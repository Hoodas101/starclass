/**
 * 扣课口径收口 —— 「一次课消耗几个课时」的唯一实现。
 *
 * 背景：courses.consume_classes 表示该课程每次上课消耗的课时数（默认 1），
 * 但签到扣课路径长期硬编码 -1，配置为「每次消耗 2 课时」的课程永远只扣 1，
 * 卡内余额被系统性高估（扣课回滚路径同样只 +1，两边一起错）。
 * 本模块把该口径收敛到一处，供 routes/checkin.js（签到扣课 / 回滚）与
 * routes/membership.js（手工扣课）共用。
 *
 * 兜底规则：排期不存在 / 未挂课程 / consume_classes 缺失、非数字或 ≤ 0 时一律按 1。
 * 特别地，course_temp（自定义名称的临时活动）的 consume_classes 刻意写 0，
 * 若按 0 处理则签到完全不扣课，故 0 必须归一到 1。
 */
'use strict';

const db = require('../db');

/**
 * 排期所属课程「每次课消耗的课时数」。
 * @param {string} scheduleId
 * @returns {number} 正整数，缺省 1
 */
function resolveConsumeClasses(scheduleId) {
  if (!scheduleId) return 1;
  const sch = db.prepare('SELECT course_id FROM schedules WHERE id = ?').get(scheduleId);
  const course = sch && sch.course_id
    ? db.prepare('SELECT consume_classes FROM courses WHERE id = ?').get(sch.course_id)
    : null;
  const n = Number(course && course.consume_classes);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/**
 * 为一次扣课挑选「该扣哪张次数卡」。
 *
 * 背景：扣课选卡此前只 `ORDER BY expires_at ASC LIMIT 1`，完全不看卡种与课程的匹配
 * 关系 —— 卡种上的 `course_scope`（卡适用课程范围）成了死字段，于是「1v1 私教次卡」
 * 会被团课消耗，机构无法按课程隔离课时包。
 *
 * 课程范围判据（course_scope 目前是**自由文本**，库里实际值形如「全活动通用」「」）：
 *   · 为空 / 含「通用」/ 含「全部」        → 匹配任意课程；
 *   · 否则文本包含本场次的 course_id 或 course_name → 视为匹配。
 * 未来应把 course_scope 结构化为「课程 id 多选」，届时只需替换本函数里的
 * `scopeMatches` 判据，其余调用方无感。
 *
 * 排序：先「课程范围匹配」的卡，再按 expires_at ASC（优先扣即将过期的）。
 * 无卡可扣的两种情形区分处理：
 *   · 学员没有任何合格卡（余额/有效期不足）→ 返回 null（调用方维持「不扣课」原行为）；
 *   · 有合格卡但全部课程范围不匹配 → 返回 { scopeMismatch: true }，由调用方拒绝扣课并提示，
 *     绝不静默扣错卡（否则 1v1 私教卡会被团课消耗，造成营收错误）。
 *
 * @param {string} studentId
 * @param {string} scheduleId
 * @param {number} t 当前时间戳（毫秒）
 * @param {number} per 本次要扣的课时数（remaining_classes >= per 才合格）
 * @returns {object|null} member_cards 行（含 course_scope 便于调用方留痕）；
 *                        无合格卡时 null；有卡但范围不匹配时 { scopeMismatch: true }
 */
function pickCardForDeduction(studentId, scheduleId, t, per) {
  // LEFT JOIN 卡种取 course_scope：member_cards 上只有 card_type_id，范围策略存在卡种（membership_cards）。
  // mc.* 展开保证调用方拿到的仍是完整的 member_cards 行（order_id / card_type_name 等结转所需字段）。
  const cards = db.prepare(`
    SELECT mc.*, mct.course_scope AS course_scope, mct.scope_course_ids AS scope_course_ids
    FROM member_cards mc
    LEFT JOIN membership_cards mct ON mct.id = mc.card_type_id
    WHERE mc.student_id = ? AND mc.status = 'active' AND mc.billing_mode = 'count'
      AND mc.expires_at > ? AND mc.remaining_classes >= ?
    ORDER BY mc.expires_at ASC
  `).all(studentId, t, per);
  if (!cards.length) return null;

  const sch = db.prepare('SELECT course_id, course_name FROM schedules WHERE id = ?').get(scheduleId);
  const scopeMatches = (card) => {
    // 结构化范围优先：scope_course_ids 非空时按 course_id 精确匹配，
    // 不再依赖「中文名互相包含」的巧合（迁移 033）。
    const ids = String(card.scope_course_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length) return !!(sch && sch.course_id && ids.includes(String(sch.course_id)));
    const scope = String(card.course_scope || '').trim();
    if (!scope) return true;                                  // 空 = 不限
    if (scope.includes('通用') || scope.includes('全部')) return true; // 自由文本的「通用」约定
    if (sch && sch.course_id && scope.includes(sch.course_id)) return true;
    if (sch && sch.course_name) {
      const name = String(sch.course_name).trim();
      // 双向包含：范围串可能比课程名长（scope「1v1私教」 vs 课程名「1v1私教课」），
      // 单向 scope.includes(name) 会把这类合法场景误拒。反向包含兜住它，避免「防误扣」变成「误拒」。
      if (name && (scope.includes(name) || name.includes(scope))) return true;
    }
    return false;
  };

  const matched = cards.filter(scopeMatches);
  // 已按 expires_at ASC，matched[0] 即「匹配范围内最先到期的卡」
  if (matched.length) return matched[0];
  // 排期不存在（如手工扣课传入尚未落库的 scheduleId）：课程范围无从判定，沿用兜底不阻断，
  // 避免把「排期数据缺失」变成「静默不扣课」。
  if (!sch) return cards[0];
  // 有合格卡（余额/有效期都够）但全部课程范围不匹配 → 返回显式标记，由调用方拒绝扣课。
  // 不再区分「真实课程 / 临时活动」：此前为兼容临时活动保留了 `return cards[0]` 兜底，
  // 结果 course_temp 排期绕过范围隔离，1v1 私教卡（单价数倍于团课）被临时/团课静默消耗
  //（实测余次 10→9），属直接营收损失且不易察觉。若临时活动确需用某张限定卡，
  // 应调整卡种范围或改用「全活动通用」卡，而非让系统静默扣错卡。
  return { scopeMismatch: true };
}

module.exports = { resolveConsumeClasses, pickCardForDeduction };
