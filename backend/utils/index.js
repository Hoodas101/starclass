/**
 * 工具函数库
 * 提供 ID 生成、统一响应格式、openid 提取等通用功能
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// === 密钥配置 ===
// 绝不使用硬编码默认密钥（历史版本回退到公开值，任何拿到 MIT 源码的人都能
// 伪造管理员 token）。未显式配置 JWT_SECRET 时：首次启动生成密码学随机密钥
// 并持久化到 data.db 同目录（随数据卷备份、跨重启稳定），此后一直复用。
// 多实例横向扩展部署仍应显式设置 JWT_SECRET 环境变量，让各实例共享同一密钥。
//
// E11 修订：密钥持久化位置必须**跟随数据库位置（DB_PATH）**。原先写死在
// backend/db/.jwt-secret，而 DB_PATH 可指向 /data/data.db 等挂载卷；一旦容器/数据卷
// 迁移，密钥留在旧目录、新库无密钥 → 全员登录态丢失。现改为与 db/index.js 的
// DB_PATH 解析保持一致：默认 backend/db/.jwt-secret（无变化），设置 DB_PATH 时落到其同目录。
const SECRET_DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '../db/data.db');
const SECRET_FILE = path.join(path.dirname(SECRET_DB_PATH), '.jwt-secret');
function resolveJwtSecret() {
  const env = process.env.JWT_SECRET;
  if (env) return env;
  try {
    const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch (e) { /* 文件不存在，下面生成 */ }
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_FILE, fresh, { mode: 0o600 });
    console.log(`[安全] 未设置 JWT_SECRET，已生成随机密钥并持久化到 ${SECRET_FILE}（请随数据库一起备份）`);
  } catch (e) {
    // 文件系统只读等异常场景：退化为进程内存密钥（重启后所有登录态失效，但不伪造风险）
    console.warn('[安全] 无法持久化 JWT_SECRET（文件系统限制），本次使用内存密钥，重启后所有登录态将失效');
  }
  return fresh;
}
const JWT_SECRET = resolveJwtSecret();
const TOKEN_EXPIRY = '7d'; // 7 天（jsonwebtoken 标准格式）
const BCRYPT_ROUNDS = 10;  // bcrypt 计算轮数（10 ≈ ~100ms，安全与性能的平衡点）

/**
 * 生成唯一 ID（前缀 + 时间戳36进制 + 加密安全随机数）
 * @param {string} prefix - ID 前缀
 * @returns {string} 大写的唯一 ID
 */
function generateId(prefix = '') {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}${ts}${rand}`.toUpperCase();
}

// === 密码哈希：bcrypt（替代旧版 SHA-256）===

/**
 * 密码哈希（bcrypt，带随机盐）
 * @param {string} password - 明文密码
 * @returns {string} bcrypt 哈希字符串（含盐与轮数）
 */
function hashPassword(password = '') {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

/**
 * 验证密码（支持 bcrypt 新格式与 SHA-256 旧格式自动迁移）
 * @param {string} password - 用户输入的明文密码
 * @param {string} storedHash - 数据库中存储的哈希值
 * @returns {{ valid: boolean, needsUpgrade: boolean }}
 *   - valid: 密码是否匹配
 *   - needsUpgrade: 旧版 SHA-256 哈希，需在登录成功后升级为 bcrypt
 */
function verifyPassword(password = '', storedHash = '') {
  // bcrypt 哈希以 $2a$ / $2b$ 开头
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
    return { valid: bcrypt.compareSync(password, storedHash), needsUpgrade: false };
  }
  // 旧版 SHA-256 + 固定盐（64 位 hex）
  const legacyHash = crypto.createHash('sha256').update(`edu-admin:${password}`).digest('hex');
  return { valid: legacyHash === storedHash, needsUpgrade: true };
}

/**
 * 生成 JWT Token（使用 jsonwebtoken 标准库）
 * @param {object} payload - 载荷数据
 * @returns {string} token 字符串
 */
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

/**
 * 验证 JWT Token（使用 jsonwebtoken 标准库）
 * @param {string} token - token 字符串
 * @returns {object|null} 解码后的 payload，验证失败返回 null
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * 统一成功响应
 * @param {*} data - 返回数据
 * @returns {{code: number, data: *, message: string}}
 */
function success(data) {
  return { code: 0, data, message: 'ok' };
}

/**
 * 统一失败响应
 * @param {string} message - 错误信息
 * @param {number} code - 错误码（默认 1）
 * @returns {{code: number, data: null, message: string}}
 */
function fail(message, code = 1) {
  return { code, data: null, message };
}

/**
 * 从请求中提取 openid（唯一可信来源：中间件从 JWT 解析后写入的 req.openid，
 * 或请求头中后端签发的 JWT；绝不信任任何客户端可控的 x-openid / ?openid= / body.openid）
 * @param {import('express').Request} req
 * @returns {string}
 */
function getOpenId(req) {
  // 1. 优先使用认证中间件已从 JWT 解析并写入的 req.openid
  if (req && req.openid) return req.openid;
  // 2. 兜底：直接从 Authorization Bearer 解析 JWT（防御性，不依赖中间件副作用）
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload && payload.openid) return payload.openid;
  }
  // 3. 任何客户端可控的 openid（x-openid header / query / body）一律不再信任
  return '';
}

/**
 * 判断当前请求是否为管理员（兼容 JWT 与 x-openid 开发模式）
 * @param {object} req
 * @returns {boolean}
 */
function isAdminReq(req) {
  if (req.userRole === 'admin') return true;
  const openid = getOpenId(req);
  if (openid) {
    try {
      const db = require('../db');
      const u = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
      return !!(u && u.role === 'admin');
    } catch (e) {
      return false;
    }
  }
  return false;
}

/**
 * 判断当前请求是否为管理端工作人员（管理员或教练）
 * Web 端仅管理员与教练可进入；教练拥有签到、请假审批、课表/成员查看等权限
 * @param {object} req
 * @returns {boolean}
 */
function isStaffReq(req) {
  // 管理端工作人员：管理员 / 教练 / 销售（销售登录后可查看其授权范围内的看板与数据）
  if (req.userRole === 'admin' || req.userRole === 'coach' || req.userRole === 'sales') return true;
  const openid = getOpenId(req);
  if (openid) {
    try {
      const db = require('../db');
      const u = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
      return !!(u && (u.role === 'admin' || u.role === 'coach' || u.role === 'sales'));
    } catch (e) {
      return false;
    }
  }
  return false;
}

/**
 * 判断当前请求是否为教练级工作人员（仅管理员或教练）
 * 用于签到、请假审批、课表/补课安排、点评等仅限教练/管理员操作的场景。
 * 销售（sales）不具备这些教练操作权限，避免越权代教练签到 / 批假 / 改课表。
 * @param {object} req
 * @returns {boolean}
 */
function isCoachReq(req) {
  if (req.userRole === 'admin' || req.userRole === 'coach') return true;
  const openid = getOpenId(req);
  if (openid) {
    try {
      const db = require('../db');
      const u = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
      return !!(u && (u.role === 'admin' || u.role === 'coach'));
    } catch (e) {
      return false;
    }
  }
  return false;
}

// === 员工权限模型：管理者 / 销售 / 教练 可自定义权限范围 ===
// 默认权限必须与前端「按角色可见」的标签页保持一致（web-admin 的 hubs/*.vue 的 roles 字段），
// 否则会出现「标签页按角色可见、接口却因缺少权限键而 403」的自相矛盾。
// coachstats（教练课时）此前遗漏：课时标签页对 coach 角色可见，但默认权限里没有该键。
const DEFAULT_PERMS = {
  admin: ['*'],
  coach: ['students', 'schedule', 'checkin', 'leave', 'coachstats'],
  sales: ['dashboard', 'sales', 'students', 'growth'],
};

/** 解析用户最终权限（自定义权限优先，否则按角色默认） */
function resolvePerms(user) {
  if (!user) return [];
  if (user.role === 'admin') return ['*'];
  if (user.permissions && typeof user.permissions === 'string' && user.permissions.trim()) {
    try {
      const arr = JSON.parse(user.permissions);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) { /* 解析失败走默认 */ }
  }
  return DEFAULT_PERMS[user.role] || [];
}

/** 判断用户是否拥有某权限（'*' 表示全部权限） */
function hasPerm(user, perm) {
  const perms = resolvePerms(user);
  return perms.includes('*') || perms.includes(perm);
}

/** 从请求获取当前用户记录 */
function getReqUser(req) {
  const openid = getOpenId(req);
  if (!openid) return null;
  try {
    const db = require('../db');
    return db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
  } catch (e) {
    return null;
  }
}

/**
 * 成员数据访问校验（防越权）
 * 允许：管理员 / 教练（管理端工作场景）/ 绑定该成员的家长
 * 用于带 studentId 参数的查询接口，家长仅能访问自己绑定的成员数据
 * @param {object} req - 请求对象
 * @param {string} studentId - 成员 ID
 * @returns {boolean}
 */
function canViewStudentData(req, studentId) {
  if (!studentId) return false;
  const openid = getOpenId(req);
  if (!openid) return false;
  try {
    const db = require('../db');
    const u = db.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
    // 管理端工作人员（管理员/教练）可查看成员数据
    if (u && (u.role === 'admin' || u.role === 'coach')) return true;
    // 家长：仅限已绑定的成员
    const bind = db.prepare(
      'SELECT 1 FROM parent_bindings WHERE parent_openid = ? AND student_id = ?'
    ).get(openid, studentId);
    return !!bind;
  } catch (e) {
    return false;
  }
}

/**
 * 转义 LIKE 查询中的通配符
 * @param {string} str - 原始字符串
 * @returns {string} 转义后的字符串
 */
function escapeLike(str) {
  return str.replace(/[%_]/g, (m) => `\\${m}`);
}

/**
 * 安全错误响应（不暴露内部细节）
 * @param {string} message - 用户可见的错误消息
 * @param {number} code - HTTP 状态码
 * @returns {{code: number, data: null, message: string}}
 */
function safeFail(message, code = 1) {
  return { code, data: null, message };
}

/**
 * 获取当前时间戳（毫秒）
 * @returns {number}
 */
function now() {
  return Date.now();
}

/**
 * 格式化日期为 YYYY-MM-DD
 * @param {number} timestamp - 毫秒时间戳
 * @returns {string}
 */
function formatDate(timestamp) {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 会员卡到期时间计算
 * 次数卡有效天数为 0（不限有效期）时返回远期哨兵值（2100-01-01），
 * 避免“激活即过期”导致次数卡在扣课查询中永远匹配不到。
 * 时效卡有效天数为 0 时保持激活即到期（无有效期的时效卡无意义）。
 */
function calcCardExpiresAt(activatedAt, validDays, billingMode) {
  if (validDays && validDays > 0) return activatedAt + validDays * 86400000;
  if (billingMode === 'count') return 4102444800000; // 2100-01-01，按次数消耗
  return activatedAt;
}

/**
 * 获取本周某天的日期（0=周日，1=周一...6=周六）
 * @param {number} weekDay - 星期几
 * @returns {string} YYYY-MM-DD
 */
function getWeekDayDate(weekDay) {
  const today = new Date();
  const currentDay = today.getDay(); // 0=周日
  const diff = weekDay - currentDay;
  const target = new Date(today);
  target.setDate(today.getDate() + diff);
  return formatDate(target.getTime());
}

/**
 * 分页参数解析
 * @param {object} query - 请求 query
 * @returns {{page: number, pageSize: number, offset: number}}
 */
function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  // 上限 500：周视图排期等场景需一次取回全部数据（列表页分页不受影响）
  const pageSize = Math.min(500, Math.max(1, parseInt(query.pageSize) || 10));
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

/**
 * 从请求解析操作者身份（openid + 角色），供审计留痕使用。
 * 优先用认证中间件写入的 req.userRole；缺失时按 openid 回查用户表角色。
 * 小程序家长端若无 openid 则记为 system。
 * @param {import('express').Request} req
 * @returns {{id: string, role: string}}
 */
function getActor(req) {
  const openid = getOpenId(req);
  let role = (req && req.userRole) || '';
  if (!role && openid) {
    try {
      const database = require('../db');
      const u = database.prepare('SELECT role FROM users WHERE openid = ?').get(openid);
      role = u ? u.role : 'parent';
    } catch (e) {
      role = '';
    }
  }
  if (!role) role = openid ? 'parent' : 'system';
  return { id: openid, role };
}

// 审计写入工具（轻量、失败不影响主流程）
const { recordAudit } = require('./audit');

/**
 * 到场率 —— 全站唯一实现（看板 / 趋势图 / 课时汇总 / 成员统计共用）。
 *
 * 口径定义：到场率 = (present + late) / (present + late + absent) × 100
 *   - late（迟到）计入「已到场」：人到场了，不应拉低到场率
 *   - leave（已批准的请假）不进分母：获批缺勤不属于「应到未到」
 *
 * 背景：此前该指标存在 4 份互不相同的实现（看板只算 present 作分子、
 * 趋势图把 leave 算进分母、课时汇总把 leave 算进分母、成员统计用 present/total），
 * 同一机构同一天会看到多个到场率。如需调整口径，改这一处即可全站生效。
 *
 * @param {{present?:number, late?:number, absent?:number}} counts 出勤状态计数
 * @returns {number} 0-100 的整数百分比；无有效样本时返回 0
 */
function attendanceRate({ present = 0, late = 0, absent = 0 } = {}) {
  const attended = (present || 0) + (late || 0);
  const expected = attended + (absent || 0);
  return expected > 0 ? Math.round((attended / expected) * 100) : 0;
}

module.exports = {
  JWT_SECRET,
  generateId,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  success,
  fail,
  safeFail,
  getOpenId,
  getActor,
  recordAudit,
  isAdminReq,
  isStaffReq,
  isCoachReq,
  canViewStudentData,
  DEFAULT_PERMS,
  resolvePerms,
  hasPerm,
  getReqUser,
  escapeLike,
  now,
  formatDate,
  calcCardExpiresAt,
  getWeekDayDate,
  parsePagination,
  attendanceRate,
};
