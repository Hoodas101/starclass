/**
 * 薪资/课时费路由
 *
 * GET  /api/payroll/coaches?month=YYYY-MM   — 管理员：全部教练当月结算汇总
 * GET  /api/payroll/coach/:id?month=YYYY-MM — 管理员/本人：某教练逐节薪资明细
 * PUT  /api/payroll/coach/:id/rule          — 管理员：保存教练薪资规则
 * GET  /api/payroll/me?month=YYYY-MM        — 教练本人：我的薪资规则与当月预估
 * POST /api/payroll/settle                  — 管理员：按月结算，事务写入 payroll_logs（财务净利润据此变真）
 * GET  /api/payroll/logs?month=YYYY-MM      — 管理员：查询结算记录
 * POST /api/payroll/logs/:id/void           — 管理员：作废一条结算（状态置 voided）
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, formatDate, recordAudit } = require('../utils');
const {
  DEFAULT_RULE,
  normalizeRule,
  calcLessonPay,
  ruleSummary,
  calcText,
} = require('../utils/payroll');

// teachers.pay_rule 列已收编至 migrations/011

function isAdmin(req) {
  if (req.userRole === 'admin') return true;
  const openid = getOpenId(req);
  if (!openid) return false;
  const u = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
  return !!(u && u.role === 'admin');
}

/**
 * 读取教练薪资规则；未配置时回退旧 class_fee 字段
 */
function getPayRule(teacher) {
  if (teacher.pay_rule) {
    try {
      return normalizeRule(JSON.parse(teacher.pay_rule));
    } catch (e) { /* 解析失败走回退 */ }
  }
  return normalizeRule({ ...DEFAULT_RULE, baseRate: Number(teacher.class_fee) || 0 });
}

/**
 * 计薪截止日：未来日期不产生应付，统一截断到今天。
 * /coaches、/coach/:id、/me、/settle 四个调用点共用本函数（lessonRows 内部也会
 * 再应用一次），保证同一教练同月不会算出两个不同的合计。
 */
function effectiveEnd(endDate) {
  const today = formatDate(now());
  return endDate > today ? today : endDate;
}

/**
 * 教练在日期范围内的逐节明细（含薪资计算）
 * endDate 在此统一截断（未来日期不计薪）；调用点传月末或已截断值结果一致。
 */
function lessonRows(teacherId, startDate, endDate) {
  const teacher = db.prepare("SELECT * FROM teachers WHERE id = ?").get(teacherId);
  if (!teacher) return null;
  const rule = getPayRule(teacher);
  const effEnd = effectiveEnd(endDate);
  // 计薪基数 = 实际授课：排了课但一条考勤记录都没有，说明该课并未实际发生
  // （停课/改期/临时取消但未改状态），不应计课时费。反之「有考勤记录但学员全部
  // 缺席」的课仍然计薪 —— 教师确实到场授课。故用 EXISTS 而非 attended > 0。
  const list = db.prepare(`
    SELECT s.id, s.date, s.course_name, s.start_time, s.end_time, s.status,
      s.enrolled_count, s.classroom_name,
      (SELECT COUNT(*) FROM attendances a
        WHERE a.schedule_id = s.id AND a.status IN ('present','late')) AS attended
    FROM schedules s
    WHERE s.teacher_id = ? AND s.status != 'cancelled' AND s.date >= ? AND s.date <= ?
      AND EXISTS (SELECT 1 FROM attendances a WHERE a.schedule_id = s.id)
    ORDER BY s.date ASC, s.start_time ASC
  `).all(teacherId, startDate, effEnd);

  const rows = list.map((r) => {
    const attended = r.attended || 0;
    return {
      id: r.id,
      date: r.date,
      courseName: r.course_name || '',
      startTime: r.start_time || '',
      endTime: r.end_time || '',
      status: r.status || 'scheduled',
      classroomName: r.classroom_name || '',
      enrolledCount: r.enrolled_count || 0,
      attended,
      calcText: calcText(rule, attended),
      lessonAmount: calcLessonPay(rule, attended),
    };
  });

  const totals = rows.reduce(
    (acc, r) => {
      acc.classes += 1;
      acc.students += r.attended;
      acc.amount += r.lessonAmount;
      return acc;
    },
    { classes: 0, students: 0, amount: 0 }
  );

  return {
    teacher: { id: teacher.id, name: teacher.name, phone: teacher.phone || '' },
    rule,
    summary: ruleSummary(rule),
    rows,
    totals,
  };
}

function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return null;
  const [y, m] = month.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  const start = `${month}-01`;
  const end = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  return { startDate: start, endDate: end };
}

/**
 * GET /api/payroll/coaches?month=YYYY-MM — 全部教练当月结算汇总
 */
router.get('/coaches', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json(safeFail('仅管理员可查看薪资结算'));
    const range = monthRange(req.query.month);
    if (!range) return res.json(fail('月份格式应为 YYYY-MM'));
    const { startDate, endDate } = range;
    // Same cutoff as /settle: exclude future-dated classes so the preview
    // matches what a mid-month settle would actually pay.
    const effEnd = effectiveEnd(endDate);
    const teachers = db.prepare("SELECT * FROM teachers ORDER BY status, name").all();
    const list = teachers.map((t) => {
      const rule = getPayRule(t);
      const rows = lessonRows(t.id, startDate, effEnd);
      return {
        teacherId: t.id,
        name: t.name,
        phone: t.phone || '',
        status: t.status || 'active',
        payRule: rule,
        ruleSummary: ruleSummary(rule),
        classes: rows ? rows.totals.classes : 0,
        students: rows ? rows.totals.students : 0,
        amount: rows ? rows.totals.amount : 0,
      };
    });
    res.json(success({ list, month: req.query.month, startDate, endDate: effEnd }));
  } catch (err) {
    console.error('[payroll coaches]', err);
    res.status(500).json(safeFail('获取薪资结算失败'));
  }
});

/**
 * GET /api/payroll/coach/:id?month=YYYY-MM — 某教练逐节薪资明细
 */
router.get('/coach/:id', (req, res) => {
  try {
    const range = monthRange(req.query.month);
    if (!range) return res.json(fail('月份格式应为 YYYY-MM'));
    const teacher = db.prepare("SELECT * FROM teachers WHERE id = ?").get(req.params.id);
    if (!teacher) return res.json(fail('教练不存在'));

    // 权限：管理员 或 教练本人
    if (!isAdmin(req)) {
      const openid = getOpenId(req);
      const u = openid ? db.prepare('SELECT phone, role FROM users WHERE openid = ?').get(openid) : null;
      const mine = u && u.role === 'coach' && u.phone && u.phone === teacher.phone;
      if (!mine) return res.status(403).json(safeFail('无权查看该教练薪资明细'));
    }

    // 与 /coaches 同口径：回显实际计酬截止日，避免明细区间宽于实际数据
    const effEnd = effectiveEnd(range.endDate);
    const data = lessonRows(req.params.id, range.startDate, effEnd);
    if (!data) return res.json(fail('教练不存在'));
    res.json(success({ ...data, month: req.query.month, startDate: range.startDate, endDate: effEnd }));
  } catch (err) {
    console.error('[payroll coach detail]', err);
    res.status(500).json(safeFail('获取薪资明细失败'));
  }
});

/**
 * PUT /api/payroll/coach/:id/rule — 保存教练薪资规则
 * Body: { payRule }
 */
router.put('/coach/:id/rule', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json(safeFail('仅管理员可设置薪资规则'));
    const teacher = db.prepare("SELECT id, name, pay_rule, class_fee FROM teachers WHERE id = ?").get(req.params.id);
    if (!teacher) return res.json(fail('教练不存在'));
    const beforeRule = getPayRule(teacher);
    const rule = normalizeRule(req.body.payRule);
    db.prepare("UPDATE teachers SET pay_rule = ? WHERE id = ?")
      .run(JSON.stringify(rule), req.params.id);
    // 薪资规则决定该教练后续所有计薪金额，改写规则必须留痕（完整新旧规则可追责）
    recordAudit(db, {
      entity: 'teacher',
      entityId: req.params.id,
      action: 'pay_rule_update',
      actorId: getOpenId(req),
      actorRole: req.userRole || '',
      before: { payRule: beforeRule },
      after: { payRule: rule },
    });
    res.json(success({ payRule: rule, summary: ruleSummary(rule) }));
  } catch (err) {
    console.error('[payroll rule save]', err);
    res.status(500).json(safeFail('保存薪资规则失败'));
  }
});

/**
 * POST /api/payroll/settle — 管理员：按月结算全部教练课时费，事务写入 payroll_logs
 * Body: { month }  month 格式 YYYY-MM
 * 结算后财务报表净利润自动扣减课酬支出（finance.js 读取 payroll_logs status='settled'）。
 * 幂等：同一月份已有 settled 记录时拒绝重复结算，需先逐条作废。
 */
router.post('/settle', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json(safeFail('仅管理员可执行薪资结算'));
    const month = String(req.body.month || '');
    const range = monthRange(month);
    if (!range) return res.json(fail('月份格式应为 YYYY-MM'));
    const { startDate, endDate } = range;
    // Only lessons up to today are payable; future scheduled classes are excluded
    // so a mid-month settle doesn't prepay classes that haven't happened.
    const effEnd = effectiveEnd(endDate);

    const teachers = db.prepare("SELECT * FROM teachers").all();
    const result = db.transaction(() => {
      const existing = db.prepare(
        "SELECT COUNT(*) c FROM payroll_logs WHERE month = ? AND status = 'settled'"
      ).get(month).c;
      if (existing > 0) return { err: '该月已结算，如需重算请先作废原结算记录' };

      const ins = db.prepare(`
        INSERT INTO payroll_logs (id, teacher_id, teacher_name, month, lesson_count, amount, rule_snapshot, status, paid_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?)
      `);
      let settled = 0;
      let totalAmount = 0;
      const t = now();
      for (const teacher of teachers) {
        const data = lessonRows(teacher.id, startDate, effEnd);
        if (!data || !data.rows.length) continue;
        const amount = Math.round(data.totals.amount * 100) / 100;
        if (amount <= 0) continue;
        ins.run(
          generateId('paylog_'), teacher.id, teacher.name, month,
          data.totals.classes, amount, JSON.stringify(data.rule), t, t
        );
        settled += 1;
        totalAmount += amount;
      }
      // Settle affects net profit — record who/when/scope in the audit log
      recordAudit(db, {
        entity: 'payroll',
        entityId: month,
        action: 'settle',
        actorId: getOpenId(req),
        actorRole: req.userRole || '',
        before: null,
        after: { month, settled, totalAmount: Math.round(totalAmount * 100) / 100, endDateUsed: effEnd },
      });
      return { ok: true, settled, totalAmount: Math.round(totalAmount * 100) / 100, month, clamped: effEnd < endDate };
    })();

    if (result.err) return res.json(fail(result.err));
    res.json(success(result));
  } catch (err) {
    console.error('[payroll settle]', err);
    res.status(500).json(safeFail('薪资结算失败'));
  }
});

/**
 * GET /api/payroll/logs?month=YYYY-MM — 管理员：查询结算记录（month 可选）
 */
router.get('/logs', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json(safeFail('仅管理员可查看薪资结算记录'));
    const month = req.query.month;
    let list;
    if (month) {
      const range = monthRange(String(month));
      if (!range) return res.json(fail('月份格式应为 YYYY-MM'));
      list = db.prepare('SELECT * FROM payroll_logs WHERE month = ? ORDER BY status, teacher_name').all(String(month));
    } else {
      list = db.prepare('SELECT * FROM payroll_logs ORDER BY month DESC, status, teacher_name LIMIT 200').all();
    }
    res.json(success({ list }));
  } catch (err) {
    console.error('[payroll logs]', err);
    res.status(500).json(safeFail('获取结算记录失败'));
  }
});

/**
 * POST /api/payroll/logs/:id/void — 管理员：作废一条结算记录（不物理删除，保留审计痕迹）
 */
router.post('/logs/:id/void', (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json(safeFail('仅管理员可作废结算记录'));
    const row = db.prepare('SELECT * FROM payroll_logs WHERE id = ?').get(req.params.id);
    if (!row) return res.json(fail('结算记录不存在'));
    if (row.status !== 'settled') return res.json(fail('仅已结算记录可作废'));
    db.prepare("UPDATE payroll_logs SET status = 'voided', paid_at = NULL WHERE id = ?").run(req.params.id);
    // Voiding reverses a money write — audit it too
    recordAudit(db, {
      entity: 'payroll',
      entityId: req.params.id,
      action: 'void_settle',
      actorId: getOpenId(req),
      actorRole: req.userRole || '',
      before: { status: row.status, month: row.month, amount: row.amount, teacher_name: row.teacher_name },
      after: { status: 'voided' },
    });
    res.json(success({ voided: true, id: req.params.id }));
  } catch (err) {
    console.error('[payroll void]', err);
    res.status(500).json(safeFail('作废结算记录失败'));
  }
});

/**
 * GET /api/payroll/me?month=YYYY-MM — 教练本人薪资规则与当月预估
 */
router.get('/me', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const u = db.prepare('SELECT phone, role FROM users WHERE openid = ?').get(openid);
    if (!u || u.role !== 'coach') return res.status(403).json(safeFail('仅教练可查看本人薪资'));
    if (!u.phone) return res.json(fail('账号未绑定手机号'));
    const teacher = db.prepare("SELECT * FROM teachers WHERE phone = ?").get(u.phone);
    if (!teacher) return res.json(fail('尚未配置教练档案'));
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
      ? req.query.month
      : new Date().toISOString().slice(0, 7);
    const range = monthRange(month);
    const data = lessonRows(teacher.id, range.startDate, range.endDate);
    res.json(success({ ...data, month }));
  } catch (err) {
    console.error('[payroll me]', err);
    res.status(500).json(safeFail('获取薪资信息失败'));
  }
});

module.exports = router;
