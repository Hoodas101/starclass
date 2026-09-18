/**
 * 员工模块权限键校验。
 *
 * 背景：员工权限（团队管理页的 13 个复选框）此前只影响前端的菜单与标签页可见性，
 * 后端仅 admin.js 一处校验了 'dashboard'。于是管理员取消勾选某模块后，
 * 该员工仍可直接调用对应接口 —— 权限裁剪形同装饰（P1-5）。
 *
 * 本模块把该校验收成统一入口，语义与 admin.js 既有写法一致：
 *   - 管理员恒通过（utils.resolvePerms 对 admin 返回 ['*']）；
 *   - 其余员工按自定义权限，未自定义则按角色默认权限（utils 的 DEFAULT_PERMS）。
 *
 * 适用边界（重要，避免误伤）：
 *   - **仅员工角色**（admin / coach / sales）受权限清单约束。家长不参与这套清单 ——
 *     家长的数据范围由 canViewStudentData 等**数据级**规则控制，而非模块级权限键。
 *     故家长与非员工角色直接放行，交由各路由既有的角色校验处理。
 *   - 仅对**已允许非管理员员工进入**的接口追加校验才有实际意义：已经是
 *     「仅管理员」的接口本就拒绝了其他角色，再叠加权限键不会改变任何行为。
 *   - 权限键清单的权威定义见 web-admin 的 hubs / router（前端消费方）。
 */
const { resolvePerms, safeFail, getReqUser } = require('../utils');

const STAFF_ROLES = ['admin', 'coach', 'sales'];

/**
 * 校验当前请求是否持有某模块权限。
 * 不通过时回 403 并返回 false，调用方据此提前 return。
 * 身份未知（req.userRole 缺失）同样按拒绝处理 —— 见下方失败关闭说明。
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} perm  权限键（如 'schedule' / 'checkin' / 'leave'）
 * @param {string} [label] 403 文案中的功能名，如「排课」
 * @returns {boolean} true = 放行
 */
function requireStaffPerm(req, res, perm, label) {
  const role = req.userRole;
  // 失败关闭（fail-closed）：身份未知（未认证 / token 缺 role 声明）一律拒绝。
  // 此前 `!STAFF_ROLES.includes(undefined)` 为真，会落进「非员工角色」分支被放行 ——
  // 任何漏传 role 的 token 都能拿到通行证，契约过于脆弱。
  // 注意：家长等非员工角色是**已定义值**（'parent'），不受本次收紧影响，仍走下方放行分支。
  if (role === undefined || role === null) {
    res.status(403).json(safeFail(`无权访问${label || '该功能'}`));
    return false;
  }
  if (!STAFF_ROLES.includes(role)) return true; // 家长等非员工角色不受员工权限清单约束
  if (role === 'admin') return true;            // 管理员恒通过，且省去一次用户查询
  if (resolvePerms(getReqUser(req)).includes(perm)) return true;
  res.status(403).json(safeFail(`无权访问${label || '该功能'}`));
  return false;
}

module.exports = { requireStaffPerm, STAFF_ROLES };
