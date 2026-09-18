/**
 * 认证路由 — 登录、用户信息、家长绑定成员
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const fs = require('fs');
const path = require('path');
const { generateId, generateToken, success, fail, safeFail, getOpenId, escapeLike, now, hashPassword, verifyPassword, resolvePerms, getActor, recordAudit } = require('../utils');

// 微信 access_token 内存缓存（有效期内的 token 复用，避免频繁请求微信接口）
let _wxAccessToken = '';
let _wxAccessTokenExpire = 0;

// alias / permissions 列已收编至 migrations/011

// 家长「手机号免密登录/自助注册」开关：
// - 显式设置 PARENT_PHONE_LOGIN=true/false 时以设置为准；
// - 未设置时：非生产环境默认开（兼容小程序家长端旧路径与冒烟测试），生产环境默认关，
//   防止知道手机号即可免凭证登录任意家长账号（账号接管面）。
// 微信一键登录（带 code）不受此开关影响，仍走 openid 路径。
const PARENT_PHONE_LOGIN = process.env.PARENT_PHONE_LOGIN
  ? process.env.PARENT_PHONE_LOGIN === 'true'
  : process.env.NODE_ENV !== 'production';

// 头像类型与扩展名按文件头（魔数）识别，不依赖客户端声明的 MIME / 扩展名。
function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return '.jpg'; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return '.png'; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif'; // GIF
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return '.webp'; // WEBP
  return null;
}

// 仅删除头像目录内的旧文件，防止 avatar URL 由客户端传入造成路径穿越删除任意文件。
function safeUnlinkAvatar(url) {
  if (!url || typeof url !== 'string') return;
  const rel = url.replace(/^\/+/, '');
  if (!rel.startsWith('uploads/avatars/')) return;
  try { fs.unlinkSync(path.join(__dirname, '..', rel)); } catch (e) { /* 不存在或删除失败：忽略 */ }
}

/**
 * POST /api/auth/upload/avatar — 上传个人头像（base64 → 本地文件）
 * Body: { dataUrl }  返回 { url: '/uploads/avatars/xxx.<ext>' }
 */
router.post('/upload/avatar', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.includes('base64,')) {
      return res.json(fail('图片数据无效'));
    }
    const base64 = dataUrl.split('base64,')[1] || '';
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > 2 * 1024 * 1024) return res.json(fail('图片不能超过 2MB'));
    if (buf.length < 100) return res.json(fail('图片数据为空'));

    const dir = path.join(__dirname, '../uploads/avatars');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join(dir, name), buf);
    res.json(success({ url: '/uploads/avatars/' + name }));
  } catch (err) {
    console.error('[upload avatar]', err);
    res.status(500).json(safeFail('上传失败，请稍后重试'));
  }
});

/**
 * POST /api/auth/login
 * 登录：手机号 + 密码（凭证登录，角色由服务端按手机号权威判定）；
 * 无密码则为家长手机号自助注册（兼容旧路径）。
 */
router.post('/login', (req, res) => {
  try {
    const { nickname = '家长', avatarUrl = '', gender = 'unknown', phone, role, password } = req.body;
    // 凭证登录（带密码）：角色由服务端按手机号权威判定，前端无需选择身份
    const isCredential = !!password;
    const requestedRole = role || 'parent';

    // 身份白名单：避免任意字符串角色写入
    if (!['parent', 'coach', 'admin', 'sales'].includes(requestedRole)) {
      return res.status(400).json(safeFail('无效的登录身份'));
    }

    const roleLabel = { admin: '管理员', coach: '教练', sales: '销售', parent: '家长' }[requestedRole];

    // 凭证登录（手机号 + 密码）：强制「手机号 + 密码」双重验证
    if (isCredential) {
      if (!phone || !/^1\d{10}$/.test(phone)) {
        return res.status(400).json(safeFail('请输入正确的手机号'));
      }
    } else if (requestedRole !== 'parent') {
      // 无密码路径：仅家长可手机号自助注册，仍需手机号
      if (!phone || !/^1\d{10}$/.test(phone)) {
        return res.status(400).json(safeFail(`请输入正确的${roleLabel}手机号`));
      }
    }

    // openid 一律由服务端派生，绝不接受客户端自报：
    // 旧版信任 body.openid，任何人构造 phone_<手机号> 或已知 wx 标识即可免凭证命中他人账号（鉴权绕过）
    let openid = phone ? `phone_${phone}` : generateId('wx_');

    // 查找或创建用户
    let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
    if (!user) {
      // 如果是手机号登录，先检查是否已存在该手机号的用户
      if (phone) {
        user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
      }
    }

    if (!user) {
      // 凭证登录：统一返回"手机号或密码错误"，不区分"账号不存在/未设密码/密码错误"，
      // 否则攻击者可用错误文案差异枚举哪些员工手机号已开通（账号存在性 oracle）
      if (isCredential) {
        return res.status(403).json(safeFail('手机号或密码错误'));
      }
      // 无密码路径：仅家长可自助注册
      if (requestedRole !== 'parent') {
        return res.status(403).json(safeFail('手机号或密码错误'));
      }
      if (!PARENT_PHONE_LOGIN) {
        return res.status(403).json(safeFail('家长免密注册已关闭，请联系管理员开通账号或使用微信登录'));
      }
      // 家长：手机号即注册（保持原有能力）
      const userId = generateId('user_');
      db.prepare(`
        INSERT INTO users (id, openid, phone, nickname, avatar, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(userId, openid, phone || null, nickname, avatarUrl, requestedRole, now(), now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    } else {
      // 已存在用户：登录身份必须与账号角色一致
      // 角色归一化：历史数据 teacher → coach
      if (user.role === 'teacher') {
        db.prepare("UPDATE users SET role = 'coach' WHERE id = ?").run(user.id);
        user.role = 'coach';
      }
      if (user.status !== 'active') {
        return res.status(403).json(safeFail('该账号已被停用，请联系管理员'));
      }
      // 凭证登录：角色由服务端权威判定，不校验客户端声明的角色是否匹配
      if (isCredential) {
        if (!user.password) {
          // 与"密码错误"同文案：不向攻击者泄露该账号是否设置过密码
          return res.status(403).json(safeFail('手机号或密码错误'));
        }
        const pwdResult = verifyPassword(password, user.password);
        if (!pwdResult.valid) {
          return res.status(403).json(safeFail('手机号或密码错误'));
        }
        // 旧版 SHA-256 哈希自动升级为 bcrypt
        if (pwdResult.needsUpgrade) {
          db.prepare('UPDATE users SET password = ?, updated_at = ? WHERE id = ?')
            .run(hashPassword(password), now(), user.id);
          console.log(`[auth] 用户 ${user.id} 密码哈希已自动升级为 bcrypt`);
        }
      } else if (requestedRole !== 'parent' || user.role !== 'parent') {
        // 无密码路径仅用于「家长微信一键登录后补登」。
        // 若不作角色限制：空密码 + 声明与账号相同的角色即可跳过密码校验，
        // 任何人知道管理员/教练手机号都能直接登录其账号（鉴权绕过）。
        return res.status(403).json(safeFail('员工账号请使用密码登录'));
      } else if (!PARENT_PHONE_LOGIN && phone) {
        // 生产默认关闭：手机号免密即可登录家长账号，属账号接管面
        return res.status(403).json(safeFail('家长免密登录已关闭，请输入密码或使用微信登录'));
      }
      // 手机号登录时，仅对历史「手机号身份」账号归一化 openid；
      // 微信身份（wx_ 前缀）保持不变，避免覆盖微信 openid 导致再次微信登录分裂账号
      const targetOpenid = phone ? `phone_${phone}` : openid;
      const isWechatIdentity = String(user.openid || '').startsWith('wx_');
      if (!isWechatIdentity && targetOpenid !== user.openid) {
        db.prepare('UPDATE users SET openid = ?, updated_at = ? WHERE id = ?')
          .run(targetOpenid, now(), user.id);
        user.openid = targetOpenid;
      }
    }

    // 手机号登录时，将历史家长绑定迁移到当前 openid（兼容早期 wx_ 前缀数据）
    if (phone) {
      db.prepare(`
        UPDATE parent_bindings SET parent_openid = ?
        WHERE parent_phone = ? AND parent_openid != ?
      `).run(user.openid, phone, user.openid);
    }

    // 生成 JWT Token（tv = token_version，用于服务端吊销：停用/改密/降级后旧 Token 失效）
    const token = generateToken({ openid: user.openid, userId: user.id, role: user.role, tv: user.token_version || 0 });

    res.json(success({
      openid: user.openid,
      token,
      userId: user.id,
      role: user.role,
      permissions: resolvePerms(user),
      nickname: user.nickname,
      avatar: user.avatar,
      userInfo: {
        phone: user.phone,
        role: user.role,
        permissions: resolvePerms(user),
        nickname: user.nickname,
      }
    }));
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json(safeFail('登录失败，请稍后重试'));
  }
});

/**
 * POST /api/auth/wx-login
 * 微信一键登录：前端 wx.login 获取 code，后端换取 openid
 * 需要环境变量 WX_APPID / WX_SECRET；未配置时回退到手机号登录
 */
router.post('/wx-login', async (req, res) => {
  try {
    const { code, nickname = '微信用户', avatarUrl = '', role = 'parent' } = req.body;
    if (!code) return res.json(fail('缺少微信登录 code'));

    const appid = process.env.WX_APPID;
    const secret = process.env.WX_SECRET;
    if (!appid || !secret) {
      return res.json(fail('后端未配置 WX_APPID/WX_SECRET，请使用手机号登录'));
    }

    let session;
    try {
      const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
      const resp = await fetch(url);
      session = await resp.json();
    } catch (e) {
      console.error('[wx-login exchange]', e.message);
      return res.status(500).json(safeFail('微信登录服务暂不可用，请稍后重试'));
    }

    if (!session || !session.openid) {
      return res.json(fail(session && session.errmsg ? `微信登录失败：${session.errmsg}` : '微信登录失败，请重试'));
    }

    const openid = session.openid;
    let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
    if (!user) {
      // 微信登录：仅允许家长身份自助注册
      if (role !== 'parent') {
        const roleLabel = { admin: '管理员', coach: '教练', sales: '销售' }[role] || role;
        return res.json(fail(`该微信号未开通${roleLabel}身份，请联系管理员在后台配置`));
      }
      const userId = generateId('user_');
      db.prepare(`
        INSERT INTO users (id, openid, phone, nickname, avatar, role, status, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, 'active', ?, ?)
      `).run(userId, openid, nickname, avatarUrl, role, now(), now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    } else {
      if (user.status !== 'active') {
        return res.json(fail('该账号已被停用，请联系管理员'));
      }
      if (user.role !== role) {
        const roleLabel = { admin: '管理员', coach: '教练', sales: '销售', parent: '家长' }[user.role] || user.role;
        return res.json(fail(`该微信号已注册为「${roleLabel}」身份，请选择对应身份登录`));
      }
      db.prepare('UPDATE users SET nickname = COALESCE(?, nickname), avatar = COALESCE(?, avatar), updated_at = ? WHERE id = ?')
        .run(nickname || null, avatarUrl || null, now(), user.id);
      user.nickname = nickname || user.nickname;
      user.avatar = avatarUrl || user.avatar;
    }

    const token = generateToken({ openid: user.openid, userId: user.id, role: user.role, tv: user.token_version || 0 });
    res.json(success({
      openid: user.openid,
      token,
      userId: user.id,
      role: user.role,
      permissions: resolvePerms(user),
      nickname: user.nickname,
      avatar: user.avatar,
      userInfo: {
        phone: user.phone,
        role: user.role,
        permissions: resolvePerms(user),
        nickname: user.nickname,
      },
    }));
  } catch (err) {
    console.error('[wx-login]', err);
    res.status(500).json(safeFail('微信登录失败，请稍后重试'));
  }
});

/**
 * 微信 access_token 内存缓存获取（client_credential 方式）
 * 有效期内复用，避免频繁请求微信接口
 */
async function getWxAccessToken(appid, secret) {
  const nowTs = Date.now();
  if (_wxAccessToken && _wxAccessTokenExpire > nowTs + 5 * 60 * 1000) {
    return _wxAccessToken;
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data || !data.access_token) {
    throw new Error(data && data.errmsg ? String(data.errmsg) : '获取 access_token 失败');
  }
  _wxAccessToken = data.access_token;
  _wxAccessTokenExpire = nowTs + (Number(data.expires_in) || 7200) * 1000;
  return _wxAccessToken;
}

/**
 * POST /api/auth/phone-login
 * 微信手机号快捷登录：前端 getPhoneNumber 获取 code，后端换取真实手机号
 * 成功后复用手机号账号体系（管理员/教练/家长均为手机号身份），匹配已开通账号直接登录
 */
router.post('/phone-login', async (req, res) => {
  try {
    const { code, nickname = '微信用户', avatarUrl = '', gender = 'unknown' } = req.body;
    if (!code) return res.json(fail('缺少微信手机号授权 code'));

    const appid = process.env.WX_APPID;
    const secret = process.env.WX_SECRET;
    if (!appid || !secret) {
      return res.json(fail('后端未配置 WX_APPID/WX_SECRET，请使用手机号登录'));
    }

    // 1) 获取 access_token
    let accessToken;
    try {
      accessToken = await getWxAccessToken(appid, secret);
    } catch (e) {
      console.error('[phone-login token]', e.message);
      return res.status(500).json(safeFail('微信服务暂不可用，请稍后重试'));
    }
    if (!accessToken) {
      return res.json(fail('后端未配置 WX_APPID/WX_SECRET，请使用手机号登录'));
    }

    // 2) 用 code 换取真实手机号
    let phoneResp;
    try {
      const r = await fetch(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      phoneResp = await r.json();
    } catch (e) {
      console.error('[phone-login phone]', e.message);
      return res.status(500).json(safeFail('微信手机号获取失败，请稍后重试'));
    }

    if (!phoneResp || phoneResp.errcode) {
      const errmsg = phoneResp && phoneResp.errmsg ? `： ${phoneResp.errmsg}` : '';
      return res.json(fail(`微信手机号获取失败${errmsg}`));
    }

    const phone = phoneResp.phone_info && phoneResp.phone_info.phoneNumber;
    if (!phone || !/^1\d{10}$/.test(phone)) {
      return res.json(fail('未获取到有效手机号，请使用手机号登录'));
    }

    // 3) 复用手机号账号体系：匹配已开通账号
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      return res.status(403).json(safeFail('该手机号未开通登录权限，请联系机构在后台配置后登录'));
    }
    if (user.status !== 'active') {
      return res.status(403).json(safeFail('该账号已被停用，请联系管理员'));
    }
    if (user.role === 'teacher') {
      db.prepare("UPDATE users SET role = 'coach' WHERE id = ?").run(user.id);
      user.role = 'coach';
    }

    // 同步微信昵称/头像（仅在原未设置时，避免覆盖机构配置）
    if (nickname && (!user.nickname || user.nickname === '微信用户')) {
      db.prepare('UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?').run(nickname, now(), user.id);
      user.nickname = nickname;
    }
    if (avatarUrl && !user.avatar) {
      db.prepare('UPDATE users SET avatar = ?, updated_at = ? WHERE id = ?').run(avatarUrl, now(), user.id);
      user.avatar = avatarUrl;
    }

    const token = generateToken({ openid: user.openid, userId: user.id, role: user.role, tv: user.token_version || 0 });
    res.json(success({
      openid: user.openid,
      token,
      userId: user.id,
      role: user.role,
      permissions: resolvePerms(user),
      nickname: user.nickname,
      avatar: user.avatar,
      userInfo: {
        phone: user.phone,
        role: user.role,
        permissions: resolvePerms(user),
        nickname: user.nickname,
      },
    }));
  } catch (err) {
    console.error('[phone-login]', err);
    res.status(500).json(safeFail('登录失败，请稍后重试'));
  }
});

/**
 * GET /api/auth/getProfile
 * 获取当前用户信息
 */
router.get('/getProfile', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));

    const user = db.prepare('SELECT id, openid, nickname, avatar, phone, role, alias FROM users WHERE openid = ?').get(openid);
    if (!user) return res.status(404).json(safeFail('用户不存在'));

    const bindings = db.prepare(`
      SELECT pb.student_id, pb.student_name, pb.relation, pb.is_main
      FROM parent_bindings pb
      WHERE pb.parent_openid = ?
    `).all(openid);

    res.json(success({
      userId: user.id,
      openid: user.openid,
      nickname: user.nickname,
      avatar: user.avatar,
      phone: user.phone,
      alias: user.alias || '',
      role: user.role,
      permissions: resolvePerms(user),
      students: bindings,
    }));
  } catch (err) {
    console.error('[getProfile]', err);
    res.status(500).json(safeFail('获取用户信息失败'));
  }
});

// 家长绑定失败计数器（内存级，防重名误绑枚举 / 爆破）
//
// 三个维度，缺一不可：
//   openid     —— 原语义：防单个账号反复试错；
//   phoneLast4 —— 同一手机后4位被反复试探时收紧（更严格的手机维度）；
//   studentId  —— 主防线。绑定的秘密是「家长手机号后4位」，只有 10^4 种可能，
//                 而攻击者必须锁定某个具体学员才能枚举其后4位（前置条件是知道姓名）。
//                 因此以「目标学员」为 key 才真正封死枚举 —— 轮换账号无法绕开这一维度。
//                 仅靠 phoneLast4 维度不足以防枚举：后4位本身就是 10^4 个桶，
//                 攻击者每次换一个后4位就能拿到独立配额，仍可把空间走完。
// 三个 Map 的 key 上界分别受 openid 数 / 学员数 / 10^4 约束，不会无界增长。
const bindAttempts = new Map();        // openid     → { count, first, blockedUntil }
const bindPhoneAttempts = new Map();   // phoneLast4 → { count, first, blockedUntil }
const bindTargetAttempts = new Map();  // studentId  → { count, first, blockedUntil }

const BIND_WINDOW = 10 * 60 * 1000;   // openid 维度：窗口 10 分钟
const BIND_LIMIT = 10;                // openid 维度：失败 ≥10 次
const BIND_BLOCK = 10 * 60 * 1000;    // openid 维度：冷却 10 分钟
const PHONE_WINDOW = 30 * 60 * 1000;  // 手机后4位维度：窗口 30 分钟
const PHONE_LIMIT = 10;               // 手机后4位维度：失败 ≥10 次
const PHONE_BLOCK = 30 * 60 * 1000;   // 手机后4位维度：冷却 30 分钟
const TARGET_WINDOW = 30 * 60 * 1000; // 学员维度（主防线，更严）：窗口 30 分钟
const TARGET_LIMIT = 5;               // 学员维度：失败 ≥5 次
const TARGET_BLOCK = 30 * 60 * 1000;  // 学员维度：冷却 30 分钟

/**
 * 通用「窗口内计数 + 冷却」判定。
 * @returns {{ok: boolean, att: object}} ok=false 表示已进入冷却或本次已达上限，调用方应回 429
 */
function throttleCheck(map, key, limit, windowMs, blockMs, nowTs) {
  const att = map.get(key) || { count: 0, first: nowTs, blockedUntil: 0 };
  if (att.blockedUntil && att.blockedUntil > nowTs) return { ok: false, att };
  if (nowTs - att.first > windowMs) { att.count = 0; att.first = nowTs; }
  if (att.count >= limit) {
    att.blockedUntil = nowTs + blockMs;
    map.set(key, att);
    return { ok: false, att };
  }
  return { ok: true, att };
}

/** 记一次失败（att 取自 throttleCheck 的返回值，保证与判定用的是同一份计数对象） */
function throttleFail(map, key, att) {
  if (!att) return;
  att.count++;
  map.set(key, att);
}

/**
 * POST /api/auth/bindStudent
 */
router.post('/bindStudent', (req, res) => {
  try {
    const { studentName, memberNo, phoneLast4, parentName, relation = '家长' } = req.body;
    const openid = getOpenId(req);

    if (!openid) return res.status(401).json(safeFail('未登录'));
    if (!studentName || studentName.trim().length === 0) return res.status(400).json(safeFail('请输入成员姓名'));
    if (!phoneLast4 || !/^\d{4}$/.test(phoneLast4)) return res.status(400).json(safeFail('请输入有效的手机号后4位'));

    // 失败频控（第 1 层）：同一家长 10 分钟内失败 ≥10 次则冷却 10 分钟
    // 失败频控（第 2 层）：同一手机后4位 30 分钟内失败 ≥10 次则冷却 30 分钟
    const nowTs = now();
    const openidThrottle = throttleCheck(bindAttempts, openid, BIND_LIMIT, BIND_WINDOW, BIND_BLOCK, nowTs);
    if (!openidThrottle.ok) return res.status(429).json(safeFail('操作过于频繁，请稍后再试'));
    const phoneThrottle = throttleCheck(bindPhoneAttempts, phoneLast4, PHONE_LIMIT, PHONE_WINDOW, PHONE_BLOCK, nowTs);
    if (!phoneThrottle.ok) return res.status(429).json(safeFail('操作过于频繁，请稍后再试'));

    // 本次请求的失败要在各维度同时记账。studentId 在姓名/编号未解析出来时不可得，
    // 此时仅记 openid + 手机后4位两个维度（这两条失败路径也不泄露后4位是否正确）。
    const failAll = (studentId, targetAtt) => {
      throttleFail(bindAttempts, openid, openidThrottle.att);
      throttleFail(bindPhoneAttempts, phoneLast4, phoneThrottle.att);
      if (studentId && targetAtt) throttleFail(bindTargetAttempts, studentId, targetAtt);
    };

    // 每位家长最多绑定 3 位成员
    const bindCount = db.prepare('SELECT COUNT(*) as count FROM parent_bindings WHERE parent_openid = ?').get(openid).count;
    if (bindCount >= 3) return res.status(400).json(safeFail('最多只能绑定 3 位成员'));

    // 按姓名匹配；重名时需用学员编号（memberNo）进一步区分，避免误绑陌生人孩子
    const candidates = db.prepare('SELECT id, name, member_no FROM students WHERE name = ? AND status = ?').all(studentName.trim(), 'active');
    if (candidates.length === 0) { failAll(null, null); return res.status(404).json(safeFail('成员不存在，请检查姓名')); }
    if (candidates.length > 1 && !memberNo) {
      failAll(null, null);
      return res.status(400).json(safeFail('该姓名存在多位成员，请填写学员编号（memberNo）以确认'));
    }
    const student = memberNo
      ? candidates.find((c) => (c.member_no || '') === String(memberNo).trim())
      : candidates[0];
    if (!student) { failAll(null, null); return res.status(404).json(safeFail('未找到匹配该编号的成员')); }

    // 失败频控（第 3 层，主防线）：同一学员 30 分钟内失败 ≥5 次则冷却 30 分钟。
    // 必须放在解析出 student 之后 —— 枚举后4位必然针对某个具体学员。
    const targetThrottle = throttleCheck(bindTargetAttempts, student.id, TARGET_LIMIT, TARGET_WINDOW, TARGET_BLOCK, nowTs);
    if (!targetThrottle.ok) return res.status(429).json(safeFail('操作过于频繁，请稍后再试'));

    const safePhoneLast4 = escapeLike(phoneLast4);
    const existingBinding = db.prepare(`
      SELECT * FROM parent_bindings WHERE student_id = ? AND parent_phone LIKE ? ESCAPE '\\'
    `).get(student.id, `%${safePhoneLast4}`);
    if (!existingBinding) { failAll(student.id, targetThrottle.att); return res.status(400).json(safeFail('手机号后4位不匹配，绑定失败')); }

    const alreadyBound = db.prepare(`SELECT 1 FROM parent_bindings WHERE student_id = ? AND parent_openid = ?`).get(student.id, openid);
    if (alreadyBound) return res.status(400).json(safeFail('已绑定该成员'));

    db.prepare(`
      INSERT INTO parent_bindings (student_id, student_name, parent_name, parent_openid, parent_phone, relation, is_main, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(student.id, student.name, parentName || '家长', openid, existingBinding.parent_phone, relation, now());

    // 绑定成功，重置本次相关维度的失败计数
    bindAttempts.delete(openid);
    bindPhoneAttempts.delete(phoneLast4);
    bindTargetAttempts.delete(student.id);

    res.json(success({ studentId: student.id, studentName: student.name, relation }));
  } catch (err) {
    console.error('[bindStudent]', err);
    res.status(500).json(safeFail('绑定失败，请稍后重试'));
  }
});

/**
 * POST /api/auth/unbindStudent — 解绑成员（家长）
 * Body: { studentId }
 * 仅删除当前家长与该成员的绑定关系；不影响成员档案与机构侧数据，
 * 其他绑定该成员的家长不受影响。解绑后若需重新绑定，可再次发起绑定。
 */
router.post('/unbindStudent', (req, res) => {
  try {
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));
    const { studentId } = req.body;
    if (!studentId) return res.status(400).json(safeFail('缺少成员ID'));

    const result = db.prepare(
      'DELETE FROM parent_bindings WHERE parent_openid = ? AND student_id = ?'
    ).run(openid, studentId);
    if (result.changes === 0) return res.json(fail('未找到该成员的绑定关系'));

    res.json(success({ studentId }));
  } catch (err) {
    console.error('[unbindStudent]', err);
    res.status(500).json(safeFail('解绑失败，请稍后重试'));
  }
});

/**
 * POST /api/auth/updateProfile — 更新当前用户个人资料（昵称 / 头像 / 手机号）
 * 手机号变更时：同步登录标识（openid=phone_xxx）、教师档案、家长绑定关系。
 * 返回最新 openid 与用户信息，前端需同步更新本地存储。
 */
router.post('/updateProfile', (req, res) => {
  try {
    const { nickname, avatar, phone, alias } = req.body;
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));

    const user = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
    if (!user) return res.status(404).json(safeFail('用户不存在'));

    let finalOpenid = user.openid;
    let finalPhone = user.phone;

    // 手机号变更：校验格式与占用，并同步关联数据
    if (phone !== undefined && phone !== (user.phone || '')) {
      if (!phone || !/^1\d{10}$/.test(phone)) {
        return res.status(400).json(safeFail('请输入正确的11位手机号'));
      }
      const conflict = db.prepare('SELECT id FROM users WHERE phone = ? AND id != ?').get(phone, user.id);
      if (conflict) {
        return res.status(400).json(safeFail('该手机号已被其他账号使用'));
      }
      const oldPhone = user.phone || '';
      const oldOpenid = user.openid;
      finalPhone = phone;
      // 微信身份账号保留微信 openid（微信登录需继续匹配原账号），
      // 仅更新手机号；手机号身份账号（phone_ 前缀）随手机号更新 openid
      const isWechatIdentity = String(user.openid || '').startsWith('wx_');
      if (!isWechatIdentity) finalOpenid = `phone_${phone}`;

      // openid 变更时，历史数据全部跟随账号迁移（同事务）：
      // 旧实现只迁 parent_bindings，订单/通知/请假/反馈等按 openid 归属，改号后成孤儿——
      // 家长改手机号后「我的订单」清空、历史通知失联。
      db.transaction(() => {
        if (isWechatIdentity) {
          db.prepare('UPDATE users SET phone = ?, updated_at = ? WHERE id = ?')
            .run(phone, now(), user.id);
          // 微信身份 openid 不变：家长绑定里的 parent_phone 仍需刷新
          db.prepare('UPDATE parent_bindings SET parent_phone = ? WHERE parent_openid = ?')
            .run(phone, oldOpenid);
        } else {
          db.prepare('UPDATE users SET phone = ?, openid = ?, updated_at = ? WHERE id = ?')
            .run(phone, finalOpenid, now(), user.id);
          if (finalOpenid !== oldOpenid) {
            const mig = [
              "UPDATE parent_bindings SET parent_openid = ?, parent_phone = ? WHERE parent_openid = ?",
              "UPDATE orders SET user_id = ? WHERE user_id = ?",
              "UPDATE payments SET user_id = ? WHERE user_id = ?",
              "UPDATE notifications SET user_id = ? WHERE user_id = ?",
              "UPDATE notification_reads SET user_id = ? WHERE user_id = ?",
              "UPDATE feedback SET user_id = ? WHERE user_id = ?",
              "UPDATE leave_requests SET parent_openid = ? WHERE parent_openid = ?",
              "UPDATE trial_bookings SET parent_openid = ? WHERE parent_openid = ?",
              "UPDATE subscribe_msg_logs SET openid = ? WHERE openid = ?",
              "UPDATE teachers SET user_id = ? WHERE user_id = ?",
            ];
            const args = {
              parent_bindings: [finalOpenid, phone, oldOpenid],
              default: [finalOpenid, oldOpenid],
            };
            for (const sql of mig) {
              const key = sql.includes('parent_phone') ? 'parent_bindings' : 'default';
              try { db.prepare(sql).run(...args[key]); } catch (e) { /* 列不存在等异常跳过该表 */ }
            }
          }
        }

        // 同步教师档案手机号（教练）
        if (user.role === 'coach' && oldPhone) {
          db.prepare('UPDATE teachers SET phone = ? WHERE phone = ?').run(phone, oldPhone);
        }
      })();
    }

    // 昵称 / 头像
    const cleanNickname = nickname !== undefined && nickname !== null ? String(nickname).trim() : user.nickname;
    const cleanAvatar = avatar !== undefined ? String(avatar).trim() : (user.avatar || '');
    if (!cleanNickname) return res.status(400).json(safeFail('姓名不能为空'));
    if (cleanNickname.length > 20) return res.status(400).json(safeFail('姓名过长，请控制在20字以内'));

    // 对外展示别名：留空则沿用昵称；教练同步到教师档案并更新历史排课展示名
    let finalAlias = user.alias || '';
    if (alias !== undefined) {
      finalAlias = String(alias).trim();
      if (finalAlias.length > 20) return res.status(400).json(safeFail('别名过长，请控制在20字以内'));
      if (finalAlias !== (user.alias || '')) {
        db.prepare('UPDATE users SET alias = ?, updated_at = ? WHERE id = ?').run(finalAlias, now(), user.id);
        if (user.role === 'coach' && user.phone) {
          const teacher = db.prepare('SELECT id FROM teachers WHERE phone = ?').get(user.phone);
          if (teacher) {
            db.prepare('UPDATE teachers SET alias = ? WHERE id = ?').run(finalAlias, teacher.id);
            // 历史排课同步使用别名展示
            db.prepare('UPDATE schedules SET teacher_name = ? WHERE teacher_id = ?')
              .run(finalAlias || cleanNickname, teacher.id);
          }
        }
      }
    }

    if (cleanNickname !== user.nickname || cleanAvatar !== (user.avatar || '')) {
      db.prepare('UPDATE users SET nickname = ?, avatar = ?, updated_at = ? WHERE id = ?')
        .run(cleanNickname, cleanAvatar, now(), user.id);
    }

    res.json(success({
      openid: finalOpenid,
      // openid 可能因手机号变更而改变；重新签发 JWT，避免旧 token 的 openid 失效导致后续请求身份错乱
      token: generateToken({ openid: finalOpenid, userId: user.id, role: user.role, tv: user.token_version || 0 }),
      userId: user.id,
      role: user.role,
      nickname: cleanNickname,
      avatar: cleanAvatar,
      phone: finalPhone,
      alias: finalAlias,
    }));
  } catch (err) {
    console.error('[updateProfile]', err);
    res.status(500).json(safeFail('保存资料失败，请稍后重试'));
  }
});

/**
 * POST /api/auth/changePassword — 修改登录密码（管理员/教练）
 * Body: { oldPassword, newPassword }
 */
router.post('/changePassword', (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const openid = getOpenId(req);
    if (!openid) return res.status(401).json(safeFail('未登录'));

    // 员工三角色（管理员/教练/销售）均需自助改密；此前漏了 sales，销售无法改初始密码
    const user = db.prepare("SELECT * FROM users WHERE openid = ? AND role IN ('admin','coach','sales')").get(openid);
    if (!user) return res.status(403).json(safeFail('当前账号无需设置密码'));

    const pwdResult = verifyPassword(oldPassword || '', user.password || '');
    if (!user.password || !pwdResult.valid) {
      return res.status(403).json(safeFail('原密码错误'));
    }
    if (!newPassword || newPassword.length < 6 || newPassword.length > 20) {
      return res.status(400).json(safeFail('新密码需为 6-20 位'));
    }

    // 改密同时 bump token_version：使该账号其他设备的旧 Token 立即失效；
    // 并为当前会话签发新 Token 返回，避免自己也被登出。
    db.prepare('UPDATE users SET password = ?, token_version = COALESCE(token_version,0) + 1, updated_at = ? WHERE id = ?')
      .run(hashPassword(newPassword), now(), user.id);
    const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    // 改密是高危安全事件，必须留痕（谁、何时改了密码；不记录密码本身）。
    const actorPwd = getActor(req);
    recordAudit(db, {
      entity: 'user',
      entityId: String(user.id),
      action: 'change_password',
      actorId: actorPwd.id,
      actorRole: actorPwd.role,
    });
    res.json(success({
      updated: true,
      token: generateToken({ openid: freshUser.openid, userId: freshUser.id, role: freshUser.role, tv: freshUser.token_version || 0 }),
    }));
  } catch (err) {
    console.error('[changePassword]', err);
    res.status(500).json(safeFail('修改密码失败，请稍后重试'));
  }
});

module.exports = router;
