import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import request from '@/api/request'

// Pinia 用户状态管理
export const useUserStore = defineStore('user', () => {
  // 状态
  const token = ref(localStorage.getItem('edu_token') || '')
  const userInfo = ref({})
try {
  userInfo.value = JSON.parse(localStorage.getItem('edu_user_info') || '{}')
} catch {
  userInfo.value = {}
}

  // 是否仍在使用系统默认口令（由登录响应 mustChangePassword 下发）。
  // 为 true 时后端鉴权中间件会硬拦截全部业务接口（403 且 code 4031），
  // 前端据此在改密页常驻提示，并避免把用户送进满屏报错的首页。
  const mustChangePassword = ref(localStorage.getItem('edu_must_change_password') === '1')

  // 计算属性
  const isLoggedIn = computed(() => !!token.value)
  const userName = computed(() => userInfo.value.name || '管理员')
  const userAvatar = computed(() => userInfo.value.avatar || '')
  // 默认空角色（不再默认 admin）：缺失角色时按最低权限处理，
  // 避免历史/伪造 localStorage 把任意账号当成超级管理员放行菜单与路由。
  const userRole = computed(() => userInfo.value.role || '')

  // 登录
  const login = async (loginForm) => {
    try {
      const data = await request.post('/auth/login', {
        phone: loginForm.phone,
        role: loginForm.role || 'admin',
        // 家长端无需密码，不传 password 字段让后端走无密码路径
        password: loginForm.role === 'parent' ? undefined : (loginForm.password || ''),
        nickname: loginForm.role === 'admin' ? '管理员' : loginForm.role === 'coach' ? '教练' : '家长',
        avatarUrl: '',
        gender: 0
      })

      token.value = data.token || data.openid
      userInfo.value = {
        id: data.userId,
        name: data.nickname || (loginForm.role === 'admin' ? '管理员' : '用户'),
        avatar: data.avatar || '',
        // 角色缺省时留空（按最低权限处理），不可回退 'admin'：
        // usePerm.has() 对 role === 'admin' 直接放行全部权限，回退到 admin 会让
        // 缺角色的账号在前端获得超级管理员能力，并被持久化进 localStorage。
        role: data.role || '',
        permissions: data.permissions || [],
        phone: data.userInfo?.phone || loginForm.phone
      }

      localStorage.setItem('edu_token', data.token || data.openid)
      localStorage.setItem('edu_user_info', JSON.stringify(userInfo.value))

      // 后端在登录响应下发该标记：为 true 表示仍是系统默认口令，
      // 除改密 / 取个人资料 / 登出外的接口都会被 4031 拦截，需引导用户先去改密
      mustChangePassword.value = data.mustChangePassword === true
      localStorage.setItem('edu_must_change_password', mustChangePassword.value ? '1' : '0')

      return data
    } catch (error) {
      throw error
    }
  }

  // 登出
  const logout = () => {
    token.value = ''
    userInfo.value = {}
    localStorage.removeItem('edu_token')
    localStorage.removeItem('edu_user_info')
    // 机构称呼方案缓存一并清除：共享电脑下一位登录者不应看到上一机构的术语
    localStorage.removeItem('edu_settings')
    // 强制改密标记同样清除：避免下一位登录者（可能已是自设密码）被误提示
    mustChangePassword.value = false
    localStorage.removeItem('edu_must_change_password')
  }

  // 获取用户信息
  const getUserInfo = async () => {
    try {
      const data = await request.get('/auth/getProfile')
      // 合并而非覆盖：/auth/getProfile 不返回 permissions，
      // 若整体替换会静默抹掉登录时下发的自定义权限（并写回 localStorage）。
      const prev = userInfo.value || {}
      userInfo.value = {
        ...prev,
        id: data.userId ?? prev.id,
        name: data.nickname || prev.name || '管理员',
        avatar: data.avatar || prev.avatar || '',
        // 同 login()：角色缺省时留空，不回退 'admin'
        role: data.role || '',
        phone: data.phone || prev.phone || '',
        // 新响应未携带 permissions 时沿用旧值
        permissions: Array.isArray(data.permissions) && data.permissions.length
          ? data.permissions
          : (prev.permissions || []),
      }
      localStorage.setItem('edu_user_info', JSON.stringify(userInfo.value))
      return data
    } catch (error) {
      throw error
    }
  }

  // 更新用户信息
  const updateUserInfo = (info) => {
    userInfo.value = { ...userInfo.value, ...info }
    localStorage.setItem('edu_user_info', JSON.stringify(userInfo.value))
  }

  // 替换当前 Token。改密（/auth/changePassword）会 bump token_version 并返回新 Token，
  // 旧 Token 随即失效：若不落盘，下一次请求就会被 401 登出（request.js 会清 token 并跳登录页）。
  const setToken = (newToken) => {
    if (!newToken) return
    token.value = newToken
    localStorage.setItem('edu_token', newToken)
  }

  // 改密成功后调用：解除「仍是默认口令」标记，改密页的警示条随之消失
  const clearMustChangePassword = () => {
    mustChangePassword.value = false
    localStorage.setItem('edu_must_change_password', '0')
  }

  return {
    token,
    userInfo,
    isLoggedIn,
    userName,
    userAvatar,
    userRole,
    mustChangePassword,
    login,
    logout,
    getUserInfo,
    updateUserInfo,
    setToken,
    clearMustChangePassword
  }
})
