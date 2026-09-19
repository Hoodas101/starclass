/**
 * 考勤回滚共享原语 —— 签到回滚与「取消排期」回滚的**单一实现来源**。
 *
 * 背景：取消排期（routes/schedules.js 的 PUT /:id cancelled 分支与 DELETE /:id）
 * 此前只改 schedules.status / enrollments.status，完全不碰考勤、扣课流水、积分与
 * 收入结转 —— 已签到学员的课时被白扣、积分被白送、出勤率虚高、收入仍挂账，
 * 而教练课时费却已按 schedules.status 剔除，四处统计互相矛盾。
 *
 * 修复方式不是另写一套回滚，而是把 routes/checkin.js 里既有的回滚逻辑抽到这里，
 * 由签到回滚与取消排期**共用同一份代码**，避免两条路径各写一份、日久漂移。
 * 本模块所有函数都**不自开事务** —— 必须由调用方置于事务内（内层再开事务会与外层
 * immediate 事务嵌套报错）。
 */
'use strict';

const db = require('../db');
const { generateId, recordAudit, now } = require('../utils');
// 「一次课消耗几个课时」的唯一口径实现（与签到扣课 / 手工扣课共用）
const { resolveConsumeClasses } = require('./deduction');

/**
 * 反向扣回积分：用于签到状态由「已签到/迟到」改为「非签到」时回滚已发放积分。
 * 仅做减法：扣减 balance 与 total_earned，并写一条负 amount 的 point_logs。
 * reference_id 复用原签到值（scheduleId），便于去重与审计追溯。
 */
function reversePoints(studentId, amount, referenceId, description) {
  if (!(amount > 0)) return;
  const acc = db.prepare('SELECT * FROM points WHERE student_id = ?').get(studentId);
  if (!acc) return; // 账户不存在则无需回滚
  // 与「清除签到回滚」同一口径：流水只记实际生效的扣减量。
  // 余额只有 3 却要回滚 10 时，实扣 3 就必须记 -3；记 -10 会让
  // SUM(point_logs.amount) 与 points.balance 永久相差 7 且无自愈。
  // 业务语义不变：余额不足时仍是「扣到 0 为止、不报失败」。
  const actual = Math.min(amount, acc.balance || 0);
  const newBal = (acc.balance || 0) - actual; // actual ≤ balance，结果自然 ≥ 0
  // total_earned 同按实际生效量扣；MAX(0, …) 仅防御历史脏数据
  // （正常情况下 total_earned ≥ balance ≥ actual，不会触发截断）。
  db.prepare(`
    UPDATE points SET total_earned = MAX(0, total_earned - ?), balance = ?, updated_at = ?
    WHERE student_id = ?
  `).run(actual, newBal, now(), studentId);
  db.prepare(`
    INSERT INTO point_logs (id, student_id, type, amount, balance, reference_id, reason, description, created_at)
    VALUES (?, ?, 'checkin', ?, ?, ?, ?, ?, ?)
  `).run(generateId('plog_'), studentId, -actual, newBal, referenceId, description, description, now());
}

/**
 * revenue_recognitions 表是否存在（迁移 017 未执行时为 false）。
 * 新增的是旁路台账：老库尚未迁移时只跳过结转，绝不让既有签到流程报错。
 * 不做结果缓存 —— 建表后无需重启即生效，且这是一次极廉价的 sqlite_master 点查
 * （只在「扣课成功」这一低频分支上发生）。
 */
function hasRevenueRecognitionTable() {
  try {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revenue_recognitions'"
    ).get();
  } catch (e) {
    return false;
  }
}

/**
 * 冲销某排期+学员的结转记录（课时回滚时调用：清除签到、签到改为缺席/请假、取消排期）。
 * DELETE 天然幂等，重复调用安全。表不存在时静默跳过。
 */
function revertRevenueRecognition(scheduleId, studentId) {
  if (!hasRevenueRecognitionTable()) return;
  db.prepare('DELETE FROM revenue_recognitions WHERE schedule_id = ? AND student_id = ?')
    .run(scheduleId, studentId);
}

/**
 * 回滚次数卡扣课（若已扣）：把 member_cards 的课时退回，并删除 deduction_logs 行。
 *
 * 回滚量以扣课时记下的真实扣减量为准（迁移 019 的 deduction_logs.count）。
 * 旧实现在回滚那一刻按 resolveConsumeClasses(scheduleId) 重新推导，
 * 与当初真实扣减量不符时（手动按 classes=N 扣课、或扣课后课程配置被改），
 * 每次「签到 → 改缺席/清除」都会让卡内课时凭空增减。
 * 迁移前的历史行 count 为 NULL，回退到旧的推导方式，行为与改动前一致。
 *
 * @param {{scheduleId:string, studentId:string, t?:number}} p
 * @returns {number} 实际退回的课时数（无扣课记录时为 0）
 */
function revertDeduction({ scheduleId, studentId, t }) {
  const ded = db.prepare(
    'SELECT * FROM deduction_logs WHERE schedule_id = ? AND student_id = ?'
  ).get(scheduleId, studentId);
  if (!ded) return 0;
  const back = ded.count != null ? ded.count : resolveConsumeClasses(scheduleId);
  db.prepare(`
    UPDATE member_cards SET remaining_classes = remaining_classes + ?,
      used_classes = MAX(0, used_classes - ?), updated_at = ?
    WHERE id = ?
  `).run(back, back, t || now(), ded.card_id);
  db.prepare('DELETE FROM deduction_logs WHERE id = ?').run(ded.id);
  return back;
}

/**
 * 取消排期专用：回滚该排期下所有考勤行带来的课时 / 积分 / 收入结转副作用。
 *
 * 口径（与签到回滚保持一致，但按考勤行状态区分处理）：
 *   · present / late —— 真实消过课：回滚积分（若 points_earned > 0）、回退课时、
 *     冲销收入结转，然后删除考勤行；
 *   · absent —— 未扣课时、未发积分，仅删除考勤行（活动都取消了，缺席不再成立）；
 *   · leave —— **保留不动**：请假是独立业务，leave_deduction_logs 里已扣的请假
 *     课时不因活动取消而退还，删除考勤行会破坏请假审批的凭据。
 *
 * 必须由调用方置于事务内。
 *
 * @param {{scheduleId:string, actorId:string, actorRole:string, reason:string}} p
 * @returns {{reverted:number, revertedClasses:number, revertedPoints:number}}
 */
function revertScheduleAttendances({ scheduleId, actorId, actorRole, reason }) {
  const rows = db.prepare('SELECT * FROM attendances WHERE schedule_id = ?').all(scheduleId);
  const t = now();
  const desc = reason || '活动取消，回滚已签到学员的课时与积分';
  let reverted = 0;
  let revertedClasses = 0;
  let revertedPoints = 0;

  for (const a of rows) {
    const status = a.status;
    if (status === 'leave') continue; // 请假独立业务，保留考勤行
    const beforeAtt = { status, points_earned: a.points_earned || 0 };

    if (status === 'present' || status === 'late') {
      if ((a.points_earned || 0) > 0) {
        reversePoints(a.student_id, a.points_earned, scheduleId, desc);
        revertedPoints += a.points_earned;
      }
      revertedClasses += revertDeduction({ scheduleId, studentId: a.student_id, t });
      // 课时已退回卡内 → 对应已结转的收入必须同步冲销，否则合同负债被低估
      revertRevenueRecognition(scheduleId, a.student_id);
    }

    db.prepare('DELETE FROM attendances WHERE id = ?').run(a.id);
    reverted++;
    recordAudit(db, {
      entity: 'attendance',
      entityId: `${scheduleId}:${a.student_id}`,
      action: 'schedule_cancel_revert',
      actorId,
      actorRole,
      before: beforeAtt,
      after: null,
    });
  }

  return { reverted, revertedClasses, revertedPoints };
}

module.exports = {
  reversePoints,
  hasRevenueRecognitionTable,
  revertRevenueRecognition,
  revertDeduction,
  revertScheduleAttendances,
};
