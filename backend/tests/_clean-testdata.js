/**
 * 一次性清理脚本：清空端到端测试残留数据，恢复空库基线。
 * 保留：管理员账号（role='admin'）、settings 配置、_migrations 记账。
 * 用法：node tests/_clean-testdata.js
 */
const db = require('../db');

const KEEP = new Set(['_migrations', 'settings']);

try {
  db.pragma('foreign_keys = OFF');
  db.exec('BEGIN');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .filter((n) => !KEEP.has(n));

  let total = 0;
  for (const t of tables) {
    if (t === 'users') {
      // 只保留管理员账号，其余（测试家长/员工绑定）全部清除
      const n = db.prepare("DELETE FROM users WHERE role IS NULL OR role <> 'admin'").run().changes;
      total += n;
      if (n) console.log(`users      -${n}（保留 admin）`);
      continue;
    }
    const c = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    if (!c) continue;
    db.prepare(`DELETE FROM "${t}"`).run();
    total += c;
    console.log(`${t.padEnd(24)} -${c}`);
  }

  db.exec('COMMIT');
  console.log(`\n清理完成，共删除 ${total} 行`);
  console.log('--- 剩余 ---');
  for (const t of ['users', 'students', 'member_cards', 'orders', 'schedules', 'teachers', 'settings']) {
    try {
      console.log(t.padEnd(16), db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c);
    } catch (e) {
      console.log(t.padEnd(16), 'n/a');
    }
  }
} catch (e) {
  try { db.exec('ROLLBACK'); } catch (_) {}
  console.error('清理失败：', e.message);
  process.exit(1);
} finally {
  db.pragma('foreign_keys = ON');
}
