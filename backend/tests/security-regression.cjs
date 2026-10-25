/**
 * 安全回归测试（离线，隔离库）
 *
 * 覆盖的都是「默认值 / 越权」类缺陷 —— 改一行就可能悄悄回退，必须用断言钉住：
 *  1. 家长手机号免密登录默认**关闭**（PARENT_PHONE_LOGIN 只认显式 true）
 *  2. 家长自助「模拟支付」默认**关闭**（SIMULATED_PAY_DISABLED 只认显式 '0'）
 *  3. 学员详情：家长只能看到自己那条绑定，看不到同一孩子的其他监护人手机号
 *  4. 数据导出：绝不包含 users.password / token_version
 *  5. 头像上传：按文件头判定类型，非图片直接拒绝
 *
 * 运行：node tests/security-regression.cjs
 */
process.env.DB_PATH = '/tmp/security_reg_test.db';
process.env.NODE_ENV = 'test';
delete process.env.PARENT_PHONE_LOGIN;
delete process.env.SIMULATED_PAY_DISABLED;

const fs = require('fs');
for (const f of ['/tmp/security_reg_test.db', '/tmp/security_reg_test.db-wal', '/tmp/security_reg_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const { exportData } = require('../utils/dataio');
const authRouter = require('../routes/auth');
const ordersRouter = require('../routes/orders');
const studentsRouter = require('../routes/students');

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

// ── 造数：管理员 / 家长A / 家长B（同一孩子）/ 待支付订单 ──
const t = now();
const PHONE_A = '13800001111';
const PHONE_B = '13800002222';
db.transaction(() => {
  const insUser = db.prepare('INSERT INTO users (id, openid, phone, nickname, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  insUser.run('u_admin', 'admin_x', '13700000000', '管理员', 'admin', 'active', t, t);
  insUser.run('u_a', `phone_${PHONE_A}`, PHONE_A, '家长A', 'parent', 'active', t, t);
  insUser.run('u_b', `phone_${PHONE_B}`, PHONE_B, '家长B', 'parent', 'active', t, t);
  db.prepare('INSERT INTO students (id, name, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('stu_1', '测试学员', 'active', String(t), t, t);
  const insBind = db.prepare('INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at) VALUES (?,?,?,?,?,?,?,?)');
  insBind.run('stu_1', '测试学员', '家长A', `phone_${PHONE_A}`, PHONE_A, '母亲', 1, t);
  insBind.run('stu_1', '测试学员', '家长B', `phone_${PHONE_B}`, PHONE_B, '父亲', 0, t);
  db.prepare(`INSERT INTO orders (id, order_no, student_id, student_name, items, payable_amount, order_type, status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('ord_1', 'SEC-1', 'stu_1', '测试学员', '[]', 1000, 'membership', 'pending', t, t);
})();

console.log('\n\x1b[1m=== 安全回归测试 ===\x1b[0m\n');

// ===== [1] 家长免密登录默认关闭 =====
console.log('\x1b[1m[1] 家长免密登录默认关闭\x1b[0m');
{
  const h = getHandler(authRouter, 'post', '/login');
  const r = mockRes();
  h(mockReq({ body: { phone: PHONE_A, role: 'parent' } }), r);
  const ok = r.body && r.body.code === 0 && r.body.data && r.body.data.token;
  rec('★ 未设 PARENT_PHONE_LOGIN 时，无口令登录被拒绝', !ok, `status=${r.statusCode} body=${JSON.stringify(r.body).slice(0, 160)}`);
}

// ===== [2] 模拟支付默认关闭 =====
console.log('\n\x1b[1m[2] 家长模拟支付默认关闭\x1b[0m');
{
  const h = getHandler(ordersRouter, 'post', '/:id/pay');
  const r = mockRes();
  h(mockReq({ params: { id: 'ord_1' }, openid: `phone_${PHONE_A}`, userRole: 'parent', body: {} }), r);
  const paid = db.prepare("SELECT status FROM orders WHERE id = 'ord_1'").get().status;
  rec('★ 未设 SIMULATED_PAY_DISABLED=0 时，家长不能自助置为已付',
    r.statusCode === 403 && paid === 'pending', `status=${r.statusCode} order=${paid}`);
}

// ===== [3] 学员详情只返回本人绑定 =====
console.log('\n\x1b[1m[3] 学员详情越权\x1b[0m');
{
  const h = getHandler(studentsRouter, 'get', '/:id');
  const r = mockRes();
  h(mockReq({ params: { id: 'stu_1' }, openid: `phone_${PHONE_A}`, userRole: 'parent' }), r);
  const parents = (r.body && r.body.data && r.body.data.parents) || [];
  rec('★ 家长只看到自己那条绑定', parents.length === 1 && parents[0].parent_phone === PHONE_A,
    JSON.stringify(parents.map((p) => p.parent_phone)));
  rec('不泄露另一位监护人的手机号', !parents.some((p) => p.parent_phone === PHONE_B), JSON.stringify(parents));

  const r2 = mockRes();
  h(mockReq({ params: { id: 'stu_1' }, openid: 'admin_x', userRole: 'admin' }), r2);
  const staffParents = (r2.body && r2.body.data && r2.body.data.parents) || [];
  rec('员工仍能看到全部监护人', staffParents.length === 2, JSON.stringify(staffParents.map((p) => p.parent_phone)));
}

// ===== [4] 导出不含口令哈希 =====
console.log('\n\x1b[1m[4] 导出不含凭据字段\x1b[0m');
{
  const payload = exportData('users', { dateFrom: 0, dateTo: Date.now() });
  const rows = JSON.stringify(payload);
  rec('★ 导出内容不含 password 字段', !/"password"/.test(rows), '导出里出现了 password');
  rec('★ 导出内容不含 token_version 字段', !/"token_version"/.test(rows), '导出里出现了 token_version');
  rec('导出仍包含用户基本字段', /"role"/.test(rows) && /"phone"/.test(rows), '导出缺少 role/phone');
}

// ===== [5] 头像只收图片 =====
console.log('\n\x1b[1m[5] 头像上传类型校验\x1b[0m');
{
  const h = getHandler(authRouter, 'post', '/upload/avatar');
  // 一段纯文本 base64：长度足够，但不是任何图片格式
  const text = Buffer.from('x'.repeat(400)).toString('base64');
  const r = mockRes();
  h(mockReq({ openid: `phone_${PHONE_A}`, body: { dataUrl: `data:image/png;base64,${text}` } }), r);
  rec('★ 非图片内容被拒绝', !!(r.body && r.body.code !== 0), JSON.stringify(r.body).slice(0, 120));

  // 合法 PNG 头 + 填充
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200, 1)]);
  const r2 = mockRes();
  h(mockReq({ openid: `phone_${PHONE_A}`, body: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } }), r2);
  rec('合法 PNG 仍可上传', !!(r2.body && r2.body.code === 0 && /\.png$/.test(r2.body.data.url)), JSON.stringify(r2.body).slice(0, 120));
}

// ===== [6] 会员卡暂停仅员工可操作 =====
console.log('\n\x1b[1m[6] 会员卡暂停权限\x1b[0m');
{
  const membershipRouter = require('../routes/membership');
  db.prepare(`INSERT INTO member_cards (id, student_id, card_type_id, card_type_name, total_classes, remaining_classes, expires_at, status, created_at, updated_at)
              VALUES ('mc_1','stu_1','ct_1','月卡',12,12,?, 'active', ?, ?)`).run(t + 30 * 86400000, t, t);
  db.prepare('INSERT INTO users (id, openid, phone, nickname, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('u_coach', 'coach_x', '13700000001', '教练', 'coach', 'active', t, t);

  const h = getHandler(membershipRouter, 'post', '/pause');
  const rp = mockRes();
  h(mockReq({ body: { cardId: 'mc_1', reason: '家长自助' }, openid: `phone_${PHONE_A}`, userRole: 'parent' }), rp);
  const st = () => db.prepare("SELECT status FROM member_cards WHERE id = 'mc_1'").get().status;
  rec('★ 家长不能自助暂停（403，卡状态不变）', rp.statusCode === 403 && st() === 'active', `status=${rp.statusCode} card=${st()}`);

  const rc = mockRes();
  h(mockReq({ body: { cardId: 'mc_1', reason: '教练操作' }, openid: 'coach_x', userRole: 'coach' }), rc);
  rec('教练可以暂停', !!(rc.body && rc.body.code === 0) && st() === 'paused', `body=${JSON.stringify(rc.body).slice(0, 100)} card=${st()}`);
}

// ===== [7] 分享积分需要凭证 =====
console.log('\n\x1b[1m[7] 分享积分凭证\x1b[0m');
{
  const pointsRouter = require('../routes/points');
  const share = getHandler(pointsRouter, 'post', '/share');
  const ticketEp = getHandler(pointsRouter, 'post', '/share/ticket');

  const r0 = mockRes();
  share(mockReq({ openid: `phone_${PHONE_A}`, userRole: 'parent', body: {} }), r0);
  rec('★ 无凭证直接被拒', !!(r0.body && r0.body.code !== 0), JSON.stringify(r0.body).slice(0, 120));

  const rt = mockRes();
  ticketEp(mockReq({ openid: `phone_${PHONE_A}`, userRole: 'parent', body: {} }), rt);
  const ticket = rt.body && rt.body.data && rt.body.data.ticket;
  rec('可申请到一次性凭证', !!ticket, JSON.stringify(rt.body).slice(0, 100));

  const r1 = mockRes();
  share(mockReq({ openid: `phone_${PHONE_A}`, userRole: 'parent', body: { ticket } }), r1);
  rec('★ 持有效凭证可领取', !!(r1.body && r1.body.code === 0 && r1.body.data && r1.body.data.added > 0), JSON.stringify(r1.body).slice(0, 120));

  const r2 = mockRes();
  share(mockReq({ openid: `phone_${PHONE_A}`, userRole: 'parent', body: { ticket } }), r2);
  // 安全属性是「不能重复领分」，不是「必须报错」：凭证复用时若本周已到账，
  // 返回 duplicated 幂等成功（避免家长被误导为"凭证失效"而反复重新分享），但 added 必须为 0。
  rec('★ 同一凭证不能重复领分（added=0 且标记 duplicated）',
    !!(r2.body && r2.body.code === 0 && r2.body.data && r2.body.data.added === 0 && r2.body.data.duplicated === true),
    JSON.stringify(r2.body).slice(0, 120));

  // 他人拿到凭证也不能用
  const rt2 = mockRes();
  ticketEp(mockReq({ openid: `phone_${PHONE_A}`, userRole: 'parent', body: {} }), rt2);
  const t2 = rt2.body && rt2.body.data && rt2.body.data.ticket;
  const r3 = mockRes();
  share(mockReq({ openid: `phone_${PHONE_B}`, userRole: 'parent', body: { ticket: t2 } }), r3);
  rec('★ 凭证与账号绑定（他人不可用）', !!(r3.body && r3.body.code !== 0), JSON.stringify(r3.body).slice(0, 120));
}

// ===== [8] 零价已付订单留痕 =====
console.log('\n\x1b[1m[8] 零价已付订单留痕\x1b[0m');
{
  const h = getHandler(ordersRouter, 'post', '/');
  const r = mockRes();
  h(mockReq({
    userRole: 'admin', openid: 'admin_x',
    body: { studentId: 'stu_1', orderType: 'membership', items: [{ itemType: 'membershipCard', itemName: '体验课', quantity: 1, unitPrice: 0 }], overrideAmount: 0, status: 'paid' },
  }), r);
  const created = r.body && r.body.data && (r.body.data.id || r.body.data.orderId);
  rec('零价已付订单可以创建（无需审批）', !!created, JSON.stringify(r.body).slice(0, 160));

  const row = created
    ? db.prepare("SELECT after_state FROM audit_log WHERE entity = 'order' AND entity_id = ? AND action = 'create'").get(created)
    : null;
  const after = row ? JSON.parse(row.after_state) : {};
  rec('★ 审计标记 zeroAmount', after.zeroAmount === true, JSON.stringify(after));
  rec('★ 审计标记 zeroAmountPaid', after.zeroAmountPaid === true, JSON.stringify(after));
  rec('审计保留原始标价便于对账', after.totalAmount === 0 && after.payableAmount === 0, JSON.stringify(after));
}

console.log(`\n\x1b[1m结果汇总：PASS ${pass}  FAIL ${fail}\x1b[0m`);
db.close();
process.exit(fail > 0 ? 1 : 0);
