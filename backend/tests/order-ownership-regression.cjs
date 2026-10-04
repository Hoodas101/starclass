/**
 * 订单归属回归测试（离线，隔离库）
 *
 * 原始缺陷（三角色实测 P0）：PUT /api/orders/:id 与 POST /api/orders/:id/cancel 只校验角色
 * （canSales），无任何订单归属校验 → 销售 A 可把销售 B 名下订单的金额改掉、状态改为 cancelled
 * （横向越权，直接篡改他人业绩/提成基数）。同文件 pay 早有归属校验，属遗漏而非设计。
 *
 * 判别性：固定「销售 A 的 token」，目标为「销售 B 的订单」——旧代码下 PUT/cancel 均 200；
 * 修复后应为 403。同时对照「管理员改任意订单仍 200」「订单所有者改自己订单仍 200」，
 * 证明 403 不是无差别拒绝。
 *
 * 运行：node tests/order-ownership-regression.cjs
 */
process.env.DB_PATH = '/tmp/order_ownership_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/order_ownership_test.db', '/tmp/order_ownership_test.db-wal', '/tmp/order_ownership_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const ordersRouter = require('../routes/orders');

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
const seed = db.transaction(() => {
  const ins = (sql, ...p) => db.prepare(sql).run(...p);
  ins('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_admin', 'admin_x', '管理员', 'admin', 'x', 'active', '', t, t);
  ins('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_sales_a', 'sales_a', '销售A', 'sales', 'x', 'active', '', t, t);
  ins('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_sales_b', 'sales_b', '销售B', 'sales', 'x', 'active', '', t, t);
  ins('INSERT INTO students (id, name, status, created_at, updated_at) VALUES (?,?,?,?,?)', 'stu_x', '测试学员', 'active', t, t);
  // 销售 B 名下订单：user_id=sales_b、salesperson='销售B'
  ins(`INSERT INTO orders (id, order_no, user_id, student_id, student_name, order_type, items, total_amount, discount_amount, payable_amount, status, salesperson, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_b', 'ORD_B_1', 'sales_b', 'stu_x', '测试学员', 'membership', '[]', 5000, 0, 5000, 'paid', '销售B', '', t, t);
  // 销售 A 名下订单
  ins(`INSERT INTO orders (id, order_no, user_id, student_id, student_name, order_type, items, total_amount, discount_amount, payable_amount, status, salesperson, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'ord_a', 'ORD_A_1', 'sales_a', 'stu_x', '测试学员', 'membership', '[]', 1000, 0, 1000, 'pending', '销售A', '', t, t);
});
seed();

console.log('\n\x1b[1m=== 订单归属回归测试 ===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '\n');

const putOrder = getHandler(ordersRouter, 'put', '/:id');
const cancelOrder = getHandler(ordersRouter, 'post', '/:id/cancel');

const salesA = { userRole: 'sales', openid: 'sales_a' };
const salesB = { userRole: 'sales', openid: 'sales_b' };
const admin = { userRole: 'admin', openid: 'admin_x' };

// ============================================================
// [一] 销售 A 改/取消 销售 B 的订单 → 403（核心修复）
// ============================================================
console.log('\x1b[1m[一] 横向越权拦截\x1b[0m');
{
  const r = mockRes();
  putOrder(mockReq({ ...salesA, params: { id: 'ord_b' }, body: { payableAmount: 1 } }), r);
  rec('销售A 改价 销售B 订单 → 403', r.statusCode === 403, `status=${r.statusCode} body=${JSON.stringify(r.body)}`);
  const after = db.prepare('SELECT payable_amount FROM orders WHERE id = ?').get('ord_b');
  rec('被拒后金额未被篡改（仍 5000）', Number(after.payable_amount) === 5000, `amount=${after.payable_amount}`);

  const r2 = mockRes();
  cancelOrder(mockReq({ ...salesA, params: { id: 'ord_b' }, body: {} }), r2);
  rec('销售A 取消 销售B 订单 → 403', r2.statusCode === 403, `status=${r2.statusCode} body=${JSON.stringify(r2.body)}`);
  const st = db.prepare('SELECT status FROM orders WHERE id = ?').get('ord_b');
  rec('被拒后订单状态未变（仍 paid）', st.status === 'paid', `status=${st.status}`);
}

// ============================================================
// [二] 对照：所有者本人与管理员不受影响（证明 403 非无差别拒绝）
// ============================================================
console.log('\n\x1b[1m[二] 所有者本人与管理员不受影响\x1b[0m');
{
  const r = mockRes();
  putOrder(mockReq({ ...salesB, params: { id: 'ord_b' }, body: { payableAmount: 4800 } }), r);
  rec('销售B 改自己订单 → 200', r.statusCode === 200 && r.body && r.body.code === 0, `status=${r.statusCode} body=${JSON.stringify(r.body)}`);

  const r2 = mockRes();
  putOrder(mockReq({ ...admin, params: { id: 'ord_a' }, body: { payableAmount: 900 } }), r2);
  rec('管理员改任意订单 → 200', r2.statusCode === 200 && r2.body && r2.body.code === 0, `status=${r2.statusCode} body=${JSON.stringify(r2.body)}`);
}

console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
