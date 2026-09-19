/**
 * 回归套件 —— 微信手机号快捷登录（POST /api/auth/phone-login）绕过「默认口令强制改密」
 *
 * 被验证的缺陷（账号接管面：默认口令长期有效）：
 *   强制改密的收口在 backend/server.js:179 的鉴权中间件，判据是 JWT claim `mcp === 1`。
 *   `mcp` 只在**密码登录**路径（routes/auth.js:202-207）判定并写入 token。
 *   而 `POST /api/auth/phone-login`（routes/auth.js:336 起）走微信 code 换真实手机号，
 *   **不校验密码**，且在 routes/auth.js:406 生成 token 时**没有带 mcp**。
 *   于是任何 password 仍是默认口令（如 123456）的 admin/coach/sales，
 *   只要改用微信手机号快捷登录，就能拿到一个不受强制改密约束的 token ——
 *   默认口令长期有效，知道其手机号的人即可登录该员工账号。
 *
 * 修复（backend/routes/auth.js，phone-login 处理器内，token 签发之前）：
 *   1) 复用与密码登录（:202）完全相同的判据计算 mustChangePassword：
 *        ['admin','coach','sales'].includes(user.role)
 *        && typeof user.password === 'string' && user.password.length > 0
 *        && verifyPassword(getStaffDefaultPassword(), user.password).valid
 *      其中 `typeof user.password === 'string'` 是纵深防御：verifyPassword 内部对
 *      storedHash 直接调用 .startsWith，早期员工数据 password 可能为 NULL，
 *      传 null 会抛 TypeError 被外层 catch 吞成 500，把正常登录打成故障。
 *   2) token 带上 `mcp: mustChangePassword ? 1 : 0`。
 *   3) 响应体补 `mustChangePassword`，与密码登录 :212 的返回字段对齐，前端据此跳改密页。
 *
 * 判别力设计（每一条「判别项」在修复被移除后必须变红）：
 *   · T1 是**判别项**：移除修复后 phone-login 下发的 token 无 mcp，T1-3/T1-4 直接失败。
 *   · T1-5 是**对照**：同一个 token 在 FORCE_PASSWORD_CHANGE='0' 时能正常访问，
 *     证明 T1-4 的 4031 确实来自强制改密闸门，而非权限不足/路由不存在等其它原因。
 *   · T2 / T3 是**对照组用户**：非默认口令的 admin、默认口令的 parent。
 *     它们钉死「修复不得误伤」——不把非默认口令判成需改密、不把 parent 也卷进来。
 *   · T4 钉死角色清单含 coach。
 *   · T5 是**判别项**（针对 NULL 守卫）：password 为 NULL 的历史员工账号必须正常登录，
 *     移除 `typeof user.password === 'string'` 后此处会 500。
 *
 * 纪律：绝不为了「验证测试有判别力」而临时改坏刚写的防护 —— 判别力全部由对照组用户
 * （T2/T3/T4/T5）与 FORCE_PASSWORD_CHANGE 开关的对照（T1-4 vs T1-5）来证明。
 *
 * 运行（隔离库，绝不触碰 backend/db/data.db 与 3001 端口上的线上服务）：
 *   node tests/phone-login-mcp-regression.cjs
 *   KEEP_TEST_DB=1 node tests/phone-login-mcp-regression.cjs   （保留临时库排查）
 *
 * 注：本文件是新增的独立套件，**未**登记进 tests/run-all.cjs（由维护者统一登记）。
 */
'use strict';

// ── 端口必须在 require('../server') 之前设定：server.js:49 在模块加载时读取 PORT ──
// 3001 被线上服务占用，3095/3098/3099 被其它套件占用，这里走 3096。
process.env.PORT = process.env.PORT || '3096';

// ── 微信桩必须在 require 任何后端模块之前替换 globalThis.fetch ──
// phone-login 内部两处直接调用全局 fetch：
//   · getWxAccessToken（routes/auth.js:315）→ /cgi-bin/token
//   · 换手机号（routes/auth.js:362）      → /wxa/business/getuserphonenumber
// 桩按 URL 区分返回；非微信 URL（本套件访问本地 HTTP 服务）委托给真实 fetch。
process.env.WX_APPID = process.env.WX_APPID || 'wx_stub_appid';
process.env.WX_SECRET = process.env.WX_SECRET || 'wx_stub_secret';

const realFetch = globalThis.fetch;
// 当前桩要返回的手机号：各用例切换它即可复用同一个进程（getWxAccessToken 有模块级缓存，
// 换手机号不会重新取 token，不影响）。
let stubPhone = '13800000000';
let stubTokenCalls = 0;
let stubPhoneCalls = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/cgi-bin/token')) {
    stubTokenCalls++;
    return { ok: true, status: 200, json: async () => ({ access_token: 'test_token', expires_in: 7200 }) };
  }
  if (u.includes('/wxa/business/getuserphonenumber')) {
    stubPhoneCalls++;
    return { ok: true, status: 200, json: async () => ({ phone_info: { phoneNumber: stubPhone } }) };
  }
  return realFetch(url, opts);
};

// ── 隔离库（必须在 require('../db') 之前设置）──
const { bootstrap } = require('./_bootstrap.cjs');
bootstrap('/tmp/edu-test-phone-login-mcp');

// 防呆：临时库必须落在 /tmp，绝不能是真实库 backend/db/data.db
if (!String(process.env.DB_PATH || '').startsWith('/tmp/')) {
  console.error('[致命] DB_PATH 不在 /tmp，拒绝运行以免污染真实库:', process.env.DB_PATH);
  process.exit(2);
}

const db = require('../db');
const { hashPassword, now, verifyToken, generateToken } = require('../utils');

const BASE = `http://localhost:${process.env.PORT}`;

// ---------- 断言记录 ----------
let passed = 0, failed = 0;
function rec(name, ok, detail) {
  if (ok) passed++; else failed++;
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${ok ? '' : '  -> ' + detail}`);
}

// ---------- HTTP 客户端（走真实 fetch，避开微信桩）----------
async function call(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await realFetch(BASE + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch (e) { /* 可能非 JSON */ }
  return { status: res.status, data };
}

const waitHealth = async (retries = 60) => {
  for (let i = 0; i < retries; i++) {
    try { const r = await call('GET', '/api/health'); if (r.status === 200) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

// ---------- 夹具 ----------
const t = now();
/** 建一个员工 / 家长账号；password 传 null 表示历史遗留的无口令行。 */
function mkUser(id, openid, phone, nickname, role, password) {
  db.prepare(`INSERT INTO users (id, openid, phone, nickname, avatar, role, password, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, '', ?, ?, 'active', ?, ?)`)
    .run(id, openid, phone, nickname, role, password === null ? null : hashPassword(password), t, t);
}

/** 走 phone-login，桩返回的手机号由 stubPhone 决定。 */
async function phoneLogin(phone) {
  stubPhone = phone;
  return call('POST', '/api/auth/phone-login', { body: { code: 'stub' } });
}

const mcpOf = (token) => {
  const p = verifyToken(token);
  return p ? p.mcp : undefined;
};

async function main() {
  console.log('\n\x1b[1m=== 微信手机号快捷登录绕过强制改密 回归 ===\x1b[0m');
  await require('../server');
  if (!await waitHealth()) { console.error('服务器启动失败'); process.exit(2); }
  console.log('服务器已就绪 @', BASE, '（测试库:', process.env.DB_PATH, '）\n');

  // ============================================================
  // T0. 前置：服务可达 + 微信桩生效 + phone-login 流程端到端跑通
  // ============================================================
  console.log('\x1b[1m[T0] 前置条件：服务就绪 + 微信桩生效 + 处理器可达\x1b[0m');
  {
    const health = await call('GET', '/api/health');
    rec('T0 /api/health 200（服务已就绪）', health.status === 200, `status=${health.status}`);

    // 未开通的手机号：应被业务逻辑拒绝（403「未开通登录权限」），而不是 500。
    // 这证明桩返回的手机号被真正读取、且请求确实走到了匹配账号那一步。
    const unknown = await phoneLogin('13999999999');
    rec('T0 未开通手机号 → 403 业务拒绝（phone-login 端到端跑通，非 500）',
      unknown.status === 403, `status=${unknown.status} body=${JSON.stringify(unknown.data)}`);

    rec('T0 微信桩生效：/cgi-bin/token 与 /getuserphonenumber 均被调用过',
      stubTokenCalls > 0 && stubPhoneCalls > 0,
      `tokenCalls=${stubTokenCalls} phoneCalls=${stubPhoneCalls}`);
  }

  // ============================================================
  // T1. 核心：admin 仍是默认口令 → phone-login 必须带上 mcp 并被闸门拦下
  // ============================================================
  console.log('\n\x1b[1m[T1] 核心：admin 默认口令经 phone-login 必须带 mcp（判别项）\x1b[0m');
  {
    mkUser('user_pl_admin_def', 'phone_13800000000', '13800000000', '默认口令管理员', 'admin', '123456');

    const res = await phoneLogin('13800000000');
    const d = res.data && res.data.data;
    rec('T1-1 phone-login 200 且 code=0',
      res.status === 200 && res.data && res.data.code === 0,
      `status=${res.status} body=${JSON.stringify(res.data)}`);
    rec('T1-2 响应体 mustChangePassword === true（与密码登录返回字段对齐）',
      !!d && d.mustChangePassword === true, JSON.stringify(d));
    const token = (d && d.token) || '';
    rec('T1-3 [判别] token 可验签且 mcp === 1（移除修复后此处为 undefined/0）',
      !!token && mcpOf(token) === 1, `mcp=${mcpOf(token)}`);

    // 受保护接口：强制改密开启时应被 4031 拦下
    const prevForce = process.env.FORCE_PASSWORD_CHANGE;
    try {
      process.env.FORCE_PASSWORD_CHANGE = '1';
      const blocked = await call('GET', '/api/students', { token });
      rec('T1-4 [判别] 持该 token 访问 GET /api/students → 403 且 code=4031（强制改密闸门生效）',
        blocked.status === 403 && blocked.data && blocked.data.code === 4031,
        `status=${blocked.status} body=${JSON.stringify(blocked.data)}`);

      // 对照：同一 token 在强制改密关闭时能正常访问 → 证明 4031 只来自 mcp 闸门
      process.env.FORCE_PASSWORD_CHANGE = '0';
      const allowed = await call('GET', '/api/students', { token });
      rec('T1-5 [对照] 同 token 在 FORCE_PASSWORD_CHANGE=0 时 → 200（4031 确由 mcp 闸门而非权限/路由导致）',
        allowed.status === 200 && allowed.data && allowed.data.code === 0,
        `status=${allowed.status} body=${JSON.stringify(allowed.data)}`);
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_PASSWORD_CHANGE;
      else process.env.FORCE_PASSWORD_CHANGE = prevForce;
    }
  }

  // ============================================================
  // T1b. 判别力来源：手工签一个**不带 mcp** 的同身份 token（复现修复前 phone-login 的行为）
  //      若它同样能通过闸门，就证明「缺 mcp = 绕过」，即 T1-4 确实在判别 mcp claim，
  //      而不是靠权限/路由等其它因素变绿。此断言不触碰修复代码，属纯只读对照。
  // ============================================================
  console.log('\n\x1b[1m[T1b] 判别力来源：不带 mcp 的同身份 token 必然绕过闸门（复现修复前行为）\x1b[0m');
  {
    const legacy = generateToken({ openid: 'phone_13800000000', userId: 'user_pl_admin_def', role: 'admin', tv: 0 });
    rec('T1b 前置：手工 token 确实不含 mcp claim（mcp === undefined）',
      mcpOf(legacy) === undefined, `mcp=${mcpOf(legacy)}`);

    const prevForce = process.env.FORCE_PASSWORD_CHANGE;
    try {
      process.env.FORCE_PASSWORD_CHANGE = '1';
      const bypass = await call('GET', '/api/students', { token: legacy });
      rec('T1b [判别力证明] FORCE_PASSWORD_CHANGE=1 下无 mcp 的 token 能访问 → 200（即修复前 phone-login 的绕过）',
        bypass.status === 200 && bypass.data && bypass.data.code === 0,
        `status=${bypass.status} body=${JSON.stringify(bypass.data)}`);
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_PASSWORD_CHANGE;
      else process.env.FORCE_PASSWORD_CHANGE = prevForce;
    }
  }

  // ============================================================
  // T2. 对照组：admin 已是非默认口令 → 不得带 mcp、不得被拦
  // ============================================================
  console.log('\n\x1b[1m[T2] 对照组：admin 非默认口令 → 不带 mcp，可正常访问（不误伤）\x1b[0m');
  {
    mkUser('user_pl_admin_custom', 'phone_13800000002', '13800000002', '已改密管理员', 'admin', 'Adm1n-Pass-2026');

    const res = await phoneLogin('13800000002');
    const d = res.data && res.data.data;
    rec('T2-1 phone-login 200 且 code=0',
      res.status === 200 && res.data && res.data.code === 0,
      `status=${res.status} body=${JSON.stringify(res.data)}`);
    rec('T2-2 mustChangePassword === false', !!d && d.mustChangePassword === false, JSON.stringify(d));
    const token = (d && d.token) || '';
    rec('T2-3 [判别] token mcp === 0（非默认口令不得被判为需改密）',
      !!token && mcpOf(token) === 0, `mcp=${mcpOf(token)}`);

    const prevForce = process.env.FORCE_PASSWORD_CHANGE;
    try {
      process.env.FORCE_PASSWORD_CHANGE = '1';
      const ok = await call('GET', '/api/students', { token });
      rec('T2-4 [判别] FORCE_PASSWORD_CHANGE=1 时仍可访问 GET /api/students → 200（不被 4031 误伤）',
        ok.status === 200 && ok.data && ok.data.code === 0,
        `status=${ok.status} body=${JSON.stringify(ok.data)}`);
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_PASSWORD_CHANGE;
      else process.env.FORCE_PASSWORD_CHANGE = prevForce;
    }
  }

  // ============================================================
  // T3. 对照组：parent 默认口令 → 不带 mcp（中间件只对 admin/coach/sales 生效）
  // ============================================================
  console.log('\n\x1b[1m[T3] 对照组：parent 默认口令 → 不带 mcp（角色清单不含 parent）\x1b[0m');
  {
    mkUser('user_pl_parent_def', 'phone_13800000003', '13800000003', '默认口令家长', 'parent', '123456');

    const res = await phoneLogin('13800000003');
    const d = res.data && res.data.data;
    rec('T3-1 phone-login 200 且 code=0',
      res.status === 200 && res.data && res.data.code === 0,
      `status=${res.status} body=${JSON.stringify(res.data)}`);
    rec('T3-2 mustChangePassword === false（家长不参与员工强制改密）',
      !!d && d.mustChangePassword === false, JSON.stringify(d));
    const token = (d && d.token) || '';
    rec('T3-3 [判别] token mcp === 0', !!token && mcpOf(token) === 0, `mcp=${mcpOf(token)}`);

    const prevForce = process.env.FORCE_PASSWORD_CHANGE;
    try {
      process.env.FORCE_PASSWORD_CHANGE = '1';
      const r = await call('GET', '/api/students', { token });
      // 家长无成员查看权限，会被路由拒绝，但**不得**是 4031（否则说明家长也被卷入强制改密）
      rec('T3-4 [判别] FORCE_PASSWORD_CHANGE=1 时返回的是权限拒绝（403, code≠4031）而非强制改密拦截',
        r.status === 403 && r.data && r.data.code !== 4031,
        `status=${r.status} body=${JSON.stringify(r.data)}`);
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_PASSWORD_CHANGE;
      else process.env.FORCE_PASSWORD_CHANGE = prevForce;
    }
  }

  // ============================================================
  // T4. coach 默认口令 → 带 mcp（钉死角色清单含 coach）
  // ============================================================
  console.log('\n\x1b[1m[T4] 角色清单：coach 默认口令 → 同样必须带 mcp\x1b[0m');
  {
    mkUser('user_pl_coach_def', 'phone_13800000004', '13800000004', '默认口令教练', 'coach', '123456');

    const res = await phoneLogin('13800000004');
    const d = res.data && res.data.data;
    rec('T4-1 phone-login 200 且 code=0',
      res.status === 200 && res.data && res.data.code === 0,
      `status=${res.status} body=${JSON.stringify(res.data)}`);
    rec('T4-2 mustChangePassword === true', !!d && d.mustChangePassword === true, JSON.stringify(d));
    const token = (d && d.token) || '';
    rec('T4-3 [判别] token mcp === 1', !!token && mcpOf(token) === 1, `mcp=${mcpOf(token)}`);

    const prevForce = process.env.FORCE_PASSWORD_CHANGE;
    try {
      process.env.FORCE_PASSWORD_CHANGE = '1';
      const blocked = await call('GET', '/api/students', { token });
      rec('T4-4 [判别] 访问受保护接口 → 403 且 code=4031',
        blocked.status === 403 && blocked.data && blocked.data.code === 4031,
        `status=${blocked.status} body=${JSON.stringify(blocked.data)}`);
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_PASSWORD_CHANGE;
      else process.env.FORCE_PASSWORD_CHANGE = prevForce;
    }
  }

  // ============================================================
  // T5. 纵深：password 为 NULL 的历史员工账号 → 不得 500（判别 NULL 守卫）
  // ============================================================
  console.log('\n\x1b[1m[T5] 纵深：password 为 NULL 的历史员工账号不得被登录打成 500\x1b[0m');
  {
    mkUser('user_pl_null_pwd', 'phone_13800000005', '13800000005', '无口令历史教练', 'coach', null);
    const row = db.prepare('SELECT password FROM users WHERE id = ?').get('user_pl_null_pwd');
    rec('T5 前置：夹具 password 确为 NULL（verifyPassword 直接 startsWith 会抛 TypeError）',
      row && row.password === null, JSON.stringify(row));

    const res = await phoneLogin('13800000005');
    const d = res.data && res.data.data;
    rec('T5-1 [判别] phone-login 200 且 code=0（移除 NULL 守卫后此处为 500）',
      res.status === 200 && res.data && res.data.code === 0,
      `status=${res.status} body=${JSON.stringify(res.data)}`);
    rec('T5-2 mustChangePassword === false（无口令不等于默认口令）',
      !!d && d.mustChangePassword === false, JSON.stringify(d));
    const token = (d && d.token) || '';
    rec('T5-3 token mcp === 0', !!token && mcpOf(token) === 0, `mcp=${mcpOf(token)}`);
  }

  console.log(`\n\x1b[1m结果汇总：PASS ${passed}  FAIL ${failed}\x1b[0m`);
  db.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试异常', e); process.exit(2); });
