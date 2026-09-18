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

module.exports = { resolveConsumeClasses };
