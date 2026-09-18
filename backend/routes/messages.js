/**
 * 消息路由 — 发送消息、我的消息、标记已读
 * POST /api/messages/send    — 发送消息
 * GET  /api/messages/my      — 我的消息
 * PUT  /api/messages/:id/read — 标记已读
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, isAdminReq } = require('../utils');
const { generateRenewalNotifications } = require('../utils/renewal');

// priority / summary / category / is_broadcast / group_name 列已收编至 migrations/011
// notification_reads 表由 db/init.js 与 migrations/001 创建（此前此处另有 CREATE TABLE，属冗余）

// 判断当前用户是否已读某条通知
function isReadFor(row, openid) {
  if (!row) return false;
  if (!row.is_broadcast) return row.status === 'read';
  if (!openid) return false;
  const r = db.prepare('SELECT 1 FROM notification_reads WHERE notification_id = ? AND user_id = ?').get(row.id, openid);
  return !!r;
}

/**
 * 家长可见的广播通知（与 /list、/unread-count 同一判定）：
 * 定向(group_name)仅本班（已报名该课程）可见；勿扰家长不见营销类；管理员可见全部。
 */
function visibleBroadcastIds(openid) {
  const user = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
  const isAdmin = !!(user && user.role === 'admin');
  if (isAdmin) {
    return db.prepare("SELECT id FROM notifications WHERE is_broadcast = 1 AND status = 'sent'").all().map(r => r.id);
  }
  const suppressed = !!db.prepare(`
    SELECT 1 FROM suppressions sp
    JOIN parent_bindings pb ON pb.parent_openid = ? AND pb.parent_phone = sp.phone
    WHERE sp.type = 'marketing' LIMIT 1
  `).get(openid);
  return db.prepare(`
    SELECT n.id FROM notifications n
    WHERE n.is_broadcast = 1 AND n.status = 'sent'
      ${suppressed ? "AND n.category != 'marketing'" : ''}
      AND (
        n.group_name = ''
        OR EXISTS (
          SELECT 1 FROM enrollments e
          JOIN schedules s ON s.id = e.schedule_id
          WHERE e.student_id IN (SELECT student_id FROM parent_bindings pb WHERE pb.parent_openid = ?)
            AND s.course_name = n.group_name
        )
      )
  `).all(openid).map(r => r.id);
}

// 标记已读
function markRead(row, openid) {
  if (!row || !openid) return;
  if (row.is_broadcast) {
    db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)')
      .run(row.id, openid, now());
  } else if (row.user_id === openid && row.status !== 'read') {
    db.prepare("UPDATE notifications SET status = 'read' WHERE id = ?").run(row.id);
  }
}

const PRIORITY_TEXT = { urgent: '紧急', important: '重要', normal: '提醒' };
const ICON_MAP = { urgent: 'warning', important: 'bell', normal: 'info' };

function formatNotice(row) {
  if (!row) return null;
  const priority = row.priority || 'normal';
  const content = row.content || '';
  const summary = row.summary || (content.length > 60 ? content.slice(0, 60) + '...' : content);
  // 系统提醒通知附带快捷动作：续期提醒 → 查看续费方案；低课时提醒 → 查看课表
  const templateId = row.template_id || '';
  let actions = [];
  if (templateId.startsWith('renewal_') || (row.title || '').includes('即将到期')) {
    actions = [{ label: '查看续费方案', type: 'url', value: '/pages/membership/membership' }];
  } else if (templateId.startsWith('low_class_')) {
    actions = [{ label: '查看活动课表', type: 'url', value: '/pages/schedule/schedule' }];
  }
  return {
    id: row.id,
    title: row.title,
    summary,
    detail: content,
    icon: ICON_MAP[priority] || 'info',
    priority,
    priorityText: PRIORITY_TEXT[priority] || '提醒',
    category: row.category || 'system',
    isRead: row.status === 'read',
    createdAt: row.created_at,
    channel: row.channel,
    groupName: row.group_name || '',
    actions,
  };
}

/**
 * GET /api/notifications/list — 当前用户通知（含广播）
 */
router.get('/list', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const user = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
    const isAdmin = !!(user && user.role === 'admin');
    // 勿扰名单：营销类广播对已设置勿扰的家长不可见（系统/课程通知不受影响）
    const suppressed = isAdmin ? false : !!db.prepare(`
      SELECT 1 FROM suppressions sp
      JOIN parent_bindings pb ON pb.parent_openid = ? AND pb.parent_phone = sp.phone
      WHERE sp.type = 'marketing' LIMIT 1
    `).get(openid);

    // 广播通知：定向(group_name)仅对属于该班级(已报名该课程)的家长可见；管理员可见全部
    const list = db.prepare(`
      SELECT * FROM notifications n
      WHERE n.user_id = ? OR (
        n.is_broadcast = 1
        ${suppressed ? "AND n.category != 'marketing'" : ''}
        ${
        isAdmin
          ? ''
          : `AND (
                n.group_name = ''
                OR EXISTS (
                  SELECT 1 FROM enrollments e
                  JOIN schedules s ON s.id = e.schedule_id
                  WHERE e.student_id IN (SELECT student_id FROM parent_bindings pb WHERE pb.parent_openid = ?)
                    AND s.course_name = n.group_name
                )
              )`
      }
      )
      ORDER BY n.created_at DESC LIMIT ?
    `).all(isAdmin ? [openid, limit] : [openid, openid, limit]);

    res.json(success(list.map((row) => ({ ...formatNotice(row), isRead: isReadFor(row, openid) }))));
  } catch (err) {
    res.status(500).json(safeFail('获取通知列表失败'));
  }
});

/**
 * GET /api/notifications/detail — 通知详情
 */
router.get('/detail', (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.json(fail('缺少通知 ID'));
    const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
    if (!row) return res.json(fail('通知不存在'));

    // 可见性校验：与列表一致——定向通知仅本人；广播按班级归属可见；勿扰家长不见营销类
    const openid = getOpenId(req);
    if (openid) {
      const user = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
      const isAdmin = !!(user && user.role === 'admin');
      if (!isAdmin && row.user_id !== openid) {
        if (row.is_broadcast !== 1) return res.json(fail('通知不存在'));
        const suppressed = !!db.prepare(`
          SELECT 1 FROM suppressions sp
          JOIN parent_bindings pb ON pb.parent_openid = ? AND pb.parent_phone = sp.phone
          WHERE sp.type = 'marketing' LIMIT 1
        `).get(openid);
        if (suppressed && row.category === 'marketing') return res.json(fail('通知不存在'));
        if (row.group_name) {
          const visible = db.prepare(`
            SELECT 1 FROM enrollments e
            JOIN schedules s ON s.id = e.schedule_id
            WHERE e.student_id IN (SELECT student_id FROM parent_bindings pb WHERE pb.parent_openid = ?)
              AND s.course_name = ?
            LIMIT 1
          `).get(openid, row.group_name);
          if (!visible) return res.json(fail('通知不存在'));
        }
      }
    }

    res.json(success(formatNotice(row)));
  } catch (err) {
    res.status(500).json(safeFail('获取通知详情失败'));
  }
});

/**
 * GET /api/notifications/unread-count — 未读数
 */
router.get('/unread-count', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));
    const user = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
    const isAdmin = !!(user && user.role === 'admin');
    const personalUnread = db.prepare(
      "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND status = 'sent'"
    ).get(openid).count;
    const broadcastUnread = isAdmin
      ? db.prepare(`
          SELECT COUNT(*) as count FROM notifications n
          WHERE n.is_broadcast = 1 AND n.status = 'sent'
            AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?)
        `).get(openid).count
      : db.prepare(`
          SELECT COUNT(*) as count FROM notifications n
          WHERE n.is_broadcast = 1 AND n.status = 'sent'
            AND (
              n.group_name = ''
              OR EXISTS (
                SELECT 1 FROM enrollments e
                JOIN schedules s ON s.id = e.schedule_id
                WHERE e.student_id IN (SELECT student_id FROM parent_bindings pb WHERE pb.parent_openid = ?)
                  AND s.course_name = n.group_name
              )
            )
            AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?)
        `).get(openid, openid).count;
    const count = personalUnread + broadcastUnread;
    res.json(success({ count }));
  } catch (err) {
    res.status(500).json(safeFail('获取未读数失败'));
  }
});

/**
 * POST /api/notifications/create — 发布广播通知（管理员）
 * Body: { title, content, priority, category, groupName }
 */
router.post('/create', (req, res) => {
  try {
    // 仅管理员可发布广播通知
    const openid = getOpenId(req);
    const u = openid ? db.prepare('SELECT role FROM users WHERE openid = ?').get(openid) : null;
    if (!(req.userRole === 'admin' || (u && u.role === 'admin'))) {
      return res.status(403).json(safeFail('仅管理员可发布通知'));
    }

    const { title, content, priority = 'normal', category = 'system', groupName = '' } = req.body;
    if (!title || !content) return res.json(fail('标题和内容不能为空'));

    const currentTime = now();
    const id = generateId('NTF');
    db.prepare(`
      INSERT INTO notifications (id, user_id, title, content, priority, category, summary, group_name, channel, status, is_broadcast, sent_at, created_at)
      VALUES (?, '', ?, ?, ?, ?, ?, ?, 'inapp', 'sent', 1, ?, ?)
    `).run(id, title, content, priority, category, content.slice(0, 80), groupName, currentTime, currentTime);

    res.json(success({ id, sent: true }));
  } catch (err) {
    console.error('[notice create]', err);
    res.status(500).json(safeFail('发布通知失败'));
  }
});

/**
 * POST /api/notifications/generate-renewal — 续费提醒自动发消息（管理员）
 * 按「推送规则 → 续期提醒」配置的提前天数（默认 15/7/1 天）扫描有效会员卡，
 * 到期当天所在的提醒档位向绑定家长发送站内通知；按 template_id 幂等去重，
 * 同一张卡同一提醒档位只发一次，不会重复打扰。
 */
router.post('/generate-renewal', (req, res) => {
  try {
    const openid = getOpenId(req);
    const u = openid ? db.prepare('SELECT role FROM users WHERE openid = ?').get(openid) : null;
    if (!(req.userRole === 'admin' || (u && u.role === 'admin'))) {
      return res.status(403).json(safeFail('仅管理员可触发续费提醒'));
    }
    const result = generateRenewalNotifications(db);
    res.json(success(result));
  } catch (err) {
    console.error('[generate-renewal]', err);
    res.status(500).json(safeFail('生成续费提醒失败，请稍后重试'));
  }
});

/**
 * POST /api/notifications/read — 标记已读
 */
router.post('/read', (req, res) => {
  try {
    const { id } = req.body;
    // 防御：id 必须是字符串，避免把对象/数组绑定进 SQLite 触发 500
    if (!id || typeof id !== 'string') return res.json(fail('缺少或无效的通知 ID'));
    const existing = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
    if (!existing) return res.json(fail('通知不存在'));
    markRead(existing, getOpenId(req));
    res.json(success({ id, read: true }));
  } catch (err) {
    res.status(500).json(safeFail('标记已读失败'));
  }
});

/**
 * POST /api/notifications/read-all — 全部标记已读
 */
router.post('/read-all', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));
    // 个人通知
    db.prepare("UPDATE notifications SET status = 'read' WHERE user_id = ? AND status = 'sent'").run(openid);
    // 广播通知（按用户记录）：仅标记本用户可见的广播，
    // 此前会把他人定向班级/勿扰营销广播也写成已读，污染送达统计
    const ids = visibleBroadcastIds(openid);
    const insert = db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)');
    const t = now();
    db.transaction(() => {
      for (const id of ids) insert.run(id, openid, t);
    })();
    res.json(success({ readAll: true }));
  } catch (err) {
    res.status(500).json(safeFail('操作失败'));
  }
});

/**
 * GET /api/notifications/group-notice — 小组通知（按 group 名称或全局广播）
 */
router.get('/group-notice', (req, res) => {
  try {
    const { group } = req.query;
    const openid = getOpenId(req);
    let row = null;
    if (group) {
      // 可见性与 list 对齐：家长只能看全局广播 + 自己孩子所报班级定向的广播；员工看全部
      const params = [group];
      let visClause = '';
      if (!isAdminReq(req)) {
        visClause = `AND (group_name = '' OR EXISTS (
            SELECT 1 FROM enrollments e
            JOIN schedules s ON s.id = e.schedule_id
            WHERE e.student_id IN (SELECT student_id FROM parent_bindings pb WHERE pb.parent_openid = ?)
              AND s.course_name = notifications.group_name
          ))`;
        params.push(openid);
      }
      row = db.prepare(`
        SELECT * FROM notifications
        WHERE is_broadcast = 1 AND (group_name = ? OR group_name = '') ${visClause}
        ORDER BY created_at DESC LIMIT 1
      `).get(...params);
    } else {
      row = db.prepare(`
        SELECT * FROM notifications
        WHERE is_broadcast = 1 AND group_name = ''
        ORDER BY created_at DESC LIMIT 1
      `).get();
    }
    res.json(success({ notice: formatNotice(row) }));
  } catch (err) {
    res.status(500).json(safeFail('获取小组通知失败'));
  }
});

/**
 * POST /api/messages/send — 发送消息
 * Body: { userId, studentId, templateId, title, content, channel }
 * channel: inapp / sms / wechat
 */
router.post('/send', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可发送消息'));
    const { userId, studentId, templateId, title, content, channel = 'inapp' } = req.body;
    if (!title || !content) return res.json(fail('标题和内容不能为空'));

    const currentTime = now();
    const id = generateId('MSG');

    db.prepare(`
      INSERT INTO notifications (id, user_id, student_id, template_id, title, content, channel, status, sent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)
    `).run(id, userId || '', studentId || '', templateId || '', title, content, channel, currentTime, currentTime);

    res.json(success({ id, sent: true }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/messages/my — 我的消息
 * 通过 openid 查询当前用户的消息
 * Query: { limit, unreadOnly }
 */
router.get('/my', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));

    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const { unreadOnly } = req.query;

    let sql = 'SELECT * FROM notifications WHERE user_id = ?';
    const params = [openid];

    if (unreadOnly === 'true' || unreadOnly === '1') {
      sql += " AND status = 'sent'";
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const list = db.prepare(sql).all(...params);

    // 统计未读数
    const unreadCount = db.prepare(
      "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND status = 'sent'"
    ).get(openid).count;

    res.json(success({ list, unreadCount, hasMore: list.length === limit }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * PUT /api/messages/:id/read — 标记已读（按用户）
 *
 * 广播通知（is_broadcast=1，user_id 为空串）的已读状态是**每用户**的，必须记录在
 * notification_reads 里。此前这里直接 `UPDATE notifications SET status='read' WHERE id=?`，
 * 而归属校验又因 `existing.user_id` 为空串而短路跳过 —— 任一家长标记一条广播已读后，
 * 整行 status 被全局改写，所有家长都看不到该条未读了。
 * 现与 POST /read 共用 markRead()：广播写 notification_reads，定向通知仅接收人可写回本行 status。
 */
router.put('/:id/read', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
    if (!existing) return res.json(fail('消息不存在'));

    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));

    // 广播通知：按调用者写入 notification_reads，绝不改写全局 status
    if (existing.is_broadcast) {
      markRead(existing, openid);
      return res.json(success({ id, read: true }));
    }

    // 定向通知：仅消息接收人可标记已读，防止越权标记他人消息
    // （不能用「user_id 为空即放行」的短路判断，那正是广播被全局改写的根因）
    if (existing.user_id !== openid) {
      return res.status(403).json(safeFail('无权操作他人消息'));
    }
    markRead(existing, openid);
    res.json(success({ id, read: true }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * PUT /api/messages/read-all — 全部标记已读（额外功能）
 */
router.put('/read-all', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.json(fail('未登录'));

    db.prepare("UPDATE notifications SET status = 'read' WHERE user_id = ? AND status = 'sent'").run(openid);
    res.json(success({ readAll: true }));
  } catch (err) {
    res.status(500).json(safeFail("操作失败，请稍后重试"));
  }
});

/**
 * GET /api/notifications/admin/list — 通知历史（管理员）
 * Query: { page, pageSize, keyword, priority, category }
 * 返回每条通知的送达人数与已读人数
 */
router.get('/admin/list', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可访问'));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const { keyword, priority, category, startDate, endDate } = req.query;

    let where = 'WHERE 1=1';
    const params = [];
    if (keyword) { where += ' AND title LIKE ?'; params.push(`%${keyword}%`); }
    if (priority) { where += ' AND priority = ?'; params.push(priority); }
    if (category) { where += ' AND category = ?'; params.push(category); }
    if (startDate) {
      where += ' AND created_at >= ?';
      params.push(new Date(startDate + 'T00:00:00').getTime());
    }
    if (endDate) {
      where += ' AND created_at <= ?';
      params.push(new Date(endDate + 'T23:59:59.999').getTime());
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM notifications ${where}`).get(...params).count;
    const rows = db.prepare(`
      SELECT * FROM notifications ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize);

    // 家长用户总数（广播送达基数）
    const parentCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'parent'").get().count;

    // E8：原先在 rows.map 内逐行 prepare + 执行两条查询（已读数、定向班级送达数），
    // 每页 pageSize 行就是 2×pageSize 次数据库往返（N+1）。改为按当前页的 id / 课程名
    // 各批量取一次，查询数与页大小无关；两处口径与逐行版本逐字保持一致。
    const ids = rows.map((r) => r.id);
    const readCountMap = new Map();
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      db.prepare(`
        SELECT notification_id, COUNT(*) as count FROM notification_reads
        WHERE notification_id IN (${ph}) GROUP BY notification_id
      `).all(...ids).forEach((r) => readCountMap.set(r.notification_id, r.count));
    }
    const groupNames = [...new Set(rows.filter((r) => r.is_broadcast && r.group_name).map((r) => r.group_name))];
    const groupCountMap = new Map();
    if (groupNames.length) {
      const ph = groupNames.map(() => '?').join(',');
      db.prepare(`
        SELECT s.course_name AS name, COUNT(DISTINCT pb.parent_openid) as count
        FROM enrollments e
        JOIN schedules s ON s.id = e.schedule_id
        JOIN parent_bindings pb ON pb.student_id = e.student_id
        WHERE e.status = 'active' AND s.course_name IN (${ph}) AND pb.parent_openid != ''
        GROUP BY s.course_name
      `).all(...groupNames).forEach((r) => groupCountMap.set(r.name, r.count));
    }

    const list = rows.map((row) => {
      const readCount = readCountMap.get(row.id) || 0;
      // 定向班级广播：按已报名该课程成员的绑定家长数统计送达，避免误显示为全员
      let delivered = parentCount;
      if (row.is_broadcast && row.group_name) {
        const groupCount = groupCountMap.get(row.group_name) || 0;
        if (groupCount > 0) delivered = groupCount;
      }
      return {
        ...formatNotice(row),
        readCount,
        deliveredCount: row.is_broadcast ? delivered : 1,
        isBroadcast: !!row.is_broadcast,
        groupName: row.group_name || '',
      };
    });

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    res.status(500).json(safeFail('获取通知列表失败'));
  }
});

/**
 * DELETE /api/notifications/:id — 删除通知（管理员）
 * 同时清理该通知的已读记录与广播关联，用于移除误发/过期通知。
 */
router.delete('/:id', (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(403).json(safeFail('仅管理员可删除通知'));
    const row = db.prepare('SELECT id FROM notifications WHERE id = ?').get(req.params.id);
    if (!row) return res.json(fail('通知不存在'));
    db.prepare('DELETE FROM notification_reads WHERE notification_id = ?').run(req.params.id);
    db.prepare('DELETE FROM notifications WHERE id = ?').run(req.params.id);
    res.json(success({ id: req.params.id, deleted: true }));
  } catch (err) {
    console.error('[notification delete]', err);
    res.status(500).json(safeFail('删除通知失败'));
  }
});

module.exports = router;
