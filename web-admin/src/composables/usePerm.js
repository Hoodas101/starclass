import { computed } from 'vue'
import { useUserStore } from '@/store/user'

// 角色默认权限（与后端 DEFAULT_PERMS 一致；自定义权限优先）
// coachstats 必须与 hubs/StaffHub.vue 的 `roles: ['admin','coach']` 对齐，
// 否则教练看得到「课时」标签页、后端却因缺少权限键而 403。
const DEFAULT_PERMS = {
  coach: ['students', 'schedule', 'checkin', 'leave', 'coachstats'],
  sales: ['dashboard', 'sales', 'students', 'growth'],
}

export function usePerm() {
  const userStore = useUserStore()
  // 默认空角色（不再默认 admin）：缺失角色时 has() 一律返回 false，
  // 任何"管理员才可见"的能力都必须显式授权，不可依赖默认值。
  const role = computed(() => userStore.userRole || '')
  // 数据源必须是响应式的 userStore.userInfo：
  // localStorage 读取不会被 Vue 追踪，若把它当主数据源，computed 实际只依赖 role，
  // permissions 变化而 role 不变时不会失效，会一直返回旧权限。
  // localStorage 仅作 userInfo 尚未就绪时的兜底。
  const perms = computed(() => {
    let p = userStore.userInfo?.permissions
    // W6 修复：仅当 permissions 完全缺失（undefined/null）才回退 localStorage/角色默认；
    // 显式空数组 [] 表示「已配置且无任何权限」，不可再膨胀成角色默认（否则「全部取消勾选」= 恢复默认）。
    if (!Array.isArray(p)) {
      try {
        const cached = JSON.parse(localStorage.getItem('edu_user_info') || '{}')
        p = cached.permissions
      } catch { /* 忽略 */ }
    }
    return Array.isArray(p) ? p : (DEFAULT_PERMS[role.value] || [])
  })
  const has = (perm) =>
    role.value === 'admin' || perms.value.includes('*') || perms.value.includes(perm)
  return { role, has }
}
