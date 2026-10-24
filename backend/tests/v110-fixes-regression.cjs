/**
 * v1.0.11 修复回归（离线，隔离库）
 *
 * 对应 2026-10-23/24 四份外部报告的核心项。每条都对应一个「守卫生效但边界漏网」的真实缺陷：
 *  H1 销售可无上限发积分      → 奖励积分仅管理员、且有上限
 *  H2 totalPrice 被信任        → 入库前服务端重算
 *  H3 status/discount 不校验   → 白名单 + 数值区间
 *  H4 quantity>1 只发一份权益  → 按数量展开卡与积分
 *  F1 建档权限口径矛盾         → 管理员+销售可建、教练不可
 *  F5 批量点名丢弃成功明细     → 部分拒绝也带回逐人结果
 *  M3 跟进任务无归属校验       → 非本人不可完成/取消
 *
 * 运行：node tests/v110-fixes-regression.cjs
 */
process.env.DB_PATH = '/tmp/v110_fixes_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/v110_fixes_test.db', '/tmp/v110_fixes_test.db-wal', '/tmp/v110_fixes_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const ordersRouter = require('../routes/orders');
const studentsRouter = require('../routes/students');
const growthRouter = require('../routes/growth');
const followupsRouter = require('../routes/followups');
const checkinRouter = require('../routes/checkin');

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

// ── 夹具 ──
db.transaction(() => {
  const insUser = db.prepare('INSERT INTO users (id, openid, phone, nickname, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  insUser.run('u_admin', 'admin_x', '13700000000', '管理员', 'admin', 'active', t, t);
  insUser.run('u_sales', 'sales_x', '13700000001', '销售甲', 'sales', 'active', t, t);
  insUser.run('u_sales2', 'sales_y', '13700000002', '销售乙', 'sales', 'active', t, t);
  insUser.run('u_coach', 'coach_x', '13700000003', '教练丙', 'coach', 'active', t, t);

  db.prepare('INSERT INTO students (id, name, gender, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('stu_1', '测试学员', '男', 'active', String(t), t, t);

  // 卡种：24 次次卡，赠 288 分
  db.prepare(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price,
    transferable, refundable, is_active, product_type, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('ct_1', '24次卡', 24, 365, 'count', 288, 2880, 1, 1, 1, 'membership', t);

  db.prepare(`INSERT INTO leads (id, name, phone, source, stage, intent_level, note, salesperson, student_id, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('lead_1', '线索甲', '13800001111', 'natural', 'new', 3, '', '销售甲', 'stu_1', 'active', t, t);

  db.prepare(`INSERT INTO follow_ups (id, target_type, target_id, target_name, phone, task_type, reason, owner, due_at, priority, status, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('fu_1', 'lead', 'lead_1', '线索甲', '13800001111', 'follow', '', '销售乙', t, 0, 'pending', '', t);
})();

console.log('\n\x1b[1m=== v1.0.11 修复回归 ===\x1b[0m\n');

const createOrder = getHandler(ordersRouter, 'post', '/');
const makeOrder = (body, role = 'admin', openid = 'admin_x') => {
  const r = mockRes();
  createOrder(mockReq({ userRole: role, openid, body }), r);
  return r.body;
};

// ===== [1] H3 状态 / 折扣 =====
console.log('\x1b[1m[1] H3 订单状态与折扣校验\x1b[0m');
{
  const bad = makeOrder({ studentId: 'stu_1', cardTypeId: 'ct_1', status: 'refunded' });
  rec('★ status=refunded 被拒（退款须走退款接口）', bad && bad.code !== 0, JSON.stringify(bad).slice(0, 120));

  const nan = makeOrder({ studentId: 'stu_1', cardTypeId: 'ct_1', discountAmount: 'abc' });
  rec('★ discountAmount="abc" 被拒（此前会写入 NULL 应付）', nan && nan.code !== 0, JSON.stringify(nan).slice(0, 120));

  const over = makeOrder({ studentId: 'stu_1', cardTypeId: 'ct_1', discountAmount: 99999 });
  rec('折扣大于总额被拒', over && over.code !== 0, JSON.stringify(over).slice(0, 120));
}

// ===== [2] H2 totalPrice 服务端重算 =====
console.log('\n\x1b[1m[2] H2 totalPrice 不被信任\x1b[0m');
{
  const ok = makeOrder({
    studentId: 'stu_1', orderType: 'retail', status: 'pending',
    items: [{ itemType: 'goods', itemId: 'ct_1', itemName: '测试商品', quantity: 1, unitPrice: 100, totalPrice: 999999 }],
  });
  const ord = db.prepare("SELECT items, total_amount FROM orders WHERE id = ?").get(ok.data.orderId);
  const item = JSON.parse(ord.items)[0];
  rec('★ 入库 totalPrice 被重算为 unitPrice×qty', Number(item.totalPrice) === 100, `totalPrice=${item.totalPrice}`);
  rec('订单总额按重算值计算', Number(ord.total_amount) === 100, `total=${ord.total_amount}`);
}

// ===== [3] H4 quantity 展开 =====
console.log('\n\x1b[1m[3] H4 一单多件按数量发权益\x1b[0m');
{
  const r = makeOrder({
    studentId: 'stu_1', orderType: 'membership', status: 'paid',
    items: [{ itemType: 'membershipCard', itemId: 'ct_1', itemName: '24次卡', quantity: 2, unitPrice: 2880 }],
  });
  const orderId = r.data.orderId;
  const cards = db.prepare('SELECT COUNT(*) c FROM member_cards WHERE order_id = ?').get(orderId).c;
  const total = db.prepare('SELECT COALESCE(SUM(total_classes),0) s FROM member_cards WHERE order_id = ?').get(orderId).s;
  rec('★ quantity=2 发出 2 张卡', cards === 2, `cards=${cards}`);
  rec('★ 总课时为 48（2×24）', Number(total) === 48, `total=${total}`);

  const pts = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM point_logs WHERE student_id = ? AND type = ?').get('stu_1', 'earn').s;
  rec('★ 积分按数量发放（2×288=576）', Number(pts) === 576, `points=${pts}`);
}

// ===== [4] F1 建档权限 =====
console.log('\n\x1b[1m[4] F1 建档权限口径\x1b[0m');
{
  const createStudent = getHandler(studentsRouter, 'post', '/');
  const asCoach = mockRes();
  createStudent(mockReq({ userRole: 'coach', openid: 'coach_x', body: { name: '教练建档' } }), asCoach);
  rec('★ 教练不可建档（403）', asCoach.statusCode === 403, `status=${asCoach.statusCode}`);

  const asSales = mockRes();
  createStudent(mockReq({ userRole: 'sales', openid: 'sales_x', body: { name: '销售建档', gender: '男' } }), asSales);
  rec('★ 销售可建档（与 DEFAULT_PERMS 对齐）', asSales.body && asSales.body.code === 0, JSON.stringify(asSales.body).slice(0, 120));

  const badGender = mockRes();
  createStudent(mockReq({ userRole: 'sales', openid: 'sales_x', body: { name: '脏性别', gender: 'hacker' } }), badGender);
  rec('销售建档仍受性别白名单约束', badGender.body && badGender.body.code !== 0, JSON.stringify(badGender.body).slice(0, 120));
}

// ===== [5] H1 奖励积分 =====
console.log('\n\x1b[1m[5] H1 成交奖励积分限管理员\x1b[0m');
{
  const convert = getHandler(growthRouter, 'post', '/leads/:id/convert');
  const r = mockRes();
  convert(mockReq({ params: { id: 'lead_1' }, userRole: 'sales', openid: 'sales_x', body: { rewardPoints: 999999999 } }), r);
  rec('★ 销售不能自行发放奖励积分（403）', r.statusCode === 403, `status=${r.statusCode} body=${JSON.stringify(r.body).slice(0, 120)}`);
  const bal = db.prepare('SELECT balance FROM points WHERE student_id = ?').get('stu_1');
  rec('★ 未产生任何积分变动', !bal || Number(bal.balance) === 576, `balance=${bal && bal.balance}`);
}

// ===== [6] F5 批量点名明细 =====
console.log('\n\x1b[1m[6] F5 部分拒绝仍返回逐人明细\x1b[0m');
{
  db.prepare(`INSERT INTO courses (id, name, category, description, duration, consume_classes, color, is_active, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('c1', '测试课', '篮球', '', 60, 1, '#409EFF', 1, t);
  db.prepare(`INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time, status, enrolled_count, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('sch_1', 'c1', '测试课', 'coach_x', '教练丙', '2026-10-26', '09:00', '10:00', 'scheduled', 2, t, t);
  db.prepare('INSERT INTO students (id, name, gender, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('stu_2', '学员二', '女', 'active', String(t), t, t);

  const teacher = getHandler(checkinRouter, 'post', '/teacher');
  const r = mockRes();
  teacher(mockReq({
    userRole: 'admin', openid: 'admin_x',
    body: {
      scheduleId: 'sch_1',
      attendances: [
        { studentId: 'stu_2', status: 'present' },
        { studentId: 'stu_1', status: 'bogus' },
      ],
    },
  }), r);
  rec('★ 部分拒绝时 code=2', r.body && r.body.code === 2, JSON.stringify(r.body).slice(0, 160));
  rec('★ data.results 带回逐人明细（不再为 null）', !!(r.body && r.body.data && Array.isArray(r.body.data.results)),
    JSON.stringify(r.body && r.body.data).slice(0, 160));
  const acc = (r.body && r.body.data && r.body.data.results || []).filter((x) => x.status === 'present').length;
  rec('★ 明细里能看到已签成功的那一位', acc === 1, `present=${acc}`);
}

// ===== [7] M3 跟进任务归属 =====
console.log('\n\x1b[1m[7] M3 跟进任务归属校验\x1b[0m');
{
  const complete = getHandler(followupsRouter, 'post', '/:id/complete');
  const r = mockRes();
  complete(mockReq({ params: { id: 'fu_1' }, userRole: 'sales', openid: 'sales_x', body: {} }), r);
  rec('★ 不能完成他人名下的任务（403）', r.statusCode === 403, `status=${r.statusCode}`);
  const st = db.prepare("SELECT status FROM follow_ups WHERE id = 'fu_1'").get().status;
  rec('任务状态未被改动', st === 'pending', `status=${st}`);

  const r2 = mockRes();
  complete(mockReq({ params: { id: 'fu_1' }, userRole: 'sales', openid: 'sales_y', body: {} }), r2);
  rec('本人可完成自己的任务', r2.body && r2.body.code === 0, JSON.stringify(r2.body).slice(0, 120));
}

console.log(`\n\x1b[1m结果汇总：PASS ${pass}  FAIL ${fail}\x1b[0m`);
db.close();
process.exit(fail > 0 ? 1 : 0);
