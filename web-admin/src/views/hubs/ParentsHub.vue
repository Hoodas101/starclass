<template>
  <div class="hub-page">
    <PageHeader title="家校沟通" />
    <el-tabs v-model="activeTab" class="hub-tabs" @tab-change="syncUrl">
      <el-tab-pane v-for="t in visibleTabs" :key="t.key" :name="t.key" :label="t.label">
        <component v-if="activeTab === t.key" :is="t.comp" :embedded="true" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import ParentsView from '@/views/parents/index.vue'
import NotificationsView from '@/views/notifications/index.vue'
import FeedbackView from '@/views/feedback/index.vue'
import { usePerm } from '@/composables/usePerm'

const route = useRoute()
const router = useRouter()
const { role, has } = usePerm()

const tabs = [
  { key: 'parents', label: '家长通讯录', comp: ParentsView, roles: ['admin'], perm: 'parents' },
  { key: 'notifications', label: '通知中心', comp: NotificationsView, roles: ['admin'], perm: 'notice' },
  { key: 'feedback', label: '意见反馈', comp: FeedbackView, roles: ['admin'], perm: 'feedback' },
]
// W1 修复：见 OperationsHub —— 角色命中 且 有权限 才显示标签页
const visibleTabs = computed(() => tabs.filter((t) => t.roles.includes(role.value) && has(t.perm)))
const activeTab = ref('parents')

const syncUrl = () => {
  router.replace({ query: { ...route.query, tab: activeTab.value } })
}

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
