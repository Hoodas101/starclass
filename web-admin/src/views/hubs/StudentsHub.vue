<template>
  <div class="hub-page">
    <PageHeader :title="`${$t('learner')}档案`" />
    <el-tabs v-model="activeTab" class="hub-tabs" @tab-change="syncUrl">
      <el-tab-pane v-for="t in visibleTabs" :key="t.key" :name="t.key" :label="t.labelKey ? $t(t.labelKey) : t.label">
        <component v-if="activeTab === t.key" :is="t.comp" :embedded="true" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import StudentsView from '@/views/students/index.vue'
import PointsView from '@/views/points/index.vue'
import { usePerm } from '@/composables/usePerm'

const route = useRoute()
const router = useRouter()
const { role, has } = usePerm()

const tabs = [
  { key: 'students', labelKey: 'learner', comp: StudentsView, roles: ['admin', 'coach', 'sales'], perm: 'students' },
  // W2 修复：积分页后端实际由 'growth' 键守卫（growth.js 的 canGrowth），前端此前错用 'points' 键，
  // 导致授予「积分管理」的员工打开积分页即 403。改为 'growth' 并放宽 roles 让销售可见（与 SalesHub 对齐）。
  { key: 'points', label: '积分', comp: PointsView, roles: ['admin', 'sales'], perm: 'growth' },
]
// W1 修复：见 OperationsHub —— 角色命中 且 有权限 才显示标签页
const visibleTabs = computed(() => tabs.filter((t) => t.roles.includes(role.value) && has(t.perm)))
const activeTab = ref('students')

const syncUrl = () => router.replace({ query: { ...route.query, tab: activeTab.value } })
onMounted(() => {
  const tab = route.query.tab
  if (tab && visibleTabs.value.some((t) => t.key === tab)) activeTab.value = tab
  else if (visibleTabs.value.length && !visibleTabs.value.some((t) => t.key === activeTab.value)) {
    activeTab.value = visibleTabs.value[0].key
  }
})
watch(route, (r) => {
  const tab = r.query.tab
  if (tab && visibleTabs.value.some((t) => t.key === tab)) activeTab.value = tab
})
</script>

<style scoped>
.hub-tabs :deep(.el-tabs__header) {
  margin-bottom: var(--t-spacing-lg);
}
</style>
