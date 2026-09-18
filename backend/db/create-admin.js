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
const { hashPassword } = require('../utils');

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
  db.prepare(`INSERT INTO users (id, openid, phone, nickname, avatar, role, password, status, created_at, updated_at)
              VALUES (?, ?, ?, '管理员', '', 'admin', ?, 'active', ?, ?)`)
    .run('user_admin', `admin_${crypto.randomBytes(8).toString('hex')}`, phone, hash, NOW, NOW);
  console.log('[Admin] 已创建管理员账号');
}

console.log('─'.repeat(54));
console.log(`  手机号：${phone}`);
console.log(`  口  令：${password}`);
console.log('─'.repeat(54));
console.log('本口令仅显示这一次，请立即登录并修改。');
