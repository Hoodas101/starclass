/**
 * v1.0.4 修复项回归测试（离线，隔离库）
 *
 * 覆盖本轮 5 项 P1 补丁（对应审计报告 starclass-p1-fixes-20261006）：
 *  1) 卡种更新接口补参数校验：validDays/totalClasses 显式传入必须为正整数；切换计费模式必须补齐必填项；
 *     仅传 price 时不误伤（部分更新语义）。
 *  2) 订单批量导入真正发卡：items 补 itemId → member_cards 落地；项目名查不到时记入 warnings 而非静默成功。
 *  3) 学员导入补日期校验：2018-02-30 / 2018/1/5 等非法日期拦截，合法行照常入库。
 *  4) 删除学员清理孤儿家长账号：采集顺序在删绑定之前；多孩共用账号不误删；仅 phone_ 前缀。
 *  5) 家长端取卡口径与扣课口径统一：首页不展示「active 但已过期」的卡；会员中心补 display_status/is_usable。
 *
 * 运行：node tests/v104-fixes-regression.cjs
 */
process.env.DB_PATH = '/tmp/v104_fixes_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/v104_fixes_test.db', '/tmp/v104_fixes_test.db-wal', '/tmp/v104_fixes_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const membershipRouter = require('../routes/membership');
const ordersRouter = require('../routes/orders');
const studentsRouter = require('../routes/students');
const adminRouter = require('../routes/admin');
const { pickCardForDeduction } = require('../utils/deduction');
const { scanDirtyData, applyCleanup } = require('../utils/data-health');

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
const future = t + 90 * 86400000;
const past = t - 30 * 86400000;

const seed = db.transaction(() => {
  const ins = (sql, ...p) => db.prepare(sql).run(...p);
  ins('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_admin', 'admin_x', '管理员', 'admin', 'x', 'active', '', t, t);
  ins('INSERT INTO users (id, openid, nickname, role, password, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_sales', 'sales_x', '销售X', 'sales', 'x', 'active', '', t, t);
  // 卡种：时效卡（用于更新校验）+ 次数卡（用于导入发卡）
  ins(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, is_active, product_type, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'ct_time', '测试时效卡', 0, 365, 'time', 0, 1000, '全活动通用', 1, 1, 1, 'membership', t);
  ins(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, is_active, product_type, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'ct_count', '导入测试次卡', 10, 0, 'count', 0, 500, '全活动通用', 0, 1, 1, 'membership', t);
  // 订单导入所需学员（含家长绑定，便于按姓名匹配）
  ins('INSERT INTO students (id, name, status, created_at, updated_at) VALUES (?,?,?,?,?)', 'stu_imp', '导入学员', 'active', t, t);
  ins(`INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
       VALUES (?,?,?,?,?,?,1,?)`, 'stu_imp', '导入学员', '导入家长', 'phone_13700000001', '13700000001', '家长', t);
  // P1-5：一张「status=active 但已过期」的卡 + 家长绑定
  ins('INSERT INTO students (id, name, status, created_at, updated_at) VALUES (?,?,?,?,?)', 'stu_exp', '过期卡学员', 'active', t, t);
  ins(`INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
       VALUES (?,?,?,?,?,?,1,?)`, 'stu_exp', '过期卡学员', '过期家长', 'phone_13700000002', '13700000002', '家长', t);
  ins(`INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'mc_exp', 'ct_count', '导入测试次卡', 'count', 'stu_exp', '过期卡学员', 10, 5, 5, past - 86400000, past, 'active', t, t);
});
seed();

console.log('\n\x1b[1m=== v1.0.4 修复项回归测试 ===\x1b[0m\n');

// [1] 卡种更新接口参数校验
console.log('\x1b[1m[1] 卡种更新接口参数校验（P1-1）\x1b[0m');
{
  const put = getHandler(membershipRouter, 'put', '/card-type/:id');
  const call = (body, id = 'ct_time') => { const r = mockRes(); put(mockReq({ params: { id }, body, userRole: 'admin', openid: 'admin_x' }), r); return r.body; };
  rec('validDays=0 → 拒绝', call({ validDays: 0 }).code !== 0, JSON.stringify(call({ validDays: 0 })));
  rec('validDays=-365 → 拒绝', call({ validDays: -365 }).code !== 0, '');
  rec('validDays=30.5（非整数）→ 拒绝', call({ validDays: 30.5 }).code !== 0, '');
  rec('validDays=120 → 成功且写库 120', call({ validDays: 120 }).code === 0 && db.prepare('SELECT valid_days FROM membership_cards WHERE id = ?').get('ct_time').valid_days === 120, '');
  rec('仅传 price → 成功且 valid_days 保持不变（部分更新语义）',
    call({ price: 1200 }).code === 0 && db.prepare('SELECT valid_days FROM membership_cards WHERE id = ?').get('ct_time').valid_days === 120, '');
  // 次数卡改时效制却不带有效天数 → 拒绝
  rec('count → time 且未带 validDays → 拒绝', call({ billingMode: 'time' }, 'ct_count').code !== 0, '');
  // 次数卡总次数=0 → 拒绝
  rec('count 卡 totalClasses=0 → 拒绝', call({ totalClasses: 0 }, 'ct_count').code !== 0, '');
}

// [2] 订单批量导入真正发卡
console.log('\n\x1b[1m[2] 订单批量导入发卡（P1-2）\x1b[0m');
{
  const imp = getHandler(ordersRouter, 'post', '/import');
  const r1 = mockRes();
  imp(mockReq({ userRole: 'sales', openid: 'sales_x', body: { rows: [{ studentName: '导入学员', phone: '13700000001', itemName: '导入测试次卡', amount: 500 }] } }), r1);
  const d1 = r1.body && r1.body.data;
  const ord = db.prepare("SELECT id FROM orders WHERE student_id = 'stu_imp' ORDER BY created_at DESC LIMIT 1").get();
  const cardCnt = ord ? db.prepare('SELECT COUNT(*) c FROM member_cards WHERE order_id = ?').get(ord.id).c : 0;
  rec('导入成功 1 条', d1 && d1.success === 1, `body=${JSON.stringify(r1.body)}`);
  rec('★ 订单导入真正发出会员卡（member_cards 有该 order_id）', cardCnt === 1, `cardCnt=${cardCnt}`);

  const r2 = mockRes();
  imp(mockReq({ userRole: 'sales', openid: 'sales_x', body: { rows: [{ studentName: '导入学员', phone: '13700000001', itemName: '不存在的项目XYZ', amount: 300 }] } }), r2);
  const d2 = r2.body && r2.body.data;
  rec('项目名查不到 → 记入 warnings（不静默成功）', d2 && Array.isArray(d2.warnings) && d2.warnings.length === 1, `warnings=${JSON.stringify(d2 && d2.warnings)}`);
}

// [3] 学员导入日期校验
console.log('\n\x1b[1m[3] 学员导入日期校验（P1-3）\x1b[0m');
{
  const imp = getHandler(studentsRouter, 'post', '/import');
  const r = mockRes();
  imp(mockReq({ userRole: 'admin', openid: 'admin_x', body: { rows: [
    { name: '导入日期错1', birthday: '2018-02-30' },
    { name: '导入日期错2', birthday: '2018/1/5' },
    { name: '导入日期对', birthday: '2018-05-01' },
  ] } }), r);
  const d = r.body && r.body.data;
  const bad1 = db.prepare("SELECT COUNT(*) c FROM students WHERE name = '导入日期错1'").get().c;
  const bad2 = db.prepare("SELECT COUNT(*) c FROM students WHERE name = '导入日期错2'").get().c;
  const good = db.prepare("SELECT COUNT(*) c FROM students WHERE name = '导入日期对'").get().c;
  rec('非法日期（2018-02-30）被拦截，未入库', bad1 === 0, `cnt=${bad1}`);
  rec('非法日期（2018/1/5）被拦截，未入库', bad2 === 0, `cnt=${bad2}`);
  rec('合法行照常入库', good === 1, `cnt=${good}`);
  rec('失败行给出定位原因', d && d.failed && d.failed.length === 2, `failed=${JSON.stringify(d && d.failed)}`);
}

// [4] 删除学员清理孤儿家长账号
console.log('\n\x1b[1m[4] 删除学员清理孤儿家长账号（P1-4）\x1b[0m');
{
  const create = getHandler(studentsRouter, 'post', '/');
  const del = getHandler(studentsRouter, 'delete', '/:id');
  const hasUser = (phone) => db.prepare('SELECT COUNT(*) c FROM users WHERE openid = ?').get('phone_' + phone).c;

  const rc = mockRes();
  create(mockReq({ userRole: 'admin', openid: 'admin_x', body: { name: '孤儿测试甲', phone: '13700001111' } }), rc);
  const sid = rc.body && rc.body.data && rc.body.data.id;
  rec('建档后生成家长账号', !!sid && hasUser('13700001111') === 1, `sid=${sid} cnt=${hasUser('13700001111')}`);
  const rd = mockRes();
  del(mockReq({ userRole: 'admin', openid: 'admin_x', params: { id: sid } }), rd);
  rec('★ 删除学员后孤儿家长账号被清理', hasUser('13700001111') === 0, `cnt=${hasUser('13700001111')}`);

  // 多孩共用同一手机号：删其中一个孩子，账号应保留
  const r1 = mockRes();
  create(mockReq({ userRole: 'admin', openid: 'admin_x', body: { name: '二孩甲', phone: '13700002222' } }), r1);
  const s1 = r1.body && r1.body.data && r1.body.data.id;
  const r2 = mockRes();
  create(mockReq({ userRole: 'admin', openid: 'admin_x', body: { name: '二孩乙', phone: '13700002222', confirmDuplicate: true } }), r2);
  const s2 = r2.body && r2.body.data && r2.body.data.id;
  rec('同手机号两孩建档成功', !!s1 && !!s2, `s1=${s1} s2=${s2}`);
  if (s1 && s2) {
    const rd2 = mockRes();
    del(mockReq({ userRole: 'admin', openid: 'admin_x', params: { id: s1 } }), rd2);
    rec('★ 多孩共用账号：删其一不误删账号', hasUser('13700002222') === 1, `cnt=${hasUser('13700002222')}`);
  }
}

// [5] 家长端取卡口径与扣课口径统一
console.log('\n\x1b[1m[5] 家长端取卡口径统一（P1-5）\x1b[0m');
{
  const home = getHandler(studentsRouter, 'get', '/home/data');
  const rh = mockRes();
  home(mockReq({ openid: 'phone_13700000002', query: {} }), rh);
  const hd = rh.body && rh.body.data;
  rec('★ 首页不展示「active 但已过期」的卡', hd && hd.membership === null, `membership=${JSON.stringify(hd && hd.membership)}`);

  const my = getHandler(membershipRouter, 'get', '/my');
  const rm = mockRes();
  my(mockReq({ openid: 'phone_13700000002', query: {} }), rm);
  const list = (rm.body && rm.body.data) || [];
  const card = list.find((c) => c.id === 'mc_exp');
  rec('会员中心仍返回该卡（家长知情权）', !!card, `len=${list.length}`);
  rec('★ 派生 display_status=expired', !!card && card.display_status === 'expired', `card=${JSON.stringify(card)}`);
  rec('★ 派生 is_usable=false / is_expired=true', !!card && card.is_usable === false && card.is_expired === true, `card=${JSON.stringify(card)}`);
}

// [6] 手工扣课路径也执行课程范围隔离（P1-6）
console.log('\n\x1b[1m[6] 手工扣课范围隔离（P1-6）\x1b[0m');
{
  const ins = (sql, ...p) => db.prepare(sql).run(...p);
  // 1v1 限定卡种 + 卡实例
  ins(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, is_active, product_type, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'ct_1v1b', '1v1限定次卡', 10, 0, 'count', 0, 5000, '一对一', 0, 1, 1, 'membership', t);
  ins('INSERT INTO students (id, name, status, created_at, updated_at) VALUES (?,?,?,?,?)', 'stu_1v1b', '私教学员', 'active', t, t);
  ins(`INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'mc_1v1b', 'ct_1v1b', '1v1限定次卡', 'count', 'stu_1v1b', '私教学员', 10, 10, 0, t, future, 'active', t, t);
  // 真实团课排期（course_id 非 course_temp）
  ins('INSERT INTO courses (id, name, category, is_active, created_at) VALUES (?,?,?,?,?)', 'c_team2', '团课X', '团课', 1, t);
  ins('INSERT INTO courses (id, name, category, is_active, created_at) VALUES (?,?,?,?,?)', 'course_temp', '临时活动', '临时', 0, t);
  ins('INSERT INTO schedules (id, course_id, course_name, date, start_time, end_time, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    'sch_team2', 'c_team2', '团课X', '2099-07-01', '10:00', '11:00', 'scheduled', t, t);
  ins('INSERT INTO schedules (id, course_id, course_name, date, start_time, end_time, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    'sch_1v1b', 'course_temp', '一对一', '2099-07-02', '10:00', '11:00', 'scheduled', t, t);

  const deduct = getHandler(membershipRouter, 'post', '/deduct');
  const r1 = mockRes();
  deduct(mockReq({ userRole: 'admin', openid: 'admin_x', body: { scheduleId: 'sch_team2', studentId: 'stu_1v1b', classes: 1 } }), r1);
  rec('★ 手工扣课：1v1 卡遇真实团课 → 拒绝', r1.body && r1.body.code !== 0, `body=${JSON.stringify(r1.body)}`);
  rec('被拒后余次未变（10）', db.prepare('SELECT remaining_classes c FROM member_cards WHERE id = ?').get('mc_1v1b').c === 10, '');

  const r2 = mockRes();
  deduct(mockReq({ userRole: 'admin', openid: 'admin_x', body: { scheduleId: 'sch_1v1b', studentId: 'stu_1v1b', classes: 1 } }), r2);
  rec('手工扣课：范围匹配活动 → 正常扣课（10→9）',
    r2.body && r2.body.code === 0 && db.prepare('SELECT remaining_classes c FROM member_cards WHERE id = ?').get('mc_1v1b').c === 9,
    `body=${JSON.stringify(r2.body)}`);
}

// [7] 结构化课程范围（迁移 033）
console.log('\n\x1b[1m[7] 结构化课程范围 scope_course_ids\x1b[0m');
{
  const ins = (sql, ...p) => db.prepare(sql).run(...p);
  // 卡种限定为「团课X」（course_id=c_team2），走结构化范围
  ins(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, scope_course_ids, transferable, refundable, is_active, product_type, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'ct_scope', '限定团课次卡', 10, 0, 'count', 0, 800, '', 'c_team2', 0, 1, 1, 'membership', t);
  ins('INSERT INTO students (id, name, status, created_at, updated_at) VALUES (?,?,?,?,?)', 'stu_scope', '限定学员', 'active', t, t);
  // 结构化范围存在卡种表（membership_cards），卡实例只需 card_type_id 指向它
  ins(`INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'mc_scope', 'ct_scope', '限定团课次卡', 'count', 'stu_scope', '限定学员', 10, 10, 0, t, future, 'active', t, t);

  const hit = pickCardForDeduction('stu_scope', 'sch_team2', t, 1);
  rec('★ 限定 c_team2 的卡：命中同课程排期 → 返回该卡', hit && hit.id === 'mc_scope', `ret=${JSON.stringify(hit)}`);
  const miss = pickCardForDeduction('stu_scope', 'sch_1v1b', t, 1);
  rec('★ 限定 c_team2 的卡：其他课程排期 → 拒绝（scopeMismatch）', miss && miss.scopeMismatch === true, `ret=${JSON.stringify(miss)}`);
}

// [8] 存量脏数据体检 + 一次性安全清理
console.log('\n\x1b[1m[8] 存量脏数据体检与清理\x1b[0m');
{
  const ins = (sql, ...p) => db.prepare(sql).run(...p);
  // 孤儿家长账号（parent 角色 + phone_ 前缀 + 无绑定）
  ins('INSERT INTO users (id, openid, nickname, phone, role, status, permissions, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_orphan', 'phone_13700009999', '孤儿家长', '13700009999', 'parent', 'active', '', t, t);
  // 非法卡种：时效卡 valid_days=0
  ins(`INSERT INTO membership_cards (id, name, total_classes, valid_days, billing_mode, points_reward, price, course_scope, transferable, refundable, is_active, product_type, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'ct_bad', '坏时效卡', 0, 0, 'time', 0, 300, '', 0, 1, 1, 'membership', t);

  const before = scanDirtyData();
  rec('体检发现孤儿家长账号', before.orphanParents.count >= 1, `cnt=${before.orphanParents.count}`);
  rec('体检发现非法卡种（valid_days=0）', before.invalidCardTypes.count >= 1, `cnt=${before.invalidCardTypes.count}`);

  const r = applyCleanup(['orphan_parents', 'invalid_card_types'], null);
  rec('清理：孤儿家长账号已删除', r.orphanParents >= 1 && db.prepare("SELECT COUNT(*) c FROM users WHERE id = 'u_orphan'").get().c === 0, `removed=${r.orphanParents}`);
  const bad = db.prepare("SELECT is_active FROM membership_cards WHERE id = 'ct_bad'").get();
  rec('清理：非法卡种已下架（不删除，保留可追溯）', bad && bad.is_active === 0, `is_active=${bad && bad.is_active}`);
  const cleanupRoute = getHandler(adminRouter, 'post', '/data-cleanup');
  const rb = mockRes();
  cleanupRoute(mockReq({ userRole: 'admin', openid: 'admin_x', body: { actions: ['drop_all'] } }), rb);
  rec('清理项白名单校验：非法动作被拒', rb.body && rb.body.code !== 0, `body=${JSON.stringify(rb.body)}`);
}

console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
