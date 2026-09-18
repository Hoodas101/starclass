/**
 * 星课 StarClass 后端 — Node.js + Express + SQLite
 * 私有化部署，本地运行
 */
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const { verifyToken } = require('./utils');
const { generateClassReminders, generateLowClassReminders, generateRenewalReminders } = require('./utils/reminders');
const { expireOverdueCards } = require('./utils/card-lifecycle');
const { startScheduledBackup } = require('./utils/backup');
const queue = require('./utils/queue');
const worker = require('./utils/worker');
const { batchSendFromNotifications, isSubscriptionEnabled } = require('./utils/subscribe-msg');
const db = require('./db');

// students.height / weight / bmi 补列已收编至 migrations/014
// （此前 3 处 try{ALTER}catch 在 require('./db') 之后执行，与迁移账本重复）

// 路由
const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/students');
const scheduleRoutes = require('./routes/schedules');
const classRoutes = require('./routes/classes');
const checkinRoutes = require('./routes/checkin');
const membershipRoutes = require('./routes/membership');
const pointsRoutes = require('./routes/points');
const orderRoutes = require('./routes/orders');
const messageRoutes = require('./routes/messages');
const adminRoutes = require('./routes/admin');
const settingsRoutes = require('./routes/settings');
const leaveRoutes = require('./routes/leave');
const feedbackRoutes = require('./routes/feedback');
const growthRoutes = require('./routes/growth');
const followupRoutes = require('./routes/followups');
const payrollRoutes = require('./routes/payroll');
const commentRoutes = require('./routes/comments');
const makeupRoutes = require('./routes/makeup');
const financeRoutes = require('./routes/finance');
const attendanceRoutes = require('./routes/attendances');
const trialRoutes = require('./routes/trial');
const wxpayRoutes = require('./routes/wxpay');

const app = express();
const PORT = process.env.PORT || 3001;

// Reverse-proxy support: behind nginx/Caddy, req.ip is always 127.0.0.1 which
// breaks per-IP rate limiting. TRUST_PROXY sets the number of trusted hops
// (usually 1); unset means no proxy headers are trusted.
//
// 仅接受正整数跳数。0 / 负数 / 非数字（`TRUST_PROXY=0` 想显式关闭、或写成 `yes`）
// 一律按「不信任任何代理头」处理 —— 与未设置同义，并打印告警。
// 刻意**不**回退到 `true`（信任全部代理）：那会让 X-Forwarded-For 可被任意伪造，
// 攻击者每请求换一个伪造 IP 即可绕过全局限流，同时污染审计日志的 IP 维度。
if (process.env.TRUST_PROXY) {
  const hops = parseInt(process.env.TRUST_PROXY, 10);
  if (Number.isInteger(hops) && hops > 0) {
    app.set('trust proxy', hops);
  } else {
    console.warn(
      `[trust proxy] TRUST_PROXY="${process.env.TRUST_PROXY}" 不是正整数跳数，` +
      '已按「不信任代理头」处理（req.ip 将取直连地址）。若确实位于反向代理之后，请设为 1。'
    );
  }
}

// CORS（限制来源）— 必须放在限流与认证之前，确保预检请求带正确响应头
// 生产环境通过 CORS_ORIGINS 环境变量配置允许的来源（逗号分隔），如：
//   export CORS_ORIGINS=https://admin.example.com,https://www.example.com
const prodOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const devOrigins = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'];
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? prodOrigins
  : devOrigins;

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-openid'],
}));

// === 全局速率限制 ===
const rateLimitMap = new Map();
const RATE_WINDOW = 60 * 1000; // 1 分钟
const RATE_MAX = parseInt(process.env.RATE_MAX) || 600; // per IP per minute; tunable via env
app.use((req, res, next) => {
  // 预检请求不参与限流
  if (req.method === 'OPTIONS') return next();
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_WINDOW;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_MAX) {
    return res.status(429).json({ code: 429, data: null, message: '请求过于频繁，请稍后重试' });
  }
  next();
});

// 1mb body limit for normal requests; data-import endpoint allows 100mb.
const jsonParser = bodyParser.json({ limit: '1mb' });
app.use((req, res, next) => {
  // import endpoint skips the global parser; handled by the big parser below
  if (req.path === '/api/settings/import') return next();
  jsonParser(req, res, next);
});
app.use('/api/settings/import', bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// === JWT 认证中间件（排除公开路由）===
const PUBLIC_PATHS = ['/api/auth/login', '/api/auth/wx-login', '/api/auth/phone-login', '/api/health', '/api/trial/apply', '/api/wxpay/notify', '/api/terms'];
app.use((req, res, next) => {
  // Express 路由默认大小写不敏感：'/API/schedules/pay' 仍会解析到
  // '/api/schedules/pay' 处理器。鉴权守卫必须用同样的口径，否则大写路径会
  // 跳过鉴权却仍命中受保护路由（P0-1：URL 大小写绕过鉴权）。
  const p = req.path.toLowerCase();
  // 仅保护 API 路由，静态资源与 SPA 页面直接放行
  if (!p.startsWith('/api')) return next();
  // 精确匹配公开路径：用 startsWith 会令 "/api/auth/loginX" 等非预期路径也公开，
  // 一旦未来新增以公开前缀开头的私密路由即被误暴露。下列均为已注册的精确端点。
  if (PUBLIC_PATHS.includes(p)) return next();
  // GET /api/settings is public: org branding (site name / logo / terms) is
  // needed by the login page. Writes still require auth.
  if (req.method === 'GET' && p === '/api/settings') return next();

  // Verify JWT — the only trusted identity source. Client-supplied
  // x-openid / ?openid= / body.openid are never trusted.
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload && payload.openid) {
      // token_version revocation: bump on disable / password change / role change
      // to invalidate old tokens immediately. A missing user row is treated the
      // same as a revoked token. DB read errors fail open (never mass-log everyone out).
      try {
        const u = db.prepare('SELECT token_version, status FROM users WHERE openid = ?').get(payload.openid);
        if (!u) {
          return res.status(401).json({ code: 401, data: null, message: '登录状态已失效，请重新登录' });
        }
        // 仅对显式非 active 的账号拒绝（历史行可能无 status 值）
        if (u.status && u.status !== 'active') {
          return res.status(401).json({ code: 401, data: null, message: '账号已停用，请联系管理员' });
        }
        if ((u.token_version || 0) !== (payload.tv || 0)) {
          return res.status(401).json({ code: 401, data: null, message: '登录状态已失效，请重新登录' });
        }
      } catch (e) {
        console.error('[auth token_version]', e.message);
      }
      req.openid = payload.openid;
      req.userRole = payload.role;
      return next();
    }
  }

  return res.status(401).json({ code: 401, data: null, message: '未登录或登录已过期' });
});

// 登录接口限流：默认 100 次/15 分钟/IP（可用 LOGIN_RATE_LIMIT 环境变量调整）
const loginAttempts = new Map();
const LOGIN_RATE_LIMIT = parseInt(process.env.LOGIN_RATE_LIMIT) || 100;
const LOGIN_RATE_WINDOW = 15 * 60 * 1000;
app.use('/api/auth/login', (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || [];
  const recent = attempts.filter(t => now - t < LOGIN_RATE_WINDOW);
  if (recent.length >= LOGIN_RATE_LIMIT) {
    return res.status(429).json({ code: 429, data: null, message: '登录尝试过于频繁，请15分钟后再试' });
  }
  recent.push(now);
  loginAttempts.set(ip, recent);
  next();
});

// 静态文件（管理端构建产物）
app.use(express.static(path.join(__dirname, '../web-admin/dist')));
// 上传文件（头像等）
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// SPA 路由回退：管理端 history 模式刷新 / 直达子页面时不 404
// 加 i 标志，与上面鉴权守卫及 Express 默认的大小写不敏感路由保持一致。
app.get(/^\/(?!api\/|assets\/|favicon\.ico).*/i, (req, res) => {
  res.sendFile(path.join(__dirname, '../web-admin/dist/index.html'));
});

// Health check with DB probe: report 503 when the process is alive but the
// database is unusable, so Docker/pm2 don't route traffic to a dead DB.
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ code: 0, data: { status: 'ok', time: Date.now() }, message: '服务运行正常' });
  } catch (e) {
    console.error('[health] DB 探测失败:', e.message);
    res.status(503).json({ code: 503, data: { status: 'db_error', time: Date.now() }, message: '数据库不可用' });
  }
});

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/checkin', checkinRoutes);
app.use('/api/membership', membershipRoutes);
app.use('/api/points', pointsRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/notifications', messageRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes.router);
app.use('/api/leave', leaveRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/growth', growthRoutes);
app.use('/api/followups', followupRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/makeup', makeupRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/attendances', attendanceRoutes);
app.use('/api/trial', trialRoutes);
app.use('/api/wxpay', wxpayRoutes);

// 顶层公开端点：机构称呼方案（小程序端 GET /api/terms，无需登录）
app.get('/api/terms', settingsRoutes.termsHandler);

// 显式 /api 404：所有已注册的 /api/* 路由都未匹配时，返回结构化 404（不影响已注册接口，也不影响 SPA 回退）
app.use('/api', (req, res) => {
  res.status(404).json({ code: 404, data: null, message: '接口不存在' });
});

// 统一错误处理（不暴露内部细节）
// 框架层 4xx 必须原样透出：body-parser 的非法 JSON（400）、超限（413）、
// 不支持的编码（415）都是**客户端**错误，此前一律被压成 500，导致
//   (a) 客户端格式错误被计入服务端故障，掩盖真实故障；
//   (b) 前端只显示「服务器开小差了」，排查方向被误导。
// 本应用路由从不调用 next(err)，到达此处的错误均来自框架中间件，故 err.status 可信。
const CLIENT_ERR_MSG = {
  400: '请求格式有误，请检查后重试',
  413: '请求内容过大，请缩减后重试',
  415: '不支持的请求编码格式',
};
app.use((err, req, res, next) => {
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 400 && status < 500) {
    console.warn('[Client Error]', status, err.type || err.message);
    return res.status(status).json({ code: status, data: null, message: CLIENT_ERR_MSG[status] || '请求有误，请检查后重试' });
  }
  console.error('[Server Error]', err);
  res.status(500).json({ code: 500, data: null, message: '服务器开小差了，请稍后重试' });
});

// 启动
const server = app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║  星课 StarClass 后端服务已启动                     ║
  ║  🚀 http://localhost:${PORT}                    ║
  ║  📋 API 文档: http://localhost:${PORT}/api/health ║
  ╚═══════════════════════════════════════════════╝
  `);
});

// 端口占用等 server 级错误兜底：避免 EADDRINUSE 等直接使进程崩溃
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[Fatal] 端口 ${PORT} 已被占用，请先停止占用该端口的进程后再启动。`);
  } else {
    console.error('[Fatal] 服务启动失败:', err);
  }
});

// Process-level error fallback:
// - tests (NODE_ENV=test): log only, keep the process alive for require()-based suites;
// - production: an uncaught exception leaves the process in an unknown state, so
//   log and exit — pm2 / docker restart will bring up a clean instance.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  if (process.env.NODE_ENV !== 'test') {
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 500).unref();
  }
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// 限流 Map 周期性清理：避免 rateLimitMap / loginAttempts 长期运行无限增长导致内存泄漏
const MAP_CLEANUP_INTERVAL = 5 * 60 * 1000; // 每 5 分钟
setInterval(() => {
  try {
    const nowMs = Date.now();
    // 清理已过期的限流窗口
    for (const [ip, entry] of rateLimitMap) {
      if (!entry || nowMs > entry.resetAt) rateLimitMap.delete(ip);
    }
    // 清理过期的登录尝试记录
    for (const [ip, attempts] of loginAttempts) {
      const recent = (attempts || []).filter((t) => nowMs - t < LOGIN_RATE_WINDOW);
      if (recent.length === 0) loginAttempts.delete(ip);
      else loginAttempts.set(ip, recent);
    }
    // 清理过期的体验课预约频控记录（trial.js 内部 Map，无自清理）
    if (typeof trialRoutes.cleanupTrialPhoneLimits === 'function') {
      trialRoutes.cleanupTrialPhoneLimits();
    }
  } catch (e) {
    console.error('[MapCleanup] 清理失败:', e.message);
  }
}, MAP_CLEANUP_INTERVAL);

// ============================================
// 续费提醒定时任务
// 每日 09:00 检查即将到期（15/7/1 天）的会员卡，向绑定家长推送站内通知
// ============================================
function formatDateMs(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function runRenewalReminders() {
  try {
    // 定期收缩 WAL（防止长时间运行后 WAL 过大导致读快照异常）
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* 忽略 */ }
    const result = generateRenewalReminders(Date.now());
    console.log(`[Reminder] 续费提醒检查完成（发送 ${result.sent} 条）`);
  } catch (err) {
    console.error('[Reminder] 续费提醒失败:', err.message);
  }
}

// ============================================
// 提醒任务统一调度（异步任务队列）
// 队列启用（ENABLE_JOB_WORKER=true）时，定时器只负责"投递任务"到 jobs 表，
// 由 worker 统一认领处理（SQLite 租约模式，等价于 SKIP LOCKED，杜绝多实例重复发送）；
// 未启用时降级为内联执行，保持原有行为不变。
// ============================================
function runInlineReminder(type) {
  try {
    if (type === 'renewal_reminder') runRenewalReminders();
    else if (type === 'low_class_reminder') runLowClassReminders();
    else if (type === 'class_reminder') runClassReminders();
  } catch (e) { console.error(`[Reminder:${type}] 失败:`, e.message); }
}

function scheduleReminder(type, initialDelayMs, intervalMs) {
  const fire = () => {
    try {
      if (process.env.ENABLE_JOB_WORKER === 'true') {
        queue.enqueue(db, { type, dueAt: Date.now() });
      } else {
        runInlineReminder(type);
      }
    } catch (e) { console.error(`[Reminder:${type}] 触发失败:`, e.message); }
  };
  setTimeout(fire, initialDelayMs);
  setInterval(fire, intervalMs);
}

// ============================================
// 会员卡过期状态流转
// status 的语义是「该卡当前是否有效」，但此前只有 leave.js 一处会写 'expired'，
// 已过期的卡长期停留在 'active'，使只按 status 过滤的查询（学员会员状态、
// 低课时提醒、取消订单回收卡、线索续费建议）把过期卡当作有效卡。
// 启动时先跑一次，保证首次提醒看到的 status 即为真值；此后每日一次。
// 该流转是幂等 UPDATE（第二次 WHERE 已无匹配行），不经任务队列也不会重复处理，
// 多实例并存同样安全。
// ============================================
function runCardExpirySweep() {
  try {
    const { expired } = expireOverdueCards(Date.now());
    if (expired > 0) console.log(`[CardExpiry] ${expired} 张会员卡已置为过期`);
  } catch (err) {
    console.error('[CardExpiry] 过期流转失败:', err.message);
  }
}
runCardExpirySweep();
setInterval(runCardExpirySweep, 24 * 3600 * 1000);

scheduleReminder('renewal_reminder', 30 * 1000, 24 * 3600 * 1000);
scheduleReminder('low_class_reminder', 45 * 1000, 24 * 3600 * 1000);
scheduleReminder('class_reminder', 10 * 1000, 30 * 60 * 1000);

// 启动异步任务队列 worker（默认关闭，需 ENABLE_JOB_WORKER=true 启用；启用后提醒走队列）
if (process.env.ENABLE_JOB_WORKER === 'true') {
  try {
    worker.startWorker(db, { intervalMs: 5000, batchSize: 5, leaseMs: 60000, backoffMs: 60000 });
    console.log('[worker] 异步任务队列已启动');
  } catch (e) {
    console.error('[worker] 启动失败（提醒将走内联降级）:', e.message);
  }
}

// ============================================
// 低课时预警定时任务
// 每日检查剩余课时 ≤ 阈值（默认 3）的会员卡，提醒家长续费
// ============================================
function runLowClassReminders() {
  try {
    const result = generateLowClassReminders(Date.now());
    console.log(`[Reminder] 低课时提醒检查完成（发送 ${result.sent} 条）`);
  } catch (err) {
    console.error('[Reminder] 低课时提醒失败:', err.message);
  }
}

// 低课时提醒已统一由 scheduleReminder('low_class_reminder') 调度（见上方）

// ============================================
// 训练开始前提醒定时任务
// 每 30 分钟扫描一次：在活动开始前 N 小时（推送规则可配），
// 向已报名该活动的绑定家长发送站内通知
// ============================================
function runClassReminders() {
  try {
    const result = generateClassReminders(Date.now());
    console.log(`[Reminder] 训练提醒检查完成（发送 ${result.sent} 条）`);
  } catch (err) {
    console.error('[Reminder] 训练提醒失败:', err.message);
  }
}

// 训练提醒已统一由 scheduleReminder('class_reminder') 调度（见上方）

// ============================================
// 每日 23:30 自动标记缺席
// 将已结束活动且未签到的登记成员标记为缺席
// ============================================
function runAutoAbsentDaily() {
  try {
    const result = checkinRoutes.runAutoAbsent();
    console.log(`[AutoAbsent] ${result.date} 标记缺席 ${result.markedCount} 人`);
  } catch (err) {
    console.error('[AutoAbsent] 失败:', err.message);
  }
}

function scheduleAutoAbsent() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(23, 30, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    runAutoAbsentDaily();
    scheduleAutoAbsent();
  }, next.getTime() - now.getTime());
}

scheduleAutoAbsent();

// ============================================
// 自动定时数据库备份
// 默认每天凌晨 2:00 执行，保留最近 30 份备份
// 可在系统设置中配置频率与保留数量
// ============================================
startScheduledBackup();

// ============================================
// 微信订阅消息定时推送
// 每 10 分钟扫描一次站内信，向已授权的微信用户推送订阅消息
// 需配置 WX_APPID / WX_SECRET 并在小程序端引导用户授权
// ============================================
function runSubscribeMsgPush() {
  if (!isSubscriptionEnabled()) return;
  batchSendFromNotifications()
    .then(result => {
      if (result.sent > 0) {
        console.log(`[SubscribeMsg] 推送完成：发送 ${result.sent}/${result.total} 条`);
      }
    })
    .catch(err => console.error('[SubscribeMsg] 推送失败:', err.message));
}

setTimeout(runSubscribeMsgPush, 60 * 1000);
setInterval(runSubscribeMsgPush, 10 * 60 * 1000);

module.exports = app;
