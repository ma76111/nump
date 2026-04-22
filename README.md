# 🤖 Telegram Task Bot

بوت تيليجرام لإدارة المهام والإعلانات مع نظام مكافآت.

## 📋 المميزات

- ✅ نظام مهام متكامل
- 💰 نظام محفظة ومكافآت
- 📱 إدارة مجموعات الأرقام
- 👥 لوحة تحكم للأدمن
- 🔒 نظام حماية وحظر
- 💳 سحب الأرباح (فودافون كاش / بينانس)
- 📊 إحصائيات وتقارير
- 🎥 فيديو شرح طريقة العمل
- 📖 دليل استخدام مدمج

## 🚀 التثبيت

### على الكمبيوتر:

```bash
# استنساخ المشروع
git clone https://github.com/YOUR_USERNAME/telegram-bot.git
cd telegram-bot

# تثبيت المكتبات
npm install

# إنشاء ملف .env
cp .env.example .env
# عدل ملف .env وضع التوكن الخاص بك

# إنشاء قاعدة البيانات
node reset-bot.js

# تشغيل البوت
node index.js
```

### على Termux (Android):

```bash
# تحديث Termux
pkg update && pkg upgrade -y

# تثبيت Node.js و Git
pkg install nodejs git -y

# استنساخ المشروع
cd ~
git clone https://github.com/YOUR_USERNAME/telegram-bot.git
cd telegram-bot

# تشغيل سكريبت الإعداد
bash setup-termux.sh

# تعديل ملف .env
nano .env
# ضع التوكن الخاص بك

# تشغيل البوت
bash start-bot.sh
```

## ⚙️ الإعدادات

عدل ملف `.env`:

```env
BOT_TOKEN=your_bot_token_here
ADMIN_ID=your_telegram_id
DB_PATH=./bot.db
```

## 📱 الاستخدام

### للمستخدمين:
- `/start` - بدء البوت
- `📢 الحصول على مهمة جديدة` - طلب مهمة جديدة
- `👤 ملفي` - عرض الملف الشخصي
- `💳 سحب الأرباح` - طلب سحب الأرباح
- `📖 طريقة العمل` - مشاهدة فيديو الشرح

### للأدمن:
- `⚙️ لوحة التحكم` - الوصول للوحة التحكم
- إدارة المستخدمين والمجموعات
- تعديل الإعدادات
- الموافقة على طلبات السحب

## 🔄 التحديث

### على الكمبيوتر:
```bash
git pull
npm install
```

### على Termux:
```bash
cd ~/telegram-bot
git pull
pm2 restart telegram-bot
```

## 📦 المكتبات المستخدمة

- `node-telegram-bot-api` - للتعامل مع Telegram API
- `better-sqlite3` - قاعدة بيانات SQLite
- `dotenv` - إدارة المتغيرات البيئية

## 🛠️ الأوامر المفيدة

```bash
# إعادة تشغيل البوت
bash restart-bot.sh

# عرض السجلات
tail -f logs/bot-*.log

# إعادة إنشاء قاعدة البيانات
node reset-bot.js
```

## 📝 ملاحظات

- احتفظ بنسخة احتياطية من `bot.db` بشكل دوري
- لا ترفع ملف `.env` على GitHub
- استخدم PM2 للتشغيل في الخلفية على Termux

## 🔒 الأمان

- التوكن محمي في ملف `.env`
- حماية من SQL Injection
- نظام حظر تلقائي
- حماية الأدمن الرئيسي

## 📄 الترخيص

هذا المشروع للاستخدام الشخصي.

## 🤝 المساهمة

للإبلاغ عن مشاكل أو اقتراحات، افتح Issue على GitHub.

---

Made with ❤️ for Telegram
