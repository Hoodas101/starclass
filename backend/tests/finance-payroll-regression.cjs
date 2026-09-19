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
// Batch2 新增：退费预览的 started 判定（F4）与扣课口径（F8）覆盖
const membershipRouter = require('../routes/membership');
const checkinRouter = require('../routes/checkin');
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
  // 已过月份但**无任何考勤记录**的一节：按「计薪以实际授课为准」的口径必须被剔除
  // （见 routes/payroll.js 的 EXISTS(attendances) 判据）。它的存在使下方 `classes === 2`
  // 具备判别力 —— 旧实现（只按 schedules 取行）会数成 3 节。
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time, status, enrolled_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'sch_past7_noatt', 'crs_p7', '体适能', 'tea_p7', '结算教练', `${PAST_MONTH}-05`, '14:00', '15:00', 'scheduled', 0, t, t);
  // 考勤行：过去两节各补一条 present（教师到场授课 → 计酬）。
  // 未来那节与 sch_past7_noatt 刻意不补，分别覆盖「未来课节剔除」与「未授课不计酬」。
  ins(`INSERT OR IGNORE INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name, status, checkin_method, date, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'att_past7_a', 'sch_past7', 'stu_p7', '资金学员', 'crs_p7', '体适能', 'present', 'teacher', `${PAST_MONTH}-01`, t, t);
  ins(`INSERT OR IGNORE INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name, status, checkin_method, date, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'att_past7_b', 'sch_past7_end', 'stu_p7', '资金学员', 'crs_p7', '体适能', 'present', 'teacher', PAST_MONTH_END, t, t);

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
    expect(rowC.classes === 2, `已过月份 ${PAST_MONTH}：2 节已授课节计酬（sch_past7_noatt 无考勤被剔除）`, `got ${rowC.classes}`);
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

// ============================================================
// F4. 退费预览的 started 判定：会员卡「支付即 activated_at」不得等同于「已开课」
// ============================================================
// 判别性：beforeStart=full + afterStart=percent 30%。未消耗课时的卡若被误判为已开课，
// 会走 afterStart 扣 30% → 只退 700（少退 300）；已消耗的卡若被误判为未开课，
// 会走 beforeStart 全额 → 多退。两侧都必须钉死。
{
  ins("INSERT OR REPLACE INTO settings (key, value) VALUES ('refund_rules', ?)", JSON.stringify({
    beforeStart: 'full', beforeStartPercent: 10, afterStart: 'percent', afterStartPercent: 30,
    needApproval: true, processDays: 7,
  }));
  const preview = (orderId) => {
    const res = mockRes();
    getHandler(ordersRouter, 'get', '/:id/refund-preview')(
      mockReq({ userRole: 'admin', openid: 'admin7_openid', params: { id: orderId } }), res);
    return res.body && res.body.data;
  };
  const mkPreviewFixture = (suffix, cardFields) => {
    ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      `ord_f4${suffix}`, `OF4${suffix}`, 'stu_p7', 'membership', 1000, 0, 0, 1000, 'paid', t, t, t);
    ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `mc_f4${suffix}`, 'ct_p7', '次卡', cardFields.mode, 'stu_p7', '资金学员',
      cardFields.total, cardFields.remaining, cardFields.used,
      cardFields.activatedAt, cardFields.expiresAt, 'active', `ord_f4${suffix}`, t, t);
    return preview(`ord_f4${suffix}`);
  };

  // (a) 次数卡：当日购卡、一次未用 → 未开课 → beforeStart=full → 全额 1000
  const a = mkPreviewFixture('a', { mode: 'count', total: 10, remaining: 10, used: 0, activatedAt: t, expiresAt: t + 60 * 86400000 });
  expect(!!a && a.started === false, 'F4 未消耗课时的次数卡 → started=false（旧实现因 activated_at 恒为 true）', a && String(a.started));
  expect(a && a.amount === 1000, 'F4 未消耗课时的次数卡 → 全额退 1000（旧实现按 afterStart 扣 30% 只退 700）', a && `${a.amount}/${a.mode}`);
  expect(a && /开课前/.test(a.reason || ''), 'F4 理由走 beforeStart 分支', a && a.reason);

  // (b) 次数卡：已用 5/10 → 已开课 → afterStart=percent → 退 700
  const b = mkPreviewFixture('b', { mode: 'count', total: 10, remaining: 5, used: 5, activatedAt: t - 10 * 86400000, expiresAt: t + 60 * 86400000 });
  expect(!!b && b.started === true, 'F4 已消耗课时的次数卡 → started=true（未被误判成开课前而多退）', b && String(b.started));
  expect(b && b.amount === 700, 'F4 已消耗课时的次数卡 → 按 afterStart 扣 30% 退 700', b && String(b.amount));

  // (c) 时效卡：当日购卡（有效期未消耗）→ 全额；已过半 → 走 afterStart
  const c1 = mkPreviewFixture('c', { mode: 'time', total: 0, remaining: 0, used: 0, activatedAt: t, expiresAt: t + 200 * 86400000 });
  expect(!!c1 && c1.started === false && c1.amount === 1000, 'F4 当日未消耗的时效卡 → 全额 1000', c1 && JSON.stringify({ s: c1.started, a: c1.amount }));
  const c2 = mkPreviewFixture('d', { mode: 'time', total: 0, remaining: 0, used: 0, activatedAt: t - 100 * 86400000, expiresAt: t + 100 * 86400000 });
  expect(!!c2 && c2.started === true && c2.amount === 700, 'F4 已过半的时效卡 → started=true 且按 afterStart 退 700', c2 && JSON.stringify({ s: c2.started, a: c2.amount }));

  // (d) 非会员卡订单（无卡）行为不变：仍走 beforeStart
  ins(`INSERT OR IGNORE INTO orders (id, order_no, student_id, order_type, payable_amount, discount_amount, refunded_amount, total_amount, status, paid_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_f4e', 'OF4E', 'stu_p7', 'retail', 300, 0, 0, 300, 'paid', t, t, t);
  const e = preview('ord_f4e');
  expect(!!e && e.started === false && e.amount === 300, 'F4 无会员卡订单行为不变（未开课全额 300）', e && JSON.stringify({ s: e.started, a: e.amount }));
}

// ============================================================
// F8. 扣课口径：courses.consume_classes（默认 1）必须真的扣 N
// ============================================================
// 判别性：签到扣课路径旧实现硬编码 -1，配置「每次消耗 2 课时」的课程永远只扣 1；
// 回滚路径同样只 +1。两侧一起错会让卡内余额被系统性高估。
{
  // 专用学员：扣课按 expires_at 最早的可扣卡选卡，复用 stu_p7 会命中前面夹具的卡
  ins("INSERT OR IGNORE INTO students (id, name) VALUES ('stu_f8', '扣课学员')");
  ins("INSERT OR IGNORE INTO courses (id, name, category, consume_classes, is_active, created_at) VALUES ('crs_f8', '双课时课', 'training', 2, 1, ?)", t);
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, date, start_time, end_time, status, enrolled_count, created_at, updated_at)
       VALUES ('sch_f8', 'crs_f8', '双课时课', 'teacher_001', ?, '09:00', '10:00', 'scheduled', 0, ?, ?)`, today, t, t);
  ins(`INSERT OR IGNORE INTO enrollments (id, schedule_id, student_id, student_name, course_id, course_name, status, enroll_type, created_at)
       VALUES ('enr_f8', 'sch_f8', 'stu_f8', '资金学员', 'crs_f8', '双课时课', 'active', 'normal', ?)`, t);
  ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
       VALUES ('mc_f8', 'ct_p7', '次卡', 'count', 'stu_f8', '资金学员', 10, 10, 0, ?, ?, 'active', NULL, ?, ?)`,
    t - 86400000, t + 200 * 86400000, t, t);
  const cardOf = () => db.prepare("SELECT remaining_classes, used_classes FROM member_cards WHERE id = 'mc_f8'").get();
  const checkin = (status) => {
    const res = mockRes();
    getHandler(checkinRouter, 'post', '/teacher')(mockReq({
      userRole: 'admin', openid: 'admin7_openid',
      body: { scheduleId: 'sch_f8', attendances: [{ studentId: 'stu_f8', status }] },
    }), res);
    return res.body && res.body.data;
  };

  const before = cardOf();
  expect(before.remaining_classes === 10 && before.used_classes === 0, 'F8 夹具：次数卡 10 次可用', JSON.stringify(before));

  checkin('present');
  const afterCk = cardOf();
  expect(afterCk.remaining_classes === 8 && afterCk.used_classes === 2,
    'F8 签到按 consume_classes=2 扣 2 课时（旧实现硬编码扣 1）', JSON.stringify(afterCk));

  checkin('clear');
  const afterClr = cardOf();
  expect(afterClr.remaining_classes === 10 && afterClr.used_classes === 0,
    'F8 清除点名回滚 2 课时（旧实现只 +1，每轮虚增 1 课时）', JSON.stringify(afterClr));

  // 手工扣课未传 classes → 取课程 consume_classes
  const resD = mockRes();
  getHandler(membershipRouter, 'post', '/deduct')(mockReq({
    userRole: 'admin', openid: 'admin7_openid', body: { scheduleId: 'sch_f8', studentId: 'stu_f8' },
  }), resD);
  const d = resD.body && resD.body.data;
  const afterDeduct = cardOf();
  expect(!!d && d.deducted === 2 && afterDeduct.remaining_classes === 8 && afterDeduct.used_classes === 2,
    'F8 手工扣课未传 classes → 按 consume_classes=2 扣 2（旧实现默认 1）',
    JSON.stringify({ resp: d, card: afterDeduct }));

  // 余量不足 N：不得扣成负数，也不得部分扣减（否则回滚无法复原到同一数值）
  db.prepare("UPDATE member_cards SET remaining_classes = 1, used_classes = 9 WHERE id = 'mc_f8'").run();
  db.prepare("DELETE FROM deduction_logs WHERE schedule_id = 'sch_f8'").run();
  checkin('present');
  const afterShort = cardOf();
  expect(afterShort.remaining_classes === 1 && afterShort.used_classes === 9,
    'F8 余量不足以支付 N 课时时不扣课（不出现负余额，回滚保持对称）', JSON.stringify(afterShort));

  // consume_classes = 0（course_temp 自定义临时活动）必须归一到 1，不能变成不扣课
  ins("INSERT OR IGNORE INTO courses (id, name, category, consume_classes, is_active, created_at) VALUES ('crs_f8z', '临时活动', '临时', 0, 0, ?)", t);
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, date, start_time, end_time, status, enrolled_count, created_at, updated_at)
       VALUES ('sch_f8z', 'crs_f8z', '临时活动', 'teacher_001', ?, '09:00', '10:00', 'scheduled', 0, ?, ?)`, today, t, t);
  ins(`INSERT OR IGNORE INTO enrollments (id, schedule_id, student_id, student_name, course_id, course_name, status, enroll_type, created_at)
       VALUES ('enr_f8z', 'sch_f8z', 'stu_f8', '资金学员', 'crs_f8z', '临时活动', 'active', 'normal', ?)`, t);
  db.prepare("UPDATE member_cards SET remaining_classes = 10, used_classes = 0 WHERE id = 'mc_f8'").run();
  db.prepare("DELETE FROM deduction_logs WHERE schedule_id = 'sch_f8z'").run();
  const resZ = mockRes();
  getHandler(checkinRouter, 'post', '/teacher')(mockReq({
    userRole: 'admin', openid: 'admin7_openid',
    body: { scheduleId: 'sch_f8z', attendances: [{ studentId: 'stu_f8', status: 'present' }] },
  }), resZ);
  const afterZ = cardOf();
  expect(afterZ.remaining_classes === 9 && afterZ.used_classes === 1,
    'F8 consume_classes=0（临时活动）归一为 1，签到仍扣 1 课时', JSON.stringify(afterZ));
}

// ---------- 输出 ----------
console.log(results.join('\n'));
if (failures) {
  console.log(`\n${failures} FAILED / ${results.length} total`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} passed ✅`);
