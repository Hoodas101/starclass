/**
 * 回归套件 —— 删除学员后，其未来场次的报名名额必须释放
 *
 * 被验证的缺陷（名额被幽灵占用 → 报不进来 + 名单对不上）：
 *   DELETE /api/students/:id（backend/routes/students.js:907）此前只做两件事：
 *     · 置 students.status='refunded' / archived=1
 *     · DELETE FROM parent_bindings
 *   **不清理该学员的 enrollments**。于是他继续占着未来场次的名额：
 *     · schedules.js:887 的容量闸 `enrolled_count >= max_students` 据此误判「已满」，
 *       其他孩子报不进来 —— 名额被一个已不存在的人永久占着；
 *     · 教练看到的应到名单（enrolled_count / 报名列表）里出现一个已不在学员列表中的人。
 *   此前只在 checkin.js:603（自动缺席定时任务）用 ACTIVE_STUDENT_SQL 单点绕过，
 *   根因没修，其余消费 enrollments 的地方仍然失真。
 *
 * 修复：删除时在事务内清理**尚未发生**的场次报名（删 enrollments 行 + 递减 enrolled_count），
 *   并作废该学员的 pending 补课权益。与「取消报名」同源口径，**不涉及课时回滚**
 *   （课时在签到 / 请假审批时扣，报名本身不占课时）。
 *
 * 边界（刻意不做，做错就是另一种事故）：
 *   **只清理未发生的场次**。已产生 attendance 的排期说明课已经上了，属历史事实；
 *   追溯删除会让往期出勤统计与教练课时费被改写。故 T3 专门钉死「历史不动」。
 *
 * 判别力设计（每条判别项在修复被移除后必须变红）：
 *   · T2-2 [判别] FUT 场次 enrolled_count 归 0（修复前仍为 1）。
 *   · T2-3 [判别·最强] 删除后另一个孩子**能报进该名额**（管理员代报名返回 code=0）。
 *     修复前容量闸 `1 >= max_students(1)` 命中，返回「该活动报名人数已满」。
 *     这条直接验证用户可见后果，而非只验证内部字段。
 *   · T2-1 [判别] 该学员在未来场次的 active 报名已不存在。
 *   · T3 是**反误伤护栏**：历史场次的报名与 attendance 必须原样保留。
 *
 * 纪律：绝不为了验证判别力而临时改坏刚写的修复——判别力由上述判别项自证。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db 与 3001 端口上的线上服务）：
 *   node tests/student-delete-release-regression.cjs
 *   KEEP_TEST_DB=1 node tests/student-delete-release-regression.cjs
 */
'use strict';

// 端口必须在 require('../server') 之前设定：server.js 在模块加载时读取 PORT。
// 3001 是线上服务；3095-3098 已被其它套件占用，这里走 3099。
process.env.PORT = process.env.PORT || '3099';

const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-student-delete-release');

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

async function call(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
const fmt = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const TOMORROW = fmt(Date.now() + 86400000);   // 未来场次：应被释放
const YESTERDAY = fmt(Date.now() - 86400000);  // 历史场次：必须原样保留

const S1 = 'stu_delrel_main';    // 将被删除的学员
const S2 = 'stu_delrel_other';   // 删除后应能报进名额的另一个孩子
const SCH_FUT = 'sch_delrel_fut';
const SCH_PAST = 'sch_delrel_past';
const PARENT_OPENID = 'wx_delrel_parent';

const ins = (sql, ...args) => db.prepare(sql).run(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

const COURSE_ID = (db.prepare('SELECT id FROM courses LIMIT 1').get() || {}).id;

function mkStudent(id, name) {
  ins(`INSERT INTO students (id, name, status, archived, join_date, created_at, updated_at)
       VALUES (?, ?, 'active', 0, ?, ?, ?)`, id, name, t, t, t);
}

/** max_students=1 是关键：名额只有一个，被幽灵占用后别人必然报不进来。 */
function mkSchedule(id, date, maxStudents, enrolledCount) {
  ins(`INSERT INTO schedules (id, course_id, course_name, status, date, start_time, end_time,
        classroom_name, teacher_name, max_students, enrolled_count)
       VALUES (?, ?, '名额释放探针课', 'scheduled', ?, '10:00', '11:00', '1号馆', '王老师', ?, ?)`,
    id, COURSE_ID, date, maxStudents, enrolledCount);
}

function mkEnrollment(id, studentId, studentName, scheduleId) {
  ins(`INSERT INTO enrollments (id, student_id, student_name, course_id, course_name, schedule_id, status, enrolled_at, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, '名额释放探针课', ?, 'active', ?, ?, ?, '夹具')`,
    id, studentId, studentName, COURSE_ID, scheduleId, t, t, t);
}

function mkAttendance(id, studentId, studentName, scheduleId, date, status) {
  ins(`INSERT INTO attendances (id, schedule_id, student_id, student_name, status, date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, scheduleId, studentId, studentName, status, date, t, t);
}

const tvOf = (openid) => {
  const r = db.prepare('SELECT COALESCE(token_version, 0) AS tv FROM users WHERE openid = ?').get(openid);
  return r ? r.tv : 0;
};

const activeEnrollCount = (studentId, scheduleId) =>
  one("SELECT COUNT(*) c FROM enrollments WHERE student_id = ? AND schedule_id = ? AND status = 'active'",
    studentId, scheduleId).c;

const enrolledCountOf = (scheduleId) =>
  (one('SELECT enrolled_count FROM schedules WHERE id = ?', scheduleId) || {}).enrolled_count;

async function main() {
  console.log('\n\x1b[1m=== 删除学员后释放未来场次报名名额 回归 ===\x1b[0m');

  mkStudent(S1, '待删除学员');
  mkStudent(S2, '另一个孩子');
  // 未来场次：max_students=1 且已占满（被 S1 占着）
  mkSchedule(SCH_FUT, TOMORROW, 1, 1);
  mkEnrollment('enr_delrel_fut', S1, '待删除学员', SCH_FUT);
  // 历史场次：已上过课（有 attendance），必须原样保留
  mkSchedule(SCH_PAST, YESTERDAY, 5, 1);
  mkEnrollment('enr_delrel_past', S1, '待删除学员', SCH_PAST);
  mkAttendance('att_delrel_past', S1, '待删除学员', SCH_PAST, YESTERDAY, 'present');
  // 家长绑定（既验证既有行为，也作为删除成功的旁证）
  ins('INSERT INTO parent_bindings (student_id, parent_openid, is_main) VALUES (?, ?, 1)', S1, PARENT_OPENID);
  // 待补课权益：删除后必须作废，否则自动排补课时会把已删学员塞进未来场次
  ins(`INSERT INTO makeup_records (id, student_id, student_name, makeup_schedule_id, status, created_at, updated_at)
       VALUES (?, ?, '待删除学员', ?, 'pending', ?, ?)`, 'mk_delrel_1', S1, SCH_FUT, t, t);

  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  const IDS = resolveStaffIdentities(db);
  const adminToken = generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) });

  // ============================================================
  // T0. 前置：夹具确已构成「名额被占满」的局面
  // ============================================================
  console.log('\x1b[1m[T0] 前置：未来场次名额确被该学员占满\x1b[0m');
  {
    rec('T0-1 /api/health 200（服务已就绪）', (await call('GET', '/api/health')).status === 200);
    rec('T0-2 未来场次 max_students=1 且 enrolled_count=1（已满）',
      enrolledCountOf(SCH_FUT) === 1, `enrolled_count=${enrolledCountOf(SCH_FUT)}`);
    rec('T0-3 该学员在未来场次有 1 条 active 报名',
      activeEnrollCount(S1, SCH_FUT) === 1, `count=${activeEnrollCount(S1, SCH_FUT)}`);
    rec('T0-4 历史场次存在该学员的 attendance（用于验证不被追溯删除）',
      !!one('SELECT 1 FROM attendances WHERE id = ?', 'att_delrel_past'), 'missing');
    // 反假绿护栏：删除前，另一个孩子确实报不进来（证明容量闸生效、夹具有效）
    const blocked = await call('POST', `/api/schedules/${SCH_FUT}/enroll`, {
      token: adminToken, body: { studentId: S2 },
    });
    rec('T0-5 [护栏] 删除前另一个孩子报名被拒（名额已满）——证明容量闸真实生效',
      !(blocked.data && blocked.data.code === 0),
      `body=${JSON.stringify(blocked.data)}`);
  }

  // ============================================================
  // T1. 执行删除（既有行为不得被破坏）
  // ============================================================
  console.log('\n\x1b[1m[T1] 执行删除：既有行为保持（归档 / 解绑 / 留痕）\x1b[0m');
  {
    const r = await call('DELETE', `/api/students/${S1}`, { token: adminToken });
    rec('T1-1 DELETE /api/students/:id 200 且 code=0',
      r.status === 200 && r.data && r.data.code === 0,
      `status=${r.status} body=${JSON.stringify(r.data)}`);

    const s1 = one('SELECT status, archived FROM students WHERE id = ?', S1);
    rec("T1-2 学员已归档：status='refunded' 且 archived=1",
      s1 && s1.status === 'refunded' && s1.archived === 1, JSON.stringify(s1));
    rec('T1-3 家长绑定已解绑',
      !one('SELECT 1 FROM parent_bindings WHERE student_id = ?', S1), '仍有绑定残留');
    const mk = one('SELECT status FROM makeup_records WHERE id = ?', 'mk_delrel_1');
    rec('T1-4 待补课权益已作废（status=cancelled）',
      mk && mk.status === 'cancelled', JSON.stringify(mk));
  }

  // ============================================================
  // T2. 核心：未来场次的名额必须释放（判别项）
  // ============================================================
  console.log('\n\x1b[1m[T2] 未来场次名额必须释放（判别项）\x1b[0m');
  {
    rec('T2-1 [判别] 该学员在未来场次的 active 报名已清理',
      activeEnrollCount(S1, SCH_FUT) === 0, `count=${activeEnrollCount(S1, SCH_FUT)}`);
    rec('T2-2 [判别] 未来场次 enrolled_count 归 0（修复前仍为 1）',
      enrolledCountOf(SCH_FUT) === 0, `enrolled_count=${enrolledCountOf(SCH_FUT)}`);

    // 最强判别项：直接验证用户可见后果 —— 名额真的空出来了，别的孩子能报进来。
    // 修复前 capacity 闸命中「1 >= max_students(1)」，返回「该活动报名人数已满」。
    const ok = await call('POST', `/api/schedules/${SCH_FUT}/enroll`, {
      token: adminToken, body: { studentId: S2 },
    });
    rec('T2-3 [判别·最强] 删除后另一个孩子可以报进该名额（修复前报「已满」）',
      ok.status === 200 && ok.data && ok.data.code === 0,
      `status=${ok.status} body=${JSON.stringify(ok.data)}`);
    rec('T2-4 报名后 enrolled_count 回到 1（计数自洽）',
      enrolledCountOf(SCH_FUT) === 1, `enrolled_count=${enrolledCountOf(SCH_FUT)}`);
  }

  // ============================================================
  // T3. 反误伤护栏：历史场次不得被追溯删除
  // ============================================================
  console.log('\n\x1b[1m[T3] 护栏：历史场次报名与考勤必须原样保留\x1b[0m');
  {
    rec('T3-1 历史场次该学员的 active 报名仍在（有 attendance，属已发生）',
      activeEnrollCount(S1, SCH_PAST) === 1, `count=${activeEnrollCount(S1, SCH_PAST)}`);
    rec('T3-2 历史 attendance 记录仍在',
      !!one('SELECT 1 FROM attendances WHERE id = ?', 'att_delrel_past'), '历史考勤被误删');
    rec('T3-3 历史场次 enrolled_count 未被改动（仍为 1）',
      enrolledCountOf(SCH_PAST) === 1, `enrolled_count=${enrolledCountOf(SCH_PAST)}`);
  }

  console.log('\n========================================');
  console.log(`  结果：${passed} PASS / ${failed} FAIL`);
  console.log('========================================');
  db.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
