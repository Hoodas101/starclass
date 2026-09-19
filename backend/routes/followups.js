/**
 * 跟进任务路由 — 借鉴 trycompai/crm 的「Activity.dueAt + AgentTask 工作队列」设计
 * 自动生成规则（对应 CRM 的 schedule_recheck）：
 *   1. 续费跟进：会员卡到期前 15 / 7 / 1 天
 *   2. 线索跟进：线索到 next_follow_at 未跟进，或新建超 3 天未联系
 *   3. 体验跟进：线索处于「体验中」阶段
 *   4. 流失挽回：连续未到课达到 churn_rules.dormantDays（默认 14）天的在籍学员
 * 每条任务都带 reason（为什么跟进），负责人可直接看到原因后行动。
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, parsePagination, hasPerm, getReqUser } = require('../utils');
const { generateRenewalNotifications } = require('../utils/renewal');
const { getChurnRules } = require('../utils/churn');

// follow_ups 建表与索引已收编至 migrations/014

function canFollowUp(req) {
  if (req.userRole === 'admin') return true;
  const user = getReqUser(req);
  return !!(user && (user.role === 'coach' || hasPerm(user, 'growth') || hasPerm(user, 'sales')));
}

const TASK_TYPE_TEXT = {
  renewal: '续费跟进',
  lead_followup: '线索跟进',
  trial_followup: '体验跟进',
  churn_winback: '流失挽回',
  other: '其他',
};

function formatTask(row) {
  if (!row) return null;
  return { ...row, taskTypeText: TASK_TYPE_TEXT[row.task_type] || row.task_type };
}

function hasPending(targetType, targetId, taskType) {
  return !!db.prepare(`
    SELECT id FROM follow_ups
    WHERE target_type = ? AND target_id = ? AND task_type = ? AND status = 'pending'
    LIMIT 1
  `).get(targetType, targetId, taskType);
}

function insertTask({ targetType, targetId, targetName, phone, taskType, reason, owner, dueAt, priority = 0, createdBy = '' }) {
  if (hasPending(targetType, targetId, taskType)) return null;
  const id = generateId('FU_');
  db.prepare(`
    INSERT INTO follow_ups (id, target_type, target_id, target_name, phone, task_type, reason, owner, due_at, priority, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, targetType, targetId, targetName || '', phone || '', taskType, reason || '', owner || '', dueAt || now(), priority, createdBy, now());
  return id;
}

/**
 * POST /api/followups/generate — 按规则自动生成跟进任务（幂等去重）
 */
router.post('/generate', (req, res) => {
  try {
    if (!canFollowUp(req)) return res.status(403).json(safeFail('无跟进任务权限'));
    const t = now();
    const DAY = 86400000;
    let created = 0;

    // 同步触发家长端续费提醒通知（按推送规则 15/7/1 天自动发送，幂等去重；失败不阻塞跟进任务）
    try {
      const renewal = generateRenewalNotifications(db);
      if (renewal.created > 0) console.log(`[followups] 已同步发送续费提醒 ${renewal.created} 条`);
    } catch (e) { /* 忽略 */ }

    // 1) 续费跟进：到期前 15 / 7 / 1 天
    const expiring = db.prepare(`
      SELECT mc.id, mc.student_id, s.name as student_name, mc.card_type_name, mc.expires_at,
             pb.parent_phone
      FROM member_cards mc
      LEFT JOIN students s ON s.id = mc.student_id
      LEFT JOIN parent_bindings pb ON pb.student_id = mc.student_id AND pb.is_main = 1
      WHERE mc.status IN ('active','valid') AND mc.expires_at > ?
        AND mc.expires_at <= ? + ?
    `).all(t - 15 * DAY, t, 16 * DAY);
    for (const c of expiring) {
      const daysLeft = Math.ceil((c.expires_at - t) / DAY);
      if (daysLeft <= 0 || daysLeft > 15) continue;
      const key = [1, 7, 15].filter((d) => daysLeft <= d).sort((a, b) => a - b)[0];
      if (daysLeft > key) continue;
      const id = insertTask({
        targetType: 'student',
        targetId: c.student_id,
        targetName: c.student_name,
        phone: c.parent_phone || '',
        taskType: 'renewal',
        reason: `「${c.card_type_name || '会员卡'}」将于 ${daysLeft} 天后到期，需提醒续费`,
        owner: '',
        dueAt: t,
        priority: 1,
        createdBy: 'system',
      });
      if (id) created++;
    }

    // 2) 线索跟进：到 next_follow_at 未跟进，或新建超 3 天未联系
    const leads = db.prepare(`
      SELECT id, name, phone, stage, next_follow_at, created_at, salesperson FROM leads
      WHERE status = 'active' AND stage IN ('new','contacted','trial')
    `).all();
    for (const l of leads) {
      let reason = '';
      if (l.next_follow_at && l.next_follow_at <= t) {
        reason = '线索已到跟进时间，需要联系';
      } else if (!l.next_follow_at && l.created_at && t - l.created_at > 3 * DAY) {
        reason = '线索新建已超过 3 天，尚未安排跟进';
      }
      if (reason) {
        const id = insertTask({
          targetType: 'lead',
          targetId: l.id,
          targetName: l.name,
          phone: l.phone || '',
          taskType: 'lead_followup',
          reason,
          owner: l.salesperson || '',
          dueAt: l.next_follow_at || t,
          priority: 2,
          createdBy: 'system',
        });
        if (id) created++;
      }
    }

    // 3) 体验跟进：线索处于「体验中」
    const trials = db.prepare(`
      SELECT id, name, phone, salesperson FROM leads
      WHERE status = 'active' AND stage = 'trial'
    `).all();
    for (const l of trials) {
      const id = insertTask({
        targetType: 'lead',
        targetId: l.id,
        targetName: l.name,
        phone: l.phone || '',
        taskType: 'trial_followup',
        reason: '体验课学员，需安排体验反馈与转化沟通',
        owner: l.salesperson || '',
        dueAt: t,
        priority: 2,
        createdBy: 'system',
      });
      if (id) created++;
    }

    // 4) 流失挽回：连续未到课达到 dormantDays 天（默认 14，规则见 utils/churn.js）的在籍学员
    const { dormantDays } = getChurnRules(db);
    const churned = db.prepare(`
      SELECT s.id, s.name,
             (SELECT pb.parent_phone FROM parent_bindings pb WHERE pb.student_id = s.id AND pb.is_main = 1 LIMIT 1) as parent_phone,
             (SELECT MAX(a.date) FROM attendances a WHERE a.student_id = s.id) as last_date
      FROM students s
      WHERE s.status = 'active'
        AND (SELECT MAX(a.date) FROM attendances a WHERE a.student_id = s.id) IS NOT NULL
    `).all();
    for (const s of churned) {
      const lastTs = Date.parse(s.last_date);
      if (Number.isNaN(lastTs)) continue;
      const gap = Math.floor((t - lastTs) / DAY);
      if (gap < dormantDays) continue;
      const id = insertTask({
        targetType: 'student',
        targetId: s.id,
        targetName: s.name,
        phone: s.parent_phone || '',
        taskType: 'churn_winback',
        reason: `已连续 ${gap} 天未到课，建议安排回访挽回`,
        owner: '',
        dueAt: t,
        priority: 3,
        createdBy: 'system',
      });
      if (id) created++;
    }

    res.json(success({ created, message: created ? `已生成 ${created} 条跟进任务` : '暂无新的跟进任务需要生成' }));
  } catch (err) {
    console.error('[followups generate]', err);
    res.status(500).json(safeFail('生成跟进任务失败'));
  }
});

/**
 * GET /api/followups — 跟进任务列表
 * Query: { status, owner, taskType, targetType, keyword, overdue, page, pageSize }
 */
router.get('/', (req, res) => {
  try {
    if (!canFollowUp(req)) return res.status(403).json(safeFail('无跟进任务权限'));
    const { page, pageSize, offset } = parsePagination(req.query);
    const where = [];
    const params = [];
    if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
    if (req.query.owner) { where.push('owner = ?'); params.push(req.query.owner); }
    if (req.query.taskType) { where.push('task_type = ?'); params.push(req.query.taskType); }
    if (req.query.targetType) { where.push('target_type = ?'); params.push(req.query.targetType); }
    if (req.query.keyword) {
      where.push('(target_name LIKE ? OR phone LIKE ?)');
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`);
    }
    if (req.query.startDate) { where.push('due_at >= ?'); params.push(new Date(req.query.startDate + 'T00:00:00').getTime()); }
    if (req.query.endDate) { where.push('due_at <= ?'); params.push(new Date(req.query.endDate + 'T23:59:59.999').getTime()); }
    if (req.query.overdue === '1') {
      where.push("status = 'pending' AND due_at <= ?");
      params.push(now());
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) as count FROM follow_ups ${whereSql}`).get(...params).count;
    const list = db.prepare(`
      SELECT * FROM follow_ups ${whereSql}
      ORDER BY (status = 'pending') DESC, priority ASC, due_at ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset).map(formatTask);
    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    console.error('[followups list]', err);
    res.status(500).json(safeFail('获取跟进任务失败'));
  }
});

/**
 * GET /api/followups/today — 今日待办（首页看板）
 */
router.get('/today', (req, res) => {
  try {
    if (!canFollowUp(req)) return res.status(403).json(safeFail('无跟进任务权限'));
    const endOfDay = now() + (24 * 60 * 60 * 1000 - 1);
    const list = db.prepare(`
      SELECT * FROM follow_ups
      WHERE status = 'pending' AND due_at <= ?
      ORDER BY priority ASC, due_at ASC LIMIT 20
    `).all(endOfDay).map(formatTask);
    res.json(success({ list, count: list.length }));
  } catch (err) {
    console.error('[followups today]', err);
    res.status(500).json(safeFail('获取今日待办失败'));
  }
});

/**
 * POST /api/followups — 手动创建跟进任务
 */
router.post('/', (req, res) => {
  try {
    if (!canFollowUp(req)) return res.status(403).json(safeFail('无跟进任务权限'));
    const { targetType = 'student', targetId, targetName, phone, taskType = 'other', reason, owner = '', dueAt, priority = 0, note = '' } = req.body;
    if (!targetId || !reason) return res.json(fail('跟进对象与跟进原因必填'));
    const id = insertTask({
      targetType,
      targetId,
      targetName,
      phone,
      taskType,
      reason,
      owner,
      dueAt: dueAt || now(),
      priority,
      createdBy: getOpenId(req) || '',
    });
    if (!id) return res.json(fail('该对象已有未完成的同类跟进任务'));
    if (note) {
      db.prepare('UPDATE follow_ups SET note = ? WHERE id = ?').run(note, id);
    }
    res.json(success({ id }));
  } catch (err) {
    console.error('[followups create]', err);
    res.status(500).json(safeFail('创建跟进任务失败'));
  }
});

/**
 * POST /api/followups/:id/complete — 完成任务
 */
router.post('/:id/complete', (req, res) => {
  try {
    if (!canFollowUp(req)) return res.status(403).json(safeFail('无跟进任务权限'));
    const row = db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(req.params.id);
    if (!row) return res.json(fail('任务不存在'));
    const t = now();
    db.prepare('UPDATE follow_ups SET status = ?, completed_at = ?, note = COALESCE(?, note) WHERE id = ?')
      .run('done', t, req.body.note || null, req.params.id);
    // 线索跟进完成后：若下次跟进时间仍已过期，自动顺延 3 天，
    // 避免“完成→再生成”立即重建同一条任务
    if (row.target_type === 'lead' && row.target_id) {
      const lead = db.prepare('SELECT next_follow_at FROM leads WHERE id = ?').get(row.target_id);
      if (lead && (!lead.next_follow_at || lead.next_follow_at <= t)) {
        db.prepare('UPDATE leads SET next_follow_at = ?, updated_at = ? WHERE id = ?')
          .run(t + 3 * 86400000, t, row.target_id);
      }
    }
    res.json(success({ id: req.params.id, done: true }));
  } catch (err) {
    res.status(500).json(safeFail('操作失败'));
  }
});

/**
 * POST /api/followups/:id/cancel — 取消任务
 */
router.post('/:id/cancel', (req, res) => {
  try {
    if (!canFollowUp(req)) return res.status(403).json(safeFail('无跟进任务权限'));
    const row = db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(req.params.id);
    if (!row) return res.json(fail('任务不存在'));
    db.prepare('UPDATE follow_ups SET status = ?, completed_at = ? WHERE id = ?')
      .run('cancelled', now(), req.params.id);
    res.json(success({ id: req.params.id, cancelled: true }));
  } catch (err) {
    res.status(500).json(safeFail('操作失败'));
  }
});

module.exports = router;
