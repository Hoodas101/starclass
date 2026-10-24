/**
 * 安全策略常量 —— 默认口令相关。
 *
 * 此前「员工默认口令」只在 routes/admin.js 内部定义，登录侧与鉴权中间件都拿不到，
 * 于是「仍是默认口令」这件事无法在登录链路被判定，只能靠启动日志告警（用户不可见）。
 * 收敛到此处后，登录、改密、强制拦截三处共用同一份定义。
 */
function getStaffDefaultPassword() {
  const configured = process.env.STAFF_DEFAULT_PASSWORD;
  if (configured) return configured;
  // 生产环境**不给**硬编码回退：默认口令写在开源仓库里，知道员工手机号即可登录。
  // 未配置时返回空串，由调用方生成随机临时口令一次性展示给管理员。
  // 本地/测试保留 123456：回归套件的夹具账号依赖它，否则 42 个套件全红。
  if (process.env.NODE_ENV === 'production') return '';
  return '123456';
}

/**
 * 生成随机临时口令（10 位，去掉 0/O/1/l/I 等易混字符）。
 * 用于「未配置 STAFF_DEFAULT_PASSWORD 时新建/重置员工密码」——
 * 一次性返回给管理员，不再回落到公开的默认口令。
 */
function generateTempPassword() {
  const crypto = require('crypto');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const buf = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

/**
 * 是否启用「默认口令强制改密」。
 * 回归套件的夹具账号用的就是默认口令，强制生效会让全量套件必然失败，
 * 故 tests/run-all.cjs 统一置为 '0'；真实部署默认开启。
 */
function isForcePasswordChange() {
  return process.env.FORCE_PASSWORD_CHANGE !== '0';
}

module.exports = {
  generateTempPassword, getStaffDefaultPassword, isForcePasswordChange };
