/**
 * 批次 9 · 支付/退款幂等 + 跨教练签到鉴权 + 请求边界（离线，隔离库）
 *
 * 为什么单独成文件：这些用例都需要真实 HTTP 服务（路由级鉴权、body-parser 上限、
 * 事务边界），但 full-system 已过大；拆出来可独立定位失败，也不与它抢同一份夹具库。
 *
 * 覆盖：
 *   T1 同一订单重复支付 → 第二次被拒（订单已支付），且只产生一条支付流水、只发一次权益
 *   T2 支付后退款 → 卡状态/订单状态/退款流水一致；再次退款被拒（不重复退款）
 *   T3 扣课幂等（与 T1/T2 同族的「重复调用不得二次生效」）
 *   T4 跨教练签到鉴权：教练 B 为教练 A 的排期签到 → 403，且不留下考勤记录；
 *      教练 A 为本人排期签到 → 成功（证明 403 不是无差别拒绝）
 *   T5 请求边界：>1mb 请求体 → 413 且进程存活；角色边界 → 403
 *
 * 判别性说明：每条断言都锚定「若对应守卫被移除就会变红」的具体终态。
 * 尤其 T1/T2/T4 —— 源码分别是 orders.js:308-314 的原子占位、
 * orders.js:489-491 的乐观锁、checkin.js:31-41 的教练归属校验。
 * better-sqlite3 是同步 API，无法真正并发；这里按顺序连续发起两次调用，
 * 断言的是「幂等/一致终态」——若原子守卫缺失，第二次调用会真的二次生效，断言即失败。
 *
 * 运行：node tests/batch9-authz-concurrency.test.cjs
 * 退出码：发现失败则非 0，便于 CI 阻断。
 */
'use strict';

const Database = require('better-sqlite3');

process.env.PORT = process.env.PORT || '3095';
// 唯一引导路径：每次运行重建 seed 夹具库（详见 _bootstrap.cjs 说明）
const { bootstrap, resolveStaffIdentities } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-batch9');

const BASE = `http://localhost:${process.env.PORT}`;
const { generateToken } = require('../utils');

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
/** 直接投递原始 body 串（用于构造超大请求体，绕过 JSON.stringify 的可读性） */
async function rawPost(p, bodyString, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method: 'POST', headers, body: bodyString });
  let data = null; try { data = await res.json(); } catch (e) { /* 可能非 JSON */ }
  return { status: res.status, data };
}
const waitHealth = async (retries = 50) => {
  for (let i = 0; i < retries; i++) {
    try { const r = await call('GET', '/api/health'); if (r.status === 200) return true; } catch (e) { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

async function main() {
  console.log('\n\x1b[1m=== 批次9 · 支付/退款幂等 + 跨教练签到鉴权 + 请求边界 ===\x1b[0m');
  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  const db = new Database(process.env.DB_PATH);
  const IDS = resolveStaffIdentities(db);
  const tvOf = (openid) => (db.prepare('SELECT token_version FROM users WHERE openid = ?').get(openid) || {}).token_version || 0;
  const tok = (openid, role) => generateToken({ openid, role, tv: tvOf(openid) });
  const tokens = { admin: tok(IDS.admin, 'admin'), sales: tok(IDS.sales, 'sales') };

  // 跨教练用例需要两名**不同**的教练身份；夹具固定提供 wx_teacher_001/002/003。
  // 解析不到即视为夹具损坏，直接失败（而非静默跳过）。
  const COACH_A = 'wx_teacher_001';   // → teachers.teacher_001（phone 13800000011）
  const COACH_B = 'wx_teacher_002';   // → teachers.teacher_002（phone 13800000012）
  const coachRows = db.prepare("SELECT openid FROM users WHERE openid IN (?, ?) AND role = 'coach'").all(COACH_A, COACH_B);
  const hasBothCoaches = coachRows.length === 2;
  rec('T4-setup 夹具提供两名教练身份', hasBothCoaches,
    `找到=${coachRows.map((r) => r.openid).join(',')}（需要 ${COACH_A} 与 ${COACH_B}）`);
  tokens.coachA = hasBothCoaches ? tok(COACH_A, 'coach') : null;
  tokens.coachB = hasBothCoaches ? tok(COACH_B, 'coach') : null;

  const ts = () => Date.now();
  const futureDate = (days) => {
    const d = new Date(Date.now() + days * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  // ============================================================
  // T1 重复支付：原子占位（orders.js:308-314）
  // ============================================================
  console.log('\x1b[1m[T1] 同一订单重复支付\x1b[0m');
  {
    const create = await call('POST', '/api/orders', { token: tokens.admin, body: {
      studentId: 'stu_003', items: [{ itemName: '幂等零售品', unitPrice: 100, quantity: 1 }],
      discountAmount: 0, orderType: 'retail', status: 'pending',
    }});
    const oid = create.data && create.data.data && create.data.data.orderId;
    rec('T1 订单创建为 pending', !!oid, `status=${create.status} body=${JSON.stringify(create.data)}`);

    const pay1 = await call('POST', `/api/orders/${oid}/pay`, { token: tokens.admin, body: { payMethod: 'cash' } });
    const ok1 = pay1.status === 200 && pay1.data && pay1.data.code === 0;
    rec('T1 首次支付成功', ok1, `status=${pay1.status} body=${JSON.stringify(pay1.data)}`);

    // 判别性核心：第二次支付必须被原子占位拒绝。守卫（WHERE status='pending'）被移除时，
    // 这里会再次成功并再写一条支付流水 → 下面两条断言同时变红。
    const pay2 = await call('POST', `/api/orders/${oid}/pay`, { token: tokens.admin, body: { payMethod: 'cash' } });
    const rejected = pay2.data && pay2.data.code !== 0;
    rec('T1 重复支付被拒（非 200 成功）', rejected, `status=${pay2.status} body=${JSON.stringify(pay2.data)}`);
    rec('T1 拒绝原因明确为「订单已支付」', !!pay2.data && pay2.data.message === '订单已支付',
      `message=${pay2.data && pay2.data.message}`);

    const payCount = db.prepare('SELECT COUNT(*) c FROM payments WHERE order_id = ?').get(oid).c;
    rec('T1 只产生 1 条支付流水（未重复记账）', payCount === 1, `payments=${payCount}`);
    const ord = db.prepare('SELECT status, paid_at FROM orders WHERE id = ?').get(oid);
    rec('T1 订单终态 paid 且 paid_at 非空', ord.status === 'paid' && !!ord.paid_at,
      `status=${ord.status} paid_at=${ord.paid_at}`);
  }

  // ============================================================
  // T2 支付 → 退款：权益不双发、退款不重复（orders.js:489-491 乐观锁）
  // ============================================================
  console.log('\x1b[1m[T2] 支付后退款的一致性与幂等\x1b[0m');
  {
    // 会员卡订单：支付会激活一张新卡（grantOrderBenefits），正是「权益双发」的观测点
    const create = await call('POST', '/api/orders', { token: tokens.admin, body: {
      studentId: 'stu_006', cardTypeId: 'ct_004', orderType: 'membership', discountAmount: 0, status: 'pending',
    }});
    const oid = create.data && create.data.data && create.data.data.orderId;
    const payable = create.data && create.data.data && create.data.data.payableAmount;
    rec('T2 会员卡订单创建（payable=1500）', !!oid && payable === 1500,
      `status=${create.status} body=${JSON.stringify(create.data)}`);

    const pay1 = await call('POST', `/api/orders/${oid}/pay`, { token: tokens.admin, body: { payMethod: 'cash' } });
    rec('T2 首次支付成功', pay1.status === 200 && pay1.data && pay1.data.code === 0,
      `status=${pay1.status} body=${JSON.stringify(pay1.data)}`);
    const cardsAfterPay = db.prepare('SELECT COUNT(*) c FROM member_cards WHERE order_id = ?').get(oid).c;
    rec('T2 支付后恰好发放 1 张会员卡', cardsAfterPay === 1, `cards=${cardsAfterPay}`);

    // 二次支付不得再次发卡（权益双发）
    const pay2 = await call('POST', `/api/orders/${oid}/pay`, { token: tokens.admin, body: { payMethod: 'cash' } });
    const cardsAfterPay2 = db.prepare('SELECT COUNT(*) c FROM member_cards WHERE order_id = ?').get(oid).c;
    const payRows = db.prepare('SELECT COUNT(*) c FROM payments WHERE order_id = ?').get(oid).c;
    rec('T2 重复支付不二次发卡（权益不双发）',
      cardsAfterPay2 === 1 && payRows === 1 && pay2.data && pay2.data.code !== 0,
      `cards=${cardsAfterPay2} payments=${payRows} code=${pay2.data && pay2.data.code}`);

    // 全额退款
    const refund1 = await call('POST', `/api/orders/${oid}/refund`, { token: tokens.admin, body: { reason: '批次9 全额退款' } });
    const rb = refund1.data && refund1.data.data;
    rec('T2 全额退款成功且金额 = 实付 1500',
      refund1.status === 200 && !!rb && rb.refunded === true && rb.refundAmount === 1500 && rb.full === true,
      `status=${refund1.status} body=${JSON.stringify(refund1.data)}`);

    const ord = db.prepare('SELECT status, refunded_amount, payable_amount FROM orders WHERE id = ?').get(oid);
    rec('T2 订单置 refunded 且累计退款 = 实付',
      ord.status === 'refunded' && ord.refunded_amount === 1500 && ord.refunded_amount <= ord.payable_amount,
      `${ord.status}/${ord.refunded_amount}/${ord.payable_amount}`);
    const card = db.prepare('SELECT status FROM member_cards WHERE order_id = ?').get(oid);
    rec('T2 关联会员卡置 refunded（权益已回收）', !!card && card.status === 'refunded',
      `card=${JSON.stringify(card)}`);
    const refPay = db.prepare("SELECT amount, status FROM payments WHERE order_id = ? AND status = 'refunded'").get(oid);
    rec('T2 退款流水金额 = 1500 且状态 refunded',
      !!refPay && refPay.amount === 1500 && refPay.status === 'refunded', JSON.stringify(refPay));

    // 判别性核心：再次退款必须被拒，且累计退款额不变（乐观锁 + 状态守卫）。
    // 若 orders.js:474 的状态判断或 489 的乐观锁被移除，这里会二次退款 → 断言变红。
    const refund2 = await call('POST', `/api/orders/${oid}/refund`, { token: tokens.admin, body: { reason: '批次9 重复退款' } });
    const ord2 = db.prepare('SELECT refunded_amount FROM orders WHERE id = ?').get(oid);
    rec('T2 重复退款被拒且累计退款额不变',
      refund2.data && refund2.data.code !== 0 && ord2.refunded_amount === 1500,
      `code=${refund2.data && refund2.data.code} refunded=${ord2.refunded_amount} msg=${refund2.data && refund2.data.message}`);
    const refPayCount = db.prepare("SELECT COUNT(*) c FROM payments WHERE order_id = ? AND status = 'refunded'").get(oid).c;
    rec('T2 只产生 1 条退款流水', refPayCount === 1, `refundPayments=${refPayCount}`);

    // 账本收支相抵：成功流水合计必须等于退款流水合计（全额退款后净额为 0）。
    // 这条兜住「只多加了一条退款流水但金额不对」或「退款记了两次不同状态」这类漂移。
    const succSum = db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE order_id = ? AND status = 'success'").get(oid).s;
    const refSum = db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE order_id = ? AND status = 'refunded'").get(oid).s;
    rec('T2 账本收支相抵（成功流水 - 退款流水 = 0）', succSum - refSum === 0,
      `success=${succSum} refunded=${refSum}`);
  }

  // ============================================================
  // T3 扣课幂等（同族：重复调用不得二次生效）
  // ============================================================
  console.log('\x1b[1m[T3] 扣课幂等\x1b[0m');
  {
    const cardId = 'mc_006', stuId = 'stu_006', schId = 'sch_b9_deduct_' + ts();
    db.prepare("UPDATE member_cards SET remaining_classes = 10, used_classes = 0, status = 'active' WHERE id = ?").run(cardId);
    const before = db.prepare('SELECT remaining_classes FROM member_cards WHERE id = ?').get(cardId).remaining_classes;

    const d1 = await call('POST', '/api/membership/deduct', { token: tokens.admin, body: {
      scheduleId: schId, studentId: stuId, classes: 1, reason: '批次9 扣课',
    }});
    rec('T3 首次扣课成功', d1.status === 200 && d1.data && d1.data.code === 0,
      `status=${d1.status} body=${JSON.stringify(d1.data)}`);
    const rows1 = db.prepare('SELECT COUNT(*) c FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').get(schId, stuId).c;
    const after1 = db.prepare('SELECT remaining_classes FROM member_cards WHERE id = ?').get(cardId).remaining_classes;
    rec('T3 扣课落 1 条记录且卡余量 -1', rows1 === 1 && after1 === before - 1,
      `rows=${rows1} remaining=${after1}（before=${before}）`);

    const d2 = await call('POST', '/api/membership/deduct', { token: tokens.admin, body: {
      scheduleId: schId, studentId: stuId, classes: 1, reason: '批次9 重复扣课',
    }});
    const rows2 = db.prepare('SELECT COUNT(*) c FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').get(schId, stuId).c;
    const after2 = db.prepare('SELECT remaining_classes FROM member_cards WHERE id = ?').get(cardId).remaining_classes;
    rec('T3 重复扣课被拒且不二次扣减',
      d2.data && d2.data.code !== 0 && rows2 === 1 && after2 === after1,
      `code=${d2.data && d2.data.code} rows=${rows2} remaining=${after2}`);

    // 收尾
    db.prepare('DELETE FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').run(schId, stuId);
    db.prepare('UPDATE member_cards SET remaining_classes = 7, used_classes = 3 WHERE id = ?').run(cardId);
  }

  // ============================================================
  // T4 跨教练签到鉴权（checkin.js:31-41）
  // ============================================================
  console.log('\x1b[1m[T4] 跨教练签到鉴权\x1b[0m');
  if (!hasBothCoaches) {
    rec('T4 跨教练签到鉴权', false, '缺少第二名教练身份，无法验证教练归属校验');
  } else {
    // 用远期日期避开 seed 的「本周排期」冲突；teacher_001 是教练 A 的档案
    const schDate = '2099-06-15';
    const created = await call('POST', '/api/schedules', { token: tokens.admin, body: {
      courseName: '批次9跨教练鉴权', date: schDate, startTime: '23:00', endTime: '23:59',
      teacherId: 'teacher_001', maxStudents: 5,
    }});
    const schId = created.data && created.data.data && created.data.data.id;
    rec('T4 排课创建成功（授课教练 = teacher_001）', !!schId,
      `status=${created.status} body=${JSON.stringify(created.data)}`);

    if (schId) {
      const stored = db.prepare('SELECT teacher_id FROM schedules WHERE id = ?').get(schId);
      rec('T4 排期确实归属 teacher_001', !!stored && stored.teacher_id === 'teacher_001',
        `teacher_id=${stored && stored.teacher_id}`);

      await call('POST', `/api/schedules/${schId}/enroll`, { token: tokens.admin, body: { studentId: 'stu_001' } });

      // —— 越权尝试：教练 B 为教练 A 的排期签到 ——
      // 若 checkin.js:36-41 的归属校验被移除，这里会返回 code 0 并写入考勤 → 断言变红。
      const byB = await call('POST', '/api/checkin/teacher', { token: tokens.coachB, body: {
        scheduleId: schId, attendances: [{ studentId: 'stu_001', status: 'present' }],
      }});
      rec('T4 教练 B 为非本人排期签到 → 403', byB.status === 403,
        `status=${byB.status} body=${JSON.stringify(byB.data)}`);
      const leaked = db.prepare('SELECT COUNT(*) c FROM attendances WHERE schedule_id = ?').get(schId).c;
      rec('T4 越权请求未留下任何考勤记录（未半执行）', leaked === 0, `attendances=${leaked}`);

      // —— 正向对照：教练 A 为本人排期签到 ——
      // 证明上面的 403 是「归属校验」而非「无差别拒绝」；否则该用例没有判别力。
      const byA = await call('POST', '/api/checkin/teacher', { token: tokens.coachA, body: {
        scheduleId: schId, attendances: [{ studentId: 'stu_001', status: 'present' }],
      }});
      rec('T4 教练 A 为本人排期签到 → 成功（对照）',
        byA.status === 200 && byA.data && byA.data.code === 0,
        `status=${byA.status} body=${JSON.stringify(byA.data)}`);
      const att = db.prepare('SELECT status FROM attendances WHERE schedule_id = ? AND student_id = ?').get(schId, 'stu_001');
      rec('T4 教练 A 签到后写入 present 考勤', !!att && att.status === 'present',
        `attendance=${JSON.stringify(att)}`);

      await call('DELETE', `/api/schedules/${schId}`, { token: tokens.admin });
    }
  }

  // ============================================================
  // T5 请求边界：超大请求体 + 角色边界
  // ============================================================
  console.log('\x1b[1m[T5] 请求边界\x1b[0m');
  {
    // server.js 的普通请求体上限是 1mb（/api/settings/import 单独挂 100mb 解析器）。
    // 超限必须被解析器以 413 拒绝，而不是把整个 body 缓冲进内存。
    const bigBody = JSON.stringify({ name: 'x'.repeat(1100 * 1024), gender: '男' });
    const over = await rawPost('/api/students', bigBody, tokens.admin);
    rec('T5 >1mb 请求体 → 413（解析器上限生效）', over.status === 413, `status=${over.status}`);
    const alive = await call('GET', '/api/health');
    rec('T5 超大请求体后进程仍存活', alive.status === 200, `status=${alive.status}`);

    // 角色边界：销售不得改系统设置 / 触发薪资结算
    const s1 = await call('PUT', '/api/settings', { token: tokens.sales, body: { site_name: 'x' } });
    rec('T5 销售改系统设置 → 403', s1.status === 403, `status=${s1.status}`);
    const s2 = await call('POST', '/api/payroll/settle', { token: tokens.sales, body: { month: '2019-01' } });
    rec('T5 销售触发薪资结算 → 403', s2.status === 403, `status=${s2.status}`);
    // 无 token 时必须 401（与 full-system 的 A 段同口径，此处就近再钉一次）
    const s3 = await call('POST', '/api/payroll/settle', { body: { month: '2019-01' } });
    rec('T5 无 token 触发薪资结算 → 401', s3.status === 401, `status=${s3.status}`);
  }

  // ============================================================
  // T6 并发支付：同一笔订单同时发起两次，只能成功一次
  // ============================================================
  // T1 验证的是「顺序重复调用」；这里补上「同时发起」——两者都会绕过任何只在
  // 应用层做「先查后写」的实现，只有真正的原子占位才能同时挡住。
  console.log('\x1b[1m[T6] 并发支付只能成功一次\x1b[0m');
  {
    const create = await call('POST', '/api/orders', { token: tokens.admin, body: {
      studentId: 'stu_003', items: [{ itemName: '并发零售品', unitPrice: 250, quantity: 1 }],
      discountAmount: 0, orderType: 'retail', status: 'pending',
    }});
    const oid = create.data && create.data.data && create.data.data.orderId;
    rec('T6 订单创建为 pending', !!oid, `status=${create.status} body=${JSON.stringify(create.data)}`);

    const [a, b] = await Promise.all([
      call('POST', `/api/orders/${oid}/pay`, { token: tokens.admin, body: { payMethod: 'cash' } }),
      call('POST', `/api/orders/${oid}/pay`, { token: tokens.admin, body: { payMethod: 'cash' } }),
    ]);
    const okCount = [a, b].filter((x) => x.status === 200 && x.data && x.data.code === 0).length;
    rec('T6 并发两次支付恰好一次成功', okCount === 1,
      `成功次数=${okCount} a=${JSON.stringify(a.data)} b=${JSON.stringify(b.data)}`);
    const payRows = db.prepare('SELECT COUNT(*) c FROM payments WHERE order_id = ?').get(oid).c;
    rec('T6 并发后支付流水恰好 1 条', payRows === 1, `payments=${payRows}`);
    const ord = db.prepare('SELECT status FROM orders WHERE id = ?').get(oid);
    rec('T6 并发后订单终态为 paid', ord.status === 'paid', `status=${ord.status}`);
  }

  // ============================================================
  // T7 支付 / 退款的权限边界（非管理员不得动他人订单的钱）
  // ============================================================
  console.log('\x1b[1m[T7] 支付/退款权限边界\x1b[0m');
  {
    const create = await call('POST', '/api/orders', { token: tokens.admin, body: {
      studentId: 'stu_003', items: [{ itemName: '越权探针品', unitPrice: 100, quantity: 1 }],
      discountAmount: 0, orderType: 'retail', status: 'pending',
    }});
    const oid = create.data && create.data.data && create.data.data.orderId;

    // 销售既不是管理员、也不是该订单的 owner → 支付必须被拒
    const salesPay = await call('POST', `/api/orders/${oid}/pay`, { token: tokens.sales, body: { payMethod: 'cash' } });
    rec('T7 非订单所有者支付被拒',
      salesPay.status === 403 || (salesPay.data && salesPay.data.code !== 0),
      `status=${salesPay.status} body=${JSON.stringify(salesPay.data)}`);
    const ord = db.prepare('SELECT status FROM orders WHERE id = ?').get(oid);
    rec('T7 被拒后订单仍为 pending（无副作用）', ord.status === 'pending', `status=${ord.status}`);

    const salesRefund = await call('POST', `/api/orders/${oid}/refund`, { token: tokens.sales, body: { reason: '越权' } });
    rec('T7 非管理员退款被拒（仅管理员可操作退款）',
      salesRefund.status === 403 && salesRefund.data && salesRefund.data.message === '仅管理员可操作退款',
      `status=${salesRefund.status} body=${JSON.stringify(salesRefund.data)}`);

    // 销售不得点名签到（isCoachReq 只放行管理员与教练）
    const salesCk = await call('POST', '/api/checkin/teacher', { token: tokens.sales, body: {
      scheduleId: 'ANY', attendances: [{ studentId: 'stu_001', status: 'present' }],
    }});
    rec('T7 销售点名签到被拒（仅管理员或教练可确认签到）',
      salesCk.status === 403 && salesCk.data && salesCk.data.message === '仅管理员或教练可确认签到',
      `status=${salesCk.status} body=${JSON.stringify(salesCk.data)}`);
  }

  // ============================================================
  // T8 签到状态机与参数边界
  // ============================================================
  console.log('\x1b[1m[T8] 签到状态机与参数边界\x1b[0m');
  {
    // 8a 参数边界：缺参 / 不存在的排期都必须回业务失败码，而不是 500
    const noSched = await call('POST', '/api/checkin/teacher', { token: tokens.admin, body: {
      attendances: [{ studentId: 'stu_001', status: 'present' }],
    }});
    rec('T8 缺少 scheduleId → 业务失败码',
      noSched.status === 200 && noSched.data && noSched.data.code !== 0,
      `status=${noSched.status} body=${JSON.stringify(noSched.data)}`);

    const noAtt = await call('POST', '/api/checkin/teacher', { token: tokens.admin, body: { scheduleId: 'X' } });
    rec('T8 缺少 attendances → 业务失败码',
      noAtt.status === 200 && noAtt.data && noAtt.data.code !== 0,
      `status=${noAtt.status} body=${JSON.stringify(noAtt.data)}`);

    const ghost = await call('POST', '/api/checkin/teacher', { token: tokens.admin, body: {
      scheduleId: 'NO_SUCH_SCHEDULE', attendances: [{ studentId: 'stu_001', status: 'present' }],
    }});
    rec('T8 不存在的排期 → 业务失败码（非 500）',
      ghost.status === 200 && ghost.data && ghost.data.code !== 0,
      `status=${ghost.status} body=${JSON.stringify(ghost.data)}`);

    // 8b 清除点名必须回滚扣课并删除流水 —— 状态机闭环。
    // T3 结束时已把 mc_006 复原为 remaining=7 / used=3 并删掉自己的流水行，故此处读到的就是夹具原值。
    const cardId = 'mc_006', stuId = 'stu_006';
    const before = db.prepare('SELECT remaining_classes, used_classes FROM member_cards WHERE id = ?').get(cardId);
    // mc_006 是 1v1 私教次卡（card_type ct_004，course_scope='一对一'）。课程范围隔离已收紧为
    // 「范围不匹配一律拒绝扣课（含临时活动）」，故排期活动名须落在卡范围内（course_scope 需包含活动名）。
    const created = await call('POST', '/api/schedules', { token: tokens.admin, body: {
      courseName: '一对一', date: '2099-06-16', startTime: '22:00', endTime: '22:59',
      teacherId: 'teacher_001', maxStudents: 5,
    }});
    const schId = created.data && created.data.data && created.data.data.id;
    rec('T8 排课创建成功', !!schId, `status=${created.status} body=${JSON.stringify(created.data)}`);
    if (schId) {
      await call('POST', `/api/schedules/${schId}/enroll`, { token: tokens.admin, body: { studentId: stuId } });
      const ck = await call('POST', '/api/checkin/teacher', { token: tokens.admin, body: {
        scheduleId: schId, attendances: [{ studentId: stuId, status: 'present' }],
      }});
      const afterCk = db.prepare('SELECT remaining_classes, used_classes FROM member_cards WHERE id = ?').get(cardId);
      rec('T8 签到扣课恰好 1 次（remaining -1 / used +1）',
        ck.data && ck.data.code === 0 && afterCk.remaining_classes === before.remaining_classes - 1
          && afterCk.used_classes === before.used_classes + 1,
        `before=${JSON.stringify(before)} after=${JSON.stringify(afterCk)}`);

      const clr = await call('POST', '/api/checkin/teacher', { token: tokens.admin, body: {
        scheduleId: schId, attendances: [{ studentId: stuId, status: 'clear' }],
      }});
      const afterClr = db.prepare('SELECT remaining_classes, used_classes FROM member_cards WHERE id = ?').get(cardId);
      const dedRows = db.prepare('SELECT COUNT(*) c FROM deduction_logs WHERE schedule_id = ? AND student_id = ?').get(schId, stuId).c;
      const attRows = db.prepare('SELECT COUNT(*) c FROM attendances WHERE schedule_id = ?').get(schId).c;
      rec('T8 清除点名回滚扣课（remaining/used 复原）',
        clr.data && clr.data.code === 0 && afterClr.remaining_classes === before.remaining_classes
          && afterClr.used_classes === before.used_classes,
        `after=${JSON.stringify(afterClr)}`);
      rec('T8 清除点名删除扣课流水与考勤行',
        dedRows === 0 && attRows === 0, `ded=${dedRows} att=${attRows}`);
      await call('DELETE', `/api/schedules/${schId}`, { token: tokens.admin });
    }

    // 8c T4 覆盖的是 teacher_id = teachers.id 分支；这里补 openid 直接相等那一支。
    // 两条分支的实现完全不同（一条要按手机号反查教师档案），只测其一等于漏一半。
    if (hasBothCoaches) {
      const created2 = await call('POST', '/api/schedules', { token: tokens.admin, body: {
        courseName: '批次9跨教练openid', date: '2099-06-17', startTime: '21:00', endTime: '21:59',
        teacherId: COACH_A, maxStudents: 5,
      }});
      const schId2 = created2.data && created2.data.data && created2.data.data.id;
      rec('T8 排课创建成功（teacher_id = 教练 A 的 openid）', !!schId2,
        `status=${created2.status} body=${JSON.stringify(created2.data)}`);
      if (schId2) {
        await call('POST', `/api/schedules/${schId2}/enroll`, { token: tokens.admin, body: { studentId: 'stu_001' } });
        const byB = await call('POST', '/api/checkin/teacher', { token: tokens.coachB, body: {
          scheduleId: schId2, attendances: [{ studentId: 'stu_001', status: 'present' }],
        }});
        rec('T8 openid 分支下教练 B 越权同样 403',
          byB.status === 403 && byB.data && byB.data.message === '无权操作非本人授课的排期',
          `status=${byB.status} body=${JSON.stringify(byB.data)}`);
        const leaked = db.prepare('SELECT COUNT(*) c FROM attendances WHERE schedule_id = ?').get(schId2).c;
        rec('T8 openid 分支下越权零写入', leaked === 0, `attendances=${leaked}`);
        const byA = await call('POST', '/api/checkin/teacher', { token: tokens.coachA, body: {
          scheduleId: schId2, attendances: [{ studentId: 'stu_001', status: 'present' }],
        }});
        rec('T8 openid 分支下教练 A 签到成功（对照）',
          byA.status === 200 && byA.data && byA.data.code === 0,
          `status=${byA.status} body=${JSON.stringify(byA.data)}`);
        await call('DELETE', `/api/schedules/${schId2}`, { token: tokens.admin });
      }
    }
  }

  db.close();
  console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常', e); process.exit(2); });
