require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./database');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 6793329200; // الأدمن الرئيسي (للتوافق مع الكود القديم)

// التحقق من وجود TOKEN
if (!TOKEN) {
  console.error('❌ ERROR: BOT_TOKEN is not defined in .env file!');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// حالات المستخدمين
const userStates = {};
const userProofPhotos = {}; // لتخزين الصور المؤقتة
const cancelledTasks = {}; // لتخزين المهام الملغاة مؤقتاً
const secondCancellation = {}; // لتتبع المحاولة الثانية للإلغاء
const userPhotoLocks = {}; // لقفل حالة إرسال الصور
const pendingWithdrawals = {}; // لمنع طلبات السحب المتعددة
const taskCreationLocks = {}; // لمنع إنشاء مهام متعددة في نفس الوقت
const userMessageTimestamps = {}; // لتتبع آخر رسالة من المستخدم (rate limiting)
const pendingWithdrawalRequests = {}; // لتتبع طلبات السحب النشطة

// ============================================
// نظام Logging
// ============================================

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;
  
  console.log(logMessage);
  
  // حفظ في ملف
  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }
  
  const logFile = path.join(logDir, `bot-${new Date().toISOString().split('T')[0]}.log`);
  const fullLog = data ? `${logMessage} | Data: ${JSON.stringify(data)}\n` : `${logMessage}\n`;
  
  fs.appendFileSync(logFile, fullLog);
}

function logError(message, error, userId = null) {
  const errorData = {
    message: error.message,
    stack: error.stack,
    userId: userId
  };
  log('ERROR', message, errorData);
}

function logInfo(message, data = null) {
  log('INFO', message, data);
}

function logWarning(message, data = null) {
  log('WARNING', message, data);
}

// التحقق من صحة رقم فودافون كاش
function isValidVodafoneCash(phone) {
  if (!phone || typeof phone !== 'string') {
    return false;
  }
  
  // إزالة المسافات والرموز
  phone = phone.trim().replace(/[\s\-\(\)]/g, '');
  
  // إزالة +20 أو 20 من البداية إن وجدت
  if (phone.startsWith('+20')) {
    phone = phone.substring(3);
  } else if (phone.startsWith('20')) {
    phone = phone.substring(2);
  }
  
  // التحقق من أن الرقم يبدأ بـ 010 أو 011 أو 012
  // ويتكون من 11 رقم بالضبط
  const vodafoneCashPattern = /^(010|011|012)\d{8}$/;
  
  return vodafoneCashPattern.test(phone);
}

// التحقق من صحة Binance ID
function isValidBinanceID(id) {
  if (!id || typeof id !== 'string') {
    return false;
  }
  
  id = id.trim();
  
  // Binance ID عادة يكون رقم من 8-11 رقم
  const binanceIDPattern = /^\d{8,11}$/;
  
  return binanceIDPattern.test(id);
}

// دالة موحدة للتحقق (للتوافق مع الكود القديم)
function isValidWalletAddress(text) {
  return isValidVodafoneCash(text) || isValidBinanceID(text);
}

// تنظيف النص من رموز Markdown الخاصة
function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString().replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// تنسيق الأرقام بشكل آمن للنسخ
function formatNumbersForCopy(numbers) {
  if (!numbers) return '';
  const numbersArray = numbers.split('\n').filter(n => n.trim().length > 0);
  // تنظيف كل رقم من الرموز الخاصة ثم إضافة backticks
  return numbersArray.map(num => {
    const cleanNum = num.trim().replace(/[^0-9]/g, ''); // إبقاء الأرقام فقط
    return `\`${cleanNum}\``;
  }).join('\n');
}

// Rate Limiting - منع الرسائل المتكررة بسرعة
function checkRateLimit(userId) {
  const now = Date.now();
  const lastMessageTime = userMessageTimestamps[userId] || 0;
  const timeDiff = now - lastMessageTime;
  
  // السماح برسالة واحدة كل ثانية
  if (timeDiff < 1000) {
    return false; // تم تجاوز الحد
  }
  
  userMessageTimestamps[userId] = now;
  return true; // مسموح
}

// تنظيف البيانات المؤقتة القديمة
function cleanupOldData() {
  const now = Date.now();
  
  // تنظيف المهام الملغاة القديمة (أكثر من 3 دقائق)
  for (const userId in cancelledTasks) {
    const task = cancelledTasks[userId];
    if (now - task.cancelTime > 3 * 60 * 1000) {
      delete cancelledTasks[userId];
    }
  }
  
  // تنظيف أقفال إنشاء المهام القديمة (أكثر من دقيقة)
  for (const userId in taskCreationLocks) {
    if (now - taskCreationLocks[userId] > 60 * 1000) {
      delete taskCreationLocks[userId];
    }
  }
  
  // تنظيف timestamps القديمة (أكثر من 5 دقائق)
  for (const userId in userMessageTimestamps) {
    if (now - userMessageTimestamps[userId] > 5 * 60 * 1000) {
      delete userMessageTimestamps[userId];
    }
  }
}

// تشغيل التنظيف كل دقيقة
setInterval(cleanupOldData, 60 * 1000);

// التحقق من صلاحيات الأدمن
function isAdmin(userId) {
  const admin = db.prepare('SELECT * FROM admins WHERE user_id = ?').get(userId);
  return admin !== undefined;
}

// التحقق من المستخدم
function checkUser(userId, username = null) {
  let user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  if (!user) {
    db.prepare('INSERT INTO users (user_id, username) VALUES (?, ?)').run(userId, username);
    user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  } else if (username && user.username !== username) {
    db.prepare('UPDATE users SET username = ? WHERE user_id = ?').run(username, userId);
  }
  return user;
}

// التحقق من الحظر
function isBlocked(userId) {
  const user = db.prepare('SELECT is_blocked FROM users WHERE user_id = ?').get(userId);
  return user && user.is_blocked === 1;
}

// التحقق من البان التلقائي وإعادة التعيين
function checkAndResetBan(userId) {
  const user = db.prepare('SELECT failed_tasks_count, last_failed_task_time, ban_time, is_blocked FROM users WHERE user_id = ?').get(userId);
  
  if (!user) return { isBanned: false, remainingAttempts: 5 };
  
  const now = Date.now();
  
  // إذا كان محظور يدوياً من الأدمن أو محظور للأبد (5 محاولات فاشلة)
  if (user.is_blocked === 1) {
    return { isBanned: true, remainingAttempts: 0, reason: 'permanent' };
  }
  
  // إذا كان لديه محاولات فاشلة ومر 24 ساعة، إعادة العداد (فقط إذا لم يصل للمحاولة الخامسة)
  if (user.last_failed_task_time && user.failed_tasks_count < 5) {
    const lastFailTime = new Date(user.last_failed_task_time).getTime();
    const daysPassed = (now - lastFailTime) / (1000 * 60 * 60 * 24);
    
    if (daysPassed >= 1) {
      db.prepare('UPDATE users SET failed_tasks_count = 0, last_failed_task_time = NULL WHERE user_id = ?').run(userId);
      return { isBanned: false, remainingAttempts: 5 };
    }
  }
  
  const remainingAttempts = 5 - (user.failed_tasks_count || 0);
  return { isBanned: false, remainingAttempts };
}

// تسجيل محاولة فاشلة
function recordFailedTask(userId) {
  // حماية الأدمن الرئيسي من الحظر التلقائي
  if (userId === ADMIN_ID) {
    return { banned: false, permanent: false, count: 0 };
  }
  
  const user = db.prepare('SELECT failed_tasks_count FROM users WHERE user_id = ?').get(userId);
  const newCount = (user.failed_tasks_count || 0) + 1;
  
  if (newCount >= 5) {
    // حظر دائم (للأبد)
    db.prepare('UPDATE users SET failed_tasks_count = ?, last_failed_task_time = CURRENT_TIMESTAMP, is_blocked = 1 WHERE user_id = ?').run(newCount, userId);
    return { banned: true, permanent: true, count: newCount };
  } else {
    // تحديث العداد فقط
    db.prepare('UPDATE users SET failed_tasks_count = ?, last_failed_task_time = CURRENT_TIMESTAMP WHERE user_id = ?').run(newCount, userId);
    return { banned: false, permanent: false, count: newCount };
  }
}

// الحصول على الإعدادات
function getSetting(key) {
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return setting ? setting.value : null;
}

// القائمة الرئيسية
function getMainKeyboard(isAdmin = false) {
  const keyboard = [
    ['📢 الحصول على مهمة جديدة'],
    ['👤 ملفي', '📊 إحصائياتي'],
    ['💳 سحب الأرباح', '📞 الدعم'],
    ['📖 طريقة العمل']
  ];
  
  if (isAdmin) {
    keyboard.push(['⚙️ لوحة التحكم']);
  }
  
  return {
    keyboard: keyboard,
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

// لوحة تحكم الأدمن
function getAdminKeyboard(userId) {
  const keyboard = [
    ['👥 إدارة المستخدمين', '📊 إحصائيات البوت'],
    ['💵 تعديل المكافأة', '📝 تعديل الإعلان'],
    ['⏰ تعديل وقت المهمة', '💲 تعديل سعر الدولار'],
    ['📞 تعديل نص الدعم', '📋 تعديل المطلوب'],
    ['📸 تعديل حدود الصور', '🎥 تحديث فيديو الشرح'],
    ['📂 إدارة المجموعات', '⏳ المجموعات المعلقة'],
    ['✅ الموافقة والدفع', '💸 طلبات السحب'],
    ['📋 تقرير مستخدم']
  ];
  
  // إضافة أزرار خاصة بالأدمن الرئيسي فقط
  if (userId === ADMIN_ID) {
    keyboard.push(['👨‍💼 إدارة الأدمنز', '📢 إرسال رسالة']);
  }
  
  keyboard.push(['🔙 القائمة الرئيسية']);
  
  return {
    keyboard: keyboard,
    resize_keyboard: true,
    one_time_keyboard: false
  };
}


// ============================================
// معالجة الأخطاء العامة
// ============================================

bot.on('polling_error', (error) => {
  logError('Polling error', error);
});

bot.on('error', (error) => {
  logError('Bot error', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('Unhandled Rejection', new Error(reason));
});

process.on('uncaughtException', (error) => {
  logError('Uncaught Exception', error);
  // لا تغلق البوت، فقط سجل الخطأ
});

// بداية البوت
bot.onText(/\/start/, (msg) => {
  const userId = msg.from.id;
  
  try {
    if (isBlocked(userId)) {
      return bot.sendMessage(userId, '❌ تم حظرك من استخدام البوت');
    }
    
    const username = msg.from.username || null;
    checkUser(userId, username);
    const isAdminUser = isAdmin(userId);
    
    bot.sendMessage(userId, 
      `مرحباً بك في بوت الإعلانات! 👋\n\n` +
      `📢 يمكنك الحصول على مهام لإرسال إعلانات والحصول على مكافآت مالية\n\n` +
      `اختر من القائمة أدناه:`,
      { reply_markup: getMainKeyboard(isAdminUser) }
    );
    
    logInfo('User started bot', { userId, username });
  } catch (error) {
    logError('Error in /start command', error, userId);
    bot.sendMessage(userId, '❌ حدث خطأ. حاول مرة أخرى.').catch(() => {});
  }
});

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const text = msg.text;
  
  // Rate Limiting - منع الرسائل المتكررة بسرعة (إلا للأدمن)
  if (userId !== ADMIN_ID && !isAdmin(userId)) {
    if (!checkRateLimit(userId)) {
      return; // تجاهل الرسالة إذا كانت سريعة جداً
    }
  }
  
  // معالجة الفيديو (لتحديث فيديو الشرح من الأدمن)
  if (msg.video) {
    try {
      if (isBlocked(userId) && userId !== ADMIN_ID) {
        return bot.sendMessage(userId, '❌ تم حظرك من استخدام البوت');
      }
      
      const state = userStates[userId];
      
      // التحقق من أن المستخدم أدمن وفي حالة انتظار الفيديو
      if (state === 'admin_how_to_work_video') {
        if (!isAdmin(userId)) {
          delete userStates[userId];
          return bot.sendMessage(userId, '⛔ هذه الميزة متاحة للأدمن فقط');
        }
        
        const videoId = msg.video.file_id;
        const videoSize = msg.video.file_size;
        const videoDuration = msg.video.duration;
        
        // حفظ معرف الفيديو
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(videoId, 'how_to_work_video');
        delete userStates[userId];
        
        bot.sendMessage(userId, 
          `✅ تم تحديث فيديو الشرح بنجاح!\n\n` +
          `📊 معلومات الفيديو:\n` +
          `⏱️ المدة: ${videoDuration} ثانية\n` +
          `📦 الحجم: ${(videoSize / 1024 / 1024).toFixed(2)} MB\n` +
          `🆔 ID: ${videoId.substring(0, 20)}...`,
          { reply_markup: getAdminKeyboard(userId) }
        );
        
        logInfo('Admin updated how to work video', { userId, videoId, videoSize, videoDuration });
        return;
      }
      
      // إذا لم يكن في حالة انتظار الفيديو
      if (isAdmin(userId)) {
        bot.sendMessage(userId, 
          '📹 لقد أرسلت فيديو.\n\n' +
          'إذا أردت تحديث فيديو الشرح:\n' +
          '1. اذهب إلى لوحة التحكم\n' +
          '2. اضغط على "🎥 تحديث فيديو الشرح"\n' +
          '3. ثم أرسل الفيديو'
        );
      }
      
      return;
    } catch (error) {
      logError('Error handling video', error, userId);
      bot.sendMessage(userId, '❌ حدث خطأ في معالجة الفيديو').catch(() => {});
      return;
    }
  }
  
  // معالجة الصور أولاً (قبل التحقق من النص)
  if (msg.photo) {
    try {
      if (isBlocked(userId) && userId !== ADMIN_ID) {
        return bot.sendMessage(userId, '❌ تم حظرك من استخدام البوت');
      }
      
      // معالجة إرسال رسالة broadcast بصورة
      const state = userStates[userId];
      if (state === 'awaiting_broadcast_all_message') {
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        const caption = msg.caption || '';
        
        const users = db.prepare('SELECT user_id FROM users WHERE is_blocked = 0').all();
        
        bot.sendMessage(userId, `📤 جاري إرسال الرسالة إلى ${users.length} مستخدم...`);
        
        const results = await Promise.allSettled(
          users.map(user => bot.sendPhoto(user.user_id, photoId, { caption: caption }))
        );
        
        const successCount = results.filter(r => r.status === 'fulfilled').length;
        const failCount = results.filter(r => r.status === 'rejected').length;
        
        delete userStates[userId];
        bot.sendMessage(userId, `✅ تم إرسال الرسالة\n\n📊 النتائج:\n✅ نجح: ${successCount}\n❌ فشل: ${failCount}`, 
          { reply_markup: getAdminKeyboard(userId) });
        return;
      }
      else if (state && state.state === 'awaiting_broadcast_single_message') {
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        const caption = msg.caption || '';
        const targetUserId = state.targetUserId;
        
        try {
          await bot.sendPhoto(targetUserId, photoId, { caption: caption });
          delete userStates[userId];
          bot.sendMessage(userId, `✅ تم إرسال الرسالة للمستخدم ${targetUserId}`, 
            { reply_markup: getAdminKeyboard(userId) });
        } catch (error) {
          bot.sendMessage(userId, `❌ فشل إرسال الرسالة للمستخدم ${targetUserId}\n\nالسبب: ${error.message}`);
        }
        return;
      }
      
      // التحقق من قفل الصور (إذا ضغط المستخدم على تأكيد الإرسال)
      if (userPhotoLocks[userId]) {
        logWarning('User tried to send photo after confirmation', { userId });
        return bot.sendMessage(userId, '⚠️ لا يمكنك إرسال المزيد من الصور بعد تأكيد الإرسال!');
      }
      
      // التحقق من حالة إرسال الإثبات
      if (!state || state !== 'sending_proof') {
        return; // تجاهل الصور إذا لم يكن في حالة إرسال الإثبات
      }
      
      // التحقق من وجود مهمة نشطة
      const activeTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
      if (!activeTask) {
        return bot.sendMessage(userId, '❌ ليس لديك مهمة نشطة');
      }
      
      // تهيئة مصفوفة الصور إذا لم تكن موجودة
      if (!userProofPhotos[userId]) {
        userProofPhotos[userId] = [];
      }
      
      // التحقق من عدم تجاوز الحد الأقصى
      const maxScreenshots = parseInt(getSetting('max_screenshots') || '15');
      if (userProofPhotos[userId].length >= maxScreenshots) {
        return bot.sendMessage(userId, `⚠️ لقد وصلت للحد الأقصى (${maxScreenshots} صورة)`);
      }
      
      // التحقق من حجم الصورة (الحد الأقصى 20 ميجابايت)
      const photo = msg.photo[msg.photo.length - 1];
      if (photo.file_size && photo.file_size > 20 * 1024 * 1024) {
        return bot.sendMessage(userId, '❌ حجم الصورة كبير جداً!\nالحد الأقصى: 20 ميجابايت');
      }
      
      // حفظ معرف الصورة
      const photoId = photo.file_id;
      userProofPhotos[userId].push(photoId);
      
      const currentCount = userProofPhotos[userId].length;
      const minScreenshots = parseInt(getSetting('min_screenshots') || '11');
      logInfo('User sent photo', { userId, photoCount: currentCount, photoId });
      
      // إرسال رسالة تأكيد بسيطة (سيتم حذفها بعد ثانية)
      bot.sendMessage(userId, `✅ تم استلام الصورة ${currentCount}/${maxScreenshots}\n\n⚠️ الحد الأدنى: ${minScreenshots} صورة`).then(sentMsg => {
        setTimeout(() => {
          bot.deleteMessage(userId, sentMsg.message_id).catch((err) => {
            logWarning('Failed to delete confirmation message', { userId, error: err.message });
          });
        }, 3000);
      }).catch((err) => {
        logError('Failed to send photo confirmation', err, userId);
      });
      
      return;
    } catch (error) {
      logError('Error handling photo', error, userId);
      bot.sendMessage(userId, '❌ حدث خطأ في معالجة الصورة').catch(() => {});
      return;
    }
  }
  
  if (!text || text.startsWith('/')) return;
  
  if (isBlocked(userId) && userId !== ADMIN_ID) {
    return bot.sendMessage(userId, '❌ تم حظرك من استخدام البوت');
  }
  
  const username = msg.from.username || null;
  checkUser(userId, username);
  const isAdminUser = isAdmin(userId);
  
  // التحقق من وجود مهمة نشطة (منع الوصول للقائمة الرئيسية)
  const activeTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
  
  // السماح فقط بأزرار المهمة إذا كان لديه مهمة نشطة
  if (activeTask && text !== '⏱️ عرض الوقت المتبقي' && text !== '📸 إرسال الإثبات' && text !== '✅ تأكيد الإرسال' && text !== '❌ إلغاء المهمة' && text !== '❌ إلغاء وحذف الصور' && text !== '↩️ استرجاع المهمة') {
    return bot.sendMessage(userId, 
      `⚠️ لديك مهمة نشطة!\n\n` +
      `يجب عليك إكمال المهمة أو إلغاؤها أولاً.`,
      {
        reply_markup: {
          keyboard: [
            ['⏱️ عرض الوقت المتبقي'],
            ['📸 إرسال الإثبات'],
            ['❌ إلغاء المهمة']
          ],
          resize_keyboard: true
        }
      }
    );
  }
  
  // معالجة الأزرار الرئيسية
  if (text === '📢 الحصول على مهمة جديدة') {
    const isAdminUser = isAdmin(userId);
    handleNewTask(userId, isAdminUser);
  }
  else if (text === '👤 ملفي') {
    handleProfile(userId);
  }
  else if (text === '📊 إحصائياتي') {
    handleStats(userId);
  }
  else if (text === '💳 سحب الأرباح') {
    handleWithdraw(userId);
  }
  else if (text === '📞 الدعم') {
    handleSupport(userId);
  }
  else if (text === '📖 طريقة العمل') {
    handleHowToWork(userId);
  }
  else if (text === '⚙️ لوحة التحكم' && isAdmin(userId)) {
    delete userStates[userId]; // مسح أي حالة سابقة
    bot.sendMessage(userId, '⚙️ لوحة التحكم:', { reply_markup: getAdminKeyboard(userId) });
  }
  else if (text === '🔙 القائمة الرئيسية') {
    // التحقق من وجود مهمة نشطة
    const activeTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
    if (activeTask) {
      return bot.sendMessage(userId, 
        `⚠️ لديك مهمة نشطة!\n\n` +
        `يجب عليك إكمال المهمة أو إلغاؤها أولاً.`,
        {
          reply_markup: {
            keyboard: [
              ['⏱️ عرض الوقت المتبقي'],
              ['📸 إرسال الإثبات'],
              ['❌ إلغاء المهمة']
            ],
            resize_keyboard: true
          }
        }
      );
    }
    delete userStates[userId]; // مسح أي حالة سابقة
    bot.sendMessage(userId, 'القائمة الرئيسية:', { reply_markup: getMainKeyboard(isAdminUser) });
  }
  else if (text === '🔙 رجوع') {
    // إلغاء أي حالة انتظار والعودة إلى لوحة التحكم
    delete userStates[userId];
    const isAdminUser = isAdmin(userId);
    if (isAdminUser) {
      bot.sendMessage(userId, '⚙️ لوحة التحكم:', { reply_markup: getAdminKeyboard(userId) });
    } else {
      bot.sendMessage(userId, 'القائمة الرئيسية:', { reply_markup: getMainKeyboard(false) });
    }
  }
  else if (text === '❌ إلغاء المهمة') {
    const isAdminUser = isAdmin(userId);
    handleCancelTask(userId, isAdminUser);
  }
  else if (text === '↩️ استرجاع المهمة') {
    const isAdminUser = isAdmin(userId);
    handleRestoreTask(userId, isAdminUser);
  }
  else if (text === '⏱️ عرض الوقت المتبقي') {
    handleShowRemainingTime(userId);
  }
  else if (text === '📸 إرسال الإثبات') {
    handleStartProofSubmission(userId);
  }
  else if (text === '✅ تأكيد الإرسال') {
    const isAdminUser = isAdmin(userId);
    handleConfirmProofSubmission(userId, isAdminUser);
  }
  else if (text === '❌ إلغاء وحذف الكل') {
    const isAdminUser = isAdmin(userId);
    handleCancelProofSubmission(userId, isAdminUser);
  }
  // أزرار الأدمن
  else if (text === '👥 إدارة المستخدمين' && isAdmin(userId)) {
    delete userStates[userId]; // مسح أي حالة سابقة
    showAdminUsersMenu(userId);
  }
  else if (text === '📊 إحصائيات البوت' && isAdmin(userId)) {
    delete userStates[userId]; // مسح أي حالة سابقة
    showBotStats(userId);
  }
  else if (text === '💵 تعديل المكافأة' && isAdmin(userId)) {
    userStates[userId] = 'admin_reward';
    bot.sendMessage(userId, '💵 أرسل قيمة المكافأة الجديدة:');
  }
  else if (text === '📝 تعديل الإعلان' && isAdmin(userId)) {
    userStates[userId] = 'admin_ad';
    bot.sendMessage(userId, '📝 أرسل نص الإعلان الجديد:');
  }
  else if (text === '⏰ تعديل وقت المهمة' && isAdmin(userId)) {
    userStates[userId] = 'admin_timeout';
    const currentTimeout = getSetting('task_timeout');
    bot.sendMessage(userId, 
      `⏰ الوقت الحالي: ${currentTimeout} دقيقة\n\n` +
      `أرسل الوقت الجديد بالدقائق (مثال: 60 أو 120):`
    );
  }
  else if (text === '💲 تعديل سعر الدولار' && isAdmin(userId)) {
    userStates[userId] = 'admin_usd_rate';
    const currentRate = getSetting('usd_rate') || '50';
    bot.sendMessage(userId, 
      `💲 السعر الحالي: ${currentRate} جنيه للدولار\n\n` +
      `أرسل السعر الجديد (مثال: 50 أو 55):`
    );
  }
  else if (text === '📂 إدارة المجموعات' && isAdmin(userId)) {
    delete userStates[userId]; // مسح أي حالة سابقة
    showAdminGroups(userId);
  }
  else if (text === '⏳ المجموعات المعلقة' && isAdmin(userId)) {
    delete userStates[userId]; // مسح أي حالة سابقة
    showPendingGroups(userId);
  }
  else if (text === '✅ الموافقة والدفع' && isAdmin(userId)) {
    delete userStates[userId]; // مسح أي حالة سابقة
    showPendingApprovals(userId);
  }
  else if (text === '📞 تعديل نص الدعم' && isAdmin(userId)) {
    userStates[userId] = 'admin_support_text';
    const currentText = getSetting('support_text');
    bot.sendMessage(userId, 
      `📞 النص الحالي:\n\n${currentText}\n\n` +
      `أرسل نص الدعم الجديد:`
    );
  }
  else if (text === '📋 تعديل المطلوب' && isAdmin(userId)) {
    userStates[userId] = 'admin_task_requirements';
    const currentRequirements = getSetting('task_requirements') || '1️⃣ أرسل 10 سكرينات من داخل الشات (سكرينة من داخل الشات بعد ما أرسلت الرسالة)\n2️⃣ أرسل سكرينات من خارج الشات تثبت إرسال الرسائل لجميع الأرقام';
    bot.sendMessage(userId, 
      `📋 النص الحالي:\n\n${currentRequirements}\n\n` +
      `أرسل نص المطلوب الجديد:`
    );
  }
  else if (text === '📸 تعديل حدود الصور' && isAdmin(userId)) {
    const minScreenshots = getSetting('min_screenshots') || '11';
    const maxScreenshots = getSetting('max_screenshots') || '15';
    bot.sendMessage(userId, 
      `📸 الحدود الحالية:\n\n` +
      `الحد الأدنى: ${minScreenshots} صورة\n` +
      `الحد الأقصى: ${maxScreenshots} صورة\n\n` +
      `اختر ما تريد تعديله:`,
      {
        reply_markup: {
          keyboard: [
            ['📉 تعديل الحد الأدنى', '📈 تعديل الحد الأقصى'],
            ['🔙 رجوع']
          ],
          resize_keyboard: true
        }
      }
    );
  }
  else if (text === '📉 تعديل الحد الأدنى' && isAdmin(userId)) {
    userStates[userId] = 'admin_min_screenshots';
    const currentMin = getSetting('min_screenshots') || '11';
    bot.sendMessage(userId, 
      `📉 الحد الأدنى الحالي: ${currentMin} صورة\n\n` +
      `أرسل الحد الأدنى الجديد (رقم):`
    );
  }
  else if (text === '📈 تعديل الحد الأقصى' && isAdmin(userId)) {
    userStates[userId] = 'admin_max_screenshots';
    const currentMax = getSetting('max_screenshots') || '15';
    bot.sendMessage(userId, 
      `📈 الحد الأقصى الحالي: ${currentMax} صورة\n\n` +
      `أرسل الحد الأقصى الجديد (رقم):`
    );
  }
  else if (text === '🎥 تحديث فيديو الشرح' && isAdmin(userId)) {
    userStates[userId] = 'admin_how_to_work_video';
    const currentVideo = getSetting('how_to_work_video');
    bot.sendMessage(userId, 
      `🎥 تحديث فيديو الشرح:\n\n` +
      `الحالة الحالية: ${currentVideo === 'none' ? 'لم يتم رفع فيديو' : 'تم رفع فيديو'}\n\n` +
      `أرسل الفيديو الجديد الآن:`
    );
  }
  else if (text === '👨‍💼 إدارة الأدمنز' && isAdmin(userId)) {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      bot.sendMessage(userId, '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط');
      return;
    }
    delete userStates[userId];
    showAdminsMenu(userId);
  }
  else if (text === '📢 إرسال رسالة' && isAdmin(userId)) {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      bot.sendMessage(userId, '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط');
      return;
    }
    delete userStates[userId];
    showBroadcastMenu(userId);
  }
  else if (text === '💸 طلبات السحب' && isAdmin(userId)) {
    delete userStates[userId];
    showWithdrawalRequests(userId);
  }
  else if (text === '📋 تقرير مستخدم' && isAdmin(userId)) {
    delete userStates[userId];
    userStates[userId] = 'awaiting_user_report_id';
    bot.sendMessage(userId, 
      '📋 تقرير مستخدم\n\n' +
      'أرسل ID المستخدم للحصول على تقريره الكامل:',
      { reply_markup: { keyboard: [['🔙 رجوع']], resize_keyboard: true } }
    );
  }
  // معالجة حالات المستخدم
  else if (userStates[userId]) {
    handleUserStates(userId, text, msg);
  }
});

// معالجة الأزرار الإضافية (Inline)
bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;
  const messageId = query.message.message_id;
  
  bot.answerCallbackQuery(query.id);
  
  // إدارة المستخدمين
  if (data === 'admin_block_user' && isAdmin(userId)) {
    userStates[userId] = 'awaiting_block_user_id';
    bot.sendMessage(userId, '🚫 أرسل ID المستخدم الذي تريد حظره:');
  }
  else if (data === 'admin_unblock_user' && isAdmin(userId)) {
    userStates[userId] = 'awaiting_unblock_user_id';
    bot.sendMessage(userId, '✅ أرسل ID المستخدم الذي تريد إلغاء حظره:');
  }
  else if (data === 'admin_add_money' && isAdmin(userId)) {
    userStates[userId] = 'awaiting_add_money_user_id';
    bot.sendMessage(userId, '💰 أرسل ID المستخدم الذي تريد إضافة محفظة له:');
  }
  else if (data === 'admin_remove_money' && isAdmin(userId)) {
    userStates[userId] = 'awaiting_remove_money_user_id';
    bot.sendMessage(userId, '💸 أرسل ID المستخدم الذي تريد خصم محفظة منه:');
  }
  else if (data === 'admin_list_users' && isAdmin(userId)) {
    delete userStates[userId]; // مسح أي حالة سابقة
    showAllUsers(userId);
  }
  else if (data === 'admin_last_10_users' && isAdmin(userId)) {
    delete userStates[userId]; // مسح أي حالة سابقة
    showLast10Users(userId);
  }
  else if (data === 'admin_search_user' && isAdmin(userId)) {
    userStates[userId] = 'awaiting_search_user';
    bot.sendMessage(userId, '🔍 أرسل ID المستخدم أو اليوزر (@username) للبحث:');
  }
  else if (data.startsWith('quick_block_') && isAdmin(userId)) {
    const targetUserId = parseInt(data.split('_')[2]);
    
    // حماية الأدمن الرئيسي من الحظر
    if (targetUserId === ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, { text: '❌ لا يمكن حظر الأدمن الرئيسي!', show_alert: true });
    }
    
    db.prepare('UPDATE users SET is_blocked = 1 WHERE user_id = ?').run(targetUserId);
    bot.answerCallbackQuery(query.id, { text: '✅ تم حظر المستخدم', show_alert: true });
    searchUser(userId, targetUserId.toString());
  }
  else if (data.startsWith('quick_unblock_') && isAdmin(userId)) {
    const targetUserId = parseInt(data.split('_')[2]);
    db.prepare('UPDATE users SET is_blocked = 0, failed_tasks_count = 0, last_failed_task_time = NULL WHERE user_id = ?').run(targetUserId);
    bot.answerCallbackQuery(query.id, { text: '✅ تم إلغاء حظر المستخدم وإعادة المحاولات', show_alert: true });
    searchUser(userId, targetUserId.toString());
  }
  else if (data.startsWith('edit_balance_') && isAdmin(userId)) {
    const targetUserId = parseInt(data.split('_')[2]);
    userStates[userId] = { state: 'awaiting_balance_edit', targetUserId: targetUserId };
    bot.sendMessage(userId, 
      '💰 أرسل المبلغ لتعديل المحفظة:\n\n' +
      '• للإضافة: أرسل رقم موجب مثل 50 أو +50\n' +
      '• للخصم: أرسل رقم سالب مثل -50\n\n' +
      'مثال: 30 (يضيف 30 جنيه)\n' +
      'مثال: -20 (يخصم 20 جنيه)'
    );
  }
  else if (data === 'add_admin' && isAdmin(userId)) {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      bot.answerCallbackQuery(query.id, { text: '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط', show_alert: true });
      return;
    }
    userStates[userId] = 'awaiting_add_admin_id';
    bot.sendMessage(userId, '➕ أرسل ID المستخدم الذي تريد إضافته كأدمن:');
  }
  else if (data === 'remove_admin' && isAdmin(userId)) {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      bot.answerCallbackQuery(query.id, { text: '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط', show_alert: true });
      return;
    }
    userStates[userId] = 'awaiting_remove_admin_id';
    bot.sendMessage(userId, '🗑️ أرسل ID الأدمن الذي تريد حذفه:');
  }
  else if (data === 'broadcast_all' && isAdmin(userId)) {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      bot.answerCallbackQuery(query.id, { text: '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط', show_alert: true });
      return;
    }
    userStates[userId] = 'awaiting_broadcast_all_message';
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(userId, '📣 أرسل الرسالة التي تريد إرسالها لجميع المستخدمين:\n\n(يمكنك إرسال نص، صورة، أو فيديو)');
  }
  else if (data === 'broadcast_single' && isAdmin(userId)) {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      bot.answerCallbackQuery(query.id, { text: '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط', show_alert: true });
      return;
    }
    userStates[userId] = 'awaiting_broadcast_single_id';
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(userId, '👤 أرسل ID المستخدم الذي تريد إرسال الرسالة له:');
  }
  else if (data === 'back_to_admin' && isAdmin(userId)) {
    delete userStates[userId]; // مسح أي حالة سابقة
    bot.sendMessage(userId, '⚙️ لوحة التحكم:', { reply_markup: getAdminKeyboard(userId) });
  }
  else if (data === 'back_to_users_menu' && isAdmin(userId)) {
    delete userStates[userId]; // مسح أي حالة سابقة
    showAdminUsersMenu(userId);
  }
  else if (data === 'withdraw_cancel') {
    // إزالة علامة طلب السحب النشط
    delete pendingWithdrawals[userId];
    delete userStates[userId]; // مسح أي حالة سابقة
    bot.editMessageText('❌ تم إلغاء طلب السحب', { chat_id: userId, message_id: messageId });
  }
  else if (data === 'withdraw_method_vodafone') {
    bot.answerCallbackQuery(query.id);
    // حفظ طريقة السحب مؤقتاً
    pendingWithdrawals[userId] = { method: 'vodafone' };
    // طلب المبلغ
    const user = db.prepare('SELECT balance FROM users WHERE user_id = ?').get(userId);
    userStates[userId] = 'awaiting_withdraw_amount';
    bot.sendMessage(userId, 
      `💰 رصيدك الحالي: ${user.balance} جنيه\n\n` +
      `💳 أرسل المبلغ الذي تريد سحبه:\n\n` +
      `(الحد الأدنى: 5 جنيه)`
    );
  }
  else if (data === 'withdraw_method_binance') {
    bot.answerCallbackQuery(query.id);
    // حفظ طريقة السحب مؤقتاً
    pendingWithdrawals[userId] = { method: 'binance' };
    // طلب المبلغ
    const user = db.prepare('SELECT balance FROM users WHERE user_id = ?').get(userId);
    userStates[userId] = 'awaiting_withdraw_amount';
    bot.sendMessage(userId, 
      `💰 رصيدك الحالي: ${user.balance} جنيه\n\n` +
      `💳 أرسل المبلغ الذي تريد سحبه:\n\n` +
      `(الحد الأدنى: 5 جنيه)`
    );
  }
  else if (data.startsWith('withdraw_paid_')) {
    const requestId = parseInt(data.split('_')[2]);
    if (isAdmin(userId)) {
      const request = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ? AND status = ?').get(requestId, 'pending');
      
      if (!request) {
        return bot.answerCallbackQuery(query.id, { text: '❌ الطلب غير موجود أو تم معالجته', show_alert: true });
      }
      
      const user = db.prepare('SELECT balance, username FROM users WHERE user_id = ?').get(request.user_id);
      const withdrawAmount = request.amount;
      const usdRate = parseFloat(getSetting('usd_rate')) || 50;
      
      // خصم المبلغ من الرصيد
      db.prepare('UPDATE users SET balance = balance - ? WHERE user_id = ?').run(withdrawAmount, request.user_id);
      
      // تحديث حالة الطلب في قاعدة البيانات
      db.prepare('UPDATE withdrawal_requests SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?').run('approved', requestId);
      
      // إزالة من الذاكرة المؤقتة
      delete pendingWithdrawals[request.user_id];
      
      // إعداد رسالة للمستخدم
      let walletType = request.method === 'binance' ? 'بينانس' : 'فودافون كاش';
      let displayAmount = `${withdrawAmount} جنيه`;
      
      if (request.method === 'binance') {
        const amountInUSD = (withdrawAmount / usdRate).toFixed(2);
        displayAmount = `${withdrawAmount} جنيه (${amountInUSD} USDT)`;
      }
      
      // إرسال إشعار للمستخدم
      bot.sendMessage(request.user_id, 
        `✅ تم الدفع بنجاح!\n\n` +
        `💰 المبلغ: ${displayAmount}\n` +
        `📱 الطريقة: ${walletType}\n` +
        `💳 المحفظة: ${request.wallet_info}\n\n` +
        `تأكد من وصول المبلغ إلى محفظتك`
      );
      
      // إعداد اسم المستخدم للعرض
      const username = user.username ? `@${user.username}` : 'لا يوجد';
      
      // تحديث رسالة الأدمن
      bot.editMessageText(
        `✅ تم تأكيد الدفع\n\n` +
        `👤 المستخدم: ${username}\n` +
        `🆔 ID: ${request.user_id}\n` +
        `💰 المبلغ: ${displayAmount}\n` +
        `💳 المحفظة: ${request.wallet_info}`,
        { chat_id: userId, message_id: messageId }
      );
      
      bot.answerCallbackQuery(query.id, { text: '✅ تم تأكيد الدفع', show_alert: false });
      
      logInfo('Admin confirmed withdrawal payment', { 
        adminId: userId, 
        targetUserId, 
        amount: withdrawAmount,
        method: withdrawal.method,
        wallet: withdrawal.wallet
      });
    }
  }
  else if (data.startsWith('withdraw_reject_')) {
    const requestId = parseInt(data.split('_')[2]);
    if (isAdmin(userId)) {
      const request = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ? AND status = ?').get(requestId, 'pending');
      
      if (!request) {
        return bot.answerCallbackQuery(query.id, { text: '❌ الطلب غير موجود أو تم معالجته', show_alert: true });
      }
      
      // تحديث حالة الطلب في قاعدة البيانات
      db.prepare('UPDATE withdrawal_requests SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?').run('rejected', requestId);
      
      // إزالة من الذاكرة المؤقتة
      delete pendingWithdrawals[request.user_id];
      
      // إرسال إشعار للمستخدم
      bot.sendMessage(request.user_id, 
        `❌ تم رفض طلب السحب\n\n` +
        `المبلغ: ${request.amount} جنيه\n\n` +
        `يمكنك التواصل مع الدعم لمعرفة السبب`
      );
      
      // تحديث رسالة الأدمن
      bot.editMessageText(
        `❌ تم رفض الطلب\n\n` +
        `المستخدم: ${request.user_id}\n` +
        `المبلغ: ${request.amount} جنيه`,
        { chat_id: userId, message_id: messageId }
      );
      
      bot.answerCallbackQuery(query.id, { text: '❌ تم رفض الطلب', show_alert: false });
      
      logInfo('Admin rejected withdrawal request', { 
        adminId: userId, 
        targetUserId: request.user_id, 
        amount: request.amount
      });
    }
  }
  else if (data.startsWith('delete_group_') && isAdmin(userId)) {
    const groupId = parseInt(data.split('_')[2]);
    
    // حذف جميع المهام المرتبطة بهذه المجموعة أولاً
    db.prepare('DELETE FROM tasks WHERE group_id = ?').run(groupId);
    
    // ثم حذف المجموعة
    db.prepare('DELETE FROM number_groups WHERE id = ?').run(groupId);
    
    bot.answerCallbackQuery(query.id, { text: '✅ تم حذف المجموعة', show_alert: true });
    showAdminGroups(userId);
  }
  else if (data.startsWith('revoke_group_') && isAdmin(userId)) {
    const groupId = parseInt(data.split('_')[2]);
    
    // البحث عن المهمة النشطة لهذه المجموعة
    const task = db.prepare('SELECT * FROM tasks WHERE group_id = ? AND status = ?').get(groupId, 'active');
    
    if (task) {
      // إلغاء المهمة وإرجاع المجموعة
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('revoked', task.id);
      db.prepare('UPDATE number_groups SET is_available = 1 WHERE id = ?').run(groupId);
      
      // إشعار المستخدم
      const user = db.prepare('SELECT username FROM users WHERE user_id = ?').get(task.user_id);
      const username = user && user.username ? `@${user.username}` : `ID: ${task.user_id}`;
      const isUserAdmin = task.user_id === ADMIN_ID;
      
      bot.sendMessage(task.user_id, 
        `⚠️ تم سحب المهمة من قبل الأدمن!\n\n` +
        `تم إلغاء مهمتك الحالية.\n` +
        `يمكنك الحصول على مهمة جديدة.`,
        { reply_markup: getMainKeyboard(isUserAdmin) }
      );
      
      bot.answerCallbackQuery(query.id, { text: `✅ تم سحب المجموعة من ${username}`, show_alert: true });
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ لم يتم العثور على مهمة نشطة', show_alert: true });
    }
    
    showAdminGroups(userId);
  }
  else if (data === 'add_new_group' && isAdmin(userId)) {
    userStates[userId] = 'awaiting_new_group';
    bot.sendMessage(userId, '➕ أرسل الأرقام (من 1 إلى 50 رقم)\nكل رقم في سطر منفصل:\n\nمثال:\n656546468464\n546465414546\n466546789123\n...');
  }
  else if (data === 'final_confirm_proof') {
    // حذف رسالة التأكيد
    bot.deleteMessage(userId, query.message.message_id).catch((err) => {
      logWarning('Failed to delete confirmation message', { userId, error: err.message });
    });
    handleFinalConfirmProof(userId);
  }
  else if (data === 'cancel_proof') {
    const isAdminUser = isAdmin(userId);
    // حذف رسالة التأكيد
    bot.deleteMessage(userId, query.message.message_id).catch((err) => {
      logWarning('Failed to delete confirmation message', { userId, error: err.message });
    });
    // إزالة القفل للسماح بإرسال المزيد من الصور
    delete userPhotoLocks[userId];
    bot.sendMessage(userId, '❌ تم إلغاء العملية\n\nيمكنك إرسال المزيد من الصور أو حذفها.', {
      reply_markup: {
        keyboard: [
          ['✅ تأكيد الإرسال'],
          ['❌ إلغاء وحذف الكل']
        ],
        resize_keyboard: true
      }
    });
  }
  else if (data.startsWith('delete_photo_')) {
    const photoIndex = parseInt(data.split('_')[2]);
    const photos = userProofPhotos[userId] || [];
    
    if (photoIndex >= 0 && photoIndex < photos.length) {
      photos.splice(photoIndex, 1);
      userProofPhotos[userId] = photos;
      
      bot.deleteMessage(userId, query.message.message_id).catch(() => {});
      
      const minScreenshots = parseInt(getSetting('min_screenshots') || '11');
      const maxScreenshots = parseInt(getSetting('max_screenshots') || '15');
      
      bot.sendMessage(userId, 
        `✅ تم حذف الصورة ${photoIndex + 1}\n\n` +
        `📊 الصور المتبقية: ${photos.length}/${maxScreenshots}\n` +
        `⚠️ الحد الأدنى: ${minScreenshots} صورة`,
        {
          reply_markup: {
            keyboard: [
              ['✅ تأكيد الإرسال'],
              ['🗑️ حذف صورة', '❌ إلغاء وحذف الكل']
            ],
            resize_keyboard: true
          }
        }
      );
    }
  }
  else if (data === 'cancel_delete_photo') {
    bot.deleteMessage(userId, query.message.message_id).catch(() => {});
    bot.sendMessage(userId, '❌ تم إلغاء العملية');
  }
  else if (data.startsWith('delete_photo_')) {
    const photoIndex = parseInt(data.split('_')[2]);
    const photos = userProofPhotos[userId] || [];
    
    if (photoIndex >= 0 && photoIndex < photos.length) {
      photos.splice(photoIndex, 1);
      userProofPhotos[userId] = photos;
      
      bot.deleteMessage(userId, query.message.message_id).catch(() => {});
      
      const minScreenshots = parseInt(getSetting('min_screenshots') || '11');
      const maxScreenshots = parseInt(getSetting('max_screenshots') || '15');
      
      bot.sendMessage(userId, 
        `✅ تم حذف الصورة ${photoIndex + 1}\n\n` +
        `📊 الصور المتبقية: ${photos.length}/${maxScreenshots}\n` +
        `⚠️ الحد الأدنى: ${minScreenshots} صورة`,
        {
          reply_markup: {
            keyboard: [
              ['✅ تأكيد الإرسال'],
              ['🗑️ حذف صورة', '❌ إلغاء وحذف الكل']
            ],
            resize_keyboard: true
          }
        }
      );
    }
  }
  else if (data === 'cancel_delete_photo') {
    bot.deleteMessage(userId, query.message.message_id).catch(() => {});
    bot.sendMessage(userId, '❌ تم إلغاء العملية');
  }
  else if (data.startsWith('review_task_')) {
    const taskId = parseInt(data.split('_')[2]);
    reviewTask(userId, taskId);
  }
  else if (data.startsWith('approve_task_')) {
    const taskId = parseInt(data.split('_')[2]);
    approveTask(userId, taskId, query.message.message_id);
  }
  else if (data.startsWith('reject_task_')) {
    const taskId = parseInt(data.split('_')[2]);
    rejectTask(userId, taskId, query.message.message_id);
  }
  else if (data === 'back_to_approvals' && isAdmin(userId)) {
    showPendingApprovals(userId);
  }
  else if (data.startsWith('review_pending_group_')) {
    const groupId = parseInt(data.split('_')[3]);
    reviewPendingGroup(userId, groupId);
  }
  else if (data.startsWith('return_group_')) {
    const groupId = parseInt(data.split('_')[2]);
    returnGroup(userId, groupId);
  }
  else if (data.startsWith('delete_rejected_group_')) {
    const groupId = parseInt(data.split('_')[3]);
    deleteRejectedGroup(userId, groupId);
  }
});

// الحصول على مهمة جديدة
async function handleNewTask(userId, isAdminUser) {
  // منع إنشاء مهام متعددة في نفس الوقت (Race Condition Protection)
  if (taskCreationLocks[userId]) {
    const lockTime = Date.now() - taskCreationLocks[userId];
    if (lockTime < 3000) { // قفل لمدة 3 ثواني
      return; // تجاهل الطلب المكرر
    }
  }
  taskCreationLocks[userId] = Date.now();
  
  // التحقق من البان التلقائي
  const banStatus = checkAndResetBan(userId);
  
  if (banStatus.isBanned) {
    const supportText = getSetting('support_text');
    return bot.sendMessage(userId, 
      `⛔ تم حظرك من استخدام البوت!\n\n` +
      `❌ السبب: فشلت في إتمام 5 مهام متتالية\n\n` +
      `📞 إذا كنت تعتقد أن هناك خطأ، يرجى التواصل مع الدعم:\n\n` +
      `${supportText}`,
      { reply_markup: { remove_keyboard: true } }
    );
  }
  
  // التحقق من وجود مهمة ملغاة مؤقتاً
  const cancelledTask = cancelledTasks[userId];
  if (cancelledTask) {
    // التحقق من أن الدقيقتين لم تنتهي
    const elapsedTime = Date.now() - cancelledTask.cancelTime;
    if (elapsedTime <= 2 * 60 * 1000) {
      // استرجاع المهمة تلقائياً
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('active', cancelledTask.taskId);
      
      // استرجاع الصور إذا كانت موجودة
      if (cancelledTask.photos.length > 0) {
        userProofPhotos[userId] = cancelledTask.photos;
      }
      
      // وضع علامة أن هذه الفرصة الثانية
      secondCancellation[userId] = cancelledTask.taskId;
      
      delete cancelledTasks[userId];
      
      // عرض المهمة
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(cancelledTask.taskId);
      const group = db.prepare('SELECT * FROM number_groups WHERE id = ?').get(task.group_id);
      const adText = getSetting('advertisement_text');
      const reward = getSetting('reward_amount');
      
      // حساب الوقت المتبقي الحقيقي بناءً على expires_at
      const timeQuery = db.prepare("SELECT (strftime('%s', expires_at) - strftime('%s', 'now')) as remaining_seconds FROM tasks WHERE id = ?").get(task.id);
      const remainingMinutes = Math.floor(timeQuery.remaining_seconds / 60);
      
      let timeMessage = '';
      if (remainingMinutes > 0) {
        const hours = Math.floor(remainingMinutes / 60);
        const minutes = remainingMinutes % 60;
        timeMessage = `⏰ الوقت المتبقي: ${hours > 0 ? hours + ' ساعة و' : ''}${minutes} دقيقة`;
      } else {
        timeMessage = '⏰ انتهى الوقت!';
      }
      
      // رسالة الاسترجاع
      bot.sendMessage(userId, `✅ تم استرجاع مهمتك!`);
      
      // نص الإعلان في رسالة منفصلة
      setTimeout(() => {
        bot.sendMessage(userId, adText);
      }, 300);
      
      // الأرقام + المكافأة
      setTimeout(() => {
        const numbersCount = group.numbers.split('\n').filter(n => n.trim().length > 0).length;
        const formattedNumbers = formatNumbersForCopy(group.numbers);
        const taskRequirements = getSetting('task_requirements') || 
          `1️⃣ أرسل 10 سكرينات من داخل الشات (سكرينة من داخل الشات بعد ما أرسلت الرسالة)\n` +
          `2️⃣ أرسل سكرينات من خارج الشات تثبت إرسال الرسائل لجميع الأرقام`;
        const minScreenshots = parseInt(getSetting('min_screenshots') || '11');
        const maxScreenshots = parseInt(getSetting('max_screenshots') || '15');
        
        bot.sendMessage(userId, 
          `📱 الأرقام (${numbersCount} رقم):\n\n` +
          `${formattedNumbers}\n\n` +
          `⚠️ *تحذير مهم:* انتظر دقيقة أو أكثر بين كل رسالة\n` +
          `   (حتى لا يتم حظرك من واتساب)\n\n` +
          `💵 المكافأة: ${reward} جنيه\n\n` +
          `📋 المطلوب:\n` +
          `${taskRequirements}\n\n` +
          `⚠️ الحد الأدنى: ${minScreenshots} صورة\n` +
          `⚠️ الحد الأقصى: ${maxScreenshots} صورة\n` +
          `الصور المستلمة: ${task.proof_count}/${maxScreenshots}`,
          { parse_mode: 'Markdown' }
        );
      }, 1200);
      
      setTimeout(() => {
        bot.sendMessage(userId, 
          `${timeMessage}\n\n` +
          `⚠️ إذا ألغيت المهمة مرة أخرى، سيتم حذفها نهائياً!`,
          {
            reply_markup: {
              keyboard: [
                ['⏱️ عرض الوقت المتبقي'],
                ['📸 إرسال الإثبات'],
                ['❌ إلغاء المهمة']
              ],
              resize_keyboard: true
            }
          }
        );
      }, 1000);
      
      return;
    }
  }
  
  // التحقق من وجود مهمة نشطة
  const activeTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
  
  // التحقق من وجود مهمة في انتظار الموافقة
  const pendingTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'pending_approval');
  
  if (pendingTask) {
    return bot.sendMessage(userId, 
      `⏳ لديك مهمة في انتظار موافقة الأدمن!\n\n` +
      `📋 رقم المهمة: ${pendingTask.id}\n` +
      `📸 عدد الصور: ${pendingTask.proof_count}\n\n` +
      `يرجى الانتظار حتى يتم مراجعة مهمتك.`
    );
  }
  
  if (activeTask) {
    // عرض المهمة الحالية
    const group = db.prepare('SELECT * FROM number_groups WHERE id = ?').get(activeTask.group_id);
    const adText = getSetting('advertisement_text');
    const reward = getSetting('reward_amount');
    
    // حساب الوقت المتبقي الحقيقي بناءً على expires_at
    const timeQuery = db.prepare("SELECT (strftime('%s', expires_at) - strftime('%s', 'now')) as remaining_seconds FROM tasks WHERE id = ?").get(activeTask.id);
    const remainingMinutes = Math.floor(timeQuery.remaining_seconds / 60);
    
    let timeMessage = '';
    if (remainingMinutes > 0) {
      const hours = Math.floor(remainingMinutes / 60);
      const minutes = remainingMinutes % 60;
      timeMessage = `⏰ الوقت المتبقي: ${hours > 0 ? hours + ' ساعة و' : ''}${minutes} دقيقة`;
    } else {
      timeMessage = '⏰ انتهى الوقت! سيتم إلغاء المهمة قريباً';
    }
    
    // رسالة التنبيه
    bot.sendMessage(userId, `⚠️ لديك مهمة نشطة بالفعل!`);
    
    // نص الإعلان في رسالة منفصلة
    setTimeout(() => {
      bot.sendMessage(userId, adText);
    }, 300);
    
    // الأرقام + المكافأة
    setTimeout(() => {
      const numbersCount = group.numbers.split('\n').filter(n => n.trim().length > 0).length;
      const formattedNumbers = formatNumbersForCopy(group.numbers);
      const taskRequirements = getSetting('task_requirements') || 
        `1️⃣ أرسل 10 سكرينات من داخل الشات (سكرينة من داخل الشات بعد ما أرسلت الرسالة)\n` +
        `2️⃣ أرسل سكرينات من خارج الشات تثبت إرسال الرسائل لجميع الأرقام`;
      const minScreenshots = parseInt(getSetting('min_screenshots') || '11');
      const maxScreenshots = parseInt(getSetting('max_screenshots') || '15');
      
      bot.sendMessage(userId, 
        `📱 الأرقام (${numbersCount} رقم):\n\n` +
        `${formattedNumbers}\n\n` +
        `⚠️ *تحذير مهم:* انتظر دقيقة أو أكثر بين كل رسالة\n` +
        `   (حتى لا يتم حظرك من واتساب)\n\n` +
        `💵 المكافأة: ${reward} جنيه\n\n` +
        `📋 المطلوب:\n` +
        `${taskRequirements}\n\n` +
        `⚠️ الحد الأدنى: ${minScreenshots} صورة\n` +
        `⚠️ الحد الأقصى: ${maxScreenshots} صورة\n` +
        `الصور المستلمة: ${activeTask.proof_count}/${maxScreenshots}`,
        { parse_mode: 'Markdown' }
      );
    }, 1200);
    
    // إرسال الوقت المتبقي
    setTimeout(() => {
      bot.sendMessage(userId, 
        `${timeMessage}\n\n` +
        `⚠️ أكمل المهمة الحالية أولاً.`,
        {
          reply_markup: {
            keyboard: [
              ['⏱️ عرض الوقت المتبقي'],
              ['📸 إرسال الإثبات'],
              ['❌ إلغاء المهمة']
            ],
            resize_keyboard: true
          }
        }
      );
    }, 1000);
    
    return;
  }
  
  const availableGroup = db.prepare('SELECT * FROM number_groups WHERE is_available = 1 LIMIT 1').get();
  
  if (!availableGroup) {
    return bot.sendMessage(userId, '❌ لا توجد مجموعات متاحة حالياً. حاول لاحقاً.');
  }
  
  db.prepare('INSERT INTO tasks (user_id, group_id, status) VALUES (?, ?, ?)').run(userId, availableGroup.id, 'active');
  db.prepare('UPDATE number_groups SET is_available = 0 WHERE id = ?').run(availableGroup.id);
  
  const adText = getSetting('advertisement_text');
  const reward = getSetting('reward_amount');
  
  // 1. إرسال رسالة الحالة أولاً
  bot.sendMessage(userId, `✅ تم تعيين مهمة جديدة لك!`);
  
  // 2. الانتظار 300ms ثم إرسال نص الإعلان لوحده (سهل النسخ)
  setTimeout(() => {
    bot.sendMessage(userId, adText);
  }, 300);
  
  // 3. الانتظار 1200ms ثم إرسال الأرقام + المكافأة + المتطلبات
  setTimeout(() => {
    const numbersCount = availableGroup.numbers.split('\n').filter(n => n.trim().length > 0).length;
    const formattedNumbers = formatNumbersForCopy(availableGroup.numbers);
    const taskRequirements = getSetting('task_requirements') || 
      `1️⃣ أرسل 10 سكرينات من داخل الشات (سكرينة من داخل الشات بعد ما أرسلت الرسالة)\n` +
      `2️⃣ أرسل سكرينات من خارج الشات تثبت إرسال الرسائل لجميع الأرقام`;
    const minScreenshots = parseInt(getSetting('min_screenshots') || '11');
    const maxScreenshots = parseInt(getSetting('max_screenshots') || '15');
    
    bot.sendMessage(userId, 
      `📱 الأرقام (${numbersCount} رقم):\n\n` +
      `${formattedNumbers}\n\n` +
      `⚠️ *تحذير مهم:* انتظر دقيقة أو أكثر بين كل رسالة\n` +
      `   (حتى لا يتم حظرك من واتساب)\n\n` +
      `💵 المكافأة: ${reward} جنيه\n\n` +
      `📋 المطلوب:\n` +
      `${taskRequirements}\n\n` +
      `⚠️ الحد الأدنى: ${minScreenshots} صورة\n` +
      `⚠️ الحد الأقصى: ${maxScreenshots} صورة\n` +
      `عند الانتهاء، أرسل الصور واحدة تلو الأخرى.`,
      { parse_mode: 'Markdown' }
    );
  }, 1200);
  
  // 4. الانتظار إضافي ثم إرسال رسالة الوقت المتبقي مع الكيبورد
  setTimeout(() => {
    const taskTimeout = parseInt(getSetting('task_timeout'));
    bot.sendMessage(userId, 
      `⏰ الوقت المتبقي: ${taskTimeout} دقيقة\n\n` +
      `⚠️ يجب إكمال المهمة خلال الوقت المحدد وإلا سيتم إلغاؤها تلقائياً.`,
      {
        reply_markup: {
          keyboard: [
            ['⏱️ عرض الوقت المتبقي'],
            ['📸 إرسال الإثبات'],
            ['❌ إلغاء المهمة']
          ],
          resize_keyboard: true
        }
      }
    );
  }, 1500);
  
  // ملاحظة: تم حذف setTimeout وسيتم الاعتماد على نظام الفحص الدوري checkExpiredTasks()
  // الذي يعمل كل 60 ثانية ويتحقق من المهام المنتهية في قاعدة البيانات
}

// عرض الملف الشخصي
function handleProfile(userId) {
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  const completedTasks = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'completed');
  const totalEarnings = completedTasks.count * parseFloat(getSetting('reward_amount'));
  
  const username = user.username ? `@${user.username}` : 'لا يوجد';
  
  bot.sendMessage(userId, 
    `👤 ملفي الشخصي:\n\n` +
    `🆔 ID: \`${user.user_id}\`\n` +
    `📝 اليوزر: ${username}\n` +
    `💰 المحفظة: ${user.balance} جنيه\n` +
    `📊 المهام المكتملة: ${completedTasks.count}\n` +
    `💵 إجمالي الأرباح: ${totalEarnings} جنيه\n` +
    `📅 تاريخ التسجيل: ${user.created_at}`,
    { parse_mode: 'Markdown' }
  );
}

// إلغاء المهمة
function handleCancelTask(userId, isAdminUser) {
  const activeTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
  
  if (!activeTask) {
    return bot.sendMessage(userId, '❌ ليس لديك مهمة نشطة لإلغائها.', { reply_markup: getMainKeyboard(isAdminUser) });
  }
  
  // التحقق إذا كانت هذه المرة الثانية للإلغاء
  if (secondCancellation[userId] === activeTask.id) {
    // الإلغاء النهائي (المرة الثانية) - حذف نهائي بدون فرصة للاسترجاع
    db.prepare('DELETE FROM tasks WHERE id = ?').run(activeTask.id);
    db.prepare('UPDATE number_groups SET is_available = 1 WHERE id = ?').run(activeTask.group_id);
    
    // تسجيل محاولة فاشلة
    const failResult = recordFailedTask(userId);
    
    // حذف الصور المؤقتة والبيانات المؤقتة
    delete userProofPhotos[userId];
    delete cancelledTasks[userId];
    delete secondCancellation[userId];
    
    logInfo('User cancelled task for second time - permanent deletion', { userId, taskId: activeTask.id });
    
    let message = `❌ تم حذف المهمة نهائياً!\n\n` +
      `تم إرجاع مجموعة الأرقام.\n`;
    
    if (failResult.banned && failResult.permanent) {
      const supportText = getSetting('support_text');
      message = `⛔ تم حظرك من استخدام البوت!\n\n` +
        `❌ السبب: فشلت في إتمام 5 مهام متتالية\n\n` +
        `📞 إذا كنت تعتقد أن هناك خطأ، يرجى التواصل مع الدعم:\n\n` +
        `${supportText}`;
      return bot.sendMessage(userId, message, { reply_markup: { remove_keyboard: true } });
    } else if (failResult.count === 4) {
      message += `\n⚠️ تحذير نهائي!\n\n` +
        `🚨 هذه آخر فرصة!\n` +
        `إذا فشلت في إتمام المهمة القادمة، سيتم حظرك للأبد.`;
    } else if (failResult.count >= 1) {
      message += `\n⚠️ تحذير!\n\n` +
        `في حالة سحب وإرجاع المجموعة أكثر من مرة ستأخذ بان.`;
    }
    
    // إرجاع القائمة الرئيسية بدون زر الاسترجاع
    return bot.sendMessage(userId, message, { reply_markup: getMainKeyboard(isAdminUser) });
  }
  
  // الإلغاء الأول (إعطاء فرصة ثانية)
  cancelledTasks[userId] = {
    taskId: activeTask.id,
    groupId: activeTask.group_id,
    photos: userProofPhotos[userId] || [],
    cancelTime: Date.now()
  };
  
  // تحديث حالة المهمة إلى ملغاة مؤقتاً
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('temp_cancelled', activeTask.id);
  
  bot.sendMessage(userId, 
    `⚠️ تم إلغاء المهمة!\n\n` +
    `⏰ لديك دقيقتان لاسترجاع المهمة إذا ألغيتها بالخطأ.\n\n` +
    `⚠️ تحذير: إذا ألغيتها مرة أخرى، سيتم حذفها نهائياً!\n\n` +
    `بعد دقيقتين سيتم حذف المهمة نهائياً وإرجاع المجموعة.`,
    {
      reply_markup: {
        keyboard: [
          ['↩️ استرجاع المهمة'],
          ['🔙 القائمة الرئيسية']
        ],
        resize_keyboard: true
      }
    }
  );
  
  // ملاحظة: تم حذف setTimeout وسيتم الاعتماد على نظام الفحص الدوري checkCancelledTasks()
  // الذي يعمل كل 30 ثانية ويتحقق من المهام الملغاة مؤقتاً في قاعدة البيانات
}

// استرجاع المهمة الملغاة
function handleRestoreTask(userId, isAdminUser) {
  const cancelledTask = cancelledTasks[userId];
  
  if (!cancelledTask) {
    return bot.sendMessage(userId, '❌ لا توجد مهمة ملغاة لاسترجاعها.', { reply_markup: getMainKeyboard(isAdminUser) });
  }
  
  // التحقق من أن الدقيقتين لم تنتهي
  const elapsedTime = Date.now() - cancelledTask.cancelTime;
  if (elapsedTime > 2 * 60 * 1000) {
    delete cancelledTasks[userId];
    return bot.sendMessage(userId, '❌ انتهى وقت الاسترجاع (دقيقتان).', { reply_markup: getMainKeyboard(isAdminUser) });
  }
  
  // استرجاع المهمة
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('active', cancelledTask.taskId);
  
  // استرجاع الصور إذا كانت موجودة
  if (cancelledTask.photos.length > 0) {
    userProofPhotos[userId] = cancelledTask.photos;
  }
  
  // وضع علامة أن هذه المحاولة الثانية (إذا ألغى مرة أخرى سيتم الحذف النهائي)
  secondCancellation[userId] = cancelledTask.taskId;
  
  delete cancelledTasks[userId];
  
  logInfo('User restored cancelled task - second chance', { userId, taskId: cancelledTask.taskId });
  
  // حساب الوقت المتبقي الحقيقي بناءً على expires_at
  const task = db.prepare('SELECT expires_at FROM tasks WHERE id = ?').get(cancelledTask.taskId);
  const timeQuery = db.prepare("SELECT (strftime('%s', expires_at) - strftime('%s', 'now')) as remaining_seconds FROM tasks WHERE id = ?").get(cancelledTask.taskId);
  const remainingMinutes = Math.floor(timeQuery.remaining_seconds / 60);
  
  let timeMessage = '';
  if (remainingMinutes > 0) {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    timeMessage = `⏰ الوقت المتبقي: ${hours > 0 ? hours + ' ساعة و' : ''}${minutes} دقيقة`;
  }
  
  bot.sendMessage(userId, 
    `✅ تم استرجاع المهمة بنجاح!\n\n` +
    (timeMessage ? `${timeMessage}\n\n` : '') +
    `⚠️ تحذير: هذه فرصتك الأخيرة!\n` +
    `إذا ألغيت المهمة مرة أخرى، سيتم حذفها نهائياً بدون إمكانية الاسترجاع.`,
    {
      reply_markup: {
        keyboard: [
          ['⏱️ عرض الوقت المتبقي'],
          ['📸 إرسال الإثبات'],
          ['❌ إلغاء المهمة']
        ],
        resize_keyboard: true
      }
    }
  );
}

// عرض الوقت المتبقي
function handleShowRemainingTime(userId) {
  const activeTask = db.prepare("SELECT created_at, (strftime('%s', 'now') - strftime('%s', created_at)) as elapsed_seconds FROM tasks WHERE user_id = ? AND status = ?").get(userId, 'active');
  
  if (!activeTask) {
    return bot.sendMessage(userId, '❌ ليس لديك مهمة نشطة.');
  }
  
  const taskTimeout = parseInt(getSetting('task_timeout'));
  const elapsedMinutes = Math.floor(activeTask.elapsed_seconds / 60);
  const remainingMinutes = taskTimeout - elapsedMinutes;
  
  if (remainingMinutes > 0) {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    bot.sendMessage(userId, 
      `⏰ الوقت المتبقي:\n\n` +
      `${hours > 0 ? hours + ' ساعة و' : ''}${minutes} دقيقة\n\n` +
      `⚠️ أكمل المهمة قبل انتهاء الوقت!`
    );
  } else {
    bot.sendMessage(userId, '⏰ انتهى الوقت! سيتم إلغاء المهمة قريباً.');
  }
}

// تذكير بإرسال الإثبات
function handleSendProofReminder(userId) {
  const activeTask = db.prepare('SELECT proof_count FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
  
  if (!activeTask) {
    return bot.sendMessage(userId, '❌ ليس لديك مهمة نشطة.');
  }
  
  const currentPhotos = userProofPhotos[userId] ? userProofPhotos[userId].length : 0;
  const minScreenshots = parseInt(getSetting('min_screenshots') || '11');
  const maxScreenshots = parseInt(getSetting('max_screenshots') || '15');
  
  bot.sendMessage(userId, 
    `📸 إرسال الإثبات:\n\n` +
    `أرسل الصور الآن:\n` +
    `• 10 سكرينات من داخل الشات\n` +
    `• سكرينات من خارج الشات\n\n` +
    `الصور المستلمة: ${currentPhotos}/${maxScreenshots}\n\n` +
    `⚠️ الحد الأدنى: ${minScreenshots} صورة\n` +
    `⚠️ الحد الأقصى: ${maxScreenshots} صورة\n` +
    `⚠️ أرسل الصور واحدة تلو الأخرى.\n\n` +
    `⚠️ تحذير: بعد تأكيد الإرسال لا يمكن التراجع!`
  );
}

// بدء إرسال الإثبات
function handleStartProofSubmission(userId) {
  const activeTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
  
  if (!activeTask) {
    return bot.sendMessage(userId, '❌ ليس لديك مهمة نشطة.');
  }
  
  // تفعيل حالة إرسال الإثبات
  userStates[userId] = 'sending_proof';
  
  // حذف أي صور قديمة والبدء من الصفر
  delete userProofPhotos[userId];
  delete userPhotoLocks[userId];
  
  const minScreenshots = parseInt(getSetting('min_screenshots') || '11');
  const maxScreenshots = parseInt(getSetting('max_screenshots') || '15');
  
  bot.sendMessage(userId, 
    `📸 إرسال الإثبات\n\n` +
    `⚠️ الحد الأدنى: ${minScreenshots} صورة\n` +
    `⚠️ الحد الأقصى: ${maxScreenshots} صورة\n\n` +
    `📤 ابدأ بإرسال الصور الآن (فردية أو مجموعات)\n\n` +
    `بعد الانتهاء، اضغط "✅ تأكيد الإرسال"`,
    {
      reply_markup: {
        keyboard: [
          ['✅ تأكيد الإرسال'],
          ['❌ إلغاء وحذف الكل']
        ],
        resize_keyboard: true
      }
    }
  );
}

// تأكيد إرسال الإثبات
async function handleConfirmProofSubmission(userId, isAdminUser) {
  try {
    const activeTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
    
    if (!activeTask) {
      return bot.sendMessage(userId, '❌ ليس لديك مهمة نشطة.', { reply_markup: getMainKeyboard(isAdminUser) });
    }
    
    const photos = userProofPhotos[userId] || [];
    const minScreenshots = parseInt(getSetting('min_screenshots') || '11');
    
    logInfo('User confirming photo submission', { userId, photoCount: photos.length });
    
    if (photos.length === 0) {
      return bot.sendMessage(userId, '❌ لم ترسل أي صور بعد!');
    }
    
    if (photos.length < minScreenshots) {
      return bot.sendMessage(userId, 
        `❌ عدد الصور غير كافٍ!\n\n` +
        `الصور المرسلة: ${photos.length}\n` +
        `الحد الأدنى: ${minScreenshots} صورة\n\n` +
        `أرسل المزيد من الصور.`
      );
    }
    
    // قفل إرسال الصور (منع المستخدم من إرسال المزيد)
    userPhotoLocks[userId] = true;
    logInfo('Photo submission locked for user', { userId });
    
    // إرسال رسالة انتظار
    const waitMsg = await bot.sendMessage(userId, '⏳ جاري تحضير الصور للمراجعة...');
    
    try {
      // إرسال الصور في مجموعات (Telegram يسمح بـ 10 صور كحد أقصى في كل مجموعة)
      const mediaGroups = [];
      for (let i = 0; i < photos.length; i += 10) {
        const chunk = photos.slice(i, i + 10);
        const mediaGroup = chunk.map((photoId, index) => ({
          type: 'photo',
          media: photoId,
          caption: i === 0 && index === 0 ? `📸 الصور المرسلة (${photos.length} صورة)` : undefined
        }));
        mediaGroups.push(mediaGroup);
      }
      
      // إرسال كل مجموعة
      for (const mediaGroup of mediaGroups) {
        await bot.sendMediaGroup(userId, mediaGroup);
        // انتظار قصير بين المجموعات
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // حذف رسالة الانتظار
      bot.deleteMessage(userId, waitMsg.message_id).catch(() => {});
      
      // عرض تأكيد نهائي
      bot.sendMessage(userId, 
        `👀 راجع الصور بدقة\n\n` +
        `📊 عدد الصور: ${photos.length}\n\n` +
        `⚠️ إذا وجدت صورة خاطئة:\n` +
        `اضغط "❌ إلغاء" ثم "❌ إلغاء وحذف الكل"\n` +
        `وأرسل الصور من جديد\n\n` +
        `✅ إذا كانت الصور صحيحة، اضغط "نعم، أرسل الآن"`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ نعم، أرسل الآن', callback_data: 'final_confirm_proof' },
                { text: '❌ إلغاء', callback_data: 'cancel_proof' }
              ]
            ]
          }
        }
      );
    } catch (error) {
      logError('Error sending media group', error, userId);
      bot.deleteMessage(userId, waitMsg.message_id).catch(() => {});
      delete userPhotoLocks[userId]; // إزالة القفل
      bot.sendMessage(userId, '❌ حدث خطأ في عرض الصور. حاول مرة أخرى.').catch(() => {});
    }
  } catch (error) {
    logError('Error in handleConfirmProofSubmission', error, userId);
    delete userPhotoLocks[userId]; // إزالة القفل
    bot.sendMessage(userId, '❌ حدث خطأ. حاول مرة أخرى.').catch(() => {});
  }
}

// إلغاء وحذف الصور
function handleCancelProofSubmission(userId, isAdminUser) {
  try {
    if (userProofPhotos[userId]) {
      const count = userProofPhotos[userId].length;
      delete userProofPhotos[userId];
      delete userPhotoLocks[userId];
      delete userStates[userId]; // حذف حالة إرسال الإثبات
      
      logInfo('User cancelled photo submission', { userId, photoCount: count });
      
      bot.sendMessage(userId, 
        `✅ تم حذف ${count} صورة\n\n` +
        `يمكنك البدء من جديد بالضغط على "📸 إرسال الإثبات"`,
        {
          reply_markup: {
            keyboard: [
              ['⏱️ عرض الوقت المتبقي'],
              ['📸 إرسال الإثبات'],
              ['❌ إلغاء المهمة']
            ],
            resize_keyboard: true
          }
        }
      );
    } else {
      delete userStates[userId]; // حذف حالة إرسال الإثبات
      bot.sendMessage(userId, 
        '❌ لا توجد صور لحذفها.',
        {
          reply_markup: {
            keyboard: [
              ['⏱️ عرض الوقت المتبقي'],
              ['📸 إرسال الإثبات'],
              ['❌ إلغاء المهمة']
            ],
            resize_keyboard: true
          }
        }
      );
    }
  } catch (error) {
    logError('Error cancelling proof submission', error, userId);
    bot.sendMessage(userId, '❌ حدث خطأ').catch(() => {});
  }
}

// التأكيد النهائي وإرسال الإثبات
function handleFinalConfirmProof(userId) {
  try {
    const activeTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
    
    if (!activeTask) {
      delete userPhotoLocks[userId]; // إزالة القفل
      return bot.sendMessage(userId, '❌ ليس لديك مهمة نشطة.');
    }
    
    const photos = userProofPhotos[userId] || [];
    
    if (photos.length < 11) {
      delete userPhotoLocks[userId]; // إزالة القفل
      return bot.sendMessage(userId, '❌ عدد الصور غير كافٍ!');
    }
    
    // حفظ الصور والعدد في قاعدة البيانات
    const photosJson = JSON.stringify(photos);
    db.prepare('UPDATE tasks SET proof_count = ?, proof_photos = ?, status = ? WHERE id = ?')
      .run(photos.length, photosJson, 'pending_approval', activeTask.id);
    
    // تغيير حالة المجموعة إلى معلقة (2)
    db.prepare('UPDATE number_groups SET is_available = 2 WHERE id = ?').run(activeTask.group_id);
    
    // حذف الصور المؤقتة والقفل والبيانات المؤقتة
    delete userProofPhotos[userId];
    delete userPhotoLocks[userId];
    delete userStates[userId]; // حذف حالة إرسال الإثبات
    delete secondCancellation[userId]; // حذف علامة المحاولة الثانية
    delete cancelledTasks[userId]; // حذف المهام الملغاة المؤقتة
    
    logInfo('User submitted proof for approval', { userId, photoCount: photos.length, taskId: activeTask.id });
    
    const isAdminUser = isAdmin(userId);
    const user = db.prepare('SELECT username FROM users WHERE user_id = ?').get(userId);
    const username = user && user.username ? `@${user.username}` : `ID: ${userId}`;
    
    // إرسال إشعار للأدمن
    bot.sendMessage(ADMIN_ID, 
      `🔔 طلب موافقة جديد!\n\n` +
      `👤 المستخدم: ${username}\n` +
      `🆔 ID: ${userId}\n` +
      `📸 عدد الصور: ${photos.length}\n` +
      `📋 رقم المهمة: ${activeTask.id}\n\n` +
      `اضغط على "✅ الموافقة والدفع" لمراجعة الطلبات`
    ).catch((err) => {
      logError('Failed to send admin notification', err);
    });
    
    bot.sendMessage(userId, 
      `✅ تم إرسال الإثبات بنجاح!\n\n` +
      `📸 عدد الصور المرسلة: ${photos.length}\n` +
      `⏳ في انتظار مراجعة الأدمن\n\n` +
      `سيتم إشعارك بالنتيجة قريباً`,
      { reply_markup: getMainKeyboard(isAdminUser) }
    );
  } catch (error) {
    logError('Error in handleFinalConfirmProof', error, userId);
    delete userPhotoLocks[userId]; // إزالة القفل في حالة الخطأ
    bot.sendMessage(userId, '❌ حدث خطأ. حاول مرة أخرى.').catch(() => {});
  }
}

// عرض الرصيد (دالة احتياطية)
function handleBalance(userId) {
  const user = db.prepare('SELECT balance FROM users WHERE user_id = ?').get(userId);
  bot.sendMessage(userId, `💰 محفظتك الحالية: ${user.balance} جنيه`);
}

// عرض الإحصائيات
function handleStats(userId) {
  const completed = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'completed');
  const pending = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
  
  bot.sendMessage(userId, 
    `📊 إحصائياتك:\n\n` +
    `✅ المهام المكتملة: ${completed.count}\n` +
    `⏳ المهام النشطة: ${pending.count}`
  );
}

// سحب الأرباح
function handleWithdraw(userId) {
  const user = db.prepare('SELECT balance FROM users WHERE user_id = ?').get(userId);
  
  if (user.balance < 5) {
    return bot.sendMessage(userId, '❌ الحد الأدنى للسحب هو 5 جنيه');
  }
  
  // التحقق من وجود طلب سحب نشط في الذاكرة
  if (pendingWithdrawals[userId]) {
    return bot.sendMessage(userId, '⚠️ لديك طلب سحب نشط بالفعل!\nانتظر حتى يتم معالجته أو قم بإلغائه.');
  }
  
  // التحقق من وجود طلب سحب نشط في قاعدة البيانات
  const activeRequest = db.prepare('SELECT * FROM withdrawal_requests WHERE user_id = ? AND status = ?').get(userId, 'pending');
  if (activeRequest) {
    return bot.sendMessage(userId, '⚠️ لديك طلب سحب نشط بالفعل!\nانتظر حتى يتم معالجته من قبل الأدمن.');
  }
  
  // عرض خيارات طريقة السحب في كل مرة
  bot.sendMessage(userId, '💳 اختر طريقة السحب:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📱 فودافون كاش', callback_data: 'withdraw_method_vodafone' }],
        [{ text: '💰 بينانس (Binance)', callback_data: 'withdraw_method_binance' }]
      ]
    }
  });
}

// معالجة حالات المستخدم
async function handleUserStates(userId, text, msg) {
  const state = userStates[userId];
  
  if (state === 'awaiting_wallet_vodafone') {
    // التحقق من صحة رقم فودافون كاش
    if (!isValidVodafoneCash(text)) {
      return bot.sendMessage(userId, '❌ رقم غير صحيح\n\n📱 أرسل محفظة الكاش:');
    }
    
    // تنظيف الرقم وحفظه مع نوع المحفظة
    let cleanPhone = text.trim().replace(/[\s\-\(\)]/g, '');
    if (cleanPhone.startsWith('+20')) {
      cleanPhone = cleanPhone.substring(3);
    } else if (cleanPhone.startsWith('20')) {
      cleanPhone = cleanPhone.substring(2);
    }
    
    // حفظ الرقم مع بادئة vodafone:
    db.prepare('UPDATE users SET wallet_address = ? WHERE user_id = ?').run(`vodafone:${cleanPhone}`, userId);
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم حفظ المحفظة بنجاح\n\n📱 ${cleanPhone}`);
    logInfo('User saved vodafone cash number', { userId, phone: cleanPhone });
    handleWithdraw(userId);
  }
  else if (state === 'awaiting_wallet_vodafone_temp') {
    // التحقق من صحة رقم فودافون كاش
    if (!isValidVodafoneCash(text)) {
      return bot.sendMessage(userId, '❌ رقم غير صحيح\n\n📱 أرسل محفظة الكاش:');
    }
    
    // تنظيف الرقم
    let cleanPhone = text.trim().replace(/[\s\-\(\)]/g, '');
    if (cleanPhone.startsWith('+20')) {
      cleanPhone = cleanPhone.substring(3);
    } else if (cleanPhone.startsWith('20')) {
      cleanPhone = cleanPhone.substring(2);
    }
    
    // حفظ المحفظة مؤقتاً مع المبلغ
    const amount = pendingWithdrawals[userId].amount;
    pendingWithdrawals[userId] = { 
      amount: amount, 
      method: 'vodafone',
      wallet: cleanPhone 
    };
    
    // حفظ الطلب في قاعدة البيانات
    db.prepare('INSERT INTO withdrawal_requests (user_id, amount, method, wallet_info, status) VALUES (?, ?, ?, ?, ?)').run(
      userId, 
      amount, 
      'vodafone', 
      cleanPhone, 
      'pending'
    );
    
    delete userStates[userId];
    
    // عرض رسالة تأكيد بدون أزرار
    bot.sendMessage(userId, 
      `✅ تم إرسال طلب السحب بنجاح!\n\n` +
      `💳 تفاصيل الطلب:\n` +
      `💰 المبلغ: ${amount} جنيه\n` +
      `📱 الطريقة: فودافون كاش\n` +
      `💳 المحفظة: ${cleanPhone}\n\n` +
      `⏳ سيتم معالجة طلبك من قبل الإدارة قريباً\n` +
      `📬 ستصلك رسالة عند تأكيد الدفع`
    );
    
    logInfo('User requested vodafone withdrawal', { userId, amount, phone: cleanPhone });
  }
  else if (state === 'awaiting_wallet_binance') {
    // التحقق من صحة Binance ID
    if (!isValidBinanceID(text)) {
      return bot.sendMessage(userId, '❌ رقم غير صحيح\n\n💰 أرسل Binance ID الخاص بك:');
    }
    
    const cleanID = text.trim();
    // حفظ الـ ID مع بادئة binance:
    db.prepare('UPDATE users SET wallet_address = ? WHERE user_id = ?').run(`binance:${cleanID}`, userId);
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم حفظ المحفظة بنجاح\n\n💰 ${cleanID}`);
    logInfo('User saved binance ID', { userId, binanceID: cleanID });
    handleWithdraw(userId);
  }
  else if (state === 'awaiting_wallet_binance_temp') {
    // التحقق من صحة Binance ID
    if (!isValidBinanceID(text)) {
      return bot.sendMessage(userId, '❌ رقم غير صحيح\n\n💰 أرسل Binance ID الخاص بك:');
    }
    
    const cleanID = text.trim();
    
    // حفظ المحفظة مؤقتاً مع المبلغ
    const amount = pendingWithdrawals[userId].amount;
    const usdRate = parseFloat(getSetting('usd_rate')) || 50;
    const amountInUSD = (amount / usdRate).toFixed(2);
    
    pendingWithdrawals[userId] = { 
      amount: amount, 
      method: 'binance',
      wallet: cleanID 
    };
    
    // حفظ الطلب في قاعدة البيانات
    db.prepare('INSERT INTO withdrawal_requests (user_id, amount, method, wallet_info, status) VALUES (?, ?, ?, ?, ?)').run(
      userId, 
      amount, 
      'binance', 
      cleanID, 
      'pending'
    );
    
    delete userStates[userId];
    
    // عرض رسالة تأكيد بدون أزرار
    bot.sendMessage(userId, 
      `✅ تم إرسال طلب السحب بنجاح!\n\n` +
      `💳 تفاصيل الطلب:\n` +
      `💰 المبلغ: ${amount} جنيه (${amountInUSD} USDT)\n` +
      `📱 الطريقة: بينانس\n` +
      `💳 المحفظة: ${cleanID}\n\n` +
      `⏳ سيتم معالجة طلبك من قبل الإدارة قريباً\n` +
      `📬 ستصلك رسالة عند تأكيد الدفع`
    );
    
    logInfo('User requested binance withdrawal', { userId, amount, binanceID: cleanID });
  }
  else if (state === 'awaiting_withdraw_amount') {
    const user = db.prepare('SELECT balance FROM users WHERE user_id = ?').get(userId);
    const amount = parseFloat(text);
    
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال مبلغ صحيح\n\n💳 أرسل المبلغ الذي تريد سحبه:');
    }
    
    if (amount < 5) {
      return bot.sendMessage(userId, '❌ الحد الأدنى للسحب هو 5 جنيه\n\n💳 أرسل المبلغ الذي تريد سحبه:');
    }
    
    if (amount > user.balance) {
      return bot.sendMessage(userId, `❌ المبلغ أكبر من رصيدك (${user.balance} جنيه)\n\n💳 أرسل المبلغ الذي تريد سحبه:`);
    }
    
    // حفظ المبلغ مع طريقة السحب المختارة
    const method = pendingWithdrawals[userId]?.method || 'vodafone';
    pendingWithdrawals[userId] = { amount: amount, method: method };
    
    // طلب المحفظة حسب الطريقة المختارة
    if (method === 'vodafone') {
      userStates[userId] = 'awaiting_wallet_vodafone_temp';
      bot.sendMessage(userId, '📱 أرسل محفظة الكاش:');
    } else if (method === 'binance') {
      userStates[userId] = 'awaiting_wallet_binance_temp';
      bot.sendMessage(userId, '💰 أرسل Binance ID الخاص بك:');
    }
  }
  else if (state === 'awaiting_wallet') {
    // للتوافق مع الكود القديم
    if (!isValidWalletAddress(text)) {
      return bot.sendMessage(userId, '❌ رقم غير صحيح\n\n💳 أرسل محفظة الكاش:');
    }
    
    // تنظيف الرقم وحفظه
    let cleanPhone = text.trim().replace(/[\s\-\(\)]/g, '');
    if (cleanPhone.startsWith('+20')) {
      cleanPhone = cleanPhone.substring(3);
    } else if (cleanPhone.startsWith('20')) {
      cleanPhone = cleanPhone.substring(2);
    }
    
    db.prepare('UPDATE users SET wallet_address = ? WHERE user_id = ?').run(cleanPhone, userId);
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم حفظ المحفظة بنجاح\n\n📱 ${cleanPhone}`);
    logInfo('User saved wallet address', { userId, phone: cleanPhone });
    handleWithdraw(userId);
  }
  else if (state === 'awaiting_block_user_id') {
    const targetUserId = parseInt(text);
    if (isNaN(targetUserId)) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح\n\n🚫 أرسل ID المستخدم الذي تريد حظره:');
    }
    
    // حماية الأدمن الرئيسي من الحظر
    if (targetUserId === ADMIN_ID) {
      return bot.sendMessage(userId, '❌ لا يمكن حظر الأدمن الرئيسي!');
    }
    
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(targetUserId);
    if (!user) {
      return bot.sendMessage(userId, '❌ المستخدم غير موجود\n\n🚫 أرسل ID المستخدم الذي تريد حظره:');
    }
    db.prepare('UPDATE users SET is_blocked = 1 WHERE user_id = ?').run(targetUserId);
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم حظر المستخدم ${targetUserId} بنجاح`);
    showAdminUsersMenu(userId);
  }
  else if (state === 'awaiting_unblock_user_id') {
    const targetUserId = parseInt(text);
    if (isNaN(targetUserId)) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح\n\n✅ أرسل ID المستخدم الذي تريد إلغاء حظره:');
    }
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(targetUserId);
    if (!user) {
      return bot.sendMessage(userId, '❌ المستخدم غير موجود\n\n✅ أرسل ID المستخدم الذي تريد إلغاء حظره:');
    }
    db.prepare('UPDATE users SET is_blocked = 0, failed_tasks_count = 0, last_failed_task_time = NULL WHERE user_id = ?').run(targetUserId);
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم إلغاء حظر المستخدم ${targetUserId} بنجاح وإعادة المحاولات إلى الصفر`);
    showAdminUsersMenu(userId);
  }
  else if (state === 'awaiting_add_money_user_id') {
    const targetUserId = parseInt(text);
    if (isNaN(targetUserId)) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح\n\n💰 أرسل ID المستخدم الذي تريد إضافة محفظة له:');
    }
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(targetUserId);
    if (!user) {
      return bot.sendMessage(userId, '❌ المستخدم غير موجود\n\n💰 أرسل ID المستخدم الذي تريد إضافة محفظة له:');
    }
    userStates[userId] = { state: 'awaiting_add_money_amount', targetUserId: targetUserId };
    bot.sendMessage(userId, '💰 أرسل المبلغ الذي تريد إضافته:');
  }
  else if (state && state.state === 'awaiting_add_money_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال مبلغ صحيح\n\n💰 أرسل المبلغ الذي تريد إضافته:');
    }
    db.prepare('UPDATE users SET balance = balance + ? WHERE user_id = ?').run(amount, state.targetUserId);
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم إضافة ${amount} جنيه للمستخدم ${state.targetUserId}`);
    showAdminUsersMenu(userId);
  }
  else if (state === 'awaiting_remove_money_user_id') {
    const targetUserId = parseInt(text);
    if (isNaN(targetUserId)) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح\n\n💸 أرسل ID المستخدم الذي تريد خصم محفظة منه:');
    }
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(targetUserId);
    if (!user) {
      return bot.sendMessage(userId, '❌ المستخدم غير موجود\n\n💸 أرسل ID المستخدم الذي تريد خصم محفظة منه:');
    }
    userStates[userId] = { state: 'awaiting_remove_money_amount', targetUserId: targetUserId };
    bot.sendMessage(userId, '💸 أرسل المبلغ الذي تريد خصمه:');
  }
  else if (state && state.state === 'awaiting_remove_money_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال مبلغ صحيح\n\n💸 أرسل المبلغ الذي تريد خصمه:');
    }
    db.prepare('UPDATE users SET balance = balance - ? WHERE user_id = ?').run(amount, state.targetUserId);
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم خصم ${amount} جنيه من المستخدم ${state.targetUserId}`);
    showAdminUsersMenu(userId);
  }
  else if (state === 'awaiting_search_user') {
    searchUser(userId, text);
    delete userStates[userId];
  }
  else if (state && state.state === 'awaiting_balance_edit') {
    const amount = parseFloat(text);
    if (isNaN(amount)) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح');
    }
    
    const user = db.prepare('SELECT balance FROM users WHERE user_id = ?').get(state.targetUserId);
    const newBalance = user.balance + amount;
    
    if (newBalance < 0) {
      return bot.sendMessage(userId, '❌ لا يمكن أن يكون الرصيد سالباً');
    }
    
    db.prepare('UPDATE users SET balance = ? WHERE user_id = ?').run(newBalance, state.targetUserId);
    delete userStates[userId];
    
    const operation = amount > 0 ? 'إضافة' : 'خصم';
    const absAmount = Math.abs(amount);
    bot.sendMessage(userId, `✅ تم ${operation} ${absAmount} جنيه ${amount > 0 ? 'إلى' : 'من'} المستخدم ${state.targetUserId}\n\nالمحفظة الجديدة: ${newBalance} جنيه`);
    
    // إعادة عرض معلومات المستخدم
    setTimeout(() => searchUser(userId, state.targetUserId.toString()), 1000);
  }
  else if (state === 'admin_reward') {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(text, 'reward_amount');
    delete userStates[userId];
    bot.sendMessage(userId, '✅ تم تحديث قيمة المكافأة');
  }
  else if (state === 'admin_ad') {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(text, 'advertisement_text');
    delete userStates[userId];
    bot.sendMessage(userId, '✅ تم تحديث نص الإعلان');
  }
  else if (state === 'admin_timeout') {
    const timeout = parseInt(text);
    if (isNaN(timeout) || timeout < 1) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح (أكبر من 0)\n\nأرسل الوقت الجديد بالدقائق (مثال: 60 أو 120):');
    }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(timeout.toString(), 'task_timeout');
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم تحديث وقت المهمة إلى ${timeout} دقيقة`);
  }
  else if (state === 'admin_usd_rate') {
    const rate = parseFloat(text);
    if (isNaN(rate) || rate <= 0) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح (أكبر من 0)\n\nأرسل السعر الجديد (مثال: 50 أو 55):');
    }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(rate.toString(), 'usd_rate');
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم تحديث سعر الدولار إلى ${rate} جنيه`);
  }
  else if (state === 'admin_support_text') {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(text, 'support_text');
    delete userStates[userId];
    bot.sendMessage(userId, '✅ تم تحديث نص الدعم');
  }
  else if (state === 'admin_task_requirements') {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(text, 'task_requirements');
    delete userStates[userId];
    bot.sendMessage(userId, '✅ تم تحديث نص المطلوب');
  }
  else if (state === 'admin_min_screenshots') {
    const minValue = parseInt(text);
    if (isNaN(minValue) || minValue < 1) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح (أكبر من 0)\n\n📉 أرسل الحد الأدنى الجديد:');
    }
    const maxValue = parseInt(getSetting('max_screenshots') || '15');
    if (minValue > maxValue) {
      return bot.sendMessage(userId, `❌ الحد الأدنى لا يمكن أن يكون أكبر من الحد الأقصى (${maxValue})\n\n📉 أرسل الحد الأدنى الجديد:`);
    }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(minValue.toString(), 'min_screenshots');
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم تحديث الحد الأدنى إلى ${minValue} صورة`, { reply_markup: getAdminKeyboard(userId) });
  }
  else if (state === 'admin_max_screenshots') {
    const maxValue = parseInt(text);
    if (isNaN(maxValue) || maxValue < 1) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح (أكبر من 0)\n\n📈 أرسل الحد الأقصى الجديد:');
    }
    const minValue = parseInt(getSetting('min_screenshots') || '11');
    if (maxValue < minValue) {
      return bot.sendMessage(userId, `❌ الحد الأقصى لا يمكن أن يكون أقل من الحد الأدنى (${minValue})\n\n📈 أرسل الحد الأقصى الجديد:`);
    }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(maxValue.toString(), 'max_screenshots');
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم تحديث الحد الأقصى إلى ${maxValue} صورة`, { reply_markup: getAdminKeyboard(userId) });
  }
  else if (state === 'awaiting_add_admin_id') {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      delete userStates[userId];
      return bot.sendMessage(userId, '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط');
    }
    
    const targetUserId = parseInt(text);
    if (isNaN(targetUserId)) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح\n\n➕ أرسل ID المستخدم الذي تريد إضافته كأدمن:');
    }
    
    // التحقق من أن المستخدم موجود
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(targetUserId);
    if (!user) {
      return bot.sendMessage(userId, '❌ المستخدم غير موجود في البوت\n\n➕ أرسل ID المستخدم الذي تريد إضافته كأدمن:');
    }
    
    // التحقق من أنه ليس أدمن بالفعل
    const existingAdmin = db.prepare('SELECT * FROM admins WHERE user_id = ?').get(targetUserId);
    if (existingAdmin) {
      return bot.sendMessage(userId, '❌ هذا المستخدم أدمن بالفعل\n\n➕ أرسل ID المستخدم الذي تريد إضافته كأدمن:');
    }
    
    // إضافة الأدمن
    db.prepare('INSERT INTO admins (user_id, username, added_by) VALUES (?, ?, ?)').run(targetUserId, user.username, userId);
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم إضافة الأدمن ${targetUserId} بنجاح`);
    setTimeout(() => showAdminsMenu(userId), 500);
  }
  else if (state === 'awaiting_remove_admin_id') {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      delete userStates[userId];
      return bot.sendMessage(userId, '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط');
    }
    
    const targetUserId = parseInt(text);
    if (isNaN(targetUserId)) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح\n\n🗑️ أرسل ID الأدمن الذي تريد حذفه:');
    }
    
    // حماية الأدمن الرئيسي من الحذف
    if (targetUserId === ADMIN_ID) {
      return bot.sendMessage(userId, '❌ لا يمكن حذف الأدمن الرئيسي!');
    }
    
    // التحقق من أنه لا يحاول حذف نفسه
    if (targetUserId === userId) {
      return bot.sendMessage(userId, '❌ لا يمكنك حذف نفسك من الأدمنز\n\n🗑️ أرسل ID الأدمن الذي تريد حذفه:');
    }
    
    // التحقق من أنه أدمن
    const admin = db.prepare('SELECT * FROM admins WHERE user_id = ?').get(targetUserId);
    if (!admin) {
      return bot.sendMessage(userId, '❌ هذا المستخدم ليس أدمن\n\n🗑️ أرسل ID الأدمن الذي تريد حذفه:');
    }
    
    // حذف الأدمن
    db.prepare('DELETE FROM admins WHERE user_id = ?').run(targetUserId);
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم حذف الأدمن ${targetUserId} بنجاح`);
    setTimeout(() => showAdminsMenu(userId), 500);
  }
  else if (state === 'awaiting_broadcast_single_id') {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      delete userStates[userId];
      return bot.sendMessage(userId, '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط');
    }
    
    const targetUserId = parseInt(text);
    if (isNaN(targetUserId)) {
      return bot.sendMessage(userId, '❌ الرجاء إدخال رقم صحيح\n\n👤 أرسل ID المستخدم الذي تريد إرسال الرسالة له:');
    }
    
    // التحقق من أن المستخدم موجود
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(targetUserId);
    if (!user) {
      return bot.sendMessage(userId, '❌ المستخدم غير موجود في البوت\n\n👤 أرسل ID المستخدم الذي تريد إرسال الرسالة له:');
    }
    
    // حفظ ID المستخدم المستهدف وتغيير الحالة
    userStates[userId] = { state: 'awaiting_broadcast_single_message', targetUserId: targetUserId };
    bot.sendMessage(userId, `✅ تم تحديد المستخدم: ${targetUserId}\n\n📝 الآن أرسل الرسالة التي تريد إرسالها له:\n\n(يمكنك إرسال نص، صورة، أو فيديو)`);
  }
  else if (state === 'awaiting_broadcast_all_message') {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      delete userStates[userId];
      return bot.sendMessage(userId, '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط');
    }
    
    const users = db.prepare('SELECT user_id FROM users WHERE is_blocked = 0').all();
    
    bot.sendMessage(userId, `📤 جاري إرسال الرسالة إلى ${users.length} مستخدم...`);
    
    const results = await Promise.allSettled(
      users.map(user => bot.sendMessage(user.user_id, text))
    );
    
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failCount = results.filter(r => r.status === 'rejected').length;
    
    delete userStates[userId];
    bot.sendMessage(userId, `✅ تم إرسال الرسالة\n\n📊 النتائج:\n✅ نجح: ${successCount}\n❌ فشل: ${failCount}`, 
      { reply_markup: getAdminKeyboard(userId) });
  }
  else if (state && state.state === 'awaiting_broadcast_single_message') {
    // التحقق من أن المستخدم هو الأدمن الرئيسي فقط
    if (userId !== ADMIN_ID) {
      delete userStates[userId];
      return bot.sendMessage(userId, '⛔ هذه الميزة متاحة للأدمن الرئيسي فقط');
    }
    
    const targetUserId = state.targetUserId;
    
    try {
      await bot.sendMessage(targetUserId, text);
      delete userStates[userId];
      bot.sendMessage(userId, `✅ تم إرسال الرسالة للمستخدم ${targetUserId}`, 
        { reply_markup: getAdminKeyboard(userId) });
    } catch (error) {
      bot.sendMessage(userId, `❌ فشل إرسال الرسالة للمستخدم ${targetUserId}\n\nالسبب: ${error.message}`);
    }
  }
  else if (state === 'awaiting_user_report_id') {
    const targetUserId = parseInt(text);
    if (isNaN(targetUserId)) {
      return bot.sendMessage(userId, 
        '❌ الرجاء إدخال رقم صحيح\n\n' +
        'أرسل ID المستخدم للحصول على تقريره الكامل:'
      );
    }
    
    // التحقق من أن المستخدم موجود
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(targetUserId);
    if (!user) {
      return bot.sendMessage(userId, 
        '❌ المستخدم غير موجود في البوت\n\n' +
        'أرسل ID المستخدم للحصول على تقريره الكامل:'
      );
    }
    
    delete userStates[userId];
    showUserReport(userId, targetUserId);
  }
  else if (state === 'admin_groups') {
    const parts = text.split(' ');
    const command = parts[0];
    
    if (command === 'add') {
      const numbers = parts.slice(1).join(' ');
      db.prepare('INSERT INTO number_groups (numbers) VALUES (?)').run(numbers);
      bot.sendMessage(userId, '✅ تم إضافة المجموعة');
      setTimeout(() => showAdminGroups(userId), 500);
    }
  }
  else if (state === 'awaiting_new_group') {
    const numbers = text.trim();
    
    // التحقق من حجم البيانات (حد أقصى 100KB)
    if (numbers.length > 100000) {
      return bot.sendMessage(userId, '❌ البيانات كبيرة جداً! الحد الأقصى 100,000 حرف');
    }
    
    // تقسيم الأرقام حسب الأسطر
    const numberArray = numbers.split('\n').map(n => n.trim()).filter(n => n.length > 0);
    
    // التحقق من عدد الأرقام (من 1 إلى 50)
    if (numberArray.length < 1) {
      return bot.sendMessage(userId, `❌ يجب إدخال رقم واحد على الأقل\nعدد الأرقام المرسلة: ${numberArray.length}`);
    }
    
    if (numberArray.length > 50) {
      return bot.sendMessage(userId, `❌ الحد الأقصى 50 رقم\nعدد الأرقام المرسلة: ${numberArray.length}`);
    }
    
    // التحقق من أن كل سطر يحتوي على أرقام (مع السماح برمز +)
    for (let i = 0; i < numberArray.length; i++) {
      if (!/^\+?\d+$/.test(numberArray[i])) {
        return bot.sendMessage(userId, `❌ الرقم في السطر ${i + 1} غير صحيح: ${numberArray[i]}\nيجب أن يحتوي على أرقام فقط (يمكن أن يبدأ بـ +)`);
      }
    }
    
    // حفظ الأرقام (كل رقم في سطر)
    try {
      db.prepare('INSERT INTO number_groups (numbers) VALUES (?)').run(numbers);
      delete userStates[userId];
      bot.sendMessage(userId, `✅ تم إضافة المجموعة بنجاح!\nعدد الأرقام: ${numberArray.length}`);
      setTimeout(() => showAdminGroups(userId), 500);
    } catch (error) {
      logError('Error inserting group', error, userId);
      bot.sendMessage(userId, '❌ حدث خطأ في حفظ المجموعة. تأكد من أن البيانات صحيحة.');
    }
  }
}

// معالجة إرسال الإثباتات
function handleProofSubmission(userId, msg) {
  const activeTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ?').get(userId, 'active');
  
  if (!activeTask) {
    return bot.sendMessage(userId, '❌ ليس لديك مهمة نشطة');
  }
  
  const newCount = activeTask.proof_count + 1;
  const minScreenshots = parseInt(getSetting('min_screenshots') || '11');
  const maxScreenshots = parseInt(getSetting('max_screenshots') || '15');
  
  // التحقق من عدم تجاوز الحد الأقصى
  if (newCount > maxScreenshots) {
    return bot.sendMessage(userId, `⚠️ لقد وصلت للحد الأقصى (${maxScreenshots} صورة)`);
  }
  
  db.prepare('UPDATE tasks SET proof_count = ? WHERE id = ?').run(newCount, activeTask.id);
  
  if (newCount >= minScreenshots) {
    const reward = parseFloat(getSetting('reward_amount'));
    db.prepare('UPDATE tasks SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run('completed', activeTask.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE user_id = ?').run(reward, userId);
    db.prepare('UPDATE number_groups SET is_available = 1 WHERE id = ?').run(activeTask.group_id);
    
    const isAdminUser = isAdmin(userId);
    bot.sendMessage(userId, 
      `✅ تم قبول المهمة!\n\n` +
      `💰 تم إضافة ${reward} جنيه إلى محفظتك\n` +
      `يمكنك الحصول على مهمة جديدة الآن`,
      { reply_markup: getMainKeyboard(isAdminUser) }
    );
  } else {
    bot.sendMessage(userId, `📸 تم استلام الصورة ${newCount}/20`);
  }
}

// قائمة إدارة المستخدمين
function showAdminUsersMenu(userId) {
  bot.sendMessage(userId, 
    '👥 إدارة المستخدمين:\n\nاختر العملية:',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚫 حظر مستخدم', callback_data: 'admin_block_user' }],
          [{ text: '✅ إلغاء حظر مستخدم', callback_data: 'admin_unblock_user' }],
          [{ text: '💰 إضافة محفظة', callback_data: 'admin_add_money' }],
          [{ text: '💸 خصم محفظة', callback_data: 'admin_remove_money' }],
          [{ text: '🔍 البحث عن مستخدم', callback_data: 'admin_search_user' }],
          [{ text: '👤 آخر 10 مستخدمين', callback_data: 'admin_last_10_users' }],
          [{ text: '📋 عرض جميع المستخدمين', callback_data: 'admin_list_users' }],
          [{ text: '🔙 لوحة التحكم', callback_data: 'back_to_admin' }]
        ]
      }
    }
  );
}

// إدارة المجموعات
function showAdminGroups(userId) {
  const groups = db.prepare('SELECT * FROM number_groups WHERE is_available IN (0, 1) ORDER BY id DESC LIMIT 10').all();
  
  let message = '📱 المجموعات (آخر 10):\n\n';
  const keyboard = [];
  
  if (groups.length === 0) {
    message += 'لا توجد مجموعات\n';
  } else {
    groups.forEach(g => {
      let status = '';
      let userInfo = '';
      
      if (g.is_available === 1) {
        status = '✅ متاحة';
      } else if (g.is_available === 0) {
        // البحث عن المستخدم الذي يستخدم هذه المجموعة
        const task = db.prepare('SELECT user_id FROM tasks WHERE group_id = ? AND status = ?').get(g.id, 'active');
        if (task) {
          const user = db.prepare('SELECT username FROM users WHERE user_id = ?').get(task.user_id);
          const username = user && user.username ? `@${user.username}` : `ID: ${task.user_id}`;
          status = '❌ مستخدمة';
          userInfo = ` (${username})`;
        } else {
          status = '❌ مستخدمة';
        }
      }
      
      message += `ID: ${g.id} | ${status}${userInfo}\n`;
      
      // أزرار حذف وسحب
      const buttons = [{ text: `🗑️ حذف ${g.id}`, callback_data: `delete_group_${g.id}` }];
      if (g.is_available === 0) {
        buttons.push({ text: `🔄 سحب ${g.id}`, callback_data: `revoke_group_${g.id}` });
      }
      keyboard.push(buttons);
    });
  }
  
  // زر إضافة مجموعة جديدة
  keyboard.push([{ text: '➕ إضافة مجموعة جديدة', callback_data: 'add_new_group' }]);
  keyboard.push([{ text: '🔙 لوحة التحكم', callback_data: 'back_to_admin' }]);
  
  bot.sendMessage(userId, message, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

// عرض آخر 10 مستخدمين
function showLast10Users(userId) {
  const users = db.prepare('SELECT user_id, username, balance, is_blocked, created_at FROM users ORDER BY created_at DESC LIMIT 10').all();
  
  if (users.length === 0) {
    return bot.sendMessage(userId, '❌ لا يوجد مستخدمين');
  }
  
  let message = '👤 آخر 10 مستخدمين:\n\n';
  users.forEach((u, index) => {
    const status = u.is_blocked ? '🚫 محظور' : '✅ نشط';
    const username = u.username ? `@${u.username}` : 'لا يوجد';
    message += `${index + 1}. ID: ${u.user_id}\n`;
    message += `   اليوزر: ${username}\n`;
    message += `   المحفظة: ${u.balance} جنيه\n`;
    message += `   الحالة: ${status}\n`;
    message += `─────────────\n`;
  });
  
  bot.sendMessage(userId, message, {
    reply_markup: {
      inline_keyboard: [[{ text: '🔙 إدارة المستخدمين', callback_data: 'back_to_users_menu' }]]
    }
  });
}

// عرض جميع المستخدمين
function showAllUsers(userId) {
  const users = db.prepare('SELECT user_id, username, balance, is_blocked FROM users ORDER BY user_id DESC LIMIT 20').all();
  
  if (users.length === 0) {
    return bot.sendMessage(userId, '❌ لا يوجد مستخدمين');
  }
  
  let message = '📋 قائمة المستخدمين (آخر 20):\n\n';
  users.forEach(u => {
    const status = u.is_blocked ? '🚫 محظور' : '✅ نشط';
    const username = u.username ? `@${u.username}` : 'لا يوجد';
    message += `ID: ${u.user_id}\n`;
    message += `اليوزر: ${username}\n`;
    message += `المحفظة: ${u.balance} جنيه\n`;
    message += `الحالة: ${status}\n`;
    message += `─────────────\n`;
  });
  
  bot.sendMessage(userId, message, {
    reply_markup: {
      inline_keyboard: [[{ text: '🔙 إدارة المستخدمين', callback_data: 'back_to_users_menu' }]]
    }
  });
}

// البحث عن مستخدم
function searchUser(userId, searchQuery) {
  let user;
  
  // البحث بالـ ID
  if (!isNaN(searchQuery)) {
    user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(parseInt(searchQuery));
  }
  // البحث باليوزر
  else if (searchQuery.startsWith('@')) {
    const username = searchQuery.substring(1);
    user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }
  else {
    user = db.prepare('SELECT * FROM users WHERE username = ?').get(searchQuery);
  }
  
  if (!user) {
    return bot.sendMessage(userId, '❌ المستخدم غير موجود', {
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 إدارة المستخدمين', callback_data: 'back_to_users_menu' }]]
      }
    });
  }
  
  // حساب عدد المهام
  const completedTasks = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = ?').get(user.user_id, 'completed');
  const activeTasks = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = ?').get(user.user_id, 'active');
  
  const status = user.is_blocked ? '🚫 محظور' : '✅ نشط';
  const username = user.username ? `@${user.username}` : 'لا يوجد';
  const walletAddress = user.wallet_address || 'لم يتم تعيينها';
  
  let message = '🔍 معلومات المستخدم:\n\n';
  message += `👤 ID: \`${user.user_id}\`\n`;
  message += `📝 اليوزر: ${username}\n`;
  message += `💰 المحفظة: ${user.balance} جنيه\n`;
  message += `💳 عنوان المحفظة: ${walletAddress}\n`;
  message += `📊 الحالة: ${status}\n`;
  message += `✅ المهام المكتملة: ${completedTasks.count}\n`;
  message += `⏳ المهام النشطة: ${activeTasks.count}\n`;
  message += `📅 تاريخ التسجيل: ${user.created_at}\n`;
  
  // أزرار ديناميكية حسب حالة المستخدم
  const keyboard = [];
  
  // حماية الأدمن الرئيسي - لا تظهر أزرار الحظر له
  if (user.user_id === ADMIN_ID) {
    message += `\n🔒 هذا هو الأدمن الرئيسي (محمي من الحظر)\n`;
  } else {
    // زر الحظر/إلغاء الحظر للمستخدمين العاديين فقط
    if (user.is_blocked) {
      keyboard.push([{ text: '✅ إلغاء الحظر', callback_data: `quick_unblock_${user.user_id}` }]);
    } else {
      keyboard.push([{ text: '🚫 حظر المستخدم', callback_data: `quick_block_${user.user_id}` }]);
    }
  }
  
  // زر تعديل المحفظة
  keyboard.push([{ text: '💰 تعديل المحفظة', callback_data: `edit_balance_${user.user_id}` }]);
  
  // زر الرجوع
  keyboard.push([{ text: '🔙 إدارة المستخدمين', callback_data: 'back_to_users_menu' }]);
  
  bot.sendMessage(userId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

// إحصائيات البوت
function showBotStats(userId) {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const blockedUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_blocked = 1').get();
  const totalTasks = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?').get('completed');
  const totalGroups = db.prepare('SELECT COUNT(*) as count FROM number_groups').get();
  const availableGroups = db.prepare('SELECT COUNT(*) as count FROM number_groups WHERE is_available = 1').get();
  
  bot.sendMessage(userId, 
    `📊 إحصائيات البوت:\n\n` +
    `👥 إجمالي المستخدمين: ${totalUsers.count}\n` +
    `🚫 المستخدمين المحظورين: ${blockedUsers.count}\n` +
    `✅ المهام المكتملة: ${totalTasks.count}\n` +
    `📱 إجمالي المجموعات: ${totalGroups.count}\n` +
    `✅ المجموعات المتاحة: ${availableGroups.count}`
  );
}

// عرض الطلبات المعلقة للموافقة
function showPendingApprovals(userId) {
  const pendingTasks = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY id DESC').all('pending_approval');
  
  if (pendingTasks.length === 0) {
    return bot.sendMessage(userId, '✅ لا توجد طلبات معلقة');
  }
  
  let message = `📋 الطلبات المعلقة (${pendingTasks.length}):\n\n`;
  const keyboard = [];
  
  pendingTasks.forEach(task => {
    const user = db.prepare('SELECT username FROM users WHERE user_id = ?').get(task.user_id);
    const username = user && user.username ? `@${user.username}` : `ID: ${task.user_id}`;
    
    message += `🆔 المهمة #${task.id}\n`;
    message += `👤 ${username}\n`;
    message += `📸 ${task.proof_count} صورة\n`;
    message += `─────────────\n`;
    
    keyboard.push([{ text: `📋 مهمة #${task.id} - ${username}`, callback_data: `review_task_${task.id}` }]);
  });
  
  bot.sendMessage(userId, message, {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

// مراجعة مهمة محددة
async function reviewTask(adminId, taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  
  if (!task) {
    return bot.sendMessage(adminId, '❌ المهمة غير موجودة');
  }
  
  const user = db.prepare('SELECT username FROM users WHERE user_id = ?').get(task.user_id);
  const username = user && user.username ? `@${user.username}` : `ID: ${task.user_id}`;
  const group = db.prepare('SELECT numbers FROM number_groups WHERE id = ?').get(task.group_id);
  
  // إرسال معلومات المهمة
  bot.sendMessage(adminId, 
    `📋 مراجعة المهمة #${task.id}\n\n` +
    `👤 المستخدم: ${username}\n` +
    `🆔 ID: ${task.user_id}\n` +
    `📸 عدد الصور: ${task.proof_count}\n` +
    `📅 تاريخ الإرسال: ${task.created_at}`
  );
  
  // إرسال الأرقام
  setTimeout(() => {
    bot.sendMessage(adminId, 
      `📱 الأرقام المرسل لها:\n\n${group.numbers}`
    );
  }, 500);
  
  // إرسال الصور
  if (task.proof_photos) {
    const photos = JSON.parse(task.proof_photos);
    
    setTimeout(async () => {
      bot.sendMessage(adminId, '⏳ جاري تحميل الصور...');
      
      try {
        // إرسال الصور في مجموعات
        for (let i = 0; i < photos.length; i += 10) {
          const chunk = photos.slice(i, i + 10);
          const mediaGroup = chunk.map((photoId, index) => ({
            type: 'photo',
            media: photoId,
            caption: i === 0 && index === 0 ? `📸 الصور (${photos.length})` : undefined
          }));
          
          await bot.sendMediaGroup(adminId, mediaGroup);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // أزرار الموافقة والرفض
        bot.sendMessage(adminId, 
          `✅ اختر الإجراء:`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ موافقة', callback_data: `approve_task_${task.id}` },
                  { text: '❌ رفض', callback_data: `reject_task_${task.id}` }
                ],
                [{ text: '🔙 رجوع', callback_data: 'back_to_approvals' }]
              ]
            }
          }
        );
      } catch (error) {
        logError('Error sending photos to admin', error, adminId);
        bot.sendMessage(adminId, '❌ حدث خطأ في تحميل الصور');
      }
    }, 1000);
  }
}

// الموافقة على المهمة
function approveTask(adminId, taskId, messageId = null) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  
  if (!task) {
    bot.sendMessage(adminId, '❌ المهمة غير موجودة');
    return;
  }
  
  const reward = parseFloat(getSetting('reward_amount'));
  
  // حفظ group_id قبل حذف المهمة
  const groupId = task.group_id;
  
  // تحديث المهمة وإضافة المكافأة
  db.prepare('UPDATE tasks SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run('completed', taskId);
  db.prepare('UPDATE users SET balance = balance + ? WHERE user_id = ?').run(reward, task.user_id);
  
  // حذف المهمة أولاً (لتجنب خطأ FOREIGN KEY)
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  
  // الآن يمكن حذف المجموعة بأمان
  db.prepare('DELETE FROM number_groups WHERE id = ?').run(groupId);
  
  // تنظيف البيانات المؤقتة للمستخدم
  delete userProofPhotos[task.user_id];
  delete userPhotoLocks[task.user_id];
  delete secondCancellation[task.user_id];
  delete cancelledTasks[task.user_id];
  
  // حذف رسالة الأزرار إذا كانت موجودة
  if (messageId) {
    bot.deleteMessage(adminId, messageId).catch((err) => {
      logWarning('Failed to delete approval buttons message', { adminId, error: err.message });
    });
  }
  
  // إشعار المستخدم
  const isUserAdmin = task.user_id === ADMIN_ID;
  bot.sendMessage(task.user_id, 
    `✅ تمت الموافقة على مهمتك!\n\n` +
    `💰 تم إضافة ${reward} جنيه إلى محفظتك\n` +
    `يمكنك الحصول على مهمة جديدة الآن`,
    { reply_markup: getMainKeyboard(isUserAdmin) }
  ).catch((err) => {
    logError('Failed to send approval message to user', err, task.user_id);
  });
  
  // إشعار الأدمن
  bot.sendMessage(adminId, `✅ تمت الموافقة على المهمة #${taskId} وتم حذف المجموعة`);
  
  logInfo('Admin approved task', { adminId, taskId, userId: task.user_id, reward });
}

// رفض المهمة
function rejectTask(adminId, taskId, messageId = null) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  
  if (!task) {
    bot.sendMessage(adminId, '❌ المهمة غير موجودة');
    return;
  }
  
  // تحديث المهمة
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('rejected', taskId);
  
  // تنظيف البيانات المؤقتة للمستخدم
  delete userProofPhotos[task.user_id];
  delete userPhotoLocks[task.user_id];
  delete secondCancellation[task.user_id];
  delete cancelledTasks[task.user_id];
  
  // حذف رسالة الأزرار إذا كانت موجودة
  if (messageId) {
    bot.deleteMessage(adminId, messageId).catch((err) => {
      logWarning('Failed to delete rejection buttons message', { adminId, error: err.message });
    });
  }
  
  const supportText = getSetting('support_text');
  
  // إشعار المستخدم
  const isUserAdmin = task.user_id === ADMIN_ID;
  bot.sendMessage(task.user_id, 
    `❌ تم رفض مهمتك\n\n` +
    `إذا كنت تعتقد أن هناك خطأ، يمكنك التواصل مع الدعم:\n\n` +
    `${supportText}`,
    { reply_markup: getMainKeyboard(isUserAdmin) }
  ).catch((err) => {
    logError('Failed to send rejection message to user', err, task.user_id);
  });
  
  logInfo('Admin rejected task', { adminId, taskId, userId: task.user_id });
  
  // سؤال الأدمن عن مصير المجموعة
  bot.sendMessage(adminId, 
    `❌ تم رفض المهمة #${taskId}\n\n` +
    `ماذا تريد أن تفعل بالمجموعة؟`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '↩️ إرجاع المجموعة', callback_data: `return_group_${task.group_id}` },
            { text: '🗑️ حذف المجموعة', callback_data: `delete_rejected_group_${task.group_id}` }
          ]
        ]
      }
    }
  );
}

// عرض صفحة الدعم
function handleSupport(userId) {
  const supportText = getSetting('support_text');
  
  bot.sendMessage(userId, 
    `📞 الدعم الفني\n\n${supportText}`
  );
}

// عرض طريقة العمل (فيديو توضيحي)
function handleHowToWork(userId) {
  const videoFileId = getSetting('how_to_work_video');
  const minScreenshots = getSetting('min_screenshots') || '11';
  const maxScreenshots = getSetting('max_screenshots') || '15';
  const taskTimeout = getSetting('task_timeout') || '90';
  const rewardAmount = getSetting('reward_amount') || '5';
  
  // إرسال الشرح النصي أولاً
  const howToText = 
    `📖 *طريقة إتمام المهمة*\n\n` +
    `*الخطوة 1️⃣: احصل على المهمة*\n` +
    `• اضغط "📢 الحصول على مهمة جديدة"\n` +
    `• ستحصل على نص الإعلان + مجموعة أرقام\n` +
    `• الوقت المتاح: ${taskTimeout} دقيقة\n` +
    `• المكافأة: ${rewardAmount} جنيه\n\n` +
    
    `*الخطوة 2️⃣: انسخ الإعلان والأرقام*\n` +
    `• انسخ نص الإعلان (ستحتاجه!)\n` +
    `• انسخ الأرقام واحداً تلو الآخر\n\n` +
    
    `*الخطوة 3️⃣: أرسل الإعلان على واتساب*\n` +
    `• افتح واتساب\n` +
    `• أرسل الإعلان لكل رقم من الأرقام المعطاة\n` +
    `⚠️ *مهم جداً:* انتظر دقيقة أو أكثر بين كل رسالة\n` +
    `   (حتى لا يتم حظرك من واتساب)\n` +
    `• خذ سكرينات أثناء الإرسال\n\n` +
    
    `*الخطوة 4️⃣: خذ السكرينات المطلوبة*\n` +
    `📸 *المطلوب:*\n` +
    `• سكرينات من داخل الشات\n` +
    `  (بعد إرسال الرسالة لكل رقم)\n` +
    `• سكرينات من خارج الشات\n` +
    `  (تثبت إرسال الرسائل لجميع الأرقام)\n\n` +
    `⚠️ *الحد الأدنى:* ${minScreenshots} صورة\n` +
    `⚠️ *الحد الأقصى:* ${maxScreenshots} صورة\n\n` +
    
    `*الخطوة 5️⃣: أرسل الإثبات*\n` +
    `• ارجع للبوت\n` +
    `• اضغط "📸 إرسال الإثبات"\n` +
    `• أرسل الصور (فردية أو مجموعات)\n` +
    `• اضغط "✅ تأكيد الإرسال"\n\n` +
    
    `*الخطوة 6️⃣: راجع الصور*\n` +
    `• سيعرض البوت جميع الصور\n` +
    `• راجعها بدقة\n` +
    `• إذا كانت صحيحة: اضغط "✅ نعم، أرسل الآن"\n` +
    `• إذا كانت خاطئة: اضغط "❌ إلغاء" وابدأ من جديد\n\n` +
    
    `*الخطوة 7️⃣: انتظر الموافقة*\n` +
    `• سيراجع الأدمن الصور\n` +
    `• إذا وافق: ستحصل على المكافأة 💰\n` +
    `• إذا رفض: ستحصل على إشعار\n\n` +
    
    `*الخطوة 8️⃣: اسحب أرباحك*\n` +
    `• اضغط "💳 سحب الأرباح"\n` +
    `• اختر الطريقة (فودافون كاش أو بينانس)\n` +
    `• أرسل رقمك أو ID\n` +
    `• انتظر موافقة الأدمن\n\n` +
    
    `⚠️ *تحذيرات مهمة:*\n` +
    `• انتظر دقيقة او اكثر بين كل رسالة (مهم جداً!)\n` +
    `• لا تلغي المهام بدون سبب\n` +
    `• 5 محاولات فاشلة = حظر دائم\n` +
    `• أكمل المهمة خلال الوقت المحدد\n` +
    `• راجع الصور قبل الإرسال النهائي\n\n` +
    
    `✅ *نصائح للنجاح:*\n` +
    `• خذ سكرينات واضحة\n` +
    `• تأكد من إرسال الرسائل لجميع الأرقام\n` +
    `• لا ترسل صور مكررة\n` +
    `• اقرأ المطلوب بدقة قبل البدء\n` +
    `• استخدم مؤقت للانتظار دقيقة أو أكثر بين الرسائل\n\n` +
    
    `💡 *ملخص سريع:*\n` +
    `احصل على مهمة → أرسل الإعلان (انتظر دقيقة أو أكثر بين كل رسالة) → خذ سكرينات → أرسل الإثبات → راجع الصور → احصل على المكافأة`;
  
  bot.sendMessage(userId, howToText, { parse_mode: 'Markdown' });
  
  // إرسال الفيديو إذا كان موجوداً
  if (videoFileId && videoFileId !== 'none') {
    setTimeout(() => {
      bot.sendVideo(userId, videoFileId, {
        caption: '🎥 شاهد الفيديو التوضيحي لمزيد من التفاصيل'
      }).catch((error) => {
        logError('Error sending how to work video', error, userId);
      });
    }, 1000);
  }
}

// عرض المجموعات المعلقة
function showPendingGroups(userId) {
  const pendingGroups = db.prepare('SELECT * FROM number_groups WHERE is_available = 2 ORDER BY id DESC').all();
  
  if (pendingGroups.length === 0) {
    return bot.sendMessage(userId, '✅ لا توجد مجموعات معلقة');
  }
  
  let message = `📋 المجموعات المعلقة (${pendingGroups.length}):\n\n`;
  const keyboard = [];
  
  pendingGroups.forEach(group => {
    // البحث عن المهمة المرتبطة بهذه المجموعة
    const task = db.prepare('SELECT * FROM tasks WHERE group_id = ? AND status = ?').get(group.id, 'pending_approval');
    
    if (task) {
      const user = db.prepare('SELECT username FROM users WHERE user_id = ?').get(task.user_id);
      const username = user && user.username ? `@${user.username}` : `ID: ${task.user_id}`;
      
      message += `🆔 المجموعة #${group.id}\n`;
      message += `👤 ${username}\n`;
      message += `📸 ${task.proof_count} صورة\n`;
      message += `─────────────\n`;
      
      keyboard.push([{ text: `📋 مجموعة #${group.id} - ${username}`, callback_data: `review_pending_group_${group.id}` }]);
    }
  });
  
  keyboard.push([{ text: '🔙 لوحة التحكم', callback_data: 'back_to_admin' }]);
  
  bot.sendMessage(userId, message, {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

// مراجعة مجموعة معلقة
async function reviewPendingGroup(adminId, groupId) {
  const group = db.prepare('SELECT * FROM number_groups WHERE id = ?').get(groupId);
  
  if (!group) {
    return bot.sendMessage(adminId, '❌ المجموعة غير موجودة');
  }
  
  const task = db.prepare('SELECT * FROM tasks WHERE group_id = ? AND status = ?').get(groupId, 'pending_approval');
  
  if (!task) {
    return bot.sendMessage(adminId, '❌ لا توجد مهمة مرتبطة بهذه المجموعة');
  }
  
  // استخدام دالة reviewTask الموجودة
  reviewTask(adminId, task.id);
}

// إرجاع المجموعة للمتاحة
function returnGroup(adminId, groupId) {
  db.prepare('UPDATE number_groups SET is_available = 1 WHERE id = ?').run(groupId);
  bot.sendMessage(adminId, `✅ تم إرجاع المجموعة #${groupId} إلى المجموعات المتاحة`);
}

// حذف المجموعة المرفوضة
function deleteRejectedGroup(adminId, groupId) {
  db.prepare('DELETE FROM number_groups WHERE id = ?').run(groupId);
  bot.sendMessage(adminId, `🗑️ تم حذف المجموعة #${groupId} نهائياً`);
}

// ============================================
// إدارة الأدمنز
// ============================================

function showAdminsMenu(userId) {
  const admins = db.prepare('SELECT * FROM admins ORDER BY added_at DESC').all();
  
  let message = '👨‍💼 قائمة الأدمنز:\n\n';
  
  if (admins.length === 0) {
    message += 'لا يوجد أدمنز\n';
  } else {
    admins.forEach((admin, index) => {
      const username = admin.username ? `@${admin.username}` : 'لا يوجد';
      const adminType = admin.user_id === ADMIN_ID ? 'Main Admin' : 'secondary_admin';
      
      message += `${index + 1}. ID: ${admin.user_id}\n`;
      message += `   اليوزر: ${adminType}@${username}\n`;
      message += `   تاريخ الإضافة: ${admin.added_at}\n`;
      message += `─────────────\n`;
    });
  }
  
  bot.sendMessage(userId, message, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ إضافة أدمن', callback_data: 'add_admin' }],
        [{ text: '🗑️ حذف أدمن', callback_data: 'remove_admin' }],
        [{ text: '🔙 لوحة التحكم', callback_data: 'back_to_admin' }]
      ]
    }
  });
}

// ============================================
// نظام إرسال الرسائل (للأدمن الرئيسي فقط)
// ============================================

function showBroadcastMenu(userId) {
  bot.sendMessage(userId, '📢 إرسال رسالة:\n\nاختر نوع الإرسال:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📣 إرسال لجميع المستخدمين', callback_data: 'broadcast_all' }],
        [{ text: '👤 إرسال لمستخدم معين', callback_data: 'broadcast_single' }],
        [{ text: '🔙 لوحة التحكم', callback_data: 'back_to_admin' }]
      ]
    }
  });
}

// ============================================
// نظام الفحص الدوري للمهام المنتهية
// ============================================

function checkExpiredTasks() {
  try {
    // الحصول على وقت المهمة من الإعدادات
    const taskTimeout = parseInt(getSetting('task_timeout'));
    const timeoutSeconds = taskTimeout * 60; // تحويل الدقائق إلى ثواني
    
    // البحث عن المهام النشطة التي مر عليها أكثر من الوقت المحدد
    const expiredTasks = db.prepare(`
      SELECT t.*, u.user_id as uid
      FROM tasks t
      JOIN users u ON t.user_id = u.user_id
      WHERE t.status = 'active' 
      AND (strftime('%s', 'now') - strftime('%s', t.created_at)) > ?
    `).all(timeoutSeconds);
    
    if (expiredTasks.length > 0) {
      logInfo(`Found ${expiredTasks.length} expired tasks`);
    }
    
    expiredTasks.forEach(task => {
      const userId = task.user_id;
      const isAdminUser = isAdmin(userId);
      
      // إلغاء المهمة وإرجاع المجموعة
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('cancelled', task.id);
      db.prepare('UPDATE number_groups SET is_available = 1 WHERE id = ?').run(task.group_id);
      
      // تسجيل محاولة فاشلة
      const failResult = recordFailedTask(userId);
      
      let message = `⏰ انتهى وقت المهمة!\n\n` +
        `تم إلغاء المهمة تلقائياً لعدم إكمالها خلال ${taskTimeout} دقيقة.\n`;
      
      if (failResult.banned && failResult.permanent) {
        const supportText = getSetting('support_text');
        message = `⛔ تم حظرك من استخدام البوت!\n\n` +
          `❌ السبب: فشلت في إتمام 5 مهام متتالية\n\n` +
          `📞 إذا كنت تعتقد أن هناك خطأ، يرجى التواصل مع الدعم:\n\n` +
          `${supportText}`;
        bot.sendMessage(userId, message, { reply_markup: { remove_keyboard: true } }).catch(err => {
          logError('Failed to send ban message to user', err, userId);
        });
      } else if (failResult.count === 4) {
        message += `\n⚠️ تحذير نهائي!\n\n` +
          `🚨 هذه آخر فرصة!\n` +
          `إذا فشلت في إتمام المهمة القادمة، سيتم حظرك للأبد.`;
        bot.sendMessage(userId, message, { reply_markup: getMainKeyboard(isAdminUser) }).catch(err => {
          logError('Failed to send warning message to user', err, userId);
        });
      } else if (failResult.count >= 1) {
        message += `\n⚠️ تحذير!\n\n` +
          `في حالة سحب وإرجاع المجموعة أكثر من مرة ستأخذ بان.`;
        bot.sendMessage(userId, message, { reply_markup: getMainKeyboard(isAdminUser) }).catch(err => {
          logError('Failed to send message to user', err, userId);
        });
      } else {
        bot.sendMessage(userId, message, { reply_markup: getMainKeyboard(isAdminUser) }).catch(err => {
          logError('Failed to send message to user', err, userId);
        });
      }
      
      logInfo(`Task ${task.id} expired and cancelled for user ${userId}`);
    });
  } catch (error) {
    logError('Error in checkExpiredTasks', error);
  }
}

// فحص المهام الملغاة مؤقتاً (temp_cancelled) التي مر عليها أكثر من دقيقتين
function checkCancelledTasks() {
  try {
    // البحث عن المهام الملغاة مؤقتاً في قاعدة البيانات
    const tempCancelledTasks = db.prepare(`
      SELECT * FROM tasks 
      WHERE status = 'temp_cancelled'
    `).all();
    
    tempCancelledTasks.forEach(task => {
      const userId = task.user_id;
      const isAdminUser = isAdmin(userId);
      
      // التحقق من الوقت المنقضي منذ آخر تحديث
      const timeQuery = db.prepare(`
        SELECT (strftime('%s', 'now') - strftime('%s', created_at)) as elapsed_seconds 
        FROM tasks WHERE id = ?
      `).get(task.id);
      
      // إذا مر أكثر من دقيقتين (120 ثانية)
      if (timeQuery.elapsed_seconds > 120) {
        // حذف المهمة نهائياً
        db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
        db.prepare('UPDATE number_groups SET is_available = 1 WHERE id = ?').run(task.group_id);
        
        // تسجيل محاولة فاشلة
        const failResult = recordFailedTask(userId);
        
        // حذف من الذاكرة المؤقتة
        delete userProofPhotos[userId];
        delete cancelledTasks[userId];
        delete secondCancellation[userId];
        
        let message = `✅ تم حذف المهمة نهائياً\n\n` +
          `تم إرجاع مجموعة الأرقام.\n`;
        
        if (failResult.banned && failResult.permanent) {
          const supportText = getSetting('support_text');
          message = `⛔ تم حظرك من استخدام البوت!\n\n` +
            `❌ السبب: فشلت في إتمام 5 مهام متتالية\n\n` +
            `📞 إذا كنت تعتقد أن هناك خطأ، يرجى التواصل مع الدعم:\n\n` +
            `${supportText}`;
          bot.sendMessage(userId, message, { reply_markup: { remove_keyboard: true } }).catch(err => {
            logError('Failed to send message to user', err, userId);
          });
        } else if (failResult.count === 4) {
          message += `\n⚠️ تحذير نهائي!\n\n` +
            `🚨 هذه آخر فرصة!\n` +
            `إذا فشلت في إتمام المهمة القادمة، سيتم حظرك للأبد.`;
          bot.sendMessage(userId, message, { reply_markup: getMainKeyboard(isAdminUser) }).catch(err => {
            logError('Failed to send message to user', err, userId);
          });
        } else if (failResult.count >= 1) {
          message += `\n⚠️ تحذير!\n\n` +
            `في حالة سحب وإرجاع المجموعة أكثر من مرة ستأخذ بان.`;
          bot.sendMessage(userId, message, { reply_markup: getMainKeyboard(isAdminUser) }).catch(err => {
            logError('Failed to send message to user', err, userId);
          });
        } else {
          bot.sendMessage(userId, message, { reply_markup: getMainKeyboard(isAdminUser) }).catch(err => {
            logError('Failed to send message to user', err, userId);
          });
        }
        
        logInfo(`Temp cancelled task ${task.id} expired and deleted for user ${userId}`);
      }
    });
  } catch (error) {
    logError('Error in checkCancelledTasks', error);
  }
}

// فحص المهام المنتهية كل دقيقة
setInterval(checkExpiredTasks, 60 * 1000);

// فحص المهام الملغاة مؤقتاً كل 30 ثانية
setInterval(checkCancelledTasks, 30 * 1000);

// فحص فوري عند بدء التشغيل (للمهام التي انتهت أثناء توقف البوت)
setTimeout(checkExpiredTasks, 5000);
setTimeout(checkCancelledTasks, 5000);

// ============================================
// طلبات السحب (للأدمن فقط)
// ============================================

function showWithdrawalRequests(adminId) {
  try {
    // الحصول على جميع طلبات السحب المعلقة من قاعدة البيانات
    const pendingRequests = db.prepare('SELECT * FROM withdrawal_requests WHERE status = ? ORDER BY created_at DESC').all('pending');
    
    if (pendingRequests.length === 0) {
      return bot.sendMessage(adminId, '📭 لا توجد طلبات سحب حالياً', {
        reply_markup: getAdminKeyboard(adminId)
      });
    }
    
    bot.sendMessage(adminId, `💸 لديك ${pendingRequests.length} طلب سحب معلق\n\nسيتم عرض كل طلب بشكل منفصل...`);
    
    const usdRate = parseFloat(getSetting('usd_rate')) || 50;
    
    // عرض كل طلب في رسالة منفصلة
    pendingRequests.forEach((request, index) => {
      setTimeout(() => {
        const user = db.prepare('SELECT username FROM users WHERE user_id = ?').get(request.user_id);
        
        if (user) {
          const withdrawAmount = request.amount;
          let walletType = request.method === 'binance' ? 'بينانس' : 'فودافون كاش';
          let displayWallet = request.wallet_info;
          let displayAmount = `${withdrawAmount} جنيه`;
          
          if (request.method === 'binance') {
            const amountInUSD = (withdrawAmount / usdRate).toFixed(2);
            displayAmount = `${withdrawAmount} جنيه (${amountInUSD} USDT)`;
          }
          
          const username = user.username ? `@${user.username}` : 'لا يوجد';
          
          let message = `💳 طلب سحب #${index + 1}\n\n`;
          message += `👤 المستخدم: ${username}\n`;
          message += `🆔 ID: ${request.user_id}\n`;
          message += `💰 المبلغ: ${displayAmount}\n`;
          message += `📱 الطريقة: ${walletType}\n`;
          message += `💳 المحفظة: ${displayWallet}\n`;
          
          bot.sendMessage(adminId, message, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ تم الدفع', callback_data: `withdraw_paid_${request.id}` }],
                [{ text: '❌ رفض الطلب', callback_data: `withdraw_reject_${request.id}` }]
              ]
            }
          });
        }
      }, index * 500); // تأخير 500ms بين كل رسالة
    });
    
    logInfo('Admin viewed withdrawal requests', { adminId, count: pendingRequests.length });
  } catch (error) {
    logError('Error showing withdrawal requests', error, adminId);
    bot.sendMessage(adminId, '❌ حدث خطأ في عرض طلبات السحب');
  }
}

// ============================================
// تقرير المستخدم (للأدمن فقط)
// ============================================

function showUserReport(adminId, targetUserId) {
  try {
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(targetUserId);
    
    if (!user) {
      return bot.sendMessage(adminId, '❌ المستخدم غير موجود');
    }
    
    // إحصائيات المهام
    const completedTasks = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = ?').get(targetUserId, 'completed');
    const activeTasks = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = ?').get(targetUserId, 'active');
    const cancelledTasks = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = ?').get(targetUserId, 'cancelled');
    const pendingApproval = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = ?').get(targetUserId, 'pending_approval');
    
    // آخر 10 مهام
    const recentTasks = db.prepare(`
      SELECT id, status, created_at, completed_at 
      FROM tasks 
      WHERE user_id = ? 
      ORDER BY created_at DESC 
      LIMIT 10
    `).all(targetUserId);
    
    // حساب معدل النجاح
    const totalTasks = completedTasks.count + cancelledTasks.count;
    const successRate = totalTasks > 0 ? ((completedTasks.count / totalTasks) * 100).toFixed(1) : 0;
    
    // حالة الحظر
    let banStatus = '✅ نشط';
    if (user.is_blocked === 1) {
      banStatus = '🚫 محظور';
    } else if (user.failed_tasks_count >= 4) {
      banStatus = `⚠️ تحذير نهائي (${user.failed_tasks_count}/5 محاولات فاشلة)`;
    } else if (user.failed_tasks_count > 0) {
      banStatus = `⚠️ ${user.failed_tasks_count}/5 محاولات فاشلة`;
    }
    
    // تاريخ التسجيل
    const joinDate = user.created_at ? new Date(user.created_at).toLocaleDateString('ar-EG') : 'غير متوفر';
    
    // آخر محاولة فاشلة
    let lastFailInfo = 'لا يوجد';
    if (user.last_failed_task_time) {
      const lastFailDate = new Date(user.last_failed_task_time);
      const now = new Date();
      const hoursPassed = Math.floor((now - lastFailDate) / (1000 * 60 * 60));
      lastFailInfo = `منذ ${hoursPassed} ساعة`;
    }
    
    // بناء التقرير
    let report = `📋 تقرير المستخدم الكامل\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    // معلومات أساسية
    report += `👤 المعلومات الأساسية:\n`;
    report += `🆔 ID: \`${targetUserId}\`\n`;
    report += `📝 Username: ${user.username ? '@' + user.username : 'غير متوفر'}\n`;
    report += `📅 تاريخ التسجيل: ${joinDate}\n`;
    report += `🔰 الحالة: ${banStatus}\n\n`;
    
    // المحفظة
    report += `💰 المحفظة:\n`;
    report += `💵 الرصيد: ${user.balance} جنيه\n`;
    report += `📍 عنوان المحفظة: ${user.wallet_address || 'غير محدد'}\n\n`;
    
    // إحصائيات المهام
    report += `📊 إحصائيات المهام:\n`;
    report += `✅ مهام مكتملة: ${completedTasks.count}\n`;
    report += `⏳ مهام نشطة: ${activeTasks.count}\n`;
    report += `❌ مهام ملغاة: ${cancelledTasks.count}\n`;
    report += `⏰ في انتظار الموافقة: ${pendingApproval.count}\n`;
    report += `📈 معدل النجاح: ${successRate}%\n\n`;
    
    // المحاولات الفاشلة
    report += `⚠️ المحاولات الفاشلة:\n`;
    report += `🔢 العدد: ${user.failed_tasks_count}/5\n`;
    report += `🕐 آخر فشل: ${lastFailInfo}\n\n`;
    
    // إرسال التقرير الأساسي
    bot.sendMessage(adminId, report, { 
      parse_mode: 'Markdown',
      reply_markup: getAdminKeyboard(adminId) 
    });
    
    // إرسال سجل آخر 10 مهام
    if (recentTasks.length > 0) {
      let tasksLog = `📜 سجل آخر ${recentTasks.length} مهام:\n`;
      tasksLog += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      recentTasks.forEach((task, index) => {
        const statusEmoji = {
          'completed': '✅',
          'active': '⏳',
          'cancelled': '❌',
          'pending_approval': '⏰',
          'temp_cancelled': '🔄'
        };
        
        const statusText = {
          'completed': 'مكتملة',
          'active': 'نشطة',
          'cancelled': 'ملغاة',
          'pending_approval': 'في انتظار الموافقة',
          'temp_cancelled': 'ملغاة مؤقتاً'
        };
        
        const createdDate = new Date(task.created_at).toLocaleString('ar-EG');
        const completedDate = task.completed_at ? new Date(task.completed_at).toLocaleString('ar-EG') : '-';
        
        tasksLog += `${index + 1}. ${statusEmoji[task.status]} المهمة #${task.id}\n`;
        tasksLog += `   الحالة: ${statusText[task.status]}\n`;
        tasksLog += `   تاريخ الإنشاء: ${createdDate}\n`;
        if (task.completed_at) {
          tasksLog += `   تاريخ الإكمال: ${completedDate}\n`;
        }
        tasksLog += `\n`;
      });
      
      bot.sendMessage(adminId, tasksLog);
    } else {
      bot.sendMessage(adminId, '📜 لا يوجد سجل مهام لهذا المستخدم');
    }
    
    logInfo('Admin viewed user report', { adminId, targetUserId });
    
  } catch (error) {
    logError('Error generating user report', error, adminId);
    bot.sendMessage(adminId, '❌ حدث خطأ في إنشاء التقرير').catch(() => {});
  }
}

logInfo('✅ البوت يعمل الآن...');
logInfo('✅ نظام الفحص الدوري للمهام المنتهية مفعّل');
logInfo('✅ نظام الفحص الدوري للمهام الملغاة مؤقتاً مفعّل');



