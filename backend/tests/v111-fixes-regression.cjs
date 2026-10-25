/**
 * v1.0.12 修复回归（离线，隔离库）
 *
 * 来源：《多孩家庭仿真测试报告-20261025》D1–D6、《冷门路径仿真测试报告-20261025》F8-1 / F7-1 / F4-1。
 * 每一项都对应一个「真实机构一定会遇到」的场景，而不是构造出来的边界：
 *  D1 兄弟姐妹被查重误拦 + 返回体假成功     D2 排课名单不生成报名（家长看不到、不能签到）
 *  D3 解绑后永远无法重绑                    D4 绑定上限 3 与多孩家庭矛盾
 *  D5 跨课程卡静默不扣课无提示              D6 家长端首页不回学员 id
 *  F8-1 非在册学员可被排补课                F7-1 重复取消排期仍报成功
 *  F4-1 分享凭证复用提示"凭证无效"（实为本周已领）
 *
 * 运行：node tests/v111-fixes-regression.cjs
 */
process.env.DB_PATH = '/tmp/v111_fixes_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/v111_fixes_test.db', '/tmp/v111_fixes_test.db-wal', '/tmp/v111_fixes_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now } = require('../utils');
const { findDuplicateStudents } = require('../utils/duplicate');
const studentsRouter = require('../routes/students');
const schedulesRouter = require('../routes/schedules');
const authRouter = require('../routes/auth');
const makeupRouter = require('../routes/makeup');
const pointsRouter = require('../routes/points');

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
const PHONE = '13700008888';

// ── 夹具 ──
db.transaction(() => {
  const insUser = db.prepare('INSERT INTO users (id, openid, phone, nickname, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  insUser.run('u_admin', 'admin_x', '13700000000', '管理员', 'admin', 'active', t, t);
  insUser.run('u_parent', `phone_${PHONE}`, PHONE, '家长甲', 'parent', 'active', t, t);

  const insStu = db.prepare('INSERT INTO students (id, name, gender, status, join_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  insStu.run('stu_a', '姐大', '女', 'active', String(t), t, t);
  insStu.run('stu_b', '弟小', '男', 'active', String(t), t, t);
  insStu.run('stu_x', '退课生', '男', 'refunded', String(t), t, t);

  const insBind = db.prepare('INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at) VALUES (?,?,?,?,?,?,?,?)');
  insBind.run('stu_a', '姐大', '家长甲', `phone_${PHONE}`, PHONE, '家长', 1, t);
  insBind.run('stu_b', '弟小', '家长甲', `phone_${PHONE}`, PHONE, '家长', 0, t);

  db.prepare(`INSERT INTO courses (id, name, category, description, duration, consume_classes, color, is_active, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('c1', '篮球基础', '篮球', '', 60, 1, '#409EFF', 1, t);
})();

console.log('\n\x1b[1m=== v1.0.12 修复回归（多孩家庭 + 冷门路径）===\x1b[0m\n');

// ===== [1] D1 查重口径 =====
console.log('\x1b[1m[1] D1 兄弟姐妹不被误拦\x1b[0m');
{
  // 用「尚未建档的第三个孩子」去查：库里已有一对同号兄弟姐妹，两个都应是弱提示。
  // （若用 '弟小' 去查，等于查它自己 —— 同号同名本来就该判强重复。）
  const sib = findDuplicateStudents({ name: '三娃', phone: PHONE });
  const sibHit = sib.list.find((x) => x.id === 'stu_a');
  rec('★ 同号不同名 → 弱提示（不再判强重复）', sibHit && sibHit.strength === 'weak', JSON.stringify(sibHit));
  rec('★ 同号不同名不阻断建档', sib.hasStrong === false, JSON.stringify(sib.list.map((x) => x.strength)));

  const same = findDuplicateStudents({ name: '姐大', phone: PHONE });
  rec('★ 同号同名 → 仍判强重复（真重复要拦住）', same.hasStrong === true, JSON.stringify(same.list.map((x) => [x.name, x.strength])));

  const create = getHandler(studentsRouter, 'post', '/');
  const r = mockRes();
  create(mockReq({ userRole: 'admin', openid: 'admin_x', body: { name: '姐大', gender: '女', phone: PHONE } }), r);
  rec('★ 命中强重复时不再回 "ok"（消除假成功）', r.body && r.body.code !== 0, JSON.stringify(r.body).slice(0, 140));
  rec('响应带 duplicate 标记与候选', !!(r.body && r.body.data && r.body.data.duplicate), JSON.stringify(r.body).slice(0, 140));
}

// ===== [2] D2 排课名单即报名 =====
console.log('\n\x1b[1m[2] D2 排课名单生成报名\x1b[0m');
{
  const create = getHandler(schedulesRouter, 'post', '/');
  const r = mockRes();
  create(mockReq({
    userRole: 'admin', openid: 'admin_x',
    body: { courseId: 'c1', courseName: '篮球基础', date: '2026-11-10', startTime: '09:00', endTime: '10:00', maxStudents: 10, student_ids: 'stu_a,stu_b' },
  }), r);
  const schId = r.body && r.body.data && r.body.data.id;
  rec('排期创建成功', !!schId, JSON.stringify(r.body).slice(0, 140));
  const enr = db.prepare("SELECT COUNT(*) c FROM enrollments WHERE schedule_id = ? AND status = 'active'").get(schId).c;
  rec('★ 显式名单自动生成 2 条报名（家长端可见/可签到）', enr === 2, `enrollments=${enr}`);
  const cnt = db.prepare('SELECT enrolled_count c FROM schedules WHERE id = ?').get(schId).c;
  rec('★ enrolled_count 与 active 报名一致', Number(cnt) === 2, `count=${cnt}`);

  // 班级排课不自动报名（保留申请-审批流）
  db.prepare(`INSERT INTO classes (id, name, coach_id, created_at) VALUES (?,?,?,?)`).run('cls1', '班级A', '', t);
  const r2 = mockRes();
  create(mockReq({
    userRole: 'admin', openid: 'admin_x',
    body: { courseId: 'c1', courseName: '篮球基础', date: '2026-11-11', startTime: '09:00', endTime: '10:00', maxStudents: 10, classId: 'cls1' },
  }), r2);
  const sch2 = r2.body && r2.body.data && r2.body.data.id;
  const enr2 = db.prepare('SELECT COUNT(*) c FROM enrollments WHERE schedule_id = ?').get(sch2).c;
  rec('★ 班级排课不自动报名（审批流不被架空）', enr2 === 0, `enrollments=${enr2}`);
}

// ===== [3] D3 软解绑可重绑 =====
console.log('\n\x1b[1m[3] D3 解绑后仍可重绑\x1b[0m');
{
  const unbind = getHandler(authRouter, 'post', '/unbindStudent');
  const r = mockRes();
  unbind(mockReq({ openid: `phone_${PHONE}`, userRole: 'parent', body: { studentId: 'stu_b' } }), r);
  rec('解绑成功', r.body && r.body.code === 0, JSON.stringify(r.body).slice(0, 120));

  const row = db.prepare("SELECT parent_openid, parent_phone FROM parent_bindings WHERE student_id = 'stu_b'").get();
  rec('★ 绑定行仍在（软解绑，未物理删除）', !!row, JSON.stringify(row));
  rec('★ parent_openid 已清空（等效解绑）', row && row.parent_openid === '', JSON.stringify(row));
  rec('★ parent_phone 保留（重绑校验依据未被销毁）', row && row.parent_phone === PHONE, JSON.stringify(row));

  const visible = db.prepare("SELECT COUNT(*) c FROM parent_bindings WHERE parent_openid = ? AND student_id = 'stu_b'").get(`phone_${PHONE}`).c;
  rec('★ 解绑后家长侧查不到该孩子', visible === 0, `visible=${visible}`);
}

// ===== [4] D4 绑定上限 5 =====
console.log('\n\x1b[1m[4] D4 绑定上限放宽到 5\x1b[0m');
{
  const src = fs.readFileSync(require('path').join(__dirname, '../routes/auth.js'), 'utf8');
  rec('★ 上限为 5（源码断言，避免构造 6 个孩子）', /bindCount >= 5/.test(src) && !/bindCount >= 3/.test(src),
    /bindCount >= \d/.exec(src) ? /bindCount >= \d/.exec(src)[0] : '未找到');
}

// ===== [5] D6 首页返回学员 id =====
console.log('\n\x1b[1m[5] D6 家长端首页带 id\x1b[0m');
{
  const home = getHandler(studentsRouter, 'get', '/home/data');
  const r = mockRes();
  home(mockReq({ openid: `phone_${PHONE}`, userRole: 'parent', query: { studentId: 'stu_a' } }), r);
  const stu = r.body && r.body.data && r.body.data.student;
  rec('★ student.id 已返回', !!stu && stu.id === 'stu_a', JSON.stringify(stu));
}

// ===== [6] F8-1 补课校验在册 =====
console.log('\n\x1b[1m[6] F8-1 非在册学员不可排补课\x1b[0m');
{
  db.prepare(`INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time, status, max_students, enrolled_count, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('sch_mk', 'c1', '篮球基础', 'coach_x', '教练', '2026-11-12', '09:00', '10:00', 'scheduled', 10, 0, t, t);
  db.prepare(`INSERT INTO attendances (id, schedule_id, student_id, student_name, date, status, checkin_time, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run('att_x', 'sch_mk', 'stu_x', '退课生', '2026-11-10', 'absent', t, t);

  const assign = getHandler(makeupRouter, 'post', '/assign');
  const r = mockRes();
  assign(mockReq({ userRole: 'admin', openid: 'admin_x', body: { studentId: 'stu_x', originalScheduleId: 'sch_mk', makeupScheduleId: 'sch_mk' } }), r);
  rec('★ 已退课学员被拒（非在册）', r.body && r.body.code !== 0, JSON.stringify(r.body).slice(0, 140));
  rec('未写入补课记录', db.prepare("SELECT COUNT(*) c FROM makeup_records WHERE student_id = 'stu_x'").get().c === 0, '');
}

// ===== [7] F7-1 重复取消 =====
console.log('\n\x1b[1m[7] F7-1 重复取消排期被显式拒绝\x1b[0m');
{
  db.prepare(`INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time, status, max_students, enrolled_count, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('sch_c', 'c1', '篮球基础', 'coach_x', '教练', '2026-11-13', '09:00', '10:00', 'scheduled', 10, 0, t, t);
  const del = getHandler(schedulesRouter, 'delete', '/:id');
  const r1 = mockRes();
  del(mockReq({ params: { id: 'sch_c' }, userRole: 'admin', openid: 'admin_x' }), r1);
  rec('首次取消成功', r1.body && r1.body.code === 0, JSON.stringify(r1.body).slice(0, 120));
  const r2 = mockRes();
  del(mockReq({ params: { id: 'sch_c' }, userRole: 'admin', openid: 'admin_x' }), r2);
  rec('★ 重复取消被显式拒绝', r2.body && r2.body.code !== 0, JSON.stringify(r2.body).slice(0, 120));
}

// ===== [8] F4-1 分享凭证复用 =====
console.log('\n\x1b[1m[8] F4-1 分享凭证复用不再误报"凭证无效"\x1b[0m');
{
  const ticketApi = getHandler(pointsRouter, 'post', '/share/ticket');
  const share = getHandler(pointsRouter, 'post', '/share');
  const tk = mockRes();
  ticketApi(mockReq({ openid: `phone_${PHONE}`, userRole: 'parent', body: {} }), tk);
  const ticket = tk.body && tk.body.data && tk.body.data.ticket;
  rec('可申请到凭证', !!ticket, JSON.stringify(tk.body).slice(0, 120));

  const s1 = mockRes();
  share(mockReq({ openid: `phone_${PHONE}`, userRole: 'parent', body: { ticket } }), s1);
  rec('首次领取成功', s1.body && s1.body.code === 0, JSON.stringify(s1.body).slice(0, 120));

  const s2 = mockRes();
  share(mockReq({ openid: `phone_${PHONE}`, userRole: 'parent', body: { ticket } }), s2);
  rec('★ 复用提示「本周已领取」而非「凭证无效」',
    !!(s2.body && s2.body.code === 0 && s2.body.data && s2.body.data.duplicated === true),
    JSON.stringify(s2.body).slice(0, 140));
  rec('★ 未重复发分（added=0）', !!(s2.body && s2.body.data && s2.body.data.added === 0), JSON.stringify(s2.body).slice(0, 120));
}

console.log(`\n\x1b[1m结果汇总：PASS ${pass}  FAIL ${fail}\x1b[0m`);
db.close();
process.exit(fail > 0 ? 1 : 0);
