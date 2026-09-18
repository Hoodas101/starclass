/**
 * SQLite 数据库连接（单例）
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 数据库路径：优先使用环境变量 DB_PATH（便于隔离测试，避免污染真实数据），
// 缺省回退到本地 data.db（非破坏性）。
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data.db');

// 确保目录存在
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// 启用 WAL 模式（提升并发性能）
db.pragma('journal_mode = WAL');
// 写锁等待上限：better-sqlite3 构造时默认已是 5000ms，此处显式固定为同一值，
// 使「遇到 SQLITE_BUSY 会等待而不是立刻失败」成为写明的契约而非隐含的驱动默认，
// 避免将来驱动默认值变化后在并发写（tools/backup.sh 的 sqlite3 .backup、
// 数据卫生脚本）时过早抛错。若确有长事务竞争，调大此值即可。
db.pragma('busy_timeout = 5000');
// 启用外键约束
db.pragma('foreign_keys = ON');

// === 基础表初始化 ===
// 先确保全部基础表存在（CREATE TABLE IF NOT EXISTS），再跑增量迁移。
// 这样全新数据库也能直接 `npm start` 启动，无需先手动 `node db/init.js`。
const { init: initDbSchema } = require('./init');
initDbSchema(db);

// === 正式迁移系统（替代散落在各路由的 try/catch ALTER）===
const { runMigrations } = require('../migrations/runner');
runMigrations(db);

// 性能索引：高频查询字段补索引（数据量增长后显著提升响应速度）
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_orders_student ON orders(student_id, status);
  CREATE INDEX IF NOT EXISTS idx_leave_parent ON leave_requests(parent_openid, status);
  CREATE INDEX IF NOT EXISTS idx_leave_student_schedule ON leave_requests(student_id, schedule_id);
`);
console.log('[DB] 索引检查完成');

// 默认密码回填已迁移至 migrations/009_default_password_backfill.js（一次性执行）

console.log(`[DB] SQLite 数据库已连接: ${DB_PATH}`);

module.exports = db;
