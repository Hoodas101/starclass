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
 * 从记录数组汇总课时统计
 */
function computeSummary(rows) {
  let presentCount = 0;
  let lateCount = 0;
  let absentCount = 0;
  let leaveCount = 0;
  let attendedMinutes = 0; // 实际出勤课时（仅 present/late 计入）
  let totalMinutes = 0;    // 出勤记录对应的排课时长合计（含缺勤，用于“应上课时”口径）

  for (const r of rows) {
    if (r.status === 'present') presentCount++;
    else if (r.status === 'late') lateCount++;
    else if (r.status === 'absent') absentCount++;
    else if (r.status === 'leave') leaveCount++;
    const mins = r.durationMin || 0;
    if (r.status === 'present' || r.status === 'late') attendedMinutes += mins;
    totalMinutes += mins;
  }
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
 * 从记录数组生成按日趋势（升序），供前端折线/柱状图使用
 */
function computeTrend(rows) {
  const map = {};
  for (const r of rows) {
    const d = r.date;
    if (!d) continue;
    if (!map[d]) map[d] = { date: d, attended: 0, total: 0 };
    map[d].total += 1;
    if (r.status === 'present' || r.status === 'late') map[d].attended += 1;
  }
  return Object.keys(map)
    .sort((a, b) => (a < b ? -1 : 1))
    .map((k) => map[k]);
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
      summary: computeSummary(rows),
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
      summary: computeSummary(rows),
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

    // E5：原先把全部考勤行读进内存再 slice(0, 20000)，全员口径下会在峰值时把整张
    // attendances 表（含大库几十万行）materialize 一遍。LIMIT 下推到 SQL 后由引擎在
    // 扫描阶段就截断（ORDER BY a.date ASC 可走 idx_attendances_date），内存峰值降为封顶行数。
    // 语义完全不变：排序键一致，截断点仍是「按 date 升序的前 20000 行」。
    const SUMMARY_ROW_CAP = 20000;
    const raw = db.prepare(`
      SELECT a.*, s.start_time, s.end_time
      FROM attendances a
      LEFT JOIN schedules s ON s.id = a.schedule_id
      ${where}
      ORDER BY a.date ASC
      LIMIT ${SUMMARY_ROW_CAP}
    `).all(...params);

    const rows = raw.map((a) => mapRecord(a, a));

    res.json(success({
      summary: computeSummary(rows),
      trend: computeTrend(rows),
      filters: { studentId: studentId || '', classId: classId || courseId || '', teacherId: teacherId || '', startDate: startDate || '', endDate: endDate || '', status: status || '' },
    }));
  } catch (err) {
    console.error('[attendances summary]', err);
    res.status(500).json(safeFail('获取课时统计失败'));
  }
});

module.exports = router;
