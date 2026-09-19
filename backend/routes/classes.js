/**
 * 课程班级模块路由 — 会员分班管理
 *
 * 关联模型（四要素）：
 *   会员/学员(students) ──< class_members >── 班级(classes)        [分班：多对多，一会员可多班]
 *   班级(classes)       ──< schedules.class_id >── 排期(schedules)  [发布排期直接关联班级]
 *   排期(schedules)     ──< enrollments >── 报名(学员)              [班级成员可见并参与报名]
 *   报名(enrollments)   ──  request_status: pending→approved/rejected [报名请求审批流]
 *
 * 端点一览：
 *   POST   /api/classes                                  — 新建班级
 *   GET    /api/classes                                  — 班级列表（支持 keyword/status/studentId 过滤）
 *   GET    /api/classes/:id                              — 班级详情
 *   PUT    /api/classes/:id                              — 更新班级
 *   DELETE /api/classes/:id                              — 删除班级（清理成员与排期关联）
 *   GET    /api/classes/:id/members                      — 按班级筛选学员（名册，支持 keyword/role/分页）
 *   POST   /api/classes/:id/members                      — 分班：批量加入学员（支持一会员多班）
 *   PUT    /api/classes/:id/members/:studentId           — 调整成员角色（member/monitor）
 *   DELETE /api/classes/:id/members/:studentId          — 移除班级成员
 *   POST   /api/classes/:id/notify                       — 发布排期通知（推送给班级成员家长）
 *   POST   /api/classes/schedules/:scheduleId/request    — 学员家长提交报名请求
 *   GET    /api/classes/schedules/:scheduleId/requests/mine — 当前用户对该排期的报名请求
 *   GET    /api/classes/registration-requests            — 全部待处理报名请求（管理端）
 *   GET    /api/classes/:id/registration-requests        — 某班级的报名请求（可按 scheduleId/status 过滤）
 *   POST   /api/classes/:id/registration-requests/:requestId/approve — 通过报名
 *   POST   /api/classes/:id/registration-requests/:requestId/reject  — 拒绝报名
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, escapeLike, parsePagination, isAdminReq, isCoachReq, isStaffReq, canViewStudentData, getActor, recordAudit } = require('../utils');
// 已删除（status='refunded'）/ 已归档学员的统一排除条件（学员表别名须为 s）
const { ACTIVE_STUDENT_SQL } = require('../utils/student-state');

// 班级查询辅助：返回班级或 404
function getClassOr404(id) {
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
}

// 校验当前用户是否为该班级成员所对应的「管理端工作人员」
function isClassManager(req) {
  return isAdminReq(req) || isCoachReq(req);
}

/**
 * POST /api/classes — 新建班级
 */
router.post('/', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可新建班级'));
    const { name, courseId, coachId, classroomId, description, scheduleDesc, maxMembers, status } = req.body || {};
    if (!name || !String(name).trim()) return res.json(fail('班级名称必填'));

    // 校验关联课程目录是否存在（courseId 可空：不绑定具体课种）
    if (courseId) {
      const c = db.prepare('SELECT id FROM courses WHERE id = ?').get(courseId);
      if (!c) return res.json(fail('关联课程不存在'));
    }
    const id = generateId('cls_');
    db.prepare(`
      INSERT INTO classes (id, name, course_id, coach_id, classroom_id, description, schedule_desc, max_members, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, String(name).trim(), courseId || '', coachId || '', classroomId || '', description || '', scheduleDesc || '',
      parseInt(maxMembers, 10) || 0, status || 'active', now(), now());

    res.json(success({ id, name }));
  } catch (err) {
    console.error('[class create]', err);
    res.status(500).json(safeFail('创建班级失败'));
  }
});

/**
 * GET /api/classes — 班级列表
 * Query: { keyword, status, studentId, page, pageSize }
 *   - keyword：班级名称模糊搜索
 *   - status：active/graduated/archived
 *   - studentId：仅返回包含该学员的班级（学生侧视角）
 */
router.get('/', (req, res) => {
  try {
    if (!isStaffReq(req)) return res.status(403).json(safeFail('无班级查看权限'));
    const { keyword, status, studentId } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);

    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND c.status = ?'; params.push(status); }
    if (keyword) { where += ' AND c.name LIKE ? ESCAPE \'\\\''; params.push(`%${escapeLike(keyword)}%`); }
    if (studentId) {
      where += ' AND EXISTS (SELECT 1 FROM class_members cm WHERE cm.class_id = c.id AND cm.student_id = ?)';
      params.push(studentId);
    }

    const total = db.prepare(`SELECT COUNT(*) c FROM classes c ${where}`).get(...params).c;
    // member_count 必须与名册 /:id/members 同口径（排除已删/已归档学员），
    // 否则会出现「列表写着 10 人、打开名册只有 9 人」——两处数字互相印证不上。
    // 班级列表是一次查多个班级，故用相关子查询逐班统计，而不是只查单个班级。
    const list = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM class_members cm
           LEFT JOIN students s ON s.id = cm.student_id
           WHERE cm.class_id = c.id AND ${ACTIVE_STUDENT_SQL}) AS member_count,
        (SELECT name FROM courses WHERE id = c.course_id) AS course_name,
        (SELECT name FROM teachers WHERE id = c.coach_id) AS coach_name,
        (SELECT name FROM classrooms WHERE id = c.classroom_id) AS classroom_name
      FROM classes c ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    console.error('[class list]', err);
    res.status(500).json(safeFail('获取班级列表失败'));
  }
});

/**
 * GET /api/classes/:id — 班级详情
 */
router.get('/:id', (req, res) => {
  try {
    if (!isStaffReq(req)) return res.status(403).json(safeFail('无班级查看权限'));
    const cls = getClassOr404(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    // 与名册 /:id/members 同口径：已删/已归档学员不计入成员数，避免详情与名册数字对不上
    const memberCount = db.prepare(`
      SELECT COUNT(*) c FROM class_members cm
      LEFT JOIN students s ON s.id = cm.student_id
      WHERE cm.class_id = ? AND ${ACTIVE_STUDENT_SQL}
    `).get(req.params.id).c;
    const scheduleCount = db.prepare("SELECT COUNT(*) c FROM schedules WHERE class_id = ? AND status != 'cancelled'").get(req.params.id).c;
    const course = cls.course_id ? db.prepare('SELECT name FROM courses WHERE id = ?').get(cls.course_id) : null;
    const coach = cls.coach_id ? db.prepare('SELECT name FROM teachers WHERE id = ?').get(cls.coach_id) : null;
    const classroom = cls.classroom_id ? db.prepare('SELECT name FROM classrooms WHERE id = ?').get(cls.classroom_id) : null;
    res.json(success({
      ...cls,
      course_name: course ? course.name : '',
      coach_name: coach ? coach.name : '',
      classroom_name: classroom ? classroom.name : '',
      member_count: memberCount,
      schedule_count: scheduleCount,
    }));
  } catch (err) {
    console.error('[class detail]', err);
    res.status(500).json(safeFail('获取班级详情失败'));
  }
});

/**
 * PUT /api/classes/:id — 更新班级
 */
router.put('/:id', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可更新班级'));
    const cls = getClassOr404(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    const { name, courseId, coachId, classroomId, description, scheduleDesc, maxMembers, status } = req.body || {};
    if (courseId !== undefined && courseId) {
      const c = db.prepare('SELECT id FROM courses WHERE id = ?').get(courseId);
      if (!c) return res.json(fail('关联课程不存在'));
    }
    const p = (v) => (v === undefined ? null : v);
    db.prepare(`
      UPDATE classes SET
        name = COALESCE(?, name),
        course_id = COALESCE(?, course_id),
        coach_id = COALESCE(?, coach_id),
        classroom_id = COALESCE(?, classroom_id),
        description = COALESCE(?, description),
        schedule_desc = COALESCE(?, schedule_desc),
        max_members = COALESCE(?, max_members),
        status = COALESCE(?, status),
        updated_at = ?
      WHERE id = ?
    `).run(p(name), p(courseId), p(coachId), p(classroomId), p(description), p(scheduleDesc),
      maxMembers !== undefined ? (parseInt(maxMembers, 10) || 0) : null, p(status), now(), req.params.id);
    res.json(success({ id: req.params.id }));
  } catch (err) {
    console.error('[class update]', err);
    res.status(500).json(safeFail('更新班级失败'));
  }
});

/**
 * DELETE /api/classes/:id — 删除班级
 * 清理：先删成员、清空排期上的 class_id 关联（避免孤儿引用），再删班级。
 */
router.delete('/:id', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可删除班级'));
    const cls = getClassOr404(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    // 影响面必须先数出来再删：删完就查不到了，审计要如实记录连带影响了多少成员与排期
    const memberCount = db.prepare('SELECT COUNT(*) c FROM class_members WHERE class_id = ?').get(req.params.id).c;
    const scheduleCount = db.prepare('SELECT COUNT(*) c FROM schedules WHERE class_id = ?').get(req.params.id).c;
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM class_members WHERE class_id = ?').run(req.params.id);
      db.prepare("UPDATE schedules SET class_id = '', updated_at = ? WHERE class_id = ?").run(now(), req.params.id);
      db.prepare('DELETE FROM classes WHERE id = ?').run(req.params.id);
    });
    tx();
    // 删除班级是不可逆操作：一并解除全部成员的班级归属，并把该班级下的排期降级为无班级排期。
    // 此前与其它高危操作（删除学员/课程、停用教师、取消排期）不同，这里**没有留痕** ——
    // 班级被谁删的、连带影响了多少成员与排期，事后无从追溯。
    const actor = getActor(req);
    recordAudit(db, {
      entity: 'class',
      entityId: req.params.id,
      action: 'delete',
      actorId: actor.id,
      actorRole: actor.role,
      before: { name: cls.name, member_count: memberCount, schedule_count: scheduleCount },
      after: { status: 'deleted', members_unlinked: memberCount, schedules_detached: scheduleCount },
    });
    res.json(success({ id: req.params.id }));
  } catch (err) {
    console.error('[class delete]', err);
    res.status(500).json(safeFail('删除班级失败'));
  }
});

/**
 * GET /api/classes/:id/members — 按班级筛选学员（班级名册）
 * Query: { keyword, role, page, pageSize }
 */
router.get('/:id/members', (req, res) => {
  try {
    if (!isStaffReq(req)) return res.status(403).json(safeFail('无班级查看权限'));
    const cls = getClassOr404(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    const { keyword, role } = req.query;
    const { page, pageSize, offset } = parsePagination(req.query);

    // 已删除（status='refunded'）/ 已归档学员不占名册、不占名额：
    // 名册与总数共用同一 where，避免「列表已过滤、总数没过滤」导致的分页错位
    let where = `WHERE cm.class_id = ? AND ${ACTIVE_STUDENT_SQL}`;
    const params = [req.params.id];
    if (role) { where += ' AND cm.role = ?'; params.push(role); }
    if (keyword) {
      where += ` AND (s.name LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM parent_bindings pb WHERE pb.student_id = s.id AND pb.parent_phone LIKE ? ESCAPE '\\'
      ))`;
      const kw = `%${escapeLike(keyword)}%`;
      params.push(kw, kw);
    }

    const total = db.prepare(`
      SELECT COUNT(*) c FROM class_members cm
      LEFT JOIN students s ON s.id = cm.student_id ${where}
    `).get(...params).c;

    const list = db.prepare(`
      SELECT cm.id AS link_id, cm.student_id, cm.role, cm.joined_at,
             s.name, s.avatar, s.gender, s.level, s.status AS student_status,
             (SELECT pb.parent_name FROM parent_bindings pb WHERE pb.student_id = s.id ORDER BY pb.is_main DESC, pb.id ASC LIMIT 1) AS parent_name,
             (SELECT pb.parent_phone FROM parent_bindings pb WHERE pb.student_id = s.id ORDER BY pb.is_main DESC, pb.id ASC LIMIT 1) AS parent_phone
      FROM class_members cm
      LEFT JOIN students s ON s.id = cm.student_id
      ${where} ORDER BY cm.joined_at ASC, s.name ASC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(success({ list, total, page, pageSize, classId: cls.id, className: cls.name }));
  } catch (err) {
    console.error('[class members]', err);
    res.status(500).json(safeFail('获取班级成员失败'));
  }
});

/**
 * POST /api/classes/:id/members — 分班：批量加入学员
 * Body: { studentIds: string[] }
 * 支持一个会员加入多个班级（UNIQUE 仅约束同班不重复，跨班自由）。
 */
router.post('/:id/members', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可分班'));
    const cls = getClassOr404(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    const ids = Array.isArray(req.body.studentIds) ? req.body.studentIds : [];
    if (!ids.length) return res.json(fail('请选择要加入的学员'));

    // 容量校验与批量加入在同一事务内：逐条读-改-写分离时，
    // 中途异常会留下「一半学员已入班」的中间态
    let added = 0;
    const t = now();
    const ins = db.prepare(`
      INSERT OR IGNORE INTO class_members (id, class_id, student_id, role, joined_at)
      VALUES (?, ?, ?, 'member', ?)
    `);
    db.transaction(() => {
      // 容量基数只算「在册」学员：已删/已归档学员虽仍留在 class_members 里，
      // 但不应继续占名额，否则他们的残留行会让分班误报「班级容量已满」而挡住正常入班。
      // 用 LEFT JOIN 保留孤立行（学员行不存在时 s.* 为 NULL，COALESCE 兜底仍计入），与名册查询口径一致。
      const current = db.prepare(`
        SELECT COUNT(*) c FROM class_members cm
        LEFT JOIN students s ON s.id = cm.student_id
        WHERE cm.class_id = ? AND ${ACTIVE_STUDENT_SQL}
      `).get(req.params.id).c;
      for (const sid of ids) {
        if (!sid) continue;
        // 已删除/已归档学员不得被重新分班（与「不存在」同等处理，静默跳过）
        const stu = db.prepare(`SELECT s.id FROM students s WHERE s.id = ? AND ${ACTIVE_STUDENT_SQL}`).get(sid);
        if (!stu) continue;
        if (cls.max_members > 0 && (current + added) >= cls.max_members) {
          const err = new Error(`班级容量已满（上限 ${cls.max_members} 人）`);
          err.code = 'CLASS_FULL';
          throw err;
        }
        added += ins.run(generateId('cm_'), req.params.id, sid, t).changes;
      }
    })();
    res.json(success({ added, classId: req.params.id }));
  } catch (err) {
    if (err && err.code === 'CLASS_FULL') return res.json(fail(err.message));
    console.error('[class members add]', err);
    res.status(500).json(safeFail('添加班级成员失败'));
  }
});

/**
 * PUT /api/classes/:id/members/:studentId — 调整成员角色
 * Body: { role: 'member' | 'monitor' }
 */
router.put('/:id/members/:studentId', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可调整成员角色'));
    const cls = getClassOr404(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    const role = req.body && req.body.role;
    if (!['member', 'monitor'].includes(role)) return res.json(fail('角色非法'));
    const r = db.prepare('UPDATE class_members SET role = ? WHERE class_id = ? AND student_id = ?')
      .run(role, req.params.id, req.params.studentId);
    if (r.changes === 0) return res.json(fail('该学员不在本班级中'));
    res.json(success({ classId: req.params.id, studentId: req.params.studentId, role }));
  } catch (err) {
    console.error('[class member role]', err);
    res.status(500).json(safeFail('调整成员角色失败'));
  }
});

/**
 * DELETE /api/classes/:id/members/:studentId — 移除班级成员
 */
router.delete('/:id/members/:studentId', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可移除班级成员'));
    const cls = getClassOr404(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    const r = db.prepare('DELETE FROM class_members WHERE class_id = ? AND student_id = ?')
      .run(req.params.id, req.params.studentId);
    // 移除成员同样要留痕：此前无任何审计，谁把谁移出了哪个班级事后无从追溯。
    // r.changes === 0（本就不是该班成员）时**不写**审计 —— 没有实际变更，
    // 写进去只会让审计流水混进噪音，反而掩盖真正的移除动作。
    if (r.changes > 0) {
      const stu = db.prepare('SELECT name FROM students WHERE id = ?').get(req.params.studentId);
      const actor = getActor(req);
      recordAudit(db, {
        entity: 'class_member',
        entityId: `${req.params.id}:${req.params.studentId}`,
        action: 'remove',
        actorId: actor.id,
        actorRole: actor.role,
        before: {
          class_name: cls.name,
          student_id: req.params.studentId,
          student_name: stu ? stu.name : '',
        },
        after: { removed: true },
      });
    }
    res.json(success({ removed: r.changes, classId: req.params.id, studentId: req.params.studentId }));
  } catch (err) {
    console.error('[class member remove]', err);
    res.status(500).json(safeFail('移除班级成员失败'));
  }
});

/**
 * POST /api/classes/:id/notify — 发布排期通知
 * 向班级全体成员（经其绑定家长）推送站内通知；可关联某排期（会把该排期挂到本班级）。
 * Body: { scheduleId?, title, content, priority? }
 */
router.post('/:id/notify', (req, res) => {
  try {
    if (!isClassManager(req)) return res.status(403).json(safeFail('仅管理员或教练可发布通知'));
    const cls = getClassOr404(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    const { scheduleId, title, content, priority } = req.body || {};
    if (!title || !String(title).trim()) return res.json(fail('通知标题必填'));
    if (!content || !String(content).trim()) return res.json(fail('通知内容必填'));

    // 关联排期：发布即把排期挂到本班级（若尚未关联）
    let schedule = null;
    if (scheduleId) {
      schedule = db.prepare("SELECT * FROM schedules WHERE id = ? AND status != 'cancelled'").get(scheduleId);
      if (!schedule) return res.json(fail('关联排期不存在或已取消'));
      if (!schedule.class_id) {
        db.prepare("UPDATE schedules SET class_id = ?, updated_at = ? WHERE id = ?").run(cls.id, now(), scheduleId);
      }
    }

    // 收集班级成员的绑定家长（去重）
    const parents = db.prepare(`
      SELECT DISTINCT pb.parent_openid
      FROM class_members cm
      JOIN parent_bindings pb ON pb.student_id = cm.student_id
      WHERE cm.class_id = ? AND pb.parent_openid != ''
    `).all(cls.id);
    if (!parents.length) return res.json(success({ notified: 0, classId: cls.id, message: '该班级暂无绑定家长的成员' }));

    const t = now();
    const ins = db.prepare(`
      INSERT INTO notifications (id, user_id, title, content, priority, category, summary, channel, status, is_broadcast, sent_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'class', ?, 'inapp', 'unread', 0, ?, ?)
    `);
    let notified = 0;
    for (const p of parents) {
      ins.run(generateId('ntf_'), p.parent_openid, String(title).trim(), String(content).trim(),
        priority || 'normal', String(content).trim().slice(0, 60), t, t);
      notified++;
    }
    res.json(success({
      notified,
      classId: cls.id,
      className: cls.name,
      scheduleId: schedule ? schedule.id : undefined,
    }));
  } catch (err) {
    console.error('[class notify]', err);
    res.status(500).json(safeFail('发布通知失败'));
  }
});

// ===== 报名请求（请求 → 审批）=====

// 判断学员是否为某排期的「本班成员」（新模型 class_members 或旧模型 student_class + group_course_id）
function isScheduleClassMember(schedule, studentId) {
  if (schedule.class_id) {
    const m = db.prepare('SELECT 1 FROM class_members WHERE class_id = ? AND student_id = ? LIMIT 1')
      .get(schedule.class_id, studentId);
    if (m) return true;
  }
  if (schedule.group_course_id) {
    const m = db.prepare('SELECT 1 FROM student_class WHERE class_id = ? AND student_id = ? LIMIT 1')
      .get(schedule.group_course_id, studentId);
    if (m) return true;
  }
  return false;
}

/**
 * POST /api/classes/schedules/:scheduleId/request — 学员家长提交报名请求
 * Body: { studentId? }（多孩家庭可指定；未指定取主绑定孩子）
 */
router.post('/schedules/:scheduleId/request', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));
    const actor = getActor(req);
    const s = db.prepare("SELECT * FROM schedules WHERE id = ? AND status = 'scheduled'").get(req.params.scheduleId);
    if (!s) return res.json(fail('排期不存在或已取消'));

    // 解析要报名的孩子（与既有 enroll 逻辑一致）
    const { studentId } = req.body || {};
    let bind;
    if (studentId) {
      bind = db.prepare('SELECT * FROM parent_bindings WHERE parent_openid = ? AND student_id = ?').get(openid, studentId);
      if (!bind) return res.json(fail('该学员未绑定到当前账号，无法代其报名'));
    } else {
      bind = db.prepare('SELECT * FROM parent_bindings WHERE parent_openid = ? ORDER BY is_main DESC, id ASC LIMIT 1').get(openid);
    }
    if (!bind) return res.json(fail('请先绑定学员再报名'));

    // 仅本班成员可发起报名请求
    if (!isScheduleClassMember(s, bind.student_id)) {
      return res.json(fail('该排期仅限对应班级成员报名，如需加入请联系机构'));
    }

    // 防重复：已有 active 或 pending 报名则不允许再请求
    const dup = db.prepare(`
      SELECT 1 FROM enrollments WHERE schedule_id = ? AND student_id = ? AND status = 'active'
    `).get(s.id, bind.student_id);
    if (dup) return res.json(fail('已报名该排期'));
    const dupPending = db.prepare(`
      SELECT 1 FROM enrollments WHERE schedule_id = ? AND student_id = ? AND status = 'pending' AND request_status = 'pending'
    `).get(s.id, bind.student_id);
    if (dupPending) return res.json(fail('报名请求已提交，等待机构审核'));

    if (s.max_students > 0 && (s.enrolled_count || 0) >= s.max_students) {
      return res.json(fail('该排期报名人数已满'));
    }

    const student = db.prepare('SELECT name FROM students WHERE id = ?').get(bind.student_id);
    const t = now();
    const reqId = generateId('enr_');
    db.prepare(`
      INSERT INTO enrollments (id, student_id, student_name, course_id, course_name, schedule_id, status, request_status, class_id, enrolled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?)
    `).run(reqId, bind.student_id, (student && student.name) || bind.student_name || s.course_name,
      s.course_id, s.course_name, s.id, s.class_id || '', t, t, t);

    recordAudit(db, {
      entity: 'enrollment',
      entityId: reqId,
      action: 'enroll_request',
      actorId: actor.id,
      actorRole: actor.role,
      before: null,
      after: { status: 'pending', request_status: 'pending', student_id: bind.student_id, schedule_id: s.id },
    });

    res.json(success({ requestId: reqId, scheduleId: s.id, studentId: bind.student_id, status: 'pending' }));
  } catch (err) {
    console.error('[class enroll request]', err);
    res.status(500).json(safeFail('提交报名请求失败'));
  }
});

/**
 * GET /api/classes/schedules/:scheduleId/requests/mine — 当前用户对该排期的报名请求
 */
router.get('/schedules/:scheduleId/requests/mine', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));
    const bound = db.prepare('SELECT student_id FROM parent_bindings WHERE parent_openid = ?').all(openid).map(r => r.student_id);
    if (!bound.length) return res.json(success({ list: [], total: 0 }));
    const ph = bound.map(() => '?').join(',');
    const list = db.prepare(`
      SELECT id, student_id, student_name, status, request_status, class_id, reviewed_at, created_at
      FROM enrollments WHERE schedule_id = ? AND student_id IN (${ph}) AND status = 'pending'
      ORDER BY created_at DESC
    `).all(req.params.scheduleId, ...bound);
    res.json(success({ list, total: list.length }));
  } catch (err) {
    console.error('[class requests mine]', err);
    res.status(500).json(safeFail('获取报名请求失败'));
  }
});

/**
 * GET /api/classes/registration-requests — 全部待处理报名请求（管理端总览）
 * Query: { status=pending, scheduleId? }
 */
router.get('/registration-requests', (req, res) => {
  try {
    if (!isStaffReq(req)) return res.status(403).json(safeFail('无查看权限'));
    const { status = 'pending', scheduleId } = req.query;
    let where = "WHERE e.status = 'pending' AND e.request_status = ?";
    const params = [status];
    if (scheduleId) { where += ' AND e.schedule_id = ?'; params.push(scheduleId); }
    const list = db.prepare(`
      SELECT e.id, e.student_id, e.student_name, e.schedule_id, e.class_id, e.request_status, e.created_at, e.reviewed_at,
             s.date, s.start_time, s.end_time, s.course_name,
             (SELECT name FROM classes WHERE id = e.class_id) AS class_name
      FROM enrollments e
      LEFT JOIN schedules s ON s.id = e.schedule_id
      ${where} ORDER BY e.created_at ASC
    `).all(...params);
    res.json(success({ list, total: list.length }));
  } catch (err) {
    console.error('[class reg requests all]', err);
    res.status(500).json(safeFail('获取报名请求失败'));
  }
});

/**
 * GET /api/classes/:id/registration-requests — 某班级的报名请求
 * Query: { status=pending, scheduleId? }
 */
router.get('/:id/registration-requests', (req, res) => {
  try {
    if (!isStaffReq(req)) return res.status(403).json(safeFail('无查看权限'));
    const cls = getClassOr404(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    const { status = 'pending', scheduleId } = req.query;
    let where = "WHERE e.status = 'pending' AND e.request_status = ? AND e.class_id = ?";
    const params = [status, req.params.id];
    if (scheduleId) { where += ' AND e.schedule_id = ?'; params.push(scheduleId); }
    const list = db.prepare(`
      SELECT e.id, e.student_id, e.student_name, e.schedule_id, e.request_status, e.created_at, e.reviewed_at,
             s.date, s.start_time, s.end_time, s.course_name
      FROM enrollments e
      LEFT JOIN schedules s ON s.id = e.schedule_id
      ${where} ORDER BY e.created_at ASC
    `).all(...params);
    res.json(success({ list, total: list.length, classId: cls.id, className: cls.name }));
  } catch (err) {
    console.error('[class reg requests]', err);
    res.status(500).json(safeFail('获取报名请求失败'));
  }
});

// 审批公共逻辑（通过/拒绝共用）
function reviewRequest(req, res, approve) {
  try {
    if (!isClassManager(req)) return res.status(403).json(safeFail('仅管理员或教练可处理报名请求'));
    const actor = getActor(req);
    const cls = getClassOr404(req.params.id);
    if (!cls) return res.json(fail('班级不存在'));
    const requestId = req.params.requestId;
    const e = db.prepare("SELECT * FROM enrollments WHERE id = ? AND status = 'pending'").get(requestId);
    if (!e) return res.json(fail('报名请求不存在或已处理'));
    // 校验请求归属本班级（防止越权审批他班请求）
    if (e.class_id && e.class_id !== cls.id) return res.status(403).json(safeFail('该请求不属于本班级'));

    const t = now();
    if (approve) {
      // 通过：转为正式报名并计入人数
      const s = db.prepare("SELECT id, enrolled_count, max_students, status FROM schedules WHERE id = ?").get(e.schedule_id);
      if (!s || s.status === 'cancelled') return res.json(fail('关联排期已取消，无法通过'));
      if (s.max_students > 0 && (s.enrolled_count || 0) >= s.max_students) return res.json(fail('排期名额已满，无法通过'));
      const tx = db.transaction(() => {
        db.prepare(`
          UPDATE enrollments SET status = 'active', request_status = 'approved', reviewed_by = ?, reviewed_at = ?, updated_at = ?
          WHERE id = ?
        `).run('staff', t, t, requestId);
        db.prepare('UPDATE schedules SET enrolled_count = enrolled_count + 1, updated_at = ? WHERE id = ?').run(t, e.schedule_id);
      });
      tx();
      recordAudit(db, {
        entity: 'enrollment',
        entityId: requestId,
        action: 'enroll_approve',
        actorId: actor.id,
        actorRole: actor.role,
        before: { status: e.status, request_status: e.request_status },
        after: { status: 'active', request_status: 'approved' },
      });
      res.json(success({ requestId, approved: true }));
    } else {
      // 拒绝：标记 rejected（不计入人数，可重新发起）
      db.prepare(`
        UPDATE enrollments SET request_status = 'rejected', reviewed_by = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ?
      `).run('staff', t, t, requestId);
      recordAudit(db, {
        entity: 'enrollment',
        entityId: requestId,
        action: 'enroll_reject',
        actorId: actor.id,
        actorRole: actor.role,
        before: { status: e.status, request_status: e.request_status },
        after: { status: 'pending', request_status: 'rejected' },
      });
      res.json(success({ requestId, approved: false }));
    }
  } catch (err) {
    console.error('[class reg review]', err);
    res.status(500).json(safeFail('处理报名请求失败'));
  }
}

/**
 * POST /api/classes/:id/registration-requests/:requestId/approve — 通过报名
 */
router.post('/:id/registration-requests/:requestId/approve', (req, res) => reviewRequest(req, res, true));

/**
 * POST /api/classes/:id/registration-requests/:requestId/reject — 拒绝报名
 */
router.post('/:id/registration-requests/:requestId/reject', (req, res) => reviewRequest(req, res, false));

module.exports = router;
