require('dotenv').config();
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

console.log('🔄 Starting bot reset process...\n');

// Backup current database
const dbPath = process.env.DB_PATH || './bot.db';
const backupPath = `./bot-backup-${Date.now()}.db`;

if (fs.existsSync(dbPath)) {
  console.log('📦 Creating backup of current database...');
  fs.copyFileSync(dbPath, backupPath);
  console.log(`✅ Backup created: ${backupPath}\n`);
}

// Delete old database
if (fs.existsSync(dbPath)) {
  console.log('🗑️  Deleting old database...');
  fs.unlinkSync(dbPath);
  console.log('✅ Old database deleted\n');
}

// Create new database
console.log('🆕 Creating fresh database...');
const db = new Database(dbPath);

// Create tables
console.log('📋 Creating tables...\n');

// 1. Users table
console.log('  → Creating users table...');
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
  )
`);
console.log('  ✅ Users table created');

// 2. Tasks table
console.log('  → Creating tasks table...');
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    group_id INTEGER,
    status TEXT DEFAULT 'pending',
    proof_count INTEGER DEFAULT 0,
    proof_photos TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (group_id) REFERENCES number_groups(id)
  )
`);
console.log('  ✅ Tasks table created');

// 3. Number groups table
console.log('  → Creating number_groups table...');
db.exec(`
  CREATE TABLE IF NOT EXISTS number_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numbers TEXT NOT NULL CHECK(length(numbers) <= 100000),
    is_available INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
console.log('  ✅ Number groups table created');

// 4. Settings table
console.log('  → Creating settings table...');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);
console.log('  ✅ Settings table created');

// 5. Admins table
console.log('  → Creating admins table...');
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    user_id INTEGER PRIMARY KEY,
    username TEXT DEFAULT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    added_by INTEGER DEFAULT NULL
  )
`);
console.log('  ✅ Admins table created');

// 6. Withdrawal requests table
console.log('  → Creating withdrawal_requests table...');
db.exec(`
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
  )
`);
console.log('  ✅ Withdrawal requests table created\n');

// Insert default settings
console.log('⚙️  Inserting default settings...');

const defaultSettings = [
  { key: 'reward_amount', value: '10', description: 'المكافأة لكل مهمة (جنيه)' },
  { key: 'advertisement_text', value: 'هذا نص الإعلان الافتراضي. يمكنك تغييره من لوحة التحكم.', description: 'نص الإعلان' },
  { key: 'support_text', value: 'للتواصل مع الدعم:\n@YourSupportUsername', description: 'نص الدعم الفني' },
  { key: 'task_requirements', value: '1️⃣ أرسل 10 سكرينات من داخل الشات (سكرينة من داخل الشات بعد ما أرسلت الرسالة)\n2️⃣ أرسل سكرينات من خارج الشات تثبت إرسال الرسائل لجميع الأرقام', description: 'نص المطلوب في المهمة' },
  { key: 'task_timeout', value: '90', description: 'وقت إتمام المهمة (دقيقة)' },
  { key: 'usd_rate', value: '50', description: 'سعر الدولار (جنيه)' },
  { key: 'how_to_work_video', value: 'none', description: 'فيديو شرح طريقة العمل' }
];

const insertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

defaultSettings.forEach(setting => {
  insertSetting.run(setting.key, setting.value);
  const displayValue = setting.value.substring(0, 40) + (setting.value.length > 40 ? '...' : '');
  console.log(`  ✅ ${setting.key}: ${displayValue}`);
  console.log(`     └─ ${setting.description}`);
});

// Add main admin (from .env or default)
console.log('\n👨‍💼 Adding main admin...');
const mainAdminId = parseInt(process.env.ADMIN_ID) || 6793329200;
db.prepare('INSERT OR IGNORE INTO admins (user_id, username, added_by) VALUES (?, ?, ?)').run(mainAdminId, 'Main Admin', mainAdminId);
console.log(`  ✅ Main admin added (ID: ${mainAdminId})`);

// Clear logs directory (optional)
const logsDir = './logs';
if (fs.existsSync(logsDir)) {
  console.log('\n🗑️  Clearing logs directory...');
  const logFiles = fs.readdirSync(logsDir);
  logFiles.forEach(file => {
    fs.unlinkSync(path.join(logsDir, file));
  });
  console.log(`  ✅ Deleted ${logFiles.length} log file(s)`);
}

// Close database
db.close();

console.log('\n✅ Bot reset completed successfully!\n');
console.log('📊 Summary:');
console.log('  • Fresh database created');
console.log('  • All tables created:');
console.log('    - users (with ban system)');
console.log('    - tasks (with expires_at)');
console.log('    - number_groups');
console.log('    - settings');
console.log('    - admins');
console.log('    - withdrawal_requests (NEW!)');
console.log('  • Default settings inserted:');
console.log('    - reward_amount: 10 جنيه');
console.log('    - task_requirements: نص المطلوب (قابل للتعديل)');
console.log('    - task_timeout: 90 دقيقة');
console.log('    - usd_rate: 50 جنيه للدولار');
console.log('    - how_to_work_video: none (لم يتم رفع فيديو)');
console.log(`  • Main admin added (ID: ${mainAdminId})`);
console.log('  • Logs cleared');
console.log(`  • Backup saved: ${backupPath}\n`);
console.log('🔒 Security features enabled:');
console.log('  • Race condition protection');
console.log('  • Rate limiting (1 message/second)');
console.log('  • Markdown injection protection');
console.log('  • Image size limit (20MB)');
console.log('  • Duplicate withdrawal prevention\n');
console.log('🚀 Next steps:');
console.log('  1. Make sure your .env file contains:');
console.log('     BOT_TOKEN=your_bot_token_here');
console.log(`     ADMIN_ID=${mainAdminId}`);
console.log('  2. Start the bot: node index.js');
console.log('  3. Upload tutorial video from admin panel');
console.log('  4. Add number groups from admin panel\n');
