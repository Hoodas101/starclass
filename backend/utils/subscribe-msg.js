/**
 * 微信小程序订阅消息推送模块
 *
 * 依赖环境变量：
 *   WX_APPID   — 小程序 AppID
 *   WX_SECRET  — 小程序 Secret
 *
 * 消息模板需在微信公众平台「订阅消息」中配置，将模板 ID 填入下方 TEMPLATES。
 * 推送失败静默记录日志，不影响主流程。
 */

const { now } = require('../utils');
const db = require('../db');

const CONFIG = {
  appid: process.env.WX_APPID || '',
  secret: process.env.WX_SECRET || '',
};

// 订阅消息模板配置（需在微信公众平台配置后填入真实模板 ID）
const TEMPLATES = {
  // 续费提醒：学员姓名 + 卡类型 + 到期日期 + 备注
  renewal: { templateId: '', keys: ['thing1', 'thing2', 'date3', 'thing4'] },
  // 上课提醒：学员姓名 + 课程名称 + 上课时间 + 教室
  classReminder: { templateId: '', keys: ['thing1', 'thing2', 'time3', 'thing4'] },
  // 缺席通知：学员姓名 + 课程名称 + 日期 + 备注
  absence: { templateId: '', keys: ['thing1', 'thing2', 'date3', 'thing4'] },
  // 请假审批结果：学员姓名 + 课程名称 + 审批结果 + 备注
  leaveResult: { templateId: '', keys: ['thing1', 'thing2', 'phrase3', 'thing4'] },
  // 低课时预警：学员姓名 + 卡类型 + 剩余课时 + 备注
  lowClass: { templateId: '', keys: ['thing1', 'thing2', 'number3', 'thing4'] },
};

// access_token 缓存
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * 检查订阅消息是否已配置
 */
function isSubscriptionEnabled() {
  return !!(CONFIG.appid && CONFIG.secret);
}

/**
 * 获取微信 access_token（带缓存）
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(CONFIG.appid)}&secret=${encodeURIComponent(CONFIG.secret)}`;
  const resp = await fetch(url);
  const data = await resp.json();

  if (data.access_token) {
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000; // 提前 5 分钟刷新
    return cachedToken;
  }
  throw new Error(`获取 access_token 失败: ${data.errmsg || 'unknown'}`);
}

/**
 * 发送订阅消息
 * @param {string} openid - 接收者的微信 openid（不含 wx_ 前缀）
 * @param {string} templateKey - TEMPLATES 中的 key
 * @param {string[]} values - 模板参数值（按 keys 顺序）
 * @param {string} [page] - 点击跳转的小程序页面路径
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendSubscribeMessage(openid, templateKey, values, page) {
  const template = TEMPLATES[templateKey];
  if (!template || !template.templateId) {
    return { success: false, error: `模板 ${templateKey} 未配置 templateId` };
  }

  if (!isSubscriptionEnabled()) {
    return { success: false, error: '微信订阅消息未配置' };
  }

  try {
    const token = await getAccessToken();
    const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`;

    // 构造模板数据
    const data = {};
    template.keys.forEach((key, i) => {
      data[key] = { value: String(values[i] || '') };
    });

    const body = {
      touser: openid,
      template_id: template.templateId,
      page: page || 'pages/index/index',
      data,
      miniprogram_state: process.env.NODE_ENV === 'production' ? 'formal' : 'developer',
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await resp.json();

    if (result.errcode === 0) {
      return { success: true };
    }
    console.error(`[SubscribeMsg] 发送失败: ${result.errmsg} (code=${result.errcode})`);
    return { success: false, error: result.errmsg };
  } catch (err) {
    console.error('[SubscribeMsg] 发送异常:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 批量发送订阅消息（从 notifications 表中取未推送的记录）
 * 每次最多发送 100 条，避免超时
 */
async function batchSendFromNotifications() {
  if (!isSubscriptionEnabled()) return { sent: 0, skipped: true };

  // 查找已发送站内信但未推送微信消息的通知
  const pending = db.prepare(`
    SELECT n.*, u.openid
    FROM notifications n
    LEFT JOIN users u ON u.openid = n.user_id
    WHERE n.channel = 'inapp'
      AND n.status = 'sent'
      AND n.template_id IS NOT NULL
      AND u.openid LIKE 'wx_%'
      AND n.id NOT IN (SELECT notification_id FROM subscribe_msg_logs WHERE status = 'success')
    LIMIT 100
  `).all();

  let sent = 0;
  for (const n of pending) {
    const wxOpenid = String(n.openid).substring(3); // 去掉 wx_ 前缀

    // 根据通知类别映射模板
    let templateKey = null;
    let values = [];
    if (n.category === 'system' && n.title?.includes('到期')) {
      templateKey = 'renewal';
      values = [n.student_id || '', '', n.title || '', '请及时续期'];
    } else if (n.category === 'attendance') {
      templateKey = 'absence';
      values = [n.student_id || '', '', '', ''];
    } else if (n.category === 'schedule') {
      templateKey = 'classReminder';
      values = [n.student_id || '', '', '', ''];
    }

    if (!templateKey) continue;

    const result = await sendSubscribeMessage(wxOpenid, templateKey, values);
    // 记录推送结果
    try {
      db.prepare(`
        INSERT OR REPLACE INTO subscribe_msg_logs (notification_id, openid, template_key, status, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(n.id, n.openid, templateKey, result.success ? 'success' : 'fail', result.error || '', now());
    } catch (e) { /* 日志表可能不存在，忽略 */ }

    if (result.success) sent++;
  }

  return { sent, total: pending.length };
}

// subscribe_msg_logs 建表已收编至 migrations/014

module.exports = {
  isSubscriptionEnabled,
  sendSubscribeMessage,
  batchSendFromNotifications,
  TEMPLATES,
};
