<template>
  <div class="login-page">
    <!-- 左侧品牌区（浅色品牌面，Apple 蓝唯一强调色，不随主题反转） -->
    <div class="login-brand">
      <!-- 背景装饰：真实图标水印 + 柔光环，建立纵深而不喧宾夺主 -->
      <el-icon class="brand-watermark" :size="380"><School /></el-icon>
      <span class="brand-ring" aria-hidden="true"></span>

      <div class="brand-inner">
        <div class="brand-logo">
          <el-icon :size="26"><School /></el-icon>
        </div>
        <h1 class="brand-name">星课<span class="brand-en">StarClass</span></h1>
        <p class="brand-tagline">教务 · 排期 · 销售 · {{ $t('learner') }}，一体化管理</p>

        <div class="brand-meta">
          <span class="brand-meta-dot"></span>
          <span>让每一堂课都被认真对待</span>
        </div>
      </div>
    </div>

    <!-- 右侧表单区 -->
    <div class="login-panel">
      <div class="panel-inner">
        <div class="panel-eyebrow">管理端登录</div>
        <h2 class="panel-title">欢迎回来</h2>
        <p class="panel-sub">登录后进入对应身份的工作台</p>

        <el-form
          ref="loginFormRef"
          :model="loginForm"
          :rules="loginRules"
          size="large"
          @keyup.enter="handleLogin"
        >
          <div class="field-block" :style="{ '--i': 0 }">
            <div class="field-label">手机号</div>
            <el-form-item prop="phone">
              <el-input
                v-model="loginForm.phone"
                placeholder="请输入手机号"
                maxlength="11"
                :prefix-icon="Iphone"
              />
            </el-form-item>
          </div>

          <div class="field-block" :style="{ '--i': 1 }">
            <div class="field-label">登录身份</div>
            <div class="role-group">
              <div
                v-for="r in roles"
                :key="r.value"
                class="role-chip"
                :class="{ active: loginForm.role === r.value }"
                @click="loginForm.role = r.value"
              >
                <el-icon :size="18"><component :is="r.icon" /></el-icon>
                <span>{{ $roleLabel(r.value) }}</span>
              </div>
            </div>
          </div>

          <div class="field-block" :style="{ '--i': 2 }">
            <div class="field-label">登录密码</div>
            <el-form-item prop="password" :rules="passwordRules">
              <el-input
                v-model="loginForm.password"
                type="password"
                show-password
                placeholder="请输入登录密码"
                maxlength="20"
                :prefix-icon="Lock"
              />
            </el-form-item>
          </div>

          <el-button
            :loading="loading"
            class="login-btn field-block"
            :style="{ '--i': 3 }"
            @click="handleLogin"
          >
            {{ loading ? '登录中...' : '登 录' }}
          </el-button>
        </el-form>

        <p class="panel-footer">手机号由机构后台预设，登录后按身份进入对应界面</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { School, Iphone, UserFilled, Basketball, Setting, Lock } from '@element-plus/icons-vue'
import { useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const settingsStore = useSettingsStore()
const t = settingsStore.t

const loginFormRef = ref(null)
const loading = ref(false)

const loginForm = reactive({
  phone: '',
  role: 'admin',
  password: ''
})

const roles = [
  { value: 'admin', label: '管理员', icon: Setting },
  { value: 'coach', label: t('instructor'), icon: Basketball },
  { value: 'sales', label: '销售', icon: UserFilled }
]

const loginRules = {
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1\d{10}$/, message: '请输入11位有效手机号', trigger: 'blur' }
  ]
}

const passwordRules = [
  { required: true, message: '请输入登录密码', trigger: 'blur' },
  { min: 6, max: 20, message: '密码长度为 6-20 位', trigger: 'blur' }
]

const handleLogin = async () => {
  if (!loginFormRef.value) return

  await loginFormRef.value.validate(async (valid) => {
    if (!valid) return

    loading.value = true
    try {
      const data = await userStore.login(loginForm)
      if (data.role !== 'admin' && data.role !== 'coach' && data.role !== 'sales') {
        ElMessage.error(data.role === 'parent' ? '家长端请使用微信小程序，管理后台面向机构员工开放' : '该账号无管理端权限，请联系管理员开通')
        userStore.logout()
        return
      }
      // 仍是系统默认口令：除改密等少数接口外全部被后端硬拦截（403 且 code 4031），
      // 必须直接落到改密页，否则用户进首页满屏报错，观感是「系统坏了」
      if (data.mustChangePassword === true) {
        ElMessage.warning('当前仍是系统默认口令，请先修改密码')
        router.push('/profile')
        return
      }
      ElMessage.success('登录成功')
      // 401 掉线重登后回原页面；否则管理员/销售进看板，教练进排期。
      // 排除回跳登录页自身（旧书签 /login?redirect=/login），否则 push 被路由去重吞掉、停在登录页像登录失败
      // 同源校验：拒绝 //host 与 /\host（WHATWG 把反斜杠也归一为斜杠 → 跨域跳转，开放重定向面）
      const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
      if (redirect && redirect.startsWith('/') && !/^\/[\/\\]/.test(redirect) && !redirect.startsWith('/login')) {
        router.push(redirect)
      } else if (data.role === 'coach') {
        router.push('/schedule')
      } else {
        router.push('/dashboard')
      }
    } catch (error) {
      ElMessage.error(error.message || '登录失败')
    } finally {
      loading.value = false
    }
  })
}

onMounted(() => {
  if (route.query.denied === '1') {
    ElMessage.warning('该账号非管理员，无法进入管理端，请切换管理员身份登录')
  }
})
</script>

<style lang="scss" scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  overflow: hidden;
  background: var(--t-bg);
}

// ============ 左侧品牌区 ============
.login-brand {
  flex: 1.15;
  min-width: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--t-text-1);
  background: var(--t-bg);
  border-right: 1px solid var(--t-line);

  // 顶部细品牌色条（Apple 蓝唯一强调色，纯色不渐变）
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: var(--t-accent);
    opacity: 1;
  }
}

// 大号图标水印：真实图标组件，低透明度，仅作纵深
.brand-watermark {
  position: absolute;
  right: -56px;
  bottom: -64px;
  color: rgba(0, 0, 0, 0.03);
  z-index: 0;
  pointer-events: none;
}

// 柔光环装饰：单色强调，克制
.brand-ring {
  position: absolute;
  top: 12%;
  right: 14%;
  width: 168px;
  height: 168px;
  border-radius: 50%;
  border: 1px solid var(--t-accent-line);
  background: transparent;
  z-index: 0;
  pointer-events: none;
}

.brand-inner {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 0 12%;
  max-width: 620px;
  animation: brandIn 0.3s var(--t-ease-standard);
}

@keyframes brandIn {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: translateY(0); }
}

.brand-logo {
  width: 56px;
  height: 56px;
  border-radius: var(--t-radius-md);
  background: var(--t-accent-bg);
  border: 1px solid var(--t-accent-line);
  backdrop-filter: none;
  color: var(--t-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 28px;
  box-shadow: none;
}

.brand-name {
  font-size: var(--t-fs-4xl);
  font-weight: 700;
  margin: 0 0 14px;
  letter-spacing: -0.01em;
  line-height: 1.2;
  color: var(--t-text-1);
  text-shadow: none;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.brand-en {
  font-size: var(--t-fs-base);
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--t-text-3);
  text-shadow: none;
}

.brand-tagline {
  font-size: var(--t-fs-base);
  color: var(--t-text-2);
  margin: 0;
  line-height: 1.7;
}

// 品牌面底部一行元信息（与 logo 对齐的小字，单点强调）
.brand-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 26px;
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  letter-spacing: 0.01em;

  &-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--t-accent);
    box-shadow: 0 0 0 4px var(--t-accent-bg);
  }
}

// ============ 右侧表单区 ============
.login-panel {
  flex: 1;
  min-width: 440px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--t-bg);
  padding: var(--t-spacing-2xl);
}

.panel-inner {
  width: 408px;
  max-width: 100%;
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: 44px 40px 36px;
  box-shadow: var(--t-elevation-2);
  animation: cardIn 0.3s var(--t-ease-standard) 40ms both;
}

@keyframes cardIn {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}

// 小标签（eyebrow）：用 text-2 保证浅色背景下 AA 对比度
.panel-eyebrow {
  font-size: var(--t-fs-2xs);
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--t-text-2);
  margin-bottom: 10px;
}

.panel-title {
  font-size: var(--t-fs-3xl);
  font-weight: 700;
  color: var(--t-text-1);
  margin: 0 0 6px;
  letter-spacing: -0.01em;
}

.panel-sub {
  font-size: var(--t-fs-base);
  color: var(--t-text-3);
  margin: 0 0 32px;
}

.panel-footer {
  font-size: var(--t-fs-xs);
  color: var(--t-text-faint);
  text-align: center;
  margin: 22px 0 0;
  line-height: 1.6;
}

// ============ 字段与入场动效 ============
// 每个字段块按 --i 错峰淡入，满足 MOTION_INTENSITY > 4 的"页面真的在动"
.field-block {
  animation: fieldIn 0.28s var(--t-ease-standard) both;
  animation-delay: calc(var(--i, 0) * 60ms + 100ms);
}

@keyframes fieldIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.field-label {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
  margin-bottom: 8px;
  font-weight: 600;
}

// 输入框
:deep(.el-input__wrapper) {
  background: var(--t-input-bg);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
  box-shadow: none;
  transition: border-color 0.2s ease-out, box-shadow 0.2s ease-out, background-color 0.2s ease-out;
  padding: 2px 14px;
}

:deep(.el-input__wrapper.is-focus) {
  border-color: var(--t-accent-line);
  background: var(--t-bg-overlay);
  box-shadow: 0 0 0 3px var(--t-accent-bg);
}

:deep(.el-input__inner) {
  color: var(--t-text-1);
  height: 48px;
  font-size: var(--t-fs-base);
}

:deep(.el-input__inner::placeholder) {
  color: var(--t-text-3);
}

:deep(.el-input__prefix) {
  color: var(--t-text-3);
}

:deep(.el-form-item) {
  margin-bottom: var(--t-spacing-lg);
}

:deep(.el-form-item__error) {
  color: var(--t-danger-text);
}

// ============ 角色选择 ============
.role-group {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 26px;
}

.role-chip {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 14px 6px 12px;
  border-radius: var(--t-radius-md);
  background: var(--t-input-bg);
  border: 1px solid var(--t-line);
  color: var(--t-text-2);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.16s ease-out, background-color 0.16s ease-out, color 0.16s ease-out, transform 0.16s ease-out;
  user-select: none;

  &:hover {
    background: var(--t-surface-hover);
    border-color: var(--t-accent-line);
  }

  &:active {
    transform: scale(0.97);
  }

  // 选中态顶部强调色条，作为视觉锚点
  &.active {
    background: var(--t-accent-bg);
    border-color: var(--t-accent-line);
    color: var(--t-accent-strong);

    &::after {
      content: '';
      position: absolute;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      width: 24px;
      height: 3px;
      border-radius: 0 0 var(--t-radius-sm) var(--t-radius-sm);
      background: var(--t-accent);
    }

    :deep(.el-icon) {
      color: var(--t-accent-strong);
    }
  }
}

// ============ 登录按钮 ============
.login-btn {
  width: 100%;
  height: 50px;
  border-radius: var(--t-radius-md);
  background: var(--t-accent);
  border: none;
  color: #fff;
  font-size: var(--t-fs-base);
  font-weight: 600;
  letter-spacing: 0.06em;
  box-shadow: none;
  transition: transform 0.16s ease-out, box-shadow 0.16s ease-out, opacity 0.16s ease-out, background-color 0.16s ease-out;

  &:hover {
    background: var(--t-accent-strong);
    box-shadow: var(--t-elevation-accent);
    transform: translateY(-1px);
  }

  &:active {
    transform: scale(0.98);
  }
}

// ============ 响应式 ============
@media (max-width: 900px) {
  .login-page {
    flex-direction: column;
  }

  .login-brand {
    display: none;
  }

  .login-panel {
    min-width: 0;
    padding: 32px 24px;
  }

  .panel-inner {
    padding: 36px 28px 30px;
  }
}

// ============ 降低动态偏好（可访问性） ============
@media (prefers-reduced-motion: reduce) {
  .brand-inner,
  .panel-inner,
  .field-block {
    animation: none !important;
  }

  .role-chip,
  .login-btn {
    transition: none !important;
  }
}
</style>
