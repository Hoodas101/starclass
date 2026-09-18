/**
 * P1-5 回归测试 —— 员工模块权限键的后端强制（离线，隔离库）
 *
 * 原始缺陷：团队管理页的 13 个权限复选框只影响前端菜单/标签页可见性，
 * 后端对 schedule / checkin / leave / coachstats 只做**角色**校验（isCoachReq），
 * 于是管理员取消勾选某模块后，该员工仍可直接调用对应接口 —— 权限裁剪形同装饰。
 *
 * 判别性：用例固定角色为 coach，只改其 permissions，比较同一接口的 403 与否。
 *   旧代码下两者都会放行（只看角色），故本用例在旧代码上必然失败。
 *   同时断言 isCoachReq 本身仍为真，证明「角色已通过、是权限键在起作用」。
 *
 * 后续补充（同一主题的收口，仍按「固定角色、只改 permissions、比较 403 与否」判别）：
 *   · W6 —— permissions='[]' 必须表示「显式零权限」而非回退角色默认（utils.resolvePerms），
 *     与 permissions=''（未配置 → 角色默认）构成对照：前者 403、后者放行。
 *   · W5-students —— 成员列表查看同样收敛到 'students' 权限键（原实现 isStaffReq || hasPerm
 *     使任意员工角色都能看成员），自定义权限不含该键的教练必须 403，默认教练不受影响。
 *
 * 运行：node tests/permission-keys-regression.cjs
 */
process.env.DB_PATH = '/tmp/permission_keys_test.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
for (const f of ['/tmp/permission_keys_test.db', '/tmp/permission_keys_test.db-wal', '/tmp/permission_keys_test.db-shm']) {
  try { fs.rmSync(f); } catch (e) { /* ignore */ }
}

const db = require('../db');
const { now, isCoachReq, resolvePerms, DEFAULT_PERMS } = require('../utils');
const schedulesRouter = require('../routes/schedules');
const checkinRouter = require('../routes/checkin');
const leaveRouter = require('../routes/leave');
const studentsRouter = require('../routes/students');

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

// ---------- 种子：仅建本用例所需的账号 ----------
const t = now();
const seed = db.transaction(() => {
  const ins = (sql, ...p) => db.prepare(sql).run(...p);
  const mkUser = (openid, role, permissions) => ins(
    'INSERT OR IGNORE INTO users (id, openid, role, password, nickname, permissions, status, token_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
    'u_' + openid, openid, role, 'x', openid, permissions, 'active', t, t
  );
  mkUser('admin_p5', 'admin', '');
  mkUser('coach_limited', 'coach', JSON.stringify(['students']));      // 只有成员管理
  mkUser('coach_checkin', 'coach', JSON.stringify(['checkin']));      // 只有签到
  mkUser('coach_default', 'coach', '');                               // 未自定义 → 角色默认
  mkUser('coach_empty_perms', 'coach', '[]');                         // W6：显式零权限
  mkUser('coach_no_students', 'coach', JSON.stringify(['schedule', 'checkin', 'leave', 'coachstats'])); // W5：除 students 外全有
  mkUser('parent_p5', 'parent', '');
});
seed();

console.log('\n\x1b[1m=== P1-5 员工权限键后端强制 回归测试 ===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '\n');

const call = (router, method, path, reqOpts) => {
  const res = mockRes();
  getHandler(router, method, path)(mockReq(reqOpts), res);
  return res;
};

const POST_SCHEDULE = [schedulesRouter, 'post', '/'];
const POST_CHECKIN = [checkinRouter, 'post', '/teacher'];
const GET_LEAVE = [leaveRouter, 'get', '/'];
const GET_COACH_STATS = [schedulesRouter, 'get', '/coach/stats'];
const GET_STUDENTS = [studentsRouter, 'get', '/'];

// ============================================================
// 一、判别性自证：角色校验对两个 coach 都放行
// ============================================================
console.log('\x1b[1m[一] 判别性自证\x1b[0m');
{
  const r = mockReq({ userRole: 'coach', openid: 'coach_limited' });
  rec('isCoachReq 对受限教练仍为真（故旧代码必然放行）', isCoachReq(r) === true, `got=${isCoachReq(r)}`);
}

// ============================================================
// 二、权限键缺失 → 403
// ============================================================
console.log('\n\x1b[1m[二] 缺少模块权限键 → 403\x1b[0m');
{
  const limited = { userRole: 'coach', openid: 'coach_limited' };
  rec('无 schedule 权限 → 创建排期 403', call(...POST_SCHEDULE, limited).statusCode === 403);
  rec('无 checkin 权限 → 教师点名 403', call(...POST_CHECKIN, limited).statusCode === 403);
  rec('无 leave 权限 → 查看请假 403', call(...GET_LEAVE, limited).statusCode === 403);
  rec('无 coachstats 权限 → 课时统计 403', call(...GET_COACH_STATS, limited).statusCode === 403);

  const onlyCheckin = { userRole: 'coach', openid: 'coach_checkin' };
  rec('只有 checkin 权限 → 创建排期仍 403', call(...POST_SCHEDULE, onlyCheckin).statusCode === 403);
  rec('只有 checkin 权限 → 教师点名放行（非 403）', call(...POST_CHECKIN, onlyCheckin).statusCode !== 403);
}

// ============================================================
// 三、角色默认权限 → 放行（不得误伤默认教练）
// ============================================================
console.log('\n\x1b[1m[三] 角色默认权限不得被误伤\x1b[0m');
{
  const def = { userRole: 'coach', openid: 'coach_default' };
  rec('默认教练 → 创建排期放行', call(...POST_SCHEDULE, def).statusCode !== 403);
  rec('默认教练 → 教师点名放行', call(...POST_CHECKIN, def).statusCode !== 403);
  rec('默认教练 → 查看请假放行', call(...GET_LEAVE, def).statusCode !== 403);
  // coachstats 此前遗漏于 DEFAULT_PERMS.coach，而 StaffHub 的课时标签页对 coach 角色可见
  rec('默认教练 → 课时统计放行（coachstats 已补入默认权限）', call(...GET_COACH_STATS, def).statusCode !== 403);
  rec('DEFAULT_PERMS.coach 含 coachstats（与前端标签页 roles 对齐）',
    (DEFAULT_PERMS.coach || []).includes('coachstats'), `got=${JSON.stringify(DEFAULT_PERMS.coach)}`);
}

// ============================================================
// 四、管理员与家长不受该层约束
// ============================================================
console.log('\n\x1b[1m[四] 管理员与家长\x1b[0m');
{
  const admin = { userRole: 'admin', openid: 'admin_p5' };
  rec('管理员 → 创建排期放行', call(...POST_SCHEDULE, admin).statusCode !== 403);
  rec('管理员 → 教师点名放行', call(...POST_CHECKIN, admin).statusCode !== 403);

  // 家长不参与员工权限清单：requireStaffPerm 对非员工角色直接放行，
  // 家长的数据范围由 canViewStudentData 等数据级规则控制（此处只验证该层不拦家长）
  const { requireStaffPerm } = require('../middleware/authz');
  const parentReq = mockReq({ userRole: 'parent', openid: 'parent_p5' });
  const res = mockRes();
  rec('家长不受员工权限清单约束（该层放行）', requireStaffPerm(parentReq, res, 'schedule', '排课') === true && res.statusCode === 200,
    `status=${res.statusCode}`);
  rec('家长权限清单为空（确认未被误配）', resolvePerms({ role: 'parent', permissions: '' }).length === 0);
}

// ============================================================
// 五、W6：permissions='[]' 是「显式零权限」，不得回退角色默认
// ============================================================
console.log('\n\x1b[1m[五] W6 显式空权限数组「[]」= 零权限\x1b[0m');
{
  const parsed = resolvePerms({ role: 'coach', permissions: '[]' });
  rec('resolvePerms(coach, "[]") 返回空数组（不回退角色默认）',
    Array.isArray(parsed) && parsed.length === 0, `got=${JSON.stringify(parsed)}`);

  const empty = { userRole: 'coach', openid: 'coach_empty_perms' };
  const rEmpty = call(...POST_SCHEDULE, empty);
  rec('显式零权限教练 → 创建排期 403', rEmpty.statusCode === 403, `status=${rEmpty.statusCode}`);

  // 判别性对照：同一接口、同一角色，仅 permissions 由 '[]' 变为 ''（未配置）
  const def = { userRole: 'coach', openid: 'coach_default' };
  const rDef = call(...POST_SCHEDULE, def);
  rec('未配置权限的默认教练 → 创建排期 200（未被 W6 误伤）', rDef.statusCode === 200, `status=${rDef.statusCode}`);
}

// ============================================================
// 六、W5-students：成员列表按 'students' 权限键判定
// ============================================================
console.log('\n\x1b[1m[六] W5-students 成员查看权限收敛到 students 键\x1b[0m');
{
  const noStudents = { userRole: 'coach', openid: 'coach_no_students' };
  const rNo = call(...GET_STUDENTS, noStudents);
  rec('自定义权限不含 students 的教练 → GET /api/students 403', rNo.statusCode === 403, `status=${rNo.statusCode}`);

  const hasStudents = { userRole: 'coach', openid: 'coach_limited' }; // permissions=['students']
  const rHas = call(...GET_STUDENTS, hasStudents);
  rec('自定义权限含 students 的教练 → GET /api/students 放行（非 403）', rHas.statusCode !== 403, `status=${rHas.statusCode}`);

  const def = { userRole: 'coach', openid: 'coach_default' };
  const rDef = call(...GET_STUDENTS, def);
  rec('默认教练（未配置权限 → 角色默认含 students）→ GET /api/students 200', rDef.statusCode === 200, `status=${rDef.statusCode}`);

  const admin = { userRole: 'admin', openid: 'admin_p5' };
  const rAdmin = call(...GET_STUDENTS, admin);
  rec('管理员 → GET /api/students 200', rAdmin.statusCode === 200, `status=${rAdmin.statusCode}`);
}

console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
