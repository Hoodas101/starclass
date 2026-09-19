/**
 * 回归套件 —— 「取消排期」回滚已签到学员的课时 / 积分 / 收入结转
 *
 * 被验证的缺陷（四处统计互相矛盾）：
 *   取消排期有两条路径 —— PUT /api/schedules/:id 的 status='cancelled' 分支
 *   （routes/schedules.js）与 DELETE /api/schedules/:id —— 两者此前都只改
 *   schedules.status / enrollments.status / enrolled_count，**完全不碰**：
 *     · attendances        —— 考勤行原样保留，出勤率 / 课消统计仍把这场算进去
 *     · deduction_logs     —— 扣课流水保留，学员的课时被**白扣**
 *     · member_cards       —— 不退还课时
 *     · point_logs/points  —— 签到积分不回收，学员**白拿**
 *     · revenue_recognitions —— 已结转收入不冲销，合同负债被低估
 *   而 payroll.js:74 却按 `s.status != 'cancelled'` 把这场课剔出教练课时费 ——
 *   于是「课时白扣、积分白送、出勤率虚高、收入仍挂账、教练费却已剔除」，
 *   同一场取消的活动在五处口径上互相矛盾。
 *
 * 修复方式（已完成，本套件只做验证，不改业务代码）：
 *   · 新增 utils/attendance-revert.js，把 routes/checkin.js 里既有的回滚逻辑
 *     （reversePoints / revertRevenueRecognition / 扣课回退）抽为共享原语，
 *     并新增 revertScheduleAttendances()：按考勤行状态回滚
 *       - present / late → 回滚积分 + 退还课时 + 冲销结转，然后删考勤行
 *       - absent         → 仅删考勤行（未扣课时未发积分）
 *       - leave          → **保留**（请假是独立业务，不因活动取消退还请假课时）
 *   · schedules.js 两条取消路径在**既有事务内、状态更新之前**调用它，
 *     保证「回滚 + 取消报名 + 置 cancelled」原子，不会留下半截状态。
 *
 * 判别力实测（不是推测 —— 把 backend/ 整树复制到 /tmp，用 git HEAD 版
 * routes/checkin.js 与 routes/schedules.js 覆盖副本里的同名文件，**保留**新增的
 * utils/attendance-revert.js（HEAD 版两个路由都不 require 它，保留只是避免
 * require 直接崩，不参与任何断言），在副本上跑本套件；工作区业务代码未改动）：
 *   修复前：PASS 20 / FAIL 13      修复后：PASS 33 / FAIL 0
 *   13 条 FAIL 全部落在标 [判别] 的条目上，一处不多一处不少：
 *     · T2  DELETE 路径 6 条：课时复原 / 积分复原 / deduction_logs 清空 /
 *           revenue_recognitions 清空 / attendances 清空 / 有 schedule_cancel_revert 审计
 *     · T3  PUT 路径 6 条：同上
 *     · T6  absent 考勤行已删除 1 条
 *   其余 20 条护栏在修复前后结果相同（均 PASS），已逐条标注为「护栏」。
 *
 * 判别力边界（据实标注，避免把「护栏」伪装成「判别项」）：
 *   · T1（签到确实产生了扣课 / 积分 / 结转 / 考勤，共 7 条）是**护栏**：它在修复前后
 *     结果相同，作用是证明夹具真的命中了「已签到学员」这一前提。若夹具没造好（例如卡
 *     没被扣、结转没写），T2/T3 的「已复原」就会变成恒真的假绿，T1 先失败即可暴露。
 *   · T2 / T3 中「取消成功且返回 code 0」「排期置 cancelled（+enrolled_count 归零）」
 *     「报名置 cancelled」在修复前后同结果 → **护栏**（HEAD 版本就改这些字段）。
 *   · T4（leave 考勤保留，3 条）是**护栏**：HEAD 版本同样保留（它压根不删任何考勤行），
 *     它钉死的是「回滚不能顺手把请假记录也删掉」这条边界。
 *   · T5（无签到的排期取消不报错）是**护栏**：HEAD 版本同样不报错。
 *   · T6 中「前置」「取消成功」「课时未被虚增」3 条是护栏；T6 真正的判别项是
 *     「absent 考勤行已删除」（HEAD 版本不删任何考勤行 → 实测 c=1）。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db）：
 *   node tests/schedule-cancel-revert-regression.cjs
 *   KEEP_TEST_DB=1 node tests/schedule-cancel-revert-regression.cjs   （保留临时库排查）
 *
 * 写法说明：建库/清理沿用 _bootstrap.cjs（seed 夹具 + 退出时删除临时库），
 * 直调路由处理器沿用 deleted-student-exclusion-regression.cjs 的
 * getHandler/mockRes/mockReq（不启 HTTP 服务，避免与线上占用的 3001 端口及并发套件冲突）。
 */
'use strict';

// ---- 隔离库（必须在 require('../db') 之前设置）----
const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-schedule-cancel-revert');

const db = require('../db');
const { now, formatDate } = require('../utils');
const schedulesRouter = require('../routes/schedules');
const checkinRouter = require('../routes/checkin');

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

// ---------- 管理员身份 ----------
// 两条取消路径均走 isAdminReq(req)（userRole='admin' 即通过）；
// checkin 的审计留痕走 getActor(req)，必须给一个**真实存在于 users 表**的 admin openid。
const IDS = resolveStaffIdentities(db);
const ADMIN_OPENID = IDS.admin;
const asAdmin = (extra) => mockReq(Object.assign({ userRole: 'admin', openid: ADMIN_OPENID }, extra));

// ---------- 夹具 ----------
const t = now();
const today = formatDate(t);
const DAY = 86400000;
const ins = (sql, ...p) => db.prepare(sql).run(...p);

/**
 * 造一个「已签到就会产生扣课 + 积分 + 收入结转」的完整场景：
 * 学员 / 关联订单 / 次数卡（order_id 指向该订单，使结转能推导出单价）/ 课程 /
 * 排期 / 报名。card_type_id 与订单明细的 itemId 对齐，deriveUnitPrice 才能命中。
 */
function mkScenario(sfx) {
  const stu = `stu_crv_${sfx}`;
  const ord = `ord_crv_${sfx}`;
  const card = `mc_crv_${sfx}`;
  const crs = `crs_crv_${sfx}`;
  const sch = `sch_crv_${sfx}`;
  ins("INSERT OR IGNORE INTO students (id, name, status, archived, created_at, updated_at) VALUES (?, ?, 'active', 0, ?, ?)",
    stu, `回滚学员${sfx}`, t, t);
  ins(`INSERT INTO orders (id, order_no, student_id, student_name, order_type, items,
         total_amount, discount_amount, payable_amount, status, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'membership', ?, 1000, 0, 1000, 'paid', ?, ?, ?)`,
    ord, `OCRV${sfx}`, stu, `回滚学员${sfx}`,
    JSON.stringify([{ itemId: `ct_crv_${sfx}`, itemName: `回滚次卡${sfx}`, unitPrice: 1000, quantity: 1 }]),
    t, t, t);
  ins("INSERT INTO courses (id, name, category, consume_classes, is_active, created_at) VALUES (?, ?, 'training', 1, 1, ?)",
    crs, `回滚活动${sfx}`, t);
  ins(`INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name,
         total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
       VALUES (?, ?, ?, 'count', ?, ?, 10, 10, 0, ?, ?, 'active', ?, ?, ?)`,
    card, `ct_crv_${sfx}`, `回滚次卡${sfx}`, stu, `回滚学员${sfx}`, t - DAY, t + 200 * DAY, ord, t, t);
  ins(`INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, date, start_time, end_time,
         status, enrolled_count, created_at, updated_at)
       VALUES (?, ?, ?, 'teacher_001', '王教练', ?, '09:00', '10:00', 'scheduled', 1, ?, ?)`,
    sch, crs, `回滚活动${sfx}`, today, t, t);
  ins(`INSERT INTO enrollments (id, student_id, student_name, course_id, course_name, schedule_id,
         enroll_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'schedule', 'active', ?, ?)`,
    `enr_crv_${sfx}`, stu, `回滚学员${sfx}`, crs, `回滚活动${sfx}`, sch, t, t);
  return { stu, ord, card, crs, sch };
}

function checkin(scheduleId, studentId, status) {
  const res = mockRes();
  getHandler(checkinRouter, 'post', '/teacher')(asAdmin({
    body: { scheduleId, attendances: [{ studentId, status }] },
  }), res);
  return res;
}
function cancelByDelete(id) {
  const res = mockRes();
  getHandler(schedulesRouter, 'delete', '/:id')(asAdmin({ params: { id } }), res);
  return res;
}
function cancelByPut(id) {
  const res = mockRes();
  getHandler(schedulesRouter, 'put', '/:id')(asAdmin({ params: { id }, body: { status: 'cancelled' } }), res);
  return res;
}

// ---------- 观测封装 ----------
const cardOf = (id) => db.prepare('SELECT remaining_classes, used_classes FROM member_cards WHERE id = ?').get(id);
const ptsOf = (stu) => db.prepare('SELECT total_earned, balance FROM points WHERE student_id = ?').get(stu);
const dedCount = (sch) => db.prepare('SELECT COUNT(*) c FROM deduction_logs WHERE schedule_id = ?').get(sch).c;
const rrCount = (sch) => db.prepare('SELECT COUNT(*) c FROM revenue_recognitions WHERE schedule_id = ?').get(sch).c;
const attRows = (sch) => db.prepare('SELECT status, points_earned FROM attendances WHERE schedule_id = ?').all(sch);
const auditCount = (sch, action) => db.prepare(
  "SELECT COUNT(*) c FROM audit_log WHERE entity = 'attendance' AND action = ? AND entity_id LIKE ?"
).get(action, `${sch}:%`).c;

// ============================================================
// T1 [护栏] 夹具前置：签到确实产生扣课 / 积分 / 结转 / 考勤
// ============================================================
console.log('\x1b[1m[T1] 夹具前置（护栏：证明后续「已复原」不是恒真假绿）\x1b[0m');
const A = mkScenario('a');
{
  const r = checkin(A.sch, A.stu, 'present');
  rec('T1 签到返回成功', r.body && r.body.code === 0, JSON.stringify(r.body));
  const card = cardOf(A.card);
  rec('T1 签到扣课 1（remaining 10→9 / used 0→1）',
    card.remaining_classes === 9 && card.used_classes === 1, JSON.stringify(card));
  rec('T1 deduction_logs 恰好 1 行', dedCount(A.sch) === 1, `c=${dedCount(A.sch)}`);
  const pts = ptsOf(A.stu);
  rec('T1 积分已发放（balance/total_earned 均为 10）',
    pts && pts.balance === 10 && pts.total_earned === 10, JSON.stringify(pts));
  rec('T1 revenue_recognitions 已写入 1 行', rrCount(A.sch) === 1, `c=${rrCount(A.sch)}`);
  const att = attRows(A.sch);
  rec('T1 attendances 恰好 1 行 present', att.length === 1 && att[0].status === 'present', JSON.stringify(att));
  rec('T1 排期仍为 scheduled', db.prepare('SELECT status FROM schedules WHERE id = ?').get(A.sch).status === 'scheduled', '');
}

// ============================================================
// T2 [判别] DELETE /api/schedules/:id 取消 → 全部回滚
// ============================================================
console.log('\x1b[1m[T2] DELETE 取消排期 → 回滚（判别项）\x1b[0m');
{
  const r = cancelByDelete(A.sch);
  rec('T2 取消成功且返回 code 0', r.body && r.body.code === 0, JSON.stringify(r.body));
  const card = cardOf(A.card);
  rec('[判别] T2 课时复原（remaining 9→10 / used 1→0）',
    card.remaining_classes === 10 && card.used_classes === 0, JSON.stringify(card));
  const pts = ptsOf(A.stu);
  rec('[判别] T2 积分复原（balance/total_earned 均回到 0）',
    pts && pts.balance === 0 && pts.total_earned === 0, JSON.stringify(pts));
  rec('[判别] T2 deduction_logs 已清空', dedCount(A.sch) === 0, `c=${dedCount(A.sch)}`);
  rec('[判别] T2 revenue_recognitions 已冲销', rrCount(A.sch) === 0, `c=${rrCount(A.sch)}`);
  rec('[判别] T2 attendances 已清空', attRows(A.sch).length === 0, `c=${attRows(A.sch).length}`);
  rec('[判别] T2 写入 schedule_cancel_revert 审计',
    auditCount(A.sch, 'schedule_cancel_revert') === 1, `c=${auditCount(A.sch, 'schedule_cancel_revert')}`);
  const sch = db.prepare('SELECT status, enrolled_count FROM schedules WHERE id = ?').get(A.sch);
  rec('T2 排期置 cancelled 且 enrolled_count 归零',
    sch.status === 'cancelled' && sch.enrolled_count === 0, JSON.stringify(sch));
  const enr = db.prepare('SELECT status FROM enrollments WHERE schedule_id = ?').get(A.sch);
  rec('T2 报名置 cancelled', enr.status === 'cancelled', JSON.stringify(enr));
}

// ============================================================
// T3 [判别] PUT /api/schedules/:id {status:'cancelled'} 取消 → 全部回滚
// ============================================================
console.log('\x1b[1m[T3] PUT 取消排期 → 回滚（判别项）\x1b[0m');
const B = mkScenario('b');
{
  const ck = checkin(B.sch, B.stu, 'present');
  rec('T3 前置：签到成功并产生扣课/积分/结转',
    ck.body && ck.body.code === 0 && cardOf(B.card).remaining_classes === 9
      && dedCount(B.sch) === 1 && rrCount(B.sch) === 1 && attRows(B.sch).length === 1,
    JSON.stringify({ card: cardOf(B.card), ded: dedCount(B.sch), rr: rrCount(B.sch) }));
  const r = cancelByPut(B.sch);
  rec('T3 取消成功且返回 code 0', r.body && r.body.code === 0, JSON.stringify(r.body));
  const card = cardOf(B.card);
  rec('[判别] T3 课时复原（remaining 9→10 / used 1→0）',
    card.remaining_classes === 10 && card.used_classes === 0, JSON.stringify(card));
  const pts = ptsOf(B.stu);
  rec('[判别] T3 积分复原（balance/total_earned 均回到 0）',
    pts && pts.balance === 0 && pts.total_earned === 0, JSON.stringify(pts));
  rec('[判别] T3 deduction_logs 已清空', dedCount(B.sch) === 0, `c=${dedCount(B.sch)}`);
  rec('[判别] T3 revenue_recognitions 已冲销', rrCount(B.sch) === 0, `c=${rrCount(B.sch)}`);
  rec('[判别] T3 attendances 已清空', attRows(B.sch).length === 0, `c=${attRows(B.sch).length}`);
  rec('[判别] T3 写入 schedule_cancel_revert 审计',
    auditCount(B.sch, 'schedule_cancel_revert') === 1, `c=${auditCount(B.sch, 'schedule_cancel_revert')}`);
  rec('T3 排期置 cancelled', db.prepare('SELECT status FROM schedules WHERE id = ?').get(B.sch).status === 'cancelled', '');
}

// ============================================================
// T4 [护栏] leave 考勤保留：请假是独立业务，不因活动取消退还请假课时
// ============================================================
console.log('\x1b[1m[T4] leave 考勤保留（护栏）\x1b[0m');
const C = mkScenario('c');
{
  ins(`INSERT INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name,
         status, checkin_method, points_earned, date, created_at, updated_at)
       VALUES ('att_crv_c', ?, ?, '回滚学员c', ?, '回滚活动c', 'leave', 'manual', 0, ?, ?, ?)`,
    C.sch, C.stu, C.crs, today, t, t);
  const r = cancelByDelete(C.sch);
  rec('T4 取消成功且返回 code 0', r.body && r.body.code === 0, JSON.stringify(r.body));
  const att = attRows(C.sch);
  rec('T4 leave 考勤行被保留（不被顺手删除）',
    att.length === 1 && att[0].status === 'leave', JSON.stringify(att));
  const card = cardOf(C.card);
  rec('T4 课时未被虚增（remaining 仍 10 / used 仍 0）',
    card.remaining_classes === 10 && card.used_classes === 0, JSON.stringify(card));
}

// ============================================================
// T5 [护栏] 无任何考勤的排期取消：不报错、不产生副作用
// ============================================================
console.log('\x1b[1m[T5] 无签到排期取消（护栏）\x1b[0m');
const D = mkScenario('d');
{
  const r = cancelByDelete(D.sch);
  rec('T5 无考勤时取消不报错（code 0）', r.body && r.body.code === 0, JSON.stringify(r.body));
}

// ============================================================
// T6 [判别] absent 考勤：未扣课时未发积分，仅删除考勤行
// ============================================================
console.log('\x1b[1m[T6] absent 考勤仅删行（判别项）\x1b[0m');
const E = mkScenario('e');
{
  const ck = checkin(E.sch, E.stu, 'absent');
  rec('T6 前置：签到为 absent 且未扣课未发积分',
    ck.body && ck.body.code === 0 && cardOf(E.card).remaining_classes === 10
      && dedCount(E.sch) === 0 && attRows(E.sch).length === 1,
    JSON.stringify({ card: cardOf(E.card), ded: dedCount(E.sch), att: attRows(E.sch) }));
  const r = cancelByDelete(E.sch);
  rec('T6 取消成功且返回 code 0', r.body && r.body.code === 0, JSON.stringify(r.body));
  rec('[判别] T6 absent 考勤行已删除', attRows(E.sch).length === 0, `c=${attRows(E.sch).length}`);
  const card = cardOf(E.card);
  rec('T6 课时未被虚增（remaining 仍 10 / used 仍 0）',
    card.remaining_classes === 10 && card.used_classes === 0, JSON.stringify(card));
}

// ---------- 输出 ----------
db.close();
console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
process.exit(failed > 0 ? 1 : 0);
