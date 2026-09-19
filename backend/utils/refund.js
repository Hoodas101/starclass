/**
 * 退费规则引擎 — 订单退款预览、订单退款、退卡退费共用同一套口径。
 * 抽自 routes/orders.js 的 computeRefundSuggestion（签名与返回结构原样保留），
 * 避免同一笔钱在 /api/orders/:id/refund 与 /api/membership/refund 两条路径算出两个金额。
 */
const db = require('../db');
// now 来自 utils/index；utils/index 不反向 require 本模块，无循环依赖
const { now } = require('../utils');

/**
 * 按退费规则计算建议退款金额（refund-preview 与 refund 共用，保证预览不是装饰）
 *
 * @param {object} order 订单行（需含 id / payable_amount / refunded_amount）
 * @param {object} [opts]
 * @param {string} [opts.cardId] 指定本次要退的那张会员卡。退卡场景必须传：
 *   默认按 `order_id` 取「最新一张卡」，多卡订单下会取到别的卡、按其消耗状态定价。
 * @returns {{started, mode, amount, reason, cardInfo, remain, needApproval, processDays, refundFactor, cardId, rules}}
 *   amount       = round(remain × refundFactor)，即「整单剩余可退额 × 规则比例」
 *   refundFactor = 规则比例因子 ∈ [0,1]。调用方若只需「规则怎么打折」而不关心整单金额
 *                  （例如退卡只退本卡份额），应直接用该因子乘自己的基数，
 *                  不要用 amount / remain 反推 —— remain 较小时四舍五入会引入精度损失。
 */
function computeRefundSuggestion(order, opts = {}) {
  const paid = Number(order.payable_amount) || 0;
  const refundedSoFar = Number(order.refunded_amount) || 0;
  const remain = Math.max(0, paid - refundedSoFar);

  // 读取退费规则
  let rules = {};
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'refund_rules'").get();
    rules = row ? JSON.parse(row.value) : {};
  } catch (e) { rules = {}; }
  const beforeStart = rules.beforeStart || 'full';
  const beforeStartPercent = Number(rules.beforeStartPercent) || 0;
  const afterStart = rules.afterStart || 'unused';
  const afterStartPercent = Number(rules.afterStartPercent) || 0;
  const needApproval = rules.needApproval !== false;
  const processDays = Number(rules.processDays) || 7;

  // 关联会员卡
  const card = opts.cardId
    ? db.prepare('SELECT * FROM member_cards WHERE id = ?').get(opts.cardId)
    : db.prepare('SELECT * FROM member_cards WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.id);
  const currentTime = now();
  let started = false;
  let unusedRatio = 1;
  let cardInfo = null;
  if (card) {
    // 「是否已开课」的判据修正（此前 beforeStart 规则是死代码）：
    // 会员卡在**支付瞬间**就写 activated_at（grantOrderBenefits），旧实现用
    // `activated_at <= now` 判定 started，于是任何已付款的卡单一律 started=true，
    // 「开课前全额退」这条规则永远走不到；当日购卡当日退会被按 afterStart
    // （默认扣 20% 手续费）少退。现改为按**实际消耗**判定。
    const activated = !!(card.activated_at && card.activated_at <= currentTime);
    const total = Number(card.total_classes) || 0;
    const remaining = Number(card.remaining_classes) || 0;
    if (card.billing_mode === 'count') {
      const used = Number(card.used_classes) || 0;
      unusedRatio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 1;
      cardInfo = { mode: 'count', total, remaining, used };
      // 次数卡：只有真正消耗过课时才算已开课。used_classes > 0 为主判据；
      // remaining < total 作为兜底（历史脏数据可能只改了余量没记 used）。
      started = used > 0 || (total > 0 && remaining < total);
    } else {
      // 时效制：扣除暂停时长
      let activeMs = currentTime - (card.activated_at || currentTime);
      if (card.paused_at) activeMs -= (currentTime - card.paused_at);
      else if (card.pause_total_ms) activeMs -= (card.pause_total_ms);
      const totalMs = (Number(card.expires_at) || currentTime) - (card.activated_at || currentTime);
      unusedRatio = totalMs > 0 ? Math.max(0, Math.min(1, (totalMs - Math.max(0, activeMs)) / totalMs)) : 1;
      cardInfo = { mode: 'time', activatedAt: card.activated_at, expiresAt: card.expires_at, unusedRatio: Math.round(unusedRatio * 100) };
      // 时效卡没有「课时」概念，以有效期是否被真正消耗判定。判据与卡片信息里展示的
      // unusedRatio 同精度（四舍五入到 1%）：仍显示 100% 未使用 → 视为尚未开课，
      // 使「当日购卡当日退」走到 beforeStart 全额退；只要消耗了 ≥1% 即视为已开课，
      // 避免中途退卡被误判成开课前而**全额**退（那是更严重的多退）。
      started = activated && Math.round((1 - unusedRatio) * 100) > 0;
    }
  }

  let mode = 'full';
  let reason = '';
  // 规则比例因子：amount 恒等于 round(remain × refundFactor)，两者不会漂移
  let refundFactor = 1;
  if (!started) {
    if (beforeStart === 'percent') {
      mode = 'ratio';
      refundFactor = 1 - beforeStartPercent / 100;
      reason = `开课前退费，按规则扣除 ${beforeStartPercent}% 手续费`;
    } else {
      mode = 'full';
      refundFactor = 1;
      reason = '开课前退费，按规则全额退款';
    }
  } else if (afterStart === 'percent') {
    mode = 'ratio';
    refundFactor = 1 - afterStartPercent / 100;
    reason = `开课后退费，按规则扣除 ${afterStartPercent}% 手续费`;
  } else {
    // unused：退还未消耗部分
    mode = 'custom';
    refundFactor = unusedRatio;
    reason = card
      ? (card.billing_mode === 'count'
          ? `开课后退费，按未上课时 ${cardInfo.remaining}/${cardInfo.total} 退还`
          : `开课后退费，按剩余有效期 ${cardInfo.unusedRatio}% 退还`)
      : '开课后退费，按未消耗部分退还';
  }
  refundFactor = Math.max(0, Math.min(1, refundFactor));
  const amount = Math.round(remain * refundFactor);

  return { started, mode, amount, reason, cardInfo, remain, needApproval, processDays, refundFactor,
    cardId: card ? card.id : null,
    rules: { beforeStart, beforeStartPercent, afterStart, afterStartPercent } };
}

module.exports = { computeRefundSuggestion };
