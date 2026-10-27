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
// formatDate 来自 utils/index：全站日期字符串口径必须同源（不要再写一份 padStart）
const { formatDate } = require('../utils');

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


// ============================================
// 订阅卡：顺延与周期锚定（P1 / P2）
//
// 一条铁律：卡种定义 → 发卡时**快照到卡实例** → 运行时只读卡实例。
// 否则机构改一次卡种配置，所有已售卡会集体变形，退款金额随之变动 —— 已收的钱
// 不能因为后台改了配置而变。这与既有 visit_limit_* 的处理方式同源。
// ============================================

const DAY_MS = 86400000;

/** 某时刻所在自然日的 00:00（本地时区，与 formatDate 口径一致） */
function dayStartMs(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addDaysMs(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** 次日的 00:00（半开区间上界：activated_at < 它 即「今天及以前已生效」） */
function dayEndExclusive(ms) {
  return addDaysMs(dayStartMs(ms), 1);
}

/**
 * 卡当前是否可用。
 *
 * 顺延卡在发卡瞬间就写 activated_at（可能是未来），status 仍是 active ——
 * 用 status 判「可用」会把排到 30 天后的卡当成今天就能上课。
 *
 * 按**自然日**比较而非精确时刻：排期时刻是「当天 12:00」这类锚点，
 * 用精确比较会把「当天 20:00 开卡、当天上课」的学员误判成尚未生效。
 *
 * @param {object} card member_cards 行
 * @param {number} t 参考时刻
 */
function isCardUsable(card, t) {
  if (!card || card.status !== 'active') return false;
  // P1-37：到期也必须校验。status 靠定时扫描刷新（最长 24h 一次），
  // 期间存在「已过期但 status 仍 active」的窗口，只信 status 会让过期卡继续上课、继续扣课。
  // 次卡的 expires_at 是 2100-01-01 哨兵值，不会误杀。
  const exp = Number(card.expires_at) || 0;
  if (exp > 0 && exp < t) return false;
  const act = Number(card.activated_at) || 0;
  // 历史数据可能没有 activated_at：视为已生效，不误伤存量卡
  if (!act) return true;
  return act < dayEndExclusive(t);
}

/**
 * SQL 片段：可用卡。调用方需为 `?` 绑定 dayEndExclusive(t)。
 * @param {string} alias 表别名
 */
function usableCardSql(alias = 'mc') {
  return `(${alias}.status = 'active' AND (COALESCE(${alias}.activated_at, 0) = 0 OR ${alias}.activated_at < ?))`;
}

/**
 * 找顺延基准卡：该学员**最晚到期**的在途卡。
 *
 * 必须把「已发未生效」的顺延卡也算作在途 —— 连买两张时，第二张若找不到第一张，
 * 两张都会从旧卡到期日起算，时间区间完全重叠、额度翻倍（资损级）。
 *
 * @param {string} studentId
 * @param {object} [opts]
 * @param {string} [opts.courseScope] 新卡的科目范围；与基准卡不同则默认不排队
 * @param {boolean} [opts.crossScope] 是否允许跨科目排队
 * @param {string} [opts.excludeCardId] 排除自身（提前激活重算时用）
 * @returns {object|null} 基准卡行（含 type_scope）
 */
function findDeferralBase(studentId, opts = {}) {
  const t = Number(opts.t) || Date.now();
  // 十年上限：次卡的 valid_days=0 会被写成 expires_at=2100-01-01（4102444800000）这种
  // 「永久」哨兵值。若不设上限，买过次卡的学员再购年卡时，顺延基准会选中这张 2100 年卡，
  // 新卡 activated_at 被排到 2100-01-02 —— 学员付了钱却在上课前就被判「未生效」，
  // 既不扣课也不报错，权益被全额冻结（资损且极难排查）。
  const horizon = t + 3650 * 24 * 3600 * 1000;
  const rows = db.prepare(`
    SELECT mc.*, COALESCE(ct.course_scope, '') AS type_scope
      FROM member_cards mc
      LEFT JOIN membership_cards ct ON ct.id = mc.card_type_id
     WHERE mc.student_id = ?
       AND mc.status IN ('active', 'paused')
       -- 次卡没有「期限」概念：budget 用完即止，不该成为时效卡的顺延基准
       AND COALESCE(mc.billing_mode, 'time') <> 'count'
       AND (mc.expires_at IS NULL OR mc.expires_at > ?)
       -- 排除 2100-01-01 一类哨兵到期日（合法年卡不会超过十年）
       AND COALESCE(mc.expires_at, 0) <= ?
       AND (? = '' OR mc.id != ?)
     ORDER BY COALESCE(mc.expires_at, 0) DESC, mc.created_at DESC
  `).all(studentId, t, horizon, opts.excludeCardId || '', opts.excludeCardId || '');

  if (!rows.length) return null;
  if (opts.crossScope) return rows[0];

  const scope = String(opts.courseScope || '');
  // 同科目才排队；找不到同科目卡 → 不排队（各算各的）
  return rows.find((r) => String(r.type_scope || '') === scope) || null;
}

/**
 * 顺延起点：基准卡到期之后。
 * @param {object} baseCard 基准卡
 * @param {string} anchor 'day'（次日 00:00，默认）| 'exact'（到期 + 1ms）
 * @param {number} [nowMs]
 * @returns {number} 新卡 activated_at
 */
function deferralStartFrom(baseCard, anchor = 'day', nowMs = Date.now()) {
  const baseExpiry = Math.max(Number(baseCard && baseCard.expires_at) || 0, nowMs);
  if (anchor === 'exact') return baseExpiry + 1;
  // day：到期日次日 00:00（与「明天起生效」的直觉一致，家长好解释）
  return dayEndExclusive(baseExpiry);
}

/**
 * 按卡实例的锚点计算当前周期区间（P2）。
 *
 * natural：保留存量口径（自然周周一为起点 / 自然月），由调用方沿用旧逻辑。
 * activated / first_use：固定长度切段，**不按自然月** —— 自然月有 28/31 天不均等，
 * 与「有效期 30 天」的合同表述对不上。
 *
 * @returns {null|{anchor, unlimited, week, month}}
 *   null      → 调用方走 natural 旧逻辑
 *   unlimited → first_use 且从未使用：不设限（没消费就不该受限）
 */
function periodBoundsForCard(card, t) {
  const anchor = String((card && card.period_anchor) || 'natural');
  if (anchor === 'natural') return null;

  const startBase = anchor === 'first_use'
    ? Number(card.first_used_at) || 0
    : Number(card.activated_at) || 0;
  if (!startBase) {
    // first_use 且从未签到：不限次；activated 缺值同样不限（不误伤存量脏数据）
    return { anchor, unlimited: true, week: null, month: null };
  }

  const start = dayStartMs(startBase);
  const expires = Number(card.expires_at) || 0;
  const weekDays = Math.max(1, Number(card.cycle_days_week) || 7);
  const monthDays = Math.max(1, Number(card.cycle_days_month) || 30);

  return {
    anchor,
    unlimited: false,
    week: segmentOf(start, t, weekDays, expires),
    month: segmentOf(start, t, monthDays, expires),
  };
}

/**
 * 当前所在的第 k 段，以及该段的「有效天数」。
 * 末段可能被卡到期截断，调用方按 effectiveCycleLimit 折算上限。
 */
function segmentOf(startMs, t, cycleDays, expiresMs) {
  const tStart = dayStartMs(t);
  const diffDays = Math.round((tStart - startMs) / DAY_MS);
  const k = Math.max(0, Math.floor(diffDays / cycleDays));
  const segStart = addDaysMs(startMs, k * cycleDays);
  let segEnd = addDaysMs(segStart, cycleDays);
  // 卡在本段内到期 → 本段实际可用天数被截断
  if (expiresMs > 0 && expiresMs < segEnd) {
    segEnd = dayEndExclusive(expiresMs);
  }
  const days = Math.max(1, Math.round((segEnd - segStart) / DAY_MS));
  return {
    index: k,
    start: segStart,
    end: segEnd,
    cycleDays,
    days,
    // 起止日期字符串（与 attendances.date 同格式，直接用于 SQL 区间）
    startDate: formatDate(segStart),
    endDate: formatDate(addDaysMs(segEnd, -1)),
  };
}

/**
 * 段内实际上限：整段用原上限，末段按天数等比折算（向上取整）。
 * 例：月限 8 次、本段只剩 12 天 → ceil(8 × 12 / 30) = 4。
 */
function effectiveCycleLimit(baseLimit, seg) {
  const limit = Number(baseLimit) || 0;
  if (!limit || !seg) return limit;
  if (!seg.days || seg.days >= seg.cycleDays) return limit;
  return Math.max(1, Math.ceil((limit * seg.days) / seg.cycleDays));
}

module.exports = {
  expireOverdueCards,
  DAY_MS,
  dayStartMs,
  dayEndExclusive,
  isCardUsable,
  usableCardSql,
  findDeferralBase,
  deferralStartFrom,
  periodBoundsForCard,
  effectiveCycleLimit,
};
