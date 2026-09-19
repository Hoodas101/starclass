/**
 * 提醒定时任务核心逻辑（纯函数，便于自动化测试）
 * 训练开始前提醒 / 续费提醒 / 低课时提醒 的生成逻辑
 */
const crypto = require('crypto');
const db = require('../db');
const { now } = require('./index');
const { getTerms, applyTerms } = require('./terms');

// ---------------------------------------------------------------------------
// 「推送规则」的读取与文案渲染 —— 自动路径（本文件）与手动路径（utils/renewal.js）
// 共用这一份实现，避免同一条提醒在两处各写一套开关/文案口径。
// ---------------------------------------------------------------------------

/**
 * 推送规则规范默认值 —— 单一真相源。
 * 设置页展示的默认值（routes/settings.js 直接引用本常量）与定时任务的兜底文案
 * 都取自这里，避免出现「页面显示一套、实际发送另一套」的配置欺骗。
 */
const DEFAULT_NOTIFICATION_RULES = [
  {
    name: '训练提醒',
    type: '微信通知',
    enabled: true,
    trigger: '活动开始前',
    advanceTime: 2,
    template: '您的孩子{{studentName}}今天有{{courseName}}活动，训练时间{{time}}，请准时到课。',
  },
  {
    name: '续期提醒',
    type: '微信通知',
    enabled: true,
    trigger: '到期前15/7/1天',
    advanceTime: 0,
    reminderDays: [15, 7, 1],
    template: '您的孩子{{studentName}}的会员卡即将到期，请及时续期。',
  },
  {
    name: '缺席通知',
    type: '微信通知',
    enabled: true,
    trigger: '成员未签到',
    advanceTime: 1,
    template: '您的孩子{{studentName}}今天{{courseName}}活动未到场，请确认情况。',
  },
];

/**
 * 取指定名称的默认规则（规则名不存在时返回 undefined）。
 * @param {string} name
 * @returns {object|undefined}
 */
function defaultRule(name) {
  return DEFAULT_NOTIFICATION_RULES.find((r) => r.name === name);
}

/**
 * 读取「推送规则」（settings.notification_rules）中指定名称的规则。
 * 键不存在 / JSON 畸形 / 非数组 / 规则不存在时一律返回 null，
 * 由调用方回退默认行为（照常发送 + 使用默认文案），
 * 绝不因配置读不到而静默停发，也不因配置畸形而抛错。
 * @param {string} name 规则名，如「续期提醒」
 * @returns {object|null}
 */
function getNotificationRule(name) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'notification_rules'").get();
    if (!row || !row.value) return null;
    const rules = JSON.parse(row.value);
    if (!Array.isArray(rules)) return null;
    const hit = rules.find((r) => r && r.name === name);
    return hit && typeof hit === 'object' ? hit : null;
  } catch (e) {
    return null;
  }
}

/**
 * 从规则对象上取文案：规则缺失或 template 为空/非法时，回退该规则的默认文案。
 * @param {object|null} rule
 * @param {string} name 规则名（用于取默认文案）
 * @returns {string}
 */
function resolveRuleTemplate(rule, name) {
  if (rule && typeof rule.template === 'string' && rule.template.trim()) return rule.template;
  const dft = defaultRule(name);
  return (dft && dft.template) || '';
}

/**
 * 渲染提醒文案：先替换业务占位符（{{studentName}} / {{courseName}} / {{days}}…），
 * 再把剩余的概念占位符（{{learner}} / {{course}} / {{org}}…）替换为机构称呼方案。
 * 模板为空或非字符串时返回空串，由调用方决定是否回退默认文案。
 * @param {string} template
 * @param {object} vars 业务占位符取值表
 * @param {object} terms 机构术语表（getTerms().terms）
 * @returns {string}
 */
function renderNotificationTemplate(template, vars, terms) {
  if (typeof template !== 'string' || !template.trim()) return '';
  const filled = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => {
    if (vars && Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null) {
      return String(vars[key]);
    }
    return m;
  });
  return terms ? applyTerms(filled, terms) : filled;
}

/**
 * 训练开始前提醒：向已报名该活动的家长发送站内通知（幂等：同一排期+时间只发一次）
 * @param {number} nowMs - 当前时间戳（毫秒），便于测试控制
 * @returns {{ sent: number, scanned: number }}
 */
function generateClassReminders(nowMs = Date.now()) {
  const rule = getNotificationRule('训练提醒');
  // 开关关闭 → 本次不发送（与「续期提醒」保持同一语义：设置页关掉的开关必须真的生效）
  if (rule && rule.enabled === false) return { sent: 0, scanned: 0 };

  // 读取推送规则中的训练提醒提前时间（小时，默认 2）
  let advanceHours = 2;
  if (rule && Number(rule.advanceTime) >= 0) advanceHours = Number(rule.advanceTime);
  // 文案取自「训练提醒」规则的 template，规则缺失时回退默认文案
  const template = resolveRuleTemplate(rule, '训练提醒');

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

    // 已报名该活动的家长（按家长聚合，同一家长只出一行，并汇总其报名的学员姓名）
    const parents = db.prepare(`
      SELECT pb.parent_openid, GROUP_CONCAT(DISTINCT e.student_name) AS student_names
      FROM enrollments e
      JOIN parent_bindings pb ON pb.student_id = e.student_id
      WHERE e.schedule_id = ? AND e.status = 'active' AND pb.parent_openid != ''
      GROUP BY pb.parent_openid
    `).all(s.id);

    if (!parents.length) continue;

    const title = applyTerms('{{course}}即将开始', terms);
    for (const p of parents) {
      // 文案来自「训练提醒」规则的 template（设置页可改），
      // 可用占位符：{{studentName}}/{{courseName}}/{{time}}/{{classroom}}/{{teacherName}}
      // 以及 {{learner}}/{{course}}/{{instructor}}/{{checkin}} 等机构称呼占位符
      const content = renderNotificationTemplate(template, {
        studentName: p.student_names || '',
        courseName: s.course_name || '',
        time: `${s.date} ${s.start_time}`,
        classroom: s.classroom_name || '待定',
        teacherName: s.teacher_name || '待定',
      }, terms);
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
  // 低课时提醒的阈值 lowClassThreshold 取自「续期提醒」规则（设置页上唯一的相关开关），
  // 因此规则被禁用时同步停发 —— 否则关掉「续期提醒」后家长仍会每日收到续费类提醒。
  const rule = getNotificationRule('续期提醒');
  if (rule && rule.enabled === false) return { sent: 0 };

  let threshold = 3;
  if (rule && parseInt(rule.lowClassThreshold, 10) > 0) {
    threshold = parseInt(rule.lowClassThreshold, 10);
  }

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
  const rule = getNotificationRule('续期提醒');
  // 开关关闭 → 不发送。原先此处只读 reminderDays，导致设置页关掉「续期提醒」后每日仍照发。
  if (rule && rule.enabled === false) return { sent: 0 };

  let reminderDays = (defaultRule('续期提醒').reminderDays || [15, 7, 1]).slice();
  if (rule && Array.isArray(rule.reminderDays) && rule.reminderDays.length) {
    const parsed = rule.reminderDays
      .map((d) => parseInt(d, 10))
      .filter((d) => d > 0 && d <= 90)
      .sort((a, b) => b - a);
    // 过滤后为空说明配置畸形（如全为 0/负数）→ 回退默认档位，而不是静默不发
    if (parsed.length) reminderDays = parsed;
  }
  // 文案与手动路径（utils/renewal.js）取自同一份规则 template，避免同一条提醒两种说法
  const template = resolveRuleTemplate(rule, '续期提醒');

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
      // 文案来自「续期提醒」规则的 template（设置页可改），
      // 可用占位符：{{studentName}}/{{cardType}}/{{days}}/{{expireDate}}
      // 以及 {{learner}}/{{course}}/{{org}} 等机构称呼占位符
      const content = renderNotificationTemplate(template, {
        studentName: card.student_name || '孩子',
        cardType: card.card_type_name || '会员卡',
        days: String(days),
        expireDate,
      }, terms);
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
  // 推送规则的读取与渲染：供 routes/settings.js（默认值展示）与 utils/renewal.js（手动发送路径）共用
  DEFAULT_NOTIFICATION_RULES,
  defaultRule,
  getNotificationRule,
  resolveRuleTemplate,
  renderNotificationTemplate,
  now,
};
