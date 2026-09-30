import asyncio
import logging
import os
from datetime import datetime

from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    ReplyKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardRemove,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
    WebAppInfo,
    MenuButtonWebApp,
    MenuButtonDefault
)

import config
import database as db

logging.basicConfig(level=logging.INFO)

bot = Bot(token=config.BOT_TOKEN)
dp = Dispatcher()

def get_contact_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="📱 Telefon raqamni yuborish", request_contact=True)]
        ],
        resize_keyboard=True,
        one_time_keyboard=True
    )

def get_webapp_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="🏢 360° Interyerni Ochish", web_app=WebAppInfo(url=config.WEBAPP_URL))]
        ],
        resize_keyboard=True
    )

def get_webapp_inline() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="🏢 360° Interyerni Ochish", web_app=WebAppInfo(url=config.WEBAPP_URL))]
        ]
    )

# ==================== /START HANDLER ====================
@dp.message(CommandStart())
async def cmd_start(message: types.Message):
    user = message.from_user
    user_id = user.id
    admins = db.get_admins()

    # Agar hali hech qanday admin belgilanmagan bo'lsa, birinchi foydalanuvchiga eslatma
    admin_hint = ""
    if not admins:
        admin_hint = (
            f"\n\n🔐 <i>(Eslatma bot egasiga: O'zingizni Bosh Admin deb belgilash uchun "
            f"<code>/admin_login {config.ADMIN_SECRET}</code> deb yozing).</i>"
        )

    # 1. Agar foydalanuvchi Admin yoki allaqachon ro'yxatdan o'tgan bo'lsa
    if db.is_admin(user_id) or db.is_user_registered(user_id):
        # Menyusiga WebApp tugmasini biriktiramiz
        try:
            await bot.set_chat_menu_button(
                chat_id=user_id,
                menu_button=MenuButtonWebApp(text="360 Interyer", web_app=WebAppInfo(url=config.WEBAPP_URL))
            )
        except Exception:
            pass

        role_text = " <i>(Bosh Admin)</i>" if db.is_admin(user_id) else ""
        await message.answer(
            f"Assalomu alaykum, <b>{user.first_name}</b>!{role_text}\n\n"
            f"🏢 <b>360° Interyer Studiyasiga xush kelibsiz!</b>\n\n"
            f"360° interyerni to'liq ekranda tomosha qilish uchun pastdagi tugmani bosing:{admin_hint}",
            reply_markup=get_webapp_keyboard(),
            parse_mode="HTML"
        )
        return

    # 2. Agar foydalanuvchi yangi bo'lsa -> Telefon raqam so'raymiz
    # Menyusini standart holatga o'tkazamiz (ro'yxatdan o'tmaguncha WebApp ochilmaydi)
    try:
        await bot.set_chat_menu_button(
            chat_id=user_id,
            menu_button=MenuButtonDefault()
        )
    except Exception:
        pass

    await message.answer(
        f"Assalomu alaykum, <b>{user.first_name}</b>!\n\n"
        f"🏢 <b>360° Interyer Studiyasiga xush kelibsiz.</b>\n\n"
        f"Loyihalar va xonalarni 360° formatda to'liq tomosha qilish uchun, "
        f"iltimos, pastdagi <b>«📱 Telefon raqamni yuborish»</b> tugmasini bosing.{admin_hint}",
        reply_markup=get_contact_keyboard(),
        parse_mode="HTML"
    )

# ==================== TELEFON RAQAM QABUL QILISH ====================
@dp.message(F.contact)
async def handle_contact(message: types.Message):
    contact = message.contact
    user = message.from_user

    # Telegram xavfsizlik tekshiruvi: O'zining raqami ekanligini tasdiqlash
    if contact.user_id and contact.user_id != user.id:
        await message.answer(
            "⚠️ Iltimos, faqat o'zingizning shaxsiy telefon raqamingizni pastdagi tugma orqali yuboring!",
            reply_markup=get_contact_keyboard()
        )
        return

    phone = contact.phone_number
    if not phone.startswith("+"):
        phone = "+" + phone

    # Bazaga saqlaymiz
    db.add_user(
        user_id=user.id,
        first_name=user.first_name or "",
        last_name=user.last_name or "",
        username=user.username or "",
        phone_number=phone
    )

    # Foydalanuvchining pastki menyusiga WebApp tugmasini faollashtiramiz
    try:
        await bot.set_chat_menu_button(
            chat_id=user.id,
            menu_button=MenuButtonWebApp(text="360 Interyer", web_app=WebAppInfo(url=config.WEBAPP_URL))
        )
    except Exception as e:
        logging.warning(f"Error setting menu button: {e}")

    # Foydalanuvchiga tabrik va 360 tugmasini beramiz
    await message.answer(
        f"✅ <b>Ro'yxatdan muvaffaqiyatli o'tdingiz!</b>\n\n"
        f"👤 <b>Ism:</b> {user.first_name}\n"
        f"📱 <b>Telefon:</b> {phone}\n\n"
        f"Endi siz barcha 360° interyerlarni bemalol tomosha qilishingiz mumkin. "
        f"Quyidagi tugmani bosing:",
        reply_markup=get_webapp_keyboard(),
        parse_mode="HTML"
    )

    # Shuningdek qo'shimcha inline tugma ham yuboramiz
    await message.answer(
        "👇 360 Turga kirish:",
        reply_markup=get_webapp_inline()
    )

    # Barcha Adminlarga yangi mijoz haqida bildirishnoma yuborish
    admins = db.get_admins()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    username_str = f"@{user.username}" if user.username else "mavjud emas"
    full_name = f"{user.first_name} {user.last_name or ''}".strip()

    admin_notification = (
        f"🔔 <b>Yangi mijoz ro'yxatdan o'tdi!</b>\n\n"
        f"👤 <b>Mijoz:</b> {full_name}\n"
        f"📱 <b>Telefon:</b> <code>{phone}</code>\n"
        f"🔗 <b>Telegram:</b> {username_str}\n"
        f"🆔 <b>ID:</b> <code>{user.id}</code>\n"
        f"📅 <b>Vaqt:</b> {now_str}"
    )

    for admin_id in admins:
        try:
            await bot.send_message(admin_id, admin_notification, parse_mode="HTML")
        except Exception as e:
            logging.error(f"Failed to notify admin {admin_id}: {e}")

# ==================== ADMIN BUYRUQLARI ====================
@dp.message(Command("admin_login"))
async def cmd_admin_login(message: types.Message):
    parts = message.text.strip().split()
    if len(parts) < 2:
        await message.answer("⚠️ Parolni kiriting: <code>/admin_login parol</code>", parse_mode="HTML")
        return

    entered_pass = parts[1]
    if entered_pass == config.ADMIN_SECRET:
        db.add_admin(message.from_user.id)
        await message.answer(
            f"🎉 <b>Tabriklaymiz! Siz muvaffaqiyatli Bosh Admin bo'ldingiz.</b>\n\n"
            f"Endi yangi mijozlar ro'yxatdan o'tganda sizga avtomatik bildirishnoma keladi.\n\n"
            f"Buyruqlar:\n"
            f"👉 /admin — Admin boshqaruv paneli\n"
            f"👉 /users — Barcha ro'yxatdan o'tgan mijozlar ro'yxati\n"
            f"👉 /stat — Jami statistika",
            parse_mode="HTML"
        )
    else:
        await message.answer("❌ Noto'g'ri parol!")

@dp.message(Command("admin"))
async def cmd_admin(message: types.Message):
    if not db.is_admin(message.from_user.id):
        await message.answer("❌ Bu buyruq faqat bot admini uchun.")
        return

    count = db.get_users_count()
    await message.answer(
        f"⚙️ <b>360 INTERYER — ADMIN PANELI</b>\n\n"
        f"👥 Jami ro'yxatdan o'tgan mijozlar: <b>{count} ta</b>\n\n"
        f"Kerakli buyruqni tanlang:\n"
        f"👉 /users — Mijozlar telefon raqamlari ro'yxati\n"
        f"👉 /stat — Umumiy statistika",
        parse_mode="HTML"
    )

@dp.message(Command("stat"))
async def cmd_stat(message: types.Message):
    if not db.is_admin(message.from_user.id):
        await message.answer("❌ Bu buyruq faqat bot admini uchun.")
        return

    count = db.get_users_count()
    await message.answer(f"📊 <b>Bazada jami {count} ta mijoz ro'yxatdan o'tgan.</b>", parse_mode="HTML")

@dp.message(Command("users"))
async def cmd_users(message: types.Message):
    if not db.is_admin(message.from_user.id):
        await message.answer("❌ Bu buyruq faqat bot admini uchun.")
        return

    users = db.get_all_users()
    if not users:
        await message.answer("ℹ️ Hozircha hech kim ro'yxatdan o'tmagan.")
        return

    text = f"📋 <b>Barcha ro'yxatdan o'tgan mijozlar ({len(users)} ta):</b>\n\n"
    for i, u in enumerate(users[:40], 1):
        full_name = f"{u['first_name']} {u['last_name'] or ''}".strip()
        username = f"@{u['username']}" if u['username'] else "yo'q"
        text += f"{i}. <b>{full_name}</b>\n   📱 <code>{u['phone_number']}</code> | {username}\n   📅 {u['created_at']}\n\n"

    if len(users) > 40:
        text += f"<i>...va yana {len(users) - 40} ta mijoz.</i>"

    await message.answer(text, parse_mode="HTML")

# Ro'yxatdan o'tmagan foydalanuvchi oddiy matn yozsa eslatma berish
@dp.message()
async def default_handler(message: types.Message):
    user_id = message.from_user.id
    if not db.is_user_registered(user_id) and not db.is_admin(user_id):
        await message.answer(
            "⚠️ 360° interyerni ochish uchun, iltimos, pastdagi <b>«📱 Telefon raqamni yuborish»</b> tugmasini bosing.",
            reply_markup=get_contact_keyboard(),
            parse_mode="HTML"
        )

# ==================== CLOUD WEB SERVER (Render/Railway 24/7) ====================
async def start_web_server():
    try:
        from aiohttp import web
        app = web.Application()
        async def health(request):
            return web.Response(text="360 Interior Bot is running 24/7!")
        app.router.add_get("/", health)
        app.router.add_get("/health", health)
        runner = web.AppRunner(app)
        await runner.setup()
        port = int(os.getenv("PORT", 8080))
        site = web.TCPSite(runner, "0.0.0.0", port)
        await site.start()
        logging.info(f"Health server port {port} da ishga tushdi.")
    except Exception as e:
        logging.warning(f"Health server ishga tushmadi (lokal rejim): {e}")

# ==================== MAIN RUNNER ====================
async def main():
    db.init_db()
    logging.info("Ma'lumotlar bazasi ishga tushdi.")
    await start_web_server()
    logging.info("Bot ishga tushmoqda...")
    # Eski to'planib qolgan yangilanishlarni tashlab yuboramiz
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        logging.info("Bot to'xtatildi.")
