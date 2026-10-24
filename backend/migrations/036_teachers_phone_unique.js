/**
 * 036 — teachers.phone 唯一约束（部分索引，空号不参与）
 *
 * 背景：新增员工只查 users 表且只比角色，同手机号同角色可重复建档，
 * teachers 出现多条同名行 → 员工下拉/排课/工资结算把同一人算多份。
 *
 * 处置原则：**不自动合并存量数据**。合并要改 schedules / payroll_logs /
 * schedule_rules / classes.coach_id 的引用，一旦判断错就是把历史课时与工资挂到别人名下。
 * 因此：
 *   · 无重复 → 建唯一索引，从此数据库层兜底；
 *   · 有重复 → 不建索引，打印明细清单，由管理员人工核对后清理再启动（启动日志可见）。
 * 应用层已在创建/改号处做了查重，索引是第二道防线而非唯一防线。
 */
'use strict';

module.exports = {
  id: '036_teachers_phone_unique',
  up(db) {
    const dups = db.prepare(`
      SELECT phone, COUNT(*) AS c, GROUP_CONCAT(name, ' / ') AS names
      FROM teachers
      WHERE phone IS NOT NULL AND phone != ''
      GROUP BY phone HAVING c > 1
    `).all();

    if (dups.length) {
      console.warn(`[migration 036] teachers 存在 ${dups.length} 个重复手机号，已跳过唯一索引（应用层查重仍然生效）：`);
      for (const d of dups.slice(0, 10)) console.warn(`  · ${d.phone} × ${d.c}（${d.names}）`);
      return;
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_teachers_phone_unique
      ON teachers(phone) WHERE phone IS NOT NULL AND phone != '';
    `);
  },
};
