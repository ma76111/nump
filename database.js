const Database = require('better-sqlite3');
const db = new Database('bot.db');

// إنشاء الجداول
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT DEFAULT NULL,
    balance REAL DEFAULT 0,
    is_blocked INTEGER DEFAULT 0,
    wallet_address TEXT DEFAULT NULL,
    failed_tasks_count INTEGER DEFAULT 0,
    last_failed_task_time DATETIME DEFAULT NULL,
    ban_time DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admins (
    user_id INTEGER PRIMARY KEY,
    username TEXT DEFAULT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    added_by INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS number_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numbers TEXT NOT NULL CHECK(length(numbers) <= 100000),
    is_available INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    group_id INTEGER,
    status TEXT DEFAULT 'pending',
    proof_count INTEGER DEFAULT 0,
    proof_photos TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (group_id) REFERENCES number_groups(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL,
    method TEXT,
    wallet_info TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );
`);

// إعدادات افتراضية
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('reward_amount', '10');
insertSetting.run('advertisement_text', 'نص الإعلان الافتراضي');
insertSetting.run('support_text', 'للتواصل مع الدعم الفني، يرجى إرسال رسالة إلى:\n\n@support_username\n\nأو عبر البريد الإلكتروني:\nsupport@example.com');
insertSetting.run('task_requirements', '1️⃣ أرسل 10 سكرينات من داخل الشات (سكرينة من داخل الشات بعد ما أرسلت الرسالة)\n2️⃣ أرسل سكرينات من خارج الشات تثبت إرسال الرسائل لجميع الأرقام');
insertSetting.run('task_timeout', '90'); // الوقت بالدقائق
insertSetting.run('usd_rate', '50'); // سعر الدولار بالجنيه
insertSetting.run('how_to_work_video', 'none'); // معرف الفيديو التوضيحي

// إضافة الأدمن الرئيسي (ID: 6793329200)
const insertAdmin = db.prepare('INSERT OR IGNORE INTO admins (user_id, username, added_by) VALUES (?, ?, ?)');
insertAdmin.run(6793329200, 'main_admin', 6793329200);

// إضافة الأعمدة الجديدة إذا لم تكن موجودة
try {
  db.exec(`ALTER TABLE users ADD COLUMN failed_tasks_count INTEGER DEFAULT 0`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE users ADD COLUMN last_failed_task_time DATETIME DEFAULT NULL`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE users ADD COLUMN ban_time DATETIME DEFAULT NULL`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE tasks ADD COLUMN expires_at DATETIME`);
} catch (e) {}

module.exports = db;
