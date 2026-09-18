<template>
  <div class="page-shell page-shell--narrow">
    <PageHeader v-if="!embedded" title="财务报表" />
    <!-- 单一工具栏：二级下拉切换报表视图，避免双 tab 栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <el-select v-model="activeMode" style="width: 120px">
          <el-option label="月度报表" value="monthly" />
          <el-option label="产品收入" value="product" />
          <el-option label="销售业绩" value="sales" />
        </el-select>
        <el-radio-group v-model="period" @change="onPeriodChange">
          <el-radio-button value="month">本月</el-radio-button>
          <el-radio-button value="quarter">本季度</el-radio-button>
          <el-radio-button value="year">本年</el-radio-button>
          <el-radio-button value="custom">自定义</el-radio-button>
        </el-radio-group>
        <el-date-picker v-if="period === 'custom'" v-model="dateRange" type="daterange" range-separator="至" start-placeholder="开始" end-placeholder="结束" value-format="YYYY-MM-DD" style="width: 260px" @change="loadSummary" />
        <el-select v-if="activeMode === 'monthly'" v-model="reportYear" style="width: 100px" @change="loadMonthly">
          <el-option v-for="y in yearOptions" :key="y" :label="y + '年'" :value="y" />
        </el-select>
      </div>
      <div class="toolbar-right">
        <el-button type="primary" @click="loadAll">刷新</el-button>
      </div>
    </div>

    <!-- 汇总卡片 -->
    <div class="metric-row">
      <div class="metric-card">
        <div class="stat-label">总收入</div>
        <div class="stat-value">¥{{ fmt(summary.revenue?.gross || 0) }}</div>
        <div class="stat-sub">{{ summary.orders?.paid || 0 }} 笔订单</div>
      </div>
      <div class="metric-card">
        <div class="stat-label">退款</div>
        <div class="stat-value danger">¥{{ fmt(summary.revenue?.refunded || 0) }}</div>
        <div class="stat-sub">{{ summary.orders?.refunded || 0 }} 笔退款</div>
      </div>
      <div class="metric-card">
        <div class="stat-label">净收入</div>
        <div class="stat-value success">¥{{ fmt(summary.revenue?.net || 0) }}</div>
        <div class="stat-sub">扣除退款后</div>
      </div>
      <div class="metric-card">
        <div class="stat-label">教师支出</div>
        <div class="stat-value warning">¥{{ fmt(summary.expense?.coachPay || 0) }}</div>
        <div class="stat-sub">利润 ¥{{ fmt(summary.profit || 0) }}</div>
      </div>
    </div>

    <!-- 月度报表 -->
    <div v-if="activeMode === 'monthly'" class="card table-container">
      <ListErrorState v-if="!loadingMonthly && errorMonthly" :error="errorMonthly" @retry="loadMonthly" />
      <el-table v-else :data="monthlyData" v-loading="loadingMonthly" size="small">
        <el-table-column label="月份" prop="month" min-width="80" />
        <el-table-column label="收入" min-width="120">
          <template #default="{ row }">¥{{ fmt(row.revenue) }}</template>
        </el-table-column>
        <el-table-column label="优惠" min-width="100">
          <template #default="{ row }">¥{{ fmt(row.discount) }}</template>
        </el-table-column>
        <el-table-column label="退款" min-width="100">
          <template #default="{ row }">¥{{ fmt(row.refunded) }}</template>
        </el-table-column>
        <el-table-column label="净收入" min-width="120">
          <template #default="{ row }"><strong>¥{{ fmt(row.netRevenue) }}</strong></template>
        </el-table-column>
        <el-table-column label="教师支出" min-width="120">
          <template #default="{ row }">¥{{ fmt(row.coachPay) }}</template>
        </el-table-column>
        <el-table-column label="利润" min-width="120">
          <template #default="{ row }"><span :class="{ positive: row.profit > 0, negative: row.profit < 0 }">¥{{ fmt(row.profit) }}</span></template>
        </el-table-column>
        <el-table-column label="订单数" prop="orderCount" min-width="80" />
      </el-table>
      <div v-if="monthlyTotals" class="totals-row">
        <span>全年合计：收入 ¥{{ fmt(monthlyTotals.revenue) }} | 净收入 ¥{{ fmt(monthlyTotals.netRevenue) }} | 利润 ¥{{ fmt(monthlyTotals.profit) }} | 订单 {{ monthlyTotals.orderCount }} 笔</span>
      </div>
    </div>

    <!-- 按产品统计 -->
    <div v-if="activeMode === 'product'" class="card table-container">
      <ListErrorState v-if="!loadingProduct && errorProduct" :error="errorProduct" @retry="loadProduct" />
      <el-table v-else :data="productList" v-loading="loadingProduct" size="small">
        <el-table-column label="产品名称" prop="name" min-width="150" />
        <el-table-column label="销售数量" prop="count" min-width="100" />
        <el-table-column label="收入" min-width="120">
          <template #default="{ row }">¥{{ fmt(row.revenue) }}</template>
        </el-table-column>
        <el-table-column label="退款" min-width="100">
          <template #default="{ row }">¥{{ fmt(row.refunded) }}</template>
        </el-table-column>
        <el-table-column label="净收入" min-width="120">
          <template #default="{ row }"><strong>¥{{ fmt(row.net) }}</strong></template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 按销售统计 -->
    <div v-if="activeMode === 'sales'" class="card table-container">
      <ListErrorState v-if="!loadingSales && errorSales" :error="errorSales" @retry="loadSales" />
      <el-table v-else :data="salesList" v-loading="loadingSales" size="small">
        <el-table-column label="销售" prop="salesperson" min-width="100" />
        <el-table-column label="订单数" prop="orderCount" min-width="100" />
        <el-table-column label="总收入" min-width="120">
          <template #default="{ row }">¥{{ fmt(row.revenue) }}</template>
        </el-table-column>
        <el-table-column label="退款" min-width="100">
          <template #default="{ row }">¥{{ fmt(row.refunded) }}</template>
        </el-table-column>
        <el-table-column label="净收入" min-width="120">
          <template #default="{ row }"><strong>¥{{ fmt(row.net) }}</strong></template>
        </el-table-column>
        <el-table-column label="VIP订单" prop="vipCount" min-width="80" />
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { getFinanceSummary, getFinanceMonthly, getFinanceByProduct, getFinanceBySales } from '@/api/modules'
import PageHeader from '@/components/PageHeader.vue'

defineProps({ embedded: Boolean })

const period = ref('month')
const dateRange = ref(null)
const activeMode = ref('monthly')

const summary = ref({})
const loadingSummary = ref(false)

const monthlyData = ref([])
const monthlyTotals = ref(null)
const loadingMonthly = ref(false)
const reportYear = ref(new Date().getFullYear())
const yearOptions = computed(() => {
  const years = []
  for (let y = new Date().getFullYear(); y >= 2024; y--) years.push(y)
  return years
})

const productList = ref([])
const loadingProduct = ref(false)
const salesList = ref([])
const loadingSales = ref(false)

function fmt(n) {
  return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function getDateRange() {
  const now = new Date()
  // 本地日期拼接（toISOString 为 UTC，东八区会把 endDate 算成昨天，导致今日数据被排除）
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (period.value === 'month') {
    return {
      startDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
      endDate: today,
    }
  } else if (period.value === 'quarter') {
    const q = Math.floor(now.getMonth() / 3)
    return {
      startDate: `${now.getFullYear()}-${String(q * 3 + 1).padStart(2, '0')}-01`,
      endDate: today,
    }
  } else if (period.value === 'year') {
    return {
      startDate: `${now.getFullYear()}-01-01`,
      endDate: today,
    }
  } else if (dateRange.value) {
    return { startDate: dateRange.value[0], endDate: dateRange.value[1] }
  }
  return {}
}

function onPeriodChange() {
  if (period.value !== 'custom') loadSummary()
}

async function loadSummary() {
  loadingSummary.value = true
  try {
    const res = await getFinanceSummary(getDateRange())
    summary.value = res || {}
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    loadingSummary.value = false
  }
}

const errorMonthly = ref('')

async function loadMonthly() {
  errorMonthly.value = ''
  loadingMonthly.value = true
  try {
    const res = await getFinanceMonthly({ year: reportYear.value })
    monthlyData.value = res.months || []
    monthlyTotals.value = res.totals || null
  } catch (e) {
    errorMonthly.value = e?.message || '数据加载失败，请稍后重试'
  } finally {
    loadingMonthly.value = false
  }
}

const errorProduct = ref('')

async function loadProduct() {
  errorProduct.value = ''
  loadingProduct.value = true
  try {
    const res = await getFinanceByProduct(getDateRange())
    productList.value = res.list || []
  } catch (e) {
    errorProduct.value = e?.message || '数据加载失败，请稍后重试'
  } finally {
    loadingProduct.value = false
  }
}

const errorSales = ref('')

async function loadSales() {
  errorSales.value = ''
  loadingSales.value = true
  try {
    const res = await getFinanceBySales(getDateRange())
    salesList.value = res.list || []
  } catch (e) {
    errorSales.value = e?.message || '数据加载失败，请稍后重试'
  } finally {
    loadingSales.value = false
  }
}

function loadAll() {
  loadSummary()
  loadMonthly()
  loadProduct()
  loadSales()
}

onMounted(() => loadAll())
</script>

<style lang="scss" scoped>
.metric-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-top: var(--t-spacing-lg);
}
.metric-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: 24px;
  text-align: center;
}
.stat-label {
  font-size: var(--t-fs-sm);
  color: var(--t-text-3);
  margin-bottom: 8px;
}
.stat-value {
  font-size: var(--t-fs-2xl);
  font-weight: 700;
  color: var(--t-text-1);
  font-variant-numeric: tabular-nums;
}
.stat-value.danger { color: var(--t-danger-text); }
.stat-value.success { color: var(--t-success-text); }
.stat-value.warning { color: var(--t-warning-text); }
.stat-sub {
  font-size: var(--t-fs-xs);
  color: var(--t-text-faint);
  margin-top: 4px;
}
.totals-row {
  margin-top: 12px;
  padding: 12px 16px;
  background: var(--t-surface-hover);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
}
.positive { color: var(--t-success-text); }
.negative { color: var(--t-danger-text); }
</style>
