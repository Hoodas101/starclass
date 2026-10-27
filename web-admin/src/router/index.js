import { createRouter, createWebHistory } from 'vue-router'
import { ElMessage } from 'element-plus'
import { hasPageAccess, permsFromStorage } from '@/utils/access'

// 路由配置
const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/login/index.vue'),
    meta: { title: '登录', public: true }
  },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/dashboard/index.vue'),
        meta: { title: '数据看板', icon: 'DataAnalysis', roles: ['admin', 'sales'], perm: 'dashboard' }
      },
      {
        path: 'operations',
        name: 'Operations',
        component: () => import('@/views/hubs/OperationsHub.vue'),
        meta: { title: '教学运营', icon: 'Calendar', roles: ['admin', 'coach'], perm: 'schedule' }
      },
      {
        path: 'students',
        name: 'Students',
        component: () => import('@/views/hubs/StudentsHub.vue'),
        meta: { title: '{learner}档案', icon: 'User', roles: ['admin', 'coach', 'sales'], perm: 'students' }
      },
      {
        // 教练也纳入 roles：守卫改为 AND 语义后，若 roles 里没有 coach，
        // 管理员在「团队管理」给教练勾选「销售/增长」权限键也无法生效（角色这一关先被拦掉）。
        // 注意：仅放开「角色」这一半，另一半仍需该账号实际持有 sales/growth 权限键，
        // 所以默认教练不会平白多出销售入口。
        path: 'sales',
        name: 'Sales',
        component: () => import('@/views/hubs/SalesHub.vue'),
        meta: { title: '销售增长', icon: 'ShoppingBag', roles: ['admin', 'sales', 'coach'], perms: ['sales', 'growth'] }
      },
      {
        // 家校沟通当前为管理员专属：ParentsHub 三个页签均为 roles:['admin']，且后端
        // feedback.js / messages.js 是 isAdminReq 硬校验。此前 roles 含 coach，导致教练
        // 进入后是「无页签空白页 + 接口 403」的死路。先收紧为仅 admin 止血；
        // 若后续要让教练看自己学员的反馈/消息，需同时放开页签 roles 并把后端改为「管理员或该学员的教练」。
        path: 'parents',
        name: 'Parents',
        component: () => import('@/views/hubs/ParentsHub.vue'),
        meta: { title: '家校沟通', icon: 'ChatDotRound', roles: ['admin'], perm: 'parents' }
      },
      {
        // perm 由 'staff' 改为 'coachstats'：守卫改 AND 后，教练默认权限里没有 'staff'，
        // 会被整页拦掉，连带丢失「教练课时」这个教练真实可用的标签页。
        // StaffHub 内部的页签权限（员工=staff 仅 admin / 课时=coachstats）不受影响，
        // 这里只决定「整页是否可进」。
        path: 'staff',
        name: 'Staff',
        component: () => import('@/views/hubs/StaffHub.vue'),
        meta: { title: '团队管理', icon: 'Avatar', roles: ['admin', 'coach'], perm: 'coachstats' }
      },
      {
        // 个人设置：全员工角色（管理员/教练/销售）可访问的自助改密入口。
        // 后端 /auth/changePassword 本就支持这三种角色，但此前承载改密表单的系统设置页
        // 仅 roles:['admin']，教练与销售拿不到任何改密入口（无法更换初始密码）。
        // 刻意不设 meta.title：本页由右上角用户菜单进入，不进入侧栏菜单。
        path: 'profile',
        name: 'Profile',
        component: () => import('@/views/profile/index.vue'),
        meta: { roles: ['admin', 'coach', 'sales'] }
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('@/views/settings/index.vue'),
        meta: { title: '系统设置', icon: 'Setting', roles: ['admin'], perm: 'settings' }
      },
      {
        // 无权限兜底页：只按角色放行、不带任何 perm 约束，保证任何已登录员工都进得去。
        // 守卫回跳前会对候选目标做可达性判断，全部不可达时落到这里，杜绝回跳自身成环。
        // noMenu: true —— 有权限也不进侧栏菜单（MainLayout 的菜单过滤会跳过），
        // 它只是守卫的兜底落点，不是用户可以主动导航的业务页面。
        path: 'no-access',
        name: 'NoAccess',
        component: () => import('@/views/NoAccess.vue'),
        meta: { title: '无访问权限', noMenu: true, roles: ['admin', 'coach', 'sales'] }
      },
      // 旧路径兼容重定向（无 meta.title，不进入侧栏菜单）
      { path: 'schedule', redirect: '/operations?tab=schedule' },
      { path: 'checkin', redirect: '/operations?tab=checkin' },
      { path: 'leave', redirect: '/operations?tab=leave' },
      { path: 'classes', redirect: '/operations?tab=classes' },
      { path: 'points', redirect: '/students?tab=points' },
      { path: 'orders', redirect: '/sales?tab=orders' },
      { path: 'growth', redirect: '/sales?tab=growth' },
      { path: 'trial', redirect: '/sales?tab=trial' },
      { path: 'feedback', redirect: '/parents?tab=feedback' },
      { path: 'notifications', redirect: '/parents?tab=notifications' },
      { path: 'coach-stats', redirect: '/staff?tab=coachstats' },
      // 404 兜底：未匹配路径（含手输错地址）回数据看板，由守卫按权限再分流
      { path: '/:pathMatch(.*)*', name: 'NotFound', redirect: '/dashboard' }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// 无权限回跳的候选目标（按业务优先级）。**逐个做可达性判断**后再跳：
// 此前写死 `role === 'coach' ? '/schedule' : '/dashboard'`，而这两个目标自身带
// perm/roles 约束（dashboard → perm:'dashboard'、operations → perm:'schedule'）。
// 员工被自定义授权（例如只勾选 students）时，回跳目标同样无权限 → 守卫再次拒绝 →
// 再次回跳同一个地址 → 无限重定向：toast 刷屏、页面卡死、侧栏被过滤成空。
// 兜底页 /no-access 只按角色放行且不含任何 perm，任何已登录员工必然可达，环到此终止。
const FALLBACK_ROUTE_NAMES = ['Dashboard', 'Operations', 'Students', 'Sales', 'Staff', 'Profile', 'NoAccess']

function resolveFallback(role, perms) {
  const root = routes.find((r) => r.path === '/')
  const children = root?.children || []
  for (const name of FALLBACK_ROUTE_NAMES) {
    const r = children.find((c) => c.name === name)
    if (r && hasPageAccess(role, perms, r.meta)) return r.path
  }
  // 理论上不可达：NoAccess 对所有员工角色放行。仍保留绝对路径兜底，避免任何情况下返回空
  return '/no-access'
}

// 路由守卫 - 检查登录态
router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('edu_token')
  let role = ''
  try {
    role = (JSON.parse(localStorage.getItem('edu_user_info') || '{}').role) || ''
  } catch (e) {
    role = ''
  }

  if (to.meta.public) {
    // 公开路由直接放行
    next()
  } else if (token && (role === 'admin' || role === 'coach' || role === 'sales')) {
    // 已登录用户：与侧栏菜单共用 hasPageAccess 判定（角色或自定义功能权限）
    // 注意：不再对 parent 无条件放行——家长端走微信小程序，管理后台面向机构员工；
    // 此前 parent 兜底可直达 /settings 等所有页面壳（URL 直达绕过菜单隐藏）
    const perms = permsFromStorage()
    if (hasPageAccess(role, perms, to.meta)) {
      next()
    } else if (to.name === 'NoAccess') {
      // 兜底页自身：无论如何放行，守卫绝不能拒绝它，否则仍会成环
      next()
    } else {
      // 无权限：跳到**当前账号确实可达**的第一个页面（不再写死 coach→/schedule）。
      // 带明确提示，避免掉线重登跳到无权限页时被"静默弹回"误认为页面坏了
      const fallback = resolveFallback(role, perms)
      ElMessage.warning(
        fallback === '/no-access'
          ? `没有访问「${to.meta.title || '该页面'}」的权限`
          : `没有访问「${to.meta.title || '该页面'}」的权限，已返回主页`
      )
      next(fallback)
    }
  } else {
    // 未登录（或家长/未知角色会话）跳转登录页
    next('/login')
  }
})

// 页面标题动态化：此前所有页面共用一个静态标题，浏览器标签页与收藏夹都分不清是哪个页面。
router.afterEach((to) => {
  const base = '星课 StarClass'
  document.title = to.meta && to.meta.title ? `${to.meta.title} · ${base}` : base
})

export default router
