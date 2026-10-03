<template>
  <div class="profile-page">
    <PageHeader title="个人设置" />
    <div class="page-shell page-shell--narrow">
      <!-- 强制改密提示：仅当登录响应标记 mustChangePassword 为真时出现（此时后端会对业务接口返回 4031） -->
      <el-alert
        v-if="userStore.mustChangePassword"
        type="warning"
        show-icon
        :closable="false"
        title="当前使用的是系统默认口令，修改后才能正常使用系统"
        style="margin-bottom: var(--t-spacing-lg)"
      />

      <!-- 账号信息 -->
      <div class="profile-section">
        <h3 class="section-title">账号信息</h3>
        <p class="section-desc">手机号可在此自行修改，保存后立即生效（同时用于登录，请确保号码可正常使用）。</p>
        <el-descriptions :column="1" border class="profile-desc">
          <el-descriptions-item label="姓名">{{ userStore.userName }}</el-descriptions-item>
          <el-descriptions-item label="角色">{{ roleLabel }}</el-descriptions-item>
        </el-descriptions>

        <!-- 手机号此前只读、页面要求「联系管理员」：但后端 /auth/updateProfile 已完整支持改号
             （格式校验、双重占用检查、openid 跨表迁移），前端零调用。此处接入。 -->
        <el-form
          ref="phoneFormRef"
          :model="phoneForm"
          :rules="phoneRules"
          label-width="auto"
          label-position="left"
          style="max-width: 480px; margin-top: var(--t-spacing-lg)"
        >
          <el-form-item label="手机号" prop="phone">
            <el-input v-model="phoneForm.phone" maxlength="11" placeholder="请输入11位手机号" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="phoneSaving" @click="submitPhone">保存手机号</el-button>
          </el-form-item>
        </el-form>
      </div>

      <!-- 修改密码 -->
      <div class="profile-section">
        <h3 class="section-title">修改密码</h3>
        <p class="section-desc">修改后其他设备上的登录状态立即失效，当前设备保持登录。</p>

        <el-form
          ref="passwordFormRef"
          :model="passwordForm"
          :rules="passwordRules"
          label-width="auto"
          label-position="left"
          style="max-width: 480px"
        >
          <el-form-item label="原密码" prop="oldPassword">
            <el-input
              v-model="passwordForm.oldPassword"
              type="password"
              show-password
              placeholder="请输入原密码"
              maxlength="20"
            />
          </el-form-item>
          <el-form-item label="新密码" prop="newPassword">
            <el-input
              v-model="passwordForm.newPassword"
              type="password"
              show-password
              placeholder="6-20 位新密码"
              maxlength="20"
            />
          </el-form-item>
          <el-form-item label="确认新密码" prop="confirmPassword">
            <el-input
              v-model="passwordForm.confirmPassword"
              type="password"
              show-password
              placeholder="再次输入新密码"
              maxlength="20"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="passwordSaving" @click="submitPassword">
              修改密码
            </el-button>
          </el-form-item>
        </el-form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { changePassword, updateProfile } from '@/api/modules'
import { useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'
import PageHeader from '@/components/PageHeader.vue'

const userStore = useUserStore()
const settingsStore = useSettingsStore()

// 角色徽标称呼跟随机构术语方案（教培版显示「老师」、健身版显示「教练」等），与全站统一；未知角色回退原值
const roleLabel = computed(() => settingsStore.roleLabel(userStore.userRole) || userStore.userRole || '—')

// 手机号自助修改
const phoneFormRef = ref(null)
const phoneSaving = ref(false)
const phoneForm = reactive({ phone: userStore.userInfo.phone || '' })
// 仅做基础格式提示（与后端一致）；占用冲突/跨表迁移等以后端为准，不在前端重复实现
const phoneRules = {
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1\d{10}$/, message: '请输入正确的11位手机号', trigger: 'blur' }
  ]
}

const submitPhone = async () => {
  if (!phoneFormRef.value) return
  const valid = await phoneFormRef.value.validate().catch(() => false)
  if (!valid) return
  const next = phoneForm.phone.trim()
  if (next === (userStore.userInfo.phone || '')) {
    ElMessage.info('手机号未变化')
    return
  }
  phoneSaving.value = true
  try {
    const data = await updateProfile({ phone: next })
    // 后端改号会重签 Token（openid 可能随手机号变化）：必须立即替换，否则下一次请求 401 被登出
    userStore.setToken(data?.token)
    await userStore.getUserInfo()
    phoneForm.phone = userStore.userInfo.phone || next
    ElMessage.success('手机号已更新')
  } catch (e) {
    // 失败保留已填内容；拦截器已展示后端返回的具体原因（如「该手机号已被其他账号使用」）
  } finally {
    phoneSaving.value = false
  }
}

const passwordFormRef = ref(null)
const passwordSaving = ref(false)
const passwordForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: ''
})
const passwordRules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, max: 20, message: '密码长度为 6-20 位', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (value !== passwordForm.newPassword) callback(new Error('两次输入的密码不一致'))
        else callback()
      },
      trigger: 'blur'
    }
  ]
}

const submitPassword = async () => {
  if (!passwordFormRef.value) return
  await passwordFormRef.value.validate(async (valid) => {
    if (!valid) return
    passwordSaving.value = true
    try {
      const data = await changePassword({
        oldPassword: passwordForm.oldPassword,
        newPassword: passwordForm.newPassword
      })
      // 后端改密同时 bump token_version 并签发新 Token：必须立即替换本地 Token，
      // 否则旧 Token 在下一次请求就会被 401 拒绝并强制登出（本页曾经的缺陷）。
      userStore.setToken(data?.token)
      // 改密成功：解除「仍是默认口令」标记，顶部警示条随之消失
      userStore.clearMustChangePassword()
      ElMessage.success('密码修改成功')
      passwordForm.oldPassword = ''
      passwordForm.newPassword = ''
      passwordForm.confirmPassword = ''
    } catch (error) {
      // 拦截器已提示业务/网络错误
    } finally {
      passwordSaving.value = false
    }
  })
}
</script>

<style scoped>
.profile-section {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: var(--t-spacing-lg);
  margin-bottom: var(--t-spacing-lg);
}

.section-desc {
  margin: 0 0 var(--t-spacing-md);
  color: var(--t-text-3);
  font-size: var(--t-fs-sm);
}

.profile-desc {
  max-width: 480px;
}
</style>
