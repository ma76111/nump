# دليل رفع البوت على GitHub وتشغيله على Termux

## الخطوة 1: رفع الملفات على GitHub (من الكمبيوتر)

### 1. إنشاء مستودع على GitHub
1. اذهب إلى https://github.com
2. اضغط على "New repository"
3. اكتب اسم المستودع مثل: `telegram-ads-bot`
4. اجعله **Private** (خاص) لحماية التوكن
5. اضغط "Create repository"

### 2. رفع الملفات
افتح PowerShell في مجلد المشروع واكتب:

```powershell
# تهيئة Git
git init

# إضافة جميع الملفات (بما فيها .env)
git add .

# عمل commit
git commit -m "Initial commit"

# ربط المستودع (استبدل USERNAME باسم المستخدم)
git remote add origin https://github.com/USERNAME/telegram-ads-bot.git

# رفع الملفات
git push -u origin master
```

**ملاحظة:** ملف `.env` سيتم رفعه مع الملفات. تأكد من أن المستودع **Private** (خاص)!

---

## الخطوة 2: تثبيت Termux على الهاتف

1. حمل Termux من F-Droid: https://f-droid.org/en/packages/com.termux/
2. **لا تحمله من Google Play** (نسخة قديمة)

---

## الخطوة 3: إعداد Termux

افتح Termux واكتب الأوامر التالية:

```bash
# تحديث الحزم
pkg update && pkg upgrade -y

# تثبيت Git و Node.js
pkg install git nodejs -y

# إنشاء مجلد للمشروع
cd ~
mkdir projects
cd projects

# سحب المشروع من GitHub (استبدل USERNAME)
git clone https://github.com/USERNAME/telegram-ads-bot.git

# الدخول للمجلد
cd telegram-ads-bot

# تثبيت المكتبات
npm install

# تشغيل البوت
npm start
```

**ملاحظة:** ملف `.env` موجود بالفعل مع التوكن، لا حاجة لتعديل شيء!

---

## الخطوة 4: تشغيل البوت في الخلفية

لتشغيل البوت حتى بعد إغلاق Termux:

```bash
# تثبيت PM2
npm install -g pm2

# تشغيل البوت في الخلفية
pm2 start index.js --name telegram-bot

# حفظ الإعدادات
pm2 save

# تشغيل PM2 تلقائياً عند بدء Termux
pm2 startup
```

---

## أوامر مفيدة

```bash
# عرض حالة البوت
pm2 status

# عرض سجلات البوت
pm2 logs telegram-bot

# إيقاف البوت
pm2 stop telegram-bot

# إعادة تشغيل البوت
pm2 restart telegram-bot

# حذف البوت من PM2
pm2 delete telegram-bot

# تحديث الكود من GitHub
cd ~/projects/telegram-ads-bot
git pull
pm2 restart telegram-bot
```

---

## نصائح مهمة

1. **المستودع خاص** - تأكد أن المستودع Private على GitHub
2. **ملف .env موجود** - يحتوي على التوكن والإعدادات
3. **اشحن الهاتف** أو وصله بالشاحن
4. **لا تغلق Termux** أو استخدم PM2
5. **اتصال إنترنت مستقر** مطلوب

---

## حل المشاكل

### إذا ظهرت مشكلة في better-sqlite3:
```bash
pkg install python build-essential -y
npm rebuild better-sqlite3
```

### إذا توقف البوت:
```bash
pm2 restart telegram-bot
pm2 logs telegram-bot
```

### لحذف قاعدة البيانات وإعادة البدء:
```bash
rm bot.db
npm start
```
