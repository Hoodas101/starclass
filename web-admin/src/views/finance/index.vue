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
        <el-date-picker v-if="period === 'custom'" v-model="dateRange" type="daterange" range-separator="至" start-placeholder="开始" end-placeholder="结束" value-format="YYYY-MM-DD" style="width: 260px" @change="loadAll" />
        <el-select v-if="activeMode === 'monthly'" v-model="reportYear" style="width: 100px" @change="loadMonthly">
          <el-option v-for="y in yearOptions" :key="y" :label="y + '年'" :value="y" />
        </el-select>
      </div>
      <div class="toolbar-right">
        <el-button :icon="Download" @click="doExport">导出</el-button>
        <el-button type="primary" @click="loadAll">刷新</el-button>
      </div>
    </div>

    <!-- 汇总卡片 -->
    <div class="metric-row">
      <div class="metric-card">
        <div class="stat-label">总收入</div>
        <div class="stat-value num-display is-md">¥{{ fmt(summary.revenue?.gross || 0) }}</div>
        <div class="stat-sub">{{ summary.orders?.paid || 0 }} 笔订单</div>
      </div>
      <div class="metric-card">
        <div class="stat-label">退款</div>
        <div class="stat-value danger num-display is-md">¥{{ fmt(summary.revenue?.refunded || 0) }}</div>
        <div class="stat-sub">{{ summary.orders?.refunded || 0 }} 笔退款</div>
      </div>
      <div class="metric-card">
        <div class="stat-label">净收入</div>
        <div class="stat-value success num-display is-md">¥{{ fmt(summary.revenue?.net || 0) }}</div>
        <div class="stat-sub">扣除退款后</div>
      </div>
      <div class="metric-card">
        <div class="stat-label">教师支出</div>
        <div class="stat-value warning num-display is-md">¥{{ fmt(summary.expense?.coachPay || 0) }}</div>
        <div class="stat-sub">利润 ¥{{ fmt(summary.profit || 0) }}</div>
      </div>
    </div>

    <!-- 视图栏：报表三张表共用一套列配置（按 activeMode 切换列定义） -->
    <div class="finance-viewbar">
      <TableViewBar
        :views="viewList"
        :active-id="activeViewId"
        @select="(id) => applyView(id)"
        @create="(name) => createView(name)"
        @rename="renameView"
        @remove="removeView"
      />
      <ColumnSettingsDialog
        title="报表字段设置"
        :columns="financeDefs"
        v-model:settings="financeSettings"
        :defaults="FINANCE_DEFAULTS"
        :widths="customWidths"
        :auto-width="autoColumnWidth"
        @update:widths="onWidthsChange"
        @update:auto-width="onAutoWidthChange"
        @reset-widths="resetWidths"
        @save="onSettingsSave"
      />
    </div>

    <!-- 明细表：三张报表同构（文本 + 金额），列由 financeDefs 驱动，接入排序 / 列宽 / 视图 -->
    <div class="card table-container">
      <ListErrorState v-if="!activeLoading && activeError" :error="activeError" @retry="reloadActive" />
      <el-table v-else :data="financeSorted" v-loading="activeLoading" size="small">
        <el-table-column
          v-for="col in financeVisible"
          :key="col.key"
          :label="col.label"
          :width="financeWidths[col.key] && financeWidths[col.key].width"
          :min-width="financeWidths[col.key] && financeWidths[col.key].minWidth"
          :align="col.align"
        >
          <template #header>
            <SortableHeader
              :label="col.label"
              :align="col.align"
              :state="sortState(col.key)"
              :priority="sortPriority(col.key)"
              @sort="(e) => onSort(col.key, e)"
              @resize="(w) => onResize(col.key, w)"
            />
          </template>
          <template #default="{ row }">
            <strong v-if="col.strong">¥{{ fmt(row[col.key]) }}</strong>
            <span
              v-else-if="col.kind === 'signed'"
              :class="{ positive: row[col.key] > 0, negative: row[col.key] < 0 }"
            >¥{{ fmt(row[col.key]) }}</span>
            <template v-else-if="col.kind === 'money'">¥{{ fmt(row[col.key]) }}</template>
            <template v-else>{{ row[col.key] }}</template>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="activeMode === 'monthly' && monthlyTotals" class="totals-row">
        <span>全年合计：收入 ¥{{ fmt(monthlyTotals.revenue) }} | 净收入 ¥{{ fmt(monthlyTotals.netRevenue) }} | 利润 ¥{{ fmt(monthlyTotals.profit) }} | 订单 {{ monthlyTotals.orderCount }} 笔</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { getFinanceSummary, getFinanceMonthly, getFinanceByProduct, getFinanceBySales } from '@/api/modules'
import { formatMoney } from '@/utils/format'
import { exportXlsx } from '@/utils/xlsx'
import { Download } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import PageHeader from '@/components/PageHeader.vue'
import SortableHeader from '@/components/SortableHeader.vue'
import TableViewBar from '@/components/TableViewBar.vue'
import ColumnSettingsDialog from '@/components/ColumnSettingsDialog.vue'
import { useTableKit, headerExtra } from '@/composables/useTableKit'

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

// 金额口径统一走 @/utils/format：全站整数元 + 千分位。
// 此前本页强制 2 位小数（¥2,999.00），与订单页的 ¥2,999 不一致，用户会以为金额变了。
// 保留无 ¥ 前缀的调用形态（模板已写 ¥{{ fmt(...) }}），故 symbol 关掉。
function fmt(n) {
  return formatMoney(n, { symbol: false, fallback: '0' })
}

// ── 多维表格：三张报表同构（文本 + 金额），共用一套列配置 ──
// kind 驱动单元格渲染（money 带 ¥、signed 带涨跌色、text 原样、strong 加粗）
const FINANCE_DEFS = {
  monthly: [
    { key: 'month', label: '月份', minWidth: 80, kind: 'text' },
    { key: 'revenue', label: '收入', minWidth: 120, kind: 'money' },
    { key: 'discount', label: '优惠', minWidth: 100, kind: 'money' },
    { key: 'refunded', label: '退款', minWidth: 100, kind: 'money' },
    { key: 'netRevenue', label: '净收入', minWidth: 120, kind: 'money', strong: true },
    { key: 'coachPay', label: '教师支出', minWidth: 120, kind: 'money' },
    { key: 'profit', label: '利润', minWidth: 120, kind: 'signed' },
    { key: 'orderCount', label: '订单数', minWidth: 80, kind: 'text' },
  ],
  product: [
    { key: 'name', label: '产品名称', minWidth: 150, kind: 'text' },
    { key: 'count', label: '销售数量', minWidth: 100, kind: 'text' },
    { key: 'revenue', label: '收入', minWidth: 120, kind: 'money' },
    { key: 'refunded', label: '退款', minWidth: 100, kind: 'money' },
    { key: 'net', label: '净收入', minWidth: 120, kind: 'money', strong: true },
  ],
  sales: [
    { key: 'salesperson', label: '销售', minWidth: 100, kind: 'text' },
    { key: 'orderCount', label: '订单数', minWidth: 100, kind: 'text' },
    { key: 'revenue', label: '总收入', minWidth: 120, kind: 'money' },
    { key: 'refunded', label: '退款', minWidth: 100, kind: 'money' },
    { key: 'net', label: '净收入', minWidth: 120, kind: 'money', strong: true },
    { key: 'vipCount', label: 'VIP订单', minWidth: 80, kind: 'text' },
  ],
}
const FINANCE_DEFAULTS = Object.fromEntries(
  Object.values(FINANCE_DEFS).flat().map((c) => [c.key, true])
)

const financeDefs = computed(() => FINANCE_DEFS[activeMode.value] || [])
const financeRows = computed(() => ({
  monthly: monthlyData.value,
  product: productList.value,
  sales: salesList.value,
}[activeMode.value] || []))

// 当前模式对应的加载/错误/重试（三张表各自一套，切模式时跟随）
const activeLoading = computed(() => ({
  monthly: loadingMonthly.value, product: loadingProduct.value, sales: loadingSales.value,
}[activeMode.value] || false))
const activeError = computed(() => ({
  monthly: errorMonthly.value, product: errorProduct.value, sales: errorSales.value,
}[activeMode.value] || ''))
const reloadActive = () => ({
  monthly: loadMonthly, product: loadProduct, sales: loadSales,
}[activeMode.value] || loadMonthly)()

const FINANCE_MODE_LABEL = { monthly: '月度报表', product: '产品收入', sales: '销售业绩' }

// 导出当前视图：可见列 + 当前排序结果。金额列输出**纯数字**（不带 ¥ / 千分位），
// 便于 Excel 直接求和做账；其余列原样输出。
const doExport = () => {
  const cols = financeVisible.value
  const rows = financeSorted.value
  if (!cols.length || !rows.length) {
    ElMessage.warning('当前视图暂无可导出的数据')
    return
  }
  const headers = cols.map((c) => c.label)
  const data = rows.map((row) => cols.map((c) => {
    const v = row[c.key]
    if (c.kind === 'money' || c.kind === 'signed') return Number(v || 0)
    return v == null ? '' : v
  }))
  const mode = FINANCE_MODE_LABEL[activeMode.value] || '报表'
  exportXlsx(`财务报表_${mode}_${dayjs().format('YYYYMMDD')}`, headers, data, { sheetName: mode })
  ElMessage.success(`已导出 ${data.length} 行`)
}

const financeText = (col, row) => {
  const v = row[col.key]
  if (col.kind === 'money' || col.kind === 'signed') return `¥${fmt(v)}`
  return v == null ? '' : String(v)
}
const financeSortValue = (key, row) => {
  const col = financeDefs.value.find((c) => c.key === key)
  const v = row[key]
  if (col && (col.kind === 'money' || col.kind === 'signed')) return Number(v || 0)
  return v
}

// 解构出顶层 ref：模板里可直接用（顶层 ref 会自动解包）
const {
  settings: financeSettings, visibleDefs: financeVisible, colWidths: financeWidths,
  sortedRows: financeSorted, sortState, sortPriority, onSort, onResize,
  customWidths, autoColumnWidth, onWidthsChange, onAutoWidthChange, resetWidths,
  viewList, activeViewId, applyView, createView, renameView, removeView, load: loadTableKit, onSettingsSave,
} = useTableKit({
  settingsKey: 'finance_columns',
  defs: () => financeDefs.value,
  rows: financeRows,
  textOf: financeText,
  getValue: financeSortValue,
  defaults: FINANCE_DEFAULTS,
  extraOf: headerExtra,
  viewLabels: { __all__: '全部报表' },
})

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
  // 切换统计周期必须整页刷新：此前只调 loadSummary()，两张明细表滞留旧周期，
  // 同屏出现汇总「本年」、明细「本月」的矛盾口径，可致错误决策。
  if (period.value !== 'custom') loadAll()
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

onMounted(() => {
  loadTableKit()
  loadAll()
})
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
  font-weight: 900;
  color: var(--t-text-1);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  letter-spacing: -0.04em;
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

.finance-viewbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
</style>
