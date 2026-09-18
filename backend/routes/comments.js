/**
 * 训练点评路由 — 教练/管理员课后点评，家长端成长记录查看
 * POST /api/comments          — 写点评（管理员/教练）
 * GET  /api/comments?studentId= — 某学员点评列表（管理员/教练）
 * GET  /api/comments/my       — 家长端：绑定成员的点评
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, isCoachReq } = require('../utils');

// coach_comments 建表已收编至 migrations/014

function fmt(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name || '',
    courseName: row.course_name || '',
    date: row.date || '',
    coachName: row.coach_name || '',
    content: row.content || '',
    createdAt: row.created_at || 0,
  };
}

/**
 * POST /api/comments — 写点评
 * Body: { studentId, content, scheduleId? }
 */
router.post('/', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可写点评'));
    const { studentId, content, scheduleId } = req.body;
    if (!studentId) return res.json(fail('缺少成员 ID'));
    if (!content || !content.trim()) return res.json(fail('请填写点评内容'));
    const student = db.prepare('SELECT id, name FROM students WHERE id = ?').get(studentId);
    if (!student) return res.json(fail('成员不存在'));

    // 当前操作人（教练或管理员）
    const openid = getOpenId(req);
    const u = openid ? db.prepare('SELECT phone, role FROM users WHERE openid = ?').get(openid) : null;
    const coach = u?.phone
      ? db.prepare('SELECT id, name FROM teachers WHERE phone = ?').get(u.phone)
      : null;
    const schedule = scheduleId
      ? db.prepare('SELECT course_name, date FROM schedules WHERE id = ?').get(scheduleId)
      : null;

    const id = generateId('cmt_');
    const t = now();
    db.prepare(`
      INSERT INTO coach_comments (id, student_id, student_name, schedule_id, course_name, date,
        coach_id, coach_name, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, student.id, student.name, scheduleId || '', schedule?.course_name || '',
      schedule?.date || '', coach?.id || '', coach?.name || (req.userRole === 'admin' ? '管理员' : '教练'),
      content.trim(), t, t);

    res.json(success({ id }));
  } catch (err) {
    console.error('[comment create]', err);
    res.status(500).json(safeFail('保存点评失败'));
  }
});

/**
 * GET /api/comments?studentId= — 某学员点评列表（管理员/教练）
 */
router.get('/', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可查看'));
    const { studentId, limit = 20 } = req.query;
    if (!studentId) return res.json(fail('缺少成员 ID'));
    const list = db.prepare(`
      SELECT * FROM coach_comments WHERE student_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(studentId, Math.min(50, Number(limit) || 20)).map(fmt);
    res.json(success({ list }));
  } catch (err) {
    res.status(500).json(safeFail('获取点评失败'));
  }
});

/**
 * GET /api/comments/my — 家长端：绑定成员的点评（成长记录）
 * Query: { studentId?, limit }
 */
router.get('/my', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const limit = Math.min(50, Number(req.query.limit) || 20);
    const binds = db.prepare(
      "SELECT student_id, student_name FROM parent_bindings WHERE parent_openid = ? AND student_name != ''"
    ).all(openid);
    if (!binds.length) return res.json(success({ list: [] }));

    let rows;
    if (req.query.studentId) {
      // 防越权：家长仅可查看自己绑定成员的点评（成长记录）
      if (!binds.some((b) => b.student_id === req.query.studentId)) {
        return res.status(403).json(safeFail('无权查看该成员的成长记录'));
      }
      rows = db.prepare(`
        SELECT * FROM coach_comments WHERE student_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(req.query.studentId, limit);
    } else {
      const ph = binds.map(() => '?').join(',');
      const ids = binds.map((b) => b.student_id);
      rows = db.prepare(`
        SELECT * FROM coach_comments WHERE student_id IN (${ph})
        ORDER BY created_at DESC LIMIT ?
      `).all(...ids, limit);
    }
    res.json(success({ list: rows.map(fmt), students: binds.map((b) => ({ id: b.student_id, name: b.student_name })) }));
  } catch (err) {
    console.error('[comment my]', err);
    res.status(500).json(safeFail('获取点评失败'));
  }
});

module.exports = router;
