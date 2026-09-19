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
 * POST /api/makeup/assign — 安排补课
 * Body: { studentId, originalScheduleId, makeupScheduleId, note? }
 */
router.post('/assign', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可安排补课'));
    const { studentId, originalScheduleId, makeupScheduleId, note = '' } = req.body;
    if (!studentId || !makeupScheduleId) return res.json(fail('缺少学员或补课排期'));

    // 验证补课排期存在
    const makeupSchedule = db.prepare('SELECT * FROM schedules WHERE id = ? AND status = ?').get(makeupScheduleId, 'scheduled');
    if (!makeupSchedule) return res.json(fail('补课排期不存在或已取消'));

    // 验证学员存在
    const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
    if (!student) return res.json(fail('学员不存在'));

    // 验证原排期
    let originalSchedule = null;
    let originalDate = null;
    let originalCourseName = '';
    if (originalScheduleId) {
      originalSchedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(originalScheduleId);
      if (originalSchedule) {
        originalDate = originalSchedule.date;
        originalCourseName = originalSchedule.course_name;
      }
    }

    // 检查是否已安排补课（同一原排期+学员）并执行安排，在同一事务内原子完成：
    // 避免并发重复安排补课，或在满员补课排期上超员登记
    const id = generateId('mk_');
    const t = now();
    const assigned = db.transaction(() => {
      const existing = originalScheduleId
        ? db.prepare(
            "SELECT id FROM makeup_records WHERE original_schedule_id = ? AND student_id = ? AND status != 'cancelled'"
          ).get(originalScheduleId, studentId)
        : null;
      if (existing) return { err: '该缺席已安排补课，请勿重复安排' };

      // 补课排期同样受名额约束：makeup 登记也占用 enrolled_count，超员时应拒绝
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
        originalScheduleId || null, originalDate, originalCourseName,
        makeupScheduleId, makeupSchedule.date, makeupSchedule.course_name,
        req.openid || '', note, t, t
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

      return { ok: true };
    })();

    if (assigned.err) return res.json(fail(assigned.err));
    res.json(success({ id, status: 'pending' }));
  } catch (err) {
    console.error('[makeup assign]', err);
    res.status(500).json(safeFail('安排补课失败'));
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
