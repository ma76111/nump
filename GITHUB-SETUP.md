# 📚 دليل إعداد GitHub

## 🎯 الخطوات على الكمبيوتر:

### 1️⃣ إنشاء حساب GitHub (إذا لم يكن لديك):
- اذهب إلى: https://github.com
- اضغط "Sign up"
- أكمل التسجيل

### 2️⃣ إنشاء Repository جديد:
1. اضغط على "+" في الأعلى
2. اختر "New repository"
3. اسم المشروع: `telegram-bot` (أو أي اسم تريده)
4. اختر "Private" (خاص) لحماية الكود
5. اضغط "Create repository"

### 3️⃣ رفع المشروع على GitHub:

افتح Terminal/CMD في مجلد المشروع واكتب:

```bash
# تهيئة Git
git init

# إضافة جميع الملفات
git add .

# عمل Commit أول
git commit -m "Initial commit"

# تغيير اسم الفرع إلى main
git branch -M main

# ربط المشروع بـ GitHub (غير YOUR_USERNAME باسمك)
git remote add origin https://github.com/YOUR_USERNAME/telegram-bot.git

# رفع الملفات
git push -u origin main
```

**ملاحظة:** إذا طلب منك Username و Password:
- Username: اسم المستخدم في GitHub
- Password: استخدم Personal Access Token (ليس كلمة المرور)

### 4️⃣ إنشاء Personal Access Token:
1. اذهب إلى: https://github.com/settings/tokens
2. اضغط "Generate new token" → "Generate new token (classic)"
3. اسم التوكن: `telegram-bot-access`
4. اختر الصلاحيات: `repo` (كل الصلاحيات)
5. اضغط "Generate token"
6. **انسخ التوكن واحفظه** (لن تراه مرة أخرى!)

---

## 📱 الخطوات على Termux (الهاتف):

### 1️⃣ تثبيت Git:
```bash
pkg install git -y
```

### 2️⃣ إعداد Git:
```bash
git config --global user.name "YOUR_NAME"
git config --global user.email "your_email@example.com"
```

### 3️⃣ استنساخ المشروع:
```bash
cd ~
git clone https://github.com/YOUR_USERNAME/telegram-bot.git
cd telegram-bot
```

إذا كان المشروع Private، سيطلب منك:
- Username: اسم المستخدم
- Password: Personal Access Token (الذي أنشأته)

### 4️⃣ تثبيت المكتبات:
```bash
bash setup-termux.sh
```

### 5️⃣ إعداد ملف .env:
```bash
nano .env
```

ضع:
```
BOT_TOKEN=your_bot_token_here
ADMIN_ID=your_telegram_id
DB_PATH=./bot.db
```

احفظ: `Ctrl+X` ثم `Y` ثم `Enter`

### 6️⃣ تشغيل البوت:
```bash
bash start-bot.sh
```

---

## 🔄 التحديث من الكمبيوتر إلى الهاتف:

### على الكمبيوتر (بعد التعديل):
```bash
# إضافة التغييرات
git add .

# عمل Commit
git commit -m "وصف التعديل"

# رفع التغييرات
git push
```

**أو استخدم السكريبت السريع:**
```bash
bash sync-to-phone.sh
```

### على Termux (لتحديث الكود):
```bash
cd ~/telegram-bot

# إيقاف البوت
pm2 stop telegram-bot

# تحديث الكود
git pull

# إعادة تشغيل البوت
pm2 restart telegram-bot
```

**أو استخدم سكريبت التحديث:**
```bash
bash update-bot.sh
```

---

## 🆘 حل المشاكل الشائعة:

### المشكلة: "Permission denied"
```bash
chmod +x *.sh
```

### المشكلة: "fatal: not a git repository"
```bash
cd ~/telegram-bot
git init
git remote add origin https://github.com/YOUR_USERNAME/telegram-bot.git
git pull origin main
```

### المشكلة: "Authentication failed"
- تأكد من استخدام Personal Access Token وليس كلمة المرور
- تأكد من أن التوكن لديه صلاحية `repo`

### المشكلة: "merge conflict"
```bash
# حفظ التغييرات المحلية
git stash

# تحديث من GitHub
git pull

# استرجاع التغييرات
git stash pop
```

---

## 💡 نصائح:

1. **لا ترفع ملف .env على GitHub** - يحتوي على معلومات حساسة
2. **اعمل Commit بعد كل تعديل مهم** - لسهولة التراجع
3. **استخدم رسائل Commit واضحة** - مثل "إضافة ميزة السحب" بدلاً من "update"
4. **اعمل نسخة احتياطية من bot.db** - قبل التحديثات الكبيرة

---

## 📞 للمساعدة:

إذا واجهت أي مشكلة، تحقق من:
- https://docs.github.com/en/get-started
- https://git-scm.com/doc

---

✅ الآن يمكنك التعديل من الكمبيوتر والتحديث على الهاتف بسهولة!
