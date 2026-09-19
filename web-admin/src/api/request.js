// src/api/request.js — 管理端请求封装
// 连接本地 Node.js 后端（Express + SQLite）
// API 格式：/api/{resource}/{action}，返回 { code: 0, data, message }

import axios from 'axios'
import router from '@/router'

// 后端 API 根地址（与 vite.config.js proxy 保持一致，默认相对路径避免 CORS）
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

// 401 并发去重：多个在途请求同时过期时，只提示 + 跳转一次
let redirecting401 = false

// 创建 axios 实例
const service = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// 请求拦截器 - 加 token
service.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('edu_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器 - 统一错误处理
service.interceptors.response.use(
  (response) => {
    // 二进制下载（备份文件等）：跳过 JSON 约定解析，直接返回原始响应体（Blob/ArrayBuffer）
    if (response.config.responseType === 'blob' || response.config.responseType === 'arraybuffer') {
      return response.data
    }

    const { code, message, data } = response.data

    // 后端约定 code === 0 表示成功
    if (code === 0) {
      return data
    }

    // 业务错误
    ElMessage.error(message || '请求失败')
    return Promise.reject(new Error(message || '请求失败'))
  },
  (error) => {
    const { response } = error

    if (response) {
      switch (response.status) {
        case 401:
          // 与主动登出对齐：同时清除身份缓存，避免共享电脑残留上一位用户的手机号与权限清单
          localStorage.removeItem('edu_token')
          localStorage.removeItem('edu_user_info')
          localStorage.removeItem('edu_settings')
          // 携带 redirect：重新登录后回到掉线前的页面，而不是每次都回看板。
          // 并发请求同时 401 时只提示/跳转一次，避免连环 push 与叠罗汉 toast
          if (!redirecting401) {
            redirecting401 = true
            ElMessage.error(response.data?.message || '登录已过期，请重新登录')
            const cur = router.currentRoute?.value
            const target = cur && cur.fullPath && !cur.meta?.public
              ? `/login?redirect=${encodeURIComponent(cur.fullPath)}`
              : '/login'
            const go = cur?.path !== '/login' ? router.push(target) : Promise.resolve()
            Promise.resolve(go).finally(() => { redirecting401 = false })
          }
          return Promise.reject(new Error(response.data?.message || '登录已过期，请重新登录'))
        case 403:
          // code 4031 = 账号仍是系统默认口令，被后端鉴权中间件硬拦截：
          // 必须把用户引导到改密页，只弹一条 message 会让其在「处处没权限」里卡死
          if (response.data?.code === 4031) {
            ElMessage.warning(response.data?.message || '请先修改密码')
            router.push('/profile')
          } else {
            ElMessage.error(response.data?.message || '没有权限访问')
          }
          return Promise.reject(new Error(response.data?.message || '没有权限访问'))
        case 404:
          ElMessage.error(response.data?.message || '请求的资源不存在')
          return Promise.reject(new Error(response.data?.message || '请求的资源不存在'))
        case 500:
          ElMessage.error(response.data?.message || '服务器内部错误')
          return Promise.reject(new Error(response.data?.message || '服务器内部错误'))
        default:
          const defaultMsg = response.data?.message || '请求失败'
          ElMessage.error(defaultMsg)
          return Promise.reject(new Error(defaultMsg))
      }
    } else {
      ElMessage.error('网络连接失败，请检查网络')
    }

    return Promise.reject(new Error('网络连接失败，请检查网络'))
  }
)

export default service
export { BASE_URL }
