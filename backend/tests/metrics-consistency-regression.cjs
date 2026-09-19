/**
 * 回归套件 —— 「同一个事实、两个数字」的三处口径统一（metrics consistency）
 *
 * 验收标准「各种信息能够相互关联与印证」要求：同一事实在两个页面必须给出同一个数字。
 * 本套件钉死三处曾各自为政的口径。
 *
 * ── 被验证的三处 ──────────────────────────────────────────────────────────
 *
 * 【1】GET /api/students/:id/stats 的到场率把「请假」算进了分母。
 *   全站标准见 utils/index.js 的 attendanceRate：
 *     到场率 = (present + late) / (present + late + absent)，leave 不进分母。
 *   HEAD 版实现用 COUNT(*)（含 leave）当分母、只把 present+late 当分子：
 *     夹具 A（3 present / 1 late / 2 absent / 4 leave）
 *       HEAD：分母 10 → 4/10 = 40%   且 totalSessions = 10
 *       修复：分母 6  → 4/6  = 67%   且 totalSessions = 6
 *   后果：同一学员在档案页的到场率被请假摊薄，低于看板 attendanceRatePct。
 *
 * 【2】makeup.js 的 enrolled_count 递减。
 *   ★ 与任务描述不符：本套件编写时，工作区与 HEAD 版 makeup.js 的两处递减
 *     （/cancel 与 /reschedule）**都已经**写成 `MAX(0, enrolled_count - 1)`；
 *     routes/schedules.js 的递减同样带 MAX(0, ...)。全仓已无裸 `enrolled_count - 1`。
 *   因此本组断言在 HEAD 版下**同样全部通过 → 全部标注为「护栏」，不是判别项**。
 *   它们锁死的是「脏状态（计数已为 0）下再递减不得变负」这一不变量，
 *   防止将来有人把 MAX(0, ...) 改回裸减法。
 *
 * 【3】GET /api/points/ranking 把「本周获得」当成了 balance 输出。
 *   HEAD 版 `balance: item.points || 0`（points = 本周 earn 合计），
 *   而 balance 语义是「当前可用余额」（points.balance）。
 *   同一学员在积分排行榜看到的余额与积分页/档案页（/growth/points/ranking
 *   的 balance、points 表的 balance）对不上，兑换时尤其困惑。
 *   夹具 C1（balance=30，本周 earn=50）
 *     HEAD：排行榜 balance = 50（错，等于本周获得）
 *     修复：排行榜 balance = 30（与 growth 排行榜一致）
 *
 * ── 判别力实测（不是推测）────────────────────────────────────────────────
 * 做法：把 backend/ 整树复制到 /tmp/edu-head-check（排除 node_modules / data.db /
 * backups / uploads，node_modules 以软链接入），用 `git show HEAD:backend/routes/
 * students.js`、`makeup.js`、`points.js` 覆盖副本里的同名文件（其余新文件全部保留），
 * 在副本上跑本套件；随后在工作区跑同一份套件（工作区业务代码为本套件修复后的版本）。
 *   修复前（HEAD 版三文件）：PASS 19 / FAIL 5
 *   修复后（工作区）        ：PASS 24 / FAIL 0
 *   5 条 FAIL 全部落在标 [判别] 的条目上，一处不多一处不少：
 *     · T1 [判别] attendanceRate === 67      （HEAD 实测 40，请假被算进分母）
 *     · T1 [判别] totalSessions === 6        （HEAD 实测 10，含 4 条请假）
 *     · T1 [判别] === utils.attendanceRate   （HEAD 接口 40 ≠ 标准 67）
 *     · T3 [判别] 排行榜 balance === 30      （HEAD 实测 50，等于本周获得）
 *     · T3 [判别] points 排行榜 === growth 排行榜的 balance（HEAD 50 ≠ 30）
 *   其余 19 条为「护栏」，修复前后同结果，逐条在下方标注。
 *
 * ── 判别力边界（据实标注，避免把护栏伪装成判别项）────────────────────────
 *   · T1 的「attendedSessions === 4」：HEAD 与修复后同为 4（分子口径本来就对）
 *     → 护栏。
 *   · T1 的夹具 C2（无请假）在 HEAD 与修复后同为 67% → 护栏，作用是证明修复
 *     只影响「有请假」的场景，没有把无请假的场景也改坏。
 *   · T1 的「响应键名不变（attendanceRate 为数字）」→ 护栏。
 *   · T2 全部 8 条 → 护栏（HEAD 版 makeup.js 已用 MAX(0, ...)，理由见上）。
 *   · T3 的「排行榜 points === 50」→ 护栏：HEAD 与修复后同为 50，它钉死的是
 *     「排序口径未被顺手改动」，不是判别项。
 *   · T3 的夹具 C2（balance 恰等于本周获得）HEAD 与修复后同为 40 → 护栏，
 *     证明修复没有引入新的偏差，也证明断言不是恒真的。
 *   · T3 的「响应仍含 points 字段且键名不变」→ 护栏。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db）：
 *   node tests/metrics-consistency-regression.cjs
 *   KEEP_TEST_DB=1 node tests/metrics-consistency-regression.cjs   （保留临时库排查）
 *
 * 写法说明：建库/清理沿用 _bootstrap.cjs（seed 夹具 + 退出时删除临时库），
 * 直调路由处理器沿用 deleted-student-exclusion-regression.cjs 的
 * getHandler/mockRes/mockReq（不启 HTTP 服务，避免与常驻 3001 端口及并发套件冲突）。
 */
'use strict';

// ---- 隔离库（必须在 require('../db') 之前设置）----
const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-metrics-consistency');

const db = require('../db');
const { now, attendanceRate } = require('../utils');
const studentsRouter = require('../routes/students');
const makeupRouter = require('../routes/makeup');
const pointsRouter = require('../routes/points');
const growthRouter = require('../routes/growth');

// 防呆：临时库必须落在 /tmp，绝不能是真实库 backend/db/data.db
if (!String(process.env.DB_PATH || '').startsWith('/tmp/')) {
  console.error('[致命] DB_PATH 不在 /tmp，拒绝运行以免污染真实库:', process.env.DB_PATH);
  process.exit(2);
}

// ---------- 直调路由处理器（与 deleted-student-exclusion-regression.cjs 同款）----------
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

// ---------- 断言记录 ----------
let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${ok ? '' : '  -> ' + detail}`);
}

// ---------- 员工身份（seed 夹具，动态解析，不硬编码）----------
const IDS = resolveStaffIdentities(db);
const ADMIN_OPENID = IDS.admin;
const COACH_OPENID = IDS.coach;
const asAdmin = (extra) => mockReq(Object.assign({ userRole: 'admin', openid: ADMIN_OPENID }, extra));
const asCoach = (extra) => mockReq(Object.assign({ userRole: 'coach', openid: COACH_OPENID }, extra));

// ---------- 夹具 ----------
const t = now();
const ins = (sql, ...p) => db.prepare(sql).run(...p);

function mkStudent(id, name) {
  ins(`INSERT OR IGNORE INTO students (id, name, status, archived, join_date, created_at, updated_at)
       VALUES (?, ?, 'active', 0, '', ?, ?)`, id, name, t, t);
}
function mkSchedule(id, maxStudents, enrolledCount) {
  ins(`INSERT OR IGNORE INTO schedules
         (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time,
          max_students, enrolled_count, status, created_at, updated_at)
       VALUES (?, 'course_001', '口径一致性探针课', 'teacher_001', '王教练', '2026-01-05', '16:00', '17:30',
          ?, ?, 'scheduled', ?, ?)`, id, maxStudents, enrolledCount, t, t);
}
// attendances 上有 (schedule_id, student_id) 唯一约束：一条出勤必须独占一个排期，
// 故每条探针出勤各自建一个排期。
function mkAttendance(id, studentId, studentName, status) {
  const schId = `sch_${id}`;
  mkSchedule(schId, 20, 0);
  ins(`INSERT INTO attendances (id, schedule_id, student_id, student_name, status, date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '2026-01-05', ?, ?)`, id, schId, studentId, studentName, status, t, t);
}
function mkEnrollment(id, studentId, studentName, scheduleId, enrollType) {
  ins(`INSERT INTO enrollments
         (id, student_id, student_name, course_id, course_name, schedule_id, enroll_type, status, enrolled_at, created_at, updated_at)
       VALUES (?, ?, ?, 'course_001', '口径一致性探针课', ?, ?, 'active', ?, ?, ?)`,
    id, studentId, studentName, scheduleId, enrollType, t, t, t);
}
function mkPoints(id, studentId, studentName, totalEarned, totalConsumed, balance) {
  ins(`INSERT INTO points (id, student_id, student_name, total_earned, total_consumed, balance, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, id, studentId, studentName, totalEarned, totalConsumed, balance, t);
}
function mkPointLog(id, studentId, type, amount, balance) {
  // created_at = now() 必定 >= 本周一 00:00，保证计入「本周获得」
  ins(`INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at)
       VALUES (?, ?, ?, ?, ?, '探针', '', '口径一致性探针流水', ?)`, id, studentId, type, amount, balance, t);
}

// ===== 组 1 夹具：到场率 =====
// A：含请假（判别项主体）
const A_ID = 'stu_mc_rate_leave';
mkStudent(A_ID, '口径探针学员A');
// 3 present + 1 late + 2 absent + 4 leave
['present', 'present', 'present', 'late', 'absent', 'absent', 'leave', 'leave', 'leave', 'leave']
  .forEach((st, i) => mkAttendance(`att_mc_a_${i}`, A_ID, '口径探针学员A', st));
// 期望：分子 4，分母 4+2=6 → 67%（HEAD 分母 10 → 40%）

// C2：无请假（护栏对照）
const C2_ID = 'stu_mc_rate_clean';
mkStudent(C2_ID, '口径探针学员C2');
['present', 'present', 'absent'].forEach((st, i) => mkAttendance(`att_mc_c2_${i}`, C2_ID, '口径探针学员C2', st));
// 期望：2/3 → 67%（HEAD 与修复后同值，护栏）

// ===== 组 2 夹具：makeup enrolled_count 非负 =====
const M_ID = 'stu_mc_makeup';
mkStudent(M_ID, '口径探针学员M');
// reschedule：源排期 enrolled_count 已被污染为 0（真实行数却还有 1 条 active 登记）
const M_SRC = 'sch_mc_mk_src';
const M_TGT = 'sch_mc_mk_tgt';
mkSchedule(M_SRC, 20, 0);
mkSchedule(M_TGT, 10, 0);
mkEnrollment('enr_mc_mk_src', M_ID, '口径探针学员M', M_SRC, 'schedule');
// cancel：补课排期 enrolled_count 同样为 0
const M_CAN = 'sch_mc_mk_cancel';
mkSchedule(M_CAN, 20, 0);
mkEnrollment('enr_mc_mk_can', M_ID, '口径探针学员M', M_CAN, 'makeup');
ins(`INSERT INTO makeup_records
       (id, student_id, student_name, original_schedule_id, original_date, original_course_name,
        makeup_schedule_id, makeup_date, makeup_course_name, type, status, created_by, note, created_at, updated_at)
     VALUES ('mk_mc_cancel', ?, '口径探针学员M', NULL, NULL, NULL, ?, '2026-01-06', '口径一致性探针课',
        'makeup', 'pending', '', '', ?, ?)`, M_ID, M_CAN, t, t);

// ===== 组 3 夹具：积分排行榜 balance =====
// C1：balance(30) ≠ 本周获得(50) —— 判别项主体
const P1_ID = 'stu_mc_rank_bal';
mkStudent(P1_ID, '口径探针学员P1');
mkPoints('pts_mc_p1', P1_ID, '口径探针学员P1', 100, 70, 30);
mkPointLog('plog_mc_p1', P1_ID, 'earn', 50, 30);
// C2：balance(40) == 本周获得(40) —— 护栏对照
const P2_ID = 'stu_mc_rank_ctrl';
mkStudent(P2_ID, '口径探针学员P2');
mkPoints('pts_mc_p2', P2_ID, '口径探针学员P2', 40, 0, 40);
mkPointLog('plog_mc_p2', P2_ID, 'earn', 40, 40);

// ---------- 观测封装 ----------
function callStudentStats(id, reqOpts) {
  const res = mockRes();
  getHandler(studentsRouter, 'get', '/:id/stats')(asAdmin(Object.assign({ params: { id } }, reqOpts || {})), res);
  return res;
}
function callMakeupReschedule(body) {
  const res = mockRes();
  getHandler(makeupRouter, 'post', '/reschedule')(asCoach({ body }), res);
  return res;
}
function callMakeupCancel(body) {
  const res = mockRes();
  getHandler(makeupRouter, 'post', '/cancel')(asCoach({ body }), res);
  return res;
}
function callPointsRanking() {
  const res = mockRes();
  // /api/points/ranking 现为员工专属（非员工 403），故须以管理员身份调用
  getHandler(pointsRouter, 'get', '/ranking')(asAdmin({ query: { limit: '100' } }), res);
  return res;
}
function callGrowthRanking() {
  const res = mockRes();
  getHandler(growthRouter, 'get', '/points/ranking')(asAdmin({ query: { limit: '100' } }), res);
  return res;
}
const findRank = (res, id) => {
  const list = (res.body && res.body.data && res.body.data.list) || [];
  return list.find((x) => x.studentId === id || x.student_id === id);
};
const enrollCountOf = (id) => db.prepare('SELECT enrolled_count FROM schedules WHERE id = ?').get(id).enrolled_count;

console.log('\n\x1b[1m=== 口径一致性回归测试（到场率 / enrolled_count / 积分排行榜余额）===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具 + 本套件夹具）\n');

// ============================================================
// T0. 前置条件：三个处理器都能直达（否则后面全是假绿）
// ============================================================
console.log('\x1b[1m[T0] 前置条件：鉴权放行\x1b[0m');
{
  const s = callStudentStats(A_ID);
  rec('T0 GET /students/:id/stats 未被 403 拦下且成功返回（管理员身份生效）',
    s.statusCode !== 403 && s.body && s.body.code === 0,
    `status=${s.statusCode} body=${JSON.stringify(s.body)}`);

  const r = callPointsRanking();
  rec('T0 GET /points/ranking 成功返回',
    r.body && r.body.code === 0, `body=${JSON.stringify(r.body)}`);

  const g = callGrowthRanking();
  rec('T0 GET /growth/points/ranking 未被 403 拦下且成功返回',
    g.statusCode !== 403 && g.body && g.body.code === 0,
    `status=${g.statusCode} body=${JSON.stringify(g.body)}`);

  // 用一个不存在的补课 id 调 cancel：能走到业务失败（而非 403）说明鉴权放行
  const c = callMakeupCancel({ id: 'mk_never_exists' });
  rec('T0 POST /makeup/cancel 可直达处理器（不存在的 id 返回业务失败而非 403）',
    c.statusCode !== 403 && c.body && c.body.code !== 0,
    `status=${c.statusCode} body=${JSON.stringify(c.body)}`);
}

// ============================================================
// T1. 到场率：请假不进分母（核心判别项）
// ============================================================
console.log('\n\x1b[1m[T1] 到场率口径：请假不计入分母，与 utils.attendanceRate 一致\x1b[0m');
{
  const res = callStudentStats(A_ID);
  const d = (res.body && res.body.data) || {};

  // 判别力：HEAD 版分母含 4 条 leave → 4/10 = 40；修复后 4/6 = 67。
  rec('T1 [判别] 含请假的学员到场率 === 67（HEAD 版 40，请假被算进分母）',
    d.attendanceRate === 67, `attendanceRate=${d.attendanceRate}`);

  // 判别力：HEAD 版 totalSessions = COUNT(*) = 10（含 leave）。
  rec('T1 [判别] 含请假的学员 totalSessions === 6（HEAD 版 10，含 4 条请假）',
    d.totalSessions === 6, `totalSessions=${d.totalSessions}`);

  // 判别力：与全站唯一实现直接比对 —— 这正是「同一事实两个数字」的判据。
  const std = attendanceRate({ present: 3, late: 1, absent: 2 });
  rec('T1 [判别] 接口到场率 === utils.attendanceRate 标准实现（全站唯一口径）',
    d.attendanceRate === std, `接口=${d.attendanceRate} 标准=${std}`);

  // 护栏：分子口径（present+late）HEAD 本来就对，修复前后同为 4。
  rec('T1 [护栏] attendedSessions === 4（present 3 + late 1，HEAD 版分子本就正确）',
    d.attendedSessions === 4, `attendedSessions=${d.attendedSessions}`);

  // 护栏：响应键名与类型不变（前端消费 attendanceRate 这个键）。
  rec('T1 [护栏] 响应仍含 attendanceRate 且为数字（键名未被改动）',
    typeof d.attendanceRate === 'number' && 'totalSessions' in d && 'attendedSessions' in d,
    JSON.stringify(d));

  // 护栏对照：无请假学员 HEAD 与修复后同为 67% —— 证明修复只作用于有请假的场景。
  const res2 = callStudentStats(C2_ID);
  const d2 = (res2.body && res2.body.data) || {};
  rec('T1 [护栏] 无请假的学员到场率仍为 67%（2/3，HEAD 与修复后同值）',
    d2.attendanceRate === 67 && d2.totalSessions === 3,
    `attendanceRate=${d2.attendanceRate} totalSessions=${d2.totalSessions}`);
}

// ============================================================
// T2. makeup enrolled_count 不得为负（★ 全部为护栏：HEAD 版已用 MAX(0, ...)）
//     任务描述称此处为「无条件 -1」，与代码实际不符 —— 见文件头说明。
// ============================================================
console.log('\n\x1b[1m[T2] 调课 / 取消补课：脏计数（已为 0）递减不得变负（护栏）\x1b[0m');
{
  // 前置：源排期计数确已被污染为 0（否则「不为负」是恒真假绿）
  rec('T2 [护栏] 前置：reschedule 源排期 enrolled_count 已为 0（脏状态）',
    enrollCountOf(M_SRC) === 0, `enrolled_count=${enrollCountOf(M_SRC)}`);

  const r = callMakeupReschedule({ studentId: M_ID, originalScheduleId: M_SRC, newScheduleId: M_TGT });
  rec('T2 [护栏] POST /makeup/reschedule 成功返回',
    r.body && r.body.code === 0, JSON.stringify(r.body));

  rec('T2 [护栏] 调课后源排期 enrolled_count === 0（HEAD 版亦为 0，未变负）',
    enrollCountOf(M_SRC) === 0, `enrolled_count=${enrollCountOf(M_SRC)}`);
  rec('T2 [护栏] 调课后新排期 enrolled_count === 1',
    enrollCountOf(M_TGT) === 1, `enrolled_count=${enrollCountOf(M_TGT)}`);
  rec('T2 [护栏] 源排期登记已置 cancelled（调课确实生效，不是空操作）',
    db.prepare("SELECT status FROM enrollments WHERE id = 'enr_mc_mk_src'").get().status === 'cancelled',
    JSON.stringify(db.prepare("SELECT status FROM enrollments WHERE id = 'enr_mc_mk_src'").get()));

  // 取消补课路径
  rec('T2 [护栏] 前置：cancel 补课排期 enrolled_count 已为 0（脏状态）',
    enrollCountOf(M_CAN) === 0, `enrolled_count=${enrollCountOf(M_CAN)}`);

  const c = callMakeupCancel({ id: 'mk_mc_cancel' });
  rec('T2 [护栏] POST /makeup/cancel 成功返回',
    c.body && c.body.code === 0, JSON.stringify(c.body));

  rec('T2 [护栏] 取消补课后排期 enrolled_count === 0（HEAD 版亦为 0，未变负）',
    enrollCountOf(M_CAN) === 0, `enrolled_count=${enrollCountOf(M_CAN)}`);
  rec('T2 [护栏] 取消补课后补课登记已删除（取消确实生效，不是空操作）',
    db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE id = 'enr_mc_mk_can'").get().c === 0,
    `remaining=${db.prepare("SELECT COUNT(*) AS c FROM enrollments WHERE id = 'enr_mc_mk_can'").get().c}`);
}

// ============================================================
// T3. 积分排行榜：balance 必须是可用余额，不是本周获得（核心判别项）
// ============================================================
console.log('\n\x1b[1m[T3] 积分排行榜 balance 口径：可用余额 ≠ 本周获得\x1b[0m');
{
  const res = callPointsRanking();
  const row = findRank(res, P1_ID);

  // 判别力：HEAD 版 balance = 本周获得 50；修复后 = points.balance 30。
  rec('T3 [判别] 排行榜 balance === 30（points.balance；HEAD 版错误输出本周获得 50）',
    !!row && row.balance === 30, `balance=${row && row.balance}`);

  // 护栏：points（本周获得）在修复前后都应是 50 —— 钉死排序口径未被顺手改动。
  rec('T3 [护栏] 排行榜 points === 50（本周获得，排序口径不得被改动）',
    !!row && row.points === 50, `points=${row && row.points}`);

  // 判别力：与管理员端排行榜（/growth/points/ranking）对同一学员的 balance 必须一致。
  const gRes = callGrowthRanking();
  const gRow = findRank(gRes, P1_ID);
  rec('T3 [判别] points 排行榜 balance === growth 排行榜 balance（跨页面同一事实同一数字）',
    !!row && !!gRow && row.balance === gRow.balance,
    `points=${row && row.balance} growth=${gRow && gRow.balance}`);

  // 护栏：键名不变（前端消费 balance / points）。
  rec('T3 [护栏] 排行榜条目仍含 balance / points / studentId / rank 键',
    !!row && 'balance' in row && 'points' in row && 'studentId' in row && 'rank' in row,
    JSON.stringify(row));

  // 护栏对照：balance 恰等于本周获得的学员，HEAD 与修复后同为 40 —— 证明断言非恒真。
  const ctrl = findRank(res, P2_ID);
  rec('T3 [护栏] 对照学员（balance 恰等于本周获得）balance === 40（HEAD 与修复后同值）',
    !!ctrl && ctrl.balance === 40, `balance=${ctrl && ctrl.balance}`);
}

// ============================================================
// 收尾：临时库由 _bootstrap.cjs 在进程退出时整目录删除
// ============================================================
console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
