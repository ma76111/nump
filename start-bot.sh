#!/data/data/com.termux/files/usr/bin/bash

echo "🤖 بدء تشغيل البوت..."
echo ""

# الألوان
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# التحقق من ملف .env
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ ملف .env غير موجود!${NC}"
    echo "قم بتشغيل: bash setup-termux.sh أولاً"
    exit 1
fi

# التحقق من التوكن
if grep -q "your_bot_token_here" .env; then
    echo -e "${YELLOW}⚠️  تحذير: لم تقم بتعديل التوكن في ملف .env${NC}"
    echo "عدل الملف أولاً: nano .env"
    exit 1
fi

# التحقق من المكتبات
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}⚠️  المكتبات غير مثبتة${NC}"
    echo "جاري التثبيت..."
    npm install
fi

# التحقق من قاعدة البيانات
if [ ! -f "bot.db" ]; then
    echo -e "${YELLOW}⚠️  قاعدة البيانات غير موجودة${NC}"
    echo "جاري إنشاء قاعدة بيانات جديدة..."
    node reset-bot.js
fi

echo ""
echo -e "${GREEN}✅ جاري تشغيل البوت...${NC}"
echo ""
echo "للإيقاف: اضغط Ctrl+C"
echo "================================"
echo ""

# تشغيل البوت
node index.js
