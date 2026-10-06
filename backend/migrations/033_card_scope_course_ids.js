/**
 * 迁移 033：membership_cards.scope_course_ids（结构化课程范围）
 *
 * 背景（审计报告 2026-10-06 · P1-6）：
 *   卡种的课程范围此前是自由中文文本 course_scope，匹配判据是 `scope.includes(course_name)`
 *   （反向包含）——课程名比范围串长即误拒（「1v1私教」vs「1v1私教课」），
 *   而 `scope.includes(course_id)` 恒为 false（中文串 vs 英文 ID）。整个体系靠中文名巧合运转。
 *
 * 方案：新增结构化列 scope_course_ids（逗号分隔的 course_id 多值），扣课时优先按 id 精确匹配；
 *   为空则回退到原文本 course_scope 逻辑（向后兼容，存量卡种无需迁移数据）。
 *
 * 幂等：ALTER 前查 pragma_table_info。
 */
function up(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('membership_cards')").all().map((c) => c.name);
  if (!cols.includes('scope_course_ids')) {
    db.exec("ALTER TABLE membership_cards ADD COLUMN scope_course_ids TEXT NOT NULL DEFAULT ''");
  }
}

module.exports = { up };
