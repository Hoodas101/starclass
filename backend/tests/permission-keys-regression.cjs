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

console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
