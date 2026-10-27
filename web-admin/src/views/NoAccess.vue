<template>
  <div class="no-access">
    <div class="no-access__icon" aria-hidden="true">
      <el-icon :size="44"><Lock /></el-icon>
    </div>
    <h2 class="no-access__title">暂无可访问的功能</h2>
    <p class="no-access__desc">
      当前账号没有被分配任何功能权限，因此没有可进入的页面。<br />
      请联系机构管理员在「团队管理」中为该账号勾选所需功能后重新登录。
    </p>
    <div class="no-access__actions">
      <el-button :icon="Refresh" @click="reload">重新加载</el-button>
      <el-button type="primary" @click="logout">退出登录</el-button>
    </div>
  </div>
</template>

<script setup>
import { Refresh, Lock } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'

const router = useRouter()
const userStore = useUserStore()

// 权限是在登录时下发并缓存在本地的：管理员改完权限后，重新登录即可拿到新清单，
// 单纯刷新页面不会重新拉取。
const reload = () => window.location.reload()

const logout = () => {
  userStore.logout()
  router.push('/login')
}
</script>

<style scoped>
.no-access {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  padding: 40px 24px;
  text-align: center;
  box-sizing: border-box;
}
.no-access__icon {
  color: var(--t-text-faint);
  margin-bottom: 14px;
}
.no-access__title {
  margin: 0 0 10px;
  font-size: var(--t-fs-xl);
  font-weight: 600;
  color: var(--t-text-1);
}
.no-access__desc {
  margin: 0 0 22px;
  max-width: 460px;
  font-size: var(--t-fs-base);
  line-height: 1.7;
  color: var(--t-text-3);
}
.no-access__actions {
  display: flex;
  gap: 12px;
}
</style>
