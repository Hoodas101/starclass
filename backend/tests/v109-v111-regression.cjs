/**
 * v1.0.9 ~ v1.0.11 外部审计项回归（离线，隔离库）
 *
 * 覆盖的都是「守卫生效但边界漏网」类缺陷 —— 不抛异常、只让数据或权限悄悄出错：
 *  1. 线索横向越权：他人名下的线索不可改 / 不可删 / 不可看建议
 *  2. 性别值域：建档 / 编辑 / 导入 三条路径同口径（此前只有建档校验）
 *  3. 姓名长度上限 50 字（此前 PUT 与导入是绕过通道）
 *  4. 下单 items 负单价 / 超大金额 / 非法数量穿透
 *  5. 删除学员后不留「有余额、无流水」的僵尸积分账户
 *  6. 已取消排期不允许再点名（否则二次扣课、二次发分）
 *
 * 运行：node tests/v109-v111-regression.cjs
 */
process.env.DB_PATH = '/tmp/v109_v111_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/v109_v111_test.db', '/tmp/v109_v111_test.db-wal', '/tmp/v109_v111_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const studentsRouter = require('../routes/students');
const ordersRouter = require('../routes/orders');
const growthRouter = require('../routes/growth');
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

// ── 造数：管理员 / 销售A / 销售B / 学员 / 线索 ──
db.transaction(() => {
  const insUser = db.prepare('INSERT INTO users (id, openid, phone, nickname, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  insUser.run('u_admin', 'admin_x', '13700000000', '管理员', 'admin', 'active', t, t);
  insUser.run('u_sa', 'sales_a', '13700000001', '销售A', 'sales', 'active', t, t);
  insUser.run('u_sb', 'sales_b', '13700000002', '销售B', 'sales', 'active', t, t);
  db.prepare('INSERT INTO students (id, name, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('stu_1', '测试学员', 'active', String(t), t, t);
  const insLead = db.prepare(`INSERT INTO leads (id, name, phone, source, stage, intent_level, note, salesperson, student_id, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insLead.run('lead_a', 'A的线索', '13800001111', 'natural', 'new', 3, '', '销售A', '', 'active', t, t);
  insLead.run('lead_b', 'B的线索', '13800002222', 'natural', 'new', 3, '', '销售B', '', 'active', t, t);
  db.prepare(`INSERT INTO points (id, student_id, student_name, total_earned, balance, updated_at) VALUES (?,?,?,?,?,?)`)
    .run('pts_1', 'stu_1', '测试学员', 100, 100, t);
  db.prepare(`INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('pl_1', 'stu_1', 'earn', 100, 100, '初始', 'ref_1', '', t);
})();

console.log('\n\x1b[1m=== v1.0.9~v1.0.11 审计项回归 ===\x1b[0m\n');

// ===== [1] 线索横向越权 =====
console.log('\x1b[1m[1] 线索归属校验\x1b[0m');
{
  const put = getHandler(growthRouter, 'put', '/leads/:id');
  const del = getHandler(growthRouter, 'delete', '/leads/:id');
  const sug = getHandler(growthRouter, 'get', '/leads/:id/suggestion');

  const r1 = mockRes();
  put(mockReq({ params: { id: 'lead_b' }, openid: 'sales_a', userRole: 'sales', body: { name: '被篡改' } }), r1);
  rec('★ 销售A 不能改销售B 的线索（403）', r1.statusCode === 403, `status=${r1.statusCode} body=${JSON.stringify(r1.body).slice(0, 100)}`);

  const r2 = mockRes();
  del(mockReq({ params: { id: 'lead_b' }, openid: 'sales_a', userRole: 'sales' }), r2);
  rec('★ 销售A 不能删销售B 的线索（403）', r2.statusCode === 403, `status=${r2.statusCode}`);
  rec('线索未被删除', !!db.prepare("SELECT 1 FROM leads WHERE id = 'lead_b'").get(), 'lead_b 已被删');

  const r3 = mockRes();
  sug(mockReq({ params: { id: 'lead_b' }, openid: 'sales_a', userRole: 'sales' }), r3);
  rec('★ 销售A 不能看销售B 的线索建议（403）', r3.statusCode === 403, `status=${r3.statusCode}`);

  const r4 = mockRes();
  put(mockReq({ params: { id: 'lead_a' }, openid: 'sales_a', userRole: 'sales', body: { note: '自己的线索' } }), r4);
  rec('自己的线索可以改', r4.body && r4.body.code === 0, JSON.stringify(r4.body).slice(0, 120));

  const r5 = mockRes();
  put(mockReq({ params: { id: 'lead_b' }, openid: 'admin_x', userRole: 'admin', body: { note: '管理员' } }), r5);
  rec('管理员可改任意线索', r5.body && r5.body.code === 0, JSON.stringify(r5.body).slice(0, 120));
}

// ===== [2][3] 姓名 / 性别 值域（POST / PUT）=====
console.log('\n\x1b[1m[2] 成员姓名与性别值域\x1b[0m');
{
  const post = getHandler(studentsRouter, 'post', '/');
  const put = getHandler(studentsRouter, 'put', '/:id');

  const cases = [
    ['gender=hacker 被拒', { name: '非法性别', gender: 'hacker' }, false],
    ['gender=male 被拒（生产口径只有男/女）', { name: '英文性别', gender: 'male' }, false],
    ['gender=男 放行', { name: '合法性别', gender: '男' }, true],
    ['gender 留空放行', { name: '未填性别', gender: '' }, true],
    ['51 字姓名被拒', { name: '张'.repeat(51), gender: '男' }, false],
    ['50 字姓名放行', { name: '张'.repeat(50), gender: '男' }, true],
  ];
  for (const [label, body, expectOk] of cases) {
    const r = mockRes();
    post(mockReq({ userRole: 'admin', openid: 'admin_x', body: { ...body, confirmDuplicate: true } }), r);
    const ok = r.body && r.body.code === 0;
    rec(`建档：${label}`, ok === expectOk, JSON.stringify(r.body).slice(0, 120));
  }

  // PUT 是此前的主要绕过通道
  const rp1 = mockRes();
  put(mockReq({ params: { id: 'stu_1' }, openid: 'admin_x', userRole: 'admin', body: { gender: 'hacker' } }), rp1);
  rec('★ 编辑：gender=hacker 被拒（PUT 曾可绕过）', rp1.body && rp1.body.code !== 0, JSON.stringify(rp1.body).slice(0, 120));

  const rp2 = mockRes();
  put(mockReq({ params: { id: 'stu_1' }, openid: 'admin_x', userRole: 'admin', body: { name: '张'.repeat(51) } }), rp2);
  rec('★ 编辑：51 字姓名被拒', rp2.body && rp2.body.code !== 0, JSON.stringify(rp2.body).slice(0, 120));

  const rp3 = mockRes();
  put(mockReq({ params: { id: 'stu_1' }, openid: 'admin_x', userRole: 'admin', body: { gender: '女' } }), rp3);
  rec('编辑：合法性别放行', rp3.body && rp3.body.code === 0, JSON.stringify(rp3.body).slice(0, 120));
}

// ===== [4] 下单金额值域 =====
console.log('\n\x1b[1m[3] 下单金额 / 数量值域\x1b[0m');
{
  const post = getHandler(ordersRouter, 'post', '/');
  const mk = (item) => ({
    userRole: 'admin', openid: 'admin_x',
    body: { studentId: 'stu_1', orderType: 'membership', status: 'pending', items: [{ itemType: 'product', itemName: '测试', ...item }] },
  });
  const bad = [
    ['负单价', { unitPrice: -5, quantity: 1 }],
    ['超大单价', { unitPrice: 1e308, quantity: 1 }],
    ['数量为 0', { unitPrice: 100, quantity: 0 }],
    ['负数量', { unitPrice: 100, quantity: -3 }],
    ['数量超上限', { unitPrice: 100, quantity: 10000 }],
  ];
  for (const [label, item] of bad) {
    const r = mockRes();
    post(mockReq(mk(item)), r);
    rec(`★ ${label} 被拒`, r.body && r.body.code !== 0, JSON.stringify(r.body).slice(0, 120));
  }
  const rOk = mockRes();
  post(mockReq(mk({ unitPrice: 199, quantity: 2 })), rOk);
  rec('合法单价/数量放行', rOk.body && rOk.body.code === 0, JSON.stringify(rOk.body).slice(0, 120));
}

// ===== [5] 删除学员清积分账户 =====
console.log('\n\x1b[1m[4] 删除学员后的账实一致\x1b[0m');
{
  const del = getHandler(studentsRouter, 'delete', '/:id');
  const r = mockRes();
  del(mockReq({ params: { id: 'stu_1' }, openid: 'admin_x', userRole: 'admin' }), r);
  rec('删除成功', r.body && r.body.code === 0, JSON.stringify(r.body).slice(0, 120));
  const acc = db.prepare("SELECT COUNT(*) c FROM points WHERE student_id = 'stu_1'").get().c;
  const logs = db.prepare("SELECT COUNT(*) c FROM point_logs WHERE student_id = 'stu_1'").get().c;
  rec('★ 积分账户与流水同删（不留有余额无流水的僵尸账户）', acc === 0 && logs === 0, `points=${acc} logs=${logs}`);
}

// ===== [6] 已取消排期不能点名 =====
console.log('\n\x1b[1m[5] 已取消排期点名守卫\x1b[0m');
{
  db.prepare('INSERT INTO students (id, name, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('stu_2', '点名学员', 'active', String(t), t, t);
  // schedules.course_id 有外键约束，先建一门课
  db.prepare(`INSERT INTO courses (id, name, category, description, duration, consume_classes, color, is_active, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('c1', '测试课', '篮球', '', 60, 1, '#409EFF', 1, t);
  db.prepare(`INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time, status, enrolled_count, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('sch_c', 'c1', '测试课', 'coach_x', '教练', '2026-10-20', '09:00', '10:00', 'cancelled', 1, t, t);

  const h = getHandler(checkinRouter, 'post', '/teacher');
  const r = mockRes();
  h(mockReq({
    userRole: 'admin', openid: 'admin_x',
    body: { scheduleId: 'sch_c', attendances: [{ studentId: 'stu_2', status: 'present' }] },
  }), r);
  rec('★ 已取消排期点名被拒', r.body && r.body.code !== 0, JSON.stringify(r.body).slice(0, 120));
  const att = db.prepare("SELECT COUNT(*) c FROM attendances WHERE schedule_id = 'sch_c'").get().c;
  rec('未写入幽灵考勤', att === 0, `attendances=${att}`);
}

console.log(`\n\x1b[1m结果汇总：PASS ${pass}  FAIL ${fail}\x1b[0m`);
db.close();
process.exit(fail > 0 ? 1 : 0);
