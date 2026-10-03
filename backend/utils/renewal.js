/**
 * 续费提醒生成器
 * 按「推送规则 → 续期提醒」配置的提前天数（默认 15/7/1 天）扫描有效会员卡，
 * 到期当天所在的提醒档位向绑定家长发送站内通知；按 template_id 幂等去重。
 * @param {object} db better-sqlite3 实例
 * @returns {{ created: number, reminderDays: number[], message: string }}
 */
function generateRenewalNotifications(db) {
  const { generateId, now } = require('./index');
  // 规则读取、文案渲染，以及「天数口径 / 去重键」都与自动路径（utils/reminders.js）
  // 共用同一实现，保证「设置页关掉的开关」「改过的文案」「同卡同档位的去重」在两条路径上口径完全一致。
  // 天数与去重键若不共用，两条路径会各算各的天数、各拼各的键，等于没有去重（家长收到重复提醒）。
  const { getNotificationRule, resolveRuleTemplate, renderNotificationTemplate, defaultRule, resolveRenewalDaysLeft, renewalDedupKey, hasRenewalNotification } = require('./reminders');
  const { getTerms } = require('./terms');
  // 「有效学员」单一事实来源：与报表侧（dashboard/growth/orders）同一判据
  const { ACTIVE_STUDENT_SQL } = require('./student-state');

  const rule = getNotificationRule('续期提醒');
  const dft = defaultRule('续期提醒');
  // 默认档位回退到 EXPIRY_WINDOWS（到期口径单一来源），而不是再写一遍 [15,7,1]
  let reminderDays = ((dft && dft.reminderDays) || EXPIRY_WINDOWS).slice();
  if (rule && Array.isArray(rule.reminderDays) && rule.reminderDays.length) {
    const parsed = rule.reminderDays
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => b - a);
    // 过滤后为空说明配置畸形（如全为 0/负数）→ 回退默认档位
    if (parsed.length) reminderDays = parsed;
  }
  const template = resolveRuleTemplate(rule, '续期提醒');
  // 规则缺失（getNotificationRule 返回 null）时按默认启用处理，不因读不到配置就不发提醒
  const enabled = !(rule && rule.enabled === false);

  if (!enabled || !reminderDays.length) {
    return { created: 0, reminderDays, message: '续期提醒规则未启用' };
  }

  const t = now();
  const DAY = 86400000;
  // 上界取 (maxDays + 1) 天：与自动路径同一扫描窗口，容纳最大档位的 +1 天窗口
  const maxDays = Math.max(...reminderDays);
  // JOIN students 并套用 ACTIVE_STUDENT_SQL：与报表侧（dashboard/growth/orders）统一「有效学员」口径。
  // 原先不 JOIN，靠「归档时已删 parent_bindings」的巧合才没向已退费家庭推送；家长一旦重新绑定，
  // 续费提醒就会发到已退费家庭 → 运营外呼无效返工。
  const cards = db.prepare(`
    SELECT mc.id, mc.student_id, mc.student_name, mc.card_type_name, mc.expires_at
    FROM member_cards mc
    JOIN students s ON s.id = mc.student_id
    WHERE mc.status = 'active' AND mc.expires_at > ?
      AND mc.expires_at <= ? + ?
      AND ${ACTIVE_STUDENT_SQL}
  `).all(t, t, (maxDays + 1) * DAY);

  let created = 0;
  const { terms } = getTerms(db);
  for (const card of cards) {
    // 天数口径与去重键均取自自动路径（utils/reminders.js）的共用实现：
    // resolveRenewalDaysLeft 返回「命中的档位值」（±1 天窗口内），
    // 因此同一张卡、同一个档位在两条路径上必然命中同一个键，否则等于没有去重。
    const daysLeft = resolveRenewalDaysLeft(card.expires_at, t, reminderDays);
    if (daysLeft === null) continue;
    const templateId = renewalDedupKey(card.id, daysLeft);
    // hasRenewalNotification 内部同时兼容历史键 renewal_mc_<cardId>_<daysLeft>，
    // 避免升级前已发过的提醒在同一档位内被再发一次。
    if (hasRenewalNotification(db, card.id, daysLeft)) continue;

    // 收件人取「该学员的全部有效家长」（不再只发 is_main=1 的主家长）：
    // 双家长家庭（爸爸 is_main=1 / 妈妈 is_main=0）里非主家长同样需要共同知情；
    // 若历史数据 is_main 全为 0，只认主家长会导致一个通知都发不出去。
    const parents = db.prepare(`
      SELECT DISTINCT pb.parent_openid, pb.parent_name
      FROM parent_bindings pb
      WHERE pb.student_id = ? AND pb.parent_openid != ''
    `).all(card.student_id);
    if (!parents.length) {
      // 无任何绑定家长 = 该学员的提醒「无法送达」。不静默丢弃，留痕便于运营补绑家长。
      console.warn(`[renewal] 无法送达续费提醒：学员 ${card.student_id}(${card.student_name || '未知'}) 无有效家长绑定`);
      continue;
    }

    // 与自动路径同一套占位符：{{studentName}}/{{cardType}}/{{days}} + 机构称呼占位符
    const content = renderNotificationTemplate(template, {
      studentName: card.student_name || '孩子',
      cardType: card.card_type_name || '会员卡',
      days: String(daysLeft),
    }, terms);
    const ins = db.prepare(`
      INSERT INTO notifications (id, user_id, student_id, template_id, title, content, summary, priority, category, channel, status, is_broadcast, sent_at, created_at)
      VALUES (?, ?, ?, ?, '会员即将到期提醒', ?, ?, 'important', 'system', 'inapp', 'sent', 0, ?, ?)
    `);
    for (const p of parents) {
      ins.run(generateId('NTF_RENEWAL_'), p.parent_openid, card.student_id, templateId, content,
        (content || '').slice(0, 60), t, t);
      created++;
    }
  }

  return { created, reminderDays, message: created ? `已发送 ${created} 条续费提醒` : '本次无新的续费提醒需发送' };
}

// ---------------------------------------------------------------------------
// 续费 / 课时预警的统一口径常量
//
// 改动前这些阈值在三处各自写死且互不一致：
//   - routes/growth.js  GET /growth/renewal      warnIn = 15
//   - routes/growth.js  GET /growth/low-classes  threshold = 5
//   - routes/followups.js 续费跟进生成           15 / 7 / 1 天
// 结果是「续费预警清单」和「跟进任务队列」对同一批会员卡给出不同的判断口径，
// 老师在同一天会看到两套互相矛盾的数字。此处收口为单一来源，三处统一引用。
//
// ⚠️ 到期口径仍未收口的三处（不属本文件职责，改动需对应负责人处理）：
//   - routes/admin.js     看板「7 天内到期」    窗口 7 天
//   - routes/growth.js    GET /growth/renewal   窗口 15 天，且状态含 paused/expired
//   - routes/membership.js GET /expiring        窗口默认 30 天
//   三处的窗口与状态过滤都应改为引用下方 EXPIRY_WINDOWS / EXPIRING_STATUSES /
//   buildExpiringWhere()，否则「预警清单列出、提醒却从不发出」的分歧会再次出现。
// ---------------------------------------------------------------------------

/**
 * 到期提醒档位：到期前多少天各发一次。到期口径的单一来源，
 * 与推送规则「续期提醒」的默认 reminderDays 同值（见 reminders.js DEFAULT_NOTIFICATION_RULES）。
 */
const EXPIRY_WINDOWS = [15, 7, 1];
/**
 * 计入「即将到期」的会员卡状态 —— 只认 active。
 * 为什么排除 paused：请假暂停的卡其 expires_at 停留在暂停前的日期，纳入会让「已暂停、未到期」
 * 的卡被当成即将到期反复预警（growth 预警列出、提醒却从不发出，正是口径分裂的表现）。
 * 为什么排除 expired：已过期属「到期未续费」的另一条口径（EXPIRED_WINDOW_DAYS），不应混入「即将到期」。
 */
const EXPIRING_STATUSES = ['active'];
/** 续费预警窗口：到期前多少天开始进入清单（= 最大提醒档位，保证清单与提醒扫描同宽） */
const RENEWAL_WARN_DAYS = Math.max(...EXPIRY_WINDOWS);
/** 低课时阈值：次数卡剩余课时不超过多少节进入清单 */
const LOW_CLASS_THRESHOLD = 5;
/**
 * 过期回溯窗口：已过期多少天内的卡仍算「待续费」。
 * 只设上界不设下界会让多年前的历史死卡永久占据清单，反而淹掉真正要催的人。
 */
const EXPIRED_WINDOW_DAYS = 60;

/**
 * 构造「即将到期」的会员卡状态过滤片段（供预警清单 / 跟进任务 / 报表统一引用）。
 * 前提：member_cards 别名为 mc。状态取值来自 EXPIRING_STATUSES 常量（非用户输入），
 * 直接内联为 SQL 字面量，避免各调用点自行绑定参数顺序。
 * @returns {string} 形如 `mc.status IN ('active')`
 */
function buildExpiringWhere() {
  return `mc.status IN (${EXPIRING_STATUSES.map((s) => `'${s}'`).join(', ')})`;
}

module.exports = {
  generateRenewalNotifications,
  EXPIRY_WINDOWS,
  EXPIRING_STATUSES,
  buildExpiringWhere,
  RENEWAL_WARN_DAYS,
  LOW_CLASS_THRESHOLD,
  EXPIRED_WINDOW_DAYS,
};
