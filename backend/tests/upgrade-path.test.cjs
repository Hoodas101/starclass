/**
 * E20 · 迁移升级路径收敛回归（隔离库，离线）
 *
 * 覆盖 B1 根因：**已经部分迁移过的库**，再跑一次真实 runner 能否收敛到最新 schema。
 *
 * 为什么单独一个套件：现有套件都是「全新库跑完整链路」，只能证明 DDL 本身正确；
 * 而 B1 的真实故障形态是「库已有 001..013 的记账，014/015 因故未执行」——
 * 此时若 runner 的发现/记账逻辑有缺陷，014/015 会被永久跳过，schema 静默缺索引。
 * 本套件显式构造这个中间态，再用**真实的** migrations/runner.js 收尾，断言收敛。
 *
 * 运行：node tests/upgrade-path.test.cjs
 */
process.env.DB_PATH = '/tmp/upgrade_path_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

for (const f of ['/tmp/upgrade_path_test.db', '/tmp/upgrade_path_test.db-wal', '/tmp/upgrade_path_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

// 刻意不 require('../db')：那会在 require 时立刻跑完整迁移链，本套件要自己控制中间态。
const { init } = require('../db/init');
const { runMigrations } = require('../migrations/runner');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// ---------- 断言脚手架（与 finance-refund-regression.cjs 同风格） ----------
let failures = 0;
const results = [];
function expect(condition, label, detail) {
  results.push(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`);
  if (!condition) failures++;
}

const db = new Database(process.env.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** 与 runner.js 完全一致的迁移文件发现逻辑（排除 runner.js，按文件名排序） */
const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.js') && f !== 'runner.js')
  .sort();

const indexExists = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
const appliedMigrations = () => db.prepare('SELECT name FROM _migrations').all().map((r) => r.name);

// ============================================================
// 1. 构造「基础表已建 + 迁移已应用到 013」的中间态库
// ============================================================
init(db);

// runner 的记账表 DDL（列定义必须与 runner.js 保持一致）
db.exec(`
  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    executed_at INTEGER NOT NULL
  );
`);

const insertMigration = db.prepare('INSERT INTO _migrations (name, executed_at) VALUES (?, ?)');
const upTo013 = migrationFiles.filter((f) => parseInt(f.slice(0, 3), 10) <= 13);

for (const file of upTo013) {
  const migration = require(path.join(MIGRATIONS_DIR, file));
  db.transaction(() => {
    migration.up(db);
    insertMigration.run(file, Date.now());
  })();
}

const before = appliedMigrations();
expect(upTo013.length === 13, '001..013 共 13 个迁移已应用', `count=${upTo013.length}`);
expect(
  !before.includes('014_consolidate_route_ddl.js') &&
  !before.includes('015_attendance_unique_and_point_index.js') &&
  !before.includes('016_perf_indexes.js'),
  '中间态：014/015/016 尚未记账',
  before.filter((n) => /^01[456]/.test(n)).join(',') || '无'
);
expect(
  !indexExists('uq_attendances_schedule_student'),
  '中间态：015 的唯一索引尚不存在',
  indexExists('uq_attendances_schedule_student') ? '已存在（构造失败）' : ''
);

// ============================================================
// 2. 用真实 runner 收尾 —— 这是被测行为本身
// ============================================================
runMigrations(db);

const after = appliedMigrations();
expect(after.includes('014_consolidate_route_ddl.js'), '014 已被真实 runner 应用');
expect(after.includes('015_attendance_unique_and_point_index.js'), '015 已被真实 runner 应用');
expect(after.includes('016_perf_indexes.js'), '016 已被真实 runner 应用');

// 015 的核心产物：考勤 (schedule_id, student_id) 唯一约束
expect(indexExists('uq_attendances_schedule_student'), '唯一索引 uq_attendances_schedule_student 已建立');
// 015 的另一个产物：积分流水引用索引
expect(indexExists('idx_point_logs_reference'), '索引 idx_point_logs_reference 已建立');
// 016 的产物（Batch 6 · E2/E3）
expect(indexExists('idx_orders_paid_at'), '索引 idx_orders_paid_at 已建立');
expect(indexExists('idx_enrollments_schedule_status'), '索引 idx_enrollments_schedule_status 已建立');
expect(indexExists('idx_enrollments_status'), '索引 idx_enrollments_status 已建立');
// 014 的产物之一：老库补齐 students 的体测列
{
  const cols = db.prepare('PRAGMA table_info(students)').all().map((c) => c.name);
  expect(cols.includes('height') && cols.includes('weight') && cols.includes('bmi'), '014 补列 students.height/weight/bmi 已到位');
}

// ============================================================
// 3. 幂等：再跑一次不应有任何变化、也不应抛错
// ============================================================
const countBefore = db.prepare('SELECT COUNT(*) AS c FROM _migrations').get().c;
let secondRunError = null;
try { runMigrations(db); } catch (e) { secondRunError = e; }
const countAfter = db.prepare('SELECT COUNT(*) AS c FROM _migrations').get().c;

expect(secondRunError === null, '二次运行 runner 不抛错', secondRunError ? secondRunError.message : '');
expect(countAfter === countBefore, '二次运行 runner 不重复记账（幂等）', `${countBefore} → ${countAfter}`);
expect(indexExists('uq_attendances_schedule_student'), '二次运行后唯一索引仍在');

// ============================================================
// 4. 索引真的可用（EXPLAIN QUERY PLAN）
//    空表上优化器必然选全表扫描，故先灌入足量订单并 ANALYZE，让统计信息可信。
// ============================================================
{
  const now = Date.now();
  const ins = db.prepare(`
    INSERT INTO orders (id, order_no, user_id, student_id, order_type, items, total_amount,
                        discount_amount, payable_amount, status, paid_at, created_at, updated_at)
    VALUES (?, ?, '', 'stu_up', 'membership', '[]', 100, 0, 100, 'paid', ?, ?, ?)
  `);
  db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      const t = now - (i % 400) * 86400000;
      ins.run(`ord_up_${i}`, `OU${String(i).padStart(6, '0')}`, t, t, t);
    }
  })();
  db.exec('ANALYZE');

  const plan = db
    .prepare('EXPLAIN QUERY PLAN SELECT SUM(payable_amount) FROM orders WHERE status IN (?, ?) AND paid_at >= ? AND paid_at < ?')
    .all('paid', 'refunded', now - 7 * 86400000, now + 86400000)
    .map((r) => r.detail)
    .join(' | ');

  expect(/idx_orders_paid_at/.test(plan), 'paid_at 毫秒区间谓词命中 idx_orders_paid_at', plan);
}

// ---------- 汇总 ----------
console.log('\n' + results.join('\n'));
console.log(`\n\x1b[1m结果汇总：PASS ${results.length - failures}  FAIL ${failures}\x1b[0m`);

db.close();
process.exit(failures > 0 ? 1 : 0);
