/**
 * 迁移 035：students.status 中文脏数据归一为系统枚举
 *
 * 背景（审计 2026-10-16 · P1-3）：
 *   导入路径此前把台账里的「正常 / 流失 / 退款 / 暂停」原样写入 students.status，
 *   而系统枚举是 active / paused / refunded / churn / graduated。后果是三处口径打架：
 *   列表「状态」列渲染中文原值（靠前端兜底才没露馅）、看板「在册成员」统计 s.status='active'
 *   得 0、列表状态筛选按会员卡存在性推断 → 「筛『正常』返回 0 条」。
 *
 * 本迁移把存量中文值归一为枚举；导入路径已在 routes/students.js 侧改为「映射 + 未知值 warning 回落」。
 *
 * 幂等：条件是 status = 中文原值，归一后不再匹配。
 */
function up(db) {
  const MAP = {
    正常: 'active', 在读: 'active', 活跃: 'active',
    流失: 'churn', 停课: 'churn',
    退款: 'refunded', 已退费: 'refunded', 退费: 'refunded',
    暂停: 'paused', 休学: 'paused',
    已结束: 'graduated', 结束: 'graduated', 毕业: 'graduated', 结业: 'graduated',
  };
  const cols = db.prepare("SELECT name FROM pragma_table_info('students')").all().map((c) => c.name);
  if (!cols.includes('status')) return;

  const upd = db.prepare('UPDATE students SET status = ? WHERE status = ?');
  let changed = 0;
  for (const [from, to] of Object.entries(MAP)) changed += upd.run(to, from).changes;
  if (changed > 0) console.log(`[Migrations] students.status 中文值已归一：${changed} 行`);

  // fail-loud：归一后仍非枚举的值要显式列出，避免再次「静默存在非法状态」
  const VALID = ['active', 'paused', 'refunded', 'churn', 'graduated'];
  const bad = db.prepare(`
    SELECT COALESCE(status, '(空)') AS s, COUNT(*) AS c FROM students
    WHERE status IS NULL OR status NOT IN (${VALID.map(() => '?').join(',')})
    GROUP BY status
  `).all(...VALID);
  if (bad.length) {
    console.warn(`[Migrations] 仍有非枚举状态（需人工确认）：${bad.map((b) => `${b.s}×${b.c}`).join('、')}`);
  }
}

module.exports = { up };
