/**
 * 迁移 041：students.join_date 毫秒串 → 'YYYY-MM-DD'
 *
 * 背景（审计 2026-10-28 · 数据口径 P1）：
 *   迁移 034 只把 '1788059200000.0' 归一成 '1788059200000'（仍是毫秒串），
 *   而全站按加入日期筛选/统计走的是**字符串比较**（students.js 筛选分支）：
 *   '1793183501149' 与 '2026-10-28' 比较时 '1...' < '2...' 恒成立 → 这类学员
 *   在任何日期区间筛选里都**静默漏掉**（实测 44 条应筛出、只出 31 条）。
 *
 * 修法：把纯毫秒串（无 '-'、13 位、落在 2001–2286 的合法毫秒区间）转成本地(+8)日期串。
 * 与写入侧统一：students.js / growth.js 建档与导入均已改为 formatDate(now())。
 *
 * 幂等：转成 'YYYY-MM-DD' 后含 '-'，不再命中 WHERE，重复执行无副作用。
 */
function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('students')").all().map((c) => c.name);
  if (!cols.includes('join_date')) return;
  const r = db.prepare(`
    UPDATE students
    SET join_date = strftime('%Y-%m-%d', datetime(CAST(join_date AS INTEGER) / 1000, 'unixepoch', '+8 hours'))
    WHERE join_date IS NOT NULL
      AND join_date NOT LIKE '%-%'
      AND length(join_date) >= 10
      AND CAST(join_date AS INTEGER) BETWEEN 1000000000000 AND 9999999999999
  `).run();
  if (r.changes > 0) {
    console.log(`[Migrations] join_date 毫秒串已转为日期串：${r.changes} 行`);
  }
}

module.exports = { up };
