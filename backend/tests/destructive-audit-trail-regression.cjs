/**
 * 回归套件 —— 高危破坏性操作必须留审计痕迹
 *
 * 被验证的缺陷（不可逆操作无从追溯）：
 *   删除学员 / 删除课程 / 停用教师 都有 recordAudit 留痕，但以下三个同样是
 *   不可逆的管理员操作却**完全没有审计**：
 *     1) DELETE /api/schedules/:id（取消排期）—— 影响最大：作废全部报名、
 *        回滚已签到学员的课时 / 积分 / 收入结转，并向家长推送取消通知。
 *     2) DELETE /api/classes/:id（删除班级）—— 一并解除全部成员的班级归属，
 *        并把该班级下的排期降级为无班级排期。
 *     3) DELETE /api/classes/:id/members/:studentId（移除班级成员）。
 *   结果是「谁在什么时候删的、连带影响了什么」事后无从查证 —— 对只有一两个
 *   管理员的小机构，这直接违背「不出差错」这条底线。
 *
 * 修复：三处补 recordAudit。
 *   · 取消排期的审计写在**事务提交之后**，只记录实际发生的结果（含回滚了多少
 *     课时/积分、作废了多少待补课、通知了多少家长），回滚若部分失败也能如实反映。
 *   · 删除班级在删除**之前**先数出影响面（成员数、排期数），否则删完就查不到了。
 *   · 移除成员在 `changes === 0`（本就不是该班成员）时**不写**审计 —— 没有实际
 *     变更却写进去，只会让审计流水混进噪音，反而掩盖真正的移除动作（见 T3）。
 *
 * 判别力设计（每条判别项在修复被移除后必须变红）：
 *   · T1-1/T2-1/T4-1 是**判别项**：修复前 audit_log 里查无此行。
 *   · T3 是**反噪音护栏**：移除一个不存在的成员不得产生审计行。
 *     若实现不做 changes>0 判断，这里会多出一行，直接失败。
 *   · T4-2/T4-3 不只断言「有审计」，还断言**审计内容如实反映了影响面**
 *     （members_unlinked === 实际成员数），防止留了痕却记错数。
 *
 * 纪律：绝不为了验证判别力而临时改坏刚写的修复——判别力由上述判别项自证。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db 与 3001 端口上的线上服务）：
 *   node tests/destructive-audit-trail-regression.cjs
 */
'use strict';

// 端口必须在 require('../server') 之前设定：server.js 在模块加载时读取 PORT。
// 3001 是线上服务；3095-3099 已被其它套件占用，这里走 3101。
process.env.PORT = process.env.PORT || '3101';

const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-destructive-audit-trail');

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
const TOMORROW = fmt(Date.now() + 86400000);

const S1 = 'stu_audit_s1';
const S2 = 'stu_audit_s2';
const CLS = 'cls_audit_remove';   // 用于「移除成员」用例
const CLS2 = 'cls_audit_delete';  // 用于「删除班级」用例（2 名成员）
const SCH = 'sch_audit_cancel';

const ins = (sql, ...args) => db.prepare(sql).run(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

const COURSE_ID = (db.prepare('SELECT id FROM courses LIMIT 1').get() || {}).id;

function mkStudent(id, name) {
  ins(`INSERT INTO students (id, name, status, archived, join_date, created_at, updated_at)
       VALUES (?, ?, 'active', 0, ?, ?, ?)`, id, name, t, t, t);
}
function mkClass(id, name) {
  ins(`INSERT INTO classes (id, name, course_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`, id, name, COURSE_ID, t, t);
}
function mkMember(classId, studentId) {
  ins(`INSERT INTO class_members (id, class_id, student_id, role, joined_at)
       VALUES (?, ?, ?, 'member', ?)`, `cm_${classId}_${studentId}`, classId, studentId, t);
}
function mkSchedule(id) {
  ins(`INSERT INTO schedules (id, course_id, course_name, status, date, start_time, end_time,
        classroom_name, teacher_name, max_students, enrolled_count)
       VALUES (?, ?, '审计探针课', 'scheduled', ?, '10:00', '11:00', '1号馆', '王老师', 10, 1)`,
    id, COURSE_ID, TOMORROW);
}
function mkEnrollment(id, studentId, studentName, scheduleId) {
  ins(`INSERT INTO enrollments (id, student_id, student_name, course_id, course_name, schedule_id, status, enrolled_at, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, '审计探针课', ?, 'active', ?, ?, ?, '夹具')`,
    id, studentId, studentName, COURSE_ID, scheduleId, t, t, t);
}

const tvOf = (openid) => {
  const r = db.prepare('SELECT COALESCE(token_version, 0) AS tv FROM users WHERE openid = ?').get(openid);
  return r ? r.tv : 0;
};

/** 取最近一条匹配的审计行（entity + action + entity_id） */
const auditOf = (entity, action, entityId) =>
  one(`SELECT * FROM audit_log WHERE entity = ? AND action = ? AND entity_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`, entity, action, entityId || '');

const countAudit = (entity, action, entityId) =>
  one(`SELECT COUNT(*) c FROM audit_log WHERE entity = ? AND action = ? AND entity_id = ?`,
    entity, action, entityId || '').c;

const parseJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

async function main() {
  console.log('\n\x1b[1m=== 高危破坏性操作的审计留痕 回归 ===\x1b[0m');

  mkStudent(S1, '审计成员一');
  mkStudent(S2, '审计成员二');
  mkClass(CLS, '移除成员探针班');
  mkMember(CLS, S1);                 // S1 是成员，S2 不是
  mkClass(CLS2, '删除班级探针班');
  mkMember(CLS2, S1);
  mkMember(CLS2, S2);                // 2 名成员
  mkSchedule(SCH);
  mkEnrollment('enr_audit_1', S1, '审计成员一', SCH);

  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  const IDS = resolveStaffIdentities(db);
  const adminToken = generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) });

  // ============================================================
  // T0. 前置
  // ============================================================
  console.log('\x1b[1m[T0] 前置：服务就绪 + 基线无相关审计行\x1b[0m');
  {
    rec('T0-1 /api/health 200（服务已就绪）', (await call('GET', '/api/health')).status === 200);
    rec('T0-2 基线：取消排期审计行数为 0', countAudit('schedule', 'cancel', SCH) === 0,
      `count=${countAudit('schedule', 'cancel', SCH)}`);
    rec('T0-3 基线：删除班级审计行数为 0', countAudit('class', 'delete', CLS2) === 0,
      `count=${countAudit('class', 'delete', CLS2)}`);
  }

  // ============================================================
  // T1. 取消排期必须留痕（影响最大的一处）
  // ============================================================
  console.log('\n\x1b[1m[T1] 取消排期必须留审计（判别项）\x1b[0m');
  {
    const r = await call('DELETE', `/api/schedules/${SCH}`, { token: adminToken });
    rec('T1-1 DELETE /api/schedules/:id 200 且 code=0',
      r.status === 200 && r.data && r.data.code === 0,
      `status=${r.status} body=${JSON.stringify(r.data)}`);

    const a = auditOf('schedule', 'cancel', SCH);
    rec('T1-2 [判别] audit_log 存在 entity=schedule / action=cancel 的行（修复前查无此行）',
      !!a, '未找到审计行');
    const after = a ? parseJson(a.after_state) : null;
    rec('T1-3 审计 after_state 记录 status=cancelled',
      !!after && after.status === 'cancelled', JSON.stringify(after));
    const before = a ? parseJson(a.before_state) : null;
    rec('T1-4 审计 before_state 保留课程名与日期（可追溯是哪一场）',
      !!before && !!before.course_name && !!before.date, JSON.stringify(before));
    rec('T1-5 审计记录了操作人 actor_id（非空）',
      !!a && !!a.actor_id, `actor_id=${a && a.actor_id}`);
    // 排期确已取消（审计与事实一致，不是记了个假账）
    rec('T1-6 排期状态确已置 cancelled（审计与事实一致）',
      (one('SELECT status FROM schedules WHERE id = ?', SCH) || {}).status === 'cancelled');
  }

  // ============================================================
  // T2. 移除班级成员必须留痕
  // ============================================================
  console.log('\n\x1b[1m[T2] 移除班级成员必须留审计（判别项）\x1b[0m');
  {
    const r = await call('DELETE', `/api/classes/${CLS}/members/${S1}`, { token: adminToken });
    rec('T2-1 DELETE /api/classes/:id/members/:studentId 200 且 removed=1',
      r.status === 200 && r.data && r.data.code === 0 && r.data.data && r.data.data.removed === 1,
      `status=${r.status} body=${JSON.stringify(r.data)}`);

    const a = auditOf('class_member', 'remove', `${CLS}:${S1}`);
    rec('T2-2 [判别] audit_log 存在 entity=class_member / action=remove 的行',
      !!a, '未找到审计行');
    const before = a ? parseJson(a.before_state) : null;
    rec('T2-3 审计记录了班级名与学员名（可追溯谁被移出哪个班）',
      !!before && !!before.class_name && !!before.student_name, JSON.stringify(before));
  }

  // ============================================================
  // T3. 反噪音护栏：移除本就不是成员的人，不得产生审计行
  // ============================================================
  console.log('\n\x1b[1m[T3] 护栏：无实际变更时不得写审计噪音\x1b[0m');
  {
    const r = await call('DELETE', `/api/classes/${CLS}/members/${S2}`, { token: adminToken });
    rec('T3-1 移除非成员：接口返回 removed=0',
      r.status === 200 && r.data && r.data.data && r.data.data.removed === 0,
      `body=${JSON.stringify(r.data)}`);
    rec('T3-2 [护栏] 未产生 class_member/remove 审计行（无变更不写噪音）',
      countAudit('class_member', 'remove', `${CLS}:${S2}`) === 0,
      `count=${countAudit('class_member', 'remove', `${CLS}:${S2}`)}`);
  }

  // ============================================================
  // T4. 删除班级必须留痕，且如实反映影响面
  // ============================================================
  console.log('\n\x1b[1m[T4] 删除班级必须留审计，且影响面如实\x1b[0m');
  {
    const r = await call('DELETE', `/api/classes/${CLS2}`, { token: adminToken });
    rec('T4-1 DELETE /api/classes/:id 200 且 code=0',
      r.status === 200 && r.data && r.data.code === 0,
      `status=${r.status} body=${JSON.stringify(r.data)}`);

    const a = auditOf('class', 'delete', CLS2);
    rec('T4-2 [判别] audit_log 存在 entity=class / action=delete 的行（修复前查无此行）',
      !!a, '未找到审计行');
    const after = a ? parseJson(a.after_state) : null;
    const before = a ? parseJson(a.before_state) : null;
    // 不只断言「有审计」，还要断言**记的数是对的**：CLS2 有 2 名成员
    rec('T4-3 审计如实记录影响面：members_unlinked === 2',
      !!after && after.members_unlinked === 2, JSON.stringify(after));
    rec('T4-4 审计 before_state 记录 member_count === 2 与班级名',
      !!before && before.member_count === 2 && !!before.name, JSON.stringify(before));
    rec('T4-5 班级确已删除（审计与事实一致）',
      !one('SELECT 1 FROM classes WHERE id = ?', CLS2), '班级仍存在');
  }

  console.log('\n========================================');
  console.log(`  结果：${passed} PASS / ${failed} FAIL`);
  console.log('========================================');
  db.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
