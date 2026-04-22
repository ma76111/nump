#!/data/data/com.termux/files/usr/bin/bash

echo "🚀 بدء إعداد البوت على Termux..."
echo ""

# الألوان
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. التحقق من Node.js
echo "📦 التحقق من Node.js..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js غير مثبت${NC}"
    echo "⏳ جاري تثبيت Node.js..."
    pkg update -y
    pkg install nodejs -y
    echo -e "${GREEN}✅ تم تثبيت Node.js${NC}"
else
    echo -e "${GREEN}✅ Node.js مثبت بالفعل ($(node --version))${NC}"
fi

echo ""

# 2. التحقق من npm
echo "📦 التحقق من npm..."
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm غير مثبت${NC}"
    pkg install nodejs -y
else
    echo -e "${GREEN}✅ npm مثبت بالفعل ($(npm --version))${NC}"
fi

echo ""

# 3. إنشاء ملف package.json إذا لم يكن موجوداً
echo "📄 التحقق من package.json..."
if [ ! -f "package.json" ]; then
    echo -e "${YELLOW}⚠️  package.json غير موجود، جاري إنشائه...${NC}"
    cat > package.json << 'EOF'
{
  "name": "telegram-bot",
  "version": "1.0.0",
  "description": "Telegram Bot for Tasks",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "reset": "node reset-bot.js"
  },
  "dependencies": {
    "dotenv": "^16.0.3",
    "node-telegram-bot-api": "^0.61.0",
    "better-sqlite3": "^9.2.2"
  },
  "engines": {
    "node": ">=14.0.0"
  }
}
EOF
    echo -e "${GREEN}✅ تم إنشاء package.json${NC}"
else
    echo -e "${GREEN}✅ package.json موجود${NC}"
fi

echo ""

# 4. حذف node_modules القديمة
echo "🗑️  تنظيف الملفات القديمة..."
if [ -d "node_modules" ]; then
    rm -rf node_modules
    echo -e "${GREEN}✅ تم حذف node_modules القديمة${NC}"
fi

if [ -f "package-lock.json" ]; then
    rm -f package-lock.json
    echo -e "${GREEN}✅ تم حذف package-lock.json${NC}"
fi

echo ""

# 5. تثبيت المكتبات
echo "📥 تثبيت المكتبات المطلوبة..."
echo "⏳ هذا قد يستغرق بضع دقائق..."
npm install

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ تم تثبيت جميع المكتبات بنجاح${NC}"
else
    echo -e "${RED}❌ فشل تثبيت المكتبات${NC}"
    echo "🔄 محاولة التثبيت يدوياً..."
    npm install dotenv node-telegram-bot-api better-sqlite3
fi

echo ""

# 6. التحقق من ملف .env
echo "🔐 التحقق من ملف .env..."
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}⚠️  ملف .env غير موجود، جاري إنشائه...${NC}"
    cat > .env << 'EOF'
BOT_TOKEN=your_bot_token_here
ADMIN_ID=6793329200
DB_PATH=./bot.db
EOF
    echo -e "${GREEN}✅ تم إنشاء ملف .env${NC}"
    echo -e "${YELLOW}⚠️  تذكر: عدل ملف .env وضع التوكن الخاص بك${NC}"
else
    echo -e "${GREEN}✅ ملف .env موجود${NC}"
fi

echo ""

# 7. التحقق من الملفات الأساسية
echo "📋 التحقق من الملفات الأساسية..."
MISSING_FILES=0

if [ ! -f "index.js" ]; then
    echo -e "${RED}❌ index.js غير موجود${NC}"
    MISSING_FILES=1
else
    echo -e "${GREEN}✅ index.js موجود${NC}"
fi

if [ ! -f "database.js" ]; then
    echo -e "${RED}❌ database.js غير موجود${NC}"
    MISSING_FILES=1
else
    echo -e "${GREEN}✅ database.js موجود${NC}"
fi

if [ ! -f "reset-bot.js" ]; then
    echo -e "${RED}❌ reset-bot.js غير موجود${NC}"
    MISSING_FILES=1
else
    echo -e "${GREEN}✅ reset-bot.js موجود${NC}"
fi

echo ""

# 8. إنشاء مجلد logs
echo "📁 إنشاء مجلد logs..."
if [ ! -d "logs" ]; then
    mkdir -p logs
    echo -e "${GREEN}✅ تم إنشاء مجلد logs${NC}"
else
    echo -e "${GREEN}✅ مجلد logs موجود${NC}"
fi

echo ""

# 9. إعطاء صلاحيات التنفيذ
echo "🔑 إعطاء صلاحيات التنفيذ..."
chmod +x *.js 2>/dev/null
chmod +x *.sh 2>/dev/null
echo -e "${GREEN}✅ تم إعطاء الصلاحيات${NC}"

echo ""
echo "================================"
echo ""

if [ $MISSING_FILES -eq 1 ]; then
    echo -e "${RED}⚠️  بعض الملفات الأساسية مفقودة!${NC}"
    echo "تأكد من رفع جميع ملفات المشروع"
    echo ""
else
    echo -e "${GREEN}✅ تم الإعداد بنجاح!${NC}"
    echo ""
    echo "📝 الخطوات التالية:"
    echo "1. عدل ملف .env وضع التوكن:"
    echo "   nano .env"
    echo ""
    echo "2. شغل البوت:"
    echo "   node index.js"
    echo ""
    echo "3. أو استخدم PM2 للتشغيل في الخلفية:"
    echo "   npm install -g pm2"
    echo "   pm2 start index.js --name telegram-bot"
    echo ""
fi

echo "================================"
