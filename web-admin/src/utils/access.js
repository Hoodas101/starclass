// 页面访问判定：菜单过滤（MainLayout）与路由守卫（router）共用同一逻辑，
// 避免此前"守卫按角色或 perms 放行、菜单只看 roles"导致授权页面看不到入口的不一致。
import { usePerm } from '@/composables/usePerm'

// 与后端 DEFAULT_PERMS 一致（usePerm 同源），供非响应式场景（路由守卫）读取
// coachstats 见 usePerm.js 的同名说明：须与 StaffHub 的 roles 对齐
const DEFAULT_PERMS = {
  coach: ['students', 'schedule', 'checkin', 'leave', 'coachstats'],
  sales: ['dashboard', 'sales', 'students', 'growth'],
}

/**
 * 纯函数判定：某角色 + 权限清单能否访问带该 meta 的页面。
 *
 * 语义为 **AND**（角色命中 且 权限命中），与 hubs/*.vue 的页签过滤保持一致。
 * 此前这里是「角色命中 或 权限命中」的 OR 语义，与 Hub 的 AND 相反：被收回权限的
 * 员工仍被守卫放行，进去后一个页签都不显示，只剩一张完全空白的页面 —— 用户会
 * 误判成系统故障（P1-B6/D6）。统一取更严格的 AND，宁可在守卫处明确拒绝并给出提示。
 *
 * 规则缺省约定：
 *   - 只有 roles 没有 perm（如 /profile）：只看角色；
 *   - 只有 perm 没有 roles：只看权限；
 *   - 两者都没有：失败关闭，不可访问。
 * admin 全放行。
 */
export function hasPageAccess(role, perms, meta) {
  if (!role) return false
  if (role === 'admin') return true
  const roles = meta?.roles
  const perm = meta?.perm
  const permsArr = meta?.perms
  const hasRoleRule = Array.isArray(roles) && roles.length > 0
  const hasSinglePermRule = !!perm
  const hasAnyPermRule = Array.isArray(permsArr) && permsArr.length > 0
  if (!hasRoleRule && !hasSinglePermRule && !hasAnyPermRule) return false
  // W6：显式空数组 [] 视为「零权限」，不再回退角色默认（与 usePerm.js / 后端 resolvePerms 同语义）
  const list = Array.isArray(perms) ? perms : (DEFAULT_PERMS[role] || [])
  const roleOk = hasRoleRule ? roles.includes(role) : true
  const singleOk = hasSinglePermRule ? (list.includes('*') || list.includes(perm)) : true
  // meta.perms：任一命中即算通过（用于「销售或增长」类入口，管理员可单独授权其中一项给教练）
  const anyOk = hasAnyPermRule ? (list.includes('*') || permsArr.some((p) => list.includes(p))) : true
  return roleOk && singleOk && anyOk
}

/**
 * 从 localStorage 读取权限清单（路由守卫在组件外执行，用不了 Pinia 响应式）。
 * 字段缺失/损坏时返回 undefined（而非 []）—— 让 hasPageAccess 回退到角色默认权限，
 * 与 usePerm.js 的判定口径一致。显式空数组 [] 仍原样返回，表示「已配置且无任何权限」。
 */
export function permsFromStorage() {
  try {
    const p = JSON.parse(localStorage.getItem('edu_user_info') || '{}').permissions
    return Array.isArray(p) ? p : undefined
  } catch {
    return undefined
  }
}

/**
 * 组合式封装：MainLayout 菜单过滤用（响应式，走 usePerm 的数据源）。
 * 判定逻辑与 hasPageAccess 完全一致（AND 语义），保证「守卫放行的页面一定有菜单入口，
 * 守卫拒绝的页面一定没有入口」。
 */
export function usePageAccess() {
  const { role, has } = usePerm()
  const can = (meta) => {
    const r = role.value
    if (!r) return false
    if (r === 'admin') return true
    const roles = meta?.roles
    const perm = meta?.perm
    const permsArr = meta?.perms
    const hasRoleRule = Array.isArray(roles) && roles.length > 0
    const hasSinglePermRule = !!perm
    const hasAnyPermRule = Array.isArray(permsArr) && permsArr.length > 0
    if (!hasRoleRule && !hasSinglePermRule && !hasAnyPermRule) return false
    const roleOk = hasRoleRule ? roles.includes(r) : true
    const singleOk = hasSinglePermRule ? has(perm) : true
    const anyOk = hasAnyPermRule ? permsArr.some((p) => has(p)) : true
    return roleOk && singleOk && anyOk
  }
  return { can }
}
