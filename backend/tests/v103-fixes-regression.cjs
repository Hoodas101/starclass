/**
 * v1.0.3 修复项回归测试（离线，隔离库）
 *
 * 覆盖本轮三处关键修复：
 *  1) 收款渠道透传：POST /orders/:id/pay 传 channel:'cash' → payments.channel='cash'、审计 paymentMethod='cash'
 *     （此前硬编码 'wechat'，与建单自动结算路径不一致）。
 *  2) 销售越权读设置：GET /api/settings 对销售只回公开子集（不含 points_rules/refund_rules），管理员回全量。
 *  3) 1v1 课程范围隔离：范围不匹配的卡（含临时活动排期）一律拒绝扣课（scopeMismatch），不再静默扣错卡。
 *
 * 运行：node tests/v103-fixes-regression.cjs
 */
process.env.DB_PATH = '/tmp/v103_fixes_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/v103_fixes_test.db', '/tmp/v103_fixes_test.db-wal', '/tmp/v103_fixes_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const ordersRouter = require('../routes/orders');
const settingsModule = require('../routes/settings'); // 导出 { router, termsHandler }
const { pickCardForDeduction } = require('../utils/deduction');

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
let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
}

const t = now();
const future = t + 30 * 86400000;
const seed = db.transaction(() => {
  const ins = (sql, ...p) => db.prepare(sql).run(...p);
  ins('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_admin', 'admin_x', '管理员', 'admin', 'x', 'active', '', t, t);
  ins('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_sales', 'sales_x', '销售X', 'sales', 'x', 'active', '', t, t);
  ins('INSERT INTO students (id, name, status, created_at, updated_at) VALUES (?,?,?,?,?)', 'stu_x', '测试学员', 'active', t, t);
  // 待支付订单（用于 /pay）
  ins(`INSERT INTO orders (id, order_no, user_id, student_id, student_name, order_type, items, total_amount, discount_amount, payable_amount, status, salesperson, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_pay', 'ORD_PAY_1', 'sales_x', 'stu_x', '测试学员', 'membership', '[]', 1000, 0, 1000, 'pending', '销售X', '', t, t);
  // 设置：写入一条经营规则（points_rules）
  ins('INSERT INTO settings (key, label, value, description, updated_at) VALUES (?,?,?,?,?)',
    'points_rules', '积分规则', JSON.stringify([{ name: 'x', points: 1 }]), '', t);
  // 1v1 卡种 + 卡实例（scope '一对一'）
  ins('INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, is_active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    'ct_1v1', '1v1私教次卡', 10, 90, 'count', 0, 5000, '一对一', 0, 1, 1, t);
  ins('INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'mc_1v1', 'ct_1v1', '1v1私教次卡', 'count', 'stu_x', '测试学员', 10, 10, 0, t, future, 'active', t, t);
  // 真实课程（团课）+ 内置「临时活动」占位课程（schedules.course_id 有外键，须先存在）+ 排期
  ins('INSERT INTO courses (id, name, category, is_active, created_at) VALUES (?,?,?,?,?)', 'c_team', '篮球基础班', '团课', 1, t);
  ins('INSERT INTO courses (id, name, category, is_active, created_at) VALUES (?,?,?,?,?)', 'course_temp', '临时活动', '临时', 0, t);
  ins('INSERT INTO schedules (id, course_id, course_name, date, start_time, end_time, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    'sch_team', 'c_team', '篮球基础班', '2099-06-16', '10:00', '11:00', 'scheduled', t, t);
  // 临时活动排期（course_temp）
  ins('INSERT INTO schedules (id, course_id, course_name, date, start_time, end_time, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    'sch_temp', 'course_temp', '团课B', '2099-06-17', '10:00', '11:00', 'scheduled', t, t);
  // 匹配范围的排期（活动名落在卡范围 '一对一' 内）
  ins('INSERT INTO schedules (id, course_id, course_name, date, start_time, end_time, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    'sch_1v1', 'course_temp', '一对一', '2099-06-18', '10:00', '11:00', 'scheduled', t, t);
});
seed();

console.log('\n\x1b[1m=== v1.0.3 修复项回归测试 ===\x1b[0m\n');

// [1] 收款渠道透传
console.log('\x1b[1m[1] 收款渠道透传（/pay）\x1b[0m');
{
  const pay = getHandler(ordersRouter, 'post', '/:id/pay');
  const r = mockRes();
  pay(mockReq({ params: { id: 'ord_pay' }, body: { channel: 'cash' }, userRole: 'admin', openid: 'admin_x' }), r);
  rec('POST /:id/pay 成功', r.body && r.body.code === 0, `status=${r.statusCode} body=${JSON.stringify(r.body)}`);
  const payRow = db.prepare('SELECT channel FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get('ord_pay');
  rec('payments.channel 落为 cash（非硬编码 wechat）', !!payRow && payRow.channel === 'cash', `channel=${payRow && payRow.channel}`);
  const audit = db.prepare("SELECT after_state FROM audit_log WHERE entity = 'order' AND entity_id = ? AND action = 'pay' ORDER BY created_at DESC LIMIT 1").get('ord_pay');
  let method = null;
  try { method = audit ? JSON.parse(audit.after_state).paymentMethod : null; } catch (e) { /* ignore */ }
  rec('审计 paymentMethod = cash', method === 'cash', `paymentMethod=${method}`);
}

// [2] 设置越权读
console.log('\n\x1b[1m[2] 设置读取权限（销售 vs 管理员）\x1b[0m');
{
  const getSettings = getHandler(settingsModule.router, 'get', '/');
  const rSales = mockRes();
  getSettings(mockReq({ userRole: 'sales', openid: 'sales_x' }), rSales);
  const dSales = rSales.body && rSales.body.data;
  rec('销售读设置：不含经营规则 points_rules', dSales && dSales.points_rules === undefined, `keys=${dSales && Object.keys(dSales)}`);
  rec('销售读设置：仍含称呼方案 term_scheme（UI 需要）', dSales && 'term_scheme' in dSales, `keys=${dSales && Object.keys(dSales)}`);

  const rAdmin = mockRes();
  getSettings(mockReq({ userRole: 'admin', openid: 'admin_x' }), rAdmin);
  const dAdmin = rAdmin.body && rAdmin.body.data;
  rec('管理员读设置：含 points_rules 全量', dAdmin && dAdmin.points_rules !== undefined, `keys=${dAdmin && Object.keys(dAdmin)}`);
}

// [3] 1v1 课程范围隔离
console.log('\n\x1b[1m[3] 1v1 课程范围隔离\x1b[0m');
{
  const tNow = now();
  const team = pickCardForDeduction('stu_x', 'sch_team', tNow, 1);
  rec('1v1 卡 遇 真实团课 → 拒绝扣课（scopeMismatch）', team && team.scopeMismatch === true, `ret=${JSON.stringify(team)}`);
  const temp = pickCardForDeduction('stu_x', 'sch_temp', tNow, 1);
  rec('1v1 卡 遇 临时活动 → 同样拒绝（不再绕过）', temp && temp.scopeMismatch === true, `ret=${JSON.stringify(temp)}`);
  const ok = pickCardForDeduction('stu_x', 'sch_1v1', tNow, 1);
  rec('1v1 卡 遇 范围匹配活动 → 正常返回该卡', ok && ok.id === 'mc_1v1', `ret=${JSON.stringify(ok)}`);
}

console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
