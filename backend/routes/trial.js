/**
 * 体验课预约路由（家长端公开接口）
 *
 * 家长在小程序提交体验课预约 → 自动创建线索（stage=trial）→ 管理端增长中心可见
 *
 * POST /api/trial/apply   — 家长提交体验课预约
 * GET  /api/trial/list    — 管理端：体验课预约列表
 * PUT  /api/trial/:id     — 管理端：处理预约（安排排期/拒绝）
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, isStaffReq } = require('../utils');

// 公开接口频控：同一手机号 1 小时内最多提交 5 次，防止体验课预约被刷
const trialPhoneLimits = new Map();
const TRIAL_LIMIT_WINDOW = 60 * 60 * 1000;
const TRIAL_LIMIT_MAX = 5;
// IP 维度频控：手机号频控可被「每次换一个合法手机号」绕过，按来源 IP 独立限
const trialIpLimits = new Map();
const TRIAL_IP_LIMIT_MAX = 15;

// trial_bookings 建表与索引已收编至 migrations/014

/**
 * POST /api/trial/apply — 家长提交体验课预约
 * Body: { studentName, studentAge?, studentGender?, parentName?, parentPhone, courseId?, preferredDate?, preferredTime?, note? }
 * 该接口允许已登录家长或未登录访客提交（手机号必填）
 */
router.post('/apply', (req, res) => {
  try {
    const {
      studentName, studentAge, studentGender,
      parentName, parentPhone,
      courseId, preferredDate, preferredTime, note,
    } = req.body;

    if (!studentName?.trim()) return res.json(fail('请填写学员姓名'));
    if (!parentPhone || !/^1\d{10}$/.test(parentPhone)) return res.json(fail('请输入正确的手机号'));

    // 手机号频控：同一手机号 1 小时内最多 5 次预约，防止公开接口被刷
    const nowMs = Date.now();
    let rec = trialPhoneLimits.get(parentPhone);
    if (!rec || nowMs - rec.firstAt > TRIAL_LIMIT_WINDOW) {
      rec = { firstAt: nowMs, count: 0 };
      trialPhoneLimits.set(parentPhone, rec);
    }
    rec.count += 1;
    if (rec.count > TRIAL_LIMIT_MAX) {
      return res.json(fail('操作过于频繁，请稍后再试'));
    }

    // IP 维度频控：堵死「每次换一个合法手机号」绕过手机号频控刷线索表的路径
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    let ipRec = trialIpLimits.get(ip);
    if (!ipRec || nowMs - ipRec.firstAt > TRIAL_LIMIT_WINDOW) {
      ipRec = { firstAt: nowMs, count: 0 };
      trialIpLimits.set(ip, ipRec);
    }
    ipRec.count += 1;
    if (ipRec.count > TRIAL_IP_LIMIT_MAX) {
      return res.json(fail('操作过于频繁，请稍后再试'));
    }

    const openid = getOpenId(req);
    const id = generateId('trial_');
    const t = now();

    // 获取课程名
    let courseName = '';
    if (courseId) {
      const course = db.prepare('SELECT name FROM courses WHERE id = ?').get(courseId);
      if (course) courseName = course.name;
    }

    db.prepare(`
      INSERT INTO trial_bookings
        (id, parent_openid, parent_name, parent_phone, student_name, student_age, student_gender,
         course_id, course_name, preferred_date, preferred_time, note, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id, openid || '', parentName || '', parentPhone,
      studentName.trim(), studentAge || null, studentGender || '',
      courseId || '', courseName, preferredDate || '', preferredTime || '',
      note || '', t, t
    );

    // 自动在增长中心创建线索（stage=trial）
    let leadId = null;
    try {
      // 检查是否已有同手机号的线索
      const existingLead = db.prepare(
        "SELECT id FROM leads WHERE phone = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      ).get(parentPhone);

      if (existingLead) {
        // 更新已有线索
        db.prepare(`
          UPDATE leads SET stage = 'trial', note = ?, updated_at = ?
          WHERE id = ?
        `).run(`体验课预约：${studentName}（${courseName || '未指定课程'}）`, t, existingLead.id);
        leadId = existingLead.id;
      } else {
        // 创建新线索
        leadId = generateId('lead_');
        db.prepare(`
          INSERT INTO leads (id, name, phone, source, stage, intent_level, note, status, created_at, updated_at)
          VALUES (?, ?, ?, 'trial', 'trial', 4, ?, 'active', ?, ?)
        `).run(
          leadId, studentName.trim(), parentPhone,
          `体验课预约：${studentName}（${courseName || '未指定课程'}）${preferredDate ? ' 期望日期：' + preferredDate : ''}${note ? ' 备注：' + note : ''}`,
          t, t
        );
      }

      // 关联线索 ID
      if (leadId) {
        db.prepare('UPDATE trial_bookings SET lead_id = ? WHERE id = ?').run(leadId, id);
      }
    } catch (e) {
      console.error('[trial apply] 创建线索失败:', e.message);
      // 线索创建失败不影响预约
    }

    res.json(success({ id, status: 'pending', leadId }));
  } catch (err) {
    console.error('[trial apply]', err);
    res.status(500).json(safeFail('提交预约失败，请稍后重试'));
  }
});

/**
 * GET /api/trial/list — 管理端：体验课预约列表
 * Query: { status?, page?, pageSize? }
 */
router.get('/list', (req, res) => {
  try {
    if (!isStaffReq(req)) return res.status(403).json(safeFail('仅管理员/教练/销售可查看'));
    const { status } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND status = ?'; params.push(status); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM trial_bookings ${where}`).get(...params).count;
    const list = db.prepare(`
      SELECT * FROM trial_bookings ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(success({ list, total, page, pageSize }));
  } catch (err) {
    console.error('[trial list]', err);
    res.status(500).json(safeFail('获取预约列表失败'));
  }
});

/**
 * PUT /api/trial/:id — 管理端：处理预约
 * Body: { action: 'assign' | 'reject', scheduleId?, note? }
 */
router.put('/:id', (req, res) => {
  try {
    if (!isStaffReq(req)) return res.status(403).json(safeFail('仅管理员/教练/销售可处理预约'));
    const { action, scheduleId, note = '' } = req.body;
    if (!['assign', 'reject'].includes(action)) return res.json(fail('无效操作'));

    const booking = db.prepare('SELECT * FROM trial_bookings WHERE id = ?').get(req.params.id);
    if (!booking) return res.json(fail('预约不存在'));
    if (booking.status !== 'pending') return res.json(fail('该预约已处理'));

    const t = now();
    const newStatus = action === 'assign' ? 'assigned' : 'rejected';
    db.prepare(`
      UPDATE trial_bookings SET status = ?, assigned_schedule_id = ?, handle_note = ?, handled_by = ?, updated_at = ?
      WHERE id = ?
    `).run(newStatus, scheduleId || null, note, req.openid || '', t, booking.id);

    // 通知家长
    if (booking.parent_openid) {
      const title = action === 'assign' ? '体验课已安排' : '体验课预约未通过';
      let content = '';
      if (action === 'assign') {
        const schedule = scheduleId ? db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) : null;
        content = `您为孩子「${booking.student_name}」预约的体验课已安排。${schedule ? `时间：${schedule.date} ${schedule.start_time}-${schedule.end_time}` : ''}。请准时到课，如有变动请联系机构。${note ? ' 备注：' + note : ''}`;
      } else {
        content = `您为孩子「${booking.student_name}」提交的体验课预约未通过。${note ? '原因：' + note : '如有疑问请联系机构。'}`;
      }
      db.prepare(`
        INSERT INTO notifications (id, user_id, title, content, priority, category, summary, channel, status, is_broadcast, sent_at, created_at)
        VALUES (?, ?, ?, ?, 'normal', 'system', ?, 'inapp', 'sent', 0, ?, ?)
      `).run(generateId('NTF'), booking.parent_openid, title, content, content.slice(0, 60), t, t);
    }

    res.json(success({ id: booking.id, status: newStatus }));
  } catch (err) {
    console.error('[trial handle]', err);
    res.status(500).json(safeFail('处理预约失败'));
  }
});

// 清理过期的体验课预约频控记录（server.js 定时调用，防止 Map 无限增长）
function cleanupTrialPhoneLimits() {
  const nowMs = Date.now();
  for (const [phone, rec] of trialPhoneLimits) {
    if (!rec || nowMs - rec.firstAt > TRIAL_LIMIT_WINDOW) trialPhoneLimits.delete(phone);
  }
  for (const [ip, rec] of trialIpLimits) {
    if (!rec || nowMs - rec.firstAt > TRIAL_LIMIT_WINDOW) trialIpLimits.delete(ip);
  }
}

module.exports = router;
module.exports.cleanupTrialPhoneLimits = cleanupTrialPhoneLimits;
