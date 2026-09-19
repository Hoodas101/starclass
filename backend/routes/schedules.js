/**
 * 排期路由 — 排期 CRUD、周期性排期、冲突检测、今日课表
 * POST /api/schedules              — 创建排期（含冲突检测）
 * POST /api/schedules/recursive    — 创建周期性排期
 * GET  /api/schedules              — 课表查询（按日期范围/教师/场地）
 * GET  /api/schedules/my           — 当前成员的课表
 * GET  /api/schedules/today        — 今日课表
 * PUT  /api/schedules/:id          — 修改排期
 * DELETE /api/schedules/:id        — 暂停活动
 * POST /api/schedules/conflict-check — 冲突检测
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, getActor, recordAudit, now, formatDate, getWeekDayDate, parsePagination, isAdminReq, isCoachReq, isStaffReq, canViewStudentData } = require('../utils');
const { requireStaffPerm } = require('../middleware/authz');

/**
 * 排期变更自动通知：向已报名学员的绑定家长发送站内通知
 */
function notifyEnrolledParents(scheduleId, title, content) {
  try {
    const parents = db.prepare(`
      SELECT DISTINCT pb.parent_openid
      FROM enrollments e
      JOIN parent_bindings pb ON pb.student_id = e.student_id
      WHERE e.schedule_id = ? AND e.status = 'active' AND pb.parent_openid != ''
    `).all(scheduleId);
    if (!parents.length) return 0;
    const t = now();
    const ins = db.prepare(`
      INSERT INTO notifications (id, user_id, title, content, priority, category, summary, channel, status, is_broadcast, sent_at, created_at)
      VALUES (?, ?, ?, ?, 'normal', 'system', ?, 'inapp', 'unread', 0, ?, ?)
    `);
    for (const p of parents) {
      ins.run(generateId('ntf_'), p.parent_openid, title, content, (content || '').slice(0, 60), t, t);
    }
    return parents.length;
  } catch (e) {
    console.error('[schedule notify]', e);
    return 0;
  }
}

// enrollments.created_by / schedule_rules.{repeat_type,interval_days,group_course_id,group_name} /
// schedules.{group_course_id,group_name,class_name,duration_minutes,allow_self_booking,student_ids}
// 等散落列已全部收编至 migrations/011（幂等账本），此处不再于 require 时执行 ALTER。

/**
 * 解析一场排期涉及的学员集合。
 *
 * 关联路径（已核验，非臆造）：
 *   1. schedules.student_ids —— 机构内部指定学员名单，逗号分隔文本
 *      （写入端见 POST / 的 `(student_ids && String(student_ids)) || ''`）；
 *      管理端表单目前不提供该字段，存量排期多为空串。
 *   2. enrollments —— 该场次已报名（status='active'）的学员，写入端见 POST /:id/enroll。
 *   3. 班级模型 —— 与 GET / 的可见性判定 applyClassVisibility（见本文件上方注释）同源：
 *      新模型 schedules.class_id → class_members；旧模型 schedules.group_course_id → student_class。
 */
function collectScheduleStudentIds(schedule) {
  const ids = new Set();
  const push = (v) => { if (v) ids.add(String(v).trim()); };
  String((schedule && schedule.student_ids) || '').split(',').forEach(push);
  if (schedule && schedule.id) {
    db.prepare("SELECT student_id FROM enrollments WHERE schedule_id = ? AND status = 'active'")
      .all(schedule.id).forEach((r) => push(r.student_id));
  }
  if (schedule && schedule.class_id) {
    db.prepare('SELECT student_id FROM class_members WHERE class_id = ?')
      .all(schedule.class_id).forEach((r) => push(r.student_id));
  } else if (schedule && schedule.group_course_id) {
    db.prepare('SELECT student_id FROM student_class WHERE class_id = ?')
      .all(schedule.group_course_id).forEach((r) => push(r.student_id));
  }
  return ids;
}

/**
 * 依据请求体解析「本次排期涉及的学员集合」（新建 / 改期 / 冲突检测三个入口共用）。
 * 与 collectScheduleStudentIds 同源：把请求体字段映射成同一形状后复用，避免两套口径。
 */
function resolveStudentIds({ studentIds, classId, groupCourseId, scheduleId = null }) {
  return collectScheduleStudentIds({
    id: scheduleId,
    student_ids: Array.isArray(studentIds) ? studentIds.join(',') : studentIds,
    class_id: classId,
    group_course_id: groupCourseId,
  });
}

/**
 * 冲突检测函数
 * 检测同一教师 / 同一场地 / 同一学员在同一时间段是否已有排期
 *
 * @param {Set<string>|null} studentIds 本次排期涉及的学员集合（见 resolveStudentIds）；
 *        为空集合时跳过学员维度。
 */
function checkConflict({ teacherId, classroomId, date, startTime, endTime, excludeId = null, studentIds = null }) {
  const excludeClause = excludeId ? ' AND id != ?' : '';

  // 教师冲突（标准区间重叠检测：start < new_end AND end > new_start）
  if (teacherId) {
    const params = [date, teacherId, endTime, startTime];
    if (excludeId) params.push(excludeId);
    const teacherConflict = db.prepare(`
      SELECT * FROM schedules
      WHERE date = ? AND teacher_id = ?
      AND start_time < ? AND end_time > ?
      AND status != 'cancelled' ${excludeClause}
    `).get(...params);
    if (teacherConflict) return { conflict: true, type: 'teacher', message: `教师在该时段已有排期: ${teacherConflict.course_name}` };
  }

  // 场地冲突
  if (classroomId) {
    const params = [date, classroomId, endTime, startTime];
    if (excludeId) params.push(excludeId);
    const classroomConflict = db.prepare(`
      SELECT * FROM schedules
      WHERE date = ? AND classroom_id = ?
      AND start_time < ? AND end_time > ?
      AND status != 'cancelled' ${excludeClause}
    `).get(...params);
    if (classroomConflict) return { conflict: true, type: 'classroom', message: `场地在该时段已被占用: ${classroomConflict.course_name}` };
  }

  // 学员冲突：同一学员被排进同日同时段的两场排期（沿用与教师/场地一致的区间重叠判定）
  if (studentIds && studentIds.size) {
    const params = [date, endTime, startTime];
    if (excludeId) params.push(excludeId);
    const others = db.prepare(`
      SELECT * FROM schedules
      WHERE date = ?
      AND start_time < ? AND end_time > ?
      AND status != 'cancelled' ${excludeClause}
    `).all(...params);
    for (const other of others) {
      const otherIds = collectScheduleStudentIds(other);
      const hit = [...studentIds].filter((sid) => otherIds.has(sid));
      if (hit.length) {
        const names = hit.map((sid) => {
          const stu = db.prepare('SELECT name FROM students WHERE id = ?').get(sid);
          return (stu && stu.name) || sid;
        });
        return { conflict: true, type: 'student', message: `学员在该时段已有排期: ${names.join('、')}` };
      }
    }
  }

  return { conflict: false };
}

// 自定义名称的临时活动：挂靠到内置「临时活动」课程（is_active=0，不在可选列表展示）
function ensureTempCourse() {
  const exists = db.prepare('SELECT id FROM courses WHERE id = ?').get('course_temp');
  if (!exists) {
    db.prepare(`
      INSERT INTO courses (id, name, category, description, duration, consume_classes, color, max_students, price_per_class, is_active, created_at)
      VALUES ('course_temp', '临时活动', '临时', '', 60, 0, '#9CA3AF', 0, 0, 0, ?)
    `).run(now());
  }
  return 'course_temp';
}

/**
 * POST /api/schedules — 创建排期（含冲突检测）
 * Body: { courseId, teacherId, classroomId, date, startTime, endTime, maxStudents, remark }
 */
  router.post('/', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可创建排期'));
    if (!requireStaffPerm(req, res, 'schedule', '排课')) return;
    const { courseId, courseName, teacherId, teacherName, classroomId, date, startTime, endTime, maxStudents, remark, groupCourseId, groupName, classId, class_name, duration_minutes, allow_self_booking, student_ids, class_count, price_per_class, confirmOverride } = req.body;
    if ((!courseId && !courseName) || !date || !startTime || !endTime) {
      return res.json(fail('活动名称、日期、开始时间、结束时间为必填'));
    }

    // 冲突检测（教师 / 场地 / 学员）。
    // confirmOverride 仅**管理员**可用：本接口对教练也开放（isCoachReq），
    // 若不校验角色，教练只要显式传该字段即可绕过全部冲突检测。
    const overrideAllowed = isAdminReq(req) && confirmOverride === true;
    const conflict = checkConflict({
      teacherId,
      classroomId,
      date,
      startTime,
      endTime,
      studentIds: resolveStudentIds({ studentIds: student_ids, classId, groupCourseId }),
    });
    if (conflict.conflict && !overrideAllowed) return res.json(fail(conflict.message));

    // 获取关联名称（支持自定义活动名称 / 手填教练）
    const course = courseId ? db.prepare('SELECT name FROM courses WHERE id = ?').get(courseId) : null;
    const teacher = teacherId ? db.prepare('SELECT name, alias FROM teachers WHERE id = ?').get(teacherId) : null;
    const classroom = classroomId ? db.prepare('SELECT name FROM classrooms WHERE id = ?').get(classroomId) : null;
    const finalName = (courseName && String(courseName).trim()) || course?.name || '';
    const finalTeacher = (teacherName && String(teacherName).trim()) || teacher?.alias || teacher?.name || '';
    if (!finalName) return res.json(fail('活动名称不能为空'));
    const effectiveCourseId = courseId || ensureTempCourse();

    const id = generateId('sch_');
    db.prepare(`
      INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, classroom_id, classroom_name,
        date, start_time, end_time, max_students, status, remark, group_course_id, group_name, class_id,
        class_name, duration_minutes, allow_self_booking, student_ids, class_count, price_per_class, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, effectiveCourseId, finalName, teacherId || '', finalTeacher, classroomId || '', classroom?.name || '',
      date, startTime, endTime, maxStudents || 0, remark || '', groupCourseId || '', groupName || '', classId || '',
      (class_name && String(class_name).trim()) || '', parseInt(duration_minutes, 10) || 0, (allow_self_booking === 0 || allow_self_booking === false || allow_self_booking === '0' || allow_self_booking === 'false') ? 0 : 1, (student_ids && String(student_ids)) || '',
      parseInt(class_count, 10) || 1, parseInt(price_per_class, 10) || 0, now(), now());

    res.json(success({ id }));
  } catch (err) {
    console.error('[schedule update]', err);
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/schedules/recursive — 创建周期性排期
 * Body: { courseId, teacherId, classroomId, repeatType: daily|weekly|custom, weekDays: [1,3,5], intervalDays, startTime, endTime, startDate, endDate, maxStudents }
 */
router.post('/recursive', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可创建排期'));
    const { courseId, courseName, teacherId, teacherName, classroomId, repeatType = 'weekly', weekDays = [], intervalDays = 1, startTime, endTime, startDate, endDate, maxStudents, groupCourseId, groupName, classId, class_name, duration_minutes, allow_self_booking, student_ids, class_count, price_per_class, confirmOverride } = req.body;
    if ((!courseId && !courseName) || !startTime || !endTime || !startDate || !endDate) {
      return res.json(fail('缺少必要参数'));
    }
    if (!['daily', 'weekly', 'custom'].includes(repeatType)) {
      return res.json(fail('不支持的重复规则'));
    }
    if (repeatType === 'weekly' && !weekDays.length) {
      return res.json(fail('请至少选择一个星期'));
    }
    if (repeatType === 'custom' && (!intervalDays || intervalDays < 1)) {
      return res.json(fail('重复间隔天数必须大于 0'));
    }
    // 周期跨度上限 180 天：误填年份（如 2027）会一次生成上千条排期，难删且污染课表
    {
      const spanDays = (new Date(endDate) - new Date(startDate)) / 86400000;
      if (!isFinite(spanDays) || spanDays < 0) return res.json(fail('结束日期不能早于开始日期'));
      if (spanDays > 180) return res.json(fail('周期排期最长 180 天，请分批创建'));
    }

    // 支持自定义活动名称 / 手填教练
    const course = courseId ? db.prepare('SELECT name FROM courses WHERE id = ?').get(courseId) : null;
    const teacher = teacherId ? db.prepare('SELECT name, alias FROM teachers WHERE id = ?').get(teacherId) : null;
    const classroom = classroomId ? db.prepare('SELECT name FROM classrooms WHERE id = ?').get(classroomId) : null;
    const finalName = (courseName && String(courseName).trim()) || course?.name || '';
    const finalTeacher = (teacherName && String(teacherName).trim()) || teacher?.alias || teacher?.name || '';
    if (!finalName) return res.json(fail('活动名称不能为空'));
    const effectiveCourseId = courseId || ensureTempCourse();

    // 创建规则
    const ruleId = generateId('rule_');
    db.prepare(`
      INSERT INTO schedule_rules (id, course_id, teacher_id, classroom_id, week_day, start_time, end_time, start_date, end_date, max_students, repeat_type, interval_days, group_course_id, group_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ruleId, effectiveCourseId, teacherId, classroomId, 0, startTime, endTime, startDate, endDate, maxStudents || 0, repeatType, intervalDays, groupCourseId || '', groupName || '', now());

    // 生成排期记录
    const createdSchedules = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    // 本次周期性排期涉及的学员集合（与单次创建同源），循环内复用，避免逐日重复查询
    const recurStudentIds = resolveStudentIds({ studentIds: student_ids, classId, groupCourseId });

    let intervalCounter = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dayOfWeek = d.getDay();
      let shouldCreate = false;
      if (repeatType === 'daily') {
        shouldCreate = true;
      } else if (repeatType === 'weekly') {
        shouldCreate = weekDays.includes(dayOfWeek);
      } else if (repeatType === 'custom') {
        shouldCreate = intervalCounter === 0;
        intervalCounter = intervalCounter === 0 ? intervalDays - 1 : intervalCounter - 1;
      }
      if (!shouldCreate) continue;

      const dateStr = formatDate(d.getTime());
      const conflict = checkConflict({
        teacherId,
        classroomId,
        date: dateStr,
        startTime,
        endTime,
        studentIds: recurStudentIds,
      });
      if (conflict.conflict && confirmOverride !== true) continue;

      const id = generateId('sch_');
      db.prepare(`
        INSERT INTO schedules (id, course_id, course_name, teacher_id, teacher_name, classroom_id, classroom_name,
          date, start_time, end_time, max_students, status, is_recursive, rule_id, group_course_id, group_name, class_id,
          class_name, duration_minutes, allow_self_booking, student_ids, class_count, price_per_class, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, effectiveCourseId, finalName, teacherId || '', finalTeacher, classroomId || '', classroom?.name || '',
        dateStr, startTime, endTime, maxStudents || 0, ruleId, groupCourseId || '', groupName || '', classId || '',
        (class_name && String(class_name).trim()) || '', parseInt(duration_minutes, 10) || 0, (allow_self_booking === 0 || allow_self_booking === false || allow_self_booking === '0' || allow_self_booking === 'false') ? 0 : 1, (student_ids && String(student_ids)) || '',
        parseInt(class_count, 10) || 1, parseInt(price_per_class, 10) || 0, now(), now());
      createdSchedules.push(id);
    }

    res.json(success({ ruleId, count: createdSchedules.length, scheduleIds: createdSchedules }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * 可见性规则（兼容新旧两类「班级」模型）—— GET / 与 GET /today 的唯一实现：
 *   新模型：schedules.class_id + class_members
 *   旧模型：schedules.group_course_id + student_class（课程即班级）
 * 判定：
 *   - group_course_id 与 class_id 均为空 = 全员可见；
 *   - 否则为受限排期，仅当浏览者归属其关联班级（任一模型命中）时可见。
 * 注意：class_id 非空而 group_course_id 为空，仍属「仅本班可见」，不可当作全员可见。
 *
 * 把过滤片段追加到 where、并把 classIds 压入 params，返回新的 where 字符串。
 */
function applyClassVisibility(where, params, classIds) {
  let w = `${where} AND (`;
  w += " (COALESCE(group_course_id,'') = '' AND COALESCE(class_id,'') = '')";
  if (classIds.length) {
    const ph = classIds.map(() => '?').join(',');
    w += ` OR (COALESCE(group_course_id,'') != '' AND group_course_id IN (${ph}))`;
    w += ` OR (COALESCE(class_id,'') != '' AND class_id IN (${ph}))`;
    params.push(...classIds, ...classIds);
  }
  return `${w} )`;
}

/** 解析逗号分隔的班级 ID 列表（管理端可按多班筛选） */
function resolveClassIds(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 当前请求者（家长等普通成员）有权看到的班级并集。
 * 合并其绑定成员所属的新旧两类班级模型；未登录或无绑定返回 []。
 */
function parentVisibleClassIds(req) {
  const openid = getOpenId(req);
  if (!openid) return [];
  const bound = db.prepare('SELECT DISTINCT student_id FROM parent_bindings WHERE parent_openid = ?').all(openid);
  const sIds = bound.map((b) => b.student_id).filter(Boolean);
  if (!sIds.length) return [];
  const ph = sIds.map(() => '?').join(',');
  const oldIds = db.prepare(`SELECT DISTINCT class_id FROM student_class WHERE student_id IN (${ph})`).all(...sIds).map((r) => r.class_id);
  const newIds = db.prepare(`SELECT DISTINCT class_id FROM class_members WHERE student_id IN (${ph})`).all(...sIds).map((r) => r.class_id);
  return [...oldIds, ...newIds];
}

/**
 * GET /api/schedules — 课表查询（按日期范围/教师/场地）
 * Query: { startDate, endDate, teacherId, classroomId, page, pageSize }
 */
router.get('/', (req, res) => {
  try {
    const { startDate, endDate, teacherId, classroomId, classId, studentId } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);

    let where = "WHERE status != 'cancelled'";
    const params = [];

    if (startDate) { where += ' AND date >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND date <= ?'; params.push(endDate); }
    if (teacherId) { where += ' AND teacher_id = ?'; params.push(teacherId); }
    if (classroomId) { where += ' AND classroom_id = ?'; params.push(classroomId); }

    // 目标班级可见性过滤：
    // - classId：管理端按班级筛选排期（可逗号分隔多个班级），仅管理员/教练显式指定
    // - studentId：按单个成员可见性筛选（仅返回全员可见或该成员所属班级可见的排期），带越权校验
    // - 家长等普通成员（非管理端工作人员）：自动按其绑定成员所属班级的并集进行过滤，
    //   仅展示“全员可见”或“其孩子所在班级可见”的排期，防止跨班窥视（防越权）
    if (classId) {
      // 管理端显式按班级筛选（管理员/教练）
      const requested = resolveClassIds(classId);
      if (isStaffReq(req)) {
        where = applyClassVisibility(where, params, requested);
      } else {
        // 家长：请求的班级必须落在其可见并集内，否则直接拒绝。
        // 若在此处退化成空并集，会把「他人班级」静默变成「全员可见排期」，与请求语义不符。
        const allowed = parentVisibleClassIds(req);
        const permitted = requested.filter((c) => allowed.includes(c));
        if (permitted.length === 0) return res.status(403).json(safeFail('无权查看该班级的排期'));
        where = applyClassVisibility(where, params, permitted);
      }
    } else if (studentId) {
      // 家长/教练/管理员按成员可见性筛选（防越权）
      if (!canViewStudentData(req, studentId)) {
        return res.status(403).json(safeFail('无权查看该成员的排期'));
      }
      const oldIds = db.prepare('SELECT class_id FROM student_class WHERE student_id = ?').all(studentId).map((r) => r.class_id);
      const newIds = db.prepare('SELECT class_id FROM class_members WHERE student_id = ?').all(studentId).map((r) => r.class_id);
      where = applyClassVisibility(where, params, [...oldIds, ...newIds]);
    } else if (!isStaffReq(req)) {
      // 普通成员（家长）：仅展示其绑定成员所属班级并集可见的排期，
      // 避免客户端伪造 classId 导致跨班窥视；并集为空时仅展示全员可见排期
      where = applyClassVisibility(where, params, parentVisibleClassIds(req));
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM schedules ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM attendances a WHERE a.schedule_id = s.id AND a.status IN ('present','late')) AS checked_in_count
      FROM schedules s ${where} ORDER BY date ASC, start_time ASC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/schedules/options — 排期轻量选项（用于调课等目标排期下拉）
 * 返回 id 与合成 label（活动 | 日期 时间区间），支持 q 按活动名搜索，默认仅进行中排期。
 * 必须放在 /schedules/:id 之前。
 */
router.get('/options', (req, res) => {
  try {
    const { q, status } = req.query;
    let where = "WHERE status != 'cancelled'";
    const params = [];
    const st = status || 'scheduled';
    where += ' AND status = ?';
    params.push(st);
    if (q) {
      where += ' AND course_name LIKE ?';
      params.push(`%${q}%`);
    }
    const rows = db.prepare(`
      SELECT id, course_name, date, start_time, end_time, enrolled_count, max_students
      FROM schedules ${where} ORDER BY date ASC, start_time ASC LIMIT 50
    `).all(...params);
    const list = rows.map((s) => ({
      id: s.id,
      course_name: s.course_name,
      date: s.date,
      start_time: s.start_time,
      end_time: s.end_time,
      enrolled_count: s.enrolled_count,
      max_students: s.max_students,
      label: `${s.course_name} | ${s.date} ${s.start_time}-${s.end_time}`,
    }));
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取排期选项失败'));
  }
});

/**
 * GET /api/schedules/my — 当前成员的课表
 */
router.get('/my', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));

    const schedules = db.prepare(`
      SELECT s.*, e.student_id, e.student_name, e.created_by
      FROM schedules s
      JOIN enrollments e ON e.schedule_id = s.id
      WHERE e.student_id IN (
        SELECT student_id FROM parent_bindings WHERE parent_openid = ?
      ) AND s.status = 'scheduled'
      ORDER BY s.date ASC, s.start_time ASC, e.created_at ASC
    `).all(openid);

    // 统一返回 { list }，与小程序端各页面解析结构保持一致
    res.json(success({ list: schedules, total: schedules.length }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/schedules/today — 今日课表
 *
 * 与 GET /api/schedules 同源的可见性强制：员工（管理员/教练/销售）看当日全量；
 * 家长等普通成员只能看到「全员可见」或自己孩子所在班级的当日排期。
 * 此前本端点无任何身份/角色判断，任一登录家长都能读到全机构当日排课。
 */
router.get('/today', (req, res) => {
  try {
    const today = formatDate(now());
    let where = "WHERE date = ? AND status = 'scheduled'";
    const params = [today];
    if (!isStaffReq(req)) {
      where = applyClassVisibility(where, params, parentVisibleClassIds(req));
    }
    const list = db.prepare(`
      SELECT * FROM schedules
      ${where}
      ORDER BY start_time ASC
    `).all(...params);

    res.json(success({ date: today, list, count: list.length }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/schedules/coach — 教练今日课表（按登录用户手机号匹配教师）
 * Query: { date }（可选，默认今天）
 */
router.get('/coach', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));

    const user = db.prepare('SELECT phone, role FROM users WHERE openid = ?').get(openid);
    if (!user) return res.json(fail('用户不存在'));

    const dateStr = req.query.date || formatDate(now());
    let teacherId = null;

    if (user.role === 'coach') {
      if (!user.phone) return res.json(fail('教练账号未绑定手机号'));
      const teacher = db.prepare("SELECT id FROM teachers WHERE phone = ? AND status = 'active'").get(user.phone);
      teacherId = teacher ? teacher.id : null;
      if (!teacherId) return res.json(success({ date: dateStr, list: [], isCoach: true, message: '未找到对应教师档案' }));
    } else if (user.role !== 'admin') {
      return res.status(403).json(safeFail('仅教练或管理员可查看今日课表'));
    }
    if (!requireStaffPerm(req, res, 'schedule', '排课')) return;

    let list;
    if (teacherId) {
      list = db.prepare(`
        SELECT * FROM schedules
        WHERE date = ? AND teacher_id = ? AND status = 'scheduled'
        ORDER BY start_time ASC
      `).all(dateStr, teacherId);
    } else {
      // 管理员查看当日全部课表
      list = db.prepare(`
        SELECT * FROM schedules
        WHERE date = ? AND status = 'scheduled'
        ORDER BY start_time ASC
      `).all(dateStr);
    }

    res.json(success({ date: dateStr, list, isCoach: !!teacherId }));
  } catch (err) {
    res.status(500).json(safeFail('获取今日课表失败'));
  }
});

// 教练课时统计（课时费核算）：上课节数 + 上课人次（今天/本周/本月/本年/累计）
// monthOverride: 可选 'YYYY-MM'，指定时“本月”周期按所选月份计算（用于管理员/教练按月份查看课时）
function coachStats(teacherId, monthOverride) {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const today = formatDate(d);
  const weekday = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (weekday === 0 ? 6 : weekday - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const weekStart = formatDate(monday);
  const weekEnd = formatDate(sunday);
  let monthStart;
  let monthEnd;
  if (monthOverride && /^\d{4}-\d{2}$/.test(monthOverride)) {
    const [oy, om] = monthOverride.split('-').map(Number);
    monthStart = formatDate(new Date(oy, om - 1, 1));
    monthEnd = formatDate(new Date(oy, om, 0));
  } else {
    monthStart = formatDate(new Date(y, m, 1));
    monthEnd = formatDate(new Date(y, m + 1, 0));
  }
  const yearStart = `${y}-01-01`;
  const yearEnd = `${y}-12-31`;

  const calc = (start, end) => {
    const classes = db.prepare(
      "SELECT COUNT(*) c FROM schedules WHERE teacher_id = ? AND status != 'cancelled' AND date >= ? AND date <= ?"
    ).get(teacherId, start, end).c;
    const students = db.prepare(`
      SELECT COUNT(*) c FROM attendances a
      JOIN schedules s ON s.id = a.schedule_id
      WHERE s.teacher_id = ? AND s.status != 'cancelled'
        AND a.status IN ('present','late') AND a.date >= ? AND a.date <= ?
    `).get(teacherId, start, end).c;
    return { classes, students };
  };

  const totalClasses = db.prepare(
    "SELECT COUNT(*) c FROM schedules WHERE teacher_id = ? AND status != 'cancelled'"
  ).get(teacherId).c;
  const totalStudents = db.prepare(`
    SELECT COUNT(*) c FROM attendances a
    JOIN schedules s ON s.id = a.schedule_id
    WHERE s.teacher_id = ? AND s.status != 'cancelled' AND a.status IN ('present','late')
  `).get(teacherId).c;

  return {
    today: calc(today, today),
    week: calc(weekStart, weekEnd),
    month: calc(monthStart, monthEnd),
    year: calc(yearStart, yearEnd),
    total: { classes: totalClasses, students: totalStudents },
  };
}

// 课时明细行（具体到哪天/哪节课/多少人）
function coachClassRows(teacherId, startDate, endDate) {
  return db.prepare(`
    SELECT s.id, s.date, s.course_name, s.start_time, s.end_time, s.status, s.enrolled_count,
      (SELECT COUNT(*) FROM attendances a
        WHERE a.schedule_id = s.id AND a.status IN ('present','late')) AS attended
    FROM schedules s
    WHERE s.teacher_id = ? AND s.status != 'cancelled' AND s.date >= ? AND s.date <= ?
    ORDER BY s.date ASC, s.start_time ASC
  `).all(teacherId, startDate, endDate);
}

/**
 * GET /api/schedules/coach/classes — 教练本人课时明细（按日期范围）
 * Query: { startDate, endDate }
 */
router.get('/coach/classes', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const user = db.prepare('SELECT phone, role FROM users WHERE openid = ?').get(openid);
    if (!user || user.role !== 'coach') return res.status(403).json(safeFail('仅教练可查看本人课时明细'));
    if (!requireStaffPerm(req, res, 'coachstats', '课时明细')) return;
    if (!user.phone) return res.json(fail('账号未绑定手机号'));
    const teacher = db.prepare("SELECT id, name FROM teachers WHERE phone = ?").get(user.phone);
    if (!teacher) return res.json(fail('尚未配置教练档案'));
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.json(fail('缺少日期范围'));
    res.json(success({ list: coachClassRows(teacher.id, startDate, endDate), coach: teacher.name }));
  } catch (err) {
    res.status(500).json(safeFail('获取课时明细失败'));
  }
});

/**
 * GET /api/schedules/admin/coach-classes — 管理员查看课时明细（按教练/日期范围）
 * Query: { coachId, startDate, endDate }
 */
router.get('/admin/coach-classes', (req, res) => {
  try {
    const openid = getOpenId(req);
    const u = openid ? db.prepare('SELECT role FROM users WHERE openid = ?').get(openid) : null;
    if (!(req.userRole === 'admin' || (u && u.role === 'admin'))) {
      return res.status(403).json(safeFail('仅管理员可查看课时明细'));
    }
    const { coachId, startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.json(fail('缺少日期范围'));
    let list;
    if (coachId) {
      list = coachClassRows(coachId, startDate, endDate).map((r) => ({
        ...r, teacherName: db.prepare('SELECT name FROM teachers WHERE id = ?').get(coachId)?.name || '',
      }));
    } else {
      list = db.prepare(`
        SELECT s.id, s.date, s.course_name, s.start_time, s.end_time, s.status, s.enrolled_count,
          s.teacher_id, s.teacher_name,
          (SELECT COUNT(*) FROM attendances a
            WHERE a.schedule_id = s.id AND a.status IN ('present','late')) AS attended
        FROM schedules s
        WHERE s.status != 'cancelled' AND s.date >= ? AND s.date <= ?
        ORDER BY s.date ASC, s.start_time ASC
      `).all(startDate, endDate);
    }
    res.json(success({ list, startDate, endDate }));
  } catch (err) {
    res.status(500).json(safeFail('获取课时明细失败'));
  }
});

/**
 * GET /api/coach/stats — 教练本人课时统计（教练端）
 */
router.get('/coach/stats', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const user = db.prepare('SELECT id, phone, role FROM users WHERE openid = ?').get(openid);
    if (!user) return res.json(fail('用户不存在'));
    if (user.role !== 'coach' && user.role !== 'admin') {
      return res.status(403).json(safeFail('仅教练或管理员可查看课时统计'));
    }
    if (!requireStaffPerm(req, res, 'coachstats', '课时统计')) return;
    if (!user.phone) return res.json(fail('账号未绑定手机号'));
    const teacher = db.prepare("SELECT id, name FROM teachers WHERE phone = ?").get(user.phone);
    if (!teacher) return res.json(fail('尚未配置教练档案，请联系管理员'));
    res.json(success({ teacherId: teacher.id, name: teacher.name, ...coachStats(teacher.id, req.query.month) }));
  } catch (err) {
    console.error('[coach stats]', err);
    res.status(500).json(safeFail('获取课时统计失败'));
  }
});

/**
 * GET /api/admin/coach-stats — 全部教练课时统计（管理员）
 */
router.get('/admin/coach-stats', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const u = openid ? db.prepare('SELECT role FROM users WHERE openid = ?').get(openid) : null;
    if (!(req.userRole === 'admin' || (u && u.role === 'admin'))) {
      return res.status(403).json(safeFail('仅管理员可查看全部教练课时统计'));
    }
    const teachers = db.prepare("SELECT id, name, phone, status, class_fee FROM teachers ORDER BY status, name").all();
    const list = teachers.map((t) => ({
      teacherId: t.id,
      name: t.name,
      phone: t.phone || '',
      status: t.status || 'active',
      classFee: Number(t.class_fee) || 0,
      ...coachStats(t.id, req.query.month),
    }));
    res.json(success({ list }));
  } catch (err) {
    console.error('[admin coach-stats]', err);
    res.status(500).json(safeFail('获取教练课时统计失败'));
  }
});

/**
 * POST /api/schedules/:id/enroll — 活动报名（家长为绑定成员报名）
 */
router.post('/:id/enroll', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));
    const isAdmin = isAdminReq(req);
    const actor = getActor(req);

    const s = db.prepare("SELECT * FROM schedules WHERE id = ? AND status = 'scheduled'").get(req.params.id);
    if (!s) return res.json(fail('活动不存在或已取消'));

    // 自助报名开关：非管理员（家长/教练端自助）遇显式关闭时拒绝，须联系机构代报。
    // （存量与新排期默认开启；关闭需在排课表单显式勾选，见 PUT 与 POST 写入端）
    if (!isAdmin && Number(s.allow_self_booking) === 0) {
      return res.json(fail('该活动未开放自助报名，请联系机构预约'));
    }

    // 支持指定孩子报名（多孩家庭）；未指定时兼容旧行为取主绑定孩子
    const { studentId } = req.body || {};
    let bind;
    if (isAdmin) {
      // 管理员代报名：无需家长绑定，直接按成员 ID 操作（用于新学员入班/纠错）
      if (!studentId) return res.json(fail('管理员代报名请指定成员ID'));
      const stu = db.prepare('SELECT id, name FROM students WHERE id = ?').get(studentId);
      if (!stu) return res.json(fail('成员不存在'));
      bind = { student_id: stu.id, student_name: stu.name, parent_name: '管理员' };
    } else if (studentId) {
      bind = db.prepare('SELECT * FROM parent_bindings WHERE parent_openid = ? AND student_id = ?').get(openid, studentId);
      if (!bind) return res.json(fail('该成员未绑定到当前账号，无法为其报名'));
    } else {
      bind = db.prepare('SELECT * FROM parent_bindings WHERE parent_openid = ? ORDER BY is_main DESC, id ASC LIMIT 1').get(openid);
    }
    if (!bind) return res.json(fail('请先绑定成员再报名'));

    // 班级限制：排期关联了班级（新模型 class_id 或旧模型 group_course_id）时，仅本班成员可自助报名。
    // 管理员可代报名（作为新成员入班/纠错路径）。
    if (!isAdmin && s.class_id) {
      // 新模型：严格校验 class_members 归属，杜绝跨班报名
      const inNewClass = db.prepare(
        'SELECT 1 FROM class_members WHERE class_id = ? AND student_id = ? LIMIT 1'
      ).get(s.class_id, bind.student_id);
      if (!inNewClass) {
        return res.json(fail('该排期仅限本班成员报名，如需加入请联系机构'));
      }
    } else if (!isAdmin && s.group_course_id) {
      // 旧模型：沿用既有 group_course_id + student_class 校验（首场放宽等逻辑保持兼容）
      const isClassMember = db.prepare(
        'SELECT 1 FROM student_class WHERE class_id = ? AND student_id = ? LIMIT 1'
      ).get(s.group_course_id, bind.student_id);
      if (!isClassMember) {
        const otherCount = db.prepare(`
          SELECT COUNT(*) c FROM schedules
          WHERE status != 'cancelled' AND id != ?
            AND (course_id = ? OR group_course_id = ?)
        `).get(s.id, s.group_course_id, s.group_course_id).c;
        if (otherCount > 0) {
          const inGroup = db.prepare(`
            SELECT 1 FROM enrollments e
            JOIN schedules sc ON sc.id = e.schedule_id
            WHERE e.student_id = ?
              AND (sc.course_id = ? OR sc.group_course_id = ?)
              AND sc.id != ?
            LIMIT 1
          `).get(bind.student_id, s.group_course_id, s.group_course_id, s.id);
          if (!inGroup) {
            return res.json(fail(`该活动仅限「${s.group_name || '本班'}」成员报名，如需加入请联系机构`));
          }
        }
      }
    }

    // 已报名去重、名额校验与报名写入在同一事务内原子完成，
    // 避免并发报名同时通过名额检查导致超员（当前同步写法无竞态，事务为语义兜底与防回归）。
    const currentTime = now();
    const enrollResult = db.transaction(() => {
      const s2 = db.prepare("SELECT * FROM schedules WHERE id = ? AND status = 'scheduled'").get(s.id);
      if (!s2) return { err: '活动不存在或已取消' };

      const already = db.prepare(`
        SELECT 1 FROM enrollments WHERE schedule_id = ? AND student_id = ? AND status = 'active'
      `).get(s2.id, bind.student_id);
      if (already) return { err: '已报名该活动' };

      if (s2.max_students > 0 && (s2.enrolled_count || 0) >= s2.max_students) {
        return { err: '该活动报名人数已满' };
      }

      // 以 students 表为准取孩子姓名（绑定记录可能为空）
      const student = db.prepare('SELECT name FROM students WHERE id = ?').get(bind.student_id);
      db.prepare(`
        INSERT INTO enrollments (id, student_id, student_name, course_id, course_name, schedule_id, status, enrolled_at, created_at, updated_at, created_by, class_id)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `).run(generateId('enr_'), bind.student_id, (student && student.name) || bind.student_name || s2.course_name,
        s2.course_id, s2.course_name, s2.id, currentTime, currentTime, currentTime, bind.parent_name || '家长', s2.class_id || '');
      db.prepare('UPDATE schedules SET enrolled_count = enrolled_count + 1, updated_at = ? WHERE id = ?')
        .run(currentTime, s2.id);

      recordAudit(db, {
        entity: 'enrollment',
        entityId: `${s2.id}:${bind.student_id}`,
        action: 'enroll',
        actorId: actor.id,
        actorRole: actor.role,
        before: null,
        after: { status: 'active', student_id: bind.student_id, schedule_id: s2.id },
      });

      return { ok: true, scheduleId: s2.id };
    })();

    if (enrollResult.err) return res.json(fail(enrollResult.err));
    res.json(success({ scheduleId: enrollResult.scheduleId, studentId: bind.student_id }));
  } catch (err) {
    console.error('[enroll]', err);
    res.status(500).json(safeFail('报名失败，请稍后重试'));
  }
});

/**
 * DELETE /api/schedules/:id/enroll — 取消报名
 */
router.delete('/:id/enroll', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));
    const isAdmin = isAdminReq(req);

    const s = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
    if (!s) return res.json(fail('活动不存在'));

    // 支持指定孩子取消报名（多孩家庭）；未指定时仅取消第一个孩子的报名，避免误删
    const { studentId } = req.body || {};
    const actor = getActor(req);
    let result, removed = [];
    if (isAdmin) {
      // 管理员代取消：直接按成员 ID 操作
      if (!studentId) return res.json(fail('管理员代取消请指定成员ID'));
      removed = db.prepare("SELECT id, student_id, status FROM enrollments WHERE schedule_id = ? AND student_id = ? AND status = 'active'").all(s.id, studentId);
      result = db.prepare(`
        DELETE FROM enrollments
        WHERE schedule_id = ? AND student_id = ? AND status = 'active'
      `).run(s.id, studentId);
    } else {
      let studentClause = '';
      const params = [s.id, openid];
      if (studentId) {
        studentClause = 'AND student_id = ?';
        params.push(studentId);
      }
      removed = db.prepare(`SELECT id, student_id, status FROM enrollments WHERE schedule_id = ? AND student_id IN (SELECT student_id FROM parent_bindings WHERE parent_openid = ?) AND status = 'active' ${studentClause}`).all(...params);
      result = db.prepare(`
        DELETE FROM enrollments
        WHERE schedule_id = ? AND student_id IN (
          SELECT student_id FROM parent_bindings WHERE parent_openid = ?
        ) AND status = 'active' ${studentClause}
      `).run(...params);
    }
    if (result.changes === 0) return res.json(fail('未找到报名记录'));

    db.prepare('UPDATE schedules SET enrolled_count = MAX(0, enrolled_count - ?), updated_at = ? WHERE id = ?')
      .run(result.changes, now(), s.id);

    for (const r of removed) {
      recordAudit(db, {
        entity: 'enrollment',
        entityId: r.id,
        action: 'enroll_cancel',
        actorId: actor.id,
        actorRole: actor.role,
        before: { student_id: r.student_id, status: r.status },
        after: { status: 'cancelled' },
      });
    }

    res.json(success({ scheduleId: s.id, studentId: studentId || undefined, removed: result.changes }));
  } catch (err) {
    console.error('[unenroll]', err);
    res.status(500).json(safeFail('取消报名失败，请稍后重试'));
  }
});

/**
 * GET /api/schedules/:id — 单个日程详情
 */
router.get('/:id', (req, res) => {
  try {
    const s = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
    if (!s) return res.json(fail('活动不存在'));

    // 当前用户是否已报名（通过绑定成员关联）
    const openid = getOpenId(req);
    let isRegistered = false;
    let myEnrollments = [];
    if (openid) {
      const enrolled = db.prepare(`
        SELECT e.student_id, e.student_name FROM enrollments e
        JOIN parent_bindings pb ON pb.student_id = e.student_id
        WHERE e.schedule_id = ? AND e.status = 'active' AND pb.parent_openid = ?
      `).all(req.params.id, openid);
      isRegistered = enrolled.length > 0;
      myEnrollments = enrolled.map((e) => ({ studentId: e.student_id, studentName: e.student_name }));
    }

    // 已报名成员（仅当前场次，防止混入同课程其他场次报名）
    // 角色隔离：工作人员（管理员/教练）可见完整名单；家长仅可见自己绑定成员在该场次的报名与考勤
    const isStaff = isStaffReq(req);
    let students;
    if (isStaff) {
      students = db.prepare(`
        SELECT e.student_id, e.student_name, a.status as checkin_status
        FROM enrollments e
        LEFT JOIN attendances a ON a.student_id = e.student_id AND a.schedule_id = ?
        WHERE e.schedule_id = ? AND e.status = 'active'
        LIMIT 20
      `).all(req.params.id, req.params.id);
    } else if (openid) {
      students = db.prepare(`
        SELECT e.student_id, e.student_name, a.status as checkin_status
        FROM enrollments e
        JOIN parent_bindings pb ON pb.student_id = e.student_id AND pb.parent_openid = ?
        LEFT JOIN attendances a ON a.student_id = e.student_id AND a.schedule_id = ?
        WHERE e.schedule_id = ? AND e.status = 'active'
      `).all(openid, req.params.id, req.params.id);
    } else {
      students = [];
    }

    // 角色隔离：student_ids 为机构内部指定学员名单，非工作人员不得见（防按 id 枚举读他人名册）
    const publicSchedule = isStaff ? s : { ...s, student_ids: '' };
    res.json(success({ ...publicSchedule, is_registered: isRegistered, my_enrollments: myEnrollments, students }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * PUT /api/schedules/:id — 修改排期
 */
  router.put('/:id', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可修改排期'));
    if (!requireStaffPerm(req, res, 'schedule', '排课')) return;
    const { id } = req.params;
    const { courseId, teacherId, classroomId, date, startTime, endTime, maxStudents, status, remark, groupCourseId, groupName, classId, class_name, duration_minutes, allow_self_booking, student_ids, class_count, price_per_class, confirmOverride } = req.body;

    const existing = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    if (!existing) return res.json(fail('排期不存在'));

    // 教练归属校验：非管理员只能修改本人授课的排期。
    // 排期含 price_per_class（直接影响薪资核算），放开任意教练互改等于互改工资。
    if (!isAdminReq(req)) {
      const openid = getOpenId(req);
      let allowed = existing.teacher_id === openid;
      if (!allowed) {
        const u = openid ? db.prepare('SELECT phone FROM users WHERE openid = ?').get(openid) : null;
        const coach = u && u.phone ? db.prepare('SELECT id FROM teachers WHERE phone = ?').get(u.phone) : null;
        allowed = !!(coach && coach.id === existing.teacher_id);
      }
      if (!allowed) return res.status(403).json(safeFail('无权修改非本人授课的排期'));
    }

    // 冲突检测（排除自身）
    const checkTeacherId = teacherId || existing.teacher_id;
    const checkClassroomId = classroomId || existing.classroom_id;
    const checkDate = date || existing.date;
    const checkStart = startTime || existing.start_time;
    const checkEnd = endTime || existing.end_time;

    // 学员集合：字段未传（undefined）时沿用原排期；scheduleId 传本场次，使本场已报名学员也纳入判定
    const effectiveStudentIds = resolveStudentIds({
      studentIds: student_ids !== undefined ? student_ids : existing.student_ids,
      classId: classId !== undefined ? classId : existing.class_id,
      groupCourseId: groupCourseId !== undefined ? groupCourseId : existing.group_course_id,
      scheduleId: id,
    });

    const conflict = checkConflict({
      teacherId: checkTeacherId,
      classroomId: checkClassroomId,
      date: checkDate,
      startTime: checkStart,
      endTime: checkEnd,
      excludeId: id,
      studentIds: effectiveStudentIds,
    });
    // 同 POST /：override 仅管理员可用，教练不得绕过冲突检测
    const overrideAllowed = isAdminReq(req) && confirmOverride === true;
    if (conflict.conflict && !overrideAllowed) return res.json(fail(conflict.message));

    // 名称解析：字段显式传空串（''）表示“清除”，未传（undefined）表示“保持不变”。
    // 传了 ID 但查不到档案时同样清空名称，避免 id 与 name 不一致。
    const course = courseId ? db.prepare('SELECT name FROM courses WHERE id = ?').get(courseId) : null;
    const teacher = teacherId ? db.prepare('SELECT name FROM teachers WHERE id = ?').get(teacherId) : null;
    const classroom = classroomId ? db.prepare('SELECT name FROM classrooms WHERE id = ?').get(classroomId) : null;
    const courseNameVal = courseId === '' ? '' : (course?.name ?? null);
    // 与创建逻辑一致：优先展示对外别名（alias），再回退真实姓名
    const teacherNameVal = teacherId === '' ? '' : ((teacher?.alias || teacher?.name) ?? null);
    const classroomNameVal = classroomId === '' ? '' : (classroom?.name ?? null);

    db.prepare(`
      UPDATE schedules SET
        course_id = COALESCE(?, course_id),
        course_name = COALESCE(?, course_name),
        teacher_id = COALESCE(?, teacher_id),
        teacher_name = COALESCE(?, teacher_name),
        classroom_id = COALESCE(?, classroom_id),
        classroom_name = COALESCE(?, classroom_name),
        date = COALESCE(?, date),
        start_time = COALESCE(?, start_time),
        end_time = COALESCE(?, end_time),
        max_students = COALESCE(?, max_students),
        status = COALESCE(?, status),
        remark = COALESCE(?, remark),
        group_course_id = COALESCE(?, group_course_id),
        group_name = COALESCE(?, group_name),
        class_id = COALESCE(?, class_id),
        class_name = COALESCE(?, class_name),
        duration_minutes = COALESCE(?, duration_minutes),
        allow_self_booking = COALESCE(?, allow_self_booking),
        student_ids = COALESCE(?, student_ids),
        class_count = COALESCE(?, class_count),
        price_per_class = COALESCE(?, price_per_class),
        updated_at = ?
      WHERE id = ?
    `).run(courseId, courseNameVal, teacherId, teacherNameVal, classroomId, classroomNameVal,
      date, startTime, endTime, maxStudents, status, remark, groupCourseId, groupName, classId,
      class_name, duration_minutes, allow_self_booking, student_ids, class_count, price_per_class, now(), id);

    // 关键信息变更：自动通知已报名家长
    const changed =
      (date && date !== existing.date) ||
      (startTime && startTime !== existing.start_time) ||
      (endTime && endTime !== existing.end_time) ||
      (teacherId && teacherId !== existing.teacher_id) ||
      (classroomId && classroomId !== existing.classroom_id) ||
      (status && status !== existing.status);
    if (changed) {
      const parts = []
      if (date || startTime || endTime) parts.push(`时间调整为 ${date || existing.date} ${startTime || existing.start_time}-${endTime || existing.end_time}`)
      if (teacherId) parts.push(`教练调整为 ${teacher?.name || '待定'}`)
      if (classroomId) parts.push(`场地调整为 ${classroom?.name || '待定'}`)
      if (status === 'cancelled') parts.push('该活动已取消')
      notifyEnrolledParents(
        id,
        '活动变更通知',
        `「${existing.course_name || '训练活动'}」${parts.join('，')}，请留意最新安排。`
      );
    }

    // 通过修改状态取消活动时,级联取消报名(与 DELETE /:id 行为一致),避免"已取消活动仍显示已报名"
    if (status === 'cancelled' && existing.status !== 'cancelled') {
      db.prepare("UPDATE enrollments SET status = 'cancelled', updated_at = ? WHERE schedule_id = ? AND status = 'active'")
        .run(now(), id);
      db.prepare('UPDATE schedules SET enrolled_count = 0, updated_at = ? WHERE id = ?').run(now(), id);
    }

    res.json(success({ id }));
  } catch (err) {
    console.error('[schedule update]', err);
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * DELETE /api/schedules/:id — 暂停活动
 */
router.delete('/:id', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可暂停活动'));
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    if (!existing) return res.json(fail('排期不存在'));

    // 先通知已报名家长（此时报名记录仍为 active）
    notifyEnrolledParents(
      id,
      '活动取消通知',
      `「${existing.course_name || '训练活动'}」（${existing.date} ${existing.start_time || ''}）已取消，感谢理解。`
    );
    db.prepare("UPDATE schedules SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), id);
    // 级联处理报名记录（置为取消，避免孤儿报名残留）
    db.prepare("UPDATE enrollments SET status = 'cancelled', updated_at = ? WHERE schedule_id = ? AND status = 'active'").run(now(), id);
    db.prepare("UPDATE schedules SET enrolled_count = 0 WHERE id = ? AND status = 'cancelled'").run(id);
    res.json(success({ id }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * POST /api/schedules/conflict-check — 冲突检测
 * Body: { teacherId, classroomId, date, startTime, endTime, excludeId,
 *         classId, groupCourseId, student_ids }  — 后三者用于推导学员维度
 */
router.post('/conflict-check', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可用冲突检测'));
    const { teacherId, classroomId, date, startTime, endTime, excludeId, classId, groupCourseId, student_ids } = req.body;
    if (!date || !startTime || !endTime) return res.json(fail('日期和时间不能为空'));

    const conflict = checkConflict({
      teacherId,
      classroomId,
      date,
      startTime,
      endTime,
      excludeId,
      studentIds: resolveStudentIds({ studentIds: student_ids, classId, groupCourseId, scheduleId: excludeId }),
    });
    res.json(success(conflict));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

module.exports = router;
