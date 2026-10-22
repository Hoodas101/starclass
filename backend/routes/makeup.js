/**
 * 补课/调课路由
 *
 * 补课流程：
 *   1. 学员因缺席/请假产生待补课时
 *   2. 管理员/教练为学员安排补课（指定目标排期）
 *   3. 学员在补课排期中签到 → 标记补课完成，不扣会员卡课时
 *
 * 调课流程：
 *   1. 管理员将学员从原排期调到新排期（课前操作）
 *   2. 原排期取消登记，新排期新增登记
 *   3. 若原排期已扣课时，新排期签到不重复扣课
 *
 * POST /api/makeup/assign     — 安排补课
 * POST /api/makeup/cancel     — 取消补课
 * GET  /api/makeup/eligible   — 可补课缺席列表
 * GET  /api/makeup/records    — 补课记录
 * POST /api/makeup/reschedule — 调课（将学员从原排期调到新排期）
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, now, isCoachReq } = require('../utils');

// makeup_records 建表与索引已收编至 migrations/014

/**
 * GET /api/makeup/eligible — 可补课缺席列表
 * 查询有 absent/leave 记录且尚未安排补课的学员
 * Query: { studentId?, dateFrom?, dateTo? }
 */
router.get('/eligible', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可查看'));
    const { studentId, dateFrom, dateTo } = req.query;

    let where = "WHERE a.status IN ('absent', 'leave')";
    const params = [];
    if (studentId) { where += ' AND a.student_id = ?'; params.push(studentId); }
    if (dateFrom) { where += ' AND a.date >= ?'; params.push(dateFrom); }
    if (dateTo) { where += ' AND a.date <= ?'; params.push(dateTo); }

    const list = db.prepare(`
      SELECT a.id as attendance_id, a.student_id, a.student_name, a.schedule_id,
             a.date, a.status, a.course_name,
             s.start_time, s.end_time,
             CASE WHEN mk.mk_id IS NOT NULL THEN 1 ELSE 0 END as hasMakeup,
             mk.makeupStatus as makeupStatus
      FROM attendances a
      LEFT JOIN schedules s ON s.id = a.schedule_id
      LEFT JOIN (
        SELECT original_schedule_id, student_id, MAX(id) AS mk_id, MAX(status) AS makeupStatus
        FROM makeup_records
        WHERE status != 'cancelled'
        GROUP BY original_schedule_id, student_id
      ) mk ON mk.original_schedule_id = a.schedule_id AND mk.student_id = a.student_id
      ${where}
      ORDER BY a.date DESC
      LIMIT 200
    `).all(...params);

    // 组装返回字段（与前端一致：attendance_id/student_id/student_name/schedule_id/date/status/course_name/start_time/end_time/hasMakeup/makeupStatus）
    const withMakeupFlag = list.map(row => ({
      ...row,
      hasMakeup: !!row.hasMakeup,
      makeupStatus: row.makeupStatus || null,
    }));

    // 列表带 LIMIT 200：若拿 list.length 当总数，缺席记录攒过 200 条后「共 N 条」
    // 会静默算少，与列表内容对不上。单独 COUNT 一次并回传截断标记。
    // COUNT 与主查询共用同一套 JOIN 与 where（mk 子查询已按「排期+学员」聚合为一行，
    // 不会让 COUNT 膨胀）。
    const total = db.prepare(`
      SELECT COUNT(*) AS c
      FROM attendances a
      LEFT JOIN schedules s ON s.id = a.schedule_id
      LEFT JOIN (
        SELECT original_schedule_id, student_id, MAX(id) AS mk_id
        FROM makeup_records
        WHERE status != 'cancelled'
        GROUP BY original_schedule_id, student_id
      ) mk ON mk.original_schedule_id = a.schedule_id AND mk.student_id = a.student_id
      ${where}
    `).get(...params).c;

    res.json(success({ list: withMakeupFlag, total, truncated: withMakeupFlag.length < total }));
  } catch (err) {
    console.error('[makeup eligible]', err);
    res.status(500).json(safeFail('查询失败'));
  }
});

/**
 * 安排一次补课（单学员）。权限与参数形状由调用方校验，本函数只负责业务判据与落库。
 * @returns {{ok:true, id:string}|{err:string}}
 */
function assignOne({ studentId, originalScheduleId, makeupScheduleId, note, openid }) {
  // 验证补课排期存在
  const makeupSchedule = db.prepare('SELECT * FROM schedules WHERE id = ? AND status = ?').get(makeupScheduleId, 'scheduled');
  if (!makeupSchedule) return { err: '补课排期不存在或已取消' };

  // 验证学员存在
  const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
  if (!student) return { err: '学员不存在' };

  // 原排期与缺席记录校验（判据与 GET /eligible 严格同源）：
  // 补课权益只能对应「一次真实的缺席 / 请假」。此前 assign 完全不校验，
  // 可为从未缺席的学员安排免费补课（凭空产生一次免扣课时的补课权益）。
  // 缺省 originalScheduleId 时同样拒绝：否则只要不传该字段即可绕过本校验。
  if (!originalScheduleId) {
    return { err: '缺少原排期：补课须对应一次缺席或请假记录' };
  }
  const absentRecord = db.prepare(
    "SELECT 1 FROM attendances WHERE schedule_id = ? AND student_id = ? AND status IN ('absent', 'leave') LIMIT 1"
  ).get(originalScheduleId, studentId);
  if (!absentRecord) {
    return { err: '该学员在原排期没有缺席或请假记录，无法安排补课' };
  }

  const originalSchedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(originalScheduleId);
  const originalDate = originalSchedule ? originalSchedule.date : null;
  const originalCourseName = originalSchedule ? originalSchedule.course_name : '';

  const id = generateId('mk_');
  const t = now();
  // 幂等 / 容量 / 落库同事务：避免并发重复安排，或在满员补课排期上超员登记
  return db.transaction(() => {
    const existing = db.prepare(
      "SELECT id FROM makeup_records WHERE original_schedule_id = ? AND student_id = ? AND status != 'cancelled'"
    ).get(originalScheduleId, studentId);
    if (existing) return { err: '该缺席已安排补课，请勿重复安排' };

    const cur = db.prepare('SELECT enrolled_count, max_students FROM schedules WHERE id = ?').get(makeupScheduleId);
    if (cur && cur.max_students > 0 && (cur.enrolled_count || 0) >= cur.max_students) {
      return { err: '该补课排期报名人数已满' };
    }

    db.prepare(`
      INSERT INTO makeup_records
        (id, student_id, student_name, original_schedule_id, original_date, original_course_name,
         makeup_schedule_id, makeup_date, makeup_course_name, type, status, created_by, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'makeup', 'pending', ?, ?, ?, ?)
    `).run(
      id, studentId, student.name,
      originalScheduleId, originalDate, originalCourseName,
      makeupScheduleId, makeupSchedule.date, makeupSchedule.course_name,
      openid || '', note, t, t
    );

    // 在补课排期中创建补课登记（type=makeup，不占名额）
    const enrollId = generateId('enr_');
    db.prepare(`
      INSERT INTO enrollments (id, student_id, student_name, course_id, course_name, schedule_id,
        enroll_type, status, enrolled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'makeup', 'active', ?, ?, ?)
    `).run(
      enrollId, studentId, student.name,
      makeupSchedule.course_id, makeupSchedule.course_name, makeupScheduleId,
      t, t, t
    );

    // 补课排期 enrolled_count + 1
    db.prepare('UPDATE schedules SET enrolled_count = enrolled_count + 1, updated_at = ? WHERE id = ?')
      .run(t, makeupScheduleId);

    return { ok: true, id };
  })();
}

/**
 * POST /api/makeup/assign — 安排补课
 * Body: { studentId, originalScheduleId, makeupScheduleId, note? }
 */
router.post('/assign', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可安排补课'));
    const { studentId, originalScheduleId, makeupScheduleId, note = '' } = req.body;
    if (!studentId || !makeupScheduleId) return res.json(fail('缺少学员或补课排期'));

    const r = assignOne({ studentId, originalScheduleId, makeupScheduleId, note, openid: req.openid || '' });
    if (r.err) return res.json(fail(r.err));
    res.json(success({ id: r.id, status: 'pending' }));
  } catch (err) {
    console.error('[makeup assign]', err);
    res.status(500).json(safeFail('安排补课失败'));
  }
});

/**
 * POST /api/makeup/batch-assign — 批量安排补课（一次课多名学员缺席）
 * Body: { originalScheduleId, makeupScheduleId, studentIds: string[], note? }
 *
 * 逐人复用 assignOne 的判据（缺席记录 / 重复安排 / 容量），**单人失败不影响其他人**，
 * 返回逐人结果供前端展示「成功 N / 失败 M」。
 * 此前只有前端封装、后端从未实现，导致「请假 → 批量补课」这条路整段不可用。
 */
router.post('/batch-assign', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可安排补课'));
    const { originalScheduleId, makeupScheduleId, studentIds, note = '' } = req.body || {};
    if (!makeupScheduleId) return res.json(fail('缺少补课排期'));
    if (!Array.isArray(studentIds) || !studentIds.length) return res.json(fail('请选择要安排补课的学员'));
    if (studentIds.length > 200) return res.json(fail('单次最多安排 200 名学员'));

    const results = studentIds.map((studentId) => {
      try {
        const r = assignOne({ studentId, originalScheduleId, makeupScheduleId, note, openid: req.openid || '' });
        return r.err ? { studentId, ok: false, reason: r.err } : { studentId, ok: true, id: r.id };
      } catch (e) {
        console.error('[makeup batch-assign]', studentId, e && e.message);
        return { studentId, ok: false, reason: '安排失败' };
      }
    });
    const okCount = results.filter((r) => r.ok).length;
    res.json(success({ total: results.length, ok: okCount, failed: results.length - okCount, results }));
  } catch (err) {
    console.error('[makeup batch-assign]', err);
    res.status(500).json(safeFail('批量安排补课失败'));
  }
});

/**
 * POST /api/makeup/cancel — 取消补课
 * Body: { id }
 */
router.post('/cancel', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可取消补课'));
    const { id } = req.body;
    if (!id) return res.json(fail('缺少补课记录 ID'));

    const record = db.prepare('SELECT * FROM makeup_records WHERE id = ?').get(id);
    if (!record) return res.json(fail('补课记录不存在'));
    if (record.status === 'cancelled') return res.json(fail('该补课已取消'));
    if (record.status === 'completed') return res.json(fail('该补课已完成，无法取消'));

    const t = now();
    const txn = db.transaction(() => {
      // 更新补课记录状态
      db.prepare("UPDATE makeup_records SET status = 'cancelled', updated_at = ? WHERE id = ?").run(t, id);
      // 删除补课排期中的登记
      db.prepare("DELETE FROM enrollments WHERE schedule_id = ? AND student_id = ? AND enroll_type = 'makeup'")
        .run(record.makeup_schedule_id, record.student_id);
      // 排期 enrolled_count - 1
      db.prepare('UPDATE schedules SET enrolled_count = MAX(0, enrolled_count - 1), updated_at = ? WHERE id = ?')
        .run(t, record.makeup_schedule_id);
    });
    txn();

    res.json(success({ id, status: 'cancelled' }));
  } catch (err) {
    console.error('[makeup cancel]', err);
    res.status(500).json(safeFail('取消补课失败'));
  }
});

/**
 * GET /api/makeup/records — 补课记录列表
 * Query: { status?, studentId?, page?, pageSize? }
 */
router.get('/records', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可查看'));
    const { status, studentId } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND m.status = ?'; params.push(status); }
    if (studentId) { where += ' AND m.student_id = ?'; params.push(studentId); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM makeup_records m ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT m.*,
             s1.start_time as original_start_time, s1.end_time as original_end_time,
             s2.start_time as makeup_start_time, s2.end_time as makeup_end_time
      FROM makeup_records m
      LEFT JOIN schedules s1 ON s1.id = m.original_schedule_id
      LEFT JOIN schedules s2 ON s2.id = m.makeup_schedule_id
      ${where}
      ORDER BY m.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    console.error('[makeup records]', err);
    res.status(500).json(safeFail('查询失败'));
  }
});

/**
 * POST /api/makeup/reschedule — 调课（课前将学员从原排期调到新排期）
 * Body: { studentId, originalScheduleId, newScheduleId, note? }
 */
router.post('/reschedule', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可调课'));
    const { studentId, originalScheduleId, newScheduleId, note = '' } = req.body;
    if (!studentId || !originalScheduleId || !newScheduleId) {
      return res.json(fail('缺少必要参数'));
    }
    if (originalScheduleId === newScheduleId) {
      return res.json(fail('原排期与新排期相同'));
    }

    const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
    if (!student) return res.json(fail('学员不存在'));

    const origSchedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(originalScheduleId);
    if (!origSchedule) return res.json(fail('原排期不存在'));

    const newSchedule = db.prepare('SELECT * FROM schedules WHERE id = ? AND status = ?').get(newScheduleId, 'scheduled');
    if (!newSchedule) return res.json(fail('新排期不存在或已取消'));

    // 检查学员是否在原排期登记
    const origEnrollment = db.prepare(
      "SELECT * FROM enrollments WHERE schedule_id = ? AND student_id = ? AND status = 'active'"
    ).get(originalScheduleId, studentId);
    if (!origEnrollment) return res.json(fail('学员未在原排期登记'));

    // 检查新排期是否有空位
    if (newSchedule.max_students && newSchedule.enrolled_count >= newSchedule.max_students) {
      return res.json(fail('新排期名额已满'));
    }

    // 检查是否已签到
    const attendance = db.prepare(
      'SELECT 1 FROM attendances WHERE schedule_id = ? AND student_id = ?'
    ).get(originalScheduleId, studentId);
    if (attendance) return res.json(fail('原排期已有签到记录，无法调课'));

    const t = now();
    const txn = db.transaction(() => {
      // 原排期：取消登记
      db.prepare("UPDATE enrollments SET status = 'cancelled', updated_at = ? WHERE id = ?")
        .run(t, origEnrollment.id);
      db.prepare('UPDATE schedules SET enrolled_count = MAX(0, enrolled_count - 1), updated_at = ? WHERE id = ?')
        .run(t, originalScheduleId);

      // 新排期：新增登记
      const enrollId = generateId('enr_');
      db.prepare(`
        INSERT INTO enrollments (id, student_id, student_name, course_id, course_name, schedule_id,
          enroll_type, status, enrolled_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'reschedule', 'active', ?, ?, ?)
      `).run(
        enrollId, studentId, student.name,
        newSchedule.course_id, newSchedule.course_name, newScheduleId,
        t, t, t
      );
      db.prepare('UPDATE schedules SET enrolled_count = enrolled_count + 1, updated_at = ? WHERE id = ?')
        .run(t, newScheduleId);

      // 记录调课日志
      const mkId = generateId('mk_');
      db.prepare(`
        INSERT INTO makeup_records
          (id, student_id, student_name, original_schedule_id, original_date, original_course_name,
           makeup_schedule_id, makeup_date, makeup_course_name, type, status, created_by, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reschedule', 'completed', ?, ?, ?, ?)
      `).run(
        mkId, studentId, student.name,
        originalScheduleId, origSchedule.date, origSchedule.course_name,
        newScheduleId, newSchedule.date, newSchedule.course_name,
        req.openid || '', note || '调课', t, t
      );
    });
    txn();

    res.json(success({ studentId, originalScheduleId, newScheduleId }));
  } catch (err) {
    console.error('[makeup reschedule]', err);
    res.status(500).json(safeFail('调课失败'));
  }
});

module.exports = router;
