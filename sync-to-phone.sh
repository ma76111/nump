#!/bin/bash

# سكريبت لمزامنة الكود مع GitHub تلقائياً

echo "🔄 بدء المزامنة مع GitHub..."
echo ""

# التحقق من وجود تغييرات
if [ -z "$(git status --porcelain)" ]; then 
    echo "✅ لا توجد تغييرات جديدة"
    exit 0
fi

# عرض التغييرات
echo "📝 التغييرات:"
git status --short
echo ""

# إضافة جميع التغييرات
git add .

# طلب رسالة الـ commit
echo "💬 أدخل وصف التعديل (اضغط Enter للاستخدام الافتراضي):"
read commit_message

# إذا لم يتم إدخال رسالة، استخدم رسالة افتراضية
if [ -z "$commit_message" ]; then
    commit_message="Update: $(date '+%Y-%m-%d %H:%M:%S')"
fi

# عمل commit
git commit -m "$commit_message"

# رفع التغييرات
echo ""
echo "📤 رفع التغييرات إلى GitHub..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ تم رفع التغييرات بنجاح!"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📱 الآن في Termux، شغل:"
    echo ""
    echo "   cd ~/telegram-bot"
    echo "   bash update-bot.sh"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
    echo ""
    echo "❌ فشل رفع التغييرات"
    echo "تحقق من اتصال الإنترنت والصلاحيات"
fi
