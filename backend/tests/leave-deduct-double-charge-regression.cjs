/**
 * 回归套件 —— 手工扣课不得对「已按请假扣过课」的场次重复扣课
 *
 * 被验证的缺陷（两套账本各扣一次）：
 *   机构有两套扣课账本：
 *     · deduction_logs      —— 签到扣课（checkin.js）与管理员手工扣课（membership.js）
 *     · leave_deduction_logs —— 请假审批扣课（leave.js，mode='class' 扣课时 / 'days' 扣有效期）
 *   签到路径 applyArrivalDeduction（checkin.js:322）已做交叉校验：同一 (schedule, student)
 *   若在 leave_deduction_logs 里已扣过，则签到侧跳过扣课。
 *   但**管理员手工扣课 POST /api/membership/deduct 此前只查 deduction_logs**，没查请假账本。
 *
 *   于是：学员请假获批（已扣课时）→ 管理员在后台发现"这次课没扣上"→ 手工补扣
 *   → **同一节课被扣两次**。手工扣课恰恰常发生在"以为系统漏扣"的补救时刻，
 *   比签到路径更容易踩，且一次就是重复扣课，家长拿两次记录来问，前台解释不清。
 *
 * 修复：在 /membership/deduct 的前置检查与事务内复查两处，都加上
 *   leave_deduction_logs(mode='class') 的交叉校验（与签到路径同口径）。
 *   只拦 mode='class'：mode='days' 扣的是时效卡有效期、并未消课时，不构成重复扣课。
 *
 * 判别力设计（每条判别项在修复被移除后必须变红）：
 *   · T2-1/T2-2 是**判别项**：修复前该请求会扣课成功、remaining 再减 1。
 *   · T1 是**对照组**：没有请假记录时手工扣课必须照常成功——证明拦截没有误伤正常流程。
 *   · T3 是**护栏**：mode='days'（扣有效期）不得被拦，否则等于把时效卡请假也一并禁掉。
 *   · T4 是**护栏**：原有的 deduction_logs 幂等不能被本次改动破坏。
 *   · 每条"被拒"断言都同时校验「卡上课时确实没变」，防出现
 *     "接口说成功但没扣"或"接口说失败却扣了"这类假绿。
 *
 * 纪律：绝不为了验证判别力而临时改坏刚写的修复——判别力由上述判别项自证。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db 与 3001 端口上的线上服务）：
 *   node tests/leave-deduct-double-charge-regression.cjs
 */
'use strict';

// 端口必须在 require('../server') 之前设定：server.js 在模块加载时读取 PORT。
// 3001 是线上服务；3095-3099、3101、3102 已被其它套件占用，这里走 3103。
process.env.PORT = process.env.PORT || '3103';

const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-leave-deduct-double-charge');

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
const TOMORROW = (() => {
  const d = new Date(Date.now() + 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

const STU = 'stu_dbl_stu';        // 主用例：请假扣过课，再手工扣
const STU_DAYS = 'stu_dbl_days';  // mode='days' 护栏
const STU_DUP = 'stu_dbl_dup';    // deduction_logs 幂等护栏
const CARD = 'card_dbl_count';
const CARD_DAYS = 'card_dbl_days';
const CARD_DUP = 'card_dbl_dup';
const SCH_LEAVE = 'sch_dbl_leave';   // 已按请假扣课
const SCH_PLAIN = 'sch_dbl_plain';   // 无请假记录（对照组）
const SCH_DAYS = 'sch_dbl_days';     // 请假扣的是有效期
const SCH_DUP = 'sch_dbl_dup';       // 已由 deduction_logs 扣过

const ins = (sql, ...args) => db.prepare(sql).run(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

const COURSE_ID = (db.prepare('SELECT id FROM courses LIMIT 1').get() || {}).id;

function mkStudent(id, name) {
  ins(`INSERT INTO students (id, name, status, archived, join_date, created_at, updated_at)
       VALUES (?, ?, 'active', 0, ?, ?, ?)`, id, name, t, t, t);
}
function mkCountCard(id, studentId, remaining) {
  ins(`INSERT INTO member_cards (id, student_id, card_type_id, card_type_name, billing_mode,
        status, remaining_classes, used_classes, total_classes, expires_at, created_at, updated_at)
       VALUES (?, ?, 'ct_dbl', '次数卡', 'count', 'active', ?, 0, ?, ?, ?, ?)`,
    id, studentId, remaining, remaining, t + 365 * 86400000, t, t);
}
function mkTimeCard(id, studentId) {
  ins(`INSERT INTO member_cards (id, student_id, card_type_id, card_type_name, billing_mode,
        status, remaining_classes, used_classes, total_classes, expires_at, created_at, updated_at)
       VALUES (?, ?, 'ct_dbl_t', '时效卡', 'time', 'active', 0, 0, 0, ?, ?, ?)`,
    id, studentId, t + 365 * 86400000, t, t);
}
function mkSchedule(id) {
  ins(`INSERT INTO schedules (id, course_id, course_name, status, date, start_time, end_time,
        classroom_name, teacher_name, max_students, enrolled_count)
       VALUES (?, ?, '重复扣课探针课', 'scheduled', ?, '10:00', '11:00', '1号馆', '王老师', 10, 1)`,
    id, COURSE_ID, TOMORROW);
}
/** 模拟请假审批已扣课时（mode='class'）或已扣有效期（mode='days'） */
function mkLeaveDeduction(scheduleId, studentId, cardId, mode) {
  ins(`INSERT OR IGNORE INTO leave_deduction_logs (schedule_id, student_id, card_id, mode, deducted_at)
       VALUES (?, ?, ?, ?, ?)`, scheduleId, studentId, cardId, mode, t);
}

const remainingOf = (cardId) => (one('SELECT remaining_classes r FROM member_cards WHERE id = ?', cardId) || {}).r;
const tvOf = (openid) => {
  const r = db.prepare('SELECT COALESCE(token_version, 0) AS tv FROM users WHERE openid = ?').get(openid);
  return r ? r.tv : 0;
};

/** 管理员手工扣课 */
const deduct = (body, token) => call('POST', '/api/membership/deduct', { token, body });

async function main() {
  console.log('\n\x1b[1m=== 手工扣课不得重复扣（两套账本交叉校验）回归 ===\x1b[0m');

  mkStudent(STU, '重复扣课学员');
  mkStudent(STU_DAYS, '时效请假学员');
  mkStudent(STU_DUP, '已签到扣课学员');
  mkCountCard(CARD, STU, 10);
  mkTimeCard(CARD_DAYS, STU_DAYS);
  mkCountCard(CARD_DUP, STU_DUP, 10);
  mkSchedule(SCH_LEAVE);
  mkSchedule(SCH_PLAIN);
  mkSchedule(SCH_DAYS);
  mkSchedule(SCH_DUP);
  // 关键夹具：该场次已按请假规则扣过 1 节课时
  mkLeaveDeduction(SCH_LEAVE, STU, CARD, 'class');
  // 护栏夹具：该场次的请假扣的是有效期，不是课时
  mkLeaveDeduction(SCH_DAYS, STU_DAYS, CARD_DAYS, 'days');

  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  const IDS = resolveStaffIdentities(db);
  const adminToken = generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) });

  // ============================================================
  // T0. 前置
  // ============================================================
  console.log('\x1b[1m[T0] 前置：夹具就位\x1b[0m');
  {
    rec('T0-1 /api/health 200（服务已就绪）', (await call('GET', '/api/health')).status === 200);
    // 反假绿护栏：若请假流水没写进去，T2 的"被拦截"断言会因为根本没触发而假绿
    const n = one('SELECT COUNT(*) c FROM leave_deduction_logs').c;
    rec(`T0-2 请假扣课流水已写入 2 条（实际 ${n}）`, n === 2, `实际 ${n}`);
    rec('T0-3 次数卡初始余额 10', remainingOf(CARD) === 10, `实际 ${remainingOf(CARD)}`);
  }

  // ============================================================
  // T1. 对照组：无请假记录时必须照常扣课
  // ============================================================
  console.log('\x1b[1m[T1] 对照组：无请假记录的场次，手工扣课照常成功\x1b[0m');
  {
    const before = remainingOf(CARD);
    const r = await deduct({ scheduleId: SCH_PLAIN, studentId: STU, cardId: CARD, classes: 1 }, adminToken);
    rec('T1-1 [对照] 手工扣课返回 code=0', r.status === 200 && r.data?.code === 0,
      `status=${r.status} body=${JSON.stringify(r.data)}`);
    rec('T1-2 卡上课时减少 1（10 → 9）', remainingOf(CARD) === before - 1,
      `before=${before} after=${remainingOf(CARD)}`);
    rec('T1-3 写入 deduction_logs 一行',
      !!one('SELECT 1 FROM deduction_logs WHERE schedule_id = ? AND student_id = ?', SCH_PLAIN, STU));
  }

  // ============================================================
  // T2. 判别项：已按请假扣过课时的场次必须被拦
  // ============================================================
  console.log('\x1b[1m[T2] 判别项：已按请假扣过课的场次，手工扣课必须被拒\x1b[0m');
  {
    const before = remainingOf(CARD);
    const r = await deduct({ scheduleId: SCH_LEAVE, studentId: STU, cardId: CARD, classes: 1 }, adminToken);
    // 业务失败：HTTP 仍是 200，但 code != 0（项目统一用 res.json(fail(...))）
    rec('T2-1 [判别] 手工扣课被拒（code !== 0）', r.data?.code !== 0,
      `code=${r.data?.code} msg=${r.data?.message}`);
    rec('T2-2 [判别] 卡上课时未被二次扣减（仍为 9）', remainingOf(CARD) === before,
      `before=${before} after=${remainingOf(CARD)}`);
    rec('T2-3 拒绝原因说明指向请假扣课',
      /请假/.test(String(r.data?.message || '')), `message=${r.data?.message}`);
    rec('T2-4 未写入 deduction_logs（两套账本未重复记账）',
      !one('SELECT 1 FROM deduction_logs WHERE schedule_id = ? AND student_id = ?', SCH_LEAVE, STU));
    // 请假流水必须保留不动：请假路径自身的幂等依赖该行
    rec('T2-5 请假扣课流水保留不动（未被删除）',
      !!one("SELECT 1 FROM leave_deduction_logs WHERE schedule_id = ? AND student_id = ? AND mode = 'class'",
        SCH_LEAVE, STU));
  }

  // ============================================================
  // T3. 护栏：mode='days'（扣有效期）不得被拦
  // ============================================================
  console.log('\x1b[1m[T3] 护栏：请假扣的是有效期（mode=days）时不得误拦\x1b[0m');
  {
    // 时效卡走 time 分支：不消耗课时，只落一条 count=0 的出席流水。
    // 关键断言是「没有被 leave 的 days 记录挡住」——若实现漏判 mode，此处会返回被拒。
    const r = await deduct({ scheduleId: SCH_DAYS, studentId: STU_DAYS, cardId: CARD_DAYS }, adminToken);
    rec('T3-1 mode=days 的请假记录不拦手工扣课（code=0）', r.data?.code === 0,
      `code=${r.data?.code} msg=${r.data?.message}`);
    rec('T3-2 落了 count=0 的出席流水',
      (one('SELECT count c FROM deduction_logs WHERE schedule_id = ? AND student_id = ?', SCH_DAYS, STU_DAYS) || {}).c === 0,
      JSON.stringify(one('SELECT * FROM deduction_logs WHERE schedule_id = ? AND student_id = ?', SCH_DAYS, STU_DAYS)));
  }

  // ============================================================
  // T4. 护栏：原有 deduction_logs 幂等未被破坏
  // ============================================================
  console.log('\x1b[1m[T4] 护栏：deduction_logs 原有幂等仍然生效\x1b[0m');
  {
    const before = remainingOf(CARD_DUP);
    const r1 = await deduct({ scheduleId: SCH_DUP, studentId: STU_DUP, cardId: CARD_DUP, classes: 1 }, adminToken);
    rec('T4-1 首次扣课成功', r1.data?.code === 0, JSON.stringify(r1.data));
    const after = remainingOf(CARD_DUP);
    rec('T4-2 课时减少 1', after === before - 1, `before=${before} after=${after}`);
    const r2 = await deduct({ scheduleId: SCH_DUP, studentId: STU_DUP, cardId: CARD_DUP, classes: 1 }, adminToken);
    rec('T4-3 [护栏] 重复扣课被拒', r2.data?.code !== 0, `code=${r2.data?.code}`);
    rec('T4-4 [护栏] 课时未再减少（仍为 9）', remainingOf(CARD_DUP) === after,
      `after=${after} now=${remainingOf(CARD_DUP)}`);
  }

  // ============================================================
  // T5. 鉴权：非管理员不得扣课
  // ============================================================
  console.log('\x1b[1m[T5] 鉴权：仅管理员可手工扣课\x1b[0m');
  {
    const coachToken = generateToken({ openid: IDS.coach, role: 'coach', tv: tvOf(IDS.coach) });
    const before = remainingOf(CARD);
    const r = await deduct({ scheduleId: SCH_PLAIN, studentId: STU, cardId: CARD, classes: 1 }, coachToken);
    rec('T5-1 教练调用 → 403', r.status === 403, `status=${r.status}`);
    rec('T5-2 教练调用未扣减课时', remainingOf(CARD) === before,
      `before=${before} now=${remainingOf(CARD)}`);
  }

  console.log(`\n========================================\n  结果：${passed} PASS / ${failed} FAIL\n========================================\n`);
  db.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
