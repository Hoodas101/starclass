/**
 * 请假路由 — 家长发起请假、管理员审批、批准后自动记录请假考勤并通知家长
 * POST /api/leave/apply       — 家长发起请假
 * GET  /api/leave/my          — 我的请假记录
 * GET  /api/leave             — 请假列表（管理员）
 * PUT  /api/leave/:id/approve — 审批（approve / reject）
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, isCoachReq, recordAudit } = require('../utils');
const { requireStaffPerm } = require('../middleware/authz');

// 请假规则默认值（可在 Web 管理端「系统设置 → 请假规则」中配置）
function getLeaveRules() {
  const defaults = {
    requireApproval: true,
    monthlyLimit: 0,
    deductClass: false,
    allowMakeup: true,
    deductMode: 'none',   // none | class(扣课时) | days(扣有效天数)
    deductAmount: 0,      // 每次请假扣除的数量
  };
  const row = db.prepare("SELECT value FROM settings WHERE key = 'leave_rules'").get();
  if (!row) return defaults;
  try {
    const r = JSON.parse(row.value);
    const mode = ['none', 'class', 'days'].includes(r.deductMode) ? r.deductMode
      : (r.deductClass ? 'class' : 'none');
    return {
      ...defaults,
      requireApproval: r.requireApproval !== false,
      monthlyLimit: Math.max(0, Number(r.monthlyLimit) || 0),
      allowMakeup: r.allowMakeup !== false,
      deductMode: mode,
      deductAmount: Math.max(0, Number(r.deductAmount) || 0),
      // 兼容旧字段
      deductClass: mode === 'class',
    };
  } catch (e) {
    return defaults;
  }
}

/**
 * 按请假规则扣减会员卡（次数扣课时 / 时效扣有效天数）。
 * 仅对状态为 active 的卡生效；找不到卡则静默跳过（非会员活动请假不扣）。
 */
function applyLeaveDeduction(studentId, scheduleId, currentTime) {
  // 幂等：同一 schedule+student 仅扣一次请假课，避免与已存在的缺席→请假转换或重复审批叠加扣减
  if (scheduleId) {
    const done = db.prepare('SELECT 1 FROM leave_deduction_logs WHERE schedule_id = ? AND student_id = ?')
      .get(scheduleId, studentId);
    if (done) return { deducted: false, reason: 'already_deducted' };
  }

  const rules = getLeaveRules();
  if (rules.deductMode === 'none' || !rules.deductAmount) return { deducted: false };

  if (rules.deductMode === 'class') {
    // 扣课时：只扣次数卡，优先扣到期最近的（DESC 会把新购卡先扣掉，与契约相反）
    const card = db.prepare(`
      SELECT * FROM member_cards
      WHERE student_id = ? AND status = 'active' AND billing_mode = 'count' AND remaining_classes > 0
      ORDER BY expires_at ASC LIMIT 1
    `).get(studentId);
    if (!card) return { deducted: false, reason: 'no_count_card' };
    const before = card.remaining_classes;
    const after = Math.max(0, before - rules.deductAmount);
    db.prepare('UPDATE member_cards SET remaining_classes = ?, used_classes = used_classes + ?, updated_at = ? WHERE id = ?')
      .run(after, before - after, currentTime, card.id);
    if (scheduleId) {
      db.prepare('INSERT OR IGNORE INTO leave_deduction_logs (schedule_id, student_id, card_id, mode, deducted_at) VALUES (?, ?, ?, ?, ?)')
        .run(scheduleId, studentId, card.id, 'class', currentTime);
    }
    return { deducted: true, mode: 'class', cardId: card.id, before, after, amount: before - after, cardName: card.card_type_name };
  }

  if (rules.deductMode === 'days') {
    // 扣有效天数：直接在名义到期日上调减；暂停期间到期日尚未顺延，恢复时会自动加上暂停时长，扣减随之保留
    const card = db.prepare(`
      SELECT * FROM member_cards
      WHERE student_id = ? AND status = 'active' AND billing_mode = 'time'
      ORDER BY expires_at DESC LIMIT 1
    `).get(studentId);
    if (!card) return { deducted: false, reason: 'no_time_card' };
    const newExpires = (card.expires_at || currentTime) - rules.deductAmount * 86400000;
    const newStatus = newExpires <= currentTime ? 'expired' : 'active';
    db.prepare('UPDATE member_cards SET expires_at = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(newExpires, newStatus, currentTime, card.id);
    if (scheduleId) {
      db.prepare('INSERT OR IGNORE INTO leave_deduction_logs (schedule_id, student_id, card_id, mode, deducted_at) VALUES (?, ?, ?, ?, ?)')
        .run(scheduleId, studentId, card.id, 'days', currentTime);
    }
    return { deducted: true, mode: 'days', cardId: card.id, before: card.expires_at, after: newExpires, amount: rules.deductAmount, cardName: card.card_type_name };
  }

  return { deducted: false, reason: 'unknown_mode' };
}

/**
 * GET /api/leave/rules — 家长端请假规则说明（供小程序展示）
 */
router.get('/rules', (req, res) => {
  try {
    res.json(success({ rules: getLeaveRules() }));
  } catch (err) {
    res.status(500).json(safeFail('获取请假规则失败'));
  }
});

/**
 * POST /api/leave/:id/cancel — 家长撤销自己的待审批请假
 */
router.post('/:id/cancel', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const row = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
    if (!row) return res.json(fail('请假记录不存在'));
    if (row.parent_openid !== openid) {
      return res.status(403).json(safeFail('仅可撤销本人提交的请假'));
    }
    if (row.status !== 'pending') {
      return res.json(fail('仅待审批的请假可撤销'));
    }
    db.prepare("UPDATE leave_requests SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(now(), req.params.id);
    res.json(success({ id: req.params.id, status: 'cancelled' }));
  } catch (err) {
    console.error('[leave cancel]', err);
    res.status(500).json(safeFail('撤销请假失败'));
  }
});

// leave_requests 由 db/init.js 创建；leave_deduction_logs 建表已收编至 migrations/014
// （此前两处 CREATE TABLE IF NOT EXISTS 分别在已存在时静默空操作）

/**
 * POST /api/leave/apply
 * Body: { scheduleId, reason }
 */
router.post('/apply', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const { scheduleId, reason, studentId } = req.body;
    if (!scheduleId) return res.json(fail('缺少排期 ID'));
    if (!reason || !reason.trim()) return res.json(fail('请填写请假原因'));

    const schedule = db.prepare("SELECT * FROM schedules WHERE id = ? AND status = 'scheduled'").get(scheduleId);
    if (!schedule) return res.json(fail('活动不存在或已取消'));

    // 支持为指定孩子请假（多孩家庭），未传时回退到主绑定孩子，兼容旧调用
    let bind;
    if (studentId) {
      bind = db.prepare(`
        SELECT * FROM parent_bindings WHERE parent_openid = ? AND student_id = ?
      `).get(openid, studentId);
      if (!bind) return res.json(fail('该成员与您无绑定关系'));
    } else {
      bind = db.prepare(`
        SELECT * FROM parent_bindings WHERE parent_openid = ? ORDER BY is_main DESC, id ASC LIMIT 1
      `).get(openid);
    }
    if (!bind) return res.json(fail('请先绑定成员'));

    // 每月请假次数上限（0 = 不限）
    const rules = getLeaveRules();
    if (rules.monthlyLimit > 0) {
      const monthPrefix = schedule.date ? schedule.date.slice(0, 7) : new Date().toISOString().slice(0, 7);
      const count = db.prepare(`
        SELECT COUNT(*) c FROM leave_requests
        WHERE student_id = ? AND status IN ('pending','approved') AND date LIKE ?
      `).get(bind.student_id, monthPrefix + '%').c;
      if (count >= rules.monthlyLimit) {
        return res.json(fail(`本月请假次数已达上限（${rules.monthlyLimit} 次）`));
      }
    }

    // 同一成员同一排期已有请假/已签到则拒绝
    const dup = db.prepare(`
      SELECT 1 FROM leave_requests WHERE student_id = ? AND schedule_id = ? AND status != 'rejected'
    `).get(bind.student_id, scheduleId);
    if (dup) return res.json(fail('该活动已有请假申请，请勿重复提交'));

    const attendance = db.prepare(`
      SELECT status FROM attendances WHERE schedule_id = ? AND student_id = ?
    `).get(scheduleId, bind.student_id);
    // 已签到/迟到/已请假 不可再请假；已自动标记缺席的可补请假（审批后转为请假）
    if (attendance && ['present', 'late', 'leave'].includes(attendance.status)) {
      return res.json(fail('该活动已签到，无法请假'));
    }

    const id = generateId('lv_');
    const currentTime = now();
    db.prepare(`
      INSERT INTO leave_requests (id, student_id, student_name, schedule_id, course_name, date, start_time,
        reason, status, parent_openid, parent_phone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(id, bind.student_id, bind.student_name || schedule.course_name, scheduleId,
      schedule.course_name, schedule.date, schedule.start_time,
      reason.trim(), openid, bind.parent_phone || '', currentTime, currentTime);

    res.json(success({ id, status: 'pending' }));
  } catch (err) {
    console.error('[leave apply]', err);
    res.status(500).json(safeFail('提交请假失败'));
  }
});

/**
 * GET /api/leave/my — 我的请假记录
 */
router.get('/my', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const list = db.prepare(`
      SELECT * FROM leave_requests WHERE parent_openid = ? ORDER BY created_at DESC
    `).all(openid);
    res.json(success({ list, total: list.length }));
  } catch (err) {
    res.status(500).json(safeFail('获取请假记录失败'));
  }
});

/**
 * GET /api/leave — 请假列表（管理员）
 * Query: { status, page, pageSize }
 */
router.get('/', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可查看'));
    if (!requireStaffPerm(req, res, 'leave', '请假审批')) return;
    const { status, startDate, endDate } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    let where = 'WHERE 1=1';
    const params = [];
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      where += ' AND status = ?';
      params.push(status);
    }
    if (startDate) { where += ' AND date >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND date <= ?'; params.push(endDate); }
    const total = db.prepare(`SELECT COUNT(*) as count FROM leave_requests ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT * FROM leave_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    res.status(500).json(safeFail('获取请假列表失败'));
  }
});

/**
 * PUT /api/leave/:id/approve — 审批请假
 * Body: { action: 'approve' | 'reject', note }
 */
router.put('/:id/approve', (req, res) => {
  try {
    if (!isCoachReq(req)) return res.status(403).json(safeFail('仅管理员或教练可审批'));
    if (!requireStaffPerm(req, res, 'leave', '请假审批')) return;
    const { action, note = '' } = req.body;
    if (!['approve', 'reject'].includes(action)) return res.json(fail('无效操作'));

    const currentTime = now();

    // 审批、考勤对齐、扣课、通知在单事务内原子提交：任一失败整体回滚，
    // 避免「状态已改但扣课未成 / 通知已发但状态未改」等半完成状态。
    const result = db.transaction(() => {
      const req_ = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
      if (!req_) return { err: '请假申请不存在' };
      if (req_.status !== 'pending') return { err: '该申请已处理' };

      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      db.prepare('UPDATE leave_requests SET status = ?, review_note = ?, updated_at = ? WHERE id = ?')
        .run(newStatus, note, currentTime, req_.id);

      if (action === 'approve') {
        // 对齐考勤状态：已存在考勤则把 absent 修正为 leave，否则插入请假考勤（幂等）
        const existing = db.prepare('SELECT * FROM attendances WHERE schedule_id = ? AND student_id = ?')
          .get(req_.schedule_id, req_.student_id);
        const schedule = db.prepare('SELECT course_id, course_name FROM schedules WHERE id = ?').get(req_.schedule_id);
        if (!existing) {
          db.prepare(`
            INSERT INTO attendances (id, schedule_id, student_id, student_name, course_id, course_name,
              status, checkin_method, checkin_time, date, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'leave', 'manual', ?, ?, ?, ?)
          `).run(generateId('att_'), req_.schedule_id, req_.student_id, req_.student_name,
            schedule?.course_id || '', schedule?.course_name || req_.course_name,
            currentTime, req_.date, currentTime, currentTime);
        } else if (existing.status === 'absent') {
          // 家长在自动缺席后补请假：将缺席转为请假，避免「既算缺席又扣课」
          db.prepare(`UPDATE attendances SET status = 'leave', checkin_method = 'manual', checkin_time = ?, updated_at = ? WHERE id = ?`)
            .run(currentTime, currentTime, existing.id);
        }

        // 按请假规则扣减会员卡（课时或有效天数）
        // 已签到/迟到不计请假扣课；缺席转请假或全新请假才扣（扣课幂等由 leave_deduction_logs 保证）
        let deduction = { deducted: false };
        if (!existing || existing.status === 'absent') {
          deduction = applyLeaveDeduction(req_.student_id, req_.schedule_id, currentTime);
        }
        let deductText = '';
        if (deduction.deducted) {
          if (deduction.mode === 'class') {
            deductText = ` 按规则扣除课时 ${deduction.amount} 节。`;
          } else if (deduction.mode === 'days') {
            deductText = ` 按规则扣除有效期 ${deduction.amount} 天。`;
          }
          // 审批即扣课时或改写有效期（可能置为 expired），等于动学员已付费资产，必须留痕可追责
          recordAudit(db, {
            entity: 'membership_card',
            entityId: deduction.cardId,
            action: 'leave_deduct',
            actorId: getOpenId(req),
            actorRole: req.userRole || '',
            before: deduction.mode === 'class'
              ? { remainingClasses: deduction.before }
              : { expiresAt: deduction.before },
            after: deduction.mode === 'class'
              ? { remainingClasses: deduction.after }
              : { expiresAt: deduction.after },
          });
        }

        // 通知家长审批结果
        if (req_.parent_openid) {
          const content = `您为孩子「${req_.student_name}」提交的请假（${req_.course_name} ${req_.date} ${req_.start_time}）已批准。${deductText}${note ? ' 备注：' + note : ''}`;
          db.prepare(`
            INSERT INTO notifications (id, user_id, title, content, priority, category, summary, template_id, channel, status, is_broadcast, sent_at, created_at)
            VALUES (?, ?, '请假已批准', ?, 'normal', 'schedule', ?, ?, 'inapp', 'sent', 0, ?, ?)
          `).run(
            generateId('NTF').toUpperCase(),
            req_.parent_openid,
            content,
            content.slice(0, 60),
            `leave_${req_.id}`.toUpperCase(),
            currentTime,
            currentTime
          );
        }
      } else if (req_.parent_openid) {
        const content = `您为孩子「${req_.student_name}」提交的请假（${req_.course_name} ${req_.date} ${req_.start_time}）未通过。${note ? '原因：' + note : ''}`;
        db.prepare(`
          INSERT INTO notifications (id, user_id, title, content, priority, category, summary, template_id, channel, status, is_broadcast, sent_at, created_at)
          VALUES (?, ?, '请假未通过', ?, 'normal', 'schedule', ?, ?, 'inapp', 'sent', 0, ?, ?)
        `).run(
          generateId('NTF').toUpperCase(),
          req_.parent_openid,
          content,
          content.slice(0, 60),
          `leave_${req_.id}`.toUpperCase(),
          currentTime,
          currentTime
        );
      }

      return { ok: true, id: req_.id, status: newStatus };
    })();

    if (result.err) return res.json(fail(result.err));
    res.json(success({ id: result.id, status: result.status }));
  } catch (err) {
    console.error('[leave approve]', err);
    res.status(500).json(safeFail('审批失败'));
  }
});

module.exports = router;
// 教师点名标「请假」与家长审批共用同一扣课规则（否则同一「请假」两条路径两种资产结果）。
// 单独挂到 router 上导出，既不改动既有的 `module.exports = router` 契约，
// 又让 routes/checkin.js 能取到；leave.js 不 require checkin.js，故无循环依赖。
module.exports.applyLeaveDeduction = applyLeaveDeduction;
