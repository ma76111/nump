// سكريبت لإضافة الأدمن الثانوي إلى قاعدة البيانات الحالية
require('dotenv').config();
const Database = require('better-sqlite3');
const db = new Database('bot.db');

console.log('🔧 إضافة الأدمن الثانوي...\n');

const mainAdminId = parseInt(process.env.ADMIN_ID) || 6793329200;
const secondaryAdminId = 8536579207;

try {
  // التحقق من وجود الأدمن الثانوي
  const existingAdmin = db.prepare('SELECT * FROM admins WHERE user_id = ?').get(secondaryAdminId);
  
  if (existingAdmin) {
    console.log(`⚠️  الأدمن الثانوي موجود بالفعل (ID: ${secondaryAdminId})`);
  } else {
    // إضافة الأدمن الثانوي
    db.prepare('INSERT INTO admins (user_id, username, added_by) VALUES (?, ?, ?)').run(secondaryAdminId, 'Secondary Admin', mainAdminId);
    console.log(`✅ تم إضافة الأدمن الثانوي بنجاح (ID: ${secondaryAdminId})`);
  }
  
  // عرض قائمة الأدمنز
  console.log('\n📋 قائمة الأدمنز الحالية:');
  const admins = db.prepare('SELECT * FROM admins').all();
  admins.forEach((admin, index) => {
    console.log(`  ${index + 1}. ID: ${admin.user_id} | Username: ${admin.username || 'N/A'} | Added: ${admin.added_at}`);
  });
  
  console.log('\n✅ تم بنجاح!');
} catch (error) {
  console.error('❌ خطأ:', error.message);
} finally {
  db.close();
}
