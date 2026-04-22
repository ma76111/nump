#!/data/data/com.termux/files/usr/bin/bash

echo "🔄 إعادة تشغيل البوت..."
echo ""

# الألوان
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# إيقاف البوت إذا كان يعمل بـ PM2
if command -v pm2 &> /dev/null; then
    echo "⏹️  إيقاف البوت..."
    pm2 stop telegram-bot 2>/dev/null
    pm2 delete telegram-bot 2>/dev/null
fi

# حذف قاعدة البيانات القديمة
if [ -f "bot.db" ]; then
    echo "🗑️  حذف قاعدة البيانات القديمة..."
    rm bot.db
fi

# إنشاء قاعدة بيانات جديدة
echo "🆕 إنشاء قاعدة بيانات جديدة..."
node reset-bot.js

echo ""
echo -e "${GREEN}✅ تم إعادة تشغيل البوت بنجاح${NC}"
echo ""
echo "لتشغيل البوت:"
echo "  bash start-bot.sh"
echo ""
echo "أو استخدم PM2:"
echo "  pm2 start index.js --name telegram-bot"
