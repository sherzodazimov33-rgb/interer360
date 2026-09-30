/**
 * Ultra-High-Performance 360° Interior Panorama Viewer
 * Engineered for 60-144 FPS smooth navigation, zero-delay switching, cinematic cross-fade zoom transitions,
 * 2D Interactive Floorplan / Mini-map with real-time camera radar, and full Project Export / Import (.interior360).
 */

// ==================== INDEXED-DB STORAGE ENGINE ====================
class DBManager {
  constructor() {
    this.dbName = 'ApexInterior360DB';
    this.storeName = 'projects';
    this.db = null;
  }

  async init() {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB not supported in this environment');
        return resolve(null);
      }
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      request.onerror = (e) => {
        console.warn('IndexedDB error:', e);
        resolve(null);
      };
    });
  }

  async saveProject(data) {
    if (!this.db) return false;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put(data, 'active_project');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        console.warn('DB save error:', err);
        resolve(false);
      }
    });
  }

  async loadProject() {
    if (!this.db) return null;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get('active_project');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (err) {
        console.warn('DB load error:', err);
        resolve(null);
      }
    });
  }

  async clearProject() {
    if (!this.db) return false;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.delete('active_project');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (err) {
        resolve(false);
      }
    });
  }
}

// ==================== PANORAMA 360 VIEWER ENGINE ====================
class Panorama360Viewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) throw new Error('Container element not found');

    // Storage Engine & Auto-Save
    this.dbManager = new DBManager();
    this.autoSaveTimeout = null;

    // Scenes repository (cached in GPU memory for zero-delay switching)
    this.scenes = [];
    this.currentSceneIndex = 0;
    this.tourHotspots = []; // Global interactive hotspots across all images

    // 2D Floorplan / Mini-map state
    this.floorplan = {
      image: null,
      markers: {} // sceneId -> { x: percentage, y: percentage }
    };

    // Camera orientation & physics parameters
    this.lon = 0;
    this.lat = 0;
    this.targetLon = 0;
    this.targetLat = 0;
    this.fov = 75;
    this.targetFov = 75;

    // Movement speeds & inertia (Gentle cinematic acceleration)
    this.currentKeySpeedX = 0;
    this.currentKeySpeedY = 0;
    this.keyHoldTimeX = 0;
    this.keyHoldTimeY = 0;
    this.activeKeys = new Set();
    this.autoRotate = false;
    this.autoRotateSpeed = 0.08;

    // Mouse / Touch kinetic inertia
    this.isUserInteracting = false;
    this.lastPointerX = 0;
    this.lastPointerY = 0;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.pointerVelocityX = 0;
    this.pointerVelocityY = 0;

    // Mobile Multi-touch & Gesture tracking
    this.activePointers = new Map();
    this.initialPinchDistance = null;
    this.initialPinchFov = 75;
    this.lastTapTime = 0;
    this.isPresentationMode = false;

    // Raycasting & Hotspots placement
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.isPlacingHotspot = false;
    this.pendingHotspotPoint = null;

    // Unified Transition State (Zoom ONLY between rooms, 0 zoom after arriving)
    this.transitionState = {
      active: false,
      targetIndex: -1,
      startTime: 0,
      duration: 520,
      startLon: 0,
      startLat: 0,
      endLon: 0,
      endLat: 0,
      baseFov: 75,
      hotspotPosition: null
    };

    // Performance telemetry
    this.lastFrameTime = performance.now();
    this.frameCount = 0;
    this.fps = 60;
    this.lastFpsUpdate = performance.now();

    this.initThree();
    this.initGyroscope();
    this.initTelegramWebApp();
    this.setupEventListeners();
    this.initFloorplanControls();
    this.updateThumbnailsUI();
    this.animate();

    // Restore previously saved project from IndexedDB
    this.initStorageAndRestore();
  }

  // Telegram Mini App (TMA / WebApp) Integration
  initTelegramWebApp() {
    if (window.Telegram && window.Telegram.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.ready();
      tg.expand();

      // Disable Telegram swipe down to close gesture completely
      try {
        if (typeof tg.disableVerticalSwipes === 'function') {
          tg.disableVerticalSwipes();
        }
        tg.isVerticalSwipesEnabled = false;
      } catch (e) {}

      // Enter True Fullscreen inside Telegram (Telegram 8.0+)
      try {
        if (typeof tg.requestFullscreen === 'function') {
          tg.requestFullscreen();
        }
      } catch (e) {}

      try {
        tg.enableClosingConfirmation();
      } catch (e) {}

      try {
        tg.setHeaderColor('#f7f5f0');
        tg.setBackgroundColor('#000000');
        if (typeof tg.setBottomBarColor === 'function') {
          tg.setBottomBarColor('#000000');
        }
      } catch (e) {}

      try {
        tg.onEvent('viewportChanged', () => {
          if (this.onWindowResize) this.onWindowResize();
        });
      } catch (e) {}

      if (tg.BackButton) {
        tg.BackButton.onClick(() => {
          const modal = document.getElementById('hotspot-modal');
          const mobileSheet = document.getElementById('mobile-menu-sheet');
          const qrModal = document.getElementById('qr-modal');

          if (modal && !modal.classList.contains('hidden')) {
            modal.classList.add('hidden');
          } else if (mobileSheet && !mobileSheet.classList.contains('hidden')) {
            mobileSheet.classList.add('hidden');
          } else if (qrModal && !qrModal.classList.contains('hidden')) {
            qrModal.classList.add('hidden');
          } else if (this.isPresentationMode) {
            this.toggleCleanPresentationMode(false);
          } else {
            tg.close();
          }
        });
      }
    }
  }

  triggerHaptic(type = 'light') {
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback) {
      try {
        window.Telegram.WebApp.HapticFeedback.impactOccurred(type);
      } catch (e) {}
    }
  }

  initThree() {
    // 1. Scene
    this.scene = new THREE.Scene();

    // 2. Camera
    this.camera = new THREE.PerspectiveCamera(
      this.fov,
      window.innerWidth / window.innerHeight,
      1,
      2000
    );
    this.camera.target = new THREE.Vector3(0, 0, 0);

    // 3. Renderer with high performance and 100% true original colors
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.setClearColor(0x000000, 1); // Deep black base so no white line can ever show

    this.container.appendChild(this.renderer.domElement);

    // 4. Primary 360 Sphere Geometry (80x48 tessellation for silky smooth projection)
    this.geometry = new THREE.SphereGeometry(500, 80, 48);
    this.geometry.scale(-1, 1, 1);

    // 5. Material with PURE WHITE color (0xffffff)
    this.material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: false
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.visible = false;
    this.scene.add(this.mesh);

    // 6. Secondary Transition Sphere (Cross-fade Dissolve Overlay)
    this.fadeGeometry = new THREE.SphereGeometry(499, 80, 48);
    this.fadeGeometry.scale(-1, 1, 1);
    this.fadeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false
    });
    this.fadeMesh = new THREE.Mesh(this.fadeGeometry, this.fadeMaterial);
    this.fadeMesh.visible = false;
    this.scene.add(this.fadeMesh);
  }

  // Instant File Load (from user upload or drag-and-drop)
  loadUserImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) {
        return reject(new Error('Faqat rasm formatidagi fayllar qabul qilinadi'));
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        const img = new Image();
        img.onload = () => {
          const texture = new THREE.Texture(img);
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.generateMipmaps = false;
          texture.encoding = THREE.sRGBEncoding;
          texture.needsUpdate = true;

          // Generate miniature thumbnail
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.width = 160;
          thumbCanvas.height = 90;
          const tCtx = thumbCanvas.getContext('2d');
          tCtx.drawImage(img, 0, 0, 160, 90);
          const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.85);

          const sceneData = {
            id: 'scene_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            name: file.name.replace(/\.[^/.]+$/, ""),
            texture: texture,
            thumbnail: thumbUrl,
            dataUrl: dataUrl,
            source: 'upload'
          };

          this.scenes.push(sceneData);
          this.ensureFloorplanMarker(sceneData.id);
          this.updateThumbnailsUI();

          const newIndex = this.scenes.length - 1;
          this.switchScene(newIndex);
          this.renderFloorplan();
          this.scheduleAutoSave();
          resolve(sceneData);
        };
        img.onerror = reject;
        img.src = dataUrl;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Create scene object directly from Base64 Data URL (used by Import & Auto-Restore)
  createSceneFromDataUrl(dataUrl, name, id = null, thumbnail = null) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const texture = new THREE.Texture(img);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.encoding = THREE.sRGBEncoding;
        texture.needsUpdate = true;

        let thumbUrl = thumbnail;
        if (!thumbUrl) {
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.width = 160;
          thumbCanvas.height = 90;
          const tCtx = thumbCanvas.getContext('2d');
          tCtx.drawImage(img, 0, 0, 160, 90);
          thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.85);
        }

        const sceneData = {
          id: id || ('scene_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)),
          name: name || 'Xona',
          texture: texture,
          thumbnail: thumbUrl,
          dataUrl: dataUrl,
          source: 'import'
        };

        resolve(sceneData);
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  // Instant scene assignment (for initial load & switches)
  switchScene(index) {
    if (index < 0 || index >= this.scenes.length) return;
    this.currentSceneIndex = index;
    const targetScene = this.scenes[index];

    this.mesh.material.map = targetScene.texture;
    this.mesh.material.color.setHex(0xffffff);
    this.mesh.material.needsUpdate = true;
    this.mesh.visible = true;

    const uploadCard = document.getElementById('initial-upload-card');
    if (uploadCard) uploadCard.style.display = 'none';

    const sceneTitleEl = document.getElementById('current-scene-title');
    if (sceneTitleEl) {
      sceneTitleEl.textContent = targetScene.name;
    }

    const deleteCurBtn = document.getElementById('btn-delete-current-scene');
    if (deleteCurBtn) {
      deleteCurBtn.classList.remove('hidden');
    }

    const thumbnails = document.querySelectorAll('.gallery-thumbnail');
    thumbnails.forEach((thumb, i) => {
      if (i === index) {
        thumb.classList.add('active');
        thumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      } else {
        thumb.classList.remove('active');
      }
    });

    this.renderHotspots();
    this.renderFloorplan();
  }

  // BUTTERY-SMOOTH WARP CROSS-FADE TRANSITION (Zoom ONLY between rooms, 0 zoom after arriving)
  transitionToScene(targetIndex, hotspotPosition = null) {
    if (targetIndex < 0 || targetIndex >= this.scenes.length) return;
    if (targetIndex === this.currentSceneIndex) return;
    if (this.transitionState.active) return;

    const targetScene = this.scenes[targetIndex];
    const startFov = this.targetFov; // base zoom level
    const startLon = this.lon;
    const startLat = this.lat;

    let endLon = this.lon;
    let endLat = this.lat;

    if (hotspotPosition) {
      const norm = hotspotPosition.clone().normalize();
      const phi = Math.acos(norm.y);
      const theta = Math.atan2(norm.z, norm.x);
      const calcLon = THREE.MathUtils.radToDeg(theta);
      const calcLat = Math.max(-85, Math.min(85, 90 - THREE.MathUtils.radToDeg(phi)));

      // Shortest angle difference to prevent 360-degree spin bug
      let dLon = ((calcLon - (this.lon % 360) + 540) % 360) - 180;
      endLon = this.lon + dLon;
      endLat = calcLat;
    }

    // Prepare Cross-fade Overlay Sphere
    this.fadeMesh.material.map = targetScene.texture;
    this.fadeMesh.material.color.setHex(0xffffff);
    this.fadeMesh.material.opacity = 0;
    this.fadeMesh.material.needsUpdate = true;
    this.fadeMesh.visible = true;

    // Reset user movement velocities to prevent any residual floating
    this.pointerVelocityX = 0;
    this.pointerVelocityY = 0;
    this.currentKeySpeedX = 0;
    this.currentKeySpeedY = 0;

    // Activate synchronized transition state
    this.transitionState = {
      active: true,
      targetIndex: targetIndex,
      startTime: performance.now(),
      duration: 520, // 520ms smooth, crisp transition
      startLon: startLon,
      startLat: startLat,
      endLon: endLon,
      endLat: endLat,
      baseFov: startFov,
      hotspotPosition: hotspotPosition
    };
  }

  // Toggle Hotspot Placement Mode
  toggleHotspotPlacement(forceState) {
    if (forceState !== undefined) {
      this.isPlacingHotspot = forceState;
    } else {
      if (this.scenes.length === 0) {
        this.showToast("Iltimos, avval kamida bitta 360 rasm yuklang!", "warning");
        return;
      }
      this.isPlacingHotspot = !this.isPlacingHotspot;
    }

    const banner = document.getElementById('placing-hotspot-banner');
    const btn = document.getElementById('btn-add-hotspot');

    if (this.isPlacingHotspot) {
      document.body.classList.add('placing-hotspot');
      if (banner) banner.classList.remove('hidden');
      if (btn) btn.classList.add('active');
    } else {
      document.body.classList.remove('placing-hotspot');
      if (banner) banner.classList.add('hidden');
      if (btn) btn.classList.remove('active');
    }
  }

  // Open Hotspot Configuration Modal
  openHotspotModal(hitPoint) {
    this.pendingHotspotPoint = hitPoint;
    this.toggleHotspotPlacement(false);

    const modal = document.getElementById('hotspot-modal');
    const nameInput = document.getElementById('hotspot-name-input');
    const select = document.getElementById('hotspot-target-select');
    const fileInput = document.getElementById('hotspot-file-input');

    if (nameInput) nameInput.value = '';
    if (fileInput) fileInput.value = '';

    // Populate dropdown with existing rooms
    if (select) {
      select.innerHTML = '';
      if (this.scenes.length <= 1) {
        const opt = document.createElement('option');
        opt.value = '-1';
        opt.textContent = "Hozircha boshqa xona yo'q (Pastdan yangi 360 rasm yuklang)";
        select.appendChild(opt);
      } else {
        this.scenes.forEach((sc, idx) => {
          if (idx !== this.currentSceneIndex) {
            const opt = document.createElement('option');
            opt.value = idx;
            opt.textContent = sc.name;
            select.appendChild(opt);
          }
        });
      }
    }

    if (modal) {
      modal.classList.remove('hidden');
      if (nameInput) nameInput.focus();
    }

    if (window.lucide) window.lucide.createIcons();
  }

  // Save Hotspot from Modal
  async savePendingHotspot() {
    const nameInput = document.getElementById('hotspot-name-input');
    const select = document.getElementById('hotspot-target-select');
    const fileInput = document.getElementById('hotspot-file-input');
    const modal = document.getElementById('hotspot-modal');

    let targetIndex = select ? parseInt(select.value, 10) : -1;
    let label = nameInput && nameInput.value.trim() ? nameInput.value.trim() : 'Xonaga o\'tish';

    // If user uploaded a new 360 file directly for this hotspot
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      const newScene = await this.loadUserImageFile(file);
      targetIndex = this.scenes.indexOf(newScene);
      if (!nameInput || !nameInput.value.trim()) {
        label = newScene.name;
      }
    }

    if (targetIndex < 0 || targetIndex >= this.scenes.length) {
      this.showToast("Iltimos, o'tiladigan xonani tanlang yoki yangi 360 rasm yuklang!", "warning");
      return;
    }

    const originScene = this.scenes[this.currentSceneIndex];
    const targetScene = this.scenes[targetIndex];

    // Save hotspot globally so it is visible across all images/scenes
    this.tourHotspots.push({
      id: 'hs_' + Date.now(),
      name: label,
      position: this.pendingHotspotPoint.clone(),
      originSceneId: originScene.id,
      targetSceneId: targetScene.id,
      originSceneIndex: this.currentSceneIndex,
      targetSceneIndex: targetIndex
    });

    if (modal) modal.classList.add('hidden');
    this.renderHotspots();
    this.scheduleAutoSave();
    this.showToast(`"${label}" o'tish nuqtasi qo'shildi`, "success");
  }

  // Render Hotspots onto HTML Overlay (Hamma rasmlarda ko'rinib turadi)
  renderHotspots() {
    const container = document.getElementById('hotspots-container');
    if (!container) return;
    container.innerHTML = '';

    if (this.scenes.length === 0 || !this.tourHotspots) return;

    this.tourHotspots.forEach((hs, idx) => {
      // Resolve scene indices safely using IDs if available
      let originIdx = hs.originSceneId ? this.scenes.findIndex(s => s.id === hs.originSceneId) : hs.originSceneIndex;
      let targetIdx = hs.targetSceneId ? this.scenes.findIndex(s => s.id === hs.targetSceneId) : hs.targetSceneIndex;

      if (originIdx === -1) originIdx = hs.originSceneIndex;
      if (targetIdx === -1) targetIdx = hs.targetSceneIndex;

      let destinationIndex = targetIdx;
      let displayLabel = hs.name;

      // Agar hozirda maqsadli xonada bo'lsak, bosilganda avtomatik ravishda boshlang'ich xonaga qaytaradi
      if (this.currentSceneIndex === targetIdx) {
        destinationIndex = originIdx;
        const originScene = this.scenes[originIdx];
        displayLabel = originScene ? `${originScene.name}ga qaytish` : 'Oldingi xonaga qaytish';
      }

      // Raqamlar (masalan "1.", "2. ") bo'lsa ularni tozalash
      let cleanLabel = displayLabel.replace(/^\d+[\.\s\-_]*/, '').trim();

      const el = document.createElement('div');
      el.className = 'hotspot-marker';
      el.innerHTML = `
        <div class="marker-circle relative flex items-center justify-center">
          <!-- Oq rangli hilpirash (White pulsating ripple) -->
          <div class="absolute w-12 h-12 rounded-full border border-white/70 bg-white/25 animate-ping pointer-events-none"></div>
          <!-- Shaffof nuqta (Strelkasiz, markaziy nafis oq nuqta bilan) -->
          <div class="w-8 h-8 rounded-full bg-white/30 backdrop-blur-md border-2 border-white flex items-center justify-center shadow-lg shadow-black/15 transition-transform">
            <div class="w-2.5 h-2.5 rounded-full bg-white shadow-sm"></div>
          </div>
        </div>
        <!-- Tepasidagi yorliq: faqat hover bo'lganda chiqadi, nomersiz toza dizayn -->
        <div class="marker-label px-3 py-1.5 rounded-xl glass-panel text-[11px] font-semibold text-stone-800 border border-[#e2dacd] shadow-xl">
          <span>${cleanLabel || 'O\'tish'}</span>
        </div>
      `;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.transitionToScene(destinationIndex, hs.position);
      });

      // Right-click (contextmenu) to delete hotspot
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (confirm(`"${hs.name}" nuqtasini o'chirmoqchimisiz?`)) {
          this.tourHotspots.splice(idx, 1);
          this.renderHotspots();
          this.scheduleAutoSave();
          this.showToast("Nuqta o'chirildi", "info");
        }
      });

      container.appendChild(el);
      hs.domElement = el;
    });

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // Project 3D Hotspot Coordinates to 2D Screen
  updateHotspotsScreenPositions() {
    if (!this.tourHotspots || this.tourHotspots.length === 0) return;

    const cameraDir = this.camera.getWorldDirection(new THREE.Vector3());

    this.tourHotspots.forEach(hs => {
      if (!hs.domElement) return;

      const normPos = hs.position.clone().normalize();
      const dot = cameraDir.dot(normPos);

      // Only display if in front of camera and not transitioning
      if (dot > 0.15 && !this.transitionState.active) {
        const p = hs.position.clone().project(this.camera);
        const x = (p.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-p.y * 0.5 + 0.5) * window.innerHeight;

        hs.domElement.style.transform = `translate(-50%, -50%) translate3d(${x}px, ${y}px, 0)`;
        hs.domElement.style.display = 'block';
      } else {
        hs.domElement.style.display = 'none';
      }
    });
  }

  updateThumbnailsUI() {
    const tray = document.getElementById('thumbnails-tray');
    const uploadCard = document.getElementById('initial-upload-card');
    const sceneTitleEl = document.getElementById('current-scene-title');
    const countEl = document.getElementById('scene-count-badge');
    const deleteCurBtn = document.getElementById('btn-delete-current-scene');

    if (this.scenes.length === 0) {
      if (tray) tray.innerHTML = '';
      if (uploadCard) uploadCard.style.display = 'block';
      if (sceneTitleEl) sceneTitleEl.textContent = '360° Rasm kutilmoqda...';
      if (countEl) countEl.textContent = '0 ta xona';
      if (deleteCurBtn) deleteCurBtn.classList.add('hidden');
      if (this.mesh) this.mesh.visible = false;
      return;
    }

    if (uploadCard) uploadCard.style.display = 'none';
    if (countEl) countEl.textContent = `${this.scenes.length} ta xona`;
    if (deleteCurBtn) deleteCurBtn.classList.remove('hidden');

    if (!tray) return;
    tray.innerHTML = '';
    this.scenes.forEach((sc, idx) => {
      const card = document.createElement('div');
      card.className = `gallery-thumbnail group relative flex-shrink-0 w-24 sm:w-32 h-16 sm:h-20 rounded-xl overflow-hidden border-2 border-transparent transition-all cursor-pointer ${idx === this.currentSceneIndex ? 'active' : ''}`;
      card.innerHTML = `
        <img src="${sc.thumbnail}" class="w-full h-full object-cover" alt="${sc.name}">
        <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex items-end p-1.5 sm:p-2 pointer-events-none">
          <span class="text-[10px] sm:text-[11px] font-semibold text-white truncate drop-shadow-md">${sc.name}</span>
        </div>
        <!-- O'chirish tugmasi (Delete button on thumbnail) -->
        <button class="btn-delete-thumb absolute top-1 right-1 sm:top-1.5 sm:right-1.5 w-5 h-5 sm:w-6 sm:h-6 rounded-md sm:rounded-lg bg-black/65 hover:bg-rose-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all shadow-md z-20 cursor-pointer" title="Ushbu rasmni o'chirish">
          <i data-lucide="trash-2" class="w-3 h-3 sm:w-3.5 sm:h-3.5 pointer-events-none"></i>
        </button>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-thumb')) return;
        this.transitionToScene(idx);
      });

      const delBtn = card.querySelector('.btn-delete-thumb');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`"${sc.name}" xonasini loyihadan o'chirmoqchimisiz?`)) {
            this.deleteScene(idx);
          }
        });
      }

      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (confirm(`"${sc.name}" xonasini loyihadan o'chirmoqchimisiz?`)) {
          this.deleteScene(idx);
        }
      });

      tray.appendChild(card);
    });

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  deleteScene(idx) {
    if (idx < 0 || idx >= this.scenes.length) return;
    const sc = this.scenes[idx];
    this.scenes.splice(idx, 1);
    if (this.floorplan.markers) {
      delete this.floorplan.markers[sc.id];
    }
    this.tourHotspots = this.tourHotspots.filter(h => h.originSceneId !== sc.id && h.targetSceneId !== sc.id);

    if (this.scenes.length > 0) {
      const nextIdx = Math.max(0, Math.min(idx, this.scenes.length - 1));
      this.switchScene(nextIdx);
    } else {
      this.currentSceneIndex = 0;
      if (this.mesh) this.mesh.visible = false;
      const uploadCard = document.getElementById('initial-upload-card');
      if (uploadCard) uploadCard.style.display = 'block';
      const deleteCurBtn = document.getElementById('btn-delete-current-scene');
      if (deleteCurBtn) deleteCurBtn.classList.add('hidden');
      const sceneTitleEl = document.getElementById('current-scene-title');
      if (sceneTitleEl) sceneTitleEl.textContent = '360° Rasm kutilmoqda...';
    }
    this.updateThumbnailsUI();
    this.renderHotspots();
    this.renderFloorplan();
    this.scheduleAutoSave();
    this.showToast(`"${sc.name}" o'chirildi`, "info");
  }

  newProject() {
    if (this.scenes.length > 0 && !confirm("Yangi toza loyiha boshlamoqchimisiz? Barcha yuklangan xonalar va nuqtalar tozalanadi.")) {
      return;
    }
    this.scenes = [];
    this.tourHotspots = [];
    this.floorplan = { image: null, markers: {} };
    this.currentSceneIndex = 0;
    if (this.mesh) this.mesh.visible = false;
    this.updateThumbnailsUI();
    this.renderHotspots();
    this.renderFloorplan();
    this.dbManager.clearProject();
    this.showToast("Yangi toza loyiha ochildi", "info");
  }

  // ==================== 2D FLOORPLAN & MINI-MAP ENGINE ====================
  ensureFloorplanMarker(sceneId) {
    if (!this.floorplan.markers) this.floorplan.markers = {};
    if (!this.floorplan.markers[sceneId]) {
      const keys = Object.keys(this.floorplan.markers);
      const count = keys.length;
      // Distribute evenly in a neat geometric circle or layout
      const angle = (count / 6) * Math.PI * 2;
      const radius = 28;
      const x = Math.round(50 + Math.cos(angle) * radius);
      const y = Math.round(50 + Math.sin(angle) * radius);
      this.floorplan.markers[sceneId] = {
        x: Math.max(12, Math.min(88, x)),
        y: Math.max(12, Math.min(88, y))
      };
    }
  }

  renderFloorplan() {
    const layer = document.getElementById('floorplan-markers-layer');
    const emptyHint = document.getElementById('floorplan-empty-hint');
    const floorplanImg = document.getElementById('floorplan-image');
    if (!layer) return;

    layer.innerHTML = '';

    // Blueprint background image
    if (this.floorplan.image) {
      if (floorplanImg) {
        floorplanImg.src = this.floorplan.image;
        floorplanImg.classList.remove('hidden');
      }
      if (emptyHint) emptyHint.classList.add('hidden');
    } else {
      if (floorplanImg) floorplanImg.classList.add('hidden');
      if (emptyHint) {
        if (this.scenes.length === 0) {
          emptyHint.classList.remove('hidden');
        } else {
          emptyHint.classList.add('hidden');
        }
      }
    }

    if (this.scenes.length === 0) return;

    this.scenes.forEach((sc, idx) => {
      this.ensureFloorplanMarker(sc.id);
      const pos = this.floorplan.markers[sc.id];
      const isActive = (idx === this.currentSceneIndex);

      const pinEl = document.createElement('div');
      pinEl.className = `floorplan-pin ${isActive ? 'active' : ''}`;
      pinEl.style.left = `${pos.x}%`;
      pinEl.style.top = `${pos.y}%`;
      pinEl.setAttribute('data-scene-id', sc.id);
      pinEl.setAttribute('data-scene-index', idx);

      let radarHtml = '';
      if (isActive) {
        radarHtml = `
          <div class="floorplan-radar-wrapper">
            <svg class="floorplan-radar-svg" viewBox="0 0 100 100" style="transform: rotate(${Math.round(this.lon)}deg)">
              <defs>
                <radialGradient id="radarGrad_${sc.id}" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stop-color="#8c7b6c" stop-opacity="0.6"/>
                  <stop offset="70%" stop-color="#8c7b6c" stop-opacity="0.18"/>
                  <stop offset="100%" stop-color="#8c7b6c" stop-opacity="0"/>
                </radialGradient>
              </defs>
              <path d="M 50 50 L 25 7 A 50 50 0 0 1 75 7 Z" fill="url(#radarGrad_${sc.id})"/>
            </svg>
          </div>
        `;
      }

      pinEl.innerHTML = `
        ${radarHtml}
        <div class="floorplan-pin-dot"></div>
        <div class="floorplan-pin-label">${sc.name}</div>
      `;

      this.bindFloorplanPinEvents(pinEl, sc.id, idx);
      layer.appendChild(pinEl);
    });
  }

  bindFloorplanPinEvents(pinEl, sceneId, sceneIndex) {
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let hasDragged = false;
    const mapArea = document.getElementById('floorplan-map-area');

    const onPointerDown = (e) => {
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      hasDragged = false;

      const rect = mapArea.getBoundingClientRect();
      const currentPos = this.floorplan.markers[sceneId] || { x: 50, y: 50 };
      initialLeft = currentPos.x;
      initialTop = currentPos.y;

      const onPointerMove = (moveEv) => {
        const dx = moveEv.clientX - startX;
        const dy = moveEv.clientY - startY;
        if (Math.hypot(dx, dy) > 4) {
          hasDragged = true;
          const newX = Math.max(6, Math.min(94, initialLeft + (dx / rect.width) * 100));
          const newY = Math.max(6, Math.min(94, initialTop + (dy / rect.height) * 100));
          pinEl.style.left = `${newX}%`;
          pinEl.style.top = `${newY}%`;
          this.floorplan.markers[sceneId] = {
            x: Math.round(newX * 10) / 10,
            y: Math.round(newY * 10) / 10
          };
        }
      };

      const onPointerUp = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);

        if (hasDragged) {
          this.scheduleAutoSave();
        } else {
          // It was a click -> transition smoothly to this room!
          if (sceneIndex !== this.currentSceneIndex) {
            this.transitionToScene(sceneIndex);
          }
        }
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    };

    pinEl.addEventListener('pointerdown', onPointerDown);
  }

  updateFloorplanRadar() {
    const activeSvg = document.querySelector('.floorplan-pin.active .floorplan-radar-svg');
    if (activeSvg) {
      activeSvg.style.transform = `rotate(${Math.round(this.lon % 360)}deg)`;
    }
  }

  initFloorplanControls() {
    const uploadBtn = document.getElementById('btn-upload-floorplan');
    const fileInput = document.getElementById('floorplan-file-input');
    const minimizeBtn = document.getElementById('btn-minimize-floorplan');
    const collapsedBtn = document.getElementById('floorplan-collapsed-btn');
    const floorplanCard = document.getElementById('floorplan-card');
    const resetPinsBtn = document.getElementById('btn-reset-floorplan-pins');

    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => {
        fileInput.click();
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          const file = e.target.files[0];
          const reader = new FileReader();
          reader.onload = (re) => {
            this.floorplan.image = re.target.result;
            this.renderFloorplan();
            this.scheduleAutoSave();
            this.showToast("2D Xona rejasi yuklandi", "success");
          };
          reader.readAsDataURL(file);
          fileInput.value = '';
        }
      });
    }

    if (minimizeBtn && floorplanCard) {
      // By default collapse floorplan to keep viewport clean
      floorplanCard.classList.add('hidden');

      minimizeBtn.addEventListener('click', () => {
        floorplanCard.classList.add('hidden');
      });

      if (collapsedBtn) {
        collapsedBtn.addEventListener('click', () => {
          floorplanCard.classList.remove('hidden');
        });
      }
    }

    if (resetPinsBtn) {
      resetPinsBtn.addEventListener('click', () => {
        this.resetFloorplanPins();
      });
    }
  }

  resetFloorplanPins() {
    this.floorplan.markers = {};
    this.scenes.forEach(sc => this.ensureFloorplanMarker(sc.id));
    this.renderFloorplan();
    this.scheduleAutoSave();
    this.showToast("Nuqtalar qayta taqsimlandi", "info");
  }

  // ==================== PROJECT EXPORT & IMPORT ====================
  exportProject() {
    if (this.scenes.length === 0) {
      this.showToast("Eksport qilish uchun avval kamida bitta 360 rasm yuklang!", "warning");
      return;
    }

    this.showToast("Loyiha tayyorlanmoqda...", "info");

    const projectData = {
      version: "1.0",
      app: "Apex360InteriorStudio",
      savedAt: new Date().toISOString(),
      scenes: this.scenes.map(s => ({
        id: s.id,
        name: s.name,
        dataUrl: s.dataUrl,
        thumbnail: s.thumbnail
      })),
      tourHotspots: this.tourHotspots.map(h => ({
        id: h.id,
        name: h.name,
        position: { x: h.position.x, y: h.position.y, z: h.position.z },
        originSceneId: h.originSceneId || (this.scenes[h.originSceneIndex] ? this.scenes[h.originSceneIndex].id : null),
        targetSceneId: h.targetSceneId || (this.scenes[h.targetSceneIndex] ? this.scenes[h.targetSceneIndex].id : null)
      })),
      floorplan: {
        image: this.floorplan.image,
        markers: this.floorplan.markers
      }
    };

    const jsonStr = JSON.stringify(projectData);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const firstSceneName = this.scenes[0] ? this.scenes[0].name.replace(/[^a-zA-Z0-9_\-]/g, '_') : 'loyiha';
    const filename = `${firstSceneName}_360_loyiha.interior360`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.showToast("Loyiha muvaffaqiyatli saqlandi (.interior360)", "success");
  }

  async importProject(file) {
    if (!file) return;

    const overlay = document.getElementById('loading-overlay');
    const loadingTitle = document.getElementById('loading-title');
    const loadingSub = document.getElementById('loading-subtitle');

    if (overlay) {
      if (loadingTitle) loadingTitle.textContent = "Loyiha o'qilmoqda...";
      if (loadingSub) loadingSub.textContent = "Fayl ochilmoqda...";
      overlay.classList.remove('hidden');
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.scenes || !Array.isArray(data.scenes) || data.scenes.length === 0) {
        throw new Error("Faylda 360 xonalar ma'lumoti topilmadi!");
      }

      if (loadingTitle) loadingTitle.textContent = "360 Rasmlar yuklanmoqda...";

      // Clear existing scenes
      this.scenes = [];
      this.tourHotspots = [];
      this.floorplan = { image: null, markers: {} };

      // Load each scene with proper Three.js textures
      let count = 0;
      for (const sc of data.scenes) {
        count++;
        if (loadingSub) loadingSub.textContent = `${count} / ${data.scenes.length} xona qayta ishlanmoqda...`;
        const sceneData = await this.createSceneFromDataUrl(sc.dataUrl, sc.name, sc.id, sc.thumbnail);
        this.scenes.push(sceneData);
      }

      // Restore Hotspots
      if (data.tourHotspots && Array.isArray(data.tourHotspots)) {
        data.tourHotspots.forEach(h => {
          const originIdx = this.scenes.findIndex(s => s.id === h.originSceneId);
          const targetIdx = this.scenes.findIndex(s => s.id === h.targetSceneId);
          if (originIdx !== -1 && targetIdx !== -1) {
            this.tourHotspots.push({
              id: h.id || ('hs_' + Date.now()),
              name: h.name,
              position: new THREE.Vector3(h.position.x, h.position.y, h.position.z),
              originSceneId: h.originSceneId,
              targetSceneId: h.targetSceneId,
              originSceneIndex: originIdx,
              targetSceneIndex: targetIdx
            });
          }
        });
      }

      // Restore Floorplan
      if (data.floorplan) {
        this.floorplan.image = data.floorplan.image || null;
        this.floorplan.markers = data.floorplan.markers || {};
      }

      // Switch to first scene
      this.updateThumbnailsUI();
      this.switchScene(0);
      this.renderFloorplan();
      await this.persistToStorage();

      if (overlay) overlay.classList.add('hidden');
      this.showToast(`Loyiha ochildi: ${this.scenes.length} ta xona!`, "success");
    } catch (err) {
      console.error('Import error:', err);
      if (overlay) overlay.classList.add('hidden');
      alert("Loyihani yuklashda xatolik: " + (err.message || err));
    }
  }

  // ==================== AUTO-SAVE & RESTORE ====================
  scheduleAutoSave() {
    if (this.autoSaveTimeout) clearTimeout(this.autoSaveTimeout);
    this.updateAutoSaveIndicator('saving');

    this.autoSaveTimeout = setTimeout(async () => {
      await this.persistToStorage();
      this.updateAutoSaveIndicator('saved');
    }, 600);
  }

  async persistToStorage() {
    if (this.scenes.length === 0) {
      await this.dbManager.clearProject();
      return;
    }

    const payload = {
      savedAt: new Date().toISOString(),
      scenes: this.scenes.map(s => ({
        id: s.id,
        name: s.name,
        dataUrl: s.dataUrl,
        thumbnail: s.thumbnail
      })),
      tourHotspots: this.tourHotspots.map(h => ({
        id: h.id,
        name: h.name,
        position: { x: h.position.x, y: h.position.y, z: h.position.z },
        originSceneId: h.originSceneId || (this.scenes[h.originSceneIndex] ? this.scenes[h.originSceneIndex].id : null),
        targetSceneId: h.targetSceneId || (this.scenes[h.targetSceneIndex] ? this.scenes[h.targetSceneIndex].id : null)
      })),
      floorplan: {
        image: this.floorplan.image,
        markers: this.floorplan.markers
      }
    };

    await this.dbManager.saveProject(payload);
  }

  updateAutoSaveIndicator(status) {
    const dot = document.getElementById('autosave-dot');
    const text = document.getElementById('autosave-text');
    if (!dot || !text) return;

    if (status === 'saving') {
      dot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-ping';
      text.textContent = 'Saqlanmoqda...';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-emerald-500';
      text.textContent = 'Avto-saqlangan';
    }
  }

  async initStorageAndRestore() {
    await this.dbManager.init();
    const saved = await this.dbManager.loadProject();
    if (saved && saved.scenes && saved.scenes.length > 0) {
      const overlay = document.getElementById('loading-overlay');
      const loadingTitle = document.getElementById('loading-title');
      const loadingSub = document.getElementById('loading-subtitle');

      if (overlay) {
        if (loadingTitle) loadingTitle.textContent = "Oldingi loyiha tiklanmoqda...";
        if (loadingSub) loadingSub.textContent = `${saved.scenes.length} ta xona xotiradan yuklanmoqda`;
        overlay.classList.remove('hidden');
      }

      try {
        for (const sc of saved.scenes) {
          const sceneData = await this.createSceneFromDataUrl(sc.dataUrl, sc.name, sc.id, sc.thumbnail);
          this.scenes.push(sceneData);
        }

        if (saved.tourHotspots && Array.isArray(saved.tourHotspots)) {
          saved.tourHotspots.forEach(h => {
            const originIdx = this.scenes.findIndex(s => s.id === h.originSceneId);
            const targetIdx = this.scenes.findIndex(s => s.id === h.targetSceneId);
            if (originIdx !== -1 && targetIdx !== -1) {
              this.tourHotspots.push({
                id: h.id,
                name: h.name,
                position: new THREE.Vector3(h.position.x, h.position.y, h.position.z),
                originSceneId: h.originSceneId,
                targetSceneId: h.targetSceneId,
                originSceneIndex: originIdx,
                targetSceneIndex: targetIdx
              });
            }
          });
        }

        if (saved.floorplan) {
          this.floorplan.image = saved.floorplan.image || null;
          this.floorplan.markers = saved.floorplan.markers || {};
        }

        this.updateThumbnailsUI();
        this.switchScene(0);
        this.renderFloorplan();
        this.showToast(`Avvalgi loyihangiz tiklandi (${this.scenes.length} ta xona)`, "info");
      } catch (err) {
        console.warn('Restore error:', err);
      } finally {
        if (overlay) overlay.classList.add('hidden');
      }
    }
  }

  // Toast notification system
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    let iconName = 'info';
    let iconColor = 'text-[#8c7b6c]';
    let borderColor = 'border-[#d8cfc0]';

    if (type === 'success') {
      iconName = 'check-circle-2';
      iconColor = 'text-emerald-600';
      borderColor = 'border-emerald-300';
    } else if (type === 'warning') {
      iconName = 'alert-triangle';
      iconColor = 'text-amber-600';
      borderColor = 'border-amber-300';
    }

    const toast = document.createElement('div');
    toast.className = `toast-item glass-panel px-4 py-3 rounded-2xl flex items-center gap-3 text-xs sm:text-sm font-semibold text-stone-800 shadow-xl border ${borderColor}`;
    toast.innerHTML = `
      <i data-lucide="${iconName}" class="w-4 h-4 ${iconColor} flex-shrink-0"></i>
      <span>${message}</span>
    `;

    container.appendChild(toast);
    if (window.lucide) window.lucide.createIcons();

    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 3200);
  }

  // ==================== EVENT LISTENERS & NAVIGATION ====================
  setupEventListeners() {
    const dom = this.renderer.domElement;

    // 1. Unified Pointer Handling (Single-finger drag + Multi-touch pinch-to-zoom + Tap detection)
    // Prevent Telegram Mini App and mobile browsers from closing on swipe down
    dom.addEventListener('touchmove', (e) => {
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (e.target === dom || e.target.closest('#canvas-container')) {
        e.preventDefault();
      }
    }, { passive: false });

    dom.addEventListener('pointerdown', (e) => {
      if (this.transitionState.active) return;
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.activePointers.size === 1) {
        this.isUserInteracting = true;
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.pointerVelocityX = 0;
        this.pointerVelocityY = 0;
      } else if (this.activePointers.size === 2) {
        // Pinch-to-zoom initiated
        this.isUserInteracting = false;
        const pts = Array.from(this.activePointers.values());
        this.initialPinchDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        this.initialPinchFov = this.targetFov;
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.activePointers.has(e.pointerId)) return;
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Multi-touch 2-finger Pinch-to-Zoom
      if (this.activePointers.size >= 2 && this.initialPinchDistance) {
        const pts = Array.from(this.activePointers.values());
        const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (currentDist > 15) {
          const ratio = this.initialPinchDistance / currentDist;
          const newFov = this.initialPinchFov * ratio;
          this.targetFov = Math.max(35, Math.min(95, newFov));
        }
        return;
      }

      // Single-pointer drag rotation
      if (this.isUserInteracting && !this.transitionState.active && this.activePointers.size === 1) {
        const dx = e.clientX - this.lastPointerX;
        const dy = e.clientY - this.lastPointerY;
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;

        // Calculate smooth velocity
        this.pointerVelocityX = dx * 0.13;
        this.pointerVelocityY = dy * 0.13;

        this.targetLon -= this.pointerVelocityX;
        this.targetLat = Math.max(-85, Math.min(85, this.targetLat + this.pointerVelocityY));
      }
    });

    const onPointerEnd = (e) => {
      const wasTracked = this.activePointers.has(e.pointerId);
      this.activePointers.delete(e.pointerId);

      if (this.activePointers.size < 2) {
        this.initialPinchDistance = null;
      }

      if (this.activePointers.size === 0 && wasTracked) {
        this.isUserInteracting = false;

        // Check if this was a quick tap (not a drag)
        const dist = Math.hypot(e.clientX - this.dragStartX, e.clientY - this.dragStartY);
        if (dist < 10) {
          // Double-tap zoom reset (Mobile convenience)
          const now = performance.now();
          if (now - this.lastTapTime < 320) {
            this.targetFov = 75; // reset to natural default FOV
          }
          this.lastTapTime = now;

          // Hotspot placement tap check
          if (this.isPlacingHotspot && this.mesh.visible) {
            const mouse = new THREE.Vector2(
              (e.clientX / window.innerWidth) * 2 - 1,
              -(e.clientY / window.innerHeight) * 2 + 1
            );
            this.raycaster.setFromCamera(mouse, this.camera);
            const intersects = this.raycaster.intersectObject(this.mesh);
            if (intersects.length > 0) {
              const hitPoint = intersects[0].point.clone().normalize().multiplyScalar(460);
              this.openHotspotModal(hitPoint);
            }
          }
        }
      }
    };

    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);

    // 2. Mouse Wheel Zoom (Ultra Smooth FOV lerping)
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.transitionState.active) return;
      const zoomFactor = e.deltaY * 0.04;
      this.targetFov = Math.max(35, Math.min(95, this.targetFov + zoomFactor));
    }, { passive: false });

    // 3. Buttery-Smooth Keyboard Controls
    window.addEventListener('keydown', (e) => {
      this.activeKeys.add(e.code);

      // Keyboard shortcuts
      if (e.code === 'Space') {
        e.preventDefault();
        this.toggleAutoRotate();
      } else if (e.code === 'KeyF') {
        this.toggleFullscreen();
      } else if (e.code === 'KeyH') {
        this.toggleCleanPresentationMode();
      } else if (e.code === 'Escape') {
        if (this.isPlacingHotspot) {
          this.toggleHotspotPlacement(false);
        }
        const modal = document.getElementById('hotspot-modal');
        if (modal && !modal.classList.contains('hidden')) {
          modal.classList.add('hidden');
        }
      } else if (e.code === 'BracketLeft') {
        if (this.scenes.length > 0) {
          const prev = (this.currentSceneIndex - 1 + this.scenes.length) % this.scenes.length;
          this.transitionToScene(prev);
        }
      } else if (e.code === 'BracketRight') {
        if (this.scenes.length > 0) {
          const next = (this.currentSceneIndex + 1) % this.scenes.length;
          this.transitionToScene(next);
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      this.activeKeys.delete(e.code);
      if (['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        this.keyHoldTimeX = 0;
      }
      if (['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
        this.keyHoldTimeY = 0;
      }
    });

    // 4. Window Resize & Orientation Change (Ekran to'liq to'lishi uchun)
    this.onWindowResize = () => {
      const w = window.innerWidth || document.documentElement.clientWidth;
      const h = window.innerHeight || document.documentElement.clientHeight;
      if (this.camera) {
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      }
      if (this.renderer) {
        this.renderer.setSize(w, h, false);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      }
    };

    window.addEventListener('resize', () => this.onWindowResize());
    window.addEventListener('orientationchange', () => {
      setTimeout(() => this.onWindowResize(), 100);
      setTimeout(() => this.onWindowResize(), 300);
    });

    // 5. Global Drag & Drop Handler
    const dropZone = document.getElementById('drop-zone-overlay');

    ['dragenter', 'dragover'].forEach(name => {
      window.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dropZone) dropZone.classList.add('active');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      window.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null && dropZone) {
        dropZone.classList.remove('active');
      }
    });

    window.addEventListener('drop', (e) => {
      if (dropZone) dropZone.classList.remove('active');
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        // If an .interior360 or .json project file is dropped
        if (files[0].name.endsWith('.interior360') || (files[0].type === 'application/json' && files.length === 1)) {
          this.importProject(files[0]);
        } else {
          this.handleMultipleUploads(files);
        }
      }
    });
  }

  async handleMultipleUploads(files) {
    const validFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (validFiles.length === 0) {
      this.showToast('Iltimos, rasm formatidagi (JPG, PNG, WEBP) 360 faylni tanlang!', 'warning');
      return;
    }

    for (const file of validFiles) {
      await this.loadUserImageFile(file);
    }
  }

  // ==================== ULTRA-ACCURATE 3D QUATERNION GYROSCOPE ====================
  initGyroscope() {
    this.gyroscopeSupported = ('DeviceOrientationEvent' in window);
    this.gyroscopeActive = false;
    this.gyroBaseRawYaw = null;
    this.gyroStartLon = 0;

    // Pre-allocated Three.js math vectors to eliminate garbage collection stutter
    this._gyroZee = new THREE.Vector3(0, 0, 1);
    this._gyroEuler = new THREE.Euler();
    this._gyroQ0 = new THREE.Quaternion();
    this._gyroQ1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 rotation around X axis
    this._gyroDeviceQuat = new THREE.Quaternion();
    this._gyroForward = new THREE.Vector3();

    this.onDeviceOrientation = (e) => {
      if (!this.gyroscopeActive) return;

      const alpha = e.alpha;
      const beta = e.beta;
      const gamma = e.gamma;

      if (alpha === null || beta === null || gamma === null) return;

      if (this.isUserInteracting || this.transitionState.active) {
        // While user is manually dragging or transitioning, re-anchor gyro so it never jumps
        this.gyroBaseRawYaw = null;
        return;
      }

      // 1. Convert sensor angles from degrees to radians
      const alphaRad = THREE.MathUtils.degToRad(alpha);
      const betaRad = THREE.MathUtils.degToRad(beta);
      const gammaRad = THREE.MathUtils.degToRad(gamma);

      // 2. Read physical screen orientation (portrait vs landscape 90/-90/180)
      let orientDeg = 0;
      if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
        orientDeg = window.screen.orientation.angle;
      } else if (typeof window.orientation === 'number') {
        orientDeg = window.orientation;
      }
      const orientRad = THREE.MathUtils.degToRad(orientDeg);

      // 3. Compute the true 3D spatial device quaternion (Three.js standard)
      this._gyroEuler.set(betaRad, alphaRad, -gammaRad, 'YXZ');
      this._gyroDeviceQuat.setFromEuler(this._gyroEuler);
      this._gyroDeviceQuat.multiply(this._gyroQ1); // Camera faces through the screen back
      this._gyroDeviceQuat.multiply(this._gyroQ0.setFromAxisAngle(this._gyroZee, -orientRad)); // Screen rotation

      // 4. Calculate exact 3D forward gaze vector
      this._gyroForward.set(0, 0, -1).applyQuaternion(this._gyroDeviceQuat);

      // 5. Convert forward vector into exact spherical pitch (elevation) and yaw (azimuth)
      const rawPitch = Math.asin(Math.max(-1, Math.min(1, this._gyroForward.y))) * (180 / Math.PI);
      const rawYaw = Math.atan2(this._gyroForward.x, -this._gyroForward.z) * (180 / Math.PI);

      // 6. Anchor heading smoothly to user's current room view
      if (this.gyroBaseRawYaw === null) {
        this.gyroBaseRawYaw = rawYaw;
        this.gyroStartLon = this.lon;
      }

      // Calculate circular delta from anchor heading
      let deltaYaw = rawYaw - this.gyroBaseRawYaw;
      deltaYaw = ((((deltaYaw % 360) + 540) % 360) - 180);

      this.targetLon = this.gyroStartLon + deltaYaw;
      this.targetLat = Math.max(-85, Math.min(85, rawPitch));
    };
  }

  async toggleGyroscope() {
    if (!this.gyroscopeSupported) {
      this.showToast("Qurilmangizda harakat sensori (Giroskop) aniqlanmadi", "warning");
      return;
    }

    if (!this.gyroscopeActive) {
      // iOS 13+ user gesture permission
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          const permission = await DeviceOrientationEvent.requestPermission();
          if (permission !== 'granted') {
            this.showToast("Giroskopga ruxsat berilmadi", "warning");
            return;
          }
        } catch (err) {
          console.warn('Gyro permission error:', err);
          this.showToast("Giroskopga ulanib bo'lmadi", "warning");
          return;
        }
      }

      // Prefer deviceorientationabsolute if available (Android zero-drift compass sensor)
      const eventName = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
      this._gyroEventName = eventName;

      window.addEventListener(eventName, this.onDeviceOrientation, false);
      if (eventName !== 'deviceorientation') {
        window.addEventListener('deviceorientation', this.onDeviceOrientation, false);
      }

      this.gyroscopeActive = true;
      this.gyroBaseRawYaw = null;
      this.updateGyroscopeUI(true);
      this.showToast("Giroskop yoqildi: Telefonni aylantirib tomosha qiling", "success");
    } else {
      if (this._gyroEventName) {
        window.removeEventListener(this._gyroEventName, this.onDeviceOrientation, false);
      }
      window.removeEventListener('deviceorientation', this.onDeviceOrientation, false);
      this.gyroscopeActive = false;
      this.gyroBaseRawYaw = null;
      this.updateGyroscopeUI(false);
      this.showToast("Giroskop o'chirildi", "info");
    }
  }

  updateGyroscopeUI(active) {
    const btns = document.querySelectorAll('.btn-gyroscope-toggle');
    btns.forEach(btn => {
      if (active) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  toggleAutoRotate() {
    this.autoRotate = !this.autoRotate;
    const btn = document.getElementById('btn-auto-rotate');
    if (btn) {
      if (this.autoRotate) {
        btn.classList.add('bg-[#8c7b6c]', 'text-white');
      } else {
        btn.classList.remove('bg-[#8c7b6c]', 'text-white');
      }
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }

  toggleCleanPresentationMode(forceState) {
    if (forceState !== undefined) {
      this.isPresentationMode = forceState;
    } else {
      this.isPresentationMode = !this.isPresentationMode;
    }

    const overlays = document.querySelectorAll('.presentation-toggleable');
    const restoreBtn = document.getElementById('btn-presentation-restore');

    overlays.forEach(el => {
      if (this.isPresentationMode) {
        el.classList.add('hidden');
        el.style.setProperty('display', 'none', 'important');
      } else {
        el.classList.remove('hidden');
        el.style.removeProperty('display');
      }
    });

    // Ensure initial-upload-card remains hidden if we already have scenes loaded
    if (!this.isPresentationMode && this.scenes && this.scenes.length > 0) {
      const uploadCard = document.getElementById('initial-upload-card');
      if (uploadCard) uploadCard.style.display = 'none';
    }

    if (restoreBtn) {
      if (this.isPresentationMode) {
        restoreBtn.classList.remove('hidden');
        restoreBtn.style.removeProperty('display');
        if (window.lucide) window.lucide.createIcons();
      } else {
        restoreBtn.classList.add('hidden');
        restoreBtn.style.setProperty('display', 'none', 'important');
      }
    }

    // Telegram Mini App header and background coordination
    if (window.Telegram && window.Telegram.WebApp) {
      try {
        const tg = window.Telegram.WebApp;
        if (this.isPresentationMode) {
          tg.setHeaderColor('#000000');
          tg.setBackgroundColor('#000000');
          if (typeof tg.setBottomBarColor === 'function') {
            tg.setBottomBarColor('#000000');
          }
        } else {
          tg.setHeaderColor('#f7f5f0');
          tg.setBackgroundColor('#000000');
          if (typeof tg.setBottomBarColor === 'function') {
            tg.setBottomBarColor('#000000');
          }
        }
      } catch (e) {}
    }

    // Re-calculate full dimensions to prevent any seam or white line at screen bottom
    if (this.onWindowResize) {
      this.onWindowResize();
      setTimeout(() => this.onWindowResize(), 50);
      setTimeout(() => this.onWindowResize(), 200);
    }
  }

  // ==================== MAIN RENDER LOOP ====================
  animate() {
    requestAnimationFrame(() => this.animate());

    const now = performance.now();
    const dt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    // Calculate real-time FPS
    this.frameCount++;
    if (now - this.lastFpsUpdate >= 500) {
      this.fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsUpdate));
      this.frameCount = 0;
      this.lastFpsUpdate = now;
      const fpsEl = document.getElementById('fps-counter');
      if (fpsEl) {
        fpsEl.textContent = `${this.fps} FPS`;
      }
    }

    // ==================== TRANSITION PROCESSING ====================
    if (this.transitionState.active) {
      const elapsed = now - this.transitionState.startTime;
      const p = Math.min(1, elapsed / this.transitionState.duration);
      const smoothstep = (x) => x * x * (3 - 2 * x);

      // 1. Zoom Arc - ONLY active between rooms (sin wave: 0 at p=0, peak at p=0.5, exactly 0 at p=1)
      const zoomIntensity = this.transitionState.hotspotPosition ? 24 : 10;
      const zoomProgress = Math.sin(p * Math.PI);
      this.fov = this.transitionState.baseFov - zoomProgress * zoomIntensity;
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();

      // 2. Camera Orientation Glide (Shortest path direct steer towards hotspot)
      if (this.transitionState.hotspotPosition) {
        const steerP = Math.min(1, p / 0.7);
        const steerT = smoothstep(steerP);
        this.lon = this.transitionState.startLon + (this.transitionState.endLon - this.transitionState.startLon) * steerT;
        this.lat = this.transitionState.startLat + (this.transitionState.endLat - this.transitionState.startLat) * steerT;
      }

      // 3. Smooth Cross-Fade Dissolve
      let fadeOpacity = 0;
      if (p < 0.25) {
        fadeOpacity = 0;
      } else if (p > 0.75) {
        fadeOpacity = 1;
      } else {
        const fp = (p - 0.25) / 0.5;
        fadeOpacity = smoothstep(fp);
      }
      this.fadeMaterial.opacity = fadeOpacity;

      // 4. Exact Completion: at p = 1, lock everything to final state (ZERO residual zoom or motion)
      if (p >= 1) {
        const targetScene = this.scenes[this.transitionState.targetIndex];
        this.currentSceneIndex = this.transitionState.targetIndex;

        // Apply new texture to primary mesh
        this.mesh.material.map = targetScene.texture;
        this.mesh.material.color.setHex(0xffffff);
        this.mesh.material.needsUpdate = true;

        this.fadeMesh.visible = false;
        this.fadeMaterial.opacity = 0;

        // Lock camera parameters so there is ZERO post-transition zoom or drift!
        this.fov = this.transitionState.baseFov;
        this.targetFov = this.transitionState.baseFov;
        this.camera.fov = this.fov;
        this.camera.updateProjectionMatrix();

        this.lon = this.transitionState.endLon;
        this.targetLon = this.transitionState.endLon;
        this.lat = this.transitionState.endLat;
        this.targetLat = this.transitionState.endLat;

        // Clear all kinetic velocities
        this.pointerVelocityX = 0;
        this.pointerVelocityY = 0;
        this.currentKeySpeedX = 0;
        this.currentKeySpeedY = 0;

        // Update UI
        const sceneTitleEl = document.getElementById('current-scene-title');
        if (sceneTitleEl) sceneTitleEl.textContent = targetScene.name;

        const thumbnails = document.querySelectorAll('.gallery-thumbnail');
        thumbnails.forEach((thumb, i) => {
          if (i === this.currentSceneIndex) {
            thumb.classList.add('active');
            thumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          } else {
            thumb.classList.remove('active');
          }
        });

        this.renderHotspots();
        this.renderFloorplan();
        this.transitionState.active = false;
      }
    } else {
      // ==================== NORMAL NAVIGATION ====================
      let dirX = 0;
      let dirY = 0;

      if (this.activeKeys.has('KeyA') || this.activeKeys.has('ArrowLeft')) dirX -= 1;
      if (this.activeKeys.has('KeyD') || this.activeKeys.has('ArrowRight')) dirX += 1;
      if (this.activeKeys.has('KeyW') || this.activeKeys.has('ArrowUp')) dirY += 1;
      if (this.activeKeys.has('KeyS') || this.activeKeys.has('ArrowDown')) dirY -= 1;

      const isTurbo = this.activeKeys.has('ShiftLeft') || this.activeKeys.has('ShiftRight');

      // Horizontal motion: starts with an ultra-slow, gentle crawl, then eases smoothly into cruising speed
      const minSpeedX = 0.035;
      const maxSpeedX = isTurbo ? 0.65 : 0.28;
      const rampDurationX = isTurbo ? 0.45 : 0.9; // 0.9 soniya davomida sekin-asta tezlashadi

      if (dirX !== 0) {
        this.keyHoldTimeX = Math.min(rampDurationX, (this.keyHoldTimeX || 0) + dt);
        const t = this.keyHoldTimeX / rampDurationX;
        const easeIn = t * t; // Quadratic ease-in: birinchi boshlanishi juda sekin va mayin
        const targetSpeed = minSpeedX + (maxSpeedX - minSpeedX) * easeIn;
        this.currentKeySpeedX = dirX * targetSpeed;
      } else {
        this.keyHoldTimeX = 0;
        this.currentKeySpeedX *= 0.948; // Silky cinematic coasting (nomiga yana aylanib keyin to'xtaydi)
        if (Math.abs(this.currentKeySpeedX) < 0.0003) this.currentKeySpeedX = 0;
      }

      // Vertical motion: gentle initial start, smooth ease-in
      const minSpeedY = 0.025;
      const maxSpeedY = isTurbo ? 0.45 : 0.20;
      const rampDurationY = isTurbo ? 0.45 : 0.9;

      if (dirY !== 0) {
        this.keyHoldTimeY = Math.min(rampDurationY, (this.keyHoldTimeY || 0) + dt);
        const t = this.keyHoldTimeY / rampDurationY;
        const easeIn = t * t;
        const targetSpeed = minSpeedY + (maxSpeedY - minSpeedY) * easeIn;
        this.currentKeySpeedY = dirY * targetSpeed;
      } else {
        this.keyHoldTimeY = 0;
        this.currentKeySpeedY *= 0.93; // Smooth vertical coasting
        if (Math.abs(this.currentKeySpeedY) < 0.0003) this.currentKeySpeedY = 0;
      }

      // Keyboard Zoom keys (+ / - or Q / E) - smooth zoom
      if (this.activeKeys.has('KeyQ') || this.activeKeys.has('Minus')) {
        this.targetFov = Math.min(95, this.targetFov + 0.4);
      }
      if (this.activeKeys.has('KeyE') || this.activeKeys.has('Equal')) {
        this.targetFov = Math.max(35, this.targetFov - 0.4);
      }

      // Auto-rotation (when enabled)
      if (this.autoRotate && !this.isUserInteracting) {
        this.targetLon += this.autoRotateSpeed;
      }

      // Apply kinetic mouse momentum
      if (!this.isUserInteracting) {
        this.targetLon -= this.pointerVelocityX;
        this.targetLat = Math.max(-85, Math.min(85, this.targetLat + this.pointerVelocityY));
        this.pointerVelocityX *= 0.88;
        this.pointerVelocityY *= 0.88;
      }

      // Apply keyboard acceleration to targets
      this.targetLon += this.currentKeySpeedX;
      this.targetLat = Math.max(-85, Math.min(85, this.targetLat + this.currentKeySpeedY));

      // Shortest circular angular difference (handles 360 wrap-around without snapping or spin-backs)
      let dLon = (this.targetLon - this.lon) % 360;
      if (dLon > 180) dLon -= 360;
      if (dLon < -180) dLon += 360;

      // Ultra-silky LERP smoothing (0.32 when gyro active for instant 1:1 response, 0.08 for touch inertia)
      const lerpFactor = this.gyroscopeActive ? 0.32 : 0.08;
      this.lon += dLon * lerpFactor;
      this.lat += (this.targetLat - this.lat) * lerpFactor;
      this.lat = Math.max(-85, Math.min(85, this.lat));

      // Smooth FOV interpolation
      this.fov += (this.targetFov - this.fov) * 0.09;
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // Convert spherical coordinates (lat/lon) to Cartesian coordinates (x, y, z)
    const phi = THREE.MathUtils.degToRad(90 - this.lat);
    const theta = THREE.MathUtils.degToRad(this.lon);

    const targetX = 500 * Math.sin(phi) * Math.cos(theta);
    const targetY = 500 * Math.cos(phi);
    const targetZ = 500 * Math.sin(phi) * Math.sin(theta);

    this.camera.lookAt(targetX, targetY, targetZ);

    // Update screen projection for interactive hotspots
    this.updateHotspotsScreenPositions();

    // Update 2D floorplan dynamic radar cone orientation
    this.updateFloorplanRadar();

    // Render WebGL
    this.renderer.render(this.scene, this.camera);
  }
}

// Global initialization
window.addEventListener('DOMContentLoaded', () => {
  const viewer = new Panorama360Viewer('canvas-container');
  window.viewer = viewer;

  // File upload input trigger
  const fileInput = document.getElementById('file-upload-input');
  const uploadBtn = document.getElementById('btn-upload-trigger');

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        viewer.handleMultipleUploads(e.target.files);
        fileInput.value = '';
      }
    });
  }

  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', () => {
      fileInput.click();
    });
  }

  // Project Export & Import & New triggers
  const exportBtn = document.getElementById('btn-export-project');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      viewer.exportProject();
    });
  }

  const importBtn = document.getElementById('btn-import-project');
  const projectImportInput = document.getElementById('project-import-input');

  if (importBtn && projectImportInput) {
    importBtn.addEventListener('click', () => {
      projectImportInput.click();
    });

    projectImportInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        viewer.importProject(e.target.files[0]);
        projectImportInput.value = '';
      }
    });
  }

  const newProjectBtn = document.getElementById('btn-new-project');
  if (newProjectBtn) {
    newProjectBtn.addEventListener('click', () => {
      viewer.newProject();
    });
  }

  // Hotspot Placement Toggle Buttons (Dock & Gallery)
  const addHotspotBtn = document.getElementById('btn-add-hotspot');
  const dockAddHotspotBtn = document.getElementById('btn-dock-add-hotspot');
  if (addHotspotBtn) {
    addHotspotBtn.addEventListener('click', () => {
      viewer.toggleHotspotPlacement();
    });
  }
  if (dockAddHotspotBtn) {
    dockAddHotspotBtn.addEventListener('click', () => {
      viewer.toggleHotspotPlacement();
    });
  }

  // 2D Floorplan Dock Button
  const dockFloorplanBtn = document.getElementById('btn-dock-floorplan');
  if (dockFloorplanBtn) {
    dockFloorplanBtn.addEventListener('click', () => {
      const fCard = document.getElementById('floorplan-card');
      if (fCard) {
        fCard.classList.toggle('hidden');
        if (!fCard.classList.contains('hidden') && window.lucide) {
          window.lucide.createIcons();
        }
      }
    });
  }

  const cancelPlacementBtn = document.getElementById('btn-cancel-placement');
  if (cancelPlacementBtn) {
    cancelPlacementBtn.addEventListener('click', () => {
      viewer.toggleHotspotPlacement(false);
    });
  }

  // Hotspot Modal Buttons
  const closeModalBtn = document.getElementById('btn-close-modal');
  const cancelModalBtn = document.getElementById('btn-cancel-modal');
  const saveHotspotBtn = document.getElementById('btn-save-hotspot');
  const hotspotModal = document.getElementById('hotspot-modal');

  const hideModal = () => {
    if (hotspotModal) hotspotModal.classList.add('hidden');
  };

  if (closeModalBtn) closeModalBtn.addEventListener('click', hideModal);
  if (cancelModalBtn) cancelModalBtn.addEventListener('click', hideModal);
  if (saveHotspotBtn) {
    saveHotspotBtn.addEventListener('click', () => {
      viewer.savePendingHotspot();
    });
  }

  // Control Buttons
  const autoRotateBtn = document.getElementById('btn-auto-rotate');
  if (autoRotateBtn) {
    autoRotateBtn.addEventListener('click', () => viewer.toggleAutoRotate());
  }

  const fullscreenBtn = document.getElementById('btn-fullscreen');
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => viewer.toggleFullscreen());
    const syncFsUI = () => {
      if (document.fullscreenElement) {
        fullscreenBtn.classList.add('active');
      } else {
        fullscreenBtn.classList.remove('active');
      }
    };
    document.addEventListener('fullscreenchange', syncFsUI);
    document.addEventListener('webkitfullscreenchange', syncFsUI);
  }

  const presentationBtn = document.getElementById('btn-presentation-mode');
  if (presentationBtn) {
    presentationBtn.addEventListener('click', () => viewer.toggleCleanPresentationMode());
  }

  // Gyroscope Motion Toggle Button
  const gyroBtn = document.getElementById('btn-gyroscope-toggle');
  if (gyroBtn) {
    gyroBtn.addEventListener('click', () => {
      viewer.toggleGyroscope();
    });
  }

  // Mobile Bottom Sheet Action Menu
  const mobileMenuSheet = document.getElementById('mobile-menu-sheet');
  const mobileMenuTrigger = document.getElementById('btn-mobile-menu-trigger');
  const closeMobileMenuBtn = document.getElementById('btn-close-mobile-menu');

  const openMobileMenu = () => {
    if (mobileMenuSheet) {
      mobileMenuSheet.classList.remove('hidden');
      if (window.lucide) window.lucide.createIcons();
    }
  };

  const closeMobileMenu = () => {
    if (mobileMenuSheet) mobileMenuSheet.classList.add('hidden');
  };

  if (mobileMenuTrigger) mobileMenuTrigger.addEventListener('click', openMobileMenu);
  if (closeMobileMenuBtn) closeMobileMenuBtn.addEventListener('click', closeMobileMenu);
  if (mobileMenuSheet) {
    mobileMenuSheet.addEventListener('click', (e) => {
      if (e.target === mobileMenuSheet) closeMobileMenu();
    });
  }

  // Mobile Sheet Action Buttons
  const mobileExportBtn = document.getElementById('btn-mobile-export');
  if (mobileExportBtn) {
    mobileExportBtn.addEventListener('click', () => {
      viewer.exportProject();
      closeMobileMenu();
    });
  }

  const mobileImportBtn = document.getElementById('btn-mobile-import');
  if (mobileImportBtn && projectImportInput) {
    mobileImportBtn.addEventListener('click', () => {
      projectImportInput.click();
      closeMobileMenu();
    });
  }

  const mobileNewBtn = document.getElementById('btn-mobile-new');
  if (mobileNewBtn) {
    mobileNewBtn.addEventListener('click', () => {
      viewer.newProject();
      closeMobileMenu();
    });
  }

  const mobileFloorplanBtn = document.getElementById('btn-mobile-floorplan');
  if (mobileFloorplanBtn) {
    mobileFloorplanBtn.addEventListener('click', () => {
      const fCard = document.getElementById('floorplan-card');
      const fBtn = document.getElementById('floorplan-collapsed-btn');
      if (fCard) fCard.classList.remove('hidden');
      if (fBtn) fBtn.classList.add('hidden');
      closeMobileMenu();
    });
  }

  const mobileAutoRotateBtn = document.getElementById('btn-mobile-autorotate');
  if (mobileAutoRotateBtn) {
    mobileAutoRotateBtn.addEventListener('click', () => {
      viewer.toggleAutoRotate();
      const label = document.getElementById('label-mobile-autorotate');
      if (label) {
        label.textContent = viewer.autoRotate ? "To'xtatish" : "Avto-aylanish";
      }
    });
  }

  const mobilePresentationBtn = document.getElementById('btn-mobile-presentation');
  if (mobilePresentationBtn) {
    mobilePresentationBtn.addEventListener('click', () => {
      viewer.toggleCleanPresentationMode();
      closeMobileMenu();
    });
  }

  // Persistent Semi-transparent Eye Button in Clean Mode (Qayta yoqish uchun)
  const restoreEyeBtn = document.getElementById('btn-presentation-restore');
  if (restoreEyeBtn) {
    restoreEyeBtn.addEventListener('click', () => {
      viewer.toggleCleanPresentationMode();
    });
  }

  // Mobile Bottom Gallery Bar Collapse/Expand Toggle
  const toggleGalleryBtn = document.getElementById('btn-toggle-gallery');
  const bottomGalleryNav = document.getElementById('bottom-gallery-nav');
  if (toggleGalleryBtn && bottomGalleryNav) {
    toggleGalleryBtn.addEventListener('click', () => {
      bottomGalleryNav.classList.toggle('collapsed');
    });
  }

  // QR Code Modal for Mobile Access
  const qrBtn = document.getElementById('btn-phone-qr');
  const qrModal = document.getElementById('qr-modal');
  const closeQrModalBtn = document.getElementById('btn-close-qr-modal');

  if (qrBtn && qrModal) {
    qrBtn.addEventListener('click', () => {
      qrModal.classList.remove('hidden');
    });
  }

  if (closeQrModalBtn && qrModal) {
    closeQrModalBtn.addEventListener('click', () => {
      qrModal.classList.add('hidden');
    });
  }

  if (qrModal) {
    qrModal.addEventListener('click', (e) => {
      if (e.target === qrModal) qrModal.classList.add('hidden');
    });
  }

  // Delete Current Active Scene Button in Header HUD
  const deleteCurrentSceneBtn = document.getElementById('btn-delete-current-scene');
  if (deleteCurrentSceneBtn) {
    deleteCurrentSceneBtn.addEventListener('click', () => {
      if (viewer.scenes.length > 0 && viewer.currentSceneIndex >= 0 && viewer.currentSceneIndex < viewer.scenes.length) {
        const curScene = viewer.scenes[viewer.currentSceneIndex];
        if (confirm(`Hozirgi ko'rilayotgan "${curScene.name}" xonasini loyihadan o'chirmoqchimisiz?`)) {
          viewer.deleteScene(viewer.currentSceneIndex);
        }
      }
    });
  }
});
