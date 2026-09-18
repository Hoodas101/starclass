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
 * meta.roles 命中 或 meta.perm 在权限清单中 即放行；admin 全放行。
 */
export function hasPageAccess(role, perms, meta) {
  if (!role) return false
  if (role === 'admin') return true
  const roles = meta?.roles
  if (Array.isArray(roles) && roles.includes(role)) return true
  const perm = meta?.perm
  if (!perm) return false
  // W6 修复：显式空数组 [] 视为「零权限」，不再回退角色默认（与 usePerm.js / 后端 resolvePerms 同语义）
  const list = Array.isArray(perms) ? perms : (DEFAULT_PERMS[role] || [])
  return list.includes('*') || list.includes(perm)
}

/**
 * 从 localStorage 读取权限清单（路由守卫在组件外执行，用不了 Pinia 响应式）。
 */
export function permsFromStorage() {
  try {
    const p = JSON.parse(localStorage.getItem('edu_user_info') || '{}').permissions
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

/**
 * 组合式封装：MainLayout 菜单过滤用（响应式，走 usePerm 的数据源）。
 * 判定逻辑与 hasPageAccess 完全一致：角色命中 meta.roles，或自定义/默认权限命中 meta.perm。
 */
export function usePageAccess() {
  const { role, has } = usePerm()
  const can = (meta) => {
    const r = role.value
    if (!r) return false
    if (r === 'admin') return true
    if (Array.isArray(meta?.roles) && meta.roles.includes(r)) return true
    return !!meta?.perm && has(meta.perm)
  }
  return { can }
}
