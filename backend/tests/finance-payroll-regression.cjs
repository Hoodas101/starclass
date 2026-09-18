/**
 * 资金与薪资回归校验（离线，隔离库）
 * 覆盖四个行为回归点：
 *   1. orders/:id/refund 部分退款（规则建议值）→ 必须同步回收卡内未用权益
 *      （remaining_classes 清零 + clawback 提示 + audit_log 留痕），
 *      否则「退剩余课时现金 + 继续把课上完」双拿
 *   2. payroll/settle 与 payroll/coaches 月中口径：未来日期的 scheduled 课节
 *      不计应付（fixed 规则下 attended=0 也发 baseRate，整月范围会提前透支）
 *   3. payroll settle/void 资金写入留 audit_log 痕迹
 *   4. admin DELETE /courses/:id 级联删除时回滚 'checkin' 类型签到积分
 *      （旧版只回滚 'earn'，签到分随流水被删、余额不清）
 *
 * 运行：node tests/finance-payroll-regression.cjs
 */
process.env.DB_PATH = '/tmp/finance_payroll_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/finance_payroll_test.db', '/tmp/finance_payroll_test.db-wal', '/tmp/finance_payroll_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now, formatDate, generateId } = require('../utils');
const ordersRouter = require('../routes/orders');
const payrollRouter = require('../routes/payroll');
const adminRouter = require('../routes/admin');
// coach_comments 表由 routes/comments.js 在 require 时懒建（server.js 会全量加载路由）；
// 课程级联删除会清理该表，故测试进程需先加载它。
require('../routes/comments');

function getHandler(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== path) continue;
    if (!layer.route.methods[method]) continue;
    const handlers = layer.route.stack;
    return handlers[handlers.length - 1].handle;
  }
  throw new Error(`未找到处理器: ${method.toUpperCase()} ${path}`);
}
function mockRes() {
  const r = { statusCode: 200, body: null };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (payload) => { r.body = payload; return r; };
  return r;
}
function mockReq(o) {
  return Object.assign({ headers: {}, params: {}, query: {}, body: {}, userRole: '', openid: '' }, o);
}

const t = now();
const today = formatDate(t);

// ── 日期无关的固定月份（C8）────────────────────────────────────────────
// 旧用例把「真实当月」当作测试区间，再用 hasFuture 分支切换断言：
//   今天不是月末 → 断言「剔除未来课节」；今天恰是月末 → 断言「全量计酬」。
// 同一份代码在不同日子得到不同结论，月末当天更是直接跳过裁剪逻辑；
// 而 settle 的 clamped 断言写成 `data && hasFuture ? data.clamped === true : true`，
// 因运算符优先级在 hasFuture=false 时整体退化为 `true` —— 恒过（假绿）。
// 现改为两个完全落在过去 / 未来的固定月份，断言不再读取真实日期：
//   PAST_MONTH   整月已过 → effEnd = 月末，clamped=false，全部课节计酬
//   FUTURE_MONTH 整月未到 → effEnd = 今天，clamped=true，全部课节被剔除
// 二者合起来精确覆盖「只结算已发生课节」这一修复点，且与运行日无关。
const PAST_MONTH = '2019-04';
const PAST_MONTH_END = '2019-04-30';
const FUTURE_MONTH = '2099-01';
const FUTURE_MONTH_END = '2099-01-31';

const ins = (sql, ...params) => db.prepare(sql).run(...params);

// ---------- 种子数据 ----------
const seed = db.transaction(() => {
  ins("INSERT OR IGNORE INTO users (id, openid, role, password, nickname) VALUES (?,?,?,?,?)",
    'u_admin7', 'admin7_openid', 'admin', 'x', 'Admin7');
  ins("INSERT OR IGNORE INTO students (id, name) VALUES (?,?)", 'stu_p7', '资金学员');
  ins("INSERT OR IGNORE INTO courses (id, name, category, created_at) VALUES (?,?,?,?)", 'crs_p7', '体适能', 'training', t);

  // === T1：次数卡部分退款回收权益 ===
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_p7', 'OP7001', 'stu_p7', 'membership', 1000, 0, 0, 1000, 'paid', t, t, t);
  // 次数卡：10 次还剩 5 次 → afterStart 默认 unused → 建议退 1000×5/10=500（部分退款）
  ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'mc_p7', 'ct_p7', '次卡', 'count', 'stu_p7', '资金学员', 10, 5, 5,
    t - 30 * 86400000, t + 60 * 86400000, 'active', 'ord_p7', t, t);

  // === T2：薪资结算只计已发生课节（固定月份，日期无关）===
  ins("INSERT OR IGNORE INTO teachers (id, name, phone, status, class_fee, pay_rule, created_at) VALUES (?,?,?,?,?,?,?)",
    'tea_p7', '结算教练', '13700000007', 'active', 100, JSON.stringify({ type: 'fixed', baseRate: 100 }), t);
  // 已过月份 PAST_MONTH 两节（月初 + 月末，均 ≤ 月末 → 都应计酬，每节 fixed 规则发 100）
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time, status, enrolled_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'sch_past7', 'crs_p7', '体适能', 'tea_p7', '结算教练', `${PAST_MONTH}-01`, '09:00', '10:00', 'scheduled', 0, t, t);
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time, status, enrolled_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'sch_past7_end', 'crs_p7', '体适能', 'tea_p7', '结算教练', PAST_MONTH_END, '09:00', '10:00', 'scheduled', 0, t, t);
  // 未来月份 FUTURE_MONTH 一节（日期 > 今天 → 必须被剔除，不得提前计酬）
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time, status, enrolled_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'sch_future7', 'crs_p7', '体适能', 'tea_p7', '结算教练', `${FUTURE_MONTH}-15`, '09:00', '10:00', 'scheduled', 0, t, t);

  // === T4：课程级联删除回滚签到积分 ===
  ins("INSERT OR IGNORE INTO courses (id, name, category, created_at) VALUES (?,?,?,?)", 'crs_del7', '待删活动', 'training', t);
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, date, start_time, end_time, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    'sch_del7', 'crs_del7', '待删活动', '', '2026-08-01', '09:00', '10:00', 'scheduled', t, t);
  ins(`INSERT OR IGNORE INTO points (id, student_id, student_name, total_earned, total_consumed, balance, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    'pts_del7', 'stu_p7', '资金学员', 50, 0, 50, t);
  // 签到奖励 +10，随后撤销 -5 → 净发放 5，删除活动应回滚 5
  ins(`INSERT OR IGNORE INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, 'pl_p7a', 'stu_p7', 'checkin', 10, 60, 'checkin', 'sch_del7', '签到奖励', t);
  ins(`INSERT OR IGNORE INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, 'pl_p7b', 'stu_p7', 'checkin', -5, 55, 'reverse', 'sch_del7', '撤销签到分', t);
});
seed();

// ---------- 断言 ----------
let failures = 0;
const results = [];
function expect(condition, label, detail) {
  results.push(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`);
  if (!condition) failures++;
}

// T1. 部分退款按规则建议值 → 回收卡内未用权益 + 留痕
{
  const h = getHandler(ordersRouter, 'post', '/:id/refund');
  const res = mockRes();
  h(mockReq({ userRole: 'admin', openid: 'admin7_openid', params: { id: 'ord_p7' }, body: { reason: '回归-部分退款回收' } }), res);
  const body = res.body && res.body.data;
  expect(!!body && body.refunded === true, '部分退款成功', res.body && res.body.message);
  expect(body && body.refundAmount === 500 && !body.full, '退款额=建议值 500 且非全额', body && JSON.stringify(body));
  expect(body && typeof body.clawback === 'string' && body.clawback.includes('回收'), '返回 clawback 权益回收提示', body && String(body.clawback));
  const card = db.prepare("SELECT remaining_classes, status FROM member_cards WHERE id = 'mc_p7'").get();
  expect(card.remaining_classes === 0, '次数卡剩余课时清零', `got ${card.remaining_classes}`);
  expect(card.status === 'active', '部分退款不改卡状态为 refunded（仍可查账）', card.status);
  const ord = db.prepare("SELECT refunded_amount, status FROM orders WHERE id = 'ord_p7'").get();
  expect(ord.refunded_amount === 500 && ord.status === 'paid', '主单累计 500、状态仍 paid', `${ord.refunded_amount}/${ord.status}`);
  const audit = db.prepare("SELECT * FROM audit_log WHERE entity = 'order' AND entity_id = 'ord_p7' AND action = 'refund'").get();
  expect(!!audit, 'refund 写入 audit_log');
  if (audit) {
    const after = JSON.parse(audit.after_state || '{}');
    expect(after.amount === 500 && after.appliedSuggestion === true && !!after.clawback, '审计含金额/建议值/回收明细', audit.after_state);
  }
  const pay = db.prepare("SELECT amount, status FROM payments WHERE order_id = 'ord_p7'").get();
  expect(!!pay && pay.amount === 500 && pay.status === 'refunded', 'REF 支付流水 500', pay && `${pay.amount}/${pay.status}`);
}

// T1b. 协商自定义金额（confirmOverride）不动卡内权益 —— 防误伤让利场景
{
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_p7b', 'OP7002', 'stu_p7', 'membership', 800, 0, 0, 800, 'paid', t, t, t);
  ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'mc_p7b', 'ct_p7', '次卡', 'count', 'stu_p7', '资金学员', 8, 6, 2,
    t - 10 * 86400000, t + 60 * 86400000, 'active', 'ord_p7b', t, t);
  const h = getHandler(ordersRouter, 'post', '/:id/refund');
  const res = mockRes();
  // 建议值 = 800×6/8=600；协商退 500 + confirmOverride
  h(mockReq({ userRole: 'admin', openid: 'admin7_openid', params: { id: 'ord_p7b' }, body: { reason: '协商退款', refundAmount: 500, confirmOverride: true } }), res);
  const body = res.body && res.body.data;
  expect(!!body && body.refunded === true, '协商退款成功', res.body && res.body.message);
  expect(body && body.clawback === null, '协商金额不触发权益回收', body && String(body.clawback));
  const card = db.prepare("SELECT remaining_classes FROM member_cards WHERE id = 'mc_p7b'").get();
  expect(card.remaining_classes === 6, '协商退款后课时保持 6 次', `got ${card.remaining_classes}`);
}

// T2/T3. payroll：/coaches 预览与 /settle 同口径只计已发生课节；资金写入留痕
// 两段断言全部使用固定月份，不读取真实日期（C8）。
{
  // ── 已过月份：整月已发生，应全额计酬且不裁剪 ──
  const hc = getHandler(payrollRouter, 'get', '/coaches');
  const resC = mockRes();
  hc(mockReq({ userRole: 'admin', query: { month: PAST_MONTH } }), resC);
  const listC = (resC.body && resC.body.data.list) || [];
  const rowC = listC.find((x) => x.teacherId === 'tea_p7');
  expect(!!rowC, '/coaches 返回教练行');
  if (rowC) {
    expect(rowC.classes === 2, `已过月份 ${PAST_MONTH}：2 节课节全部计酬`, `got ${rowC.classes}`);
    expect(rowC.amount === 200, '已过月份应付 = 2 × 100 = 200', `got ${rowC.amount}`);
  }
  const effEnd = resC.body && resC.body.data.endDate;
  // 捕获「无脑裁剪到今天」的实现：已过月份必须回显月末，而不是今天
  expect(effEnd === PAST_MONTH_END, '已过月份回显月末为计酬截止日（未被裁剪到今天）', String(effEnd));

  const hs = getHandler(payrollRouter, 'post', '/settle');
  const resS = mockRes();
  hs(mockReq({ userRole: 'admin', openid: 'admin7_openid', body: { month: PAST_MONTH } }), resS);
  const data = resS.body && resS.body.data;
  expect(!!data && data.ok === true, 'settle 成功', resS.body && resS.body.message);
  expect(data && data.settled === 1, '结算 1 位教练', data && String(data.settled));
  expect(data && data.totalAmount === 200, '结算总额 = 200（整月全额）', data && String(data.totalAmount));
  // 旧断言 `data && hasFuture ? data.clamped === true : true` 因优先级在 hasFuture=false
  // 时整体为 `true`，恒过。此处无条件精确断言：已过月份不裁剪 → clamped 必须为 false。
  expect(!!data && data.clamped === false, '已过月份 clamped=false（未发生裁剪）', data && String(data.clamped));
  const log = db.prepare("SELECT * FROM payroll_logs WHERE teacher_id = 'tea_p7' AND status = 'settled'").get();
  expect(!!log && log.lesson_count === 2 && log.amount === 200,
    'payroll_logs 落库口径正确（2 节 / 200）', log && `${log.lesson_count}/${log.amount}`);
  expect(!!log && log.month === PAST_MONTH, 'payroll_logs 月份为固定测试月份', log && log.month);
  const auditS = db.prepare("SELECT * FROM audit_log WHERE entity = 'payroll' AND action = 'settle' AND entity_id = ?").get(PAST_MONTH);
  expect(!!auditS, 'settle 写入 audit_log');
  if (auditS) {
    const after = JSON.parse(auditS.after_state || '{}');
    expect(after.endDateUsed === PAST_MONTH_END, '审计记录实际计酬截止日 = 月末', auditS.after_state);
  }

  // 幂等：重复结算被拒
  const resS2 = mockRes();
  hs(mockReq({ userRole: 'admin', openid: 'admin7_openid', body: { month: PAST_MONTH } }), resS2);
  expect(resS2.body && resS2.body.code !== 0, '重复结算拒绝', JSON.stringify(resS2.body));

  // 作废 + 留痕
  const hv = getHandler(payrollRouter, 'post', '/logs/:id/void');
  const resV = mockRes();
  hv(mockReq({ userRole: 'admin', openid: 'admin7_openid', params: { id: log.id } }), resV);
  expect(resV.body && resV.body.data && resV.body.data.voided === true, 'void 成功', JSON.stringify(resV.body));
  const voided = db.prepare('SELECT status, paid_at FROM payroll_logs WHERE id = ?').get(log.id);
  expect(voided.status === 'voided' && !voided.paid_at, '记录置 voided 且清空 paid_at', `${voided.status}/${voided.paid_at}`);
  const auditV = db.prepare("SELECT * FROM audit_log WHERE entity = 'payroll' AND action = 'void_settle' AND entity_id = ?").get(log.id);
  expect(!!auditV && JSON.parse(auditV.before_state || '{}').amount === log.amount, 'void 审计含作废前快照', auditV && auditV.before_state);
}

// T2b. 未来月份：整月未发生 → 必须全部剔除，且 clamped=true。日期无关。
{
  const hc = getHandler(payrollRouter, 'get', '/coaches');
  const resC = mockRes();
  hc(mockReq({ userRole: 'admin', query: { month: FUTURE_MONTH } }), resC);
  const rowC = ((resC.body && resC.body.data.list) || []).find((x) => x.teacherId === 'tea_p7');
  expect(!!rowC, '未来月份 /coaches 返回教练行');
  if (rowC) {
    // 捕获修复前的缺陷：未来课节被按 baseRate 提前计酬（此处会得到 1 / 100）
    expect(rowC.classes === 0, `未来月份 ${FUTURE_MONTH}：未发生课节不计应付`, `got ${rowC.classes}`);
    expect(rowC.amount === 0, '未来月份应付 = 0', `got ${rowC.amount}`);
  }
  const effEndF = resC.body && resC.body.data.endDate;
  expect(effEndF === today, '未来月份计酬截止日被裁剪到今天', String(effEndF));
  expect(effEndF < FUTURE_MONTH_END, '未来月份截止日严格早于月末（裁剪确实发生）', `${effEndF} < ${FUTURE_MONTH_END}`);

  const hs = getHandler(payrollRouter, 'post', '/settle');
  const resS = mockRes();
  hs(mockReq({ userRole: 'admin', openid: 'admin7_openid', body: { month: FUTURE_MONTH } }), resS);
  const data = resS.body && resS.body.data;
  expect(!!data && data.ok === true, '未来月份 settle 成功（无应付）', resS.body && resS.body.message);
  expect(data && data.settled === 0, '未来月份不产生任何结算记录', data && String(data.settled));
  expect(data && data.totalAmount === 0, '未来月份结算总额 = 0', data && String(data.totalAmount));
  expect(!!data && data.clamped === true, '未来月份 clamped=true（裁剪已发生）', data && String(data.clamped));
  const futureLogs = db.prepare('SELECT COUNT(*) c FROM payroll_logs WHERE month = ?').get(FUTURE_MONTH).c;
  expect(futureLogs === 0, '未来月份 payroll_logs 零落库', String(futureLogs));
}

// T4. 删除活动级联回滚签到积分（含撤销行净额）
{
  const h = getHandler(adminRouter, 'delete', '/courses/:id');
  const res = mockRes();
  h(mockReq({ userRole: 'admin', openid: 'admin7_openid', params: { id: 'crs_del7' } }), res);
  expect(res.body && res.body.code === 0, '删除活动成功', res.body && res.body.message);
  const pts = db.prepare("SELECT total_earned, balance FROM points WHERE student_id = 'stu_p7'").get();
  // 净发放 10 + (-5) = 5 → 余额 50-5=45
  expect(pts.balance === 45 && pts.total_earned === 45, '签到净发放回滚（45=50-5）', `${pts.balance}/${pts.total_earned}`);
  const left = db.prepare("SELECT COUNT(*) c FROM point_logs WHERE reference_id = 'sch_del7'").get().c;
  expect(left === 0, '关联积分流水已清理', String(left));
}

// ---------- 输出 ----------
console.log(results.join('\n'));
if (failures) {
  console.log(`\n${failures} FAILED / ${results.length} total`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} passed ✅`);
