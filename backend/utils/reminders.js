/**
 * 提醒定时任务核心逻辑（纯函数，便于自动化测试）
 * 训练开始前提醒 / 续费提醒 / 低课时提醒 的生成逻辑
 */
const crypto = require('crypto');
const db = require('../db');
const { now } = require('./index');
const { getTerms, applyTerms } = require('./terms');

/**
 * 训练开始前提醒：向已报名该活动的家长发送站内通知（幂等：同一排期+时间只发一次）
 * @param {number} nowMs - 当前时间戳（毫秒），便于测试控制
 * @returns {{ sent: number, scanned: number }}
 */
function generateClassReminders(nowMs = Date.now()) {
  // 读取推送规则中的训练提醒提前时间（小时，默认 2）
  let advanceHours = 2;
  try {
    const ruleRow = db.prepare("SELECT value FROM settings WHERE key = 'notification_rules'").get();
    if (ruleRow && ruleRow.value) {
      const rules = JSON.parse(ruleRow.value);
      const trainRule = (Array.isArray(rules) ? rules : []).find((r) => r.name === '训练提醒');
      if (trainRule && Number(trainRule.advanceTime) >= 0) {
        advanceHours = Number(trainRule.advanceTime);
      }
    }
  } catch (e) { /* 配置缺失时使用默认值 */ }

  const windowEndMs = nowMs + advanceHours * 3600000;
  const iso = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
  };

  // 兼容 start_time 可能带秒的情况：统一截取 HH:MM
  const schedules = db.prepare(`
    SELECT * FROM schedules
    WHERE status = 'scheduled'
      AND (date || 'T' || substr(start_time, 1, 5) || ':00') >= ?
      AND (date || 'T' || substr(start_time, 1, 5) || ':00') <= ?
  `).all(iso(nowMs), iso(windowEndMs));

  let sent = 0;
  const { terms } = getTerms(db);
  for (const s of schedules) {
    const key = `class_${s.id}_${s.date}_${s.start_time}`;
    const exists = db.prepare('SELECT 1 FROM notifications WHERE template_id = ?').get(key);
    if (exists) continue;

    // 已报名该活动的家长
    const parents = db.prepare(`
      SELECT DISTINCT pb.parent_openid, pb.parent_name
      FROM enrollments e
      JOIN parent_bindings pb ON pb.student_id = e.student_id
      WHERE e.schedule_id = ? AND e.status = 'active' AND pb.parent_openid != ''
    `).all(s.id);

    if (!parents.length) continue;

    // 文案跟随机构称呼方案（教练/学员/课程/签到 → 老师/会员/训练/打卡 等）
    const content = applyTerms(
      `您的{{learner}}已报名「${s.course_name || '{{course}}'}」，开始时间 ${s.date} ${s.start_time}，场地：${s.classroom_name || '待定'}，{{instructor}}：${s.teacher_name || '待定'}。请提前到场{{checkin}}。`,
      terms
    );
    const title = applyTerms('{{course}}即将开始', terms);
    for (const p of parents) {
      // 通知 ID 用 openid 哈希后缀：直接截断明文会把长微信 openid（wx + 28 位）切掉，
      // 同活动下多个家长 ID 前缀相同 → 主键冲突，只建出第一条提醒
      const idSuffix = crypto.createHash('sha1').update(p.parent_openid).digest('hex').slice(0, 12);
      db.prepare(`
        INSERT INTO notifications (id, user_id, title, content, priority, category, summary, template_id, channel, status, is_broadcast, sent_at, created_at)
        VALUES (?, ?, ?, ?, 'normal', 'schedule', ?, ?, 'inapp', 'sent', 0, ?, ?)
      `).run(
        `NTF_${key}_${idSuffix}`.toUpperCase().slice(0, 64),
        p.parent_openid,
        title,
        content,
        content.slice(0, 60),
        key,
        nowMs,
        nowMs
      );
      sent++;
    }
  }
  return { sent, scanned: schedules.length };
}

/**
 * 低课时预警：剩余课时 ≤ 阈值的次数卡会员提醒续费（幂等：每周一次）
 * @param {number} nowMs - 当前时间戳（毫秒）
 * @returns {{ sent: number }}
 */
function generateLowClassReminders(nowMs = Date.now()) {
  let threshold = 3;
  try {
    const ruleRow = db.prepare("SELECT value FROM settings WHERE key = 'notification_rules'").get();
    if (ruleRow && ruleRow.value) {
      const rules = JSON.parse(ruleRow.value);
      const renewRule = (Array.isArray(rules) ? rules : []).find((r) => r.name === '续期提醒');
      if (renewRule && parseInt(renewRule.lowClassThreshold, 10) > 0) {
        threshold = parseInt(renewRule.lowClassThreshold, 10);
      }
    }
  } catch (e) { /* 使用默认值 */ }

  const weekMs = 7 * 86400000;
  // expires_at > now：已过期的卡不该再收到「课时即将用尽，请续费」。
  // 过期卡的续费诉求由「已到期」提醒承担，两者混发会让家长收到自相矛盾的通知。
  // 本条件不依赖 expireOverdueCards 的调度时机（每日一次，存在最长 24h 的物化延迟），
  // 故在此独立成立。
  const cards = db.prepare(`
    SELECT mc.*, pb.parent_openid
    FROM member_cards mc
    LEFT JOIN parent_bindings pb ON pb.student_id = mc.student_id AND pb.is_main = 1
    WHERE mc.status = 'active' AND mc.remaining_classes <= ? AND mc.remaining_classes > 0
      AND mc.expires_at IS NOT NULL AND mc.expires_at > ?
  `).all(threshold, nowMs);

  let sent = 0;
  const { terms } = getTerms(db);
  for (const card of cards) {
    if (!card.parent_openid) continue;
    const weekKey = Math.floor(nowMs / weekMs);
    const key = `low_class_${card.id}_${weekKey}`;
    const exists = db.prepare('SELECT 1 FROM notifications WHERE template_id = ?').get(key);
    if (exists) continue;

    // 文案跟随机构称呼方案
    const content = applyTerms(
      `您的{{learner}}${card.student_name}的「${card.card_type_name}」剩余课时仅 ${card.remaining_classes} 节，即将用尽。为避免影响{{course}}安排，请及时联系{{org}}续费。`,
      terms
    );
    const title = applyTerms('课时不足提醒', terms);
    db.prepare(`
      INSERT INTO notifications (id, user_id, title, content, priority, category, summary, template_id, channel, status, is_broadcast, sent_at, created_at)
      VALUES (?, ?, ?, ?, 'warning', 'system', ?, ?, 'inapp', 'sent', 0, ?, ?)
    `).run(
      `NTF_${key}`.toUpperCase(),
      card.parent_openid,
      title,
      content,
      content.slice(0, 60),
      key,
      nowMs,
      nowMs
    );
    sent++;
  }
  return { sent };
}

/**
 * 续费提醒：扫描即将到期（按推送规则配置的提前天数，默认 15/7/1 天）的会员卡，
 * 向绑定家长发送站内通知（幂等：同一卡同一提醒档位只发一次，template_id 去重）。
 * 抽离为纯函数，供 server.js 内联降级与 utils/worker 队列处理器共用（单一真相源）。
 * @param {number} nowMs
 * @returns {{ sent: number }}
 */
function generateRenewalReminders(nowMs = Date.now()) {
  const dayMs = 86400000;
  let reminderDays = [15, 7, 1];
  try {
    const ruleRow = db.prepare("SELECT value FROM settings WHERE key = 'notification_rules'").get();
    if (ruleRow && ruleRow.value) {
      const rules = JSON.parse(ruleRow.value);
      const renewRule = (Array.isArray(rules) ? rules : []).find((r) => r.name === '续期提醒');
      if (renewRule && Array.isArray(renewRule.reminderDays) && renewRule.reminderDays.length) {
        reminderDays = renewRule.reminderDays
          .map((d) => parseInt(d, 10))
          .filter((d) => d > 0 && d <= 90)
          .sort((a, b) => b - a);
      }
    }
  } catch (e) { /* 配置缺失时使用默认值 */ }

  const fmtDate = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const { terms } = getTerms(db);
  let sent = 0;
  for (const days of reminderDays) {
    const start = nowMs + (days - 1) * dayMs;
    const end = nowMs + (days + 1) * dayMs;
    const cards = db.prepare(`
      SELECT mc.*, pb.parent_openid
      FROM member_cards mc
      LEFT JOIN parent_bindings pb ON pb.student_id = mc.student_id AND pb.is_main = 1
      WHERE mc.status = 'active' AND mc.expires_at >= ? AND mc.expires_at <= ?
    `).all(start, end);

    for (const card of cards) {
      const key = `renewal_${card.id}_${days}`;
      const exists = db.prepare('SELECT 1 FROM notifications WHERE template_id = ?').get(key);
      if (exists || !card.parent_openid) continue;

      const expireDate = fmtDate(card.expires_at);
      const content = applyTerms(
        `您的{{learner}}${card.student_name}的「${card.card_type_name}」将于 ${expireDate} 到期，剩余 ${days} 天。为避免影响{{course}}安排，请及时续期。`,
        terms
      );
      const title = applyTerms('会员即将到期提醒', terms);
      db.prepare(`
        INSERT INTO notifications (id, user_id, title, content, priority, category, summary, template_id, channel, status, is_broadcast, sent_at, created_at)
        VALUES (?, ?, ?, ?, 'normal', 'system', ?, ?, 'inapp', 'sent', 0, ?, ?)
      `).run(
        `NTF_${key}`.toUpperCase(),
        card.parent_openid,
        title,
        content,
        content.slice(0, 60),
        key,
        nowMs,
        nowMs
      );
      sent++;
    }
  }
  return { sent };
}

module.exports = {
  generateClassReminders,
  generateLowClassReminders,
  generateRenewalReminders,
  now,
};
