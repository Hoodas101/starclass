/**
 * 迁移 014：收编散落在 routes/*.js 与 utils/ 中 require 时执行的建表 / 建索引语句
 *
 * 背景（承接 011）：011 已把散落的 `try { ALTER TABLE ... } catch {}` 列收编进幂等账本，
 * 但**建表与建索引**仍留在各路由文件顶部（共 26 处）。这些语句用的是
 * `CREATE TABLE IF NOT EXISTS`，对「表已存在但结构较旧」的库是**静默空操作**——
 * 于是后续版本给该表新增的列永远无法到达老库，直到运行时才以
 * `no such column` 崩溃。迁移账本（_migrations）才是 schema 的唯一权威来源。
 *
 * 本迁移把 7 张仅由路由创建的表的建表/建索引语句、以及 4 处补列语句收编至此，
 * 并同步删除路由文件中的对应 DDL。
 *
 * 幂等性：建表/建索引均带 IF NOT EXISTS；补列用 safeAddColumn（PRAGMA 先探测）。
 * 新库 / 老库 / 半迁移库均可安全重复执行。
 *
 * 注意：**不要**在本文件里使用会抛错的裸 ALTER。runner.js 把每个迁移包在一个事务里，
 * 且把 `duplicate column name` 当作「已执行」处理——若中途抛错，整个事务回滚
 * 却仍被记为已执行，建表语句将永久丢失。故补列一律走 safeAddColumn。
 */

function safeAddColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function up(db) {
  // ── 勿扰名单 / 营销抑制（原 routes/admin.js 顶部）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS suppressions (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      name TEXT DEFAULT '',
      type TEXT DEFAULT 'marketing',
      reason TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_suppressions_phone ON suppressions(phone)');

  // ── 补课记录（原 routes/makeup.js 顶部）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS makeup_records (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      student_name TEXT,
      original_schedule_id TEXT,
      original_date TEXT,
      original_course_name TEXT,
      makeup_schedule_id TEXT NOT NULL,
      makeup_date TEXT,
      makeup_course_name TEXT,
      type TEXT DEFAULT 'makeup',
      status TEXT DEFAULT 'pending',
      created_by TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_makeup_student ON makeup_records(student_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_makeup_schedule ON makeup_records(makeup_schedule_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_makeup_status ON makeup_records(status)');

  // ── 试听预约（原 routes/trial.js 顶部）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS trial_bookings (
      id TEXT PRIMARY KEY,
      parent_openid TEXT,
      parent_name TEXT DEFAULT '',
      parent_phone TEXT DEFAULT '',
      student_name TEXT NOT NULL,
      student_age INTEGER,
      student_gender TEXT DEFAULT '',
      course_id TEXT,
      course_name TEXT DEFAULT '',
      preferred_date TEXT,
      preferred_time TEXT DEFAULT '',
      note TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      assigned_schedule_id TEXT,
      handled_by TEXT DEFAULT '',
      handle_note TEXT DEFAULT '',
      lead_id TEXT,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_trial_status ON trial_bookings(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_trial_phone ON trial_bookings(parent_phone)');

  // ── 跟进任务（原 routes/followups.js 顶部）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS follow_ups (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL DEFAULT 'student',
      target_id TEXT NOT NULL,
      target_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      task_type TEXT DEFAULT 'other',
      reason TEXT DEFAULT '',
      owner TEXT DEFAULT '',
      due_at INTEGER NOT NULL,
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      note TEXT DEFAULT '',
      completed_at INTEGER,
      created_by TEXT DEFAULT '',
      created_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups(due_at, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_follow_ups_target ON follow_ups(target_type, target_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_follow_ups_owner ON follow_ups(owner, status)');

  // ── 教练点评（原 routes/comments.js 顶部）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS coach_comments (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      student_name TEXT,
      schedule_id TEXT,
      course_name TEXT,
      date TEXT,
      coach_id TEXT,
      coach_name TEXT,
      content TEXT,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);

  // ── 请假扣课幂等表（原 routes/leave.js 顶部）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS leave_deduction_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      card_id TEXT,
      mode TEXT,
      deducted_at INTEGER,
      UNIQUE(schedule_id, student_id)
    )
  `);

  // ── 订阅消息发送日志（原 utils/subscribe-msg.js 底部）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscribe_msg_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id TEXT NOT NULL,
      openid TEXT NOT NULL,
      template_key TEXT,
      status TEXT,
      error TEXT,
      created_at INTEGER,
      UNIQUE(notification_id, openid)
    )
  `);

  // ── 为已有库补充列（原 server.js 顶部 3 处 + routes/growth.js 顶部 1 处）──
  // init.js 的 students 已含这三列，故此处只对「升级上来的老库」生效；
  // leads.stage_changed_at 则对新库老库都需要。
  safeAddColumn(db, 'students', 'height', 'REAL DEFAULT 0');
  safeAddColumn(db, 'students', 'weight', 'REAL DEFAULT 0');
  safeAddColumn(db, 'students', 'bmi', 'REAL DEFAULT 0');
  safeAddColumn(db, 'leads', 'stage_changed_at', 'INTEGER DEFAULT 0');
}

module.exports = { up };
