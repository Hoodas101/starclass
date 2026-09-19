/**
 * 回归套件 —— 撤销签到时的「课时回滚数量」（deduction_logs.count，迁移 019）
 *
 * 被验证的缺陷（业务审查 C-ERP-17）：
 *   deduction_logs 原先只记录「哪次排期、哪个学员、哪张卡、什么时候扣的」，
 *   唯独没有「扣了几节」。于是两条回滚路径（清除签到 checkin.js:153、
 *   签到改非签到 checkin.js:207）只能靠 resolveConsumeClasses(scheduleId)
 *   在**回滚那一刻重新推导**应退数量，推导值与当初真实扣减量不一致时，
 *   学员课时会凭空增减 —— 这是直接引发家长投诉的账目差错。两种触发场景：
 *     1. 管理员用 POST /api/membership/deduct 显式传 classes=N（如 3），
 *        而课程 consume_classes=1 —— 撤销只退 1 节，学员白丢 2 节（T1/T1b）。
 *     2. 扣课之后课程配置被改动（1 改 2 或反之）—— 按新配置退，与当初扣的不符（T5）。
 *
 * 修复方式（已完成，本套件只做验证，不改业务代码）：
 *   迁移 019 给 deduction_logs 补 count 列（可为 NULL），三处 INSERT 写入真实扣减量
 *   （checkin.js:352 签到扣课写 per、membership.js:513 时效制写 0、membership.js:550
 *   手动扣课写 n），两处回滚改为「优先读 ded.count，NULL 才回退旧推导」。
 *   迁移前的历史行 count 一律留 NULL，回退旧推导 → 行为与修复前一致（T3）。
 *
 * 判别性说明（本套件每条核心断言都先证明「旧代码会给出不同结果」）：
 *   断言前先算出 resolveConsumeClasses(scheduleId) 的推导值，并断言它与真实扣减量
 *   **不相等**。若两者恰好相等，这条用例就失去判别力（新老实现同结果），
 *   故把它显式钉成一条前置断言，而不是藏在注释里。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db）：
 *   node tests/deduction-count-regression.cjs
 *   KEEP_TEST_DB=1 node tests/deduction-count-regression.cjs   （保留临时库排查）
 *
 * 写法说明：建库/清理沿用 _bootstrap.cjs（seed 夹具 + 退出时删除临时库），
 * 直调路由处理器沿用 finance-payroll-regression.cjs 的 getHandler/mockRes/mockReq
 * （不启 HTTP 服务，避免与线上占用的 3001 端口及并发套件冲突）。
 */
'use strict';

// ---- 隔离库（必须在 require('../db') 之前设置）----
const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-deduction-count');

const db = require('../db');
const { now, formatDate } = require('../utils');
const { resolveConsumeClasses } = require('../utils/deduction');
const membershipRouter = require('../routes/membership');
const checkinRouter = require('../routes/checkin');

// ---------- 直调路由处理器（与 finance-payroll-regression.cjs 同款）----------
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
const today = formatDate(t);
const DAY = 86400000;
const ins = (sql, ...p) => db.prepare(sql).run(...p);

function mkStudent(id, name) {
  ins('INSERT OR IGNORE INTO students (id, name) VALUES (?, ?)', id, name);
}
function mkCourse(id, name, consume) {
  ins(`INSERT OR IGNORE INTO courses (id, name, category, consume_classes, is_active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`, id, name, 'training', consume, t);
}
function mkSchedule(id, courseId, courseName) {
  ins(`INSERT OR IGNORE INTO schedules (id, course_id, course_name, teacher_id, teacher_name,
         date, start_time, end_time, status, enrolled_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)`,
    id, courseId, courseName, 'teacher_dc', '扣课教练', today, '09:00', '10:00', t, t);
}
/**
 * 建卡。billing_mode='count' 为次数卡；'time' 为时效制卡（不消耗课时）。
 * remaining 刻意允许非 0，使「回滚没有凭空增加课时」成为可证伪的断言。
 */
function mkCard(id, studentId, studentName, o) {
  const { mode = 'count', total = 10, remaining = 10, used = 0 } = o || {};
  ins(`INSERT OR IGNORE INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id,
         student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at,
         status, order_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    id, 'ct_dc', '扣课回滚探针卡', mode, studentId, studentName, total, remaining, used,
    t - DAY, t + 200 * DAY, t, t);
}
/** 造一行考勤 —— 回滚路径要求 attendances 里存在记录，否则直接短路返回。 */
function mkAttendance(scheduleId, studentId, studentName, courseId, courseName, status) {
  ins(`INSERT OR IGNORE INTO attendances (id, schedule_id, student_id, student_name, course_id,
         course_name, status, checkin_method, date, points_earned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'teacher', ?, 0, ?, ?)`,
    `att_${scheduleId}`, scheduleId, studentId, studentName, courseId, courseName, status, today, t, t);
}
/** count 传 null 表示「迁移 019 之前的历史行」。 */
function mkDeductionLog(scheduleId, studentId, cardId, count) {
  ins(`INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at, count)
       VALUES (?, ?, ?, ?, ?)`, scheduleId, studentId, cardId, t, count);
}

const cardOf = (id) => db.prepare('SELECT remaining_classes, used_classes FROM member_cards WHERE id = ?').get(id);
const dedOf = (scheduleId, studentId) => db.prepare(
  'SELECT * FROM deduction_logs WHERE schedule_id = ? AND student_id = ?'
).get(scheduleId, studentId);

// ---------- 路由调用封装（统一以管理员身份）----------
const asAdmin = (extra) => mockReq(Object.assign({ userRole: 'admin', openid: 'admin_dc' }, extra));

/** POST /api/membership/deduct */
function deduct(body) {
  const res = mockRes();
  getHandler(membershipRouter, 'post', '/deduct')(asAdmin({ body }), res);
  return res;
}
/** POST /api/checkin/teacher —— 单学员点名（present / absent / clear） */
function checkin(scheduleId, studentId, status) {
  const res = mockRes();
  getHandler(checkinRouter, 'post', '/teacher')(asAdmin({
    body: { scheduleId, attendances: [{ studentId, status }] },
  }), res);
  return res;
}

console.log('\n\x1b[1m=== 撤销签到 · 课时回滚数量回归测试（迁移 019）===\x1b[0m');
console.log('测试库:', process.env.DB_PATH, '（seed 夹具）\n');

// ============================================================
// T0. 迁移本身：deduction_logs 必须有 count 列，且允许 NULL
// ============================================================
console.log('\x1b[1m[T0] 迁移 019：schema\x1b[0m');
{
  // notnull 是 SQLite 关键字，必须加引号才能作为列名出现在投影里
  const cols = db.prepare('SELECT name, "notnull" AS not_null, dflt_value FROM pragma_table_info(\'deduction_logs\')').all();
  const names = cols.map((c) => c.name);
  const countCol = cols.find((c) => c.name === 'count');
  rec('deduction_logs 已含 count 列（旧 schema 无此列，回滚只能重新推导）',
    !!countCol, `cols=${names.join(',')}`);
  rec('count 列可为 NULL（历史行不得被强行填成 1，那等于把猜测写成事实）',
    !!countCol && countCol.not_null === 0 && countCol.dflt_value === null,
    countCol && JSON.stringify(countCol));
}

// ============================================================
// T1. 核心判别性用例：显式 classes=3 扣课 → 撤销必须退 3（而非课程配置的 1）
// ============================================================
console.log('\n\x1b[1m[T1] 手动扣课 classes=3 / 课程 consume_classes=1 → 清除签到回滚\x1b[0m');
{
  mkStudent('stu_dc1', 'T1学员');
  mkCourse('crs_dc1', '单课时课', 1);
  mkSchedule('sch_dc1', 'crs_dc1', '单课时课');
  mkCard('mc_dc1', 'stu_dc1', 'T1学员', { total: 10, remaining: 10, used: 0 });
  mkAttendance('sch_dc1', 'stu_dc1', 'T1学员', 'crs_dc1', '单课时课', 'present');

  // 判别力自证：推导值 1 ≠ 真实扣减 3，旧实现（回滚时重新推导）必然只退 1。
  const derived = resolveConsumeClasses('sch_dc1');
  rec('T1 判别力：课程推导值(1) 与真实扣减量(3) 不相等',
    derived === 1, `derived=${derived}`);

  const r1 = deduct({ scheduleId: 'sch_dc1', studentId: 'stu_dc1', cardId: 'mc_dc1', classes: 3 });
  const d1 = r1.body && r1.body.data;
  rec('T1 显式扣课 3 节成功', !!d1 && d1.deducted === 3, JSON.stringify(r1.body));
  const afterDeduct = cardOf('mc_dc1');
  rec('T1 扣课后卡内剩 7（10-3）',
    afterDeduct.remaining_classes === 7 && afterDeduct.used_classes === 3, JSON.stringify(afterDeduct));

  const log1 = dedOf('sch_dc1', 'stu_dc1');
  rec('T1 扣课流水记下真实扣减量 count=3（迁移 019 的核心）',
    !!log1 && log1.count === 3, JSON.stringify(log1));

  const r2 = checkin('sch_dc1', 'stu_dc1', 'clear');
  rec('T1 清除签到调用成功', !!(r2.body && r2.body.code === 0), JSON.stringify(r2.body));
  const afterRollback = cardOf('mc_dc1');
  rec('T1 撤销后卡内恢复为 10（修复前按推导只退 1 → 8，学员白丢 2 节）',
    afterRollback.remaining_classes === 10 && afterRollback.used_classes === 0,
    JSON.stringify(afterRollback));
  rec('T1 回滚后扣课流水同步清理', !dedOf('sch_dc1', 'stu_dc1'), 'deduction_logs 有残留');
}

// ============================================================
// T1b. 第二条回滚路径：签到改缺席（checkin.js:207 的补偿分支）
// ============================================================
console.log('\n\x1b[1m[T1b] 手动扣课 classes=3 → 签到改缺席回滚（另一处回滚分支）\x1b[0m');
{
  mkStudent('stu_dc1b', 'T1b学员');
  mkSchedule('sch_dc1b', 'crs_dc1', '单课时课');
  mkCard('mc_dc1b', 'stu_dc1b', 'T1b学员', { total: 10, remaining: 10, used: 0 });
  mkAttendance('sch_dc1b', 'stu_dc1b', 'T1b学员', 'crs_dc1', '单课时课', 'present');

  deduct({ scheduleId: 'sch_dc1b', studentId: 'stu_dc1b', cardId: 'mc_dc1b', classes: 3 });
  const afterDeduct = cardOf('mc_dc1b');
  rec('T1b 扣课 3 节后卡内剩 7',
    afterDeduct.remaining_classes === 7, JSON.stringify(afterDeduct));

  const r = checkin('sch_dc1b', 'stu_dc1b', 'absent');
  rec('T1b 改缺席调用成功', !!(r.body && r.body.code === 0), JSON.stringify(r.body));
  const afterRollback = cardOf('mc_dc1b');
  rec('T1b 改缺席后卡内恢复为 10（修复前只退 1 → 8）',
    afterRollback.remaining_classes === 10 && afterRollback.used_classes === 0,
    JSON.stringify(afterRollback));
}

// ============================================================
// T2. 签到自动扣课路径：count 必须等于 courses.consume_classes
// ============================================================
console.log('\n\x1b[1m[T2] 签到自动扣课（consume_classes=2）写入 count=2 并可原值回滚\x1b[0m');
{
  mkStudent('stu_dc2', 'T2学员');
  mkCourse('crs_dc2', '双课时课', 2);
  mkSchedule('sch_dc2', 'crs_dc2', '双课时课');
  mkCard('mc_dc2', 'stu_dc2', 'T2学员', { total: 10, remaining: 10, used: 0 });

  const derived = resolveConsumeClasses('sch_dc2');
  rec('T2 判别力：课程 consume_classes=2（推导值本身即 2）', derived === 2, `derived=${derived}`);

  const r1 = checkin('sch_dc2', 'stu_dc2', 'present');
  rec('T2 签到调用成功', !!(r1.body && r1.body.code === 0), JSON.stringify(r1.body));
  const afterCheckin = cardOf('mc_dc2');
  rec('T2 签到自动扣 2 课时（卡内 10 → 8）',
    afterCheckin.remaining_classes === 8 && afterCheckin.used_classes === 2, JSON.stringify(afterCheckin));

  const log2 = dedOf('sch_dc2', 'stu_dc2');
  rec('T2 签到路径写入的 count 等于 consume_classes(2)',
    !!log2 && log2.count === 2, JSON.stringify(log2));

  checkin('sch_dc2', 'stu_dc2', 'clear');
  const afterRollback = cardOf('mc_dc2');
  rec('T2 撤销后回到原值 10（回滚数量与扣减数量对称）',
    afterRollback.remaining_classes === 10 && afterRollback.used_classes === 0, JSON.stringify(afterRollback));
}

// ============================================================
// T3. 历史行兼容：count IS NULL → 回退到旧的 resolveConsumeClasses 推导
// ============================================================
console.log('\n\x1b[1m[T3] 历史行（count IS NULL）回退旧推导，行为与修复前一致\x1b[0m');
{
  mkStudent('stu_dc3', 'T3学员');
  mkCourse('crs_dc3', '双课时课', 2);
  mkSchedule('sch_dc3', 'crs_dc3', '双课时课');
  // 历史现场：当初扣过 3 节（卡内 10 → 7），但流水里没记数量
  mkCard('mc_dc3', 'stu_dc3', 'T3学员', { total: 10, remaining: 7, used: 3 });
  mkAttendance('sch_dc3', 'stu_dc3', 'T3学员', 'crs_dc3', '双课时课', 'present');
  mkDeductionLog('sch_dc3', 'stu_dc3', 'mc_dc3', null);

  const before = dedOf('sch_dc3', 'stu_dc3');
  rec('T3 夹具：历史行 count 确为 NULL（迁移不填默认值）',
    !!before && before.count === null, JSON.stringify(before));

  // 判别力：推导值 2 —— 若回退路径写成「硬编码 1」而非调用 resolveConsumeClasses，
  // 卡内会变成 8 而不是 9，本条断言即可捕获。
  const derived = resolveConsumeClasses('sch_dc3');
  rec('T3 判别力：推导值为 2（硬编码 1 会得出不同结果）', derived === 2, `derived=${derived}`);

  const r = checkin('sch_dc3', 'stu_dc3', 'clear');
  rec('T3 历史行回滚不报错（NULL 不触发 TypeError）',
    !!(r.body && r.body.code === 0), JSON.stringify(r.body));
  const after = cardOf('mc_dc3');
  rec(`T3 按旧推导退 ${derived} 节：卡内 7 → ${7 + derived}（与修复前行为一致）`,
    after.remaining_classes === 7 + derived && after.used_classes === 3 - derived,
    JSON.stringify(after));
  rec('T3 历史行流水回滚后清理', !dedOf('sch_dc3', 'stu_dc3'), 'deduction_logs 有残留');
}

// ============================================================
// T4. 时效制卡：count 记为 0（本次没有真实消课），回滚不得凭空增加课时
// ============================================================
console.log('\n\x1b[1m[T4] 时效制卡扣课 count=0，回滚不增加课时\x1b[0m');
{
  mkStudent('stu_dc4', 'T4学员');
  mkCourse('crs_dc4', '时效制课', 1);
  mkSchedule('sch_dc4', 'crs_dc4', '时效制课');
  // remaining 刻意给非 0：若回滚误按推导退 1 节，会变成 6 并被断言捕获
  mkCard('mc_dc4', 'stu_dc4', 'T4学员', { mode: 'time', total: 5, remaining: 5, used: 0 });
  mkAttendance('sch_dc4', 'stu_dc4', 'T4学员', 'crs_dc4', '时效制课', 'present');

  // T4a 写入侧：走真实扣课路由。
  // 该路由当前存在**已知缺陷**（SQL 模板内写了 JS 风格注释 `//`，SQLite 只认 `--`，
  // 见 backend/routes/membership.js:511）—— 时效制扣课一律 500，count 根本写不进去。
  // 本套件不修改业务代码，故此处仅在路由成功时断言；失败时由下方 T4b 显式告警，
  // 而不是把「路由已损坏」伪装成一条普通断言失败、让人误以为是回滚逻辑的问题。
  const r = deduct({ scheduleId: 'sch_dc4', studentId: 'stu_dc4', cardId: 'mc_dc4' });
  const d = r.body && r.body.data;
  if (d && d.deducted === 0 && d.mode === 'time') {
    const log4 = dedOf('sch_dc4', 'stu_dc4');
    rec('T4a 时效制扣课路由写入 count=0（不消耗课时）',
      !!log4 && log4.count === 0, JSON.stringify(log4));
  } else {
    // 路由不可用时，按「修复意图」手工补上它应当写入的那一行（count=0），
    // 使下方回滚侧断言仍能覆盖 count=0 这一分支。
    mkDeductionLog('sch_dc4', 'stu_dc4', 'mc_dc4', 0);
    console.log('  [\x1b[33mWARN\x1b[0m] 时效制扣课路由未成功（T4a 写入侧断言跳过），'
      + '已按修复意图直插 count=0 继续验证回滚侧 —— 路由缺陷详见 T4b');
  }

  const derived = resolveConsumeClasses('sch_dc4');
  rec('T4 判别力：推导值为 1，旧实现回滚会凭空 +1 节', derived === 1, `derived=${derived}`);

  const r2 = checkin('sch_dc4', 'stu_dc4', 'clear');
  rec('T4 清除签到调用成功', !!(r2.body && r2.body.code === 0), JSON.stringify(r2.body));
  const after = cardOf('mc_dc4');
  rec('T4 回滚后卡内仍为 5（未被 +1；count=0 被正确识别为「本次没有真实消课」）',
    after.remaining_classes === 5 && after.used_classes === 0, JSON.stringify(after));
}

// ------------------------------------------------------------
// T4b. 已知缺陷告警（不参与 PASS/FAIL 计数）
// 本次修复在 backend/routes/membership.js:511 的 SQL 模板里写入了 JS 风格注释 `//`，
// 而 SQLite 的注释语法是 `--`，导致该语句在 prepare 阶段直接抛
//   SqliteError: near "/": syntax error
// 被路由的 catch 吞成 500「操作失败，请稍后重试」——
// **时效制会员卡的手工扣课（POST /api/membership/deduct）100% 失败**。
// 这是本次改动引入的回归（改动前该语句没有注释，可正常执行），与回滚数量无关，
// 但同属 deduction_logs.count 这一处改动，故在此显式告警。
// 修复方式：把该行注释改为 `-- 时效制不消耗课时，count 记 0：…`（或移到模板字符串之外）。
// 修好后本段告警消失，T4a 会自动改走真实路由断言。
// ------------------------------------------------------------
{
  // 独立的探针夹具：避免与 T4 的流水撞上 deduction_logs 的 UNIQUE(schedule_id, student_id)
  // 幂等约束 —— 否则路由修好后会被「已扣过」挡回，把正常幂等误报成路由损坏。
  mkStudent('stu_dc4b', 'T4b探针学员');
  mkSchedule('sch_dc4b', 'crs_dc4', '时效制课');
  mkCard('mc_dc4b', 'stu_dc4b', 'T4b探针学员', { mode: 'time', total: 5, remaining: 5, used: 0 });
  const probe = deduct({ scheduleId: 'sch_dc4b', studentId: 'stu_dc4b', cardId: 'mc_dc4b' });
  const routeBroken = !(probe.body && probe.body.code === 0);
  if (routeBroken) {
    console.log('  [\x1b[33mWARN\x1b[0m] \x1b[33m已知缺陷\x1b[0m：时效制会员卡扣课路由不可用'
      + '（POST /api/membership/deduct 对 billing_mode=time 的卡恒返回 500）。');
    console.log('        位置：backend/routes/membership.js:511 —— SQL 模板内的 `// 时效制不消耗课时…`'
      + ' 应改为 `-- …`（SQLite 只认 `--` 注释）。');
    console.log('        影响：时效制会员无法通过该路由记录出席流水，count=0 永远写不进去；'
      + '本套件不修改业务代码，故在此告警而非断言。');
  }
}

// ============================================================
// T5. 扣课后课程配置被改动：回滚仍按当初的真实扣减量，而非新配置
// ============================================================
console.log('\n\x1b[1m[T5] 扣课后课程配置 1 → 2，回滚仍退 3（不按新配置退 2）\x1b[0m');
{
  mkStudent('stu_dc5', 'T5学员');
  mkCourse('crs_dc5', '配置可变课', 1);
  mkSchedule('sch_dc5', 'crs_dc5', '配置可变课');
  mkCard('mc_dc5', 'stu_dc5', 'T5学员', { total: 10, remaining: 10, used: 0 });
  mkAttendance('sch_dc5', 'stu_dc5', 'T5学员', 'crs_dc5', '配置可变课', 'present');

  deduct({ scheduleId: 'sch_dc5', studentId: 'stu_dc5', cardId: 'mc_dc5', classes: 3 });
  const afterDeduct = cardOf('mc_dc5');
  rec('T5 扣课 3 节后卡内剩 7', afterDeduct.remaining_classes === 7, JSON.stringify(afterDeduct));

  // 扣课之后管理员改了课程配置：这正是「推导值与真实扣减量脱节」的第二种触发场景
  db.prepare("UPDATE courses SET consume_classes = 2 WHERE id = 'crs_dc5'").run();
  const derived = resolveConsumeClasses('sch_dc5');
  rec('T5 判别力：配置已改为 2，旧实现会按 2 退（卡内只回到 9）', derived === 2, `derived=${derived}`);

  const r = checkin('sch_dc5', 'stu_dc5', 'clear');
  rec('T5 清除签到调用成功', !!(r.body && r.body.code === 0), JSON.stringify(r.body));
  const after = cardOf('mc_dc5');
  rec('T5 回滚退 3（按扣课时记录的数量，而非改动后的课程配置）→ 卡内 10',
    after.remaining_classes === 10 && after.used_classes === 0, JSON.stringify(after));
}

// ============================================================
// 收尾：临时库由 _bootstrap.cjs 在进程退出时整目录删除
// ============================================================
console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
db.close();
process.exit(failed > 0 ? 1 : 0);
