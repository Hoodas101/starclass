/**
 * 混沌 / 压力回归（离线，隔离库）—— v1.0.9 新增能力
 *
 * 只打**本轮新写的代码面**，因为新代码的风险密度最高：
 *  1. 批量补课：同批重复学员 / 重复调用 / 超容量 / 参数边界 —— 不得产生重复记录或超员
 *  2. R1 口径：销售视角看不到生日与累计消费，管理员视角正常
 *  3. 会员卡转让：不可转让卡种被拒、转给原持卡人被拒、转让后归属正确
 *
 * 运行：node tests/chaos-v109.cjs
 */
process.env.DB_PATH = '/tmp/chaos_v109_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/chaos_v109_test.db', '/tmp/chaos_v109_test.db-wal', '/tmp/chaos_v109_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const makeupRouter = require('../routes/makeup');
const studentsRouter = require('../routes/students');
const membershipRouter = require('../routes/membership');

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

// ── 造数 ──
db.transaction(() => {
  const insUser = db.prepare('INSERT INTO users (id, openid, phone, nickname, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  insUser.run('u_admin', 'admin_x', '13700000000', '管理员', 'admin', 'active', t, t);
  insUser.run('u_sales', 'sales_x', '13700000009', '销售', 'sales', 'active', t, t);
  db.prepare(`INSERT INTO courses (id, name, category, description, duration, consume_classes, color, is_active, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('c1', '测试课', '篮球', '', 60, 1, '#409EFF', 1, t);

  const insStu = db.prepare('INSERT INTO students (id, name, gender, birthday, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 1; i <= 6; i++) insStu.run(`stu_${i}`, `学员${i}`, '男', '2015-03-15', 'active', String(t), t, t);

  // 原排期（已发生）+ 补课排期（容量 3）
  const insSch = db.prepare(`INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time, status, max_students, enrolled_count, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insSch.run('sch_orig', 'c1', '测试课', 'coach_x', '教练', '2026-10-20', '09:00', '10:00', 'scheduled', 20, 6, t, t);
  insSch.run('sch_makeup', 'c1', '测试课', 'coach_x', '教练', '2026-10-25', '09:00', '10:00', 'scheduled', 3, 0, t, t);

  // 6 名学员在原排期全部缺席
  const insAtt = db.prepare(`INSERT INTO attendances (id, schedule_id, student_id, student_name, date, status, checkin_time, created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= 6; i++) insAtt.run(`att_${i}`, 'sch_orig', `stu_${i}`, `学员${i}`, '2026-10-20', 'absent', t, t);

  // 卡种：可转让 / 不可转让
  db.prepare(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, transferable, refundable, is_active, product_type, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('ct_yes', '可转让年卡', 0, 365, 'time', 0, 1000, 1, 1, 1, 'membership', t);
  db.prepare(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, transferable, refundable, is_active, product_type, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('ct_no', '不可转让次卡', 12, 365, 'count', 0, 600, 0, 1, 1, 'membership', t);
  db.prepare(`INSERT INTO member_cards (id, student_id, student_name, card_type_id, card_type_name, billing_mode, total_classes, remaining_classes, expires_at, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('mc_yes', 'stu_1', '学员1', 'ct_yes', '可转让年卡', 'time', 0, 0, t + 300 * 86400000, 'active', t, t);
  db.prepare(`INSERT INTO member_cards (id, student_id, student_name, card_type_id, card_type_name, billing_mode, total_classes, remaining_classes, expires_at, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('mc_no', 'stu_2', '学员2', 'ct_no', '不可转让次卡', 'count', 12, 12, t + 300 * 86400000, 'active', t, t);
})();

const batchAssign = getHandler(makeupRouter, 'post', '/batch-assign');
const callBatch = (body) => {
  const r = mockRes();
  batchAssign(mockReq({ userRole: 'admin', openid: 'admin_x', body }), r);
  return r.body;
};
const makeupCount = (sid) => db.prepare("SELECT COUNT(*) c FROM makeup_records WHERE student_id = ? AND status != 'cancelled'").get(sid).c;

console.log('\n\x1b[1m=== 混沌 / 压力回归（v1.0.9 新能力）===\x1b[0m\n');

// ===== [1] 批量补课：参数边界 =====
console.log('\x1b[1m[1] 批量补课参数边界\x1b[0m');
{
  rec('空数组被拒', callBatch({ makeupScheduleId: 'sch_makeup', studentIds: [] }).code !== 0, '');
  rec('非数组被拒', callBatch({ makeupScheduleId: 'sch_makeup', studentIds: 'stu_1' }).code !== 0, '');
  rec('缺补课排期被拒', callBatch({ studentIds: ['stu_1'] }).code !== 0, '');
  const many = Array.from({ length: 201 }, (_, i) => `x${i}`);
  rec('超过 200 人被拒', callBatch({ makeupScheduleId: 'sch_makeup', studentIds: many }).code !== 0, '');
  rec('以上均未产生记录', db.prepare('SELECT COUNT(*) c FROM makeup_records').get().c === 0,
    String(db.prepare('SELECT COUNT(*) c FROM makeup_records').get().c));
}

// ===== [2] 同批重复学员：只能成功一次 =====
console.log('\x1b[1m[2] 同批重复学员（幂等）\x1b[0m');
{
  const body = callBatch({ originalScheduleId: 'sch_orig', makeupScheduleId: 'sch_makeup', studentIds: ['stu_1', 'stu_1', 'stu_1'] });
  rec('★ 同一学员出现 3 次只成功 1 次', body.code === 0 && body.data.ok === 1 && body.data.failed === 2,
    JSON.stringify(body.data).slice(0, 160));
  rec('★ 只落 1 条补课记录', makeupCount('stu_1') === 1, String(makeupCount('stu_1')));
}

// ===== [3] 重复调用：不重复落库 =====
console.log('\x1b[1m[3] 重复调用（幂等）\x1b[0m');
{
  const again = callBatch({ originalScheduleId: 'sch_orig', makeupScheduleId: 'sch_makeup', studentIds: ['stu_1'] });
  rec('★ 已安排过的学员再次提交 → 失败且不新增', again.code === 0 && again.data.ok === 0 && makeupCount('stu_1') === 1,
    JSON.stringify(again.data).slice(0, 160));
}

// ===== [4] 容量闸：不超员 =====
console.log('\x1b[1m[4] 容量闸\x1b[0m');
{
  // sch_makeup 容量 3，已用 1 → 再提交 5 人，应只成功 2
  const body = callBatch({ originalScheduleId: 'sch_orig', makeupScheduleId: 'sch_makeup', studentIds: ['stu_2', 'stu_3', 'stu_4', 'stu_5', 'stu_6'] });
  const enrolled = db.prepare("SELECT enrolled_count FROM schedules WHERE id = 'sch_makeup'").get().enrolled_count;
  rec('★ 超容量时只放行剩余名额', body.code === 0 && body.data.ok === 2, JSON.stringify(body.data).slice(0, 160));
  rec('★ enrolled_count 未超过 max_students', enrolled === 3, `enrolled=${enrolled} max=3`);
  rec('失败原因明确（已满）', (body.data.results || []).some((r) => !r.ok && /已满/.test(r.reason || '')),
    JSON.stringify((body.data.results || []).filter((r) => !r.ok).slice(0, 1)));
}

// ===== [5] 缺勤记录校验不可绕过 =====
console.log('\x1b[1m[5] 无缺席记录不得补课\x1b[0m');
{
  const body = callBatch({ originalScheduleId: 'sch_makeup', makeupScheduleId: 'sch_makeup', studentIds: ['stu_1'] });
  rec('★ 原排期没有缺席记录 → 拒绝', body.code === 0 && body.data.ok === 0, JSON.stringify(body.data).slice(0, 160));
  const noOrig = callBatch({ makeupScheduleId: 'sch_makeup', studentIds: ['stu_1'] });
  rec('★ 不传原排期 → 拒绝（不能绕过校验）', noOrig.code === 0 && noOrig.data.ok === 0, JSON.stringify(noOrig.data).slice(0, 160));
}

// ===== [6] R1：销售视角脱敏 =====
console.log('\n\x1b[1m[6] R1 销售视角脱敏\x1b[0m');
{
  db.prepare(`INSERT INTO orders (id, order_no, student_id, student_name, items, total_amount, discount_amount, payable_amount, order_type, status, paid_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ord_1', 'R1-1', 'stu_3', '学员3', '[]', 999, 0, 999, 'membership', 'paid', t, t, t);

  const list = getHandler(studentsRouter, 'get', '/');
  const asSales = mockRes();
  list(mockReq({ userRole: 'sales', openid: 'sales_x', query: { page: 1, pageSize: 50 } }), asSales);
  const sRow = ((asSales.body?.data?.list) || []).find((r) => r.id === 'stu_3');
  rec('★ 销售看到生日为 null', sRow && sRow.birthday === null, JSON.stringify(sRow || {}).slice(0, 120));
  rec('★ 销售看到累计消费为 null', sRow && sRow.total_spent === null, JSON.stringify(sRow || {}).slice(0, 120));
  rec('销售仍能看到姓名与家长手机字段', !!sRow && sRow.name === '学员3' && 'parent_phone' in sRow, JSON.stringify(sRow || {}).slice(0, 120));

  // 详情接口必须与列表同口径：只脱敏列表等于没做
  const detail = getHandler(studentsRouter, 'get', '/:id');
  const dSales = mockRes();
  detail(mockReq({ params: { id: 'stu_3' }, userRole: 'sales', openid: 'sales_x' }), dSales);
  rec('★ 销售在详情里也看不到生日', dSales.body?.data?.birthday === null, JSON.stringify(dSales.body?.data || {}).slice(0, 100));

  const asAdmin = mockRes();
  list(mockReq({ userRole: 'admin', openid: 'admin_x', query: { page: 1, pageSize: 50 } }), asAdmin);
  const aRow = ((asAdmin.body?.data?.list) || []).find((r) => r.id === 'stu_3');
  rec('管理员能看到生日', !!aRow && aRow.birthday === '2015-03-15', JSON.stringify(aRow || {}).slice(0, 120));
  rec('管理员能看到累计消费', !!aRow && Number(aRow.total_spent) === 999, JSON.stringify(aRow || {}).slice(0, 120));
}

// ===== [7] 会员卡转让 =====
console.log('\n\x1b[1m[7] 会员卡转让\x1b[0m');
{
  const transfer = getHandler(membershipRouter, 'post', '/card/:id/transfer');
  const doTransfer = (cardId, toStudentId) => {
    const r = mockRes();
    transfer(mockReq({ params: { id: cardId }, userRole: 'admin', openid: 'admin_x', body: { toStudentId } }), r);
    return r.body;
  };

  rec('★ 不可转让卡种被拒', doTransfer('mc_no', 'stu_5').code !== 0, '');
  rec('★ 转给原持卡人被拒', doTransfer('mc_yes', 'stu_1').code !== 0, '');
  rec('受让人不存在被拒', doTransfer('mc_yes', 'stu_not_exist').code !== 0, '');

  const ok = doTransfer('mc_yes', 'stu_4');
  rec('可转让卡成功易主', ok.code === 0, JSON.stringify(ok).slice(0, 120));
  const owner = db.prepare("SELECT student_id, student_name FROM member_cards WHERE id = 'mc_yes'").get();
  rec('★ 归属已更新为受让人', owner.student_id === 'stu_4' && owner.student_name === '学员4', JSON.stringify(owner));

  const log = db.prepare("SELECT COUNT(*) c FROM card_transfer_logs WHERE card_id = 'mc_yes'").get().c;
  rec('★ 留了转让流水（可追溯）', log >= 1, `logs=${log}`);

  // 注意：转让后「原持卡人」已是第三人，再转回给他属于合法的二次转让，不应被拒；
  // 真正该拒的是「转给当前持卡人自己」。
  rec('★ 转给当前持卡人被拒', doTransfer('mc_yes', 'stu_4').code !== 0, '');
}

console.log(`\n\x1b[1m结果汇总：PASS ${pass}  FAIL ${fail}\x1b[0m`);
db.close();
process.exit(fail > 0 ? 1 : 0);
