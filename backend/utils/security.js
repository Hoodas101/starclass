/**
 * 安全策略常量 —— 默认口令相关。
 *
 * 此前「员工默认口令」只在 routes/admin.js 内部定义，登录侧与鉴权中间件都拿不到，
 * 于是「仍是默认口令」这件事无法在登录链路被判定，只能靠启动日志告警（用户不可见）。
 * 收敛到此处后，登录、改密、强制拦截三处共用同一份定义。
 */
function getStaffDefaultPassword() {
  return process.env.STAFF_DEFAULT_PASSWORD || '123456';
}

/**
 * 是否启用「默认口令强制改密」。
 * 回归套件的夹具账号用的就是默认口令，强制生效会让全量套件必然失败，
 * 故 tests/run-all.cjs 统一置为 '0'；真实部署默认开启。
 */
function isForcePasswordChange() {
  return process.env.FORCE_PASSWORD_CHANGE !== '0';
}

module.exports = { getStaffDefaultPassword, isForcePasswordChange };
