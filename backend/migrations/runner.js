/**
 * 数据库迁移运行器
 * 
 * 使用 _migrations 表追踪已执行的迁移，每次启动自动运行待执行迁移。
 * 替代散落在各路由文件中的 try/catch ALTER 模式。
 *
 * 用法：
 *   1. 在 migrations/ 目录下创建迁移文件，文件名格式：NNN_description.js
 *   2. 每个文件导出 { up(db) } 函数，执行 SQL DDL/DML
 *   3. 迁移在服务器启动时自动执行（在 db/index.js 中调用）
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = __dirname;

/**
 * 运行所有待执行的迁移
 * @param {import('better-sqlite3').Database} db
 */
function runMigrations(db) {
  // 创建迁移追踪表（如果不存在）
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      executed_at INTEGER NOT NULL
    );
  `);

  // 获取已执行的迁移
  const executed = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );

  // 扫描迁移文件并排序
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js') && f !== 'runner.js')
    .sort();

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (name, executed_at) VALUES (?, ?)'
  );

  let applied = 0;
  for (const file of files) {
    if (executed.has(file)) continue;

    const migration = require(path.join(MIGRATIONS_DIR, file));
    if (typeof migration.up !== 'function') {
      console.warn(`[Migrations] 跳过 ${file}：未导出 up() 函数`);
      continue;
    }

    const txn = db.transaction(() => {
      migration.up(db);
      insertMigration.run(file, Date.now());
    });

    try {
      txn();
      console.log(`[Migrations] 已执行: ${file}`);
      applied++;
    } catch (err) {
      // 仅“列/索引已存在”属于可安全视为“已应用”的幂等场景（迁移使用 IF NOT EXISTS 时本不应触发）。
      // 其余任何异常一律 fail-loud —— 绝不静默记账，否则会出现「DDL 已回滚、迁移却标记为已完成」，
      // 导致下次启动跳过、真实 schema 缺失。记账动作包在独立事务里，保证原子落库。
      if (err.message && /duplicate (column|index) name/i.test(err.message)) {
        console.warn(`[Migrations] ${file}：目标列/索引已存在，视为已应用并记账`);
        db.transaction(() => { insertMigration.run(file, Date.now()); })();
      } else {
        console.error(`[Migrations] 失败: ${file}`, err.message);
        throw err;
      }
    }
  }

  if (applied > 0) {
    console.log(`[Migrations] 共执行 ${applied} 个迁移`);
  }
}

module.exports = { runMigrations };
