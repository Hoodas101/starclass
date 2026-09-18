<template>
  <div class="profile-page">
    <PageHeader title="个人设置" />
    <div class="page-shell page-shell--narrow">
      <!-- 账号信息 -->
      <div class="profile-section">
        <h3 class="section-title">账号信息</h3>
        <p class="section-desc">当前登录账号。姓名与手机号如需变更，请联系管理员。</p>
        <el-descriptions :column="1" border class="profile-desc">
          <el-descriptions-item label="姓名">{{ userStore.userName }}</el-descriptions-item>
          <el-descriptions-item label="角色">{{ roleLabel }}</el-descriptions-item>
          <el-descriptions-item label="手机号">{{ phone || '—' }}</el-descriptions-item>
        </el-descriptions>
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
import { changePassword } from '@/api/modules'
import { useUserStore } from '@/store/user'
import PageHeader from '@/components/PageHeader.vue'

const userStore = useUserStore()
const settingsStore = useSettingsStore()

// 角色徽标称呼跟随机构术语方案（教培版显示「老师」、健身版显示「教练」等），与全站统一；未知角色回退原值
const roleLabel = computed(() => settingsStore.roleLabel(userStore.userRole) || userStore.userRole || '—')
const phone = computed(() => userStore.userInfo.phone || '')

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
      ElMessage.success('密码修改成功')
      passwordForm.oldPassword = ''
      passwordForm.newPassword = ''
      passwordForm.confirmPassword = ''
    } catch (error) {
      ElMessage.error(error.message || '修改失败')
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
