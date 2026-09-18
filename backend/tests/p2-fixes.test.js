/**
 * 星课教务系统 — P2 修复回归测试（针对性验证本次修复的行为）
 *
 * 运行（隔离库，每次运行前重建 seed 夹具，绝不污染真实数据）：
 *   PORT=3098 NODE_ENV=test node tests/p2-fixes.test.js
 *
 * 覆盖：P2-1 请假↔考勤状态对齐+扣课幂等 / P2-4 私信已读归属 / P2-5 试听频控
 *       P2-6 线索转化幂等 / P2-7 退卡按实付 / P2-8 财务 by-product 口径 / P2-9 教师手机号脱敏
 *
 * 退出码：发现失败则非 0，便于 CI 阻断。
 */
'use strict';

const Database = require('better-sqlite3');

process.env.PORT = process.env.PORT || '3098';
// 唯一引导路径：每次运行都重建 seed 夹具库，与 CI 完全一致（详见 _bootstrap.cjs 说明）。
const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-p2');

const BASE = `http://localhost:${process.env.PORT}`;
const { generateToken } = require('../utils');
let IDS;

let passed = 0, failed = 0, warned = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${ok ? '' : '  -> ' + detail}`);
}
// 「样本不足、跳过」必须与「通过」区分：旧实现遇到无样本分支直接记 true，
// 于是该用例在空库上恒 PASS —— 属于假绿（测试通过不代表被测行为被验证过）。
function recWarn(name, detail) {
  warned++;
  console.log(`  [\x1b[33mWARN\x1b[0m] ${name}  -> ${detail}`);
}

async function call(method, p, { token, body, query } = {}) {
  let url = BASE + p;
  if (query) {
    const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) { /* 可能非 JSON */ }
  return { status: res.status, data };
}
const waitHealth = async (retries = 50) => {
  for (let i = 0; i < retries; i++) {
    try { const r = await call('GET', '/api/health'); if (r.status === 200) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

async function main() {
  console.log('\n\x1b[1m=== P2 修复回归测试 ===\x1b[0m');
  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  // token_version 吊销校验：自签 Token 需携带与库中一致的 tv（服务器启动时已跑迁移 012）
  const db = new Database(process.env.DB_PATH);
  // 夹具身份为 wx_ 前缀，按角色动态解析；解析不到会直接失败（而非静默用不存在的身份）
  IDS = resolveStaffIdentities(db);
  // schedules.teacher_id 指向 teachers.id：夹具无 phone_* 教师行，取 seed 的教练教师档案。
  // 旧快照路径曾把 IDS.coach（phone_13800000011）当作 teacher_id 写入，而 teachers 表
  // 中并无该 id —— 同一断言在两条路径上验证的是不同数据完整性条件，已随收敛消除。
  const coachTeacherId = (db.prepare("SELECT id FROM teachers WHERE status = 'active' ORDER BY id LIMIT 1").get() || {}).id;
  if (!coachTeacherId) { console.error('[p2-fixes] 夹具缺少可用教师档案，无法继续。'); process.exit(2); }
  const tvOf = (openid) => (db.prepare('SELECT token_version FROM users WHERE openid = ?').get(openid) || {}).token_version || 0;
  const tokens = {
    admin: generateToken({ openid: IDS.admin, role: 'admin', tv: tvOf(IDS.admin) }),
    coach: generateToken({ openid: IDS.coach, role: 'coach', tv: tvOf(IDS.coach) }),
    sales: generateToken({ openid: IDS.sales, role: 'sales', tv: tvOf(IDS.sales) }),
  };

  const t = () => Date.now();
  const gen = (p) => p + Math.random().toString(36).slice(2, 10);

  // 取一个真实学员与绑定家长（用于请假流）
  const bind = db.prepare('SELECT parent_openid, student_id FROM parent_bindings LIMIT 1').get();
  const studentId = bind ? bind.student_id : 'stu_002';
  const parentOpenid = bind ? bind.parent_openid : null;
  const parentToken = parentOpenid ? generateToken({ openid: parentOpenid, role: 'parent', tv: tvOf(parentOpenid) }) : null;

  // ============================================================
  // P2-9 教师列表明文手机号 / 薪酬规则脱敏
  // ============================================================
  {
    const r = await call('GET', '/api/admin/teachers', { token: tokens.coach });
    const list = (r.data && r.data.data && r.data.data.list) || [];
    const leaked = list.some(t => 'phone' in t || 'pay_rule' in t);
    rec('P2-9 教练视角不泄露 phone/pay_rule', r.status === 200 && list.length > 0 && !leaked,
      `status=${r.status} leaked=${leaked} count=${list.length}`);

    const ra = await call('GET', '/api/admin/teachers', { token: tokens.admin });
    const lista = (ra.data && ra.data.data && ra.data.data.list) || [];
    const hasPhone = lista.some(t => 'phone' in t && t.phone);
    rec('P2-9 管理员视角可见 phone', ra.status === 200 && hasPhone, `status=${ra.status} hasPhone=${hasPhone}`);
  }

  // ============================================================
  // P2-4 私信标记已读归属校验
  // ============================================================
  {
    const nid = gen('NTF_P24_');
    db.prepare(`INSERT INTO notifications (id, user_id, title, content, priority, category, status, created_at)
      VALUES (?, ?, 't', 'c', 'normal', 'schedule', 'sent', ?)`).run(nid, IDS.admin, t());
    const rc = await call('PUT', `/api/messages/${nid}/read`, { token: tokens.coach });
    rec('P2-4 越权标记他人消息已读 → 403', rc.status === 403, `status=${rc.status}`);
    const ro = await call('PUT', `/api/messages/${nid}/read`, { token: tokens.admin });
    rec('P2-4 接收人本人标记已读 → 成功', ro.status === 200, `status=${ro.status}`);
  }

  // ============================================================
  // P2-5 试听申请公开接口手机号频控
  // ============================================================
  {
    const phone = '13800000997';
    let blocked = 0, ok = 0;
    for (let i = 0; i < 7; i++) {
      const r = await call('POST', '/api/trial/apply', {
        body: { studentName: '频控测试', parentPhone: phone, preferredDate: '2099-01-01' },
      });
      if (r.status === 200 && r.data && r.data.code === 0) ok++; else blocked++;
    }
    rec('P2-5 同手机号高频试听被限流', blocked >= 1 && ok <= 5, `ok=${ok} blocked=${blocked}`);
  }

  // ============================================================
  // P2-6 线索转化幂等（重复调用不重复发奖）
  // ============================================================
  {
    const create = await call('POST', '/api/growth/leads', {
      token: tokens.admin,
      body: { name: '转化测试', phone: '13800000998', studentId, stage: 'trial' },
    });
    const lid = create.data && create.data.data && create.data.data.id;
    let firstOk = false, secondFail = false;
    if (lid) {
      const c1 = await call('POST', `/api/growth/leads/${lid}/convert`, { token: tokens.admin, body: { rewardPoints: 50 } });
      firstOk = c1.status === 200;
      const c2 = await call('POST', `/api/growth/leads/${lid}/convert`, { token: tokens.admin, body: { rewardPoints: 50 } });
      secondFail = c2.status === 200 && c2.data && c2.data.code !== 0;
    }
    rec('P2-6 线索首次转化成功', !!lid && firstOk, `lid=${lid} firstOk=${firstOk}`);
    rec('P2-6 线索重复转化被拒', secondFail, `secondFail=${secondFail}`);
  }

  // ============================================================
  // P2-1 请假↔考勤状态对齐 + 扣课幂等
  // ============================================================
  {
    // 启用请假扣课规则并给学员发放一张已知余量的次数卡，方能验证扣课幂等
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('leave_rules', ?)")
      .run(JSON.stringify({ deductMode: 'class', deductAmount: 1, requireApproval: true, monthlyLimit: 0, allowMakeup: true }));
    const cardId = gen('mc_p2_');
    const cardExp = t() + 365 * 86400000;
    db.prepare(`INSERT INTO member_cards (id, card_type_id, card_type_name, billing_mode, student_id, student_name, total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id, created_at, updated_at)
      VALUES (?, 'ct_p2', '计数卡', 'count', ?, '学员', 10, 10, 0, ?, ?, 'active', '', ?, ?)`)
      .run(cardId, studentId, t(), cardExp, t(), t());
    const beforeRemaining = db.prepare('SELECT remaining_classes FROM member_cards WHERE id = ?').get(cardId).remaining_classes;

    const course = db.prepare('SELECT id FROM courses LIMIT 1').get();
    const courseId = course ? course.id : 'course_test';
    const schId = gen('sch_p2_');
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    db.prepare(`INSERT INTO schedules (id, course_id, course_name, teacher_id, date, start_time, end_time, status, max_students, created_at, updated_at)
      VALUES (?, ?, '测试课', ?, ?, '09:00', '10:00', 'scheduled', 10, ?, ?)`)
      .run(schId, courseId, coachTeacherId, future, t(), t());

    // 模拟 auto-absent：先写入 absent 考勤
    const attId = gen('att_p2_');
    db.prepare(`INSERT INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name, status, checkin_method, date, created_at, updated_at)
      VALUES (?, ?, ?, '学员', ?, '测试课', 'absent', 'auto', ?, ?, ?)`)
      .run(attId, schId, studentId, courseId, future, t(), t());

    // 家长在缺席后补请假（应被允许）
    let applyOk = false, leaveId = null;
    if (parentToken) {
      const a = await call('POST', '/api/leave/apply', { token: parentToken, body: { scheduleId: schId, reason: '病假' } });
      applyOk = a.status === 200 && a.data && a.data.code === 0;
      const row = db.prepare("SELECT id FROM leave_requests WHERE student_id = ? AND schedule_id = ? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(studentId, schId);
      leaveId = row ? row.id : null;
    }
    rec('P2-1 缺席后家长可补请假', applyOk, `applyOk=${applyOk} parentToken=${!!parentToken}`);

    // 教练审批：absent → leave，且扣课一次
    let converted = false, deductedOnce = false, decremented = false;
    if (leaveId) {
      const ap = await call('PUT', `/api/leave/${leaveId}/approve`, { token: tokens.coach, body: { action: 'approve' } });
      const att = db.prepare('SELECT status FROM attendances WHERE id = ?').get(attId);
      converted = ap.status === 200 && att && att.status === 'leave';
      const logs = db.prepare('SELECT COUNT(*) c FROM leave_deduction_logs WHERE schedule_id = ? AND student_id = ?').get(schId, studentId).c;
      deductedOnce = logs === 1;
      const afterRemaining = db.prepare('SELECT remaining_classes FROM member_cards WHERE id = ?').get(cardId).remaining_classes;
      decremented = afterRemaining === beforeRemaining - 1;
    }
    rec('P2-1 审批将 absent 转为 leave', converted, `converted=${converted}`);
    rec('P2-1 请假扣课仅一次（幂等）', deductedOnce, `deductedOnce=${deductedOnce}`);
    rec('P2-1 扣课次数正确（-1）', decremented, `decremented=${decremented}`);

    // 反向校验：已签到(present)不可再请假（业务失败码，非 200 成功）
    const schId2 = gen('sch_p2b_');
    db.prepare(`INSERT INTO schedules (id, course_id, course_name, teacher_id, date, start_time, end_time, status, max_students, created_at, updated_at)
      VALUES (?, ?, '测试课2', ?, ?, '09:00', '10:00', 'scheduled', 10, ?, ?)`)
      .run(schId2, courseId, coachTeacherId, future, t(), t());
    db.prepare(`INSERT INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name, status, checkin_method, date, created_at, updated_at)
      VALUES (?, ?, ?, '学员', ?, '测试课2', 'present', 'teacher', ?, ?, ?)`)
      .run(gen('att_p2b_'), schId2, studentId, courseId, future, t(), t());
    let blockedPresent = true;
    if (parentToken) {
      const a = await call('POST', '/api/leave/apply', { token: parentToken, body: { scheduleId: schId2, reason: '又假' } });
      blockedPresent = !(a.data && a.data.code === 0);
    }
    rec('P2-1 已签到学员不可请假', blockedPresent, `blockedPresent=${blockedPresent}`);
  }

  // ============================================================
  // P2-7 退卡按订单实付（而非卡类型标价）
  // ============================================================
  {
    // 构造确定性场景：真实库里的购卡订单普遍无折扣（实测样本 实付=199、卡类型标价=199），
    // 用真实样本无法判别「按实付退」与「按标价退」—— 用例会恒过而毫无约束力。
    // 因此自建「标价全额、实付五折」的订单：两者相差一倍，任何退到标价的实现都会立刻暴露。
    const stu = db.prepare('SELECT id, name FROM students ORDER BY id LIMIT 1').get();
    const ct = db.prepare('SELECT id, name, price FROM membership_cards ORDER BY id LIMIT 1').get();
    const listPrice = Number(ct && ct.price) || 0;
    if (!stu || !ct || listPrice <= 0) {
      recWarn('P2-7 退卡按实付计退', '缺少学员或卡类型样本，跳过（不计入通过）');
    } else {
      const TOTAL = 10;
      const PAID = Math.round(listPrice * 0.5); // 五折成交

      /**
       * 建一张「已支付、可退」的次数卡，返回按 membership.js 声明口径推导的期望退款额。
       * 口径：实付价 × 剩余比例，且不超过订单剩余可退额（payable − 已退）。
       * 注意订单明细字段名是 unitPrice（orders.js 写入）；旧测试读 it.price 并回退 items[0]，
       * 两者都不会命中，导致其诊断输出恒为 0、断言退化为 `amt >= 0`。
       */
      const seedCard = (remaining, refundedSoFar) => {
        const ts = t();
        const orderId = gen('ORD_P27_');
        db.prepare(`INSERT INTO orders (id, order_no, student_id, student_name, order_type, items,
            total_amount, discount_amount, payable_amount, status, paid_at, refunded_amount, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'membership', ?, ?, ?, ?, 'paid', ?, ?, ?, ?)`)
          .run(orderId, gen('P27'), stu.id, stu.name,
            JSON.stringify([{ itemType: 'membershipCard', itemId: ct.id, itemName: ct.name, quantity: 1, unitPrice: listPrice, totalPrice: listPrice }]),
            listPrice, listPrice - PAID, PAID, ts, refundedSoFar, ts, ts);
        const cardId = gen('CARD_P27_');
        db.prepare(`INSERT INTO member_cards (id, card_type_id, card_type_name, student_id, student_name,
            total_classes, remaining_classes, used_classes, activated_at, expires_at, status, order_id,
            billing_mode, pause_total_ms, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 'count', 0, ?, ?)`)
          .run(cardId, ct.id, ct.name, stu.id, stu.name, TOTAL, remaining, TOTAL - remaining,
            ts, ts + 365 * 86400000, orderId, ts, ts);
        return {
          cardId,
          expected: Math.min(Math.round(remaining * PAID / TOTAL), Math.max(0, PAID - refundedSoFar)),
        };
      };

      const refund = async (cardId) => {
        const r = await call('POST', '/api/membership/refund', { token: tokens.admin, body: { cardId, studentId: stu.id, reason: '测试退卡' } });
        const amt = r.data && r.data.data && Number(r.data.data.refundAmount);
        const rfnd = db.prepare('SELECT payable_amount FROM orders WHERE id = ?').get((r.data && r.data.data && r.data.data.orderId) || '');
        return { r, amt, rfnd };
      };

      // —— 场景 A：剩余 6/10、订单无已退 → 期望 = round(6 × 实付 ÷ 10) ——
      const a = seedCard(6, 0);
      // 先自证场景可判别：按标价退会得到不同答案，否则本用例形同虚设
      const byListPrice = Math.round(6 * listPrice / TOTAL);
      rec('P2-7 场景可判别（按实付 ≠ 按标价）', a.expected !== byListPrice,
        `expectedByPaid=${a.expected} expectedByListPrice=${byListPrice} listPrice=${listPrice} paid=${PAID}`);

      const ra = await refund(a.cardId);
      rec('P2-7 退款额 = 实付价×剩余比例（非标价）',
        ra.r.status === 200 && ra.amt === a.expected,
        `status=${ra.r.status} amt=${ra.amt} expected=${a.expected}（按标价会退 ${byListPrice}）`);
      rec('P2-7 退款流水落账金额与返回值一致',
        !!ra.rfnd && Number(ra.rfnd.payable_amount) === ra.amt,
        `rfnd=${ra.rfnd && ra.rfnd.payable_amount} amt=${ra.amt}`);

      // —— 场景 B：剩余 6/10 但订单仅剩 10 可退 → 必须被硬上限截断 ——
      const b = seedCard(6, PAID - 10);
      const rb = await refund(b.cardId);
      rec('P2-7 退款额受订单剩余可退额硬上限约束',
        rb.r.status === 200 && rb.amt === b.expected && rb.amt < Math.round(6 * PAID / TOTAL),
        `amt=${rb.amt} expected=${b.expected}（未截断会退 ${Math.round(6 * PAID / TOTAL)}）`);
    }
  }

  // ============================================================
  // P2-8 财务 by-product 口径（退款按比例分摊 + 收入用实付）
  // ============================================================
  {
    const start = '2000-01-01', end = '2099-12-31';
    const r = await call('GET', '/api/finance/by-product', { token: tokens.admin, query: { startDate: start, endDate: end } });
    const list = (r.data && r.data.data && r.data.data.list) || [];
    const numeric = list.every(p => Number.isFinite(p.revenue) && Number.isFinite(p.refunded) && Number.isFinite(p.net));
    rec('P2-8 by-product 返回数值合理聚合', r.status === 200 && Array.isArray(list) && numeric, `status=${r.status} count=${list.length}`);
  }

  db.close();
  console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}  WARN ${warned}\x1b[0m`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常', e); process.exit(2); });
