/**
 * 创建 / 重置管理员账号
 *
 * 用法：
 *   node db/create-admin.js                        # 生成随机强口令，创建或重置管理员
 *   node db/create-admin.js --phone 13800000000    # 指定手机号
 *   node db/create-admin.js --password 'xxx'       # 指定口令（不推荐：会留在 shell 历史中）
 *
 * 为什么需要这个脚本：
 *   db/seed.js 会先清空 19 张业务表再灌入演示数据，用它来「找回管理员密码」
 *   等于抹掉全部真实业务数据。本脚本只触碰 users 表的目标行，安全可重复执行。
 */
const crypto = require('crypto');
const db = require('./index');
const { hashPassword, generateId } = require('../utils');

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const phone = String(getArg('phone') || '13800000001').trim();
const explicitPassword = getArg('password');
const password = explicitPassword || crypto.randomBytes(9).toString('base64url');

if (!/^1[3-9]\d{9}$/.test(phone)) {
  console.error(`[Admin] 手机号格式不合法：${phone}`);
  process.exit(1);
}
if (password.length < 8) {
  console.error('[Admin] 口令至少需要 8 位');
  process.exit(1);
}

const NOW = Date.now();
const hash = hashPassword(password);
const existing = db.prepare("SELECT id FROM users WHERE phone = ? AND role = 'admin'").get(phone);

if (existing) {
  // 重置口令：bump token_version 让该账号已签发的 Token 立即失效
  db.prepare(`UPDATE users SET password = ?, status = 'active',
              token_version = COALESCE(token_version, 0) + 1, updated_at = ?
              WHERE id = ?`).run(hash, NOW, existing.id);
  console.log('[Admin] 已重置管理员口令（该账号此前的登录状态已失效）');
} else {
  // 该手机号若已被**非管理员**账号占用（如教练/家长），直接 INSERT 会撞 users.phone
  // 唯一约束并抛栈。这里明确拒绝，而不是静默把对方「升格」为管理员 ——
  // 后者是一次操作者未被告知、事后也难以察觉的权限变更。
  const occupied = db.prepare('SELECT id, role FROM users WHERE phone = ?').get(phone);
  if (occupied) {
    console.error(`[Admin] 手机号 ${phone} 已被角色为「${occupied.role}」的账号占用，未创建管理员。`);
    console.error('[Admin] 请改用其他手机号，或先处理该账号的角色后再执行本脚本。');
    process.exit(1);
  }
  // id 必须唯一：原先硬编码 'user_admin'，创建第二个管理员时直接撞主键
  // （UNIQUE constraint failed: users.id），README 指引的「找回密码」流程
  // 在多管理员场景下必然崩溃。改为复用项目既有的 generateId 风格生成唯一 id。
  db.prepare(`INSERT INTO users (id, openid, phone, nickname, avatar, role, password, status, created_at, updated_at)
              VALUES (?, ?, ?, '管理员', '', 'admin', ?, 'active', ?, ?)`)
    .run(generateId('user_admin_'), `admin_${crypto.randomBytes(8).toString('hex')}`, phone, hash, NOW, NOW);
  console.log('[Admin] 已创建管理员账号');
}

console.log('─'.repeat(54));
console.log(`  手机号：${phone}`);
console.log(`  口  令：${password}`);
console.log('─'.repeat(54));
console.log('本口令仅显示这一次，请立即登录并修改。');
