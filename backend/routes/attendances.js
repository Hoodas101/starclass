/**
 * 上课记录 / 课时统计路由
 * GET /api/attendances              — 全部上课记录（管理端；按 成员/课程班级/教练/日期/状态 筛选 + 分页）
 * GET /api/attendances/student/:id  — 单个成员上课记录明细（家长仅可看自己绑定成员；管理端可见全部）
 * GET /api/attendances/summary      — 课时汇总统计（出勤次数 / 课时 / 出勤率 / 按日趋势）
 *
 * 授权策略：
 *  - 带 studentId 的查询（/student/:id、/summary?studentId=）：管理员 / 教练 / 绑定该成员的家长（canViewStudentData）
 *  - 不带 studentId 的全员汇总（/summary、/）：仅管理员 / 教练 / 销售等管理端工作人员（isStaffReq）
 *
 * 数据来源：attendances 表（每节课每个成员一条），关联 schedules 取开始/结束时间、教练姓名用于课时计算。
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { success, fail, safeFail, parsePagination, isStaffReq, canViewStudentData, attendanceRate } = require('../utils');

/**
 * 计算两个 HH:mm 时间字符串之间的分钟差（结束 > 开始才有效）
 */
function durationMinutes(start, end) {
  if (!start || !end) return 0;
  const parse = (t) => {
    const parts = String(t).split(':');
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    return h * 60 + m;
  };
  const mins = parse(end) - parse(start);
  return mins > 0 ? mins : 0;
}

/**
 * 组装 WHERE + 参数（attendances 别名为 a，schedules 别名为 s）
 * 支持：studentId / 课程班级 classId(course_id) / 教练 teacherId / 日期区间 / 状态
 */
function buildWhere(query) {
  const { studentId, classId, courseId, teacherId, startDate, endDate, status } = query;
  let where = 'WHERE 1=1';
  const params = [];
  if (studentId) { where += ' AND a.student_id = ?'; params.push(studentId); }
  // 课程班级即 courses 表，attendances.course_id 直接对应；classId 与 courseId 等价
  if (classId || courseId) { where += ' AND a.course_id = ?'; params.push(classId || courseId); }
  if (teacherId) { where += ' AND s.teacher_id = ?'; params.push(teacherId); }
  if (startDate) { where += ' AND a.date >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND a.date <= ?'; params.push(endDate); }
  if (status) { where += ' AND a.status = ?'; params.push(status); }
  return { where, params };
}

/**
 * 将一行 attendance + 关联 schedule 映射为前端统一记录结构
 */
function mapRecord(a, s) {
  return {
    id: a.id,
    scheduleId: a.schedule_id,
    studentId: a.student_id,
    studentName: a.student_name || '',
    courseId: a.course_id || '',
    courseName: a.course_name || (s ? s.course_name || '' : ''),
    date: a.date || '',
    startTime: s ? (s.start_time || '') : '',
    endTime: s ? (s.end_time || '') : '',
    durationMin: s ? durationMinutes(s.start_time, s.end_time) : 0,
    status: a.status,
    checkinMethod: a.checkin_method || '',
    checkinTime: a.checkin_time || 0,
    checkinBy: a.checkin_by || '',
    coach: s ? (s.teacher_name || '') : '',
    classroom: s ? (s.classroom_name || '') : '',
    pointsEarned: a.points_earned || 0,
  };
}

/**
 * 排课时长（分钟）的 SQL 表达式（schedules 别名为 s）。
 * 与 durationMinutes() 保持同一口径：起止时间任一为空则记 0，结束不晚于开始也记 0。
 * 时间格式为 HH:mm，直接按位截取时分，避免为了算课时把明细行读进内存。
 */
const DURATION_MIN_SQL = `CASE
    WHEN s.start_time IS NULL OR s.start_time = '' OR s.end_time IS NULL OR s.end_time = '' THEN 0
    ELSE MAX(0,
      (CAST(substr(s.end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(s.end_time, 4, 2) AS INTEGER))
      - (CAST(substr(s.start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(s.start_time, 4, 2) AS INTEGER))
    )
  END`;

/**
 * 课时汇总统计（全量口径）
 * 在 SQL 里按与列表完全相同的 WHERE 条件聚合 COUNT / SUM，只回传一行统计结果。
 * 此前是对分页后的 rows 做汇总，导致卡片只统计当前页（默认 20 行）而非全部。
 * @param {string} where 由 buildWhere 生成的 WHERE 片段（含别名 a / s）
 * @param {Array} params 与 where 对应的绑定参数
 */
function computeSummary(where, params) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS presentCount,
      SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS lateCount,
      SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absentCount,
      SUM(CASE WHEN a.status = 'leave' THEN 1 ELSE 0 END) AS leaveCount,
      SUM(CASE WHEN a.status IN ('present', 'late') THEN ${DURATION_MIN_SQL} ELSE 0 END) AS attendedMinutes,
      SUM(${DURATION_MIN_SQL}) AS totalMinutes
    FROM attendances a
    LEFT JOIN schedules s ON s.id = a.schedule_id
    ${where}
  `).get(...params) || {};

  const presentCount = row.presentCount || 0;
  const lateCount = row.lateCount || 0;
  const absentCount = row.absentCount || 0;
  const leaveCount = row.leaveCount || 0;
  const attendedMinutes = row.attendedMinutes || 0; // 实际出勤课时（仅 present/late 计入）
  const totalMinutes = row.totalMinutes || 0;       // 出勤记录对应的排课时长合计（含缺勤，用于“应上课时”口径）

  // 应到次数 = 实到 + 缺勤；已批准的请假不算「应到未到」，故不进分母。
  // 必须与 attendanceRate 的分子/分母一致，否则页面上「出勤次数 ÷ 总次数」与「出勤率」两张卡互相矛盾。
  const totalSessions = presentCount + lateCount + absentCount;
  const attendedSessions = presentCount + lateCount;
  return {
    totalSessions,
    attendedSessions,
    presentCount,
    lateCount,
    absentCount,
    leaveCount,
    attendedHours: Math.round((attendedMinutes / 60) * 10) / 10,
    totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    attendanceRate: attendanceRate({ present: presentCount, late: lateCount, absent: absentCount }),
  };
}

/**
 * 按日趋势（升序），供前端折线/柱状图使用。
 * 同样在 SQL 里 GROUP BY 聚合，不依赖明细行 —— 否则全量口径下要把整表读进内存。
 * @param {string} where 由 buildWhere 生成的 WHERE 片段（含别名 a / s）
 * @param {Array} params 与 where 对应的绑定参数
 */
function computeTrend(where, params) {
  return db.prepare(`
    SELECT a.date AS date,
      COUNT(*) AS total,
      SUM(CASE WHEN a.status IN ('present', 'late') THEN 1 ELSE 0 END) AS attended
    FROM attendances a
    LEFT JOIN schedules s ON s.id = a.schedule_id
    ${where}
      AND a.date IS NOT NULL AND a.date != ''
    GROUP BY a.date
    ORDER BY a.date ASC
  `).all(...params);
}

/**
 * GET /api/attendances — 全部上课记录（管理端）
 * Query: studentId, classId, teacherId, startDate, endDate, status, page, pageSize
 */
router.get('/', (req, res) => {
  try {
    // 全员上课记录仅管理端工作人员可见（管理者/教练/销售）
    if (!isStaffReq(req)) return res.status(403).json(safeFail('仅管理端工作人员可查看全部上课记录'));
    const { studentId, classId, courseId, teacherId, startDate, endDate, status } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);

    const { where, params } = buildWhere(req.query);

    const total = db.prepare(`
      SELECT COUNT(*) AS count FROM attendances a
      LEFT JOIN schedules s ON s.id = a.schedule_id
      ${where}
    `).get(...params).count;

    const raw = db.prepare(`
      SELECT a.*, s.start_time, s.end_time, s.teacher_name, s.classroom_name, s.course_name AS sched_course
      FROM attendances a
      LEFT JOIN schedules s ON s.id = a.schedule_id
      ${where}
      ORDER BY a.date DESC, COALESCE(s.start_time, '99:99') DESC, a.checkin_time DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    const rows = raw.map((a) => mapRecord(a, a));
    res.json(success({
      list: rows,
      total,
      page,
      pageSize,
      // 全量口径：与列表同一 WHERE 条件在 SQL 里聚合，不再统计当前页
      summary: computeSummary(where, params),
    }));
  } catch (err) {
    console.error('[attendances list]', err);
    res.status(500).json(safeFail('获取上课记录失败'));
  }
});

/**
 * GET /api/attendances/student/:id — 单个成员上课记录明细
 * Query: startDate, endDate, status, courseId, page, pageSize
 */
router.get('/student/:id', (req, res) => {
  try {
    const { id } = req.params;
    // 家长仅可查看自己绑定成员；管理端工作人员可见全部
    if (!canViewStudentData(req, id)) return res.status(403).json(safeFail('无权查看该成员的上课记录'));
    const { startDate, endDate, status, courseId } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);

    const student = db.prepare('SELECT id, name FROM students WHERE id = ?').get(id);
    if (!student) return res.status(404).json(safeFail('成员不存在'));

    let where = 'WHERE a.student_id = ?';
    const params = [id];
    if (courseId) { where += ' AND a.course_id = ?'; params.push(courseId); }
    if (startDate) { where += ' AND a.date >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND a.date <= ?'; params.push(endDate); }
    if (status) { where += ' AND a.status = ?'; params.push(status); }

    const total = db.prepare(`
      SELECT COUNT(*) AS count FROM attendances a ${where}
    `).get(...params).count;

    const raw = db.prepare(`
      SELECT a.*, s.start_time, s.end_time, s.teacher_name, s.classroom_name
      FROM attendances a
      LEFT JOIN schedules s ON s.id = a.schedule_id
      ${where}
      ORDER BY a.date DESC, COALESCE(s.start_time, '99:99') DESC, a.checkin_time DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    const rows = raw.map((a) => mapRecord(a, a));
    res.json(success({
      student: { id: student.id, name: student.name },
      list: rows,
      total,
      page,
      pageSize,
      // 全量口径：与列表同一 WHERE 条件在 SQL 里聚合，不再统计当前页
      summary: computeSummary(where, params),
    }));
  } catch (err) {
    console.error('[attendances student]', err);
    res.status(500).json(safeFail('获取成员上课记录失败'));
  }
});

/**
 * GET /api/attendances/summary — 课时汇总统计（出勤次数 / 课时 / 出勤率 / 按日趋势）
 * Query: studentId, classId, teacherId, startDate, endDate, status
 */
router.get('/summary', (req, res) => {
  try {
    const { studentId, classId, courseId, teacherId, startDate, endDate, status } = req.query;

    // 带 studentId 的汇总：家长仅可看自己绑定成员；否则需管理端工作人员
    if (studentId) {
      if (!canViewStudentData(req, studentId)) return res.status(403).json(safeFail('无权查看该成员的课时统计'));
    } else if (!isStaffReq(req)) {
      return res.status(403).json(safeFail('仅管理端工作人员可查看课时汇总'));
    }

    const { where, params } = buildWhere(req.query);

    // 统计与趋势都在 SQL 里聚合（COUNT / SUM / GROUP BY），明细行不进内存。
    // 此前用 ORDER BY a.date ASC LIMIT 20000 截断，取到的是「最旧」的两万行，
    // 对「本月出勤」这类场景分子分母都只覆盖历史窗口 —— 口径是错的，已去掉该截断。
    res.json(success({
      summary: computeSummary(where, params),
      trend: computeTrend(where, params),
      filters: { studentId: studentId || '', classId: classId || courseId || '', teacherId: teacherId || '', startDate: startDate || '', endDate: endDate || '', status: status || '' },
    }));
  } catch (err) {
    console.error('[attendances summary]', err);
    res.status(500).json(safeFail('获取课时统计失败'));
  }
});

module.exports = router;
