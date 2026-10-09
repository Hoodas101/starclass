/**
 * 迁移 034：students.join_date 文本形态归一化
 *
 * 背景（审计 2026-10-08 · P1-1）：
 *   `students.join_date` 声明为 TEXT（db/init.js:42），而建档与导入写入的都是 JS 数字。
 *   better-sqlite3 把 JS 数字按 REAL 绑定，SQLite 的 TEXT 亲和性随即把浮点写成文本，
 *   落库形态为 **'1788059200000.0'**（带 `.0`）—— 而早期经另一条路径写入的是纯整数串。
 *   前端 `toDate()` 用 /^\d{10,}$/ 判定 epoch，带 `.0` 不匹配 → Invalid Date → 整列显示 `-`
 *   （学员档案「加入时间」360 条全空）。
 *
 * 修法：把已落库的浮点形态转成纯整数文本（语义不变，仍是毫秒时间戳）。
 * 注意 CAST 链：'1788059200000.0' --REAL--> 1788059200000.0 --INTEGER--> 1788059200000，
 * 写回 TEXT 列即为 '1788059200000'。仅处理含 `.` 的行，已正常的行不受影响。
 *
 * 幂等：条件是 LIKE '%.%'，归一化后不再匹配，重复执行无副作用。
 */
function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('students')").all().map((c) => c.name);
  if (!cols.includes('join_date')) return;
  const r = db.prepare(`
    UPDATE students
    SET join_date = CAST(CAST(join_date AS REAL) AS INTEGER)
    WHERE join_date IS NOT NULL AND join_date LIKE '%.%'
      AND CAST(CAST(join_date AS REAL) AS INTEGER) > 0
  `).run();
  if (r.changes > 0) {
    console.log(`[Migrations] join_date 文本形态已归一化：${r.changes} 行`);
  }
}

module.exports = { up };
