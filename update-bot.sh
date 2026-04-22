#!/data/data/com.termux/files/usr/bin/bash

echo "🔄 تحديث البوت من GitHub..."
echo ""

# الألوان
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# التحقق من وجود Git
if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ Git غير مثبت${NC}"
    echo "قم بتثبيته: pkg install git -y"
    exit 1
fi

# التحقق من وجود PM2
PM2_INSTALLED=false
if command -v pm2 &> /dev/null; then
    PM2_INSTALLED=true
fi

# إيقاف البوت إذا كان يعمل
if [ "$PM2_INSTALLED" = true ]; then
    echo "⏹️  إيقاف البوت..."
    pm2 stop telegram-bot 2>/dev/null
else
    echo -e "${YELLOW}⚠️  PM2 غير مثبت، تأكد من إيقاف البوت يدوياً${NC}"
fi

echo ""

# حفظ التغييرات المحلية (إن وجدت)
echo "💾 حفظ التغييرات المحلية..."
git stash

# تحديث الكود
echo "📥 تحميل التحديثات من GitHub..."
git pull origin main

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ تم تحديث الكود بنجاح${NC}"
else
    echo -e "${RED}❌ فشل التحديث${NC}"
    echo "جرب: git pull origin main"
    exit 1
fi

echo ""

# استرجاع التغييرات المحلية
echo "🔄 استرجاع التغييرات المحلية..."
git stash pop 2>/dev/null

# تحديث المكتبات
echo "📦 تحديث المكتبات..."
npm install

echo ""

# إعادة تشغيل البوت
if [ "$PM2_INSTALLED" = true ]; then
    echo "🚀 إعادة تشغيل البوت..."
    pm2 restart telegram-bot
    echo ""
    echo -e "${GREEN}✅ تم تحديث وإعادة تشغيل البوت بنجاح!${NC}"
    echo ""
    echo "لعرض السجلات: pm2 logs telegram-bot"
else
    echo -e "${GREEN}✅ تم التحديث بنجاح!${NC}"
    echo ""
    echo "لتشغيل البوت: bash start-bot.sh"
fi

echo ""
echo "================================"
