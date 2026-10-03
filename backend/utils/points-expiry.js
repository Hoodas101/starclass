'use strict';

/**
 * D1 积分滚动过期工具
 *
 * 规则：获赠积分约 24 个月（730 天）后到期。到期不自动消失，而是由日调度
 * sweep 将到期未处理的「获得流水」按金额从余额扣减并标记 expired —— 这样
 * 余额与 point_logs 永远自洽，也不会出现「凭空消失」或「负数余额」。
 *
 * 设计要点：
 *   · 到期粒度落在 point_logs（每笔获得），而非 points 聚合；不同批次到期日不同。
 *   · sweep 幂等：expired=1 后不再处理，重复调度与多实例并存均安全。
 *   · 扣减按 min(当前余额, 流水金额) 钳制，余额不会变负；对应的总消耗同步累加，
 *     保持 total_earned - total_consumed = balance 的恒等式。
 */

const POINT_EXPIRY_DAYS = 730; // ≈ 24 个月
const POINT_EXPIRY_MS = POINT_EXPIRY_DAYS * 24 * 3600 * 1000;

function computeExpiry(ts) {
  return (ts || Date.now()) + POINT_EXPIRY_MS;
}

/**
 * 回收到期积分。返回本次实际扣减的总积分（供日志）。
 * @param {import('better-sqlite3').Database} db
 * @param {number} nowTs 当前毫秒戳
 */
function expirePoints(db, nowTs) {
  const logs = db.prepare(
    "SELECT id, student_id, amount FROM point_logs WHERE expired = 0 AND expire_at IS NOT NULL AND expire_at <= ?"
  ).all(nowTs);

  let expiredTotal = 0;
  const tx = db.transaction(() => {
    for (const log of logs) {
      const p = db.prepare('SELECT id, balance, total_consumed FROM points WHERE student_id = ?').get(log.student_id);
      const deduct = p ? Math.max(0, Math.min(p.balance, log.amount)) : 0;
      if (p && deduct > 0) {
        db.prepare('UPDATE points SET balance = balance - ?, total_consumed = total_consumed + ?, updated_at = ? WHERE student_id = ?')
          .run(deduct, deduct, nowTs, log.student_id);
      }
      db.prepare('UPDATE point_logs SET expired = 1 WHERE id = ?').run(log.id);
      expiredTotal += deduct;
    }
  });
  tx();
  return expiredTotal;
}

module.exports = { POINT_EXPIRY_DAYS, POINT_EXPIRY_MS, computeExpiry, expirePoints };
