/**
 * 回归套件 —— 删除活动（DELETE /api/admin/courses/:id）级联回滚积分时，
 * 「该排期积分净额为负」的学员也必须同步余额。
 *
 * 被验证的缺陷（backend/routes/admin.js 约 1217-1256 行）：
 *   删活动前先按学员聚合这批排期的积分流水净额，再整批 DELETE 掉这些流水、
 *   并按净额回滚 points.balance。原实现用
 *       `).all(...ids).filter((a) => (a.total || 0) > 0);`
 *   把**净额 ≤ 0** 的学员一并滤掉，但紧随其后的
 *   `DELETE FROM point_logs WHERE reference_id IN (...)` 并不区分正负，
 *   照样删掉**所有**学员的流水。于是：
 *     · 净额 = 0：流水删除的净变动本就是 0，余额不动 → 自洽，**确实不用处理**；
 *     · 净额 < 0：这批流水里回滚（负值行）多于获得，整批删除后
 *       **流水净额反而增加 |total|**，而余额一动不动
 *       → 「流水净变动 ≠ 余额变动」，学员积分账户凭空少掉 |total|，
 *         而流水侧已无任何痕迹可对（删除后无自愈机制）。
 *   修复把 `> 0` 改成 `!== 0`：净额为负的学员也进回滚分支，
 *   `Math.min(a.total, balance)` 对负数天然返回 a.total（负数），
 *   `newBal = balance - actual` 即「余额增加 |total|」，与流水侧对齐。
 *
 * 核心不变量（本套件每条用例都断言它）：
 *   对被删排期涉及的每个学员，
 *     ΔSUM(point_logs.amount)  ===  Δpoints.balance
 *   （左边按 amount 原样求和，不看 type；consume 流水的 reference_id 是
 *     `consume_<学员id>`、不在删除集合内，故不干扰该等式。）
 *
 * 真实业务里「净额为负」怎么来的（夹具据此构造，不是凭空造数）：
 *   学员在同一排期上先签到得 +100（reference_id = 排期 id，checkin.js:257），
 *   之后签到状态被调整（present↔late）按差额补发/回滚
 *   （checkin.js:236-238，调整行 reference_id = `<排期id>_adjust`），
 *   再遇排期取消/清除签到时按**考勤行当前值**回滚
 *   （utils/attendance-revert.js:131，reversePoints 用 a.points_earned、
 *    reference_id = 排期 id）。发放走排期 id、回滚也走排期 id，
 *   一旦回滚量大于当初发放量（状态调整后分值变高、或人工修正），
 *   该排期上的流水净额就是负数 —— 而余额靠其他来源仍是非负的正常值。
 *
 * 判别力标注（与 points-clamp-consistency-regression.cjs 同款约定）：
 *   · [判别] 在修复前（filter 为 `> 0`）会失败的断言；
 *   · [护栏] 修复前后同结果、用来钉死「不许为了对齐而破坏既有契约」的断言；
 *   · [前置] 夹具/调用可达性的自证，否则后面的「相等」可能是假绿。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db）：
 *   node tests/points-negative-net-rollback-regression.cjs
 *   KEEP_TEST_DB=1 node tests/points-negative-net-rollback-regression.cjs   （保留临时库排查）
 *
 * 写法说明：建库沿用 _bootstrap.cjs；直调路由处理器沿用
 * points-clamp-consistency-regression.cjs 的 getHandler/mockRes/mockReq
 * （不启 HTTP 服务，避免与线上占用的 3001 端口及并发套件冲突）。
 */
'use strict';

// ---- 隔离库（必须在 require('../db') 之前设置）----
const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-points-negnet');

const db = require('../db');
const { now } = require('../utils');
const adminRouter = require('../routes/admin');

// 防呆：临时库必须落在 /tmp，绝不能是真实库 backend/db/data.db
if (!String(process.env.DB_PATH || '').startsWith('/tmp/')) {
  console.error('[致命] DB_PATH 不在 /tmp，拒绝运行以免污染真实库:', process.env.DB_PATH);
  process.exit(2);
}

// ---------- 直调路由处理器（与 points-clamp-consistency-regression.cjs 同款）----------
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

// ---------- 夹具 ----------
const t = now();
const ins = (sql, ...p) => db.prepare(sql).run(...p);
const asAdmin = (extra) => mockReq(Object.assign({ userRole: 'admin', openid: 'admin_negnet' }, extra));

function mkStudent(id, name) {
  ins("INSERT OR IGNORE INTO students (id, name, status, archived, created_at, updated_at) VALUES (?, ?, 'active', 0, ?, ?)",
    id, name, t, t);
}
function mkCourse(id, name) {
  ins("INSERT OR IGNORE INTO courses (id, name, category, consume_classes, is_active, created_at) VALUES (?, ?, 'training', 1, 1, ?)",
    id, name, t);
}
function mkSchedule(id, courseId, courseName) {
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, teacher_name,
         date, start_time, end_time, status, enrolled_count, created_at, updated_at)
       VALUES (?, ?, ?, 'teacher_negnet', '净额回滚教练', '2026-01-01', '09:00', '10:00', 'scheduled', 0, ?, ?)`,
    id, courseId, courseName, t, t);
}
/** 积分账户。total_earned/total_consumed/balance 由调用方按夹具流水算准，保证夹具自身账实相符。 */
function mkPoints(studentId, studentName, totalEarned, totalConsumed, balance) {
  ins(`INSERT OR IGNORE INTO points (id, student_id, student_name, total_earned, total_consumed, balance, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'pts_' + studentId, studentId, studentName, totalEarned, totalConsumed, balance, t);
}
/**
 * 一条积分流水。
 * 注意：本项目里 consume 流水的 amount 存**正数**（points.js:130），
 * 扣减体现在 type 上 —— 故本套件的「净额」口径为
 *   SUM(CASE WHEN type='consume' THEN -amount ELSE amount END)。
 * 而「流水合计的变动量」按 amount 原样求和（team-lead 的断言口径），
 * 两者在「删除只影响本排期那些行」的前提下，变动量恒等。
 */
function mkLog(id, studentId, type, amount, balance, referenceId, reason) {
  ins(`INSERT INTO point_logs (id, student_id, type, amount, balance, reason, reference_id, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '夹具', ?)`,
    id, studentId, type, amount, balance, reason || '夹具', referenceId, t);
}

// ---------- 观测 ----------
const snap = (stu) => ({
  balance: (db.prepare('SELECT balance FROM points WHERE student_id = ?').get(stu) || {}).balance,
  totalEarned: (db.prepare('SELECT total_earned FROM points WHERE student_id = ?').get(stu) || {}).total_earned,
  /** 流水 amount 原样合计 */
  rawSum: db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM point_logs WHERE student_id = ?').get(stu).s,
  /** 流水净额（consume 记负）—— 与 points.balance 应当恒等 */
  signedSum: db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN type = 'consume' THEN -amount ELSE amount END), 0) AS s FROM point_logs WHERE student_id = ?"
  ).get(stu).s,
  logCount: db.prepare('SELECT COUNT(*) AS c FROM point_logs WHERE student_id = ?').get(stu).c,
});
const refCount = (ref) => db.prepare('SELECT COUNT(*) AS c FROM point_logs WHERE reference_id = ?').get(ref).c;

function deleteCourse(courseId) {
  const res = mockRes();
  getHandler(adminRouter, 'delete', '/courses/:id')(asAdmin({ params: { id: courseId } }), res);
  return res;
}

/**
 * 核心不变量断言组：Δ流水合计 === Δ余额，且删除后账实相符。
 * @param {string} tag 用例前缀
 * @param {string} stu 学员 id
 * @param {object} before 调用前的 snap(stu)
 */
function assertInvariant(tag, stu, before) {
  const after = snap(stu);
  const dLog = after.rawSum - before.rawSum;
  const dBal = after.balance - before.balance;
  rec(`${tag} [判别] 流水合计的变动量 === 余额变动量（Δ流水 ${dLog} / Δ余额 ${dBal}）`,
    dLog === dBal, `Δ流水=${dLog} Δ余额=${dBal}`);
  rec(`${tag} [判别] 删除后账实相符：流水净额 === 余额（signed=${after.signedSum} balance=${after.balance}）`,
    after.signedSum === after.balance, `signed=${after.signedSum} balance=${after.balance}`);
}

console.log('\n\x1b[1m=== 删除活动：积分净额为负的学员也必须同步回滚余额 ===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具 + 本套件夹具）\n');

// ============================================================
// T0. 前置条件：处理器可达 + 净额口径自证（否则后面全是假绿）
// ============================================================
console.log('\x1b[1m[T0] 前置条件：鉴权放行 + 口径自证\x1b[0m');
{
  const r = deleteCourse('crs_negnet_never');
  rec('T0 DELETE /admin/courses/:id 未被 403 拦下（不存在的活动返回业务失败）',
    r.statusCode !== 403 && r.body && r.body.code === 1, `status=${r.statusCode} body=${JSON.stringify(r.body)}`);

  // 口径自证：seed 里的积分账户本就满足「流水净额 == 余额」，证明 signedSum 口径正确
  const probe = db.prepare('SELECT student_id, balance FROM points ORDER BY student_id LIMIT 1').get();
  const ps = probe && snap(probe.student_id);
  rec('T0 口径自证：seed 账户满足「流水净额 === 余额」',
    !!ps && ps.signedSum === ps.balance, `stu=${probe && probe.student_id} signed=${ps && ps.signedSum} balance=${ps && ps.balance}`);
}

// ============================================================
// T1. 净额为负（回滚多于获得）—— 本次修复的核心场景
//     夹具：其他来源 +250，本排期 +100 后回滚 −150 → 净额 −50
// ============================================================
console.log('\n\x1b[1m[T1] 净额为负：余额必须同步增加 |净额| = 50\x1b[0m');
{
  const S = 'stu_negnet1', C = 'crs_negnet1', SCH = 'sch_negnet1';
  mkStudent(S, '净额为负学员');
  mkCourse(C, '净额回滚活动1');
  mkSchedule(SCH, C, '净额回滚活动1');
  mkPoints(S, '净额为负学员', 350, 60, 140);
  mkLog('plog_neg1_a', S, 'earn', 250, 250, 'seed_negnet1', '其他来源发放');
  mkLog('plog_neg1_b', S, 'checkin', 100, 350, SCH, '签到获得积分');
  mkLog('plog_neg1_c', S, 'checkin', -150, 200, SCH, '状态调整/取消排期回滚积分');
  mkLog('plog_neg1_d', S, 'consume', 60, 140, 'consume_negnet1', '兑换');

  const before = snap(S);
  rec('T1 前置：夹具余额 140 且账实相符（流水净额 === 余额）',
    before.balance === 140 && before.signedSum === 140, JSON.stringify(before));
  rec('T1 前置：该排期流水净额为负（+100 −150 = −50）',
    db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM point_logs WHERE reference_id = ? AND type IN ('earn','checkin')").get(SCH).s === -50,
    JSON.stringify(db.prepare("SELECT SUM(amount) AS s FROM point_logs WHERE reference_id = ?").get(SCH)));

  const res = deleteCourse(C);
  rec('T1 前置：删除活动成功', res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const after = snap(S);
  rec('T1 [判别] 净额为负时余额同步增加 |净额|=50（期望 190；旧实现纹丝不动停在 140）',
    after.balance === 190, `balance=${after.balance}`);
  assertInvariant('T1', S, before);
  // 护栏：流水整批清理的既有契约不得为对齐余额而被破坏
  rec('T1 [护栏] 该排期的积分流水仍被整批清理（reference_id 行数归零）',
    refCount(SCH) === 0, `count=${refCount(SCH)}`);
}

// ============================================================
// T2. 净额为正且余额充足 —— 防回归：改动不得破坏原本就对的路径
// ============================================================
console.log('\n\x1b[1m[T2] 净额为正 + 余额充足：行为不变（足额回滚、不补记差额行）\x1b[0m');
{
  const S = 'stu_negnet2', C = 'crs_negnet2', SCH = 'sch_negnet2';
  mkStudent(S, '净额为正学员');
  mkCourse(C, '净额回滚活动2');
  mkSchedule(SCH, C, '净额回滚活动2');
  mkPoints(S, '净额为正学员', 100, 0, 100);
  mkLog('plog_neg2_a', S, 'checkin', 100, 100, SCH, '签到获得积分');

  const before = snap(S);
  rec('T2 前置：夹具余额 100、流水净额 === 余额', before.balance === 100 && before.signedSum === 100, JSON.stringify(before));

  const res = deleteCourse(C);
  rec('T2 前置：删除活动成功', res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const after = snap(S);
  rec('T2 [护栏] 余额归零且不为负（足额回滚，旧实现同结果）', after.balance === 0, `balance=${after.balance}`);
  rec('T2 [护栏] 未补记差额行：该学员已无任何流水', after.logCount === 0, `logCount=${after.logCount}`);
  assertInvariant('T2', S, before);
}

// ============================================================
// T3. 净额恰好为 0 —— 边界：改动前后都应通过，证明没把边界搞反
//     夹具：其他来源 +80，本排期 +100 后全额回滚 −100 → 净额 0
// ============================================================
console.log('\n\x1b[1m[T3] 净额为 0：余额不动且仍然自洽（改动前后同结果）\x1b[0m');
{
  const S = 'stu_negnet3', C = 'crs_negnet3', SCH = 'sch_negnet3';
  mkStudent(S, '净额为零学员');
  mkCourse(C, '净额回滚活动3');
  mkSchedule(SCH, C, '净额回滚活动3');
  mkPoints(S, '净额为零学员', 180, 0, 80);
  mkLog('plog_neg3_a', S, 'earn', 80, 80, 'seed_negnet3', '其他来源发放');
  mkLog('plog_neg3_b', S, 'checkin', 100, 180, SCH, '签到获得积分');
  mkLog('plog_neg3_c', S, 'checkin', -100, 80, SCH, '清除签到回滚积分');

  const before = snap(S);
  rec('T3 前置：夹具余额 80、该排期净额恰为 0',
    before.balance === 80 && before.signedSum === 80
    && db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM point_logs WHERE reference_id = ? AND type IN ('earn','checkin')").get(SCH).s === 0,
    JSON.stringify(before));

  const res = deleteCourse(C);
  rec('T3 前置：删除活动成功', res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const after = snap(S);
  rec('T3 [护栏] 净额为 0 时余额纹丝不动（期望 80）', after.balance === 80, `balance=${after.balance}`);
  assertInvariant('T3', S, before);
}

// ============================================================
// T4. 净额为正但余额不足 —— 只能扣到 0，靠补记差额行保持账实相符
// ============================================================
console.log('\n\x1b[1m[T4] 净额为正 + 余额不足：扣到 0 为止且账实相符\x1b[0m');
{
  const S = 'stu_negnet4', C = 'crs_negnet4', SCH = 'sch_negnet4';
  mkStudent(S, '余额不足学员');
  mkCourse(C, '净额回滚活动4');
  mkSchedule(SCH, C, '净额回滚活动4');
  mkPoints(S, '余额不足学员', 100, 70, 30);
  mkLog('plog_neg4_a', S, 'checkin', 100, 100, SCH, '签到获得积分');
  mkLog('plog_neg4_b', S, 'consume', 70, 30, 'consume_negnet4', '兑换');

  const before = snap(S);
  rec('T4 前置：夹具余额 30 < 净额 100、流水净额 === 余额', before.balance === 30 && before.signedSum === 30, JSON.stringify(before));

  const res = deleteCourse(C);
  rec('T4 前置：删除活动成功', res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  const after = snap(S);
  rec('T4 [护栏] 余额扣到 0 为止且不为负（业务语义：不足时仍不报失败）', after.balance === 0, `balance=${after.balance}`);
  rec('T4 [护栏] 追不回的 70 分补记了一笔差额流水，使净变动恰为 −30',
    after.logCount === 2 && after.rawSum - before.rawSum === -30,
    `logCount=${after.logCount} Δ流水=${after.rawSum - before.rawSum}`);
  assertInvariant('T4', S, before);
}

// ============================================================
// T5. 同一排期下正负混合 —— bug 只吃掉负的那一个，最能体现判别力
// ============================================================
console.log('\n\x1b[1m[T5] 同一排期正负混合：负的必须同步、正的照旧\x1b[0m');
{
  const A = 'stu_negnet5a', B = 'stu_negnet5b', C = 'crs_negnet5', SCH = 'sch_negnet5';
  mkStudent(A, '混合排期负净额学员');
  mkStudent(B, '混合排期正净额学员');
  mkCourse(C, '净额回滚活动5');
  mkSchedule(SCH, C, '净额回滚活动5');
  // A：其他来源 +250，本排期 +100 后回滚 −150 → 净额 −50，余额 200
  mkPoints(A, '混合排期负净额学员', 350, 0, 200);
  mkLog('plog_neg5a_1', A, 'earn', 250, 250, 'seed_negnet5a', '其他来源发放');
  mkLog('plog_neg5a_2', A, 'checkin', 100, 350, SCH, '签到获得积分');
  mkLog('plog_neg5a_3', A, 'checkin', -150, 200, SCH, '状态调整/取消排期回滚积分');
  // B：本排期 +100 → 净额 +100，余额 100
  mkPoints(B, '混合排期正净额学员', 100, 0, 100);
  mkLog('plog_neg5b_1', B, 'checkin', 100, 100, SCH, '签到获得积分');

  const beforeA = snap(A), beforeB = snap(B);
  rec('T5 前置：负净额学员余额 200、正净额学员余额 100，且均账实相符',
    beforeA.balance === 200 && beforeA.signedSum === 200 && beforeB.balance === 100 && beforeB.signedSum === 100,
    JSON.stringify({ beforeA, beforeB }));

  const res = deleteCourse(C);
  rec('T5 前置：删除活动成功', res.body && res.body.code === 0, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

  rec('T5 [判别] 负净额学员余额 200 → 250（旧实现被 filter 滤掉，停在 200）',
    snap(A).balance === 250, `balance=${snap(A).balance}`);
  rec('T5 [判别] 正净额学员余额 100 → 0（两条路径都应如此）',
    snap(B).balance === 0, `balance=${snap(B).balance}`);
  assertInvariant('T5-负', A, beforeA);
  assertInvariant('T5-正', B, beforeB);
  rec('T5 [护栏] 该排期的积分流水已整批清理', refCount(SCH) === 0, `count=${refCount(SCH)}`);
}

// ============================================================
// 收尾：临时库由 _bootstrap.cjs 在进程退出时整目录删除
// ============================================================
console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
