/**
 * 会员卡生命周期收口 —— 过期状态流转。
 *
 * 背景：`member_cards.status` 的语义是「该卡当前是否有效」，但改动前全库只有
 * routes/leave.js 一处会写 'expired'（请假把到期日推过当前时刻时）。结果是已过期的卡
 * 长期停留在 'active'，于是所有**只按 `status = 'active'` 过滤**的查询都会把过期卡
 * 当成有效卡：学员会员状态（students.js）、低课时续费提醒（reminders.js）、
 * 订单取消时回收卡（orders.js）、线索续费建议（lead-suggestions.js）。
 *
 * 本模块把「已过期」这一**派生状态**定期物化到 status 上，让 status 与 expires_at
 * 两个口径重新一致。
 *
 * 边界说明（避免误伤）：
 *   - 只流转 `status = 'active'`。`paused`（请假暂停）与 `refunded` / `cancelled`
 *     是人工或业务主动置入的状态，不由时间推进决定，故不参与。
 *   - `expires_at IS NULL` 的卡不参与：判据 `NULL <= now` 在 SQL 三值逻辑下不为真，
 *     故天然排除；显式写出以免读者误以为遗漏。
 *   - 次数卡 expires_at 由 calcCardExpiresAt 置为 2100-01-01，不会被扫到。
 *   - 任何本来就按 `expires_at > now` 判断的地方（checkin.js 扣课、students.js 筛选、
 *     admin.js KPI、membership.js `/expiring`、utils/renewal.js 续费窗口）判断结果不变 ——
 *     本改动只修正那些依赖 status 的地方。
 *
 * 幂等：重复执行不会产生额外变更（第二次的 WHERE 已无匹配行），
 * 因此即使多实例同时运行或与任务队列并存也不会重复处理。
 */
const db = require('../db');

/**
 * 把已过期的有效卡置为 'expired'。
 * @param {number} nowMs - 当前时间戳（毫秒），便于测试控制
 * @returns {{ expired: number }} 本次流转的卡数
 */
function expireOverdueCards(nowMs = Date.now()) {
  const result = db.prepare(`
    UPDATE member_cards
    SET status = 'expired', updated_at = ?
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
  `).run(nowMs, nowMs);
  return { expired: result.changes };
}

module.exports = { expireOverdueCards };
