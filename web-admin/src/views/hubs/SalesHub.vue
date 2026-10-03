<template>
  <div class="hub-page">
    <PageHeader title="销售增长" />
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
import OrdersView from '@/views/orders/index.vue'
import GrowthView from '@/views/growth/index.vue'
import TrialView from '@/views/trial/index.vue'
import ProductsView from '@/views/products/index.vue'
import FinanceView from '@/views/finance/index.vue'
import { usePerm } from '@/composables/usePerm'

const route = useRoute()
const router = useRouter()
const { role, has } = usePerm()

const tabs = [
  { key: 'orders', label: '销售管理', comp: OrdersView, roles: ['admin', 'sales'], perm: 'sales' },
  { key: 'products', label: '产品服务', comp: ProductsView, roles: ['admin', 'sales'], perm: 'sales' },
  { key: 'finance', label: '财务报表', comp: FinanceView, roles: ['admin'], perm: 'dashboard' },
  { key: 'growth', label: '增长中心', comp: GrowthView, roles: ['admin', 'sales', 'coach'], perm: 'growth' },
  // 试听预约：后端 GET/PUT /api/trial 面向全体员工，但预约会自动生成增长中心线索，
  // 故与「增长中心」同角色、同权限键（sales 角色默认含 growth）
  { key: 'trial', label: '试听预约', comp: TrialView, roles: ['admin', 'sales', 'coach'], perm: 'growth' },
]
// W1 修复：见 OperationsHub —— 角色命中 且 有权限 才显示标签页。
// 顺带消解 W3：finance 标签页 roles:['admin']，销售即便持有 dashboard 也不会显示（财务报表纯管理员）。
const visibleTabs = computed(() => tabs.filter((t) => t.roles.includes(role.value) && has(t.perm)))
const activeTab = ref('orders')

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
