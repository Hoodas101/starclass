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
        path: 'sales',
        name: 'Sales',
        component: () => import('@/views/hubs/SalesHub.vue'),
        meta: { title: '销售增长', icon: 'ShoppingBag', roles: ['admin', 'sales'], perm: 'sales' }
      },
      {
        path: 'parents',
        name: 'Parents',
        component: () => import('@/views/hubs/ParentsHub.vue'),
        meta: { title: '家校沟通', icon: 'ChatDotRound', roles: ['admin'], perm: 'parents' }
      },
      {
        path: 'staff',
        name: 'Staff',
        component: () => import('@/views/hubs/StaffHub.vue'),
        meta: { title: '团队管理', icon: 'Avatar', roles: ['admin', 'coach'], perm: 'staff' }
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
    if (hasPageAccess(role, permsFromStorage(), to.meta)) {
      next()
    } else {
      // 无权限：回各自默认页。带明确提示，避免掉线重登跳到无权限页时被"静默弹回"误认为页面坏了
      ElMessage.warning(`没有访问「${to.meta.title || '该页面'}」的权限，已返回主页`)
      next(role === 'coach' ? '/schedule' : '/dashboard')
    }
  } else {
    // 未登录（或家长/未知角色会话）跳转登录页
    next('/login')
  }
})

export default router
