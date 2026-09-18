/**
 * 反馈路由 — 家长提交意见反馈、管理员查看、回复与处理
 * POST /api/feedback/apply       — 提交反馈
 * GET  /api/feedback/my          — 我的反馈
 * GET  /api/feedback             — 反馈列表（管理员）
 * PUT  /api/feedback/:id/reply   — 机构回复（管理员）
 * PUT  /api/feedback/:id/status  — 标记处理（管理员）
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, isAdminReq } = require('../utils');

// feedback 表由 db/init.js 创建（此前此处另有 CREATE TABLE IF NOT EXISTS，属冗余）

/**
 * POST /api/feedback/apply
 * Body: { content, contact }
 */
router.post('/apply', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const { content, contact = '' } = req.body;
    if (!content || !content.trim()) return res.json(fail('请填写反馈内容'));
    if (content.trim().length > 500) return res.json(fail('反馈内容过长（500 字以内）'));

    const user = db.prepare('SELECT nickname FROM users WHERE openid = ?').get(openid);
    const id = generateId('fb_');
    const currentTime = now();
    db.prepare(`
      INSERT INTO feedback (id, user_id, user_name, content, contact, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, openid, user?.nickname || '用户', content.trim(), contact.trim(), currentTime, currentTime);

    res.json(success({ id, status: 'pending' }));
  } catch (err) {
    console.error('[feedback apply]', err);
    res.status(500).json(safeFail('提交反馈失败'));
  }
});

/**
 * GET /api/feedback/my — 我的反馈
 */
router.get('/my', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const list = db.prepare('SELECT * FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(openid);
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取反馈记录失败'));
  }
});

/**
 * GET /api/feedback — 反馈列表（管理员）
 */
router.get('/', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可查看'));
    const { status, startDate, endDate } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    let where = 'WHERE 1=1';
    const params = [];
    if (status && ['pending', 'done'].includes(status)) {
      where += ' AND status = ?';
      params.push(status);
    }
    if (startDate) {
      where += ' AND created_at >= ?';
      params.push(new Date(startDate + 'T00:00:00').getTime());
    }
    if (endDate) {
      where += ' AND created_at <= ?';
      params.push(new Date(endDate + 'T23:59:59.999').getTime());
    }
    const total = db.prepare(`SELECT COUNT(*) as count FROM feedback ${where}`).get(...params).count;
    const list = db.prepare(`SELECT * FROM feedback ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);
    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    res.status(500).json(safeFail('获取反馈列表失败'));
  }
});

/**
 * PUT /api/feedback/:id/reply — 机构回复（管理员）
 * Body: { reply }
 * 回复后反馈状态同步置为 done（已处理）；回复为空则视为撤回回复，状态回到 pending。
 */
router.put('/:id/reply', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可操作'));
    const { reply = '' } = req.body;
    if (reply.trim().length > 500) return res.json(fail('回复内容过长（500 字以内）'));
    const existing = db.prepare('SELECT id FROM feedback WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('反馈不存在'));

    const operator = db.prepare('SELECT nickname, phone FROM users WHERE openid = ?')
      .get(getOpenId(req) || '');
    const repliedBy = operator?.nickname || operator?.phone || '管理员';
    const t = now();
    const text = reply.trim();
    db.prepare(
      'UPDATE feedback SET reply = ?, reply_at = ?, replied_by = ?, status = ?, updated_at = ? WHERE id = ?'
    ).run(text, text ? t : null, text ? repliedBy : '', text ? 'done' : 'pending', t, req.params.id);

    res.json(success({ id: req.params.id, reply: text, repliedBy: text ? repliedBy : '', status: text ? 'done' : 'pending' }));
  } catch (err) {
    console.error('[feedback reply]', err);
    res.status(500).json(safeFail('回复失败'));
  }
});

/**
 * PUT /api/feedback/:id/status — 标记处理（管理员）
 */
router.put('/:id/status', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可操作'));
    const { status } = req.body;
    if (!['done', 'pending'].includes(status)) return res.json(fail('无效状态'));
    const existing = db.prepare('SELECT id FROM feedback WHERE id = ?').get(req.params.id);
    if (!existing) return res.json(fail('反馈不存在'));
    db.prepare('UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), req.params.id);
    res.json(success({ id: req.params.id, status }));
  } catch (err) {
    res.status(500).json(safeFail('操作失败'));
  }
});

module.exports = router;
