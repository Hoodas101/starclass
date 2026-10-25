/**
 * 订阅卡功能线回归（离线，隔离库）—— 对应设计提案 §9 的 A/B/C 三组验收
 *
 *  A 组 顺延：接续起点、链式不重叠、未生效不可用、提前激活、未生效退款
 *  B 组 周期锚定：activated / first_use / natural 三态、末段折算
 *  C 组 退费公式：默认兼容、自定义求值、非法拒绝、预览明细
 *
 * 运行：node tests/subscription-card-regression.cjs
 */
process.env.DB_PATH = '/tmp/subcard_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/subcard_test.db', '/tmp/subcard_test.db-wal', '/tmp/subcard_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const ordersRouter = require('../routes/orders');
const membershipRouter = require('../routes/membership');
const { pickCardForDeduction } = require('../utils/deduction');
const { computeRefundSuggestion } = require('../utils/refund');
const {
  isCardUsable, findDeferralBase, deferralStartFrom, periodBoundsForCard, effectiveCycleLimit, dayEndExclusive,
} = require('../utils/card-lifecycle');
const { evaluateRefund, validateFormula } = require('../utils/formula');
const { getCardRules, mergeGroup } = require('../utils/card-rules');

function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route || layer.route.path !== path) continue;
    if (!layer.route.methods[method]) continue;
    const h = layer.route.stack;
    return h[h.length - 1].handle;
  }
  throw new Error(`未找到处理器: ${method.toUpperCase()} ${path}`);
}
const mockRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  r.setHeader = () => r;
  return r;
};
const mockReq = (o) => Object.assign({ headers: {}, params: {}, query: {}, body: {}, userRole: '', openid: '' }, o);

let pass = 0, fail = 0;
const rec = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
};

const t = now();
const DAY = 86400000;

// ── 夹具 ──
db.transaction(() => {
  db.prepare('INSERT INTO users (id, openid, phone, nickname, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('u_admin', 'admin_x', '13700000000', '管理员', 'admin', 'active', t, t);
  db.prepare('INSERT INTO students (id, name, gender, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('stu_1', '测试学员', '男', 'active', String(t), t, t);

  // 顺延时效卡：30 天，月限 8
  db.prepare(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price,
    course_scope, transferable, refundable, is_active, product_type, visit_limit_per_month, defer_enabled, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('ct_time', '月卡30天', 0, 30, 'time', 0, 599, '篮球', 1, 1, 1, 'membership', 8, 1, t);

  // 次数卡（用于扣课可用性验证）
  db.prepare(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price,
    course_scope, transferable, refundable, is_active, product_type, defer_enabled, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('ct_count', '24次卡', 24, 365, 'count', 0, 2880, '篮球', 1, 1, 1, 'membership', 1, t);

  db.prepare(`INSERT INTO courses (id, name, category, description, duration, consume_classes, color, is_active, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('c1', '篮球基础', '篮球', '', 60, 1, '#409EFF', 1, t);
  db.prepare(`INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time, status, enrolled_count, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('sch_1', 'c1', '篮球基础', 'coach', '教练', '2026-11-20', '09:00', '10:00', 'scheduled', 1, t, t);
})();

const createOrder = getHandler(ordersRouter, 'post', '/');
const buyCard = (cardTypeId, qty = 1) => {
  const r = mockRes();
  createOrder(mockReq({
    userRole: 'admin', openid: 'admin_x',
    body: { studentId: 'stu_1', orderType: 'membership', status: 'paid',
      items: [{ itemType: 'membershipCard', itemId: cardTypeId, itemName: 'x', quantity: qty, unitPrice: 599 }] },
  }), r);
  return r.body;
};
const cardsOf = (typeId) => db.prepare('SELECT * FROM member_cards WHERE card_type_id = ? ORDER BY activated_at ASC').all(typeId);

console.log('\n\x1b[1m=== 订阅卡功能线回归（A 顺延 / B 周期 / C 公式）===\x1b[0m\n');

// ===== A 组：顺延 =====
console.log('\x1b[1m[A] 顺延\x1b[0m');
{
  // A0 第一张卡：立即生效
  const r1 = buyCard('ct_time');
  const first = cardsOf('ct_time')[0];
  rec('A0 首张卡立即生效（activated_at ≈ 现在）', Math.abs(Number(first.activated_at) - t) < 5000,
    `activated=${first.activated_at} now=${t}`);

  // A1 第二张卡：接在第一张之后
  const r2 = buyCard('ct_time');
  const list2 = cardsOf('ct_time');
  const second = list2[1];
  const expect = dayEndExclusive(Number(first.expires_at));
  rec('A1 ★ 第二张卡排在旧卡到期次日 00:00', Math.abs(Number(second.activated_at) - expect) < 1000,
    `got=${new Date(Number(second.activated_at)).toISOString()} want=${new Date(expect).toISOString()}`);
  rec('A1b 记录了顺延谱系', second.deferred_from_card_id === first.id,
    `deferred_from=${second.deferred_from_card_id} base=${first.id}`);

  // A3 链式不重叠（连买第三张）
  buyCard('ct_time');
  const list3 = cardsOf('ct_time');
  let overlap = 0;
  for (let i = 1; i < list3.length; i++) {
    if (Number(list3[i].activated_at) <= Number(list3[i - 1].expires_at)) overlap++;
  }
  rec('A3 ★ 三张顺延卡时间区间无交集（防额度翻倍）', overlap === 0, `overlap=${overlap}`);

  // A4 未生效卡不可用
  const pending = list3[2];
  rec('A4 ★ 未生效卡 isCardUsable=false', isCardUsable(pending, t) === false, `activated=${pending.activated_at}`);
  rec('A4b 已生效卡 isCardUsable=true', isCardUsable(list3[0], t) === true, '');
}

// ===== A5 提前激活 =====
console.log('\n\x1b[1m[A5] 提前激活\x1b[0m');
{
  const list = cardsOf('ct_time');
  const pending = list[list.length - 1];
  const activateNow = getHandler(membershipRouter, 'post', '/card/:id/activate-now');
  const r = mockRes();
  activateNow(mockReq({ params: { id: pending.id }, userRole: 'admin', openid: 'admin_x' }), r);
  rec('A5 提前激活成功', r.body && r.body.code === 0, JSON.stringify(r.body).slice(0, 140));

  const after = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(pending.id);
  rec('A5b ★ 谱系已清空（防退款回滚拉回等待态）', String(after.deferred_from_card_id || '') === '',
    `deferred_from=${after.deferred_from_card_id}`);
  rec('A5c 生效时间改为现在', Number(after.activated_at) <= Date.now() + 1000, '');

  const superseded = db.prepare("SELECT COUNT(*) c FROM member_cards WHERE status = 'superseded' AND student_id = 'stu_1'").get().c;
  rec('A5d ★ 同科目在途旧卡被作废', superseded >= 1, `superseded=${superseded}`);

  const again = mockRes();
  activateNow(mockReq({ params: { id: pending.id }, userRole: 'admin', openid: 'admin_x' }), again);
  rec('A5e 已生效卡再次提前激活被拒', again.body && again.body.code !== 0, JSON.stringify(again.body).slice(0, 120));
}

// ===== A6 未生效卡退款 =====
console.log('\n\x1b[1m[A6] 未生效卡退款按「未开课」处理\x1b[0m');
{
  // 造一张未来的顺延卡 + 订单
  const r = buyCard('ct_time');
  const orderId = r.data.orderId;
  const card = db.prepare('SELECT * FROM member_cards WHERE order_id = ?').get(orderId);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const sug = computeRefundSuggestion(order, { cardId: card.id });
  rec('A6 ★ 未生效卡 started=false（走开课前规则）', sug.started === false, `started=${sug.started}`);
  rec('A6b 未配置公式时全额可退', sug.amount === Number(order.payable_amount), `amount=${sug.amount} paid=${order.payable_amount}`);
}

// ===== B 组：周期锚定 =====
console.log('\n\x1b[1m[B] 周期锚定\x1b[0m');
{
  const base = t;
  const card = {
    period_anchor: 'activated', activated_at: base, first_used_at: 0,
    expires_at: base + 90 * DAY, cycle_days_week: 7, cycle_days_month: 30,
  };
  // 第 0 段
  const b0 = periodBoundsForCard(card, base + 1000);
  rec('B1 ★ activated 锚点：第 0 段从开卡日起算', b0 && b0.month.index === 0, JSON.stringify(b0 && b0.month));
  // 第 1 段（31 天后）
  const b1 = periodBoundsForCard(card, base + 31 * DAY);
  rec('B1b 第 31 天进入第 1 段', b1 && b1.month.index === 1, JSON.stringify(b1 && b1.month));
  rec('B1c 段长 30 天', b1 && b1.month.cycleDays === 30, '');

  // B2 first_use 未使用 → 不限
  const cardFu = { ...card, period_anchor: 'first_use', first_used_at: 0 };
  const b2 = periodBoundsForCard(cardFu, base + 5000);
  rec('B2 ★ first_use 未使用时不限次', b2 && b2.unlimited === true, JSON.stringify(b2));

  // B2b first_use 已使用 → 从使用日起算
  const cardFu2 = { ...card, period_anchor: 'first_use', first_used_at: base + 5 * DAY };
  const b2b = periodBoundsForCard(cardFu2, base + 6 * DAY);
  rec('B2b first_use 已使用后按使用日起算', b2b && b2b.unlimited === false && b2b.month.index === 0, JSON.stringify(b2b && b2b.month));

  // B3 末段折算：月限 8、本段只剩 12 天 → 4
  const seg = { days: 12, cycleDays: 30 };
  rec('B3 ★ 末段按天数折算（8×12/30 → 4）', effectiveCycleLimit(8, seg) === 4, `got=${effectiveCycleLimit(8, seg)}`);
  rec('B3b 整段不折算', effectiveCycleLimit(8, { days: 30, cycleDays: 30 }) === 8, '');

  // natural 兼容
  const cardN = { ...card, period_anchor: 'natural' };
  rec('B4 ★ natural 返回 null（沿用旧自然月逻辑）', periodBoundsForCard(cardN, base) === null, '');
}

// ===== C 组：退费公式 =====
console.log('\n\x1b[1m[C] 退费公式\x1b[0m');
{
  const vars = { paid: 1000, refunded: 0, remain: 1000, total_days: 30, used_days: 12, remain_days: 18,
    paused_days: 0, total_classes: 20, used_classes: 8, remain_classes: 12, fee_rate: 0.2 };

  rec('C2 按剩余天数求值正确', evaluateRefund('round(remain * remain_days / total_days)', vars).amount === 600, '');
  rec('C2b 扣手续费', evaluateRefund('max(0, round(remain * remain_days / total_days) - 200)', vars).amount === 400, '');
  rec('C2c 结果夹取到 [0, remain]', evaluateRefund('remain * 99', vars).amount === 1000, '');
  rec('C2d 负数夹取到 0', evaluateRefund('0 - 500', vars).amount === 0, '');

  const bad = ['eval(1)', '1;2', 'remain && 1', 'process.exit()', 'foo + 1', 'min(1)', 'x'.repeat(600)];
  const leaked = bad.filter((e) => evaluateRefund(e, vars).ok);
  rec('C3 ★ 非法表达式全部被拒（无注入面）', leaked.length === 0, leaked.join(' | '));

  rec('C3b validateFormula 拒绝坏公式', validateFormula('remain * ').ok === false, '');
  rec('C3c validateFormula 接受空公式（用默认）', validateFormula('').ok === true, '');

  // 配置自定义公式后，退款金额随之变化
  const r = buyCard('ct_count');
  const orderId = r.data.orderId;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const card = db.prepare('SELECT * FROM member_cards WHERE order_id = ?').get(orderId);

  // C1 未配置公式 → 与内置默认一致（次数卡按剩余次数）
  const before = computeRefundSuggestion(order, { cardId: card.id });
  rec('C1 未配置公式时走内置默认', before.amount === Math.round(Number(order.payable_amount) * (24 / 24)),
    `amount=${before.amount}`);

  // 配置「全额」公式
  db.prepare('UPDATE membership_cards SET refund_formula = ? WHERE id = ?').run('remain', 'ct_count');
  const after = computeRefundSuggestion(order, { cardId: card.id });
  rec('C2e ★ 卡种公式生效（remain → 全额）', after.amount === Number(order.payable_amount),
    `amount=${after.amount} paid=${order.payable_amount}`);
  rec('C5 ★ 预览带回公式明细（可解释）', !!(after.formula && after.formula.formula === 'remain' && after.formula.vars),
    JSON.stringify(after.formula && after.formula.formula));

  // 恢复，避免影响后续
  db.prepare('UPDATE membership_cards SET refund_formula = ? WHERE id = ?').run('', 'ct_count');
}

// ===== D 组：配置读写 =====
console.log('\n\x1b[1m[D] 规则中心读写\x1b[0m');
{
  const cfg = getCardRules();
  rec('D1 默认值下发完整', cfg.defer && cfg.period && cfg.refund, JSON.stringify(cfg).slice(0, 120));

  const merged = mergeGroup(cfg, { period: { defaultAnchor: 'first_use' } });
  rec('D2 ★ 只传一组不冲掉其他组', merged.defer.enabled === cfg.defer.enabled && merged.refund.allowPartial === cfg.refund.allowPartial,
    JSON.stringify(merged).slice(0, 140));
  rec('D2b 目标组已更新', merged.period.defaultAnchor === 'first_use', '');

  const bad = mergeGroup(cfg, { defer: { startAnchor: '不存在的值', enabled: 'yes' } });
  rec('D3 ★ 非法值被丢弃并保留原值', bad.defer.startAnchor === cfg.defer.startAnchor && bad.defer.enabled === cfg.defer.enabled,
    JSON.stringify(bad.defer));
}

console.log(`\n\x1b[1m结果汇总：PASS ${pass}  FAIL ${fail}\x1b[0m`);
db.close();
process.exit(fail > 0 ? 1 : 0);
