/**
 * 回归套件 —— 请假扣的课时在会员卡明细里查不到（账对不上）
 *
 * 被验证的缺陷（信息无法相互印证）：
 *   请假审批通过、按班级规则扣课时时，扣课记录写进 leave_deduction_logs：
 *     · 建表 backend/migrations/014_consolidate_route_ddl.js:137
 *     · 写入 backend/routes/leave.js:73（mode='class'，扣次数卡课时）
 *              backend/routes/leave.js:92（mode='days'，扣时效卡有效天数）
 *   而会员卡课时明细 GET /api/membership/deductions（backend/routes/membership.js）
 *   此前只查 deduction_logs，于是「卡上少了一节课，却在任何明细里都查不到是谁扣的」。
 *
 * 修复（只改读路径，绝不动写入路径）：
 *   把查询改成 UNION ALL：deduction_logs ∪ leave_deduction_logs(仅 mode='class')。
 *   · mode='days' 扣的是时效卡「有效天数」、并未消课，并入会凭空多出一条消课记录；
 *   · leave_deduction_logs 无数量列，请假分支 count 恒为 NULL，调用方靠 mode 识别；
 *   · 不补写 deduction_logs：utils/attendance-revert.js:88 与 routes/admin.js:1199
 *     把 deduction_logs 当「上课扣课流水」读并删除，补写会污染撤销签到的回滚语义。
 *
 * 判别力设计（每条判别项在修复被移除后必须变红）：
 *   · T2-1 / T2-2 是**判别项**：修复前 total=1 且 list 里找不到请假扣课记录。
 *   · T3 是**安全底线**：UNION 改造最容易犯的错是让 where 过滤只作用于一个分支，
 *     从而把别的学生/别的卡的扣课记录返回出去。T3 断言明细里不含成员B 的任何记录。
 *   · T2-3 钉死 mode='days' 不并入（并入会凭空多出一条消课）。
 *
 * 纪律：绝不为了验证判别力而临时改坏刚写的修复——判别力由上述判别项自证。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db 与 3001 端口上的线上服务）：
 *   node tests/leave-deduction-visibility-regression.cjs
 *   KEEP_TEST_DB=1 node tests/leave-deduction-visibility-regression.cjs
 */
'use strict';

// 端口必须在 require('../server') 之前设定：server.js 在模块加载时读取 PORT。
// 3001 是线上服务；3095/3096/3097 已被其它套件占用，这里走 3098。
process.env.PORT = process.env.PORT || '3098';

const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-leave-deduction-visibility');

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
const STU_A = 'stu_leavevis_a';
const STU_B = 'stu_leavevis_b';
const CARD_A = 'card_leavevis_a';
const CARD_B = 'card_leavevis_b';
// 四种来源各占一个独立场次（两张表都有 UNIQUE(schedule_id, student_id) 之类的幂等约束思想，
// 用不同场次避免互相覆盖）
const SCH_CLASS = 'sch_leavevis_class';   // 上课扣课
const SCH_LEAVE_C = 'sch_leavevis_lc';    // 请假扣课 mode='class'
const SCH_LEAVE_D = 'sch_leavevis_ld';    // 请假扣天数 mode='days'
const SCH_B = 'sch_leavevis_b';           // 成员B 的记录（用于验证过滤没被破坏）

const ins = (sql, ...args) => db.prepare(sql).run(...args);

const COURSE_ID = (db.prepare('SELECT id FROM courses LIMIT 1').get() || {}).id;

function mkStudent(id, name) {
  ins(`INSERT INTO students (id, name, status, join_date, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?)`, id, name, t, t, t);
}

function mkSchedule(id) {
  ins(`INSERT INTO schedules (id, course_id, course_name, status, date, start_time, end_time, classroom_name, teacher_name)
       VALUES (?, ?, '请假扣课可见性探针课', 'scheduled', '2026-03-01', '10:00', '11:00', '1号馆', '王老师')`,
    id, COURSE_ID);
}

/** 上课扣课流水（deduction_logs）；id 为 AUTOINCREMENT，不显式插入。 */
function mkDeduction(scheduleId, studentId, cardId, count) {
  ins(`INSERT INTO deduction_logs (schedule_id, student_id, card_id, deducted_at, count)
       VALUES (?, ?, ?, ?, ?)`, scheduleId, studentId, cardId, t, count);
}

/** 请假扣课流水（leave_deduction_logs）；mode='class' 扣课时，'days' 扣有效天数。 */
function mkLeaveDeduction(scheduleId, studentId, cardId, mode) {
  ins(`INSERT INTO leave_deduction_logs (schedule_id, student_id, card_id, mode, deducted_at)
       VALUES (?, ?, ?, ?, ?)`, scheduleId, studentId, cardId, mode, t);
}

const tvOf = (openid) => {
  const r = db.prepare('SELECT COALESCE(token_version, 0) AS tv FROM users WHERE openid = ?').get(openid);
  return r ? r.tv : 0;
};

async function deductionsOf(studentId, token) {
  const r = await call('GET', `/api/membership/deductions?studentId=${encodeURIComponent(studentId)}`, { token });
  const d = r.data && r.data.data;
  return { status: r.status, list: (d && d.list) || [], total: d && d.total, raw: r.data };
}

async function main() {
  console.log('\n\x1b[1m=== 请假扣课在会员卡明细中可见 回归 ===\x1b[0m');

  mkStudent(STU_A, '请假扣课成员A');
  mkStudent(STU_B, '请假扣课成员B');
  [SCH_CLASS, SCH_LEAVE_C, SCH_LEAVE_D, SCH_B].forEach(mkSchedule);

  // 成员A：1 条上课扣课 + 1 条请假扣课(class) + 1 条请假扣天数(days)
  mkDeduction(SCH_CLASS, STU_A, CARD_A, 1);
  mkLeaveDeduction(SCH_LEAVE_C, STU_A, CARD_A, 'class');
  mkLeaveDeduction(SCH_LEAVE_D, STU_A, CARD_A, 'days');
  // 成员B：各 1 条（用于验证 UNION 改造没有破坏 where 过滤）
  mkDeduction(SCH_B, STU_B, CARD_B, 1);

  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  const IDS = resolveStaffIdentities(db);
  const adminToken = generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) });

  // ============================================================
  // T0. 前置：接口可达（UNION SQL 若写错列/缺 count 列会在这里 500）
  // ============================================================
  console.log('\x1b[1m[T0] 前置条件：服务就绪 + /membership/deductions 可用\x1b[0m');
  {
    const health = await call('GET', '/api/health');
    rec('T0-1 /api/health 200（服务已就绪）', health.status === 200, `status=${health.status}`);

    const a = await deductionsOf(STU_A, adminToken);
    rec('T0-2 /api/membership/deductions?studentId 200 且 code=0（UNION SQL 可执行）',
      a.status === 200 && a.raw && a.raw.code === 0,
      `status=${a.status} body=${JSON.stringify(a.raw)}`);
  }

  // ============================================================
  // T1. 夹具自检：三条来源各异的记录确实都写进去了
  // ============================================================
  console.log('\n\x1b[1m[T1] 夹具自检：三张来源表/分支各有一条记录\x1b[0m');
  {
    const dCount = db.prepare('SELECT COUNT(*) c FROM deduction_logs WHERE student_id = ?').get(STU_A).c;
    const lAll = db.prepare('SELECT COUNT(*) c FROM leave_deduction_logs WHERE student_id = ?').get(STU_A).c;
    const lClass = db.prepare("SELECT COUNT(*) c FROM leave_deduction_logs WHERE student_id = ? AND mode = 'class'").get(STU_A).c;
    const lDays = db.prepare("SELECT COUNT(*) c FROM leave_deduction_logs WHERE student_id = ? AND mode = 'days'").get(STU_A).c;
    rec('T1-1 deduction_logs 有 1 条', dCount === 1, `count=${dCount}`);
    rec('T1-2 leave_deduction_logs 共 2 条（class 1 + days 1）',
      lAll === 2 && lClass === 1 && lDays === 1, `all=${lAll} class=${lClass} days=${lDays}`);
  }

  // ============================================================
  // T2. 明细必须包含请假扣课，且不含 mode='days'（判别项）
  // ============================================================
  console.log('\n\x1b[1m[T2] 明细包含请假扣课、排除扣天数（判别项）\x1b[0m');
  const A = await deductionsOf(STU_A, adminToken);
  {
    // 判别项：修复前只读 deduction_logs → total=1
    rec('T2-1 [判别项] total=2（上课扣课 1 + 请假扣课 1；修复前为 1）',
      A.total === 2, `total=${A.total} list=${JSON.stringify(A.list)}`);

    const foundLeave = A.list.find((x) => x.schedule_id === SCH_LEAVE_C);
    rec('T2-2 [判别项] 明细里能按 schedule_id 找到那条请假扣课记录（修复前查不到）',
      !!foundLeave, `list=${JSON.stringify(A.list)}`);
    rec('T2-3 该条记录的 mode === "class"，调用方可据此标注「请假扣课」',
      foundLeave && foundLeave.mode === 'class', `mode=${foundLeave && foundLeave.mode}`);
    rec('T2-4 该条记录归属成员A 的卡',
      foundLeave && foundLeave.card_id === CARD_A, `card_id=${foundLeave && foundLeave.card_id}`);

    // mode='days' 扣的是时效卡有效天数、并未消课，并入会凭空多出一条消课记录
    rec("T2-5 mode='days' 的请假记录不并入明细（扣天数≠消课）",
      !A.list.some((x) => x.schedule_id === SCH_LEAVE_D),
      `list=${JSON.stringify(A.list)}`);

    // 上课扣课那条仍在，且 mode 为 null（不是 undefined：字段必须显式存在）
    const foundClass = A.list.find((x) => x.schedule_id === SCH_CLASS);
    rec('T2-6 上课扣课记录仍在且 mode 为 null',
      !!foundClass && foundClass.mode === null,
      `found=${JSON.stringify(foundClass)}`);

    rec('T2-7 每条记录都显式带 mode 字段（null 或 "class"）',
      A.list.length > 0 && A.list.every((x) => Object.prototype.hasOwnProperty.call(x, 'mode')),
      `list=${JSON.stringify(A.list)}`);
  }

  // ============================================================
  // T3. 安全底线：UNION 改造不得让 where 过滤失效而串出别人的数据
  // ============================================================
  console.log('\n\x1b[1m[T3] 安全底线：过滤仍生效，不得串出其它成员的记录\x1b[0m');
  {
    const leaked = A.list.filter((x) => x.student_id === STU_B || x.card_id === CARD_B);
    rec('T3-1 成员A 的明细里不含成员B 的任何记录',
      leaked.length === 0, `leaked=${JSON.stringify(leaked)}`);
    rec('T3-2 成员A 的明细里不含 sch_leavevis_b 场次',
      !A.list.some((x) => x.schedule_id === SCH_B), `list=${JSON.stringify(A.list)}`);

    // 反向：查成员B 只应看到自己的 1 条
    const B = await deductionsOf(STU_B, adminToken);
    rec('T3-3 成员B 的明细 total=1 且只含自己的记录',
      B.total === 1 && B.list.every((x) => x.student_id === STU_B),
      `total=${B.total} list=${JSON.stringify(B.list)}`);
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
