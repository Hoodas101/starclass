/**
 * 回归套件 —— 出勤统计「应到」口径分叉（同一页面出现两个互相矛盾的数字）
 *
 * 被验证的缺陷（信息无法相互印证）：
 *   backend/routes/attendances.js 里两个函数的「应到」口径不一致：
 *     · 汇总 computeSummary（:119）
 *         const totalSessions = presentCount + lateCount + absentCount;
 *         注释写明「已批准的请假不算应到未到」—— **不含 leave**。
 *     · 趋势 computeTrend（原 :143）
 *         COUNT(*) AS total
 *         **含 leave**（也含任何其它未知 status）。
 *   前端 web-admin/src/views/attendance-records/index.vue 把两者同屏渲染：
 *     · :79  卡片「应到次数」= summary.totalSessions
 *     · :327/:367 柱状图「应到」系列 = trend[].total
 *   于是同一页面出现两个「应到」：例如某成员 present/late/absent/leave 各 1 条时，
 *   卡片显示「应到 3」而柱状图显示「应到 4」，家长会认为系统算错了。
 *
 * 修复（backend/routes/attendances.js，computeTrend 内）：
 *   把 COUNT(*) AS total 改成与 :119 同口径：
 *     SUM(CASE WHEN a.status IN ('present', 'late', 'absent') THEN 1 ELSE 0 END) AS total
 *   不动汇总、不动 attendanceRate 分母（utils/index.js:404-408 已是同一口径）。
 *
 * 判别力设计（每条判别项在修复被移除后必须变红）：
 *   · T2-2 是**判别项**：修复前该日 trend.total = 4（COUNT(*) 含 leave），修复后 = 3。
 *   · T2-4 是**不变式**：trend 各日 total 求和 必须 === summary.totalSessions。
 *     修复前 6 ≠ 5 直接失败；且这条不依赖具体某天的数据，跨多日同样成立。
 *   · T1-3 是**反假绿护栏**：必须先断言 leaveCount === 1（leave 行确实存在），
 *     否则「趋势不含 leave」可能只是因为压根没有 leave 数据，测试会假绿。
 *   · T3 是**对照/隔离**：另一个成员的数据不得串进来。
 *
 * 纪律：绝不为了验证判别力而临时改坏刚写的修复——判别力由上述判别项与护栏自证。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db 与 3001 端口上的线上服务）：
 *   node tests/attendance-trend-consistency-regression.cjs
 *   KEEP_TEST_DB=1 node tests/attendance-trend-consistency-regression.cjs
 */
'use strict';

// 端口必须在 require('../server') 之前设定：server.js 在模块加载时读取 PORT。
// 3001 是线上服务；3095/3096 已被其它套件占用，这里走 3097。
process.env.PORT = process.env.PORT || '3097';

const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-attendance-trend');

// 防呆：临时库必须落在 /tmp，绝不能是真实库 backend/db/data.db
if (!String(process.env.DB_PATH || '').startsWith('/tmp/')) {
  console.error('[致命] DB_PATH 不在 /tmp，拒绝运行以免污染真实库:', process.env.DB_PATH);
  process.exit(2);
}

const db = require('../db');
const { now, generateToken } = require('../utils');

const BASE = `http://localhost:${process.env.PORT}`;

// ---------- 断言记录 ----------
let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${ok ? '' : '  -> ' + detail}`);
}

async function call(method, p, { token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers });
  let data = null; try { data = await res.json(); } catch (e) { /* 可能非 JSON */ }
  return { status: res.status, data };
}

const waitHealth = async (retries = 60) => {
  for (let i = 0; i < retries; i++) {
    try { const r = await call('GET', '/api/health'); if (r.status === 200) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

// ---------- 夹具 ----------
const t = now();
const STU_A = 'stu_trend_a';   // 含 leave 的成员（本套件的主角）
const STU_B = 'stu_trend_b';   // 对照：不含 leave，用于验证不串数据
const D1 = '2026-03-01';
const D2 = '2026-03-02';

const ins = (sql, ...args) => db.prepare(sql).run(...args);

function mkStudent(id, name) {
  ins(`INSERT INTO students (id, name, status, join_date, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?)`, id, name, t, t, t);
}

// schedules.course_id 有外键指向 courses，必须复用夹具里真实存在的课程 id，
// 不能凭空写一个 course_trend（否则 FOREIGN KEY constraint failed）。
const COURSE_ID = (db.prepare('SELECT id FROM courses LIMIT 1').get() || {}).id;

function mkSchedule(id) {
  ins(`INSERT INTO schedules (id, course_id, course_name, status, date, start_time, end_time, classroom_name, teacher_name)
       VALUES (?, ?, '口径一致性探针课', 'scheduled', ?, '10:00', '11:00', '1号馆', '王老师')`,
    id, COURSE_ID, D1);
}

let attSeq = 0;
function mkAttendance(studentId, studentName, scheduleId, status, date) {
  attSeq++;
  ins(`INSERT INTO attendances (id, schedule_id, student_id, student_name, status, date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    `att_trend_${attSeq}`, scheduleId, studentId, studentName, status, date, t, t);
}

const tvOf = (openid) => {
  const r = db.prepare('SELECT COALESCE(token_version, 0) AS tv FROM users WHERE openid = ?').get(openid);
  return r ? r.tv : 0;
};

async function summaryOf(studentId, token) {
  const r = await call('GET', `/api/attendances/summary?studentId=${encodeURIComponent(studentId)}`, { token });
  const d = r.data && r.data.data;
  return { status: r.status, summary: d && d.summary, trend: d && d.trend, raw: r.data };
}

async function main() {
  console.log('\n\x1b[1m=== 出勤统计「应到」口径一致性 回归 ===\x1b[0m');

  // 夹具必须在起服务前写好（避免与 seed 数据竞争）
  mkStudent(STU_A, '口径成员A');
  mkStudent(STU_B, '口径成员B');
  // attendances 有 UNIQUE(schedule_id, student_id)：同一场次的同一学员只能有一条考勤，
  // 因此「同一天既有 present 又有 leave」必须落在**同一天的不同场次**上，不能靠一个场次造多种状态。
  for (let i = 1; i <= 7; i++) mkSchedule(`sch_trend_${i}`);
  // A：D1 = present/late/absent/leave 各一场；D2 = present/absent 各一场
  mkAttendance(STU_A, '口径成员A', 'sch_trend_1', 'present', D1);
  mkAttendance(STU_A, '口径成员A', 'sch_trend_2', 'late', D1);
  mkAttendance(STU_A, '口径成员A', 'sch_trend_3', 'absent', D1);
  mkAttendance(STU_A, '口径成员A', 'sch_trend_4', 'leave', D1);
  mkAttendance(STU_A, '口径成员A', 'sch_trend_5', 'present', D2);
  mkAttendance(STU_A, '口径成员A', 'sch_trend_6', 'absent', D2);
  // B：D1 仅一场 present
  mkAttendance(STU_B, '口径成员B', 'sch_trend_7', 'present', D1);

  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  const IDS = resolveStaffIdentities(db);
  const adminToken = generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) });

  // ============================================================
  // T0. 前置：服务可达 + 接口返回预期结构
  // ============================================================
  console.log('\x1b[1m[T0] 前置条件：服务就绪 + /attendances/summary 返回 summary 与 trend\x1b[0m');
  {
    const health = await call('GET', '/api/health');
    rec('T0-1 /api/health 200（服务已就绪）', health.status === 200, `status=${health.status}`);

    const r = await summaryOf(STU_A, adminToken);
    rec('T0-2 /api/attendances/summary?studentId 200 且 code=0',
      r.status === 200 && r.raw && r.raw.code === 0,
      `status=${r.status} body=${JSON.stringify(r.raw)}`);
    rec('T0-3 返回体含 summary 与 trend 两个字段',
      !!r.summary && Array.isArray(r.trend),
      `summary=${JSON.stringify(r.summary)} trend=${JSON.stringify(r.trend)}`);
  }

  // ============================================================
  // T1. 汇总口径：leave 不计入应到（反假绿护栏）
  // ============================================================
  console.log('\n\x1b[1m[T1] 汇总口径：应到 = present + late + absent，不含 leave\x1b[0m');
  const { summary: sA, trend: trendA } = await summaryOf(STU_A, adminToken);
  {
    rec('T1-1 汇总 presentCount=2（D1 present + D2 present）',
      sA.presentCount === 2, `presentCount=${sA.presentCount}`);
    rec('T1-2 汇总 lateCount=1 / absentCount=2',
      sA.lateCount === 1 && sA.absentCount === 2,
      `lateCount=${sA.lateCount} absentCount=${sA.absentCount}`);
    // 反假绿护栏：leave 行必须真实存在，否则后面「趋势不含 leave」的断言
    // 可能只是因为压根没有 leave 数据，测试会假绿。
    rec('T1-3 [护栏] 汇总 leaveCount=1（leave 行确实存在，排除 leave 才有意义）',
      sA.leaveCount === 1, `leaveCount=${sA.leaveCount}`);
    rec('T1-4 汇总 totalSessions=5（= 2+1+2，不含 leave）',
      sA.totalSessions === 5, `totalSessions=${sA.totalSessions}`);
  }

  // ============================================================
  // T2. 趋势口径必须与汇总一致（核心判别项）
  // ============================================================
  console.log('\n\x1b[1m[T2] 趋势口径：trend[].total 必须与汇总同口径（判别项）\x1b[0m');
  {
    rec('T2-1 趋势返回 2 个日期（D1 / D2）',
      trendA.length === 2, `trend=${JSON.stringify(trendA)}`);

    const d1 = trendA.find((x) => x.date === D1);
    // 判别项：修复前 COUNT(*) 把 leave 也算进去 → 4；修复后 → 3。
    rec('T2-2 [判别项] D1 趋势 total=3（不含 leave；修复前 COUNT(*) 为 4）',
      d1 && d1.total === 3, `D1=${JSON.stringify(d1)}`);
    rec('T2-3 D1 趋势 attended=2（present + late）',
      d1 && d1.attended === 2, `D1.attended=${d1 && d1.attended}`);

    const d2 = trendA.find((x) => x.date === D2);
    rec('T2-4 D2 趋势 total=2 / attended=1',
      d2 && d2.total === 2 && d2.attended === 1, `D2=${JSON.stringify(d2)}`);

    // 不变式：这才是「同一页面两个数字必须相等」的真正表述，且不依赖单日数据。
    // 修复前 4+2=6 ≠ 5；修复后 3+2=5 === 5。
    const trendSum = trendA.reduce((acc, x) => acc + (x.total || 0), 0);
    rec('T2-5 [不变式] 趋势各日 total 求和 === 汇总 totalSessions（5）',
      trendSum === sA.totalSessions,
      `trendSum=${trendSum} totalSessions=${sA.totalSessions}`);
  }

  // ============================================================
  // T3. 对照/隔离：另一成员的数据不得串进来
  // ============================================================
  console.log('\n\x1b[1m[T3] 对照：按 studentId 过滤不得串数据\x1b[0m');
  {
    const { summary: sB, trend: trendB } = await summaryOf(STU_B, adminToken);
    rec('T3-1 成员B 汇总 totalSessions=1（未被成员A 的数据污染）',
      sB.totalSessions === 1, `totalSessions=${sB.totalSessions}`);
    rec('T3-2 成员B 汇总 leaveCount=0',
      sB.leaveCount === 0, `leaveCount=${sB.leaveCount}`);
    rec('T3-3 成员B 趋势仅 1 个日期且 total=1',
      trendB.length === 1 && trendB[0].total === 1, `trend=${JSON.stringify(trendB)}`);
    const sumB = trendB.reduce((acc, x) => acc + (x.total || 0), 0);
    rec('T3-4 [不变式] 成员B 趋势求和 === 汇总 totalSessions（1）',
      sumB === sB.totalSessions, `trendSum=${sumB} totalSessions=${sB.totalSessions}`);
  }

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n========================================');
  console.log(`  结果：${passed} PASS / ${failed} FAIL`);
  console.log('========================================');
  db.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
