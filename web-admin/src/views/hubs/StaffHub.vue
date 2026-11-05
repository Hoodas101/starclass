<template>
  <div class="hub-page">
    <PageHeader title="团队管理" />
    <el-tabs v-model="activeTab" class="hub-tabs" @tab-change="syncUrl">
      <el-tab-pane v-for="t in visibleTabs" :key="t.key" :name="t.key" :label="t.labelKey ? $t(t.labelKey) + '课时' : t.label">
        <component v-if="activeTab === t.key" :is="t.comp" :embedded="true" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import StaffView from '@/views/staff/index.vue'
import CoachStatsView from '@/views/coach-stats/index.vue'
import { usePerm } from '@/composables/usePerm'

const route = useRoute()
const router = useRouter()
const { role, has } = usePerm()

const tabs = [
  { key: 'staff', label: '员工', comp: StaffView, roles: ['admin'], perm: 'staff' },
  { key: 'coachstats', labelKey: 'instructor', comp: CoachStatsView, roles: ['admin', 'coach'], perm: 'coachstats' },
]
// W1 修复：见 OperationsHub —— 角色命中 且 有权限 才显示标签页
const visibleTabs = computed(() => tabs.filter((t) => t.roles.includes(role.value) && has(t.perm)))
const activeTab = ref('staff')

const syncUrl = () => router.replace({ query: { ...route.query, tab: activeTab.value } })
onMounted(() => {
  const tab = route.query.tab
  if (tab && visibleTabs.value.some((t) => t.key === tab)) { activeTab.value = tab; return }
  // B5：强开不可见页签时内容已回退，但 URL 未同步会导致「地址显示 A、内容是 B」。
  // 仅在 URL 带了不可见 tab 时修正，无 tab 参数的正常进入不受影响
  if (tab && visibleTabs.value.length) {
    activeTab.value = visibleTabs.value[0].key
    router.replace({ query: { ...route.query, tab: activeTab.value } })
    return
  }
  if (visibleTabs.value.length && !visibleTabs.value.some((t) => t.key === activeTab.value)) {
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
