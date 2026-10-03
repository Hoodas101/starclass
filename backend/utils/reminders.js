/**
 * 提醒定时任务核心逻辑（纯函数，便于自动化测试）
 * 训练开始前提醒 / 续费提醒 / 低课时提醒 的生成逻辑
 */
const crypto = require('crypto');
const db = require('../db');
const { now } = require('./index');
const { getTerms, applyTerms } = require('./terms');
// 「有效学员」单一事实来源：通知侧与报表侧（dashboard/growth/orders）统一口径
const { ACTIVE_STUDENT_SQL } = require('./student-state');

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
 * 取某学员的全部有效家长 openid（去重、去空）。
 *
 * 为什么不再只取 is_main=1：双家长家庭（爸爸 is_main=1 / 妈妈 is_main=0）里非主家长同样需要
 * 共同知情（接送、请假、续费决策），只发主家长会让另一方永远收不到任何通知；
 * 若历史数据 is_main 全为 0，则一条通知都发不出去。故收件人改为「该学员的全部有效家长」。
 * DISTINCT 同时兜住历史脏数据：同一 openid 出现多行也只发一次。
 * @param {string} studentId
 * @returns {string[]} 去重后的家长 openid 列表
 */
function listParentOpenids(studentId) {
  return db.prepare(
    "SELECT DISTINCT parent_openid FROM parent_bindings WHERE student_id = ? AND parent_openid IS NOT NULL AND parent_openid != ''"
  ).all(studentId).map((r) => r.parent_openid);
}

/**
 * 通知 ID 的收件人后缀。
 * 直接截断明文会把长微信 openid（wx + 28 位）切掉，同一提醒下多个家长 ID 前缀相同 →
 * 主键冲突，只建得出第一条。用 openid 哈希后缀规避。
 * @param {string} openid
 * @returns {string}
 */
function recipientIdSuffix(openid) {
  return crypto.createHash('sha1').update(openid).digest('hex').slice(0, 12);
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
  // JOIN students 并套用 ACTIVE_STUDENT_SQL：通知侧与报表侧统一「有效学员」口径，
  // 避免向已归档/已退费家庭推送「课时即将用尽，请续费」。
  const cards = db.prepare(`
    SELECT mc.*
    FROM member_cards mc
    JOIN students s ON s.id = mc.student_id
    WHERE mc.status = 'active' AND mc.remaining_classes <= ? AND mc.remaining_classes > 0
      AND mc.expires_at IS NOT NULL AND mc.expires_at > ?
      AND ${ACTIVE_STUDENT_SQL}
  `).all(threshold, nowMs);

  let sent = 0;
  const { terms } = getTerms(db);
  for (const card of cards) {
    const weekKey = Math.floor(nowMs / weekMs);
    // 幂等闸门：同一张卡同一周只生成一批（按 template_id 去重）。
    // 收件人变多不破坏幂等——template_id 与收件人无关，多行共享同一 template_id，
    // 后续扫描命中任意一行即视为本周已发。
    const key = `low_class_${card.id}_${weekKey}`;
    const exists = db.prepare('SELECT 1 FROM notifications WHERE template_id = ?').get(key);
    if (exists) continue;

    // 收件人 = 该学员的全部有效家长（去重、去空），不再只发主家长
    const recipients = listParentOpenids(card.student_id);
    if (!recipients.length) {
      // 无法送达：留痕便于运营补绑家长，不静默丢弃
      console.warn(`[reminders] 无法送达低课时提醒：学员 ${card.student_id}(${card.student_name || '未知'}) 无有效家长绑定`);
      continue;
    }

    // 文案跟随机构称呼方案
    const content = applyTerms(
      `您的{{learner}}${card.student_name}的「${card.card_type_name}」剩余课时仅 ${card.remaining_classes} 节，即将用尽。为避免影响{{course}}安排，请及时联系{{org}}续费。`,
      terms
    );
    const title = applyTerms('课时不足提醒', terms);
    const ins = db.prepare(`
      INSERT INTO notifications (id, user_id, title, content, priority, category, summary, template_id, channel, status, is_broadcast, sent_at, created_at)
      VALUES (?, ?, ?, ?, 'warning', 'system', ?, ?, 'inapp', 'sent', 0, ?, ?)
    `);
    for (const openid of recipients) {
      // 每位家长一行、ID 带 openid 哈希后缀，避免同一 key 下主键冲突只建出第一条
      ins.run(
        `NTF_${key}_${recipientIdSuffix(openid)}`.toUpperCase().slice(0, 64),
        openid,
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

// ---------------------------------------------------------------------------
// 续费提醒的「天数口径」与「去重键」—— 手动路径（utils/renewal.js）与自动路径
// （本文件的 generateRenewalReminders）必须共用这一份实现，否则等于没有去重：
//
//   两个入口是两条互相独立的实现，各自算天数、各自拼去重键：
//     · 手动路径（设置页「立即发送续费提醒」/ 跟进生成）用 ceil 差值，
//       键为 renewal_mc_<cardId>_<daysLeft>；
//     · 自动路径（每日定时任务 / 队列 worker）用 ±1 天窗口，
//       键为 renewal_<cardId>_<days>。
//   前缀不同 → 两条路径写的去重记录互不认账；天数口径不同 → 键里的数字还可能对不上。
//   结果：同一张卡、同一个档位，机构管理员手动点一次、定时任务再跑一次，
//   同一位家长就会收到两条一模一样的提醒。
//   因此这里把天数计算与去重键收口为单一来源，两条路径只允许引用本处函数。
// ---------------------------------------------------------------------------

/**
 * 计算会员卡命中的续费提醒档位（两条续费提醒路径共用的唯一天数口径）。
 *
 * 判定：遍历配置档位，若到期时间落在 [now + (days-1) 天, now + (days+1) 天]
 * 之内即算命中该档位（约 2 天宽的窗口）。
 * 返回值：档位值本身（reminderDays 里的数，如 7），而不是算出来的剩余天数。
 *   这一点很关键——返回值只取决于配置档位，不随运行时刻漂移，
 *   因此两条路径对同一张卡同一档位必然得到同一个键 renewal_<cardId>_7。
 *
 * 为什么保留 ±1 天窗口：定时任务漏跑一天（服务未启动 / 机器关机 / 进程挂掉）时，
 * 1 天宽的精确匹配会让该档位被永久跳过，续费提醒再也发不出去；漏发比重复发严重得多。
 * 窗口放宽到 2 天即可容错，同时因为返回值是稳定的档位值，不会反过来破坏去重。
 * @param {number} expiresAt 会员卡到期时间戳（毫秒）
 * @param {number} nowMs 当前时间戳（毫秒）
 * @param {number[]} reminderDays 配置的提醒档位，如 [15, 7, 1]
 * @returns {number|null} 命中的档位值；未命中（已过期或不在任何档位窗口内）返回 null
 */
function resolveRenewalDaysLeft(expiresAt, nowMs, reminderDays) {
  if (!Array.isArray(reminderDays) || !reminderDays.length) return null;
  // 已过期（含到期时刻）不再提醒
  if (expiresAt <= nowMs) return null;
  const dayMs = 86400000;
  for (const days of reminderDays) {
    if (expiresAt >= nowMs + (days - 1) * dayMs && expiresAt <= nowMs + (days + 1) * dayMs) {
      return days;
    }
  }
  return null;
}

/**
 * 续费提醒去重键 —— 两条路径共用的唯一格式：renewal_<cardId>_<档位值>。
 * 保留 renewal_ 前缀（自动路径原有格式，routes/messages.js 也按该前缀挂续费动作）。
 * 档位值来自 resolveRenewalDaysLeft 的返回值，稳定不漂移。
 * @param {string} cardId
 * @param {number} daysLeft 命中的档位值（来自 resolveRenewalDaysLeft）
 * @returns {string}
 */
function renewalDedupKey(cardId, daysLeft) {
  return `renewal_${cardId}_${daysLeft}`;
}

/**
 * 判断某张卡的某个续费档位是否已发过提醒（两条路径共用）。
 * 除新键外，同时兼容历史键 renewal_mc_<cardId>_<daysLeft>：升级前手动路径
 * 写入的旧记录若不再被识别，同一档位内会被再发一次。这是最小代价的兼容做法，
 * 不迁移历史数据、不改表，仅多查一个键；此后只写新键。
 * @param {object} database better-sqlite3 实例（两条路径各自持有的 db）
 * @param {string} cardId
 * @param {number} daysLeft
 * @returns {boolean}
 */
function hasRenewalNotification(database, cardId, daysLeft) {
  return !!database.prepare(
    'SELECT 1 FROM notifications WHERE template_id IN (?, ?) LIMIT 1'
  ).get(renewalDedupKey(cardId, daysLeft), `renewal_mc_${cardId}_${daysLeft}`);
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

  // 与手动路径（utils/renewal.js）同一扫描窗口：一次性取出落在最大档位 +1 天内的卡，
  // 再用共用函数 resolveRenewalDaysLeft 按 ±1 天窗口判定命中档位。
  // 上界取 (maxDays + 1) 天是为了容纳最大档位的 +1 天窗口，否则最大档位会漏掉窗口右半侧。
  // 原实现按档位逐个窗口查询、且键里用的是档位值，手动路径却用计算天数，两者对不上，是重复推送的根因之一。
  const maxDays = Math.max(...reminderDays);
  // JOIN students 并套用 ACTIVE_STUDENT_SQL：通知侧与报表侧统一「有效学员」口径，
  // 避免向已归档/已退费家庭推送续费提醒（否则运营外呼无效返工）。
  const cards = db.prepare(`
    SELECT mc.*
    FROM member_cards mc
    JOIN students s ON s.id = mc.student_id
    WHERE mc.status = 'active' AND mc.expires_at > ? AND mc.expires_at <= ?
      AND ${ACTIVE_STUDENT_SQL}
  `).all(nowMs, nowMs + (maxDays + 1) * dayMs);

  const { terms } = getTerms(db);
  let sent = 0;
  for (const card of cards) {
    // 天数口径与去重键都走共用实现，保证与手动路径完全一致
    const daysLeft = resolveRenewalDaysLeft(card.expires_at, nowMs, reminderDays);
    if (daysLeft === null) continue;
    // 幂等闸门：同一张卡同一档位只发一批（template_id 去重，与收件人无关）。
    // 多收件人共享同一 template_id，故不会因收件人变多而重复生成提醒。
    if (hasRenewalNotification(db, card.id, daysLeft)) continue;

    // 收件人 = 该学员的全部有效家长（去重、去空），不再只发主家长
    const recipients = listParentOpenids(card.student_id);
    if (!recipients.length) {
      // 无法送达：留痕便于运营补绑家长，不静默丢弃
      console.warn(`[reminders] 无法送达续费提醒：学员 ${card.student_id}(${card.student_name || '未知'}) 无有效家长绑定`);
      continue;
    }

    const key = renewalDedupKey(card.id, daysLeft);
    const expireDate = fmtDate(card.expires_at);
    // 文案来自「续期提醒」规则的 template（设置页可改），
    // 可用占位符：{{studentName}}/{{cardType}}/{{days}}/{{expireDate}}
    // 以及 {{learner}}/{{course}}/{{org}} 等机构称呼占位符
    const content = renderNotificationTemplate(template, {
      studentName: card.student_name || '孩子',
      cardType: card.card_type_name || '会员卡',
      days: String(daysLeft),
      expireDate,
    }, terms);
    const title = applyTerms('会员即将到期提醒', terms);
    const ins = db.prepare(`
      INSERT INTO notifications (id, user_id, title, content, priority, category, summary, template_id, channel, status, is_broadcast, sent_at, created_at)
      VALUES (?, ?, ?, ?, 'normal', 'system', ?, ?, 'inapp', 'sent', 0, ?, ?)
    `);
    for (const openid of recipients) {
      // 每位家长一行、ID 带 openid 哈希后缀，避免同一 key 下主键冲突只建出第一条
      ins.run(
        `NTF_${key}_${recipientIdSuffix(openid)}`.toUpperCase().slice(0, 64),
        openid,
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
  // 续费提醒的天数口径与去重键：供 utils/renewal.js（手动发送路径）共用，两条路径必须同源
  resolveRenewalDaysLeft,
  renewalDedupKey,
  hasRenewalNotification,
  now,
  // 收件人解析与通知 ID 后缀：多家长通知的唯一实现。
  // routes/checkin.js 的缺席通知必须与本文件同口径 —— 三处通知若各写一套收件人逻辑，
  // 口径日久必然漂移（一处改了、另两处没改），故一律从这里取。
  listParentOpenids,
  recipientIdSuffix,
};
