/**
 * 退费规则引擎 — 订单退款预览、订单退款、退卡退费共用同一套口径。
 * 抽自 routes/orders.js 的 computeRefundSuggestion（签名与返回结构原样保留），
 * 避免同一笔钱在 /api/orders/:id/refund 与 /api/membership/refund 两条路径算出两个金额。
 */
const db = require('../db');
// now 来自 utils/index；utils/index 不反向 require 本模块，无循环依赖
const { now } = require('../utils');
const { evaluateRefund } = require('./formula');
const { getCardRules } = require('./card-rules');

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

  // ── 退费口径：三档优先级，且必须互斥，避免两套配置各自为政 ──
  //   1) 卡种上显式填了公式 / 全局切到 formula → 高级表达式
  //   2) 卡规则中心「简易」里真的填了数字 → 基数 × (1 − 手续费%) − 最低手续费
  //   3) 都没配 → 沿用「退费规则」页 beforeStart / afterStart（存量口径，默认值即此路）
  // 第 3 档存在的理由：简易模式的默认值（unused + 0% + ¥0）与旧口径在金额上等价，
  // 却会丢掉 beforeStart=full / afterStart=percent 的百分比语义 —— 若让它无条件接管，
  // 机构只在「退费规则」页配的 30% 手续费就静默失效（少退钱，直接客诉）。
  // 故简易模式按「显式配置才生效」处理，并在返回值里带 ruleSource 便于排查。
  let amount = Math.round(remain * refundFactor);
  let formulaInfo = null;
  let calcInfo = null;
  let ruleSource = 'refund_rules';
  let rcfg = {};
  try {
    const cfg = getCardRules();
    rcfg = (cfg && cfg.refund) || {};
  } catch (e) {
    rcfg = {};
  }

  const simplePct = Math.max(0, Math.min(100, Number(rcfg.deductPercent) || 0));
  const simpleMinFee = Math.max(0, Number(rcfg.minFee) || 0);
  const simpleConfigured = simplePct > 0 || simpleMinFee > 0 || rcfg.base === 'remain';

  // 卡种级公式优先于全局开关：管理员在卡种上填了公式就是显式意图，
  // 不该因为全局还停在 mode='simple' 而让该卡种的公式变成死配置。
  let cardTypeFormula = '';
  try {
    const ct = card
      ? db.prepare('SELECT refund_formula FROM membership_cards WHERE id = ?').get(card.card_type_id)
      : null;
    cardTypeFormula = String((ct && ct.refund_formula) || '').trim();
  } catch (e) {
    cardTypeFormula = '';
  }
  const formulaSrc = cardTypeFormula
    || (rcfg.mode === 'formula' ? String(rcfg.formula || '').trim() : '');

  if (formulaSrc) {
    ruleSource = cardTypeFormula ? 'card_type_formula' : 'card_rules_formula';
    {
    const DAY = 86400000;
    const act = Number(card && card.activated_at) || 0;
    const exp = Number(card && card.expires_at) || 0;
    const totalDays = act && exp > act ? Math.max(1, Math.round((exp - act) / DAY)) : 0;
    const usedDays = card ? Math.min(totalDays, Math.max(0, Math.round((currentTime - act) / DAY))) : 0;
    const vars = {
      paid,
      refunded: refundedSoFar,
      remain,
      total_days: totalDays,
      used_days: usedDays,
      remain_days: Math.max(0, totalDays - usedDays),
      paused_days: card && card.pause_total_ms ? Math.round(Number(card.pause_total_ms) / DAY) : 0,
      total_classes: Number(card && card.total_classes) || 0,
      used_classes: Number(card && card.used_classes) || 0,
      remain_classes: Number(card && card.remaining_classes) || 0,
      fee_rate: Math.max(0, Math.min(1, 1 - refundFactor)),
    };
    const r = evaluateRefund(formulaSrc, vars);
    if (r.ok) {
      // 公式可任意书写，必须夹取到 [0, 整单可退额]：否则一个写错的表达式就能退超净收。
      amount = Math.max(0, Math.min(remain, Math.round(Number(r.amount) || 0)));
      // 因子同步回写：退卡路径按「本卡份额 × 因子」算，两者不能漂移
      refundFactor = remain > 0 ? amount / remain : 0;
      formulaInfo = { formula: formulaSrc, vars, raw: r.raw, amount };
    } else {
      // 公式坏了不能把退款算成 0 —— 回落既有规则，并留痕便于排查
      console.warn('[refund] 退费公式求值失败，回落默认规则:', r.error, '|', formulaSrc);
    }
    }
  } else if (simpleConfigured) {
    // 简易模式：基数 × (1 − 手续费%) − 最低手续费（全数字配置，不写表达式）
    ruleSource = 'card_rules_simple';
    const baseKind = rcfg.base === 'remain' ? 'remain' : 'unused';
    const baseVal = baseKind === 'remain' ? remain : remain * unusedRatio;
    const pct = simplePct;
    const minFee = simpleMinFee;
    let amt = Math.round(baseVal * (1 - pct / 100));
    if (minFee > 0) amt = Math.min(amt, Math.max(0, Math.round(baseVal - minFee)));
    amt = Math.max(0, Math.min(remain, amt));
    amount = amt;
    refundFactor = remain > 0 ? amount / remain : 0;
    mode = amount >= remain ? 'full' : 'custom';
    const ratioText = Math.round(unusedRatio * 100);
    reason = `退费规则：基数 ¥${Math.round(baseVal)}`
      + (baseKind === 'remain' ? '（整单剩余额）' : `（未消耗 ${ratioText}%）`)
      + (pct ? ` × (1 − ${pct}%)` : '')
      + (minFee ? ` − 最低手续费 ¥${minFee}` : '')
      + ` = ¥${amount}`;
    calcInfo = { baseKind, base: Math.round(baseVal), deductPercent: pct, minFee, unusedRatio: ratioText };
    // P1-36：base='remain' 是显式选择（保留管理者的操作空间），但必须让人知道代价 ——
    // 已消耗的部分也会被计算进退款基数，只适用于「整单未开课」的补退场景。
    if (baseKind === 'remain' && ratioText < 100) {
      calcInfo.warn = `已消耗 ${100 - ratioText}% 仍按整单剩余额计算，仅适用于整单未开课场景`;
      reason += `｜注意：${calcInfo.warn}`;
    }
  }

  // ── P0-5：多卡订单必须按卡分别定价 ──
  // 旧实现只取「最新一张卡」的消耗状态给**整单**定价：订单含卡A（已用 20/24）与卡B（未用）时，
  // 取到卡B → unusedRatio=1 → 整单全额退 ¥6000，而正确值是卡A 500 + 卡B 3000 = ¥3500。
  // 现改为：未显式指定 cardId 且订单下有多张卡时，按卡种标价占比拆分整单可退额，
  // 逐卡套用各自规则因子后求和，并夹取到 [0, remain]。
  if (!opts.cardId) {
    try {
      const rows = db.prepare(`
        SELECT c.id, COALESCE(t.price, 0) AS price
        FROM member_cards c LEFT JOIN membership_cards t ON t.id = c.card_type_id
        WHERE c.order_id = ? ORDER BY c.created_at ASC
      `).all(order.id);
      if (rows.length > 1) {
        const posSum = rows.reduce((s, r) => s + Math.max(0, Number(r.price) || 0), 0);
        let sum = 0;
        const parts = [];
        rows.forEach((r) => {
          // 标价全为 0（赠卡单）时退化为均分，避免除零后每张卡都算 0 元
          const w = posSum > 0 ? Math.max(0, Number(r.price) || 0) / posSum : 1 / rows.length;
          const sub = computeRefundSuggestion(order, { cardId: r.id });
          const part = Math.round(remain * w * sub.refundFactor);
          sum += part;
          parts.push({
            cardId: r.id,
            weight: Math.round(w * 1000) / 10,
            factor: Math.round(sub.refundFactor * 1000) / 1000,
            amount: part,
          });
        });
        amount = Math.max(0, Math.min(remain, sum));
        refundFactor = remain > 0 ? amount / remain : 0;
        mode = amount >= remain ? 'full' : 'custom';
        reason = `按 ${rows.length} 张卡分别计算后合计 ¥${amount}`
          + `（${parts.map((p) => `¥${p.amount}`).join(' + ')}）`;
        calcInfo = { multiCard: parts, total: amount };
        ruleSource = 'multi_card';
      }
    } catch (e) {
      // 明细拆分失败不能把退款算错：回落到单卡口径，并留痕便于排查
      console.warn('[refund] 多卡分别定价失败，回落单卡口径:', e && e.message);
    }
  }

  return { started, mode, amount, reason, cardInfo, remain, needApproval, processDays, refundFactor,
    // 公式明细：预览页要展示「怎么算出来的」，不能只给一个数字
    formula: formulaInfo,
    // 简易模式明细：同样要能解释「怎么算出来的」
    calc: calcInfo,
    // 本次实际生效的口径：refund_rules | card_rules_simple | card_rules_formula |
    // card_type_formula | multi_card。设置页两处配置冲突时，以这里为准排查。
    ruleSource,
    cardId: card ? card.id : null,
    rules: { beforeStart, beforeStartPercent, afterStart, afterStartPercent } };
}

module.exports = { computeRefundSuggestion };
