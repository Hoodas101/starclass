/**
 * 体验课预约路由（家长端公开接口）
 *
 * 家长在小程序提交体验课预约 → 自动创建线索（stage=trial）→ 管理端增长中心可见
 *
 * POST /api/trial/apply        — 家长提交体验课预约
 * GET  /api/trial/list         — 管理端：体验课预约列表
 * GET  /api/trial/:id          — 管理端：体验课详情（含一键建学员的预填字段）
 * POST /api/trial/:id/convert  — 管理端：体验课成交（回写学员绑定 + 线索成交）
 * PUT  /api/trial/:id          — 管理端：处理预约（安排排期/拒绝）
 *
 * 转化主链路：预约（apply）只负责建/更新线索；成交（convert）在同一事务内把
 * 「预约 → 学员 → 线索」三处串起来，避免用户手工在试听预约 / 增长中心 / 销售订单
 * 三个页面搬运同一条信息。
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateId, success, fail, safeFail, getOpenId, now, isStaffReq, isAdminReq, hasPerm, getReqUser, getActor, recordAudit } = require('../utils');
// 「学员是否在册」的唯一判据（已删除/已归档排除）；注意 SQL 中学员表别名必须为 s
const { ACTIVE_STUDENT_SQL } = require('../utils/student-state');

// trial_bookings.student_id 列由 migrations/028 统一创建（migrations 先于路由加载执行），
// 此处不再做运行时补列 —— schema 变更统一归 migrations 拥有，避免启动时隐式改表结构。

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
 * 体验课成交权限：管理员，或拥有「growth」权限的员工（销售默认拥有）。
 * 与增长中心 canGrowth 同判据 —— 成交本质是线索转化，入口不同不应放宽。
 */
function canConvertTrial(req) {
  return isAdminReq(req) || hasPerm(getReqUser(req), 'growth');
}

/**
 * GET /api/trial/:id — 管理端：体验课详情
 * 返回该预约的全部字段，外加前端一键建学员用的预填字段 studentPayload。
 * 字段取自 trial_bookings 实际列：无 birthday（只有 student_age），故不返回该键
 * （拿不到的字段一律省略，不写占位值 —— 否则前端会把空生日当真实值提交）。
 */
router.get('/:id', (req, res) => {
  try {
    if (!isStaffReq(req)) return res.status(403).json(safeFail('仅管理员/教练/销售可查看'));
    const booking = db.prepare('SELECT * FROM trial_bookings WHERE id = ?').get(req.params.id);
    if (!booking) return res.json(fail('预约不存在'));

    const studentPayload = {
      name: booking.student_name || '',
      phone: booking.parent_phone || '',
      gender: booking.student_gender || '',
      remark: booking.note || '',
      source: 'trial',
    };
    // 关联线索：成交后据此展示「已转成交」，也用于前端判断是否需要再次转化
    const lead = booking.lead_id
      ? db.prepare('SELECT id, name, stage, status, student_id FROM leads WHERE id = ?').get(booking.lead_id)
      : null;

    res.json(success({
      ...booking,
      studentId: booking.student_id || '',
      leadId: booking.lead_id || '',
      studentPayload,
      lead: lead || null,
    }));
  } catch (err) {
    console.error('[trial detail]', err);
    res.status(500).json(safeFail('获取预约详情失败'));
  }
});

/**
 * POST /api/trial/:id/convert — 管理端：体验课成交
 * Body: { studentId }（必填）
 *
 * 学员档案由前端复用 POST /api/students 创建（本端点不重复实现建档逻辑，避免与
 * students.js 的事务化建档/编号重试逻辑分叉），本端点只负责把三处串起来：
 *   预约（trial_bookings）→ 学员（students）→ 线索（leads）
 * 幂等：预约已绑定学员时直接返回既有结果，不重复写。
 */
router.post('/:id/convert', (req, res) => {
  try {
    if (!canConvertTrial(req)) return res.status(403).json(safeFail('仅管理员/销售可办理体验课成交'));
    const { studentId } = req.body || {};
    if (!studentId) return res.json(fail('请先选择或创建学员'));

    const booking = db.prepare('SELECT * FROM trial_bookings WHERE id = ?').get(req.params.id);
    if (!booking) return res.json(fail('体验课预约不存在'));

    // 学员必须在册：已删除/已归档的档案不得挂上成交（复用全站唯一判据，别名为 s）
    const student = db.prepare(`SELECT s.id FROM students s WHERE s.id = ? AND ${ACTIVE_STUDENT_SQL}`).get(studentId);
    if (!student) return res.json(fail('学员不存在或已归档/删除'));

    const t = now();
    const actor = getActor(req);
    const result = db.transaction(() => {
      // 幂等：已绑定过学员 → 返回既有结果，不重复写（也不重复记审计）
      if (booking.student_id) {
        return { studentId: booking.student_id, leadId: booking.lead_id || '', converted: true, alreadyConverted: true };
      }

      // 关联线索：优先用预约记录上的 lead_id；缺失时按手机号兜底匹配活跃线索
      // （apply 阶段的线索创建是 best-effort，失败时不应阻断成交）
      let lead = booking.lead_id
        ? db.prepare('SELECT id, stage, status FROM leads WHERE id = ?').get(booking.lead_id)
        : null;
      if (!lead && booking.parent_phone) {
        lead = db.prepare(
          "SELECT id, stage, status FROM leads WHERE phone = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
        ).get(booking.parent_phone);
      }

      // 回写预约：绑定学员 + 终态。status 取 'converted'（该列现取值 pending/assigned/rejected，
      // 成交是独立于「安排/拒绝」的终态，语义上不与二者混用）。
      db.prepare("UPDATE trial_bookings SET student_id = ?, status = 'converted', updated_at = ? WHERE id = ?")
        .run(studentId, t, booking.id);

      // 回写线索成交：stage 与 status 同时置位（全站统一判据，见 growth.js 的说明）
      if (lead) {
        db.prepare(`
          UPDATE leads SET stage = 'deal', status = 'converted', student_id = ?,
            converted_at = COALESCE(converted_at, ?), updated_at = ?
          WHERE id = ?
        `).run(studentId, t, t, lead.id);
      }

      recordAudit(db, {
        entity: 'trial',
        entityId: booking.id,
        action: 'convert',
        actorId: actor.id,
        actorRole: actor.role,
        before: { status: booking.status, student_id: booking.student_id || '', lead_id: booking.lead_id || '' },
        after: { status: 'converted', studentId, leadId: lead ? lead.id : '' },
      });

      return { studentId, leadId: lead ? lead.id : '', converted: true };
    })();

    res.json(success(result));
  } catch (err) {
    console.error('[trial convert]', err);
    res.status(500).json(safeFail('办理体验课成交失败'));
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
