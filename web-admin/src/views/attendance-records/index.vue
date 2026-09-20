<template>
  <div class="page-shell">
    <PageHeader v-if="!embedded" title="上课记录" />

    <!-- 筛选栏 -->
    <div class="toolbar">
      <div class="toolbar-left filters">
        <el-select
          v-model="filters.studentId"
          placeholder="成员"
          clearable
          filterable
          remote
          :remote-method="loadStudentOptions"
          style="width: 150px"
          @change="onFilterChange"
        >
          <el-option v-for="s in studentOptions" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-select
          v-model="filters.classId"
          placeholder="课程班级"
          clearable
          filterable
          remote
          :remote-method="loadCourseOptions"
          style="width: 160px"
          @change="onFilterChange"
        >
          <el-option v-for="c in courseOptions" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
        <el-select
          v-model="filters.teacherId"
          placeholder="教练"
          clearable
          filterable
          remote
          :remote-method="loadTeacherOptions"
          style="width: 140px"
          @change="onFilterChange"
        >
          <el-option v-for="t in teacherOptions" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
        <el-select
          v-model="filters.status"
          placeholder="状态"
          clearable
          style="width: 120px"
          @change="onFilterChange"
        >
          <el-option v-for="o in statusOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          style="width: 240px"
          @change="onDateChange"
        />
      </div>
      <div class="toolbar-right">
        <el-button @click="resetFilters">重置</el-button>
        <el-button type="primary" :icon="Download" :loading="exporting" @click="onExport">导出</el-button>
      </div>
    </div>

    <ListErrorState v-if="!loading && error" :error="error" @retry="loadData" />
    <template v-else>
    <!-- 汇总卡片 -->
    <div class="stat-cards">
      <div class="stat-card">
        <div class="stat-value text-success v4-num-display is-md">{{ summary.attendedSessions }}</div>
        <div class="stat-label">出勤次数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value v4-num-display is-md">{{ summary.totalSessions }}</div>
        <div class="stat-label">应到次数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value text-accent v4-num-display is-md">{{ summary.attendedHours }}<span class="stat-unit">课时</span></div>
        <div class="stat-label">已上课时</div>
      </div>
      <div class="stat-card">
        <div class="stat-value text-accent v4-num-display is-md">{{ summary.attendanceRate }}<span class="stat-unit">%</span></div>
        <div class="stat-label">出勤率</div>
      </div>
    </div>

    <!-- 出勤趋势 -->
    <div class="chart-card">
      <div class="chart-title">出勤趋势</div>
      <div ref="trendChartRef" class="trend-chart"></div>
    </div>

    <!-- 明细表 -->
    <div class="table-card">
      <el-table :data="records" v-loading="loading" stripe class="att-table">
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column label="成员" min-width="100" show-overflow-tooltip>
          <template #default="{ row }">{{ row.studentName || '-' }}</template>
        </el-table-column>
        <el-table-column label="课程班级" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.courseName || '-' }}</template>
        </el-table-column>
        <el-table-column label="教练" min-width="100" show-overflow-tooltip>
          <template #default="{ row }">{{ row.coach || '-' }}</template>
        </el-table-column>
        <el-table-column label="时间" width="150">
          <template #default="{ row }">
            <span v-if="row.startTime && row.endTime">{{ row.startTime }}–{{ row.endTime }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('session')" width="90">
          <template #default="{ row }">
            <span v-if="row.durationMin">{{ (row.durationMin / 60).toFixed(1).replace(/\.0$/, '') }}课时</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <span class="status-tag" :class="'st-' + row.status">{{ statusText(row.status) }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="loadData"
          @size-change="loadData"
        />
      </div>
    </div>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, computed } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])
import { Download } from '@element-plus/icons-vue'
import PageHeader from '@/components/PageHeader.vue'
import {
  getAttendances,
  getAttendanceSummary,
  getStudentOptions,
  getCourseOptions,
  getTeacherOptions,
} from '@/api/modules'
import { fetchAllPages } from '@/utils/fetchAll'
import { useSettingsStore } from '@/store/settings'

const settingsStore = useSettingsStore()
const t = settingsStore.t
const props = defineProps({ embedded: { type: Boolean, default: false } })

// ECharts 无法解析 CSS 变量，手动读取主题色
const cssVar = (name, fallback = '') => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback || undefined
}
const hexToRgba = (hex, alpha) => {
  const h = (hex || '').replace('#', '')
  if (h.length !== 6 && h.length !== 3) return `rgba(0,113,227,${alpha})`
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

const statusOptions = [
  { value: 'present', label: '出勤' },
  { value: 'late', label: '迟到' },
  { value: 'absent', label: '缺席' },
  { value: 'leave', label: '请假' },
]
const statusText = (s) => statusOptions.find((o) => o.value === s)?.label || s || '-'

// 筛选条件
const filters = reactive({ studentId: '', classId: '', teacherId: '', status: '' })
const dateRange = ref([])

const studentOptions = ref([])
const courseOptions = ref([])
const teacherOptions = ref([])

const records = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)
const summary = reactive({
  totalSessions: 0,
  attendedSessions: 0,
  attendedHours: 0,
  attendanceRate: 0,
})
const trend = ref([])

const trendChartRef = ref(null)
let trendChart = null

function buildParams(extra = {}) {
  const p = {
    page: page.value,
    pageSize: pageSize.value,
    ...extra,
  }
  if (filters.studentId) p.studentId = filters.studentId
  if (filters.classId) p.classId = filters.classId
  if (filters.teacherId) p.teacherId = filters.teacherId
  if (filters.status) p.status = filters.status
  if (dateRange.value && dateRange.value.length === 2) {
    p.startDate = dateRange.value[0]
    p.endDate = dateRange.value[1]
  }
  return p
}

async function loadData() {
  loading.value = true
  try {
    const [listRes, sumRes] = await Promise.all([
      getAttendances(buildParams()),
      getAttendanceSummary(buildParams({ pageSize: 500 })),
    ])
    records.value = listRes.list || []
    total.value = listRes.total || 0
    // 卡片与趋势图统一取 /attendances/summary 的全量口径结果：
    // 列表接口的 summary 历史上只统计当前分页（默认 20 行），与趋势图口径不一致，
    // 同屏出现两套数字。这里只认一个来源，避免再次分叉。
    if (sumRes.summary) Object.assign(summary, sumRes.summary)
    trend.value = sumRes.trend || []
    renderTrend()
  } catch (e) {
    // 列表加载失败：写 error 状态由 ListErrorState 呈现并提供重试，不再重复弹 toast（拦截器已提示业务/网络错误）
    error.value = e?.message || '加载上课记录失败'
  } finally {
    loading.value = false
  }
}

function onFilterChange() {
  page.value = 1
  loadData()
}
function onDateChange() {
  page.value = 1
  loadData()
}
function resetFilters() {
  filters.studentId = ''
  filters.classId = ''
  filters.teacherId = ''
  filters.status = ''
  dateRange.value = []
  page.value = 1
  loadData()
}

// 导出 CSV（按当前筛选拉取全部记录）
const exporting = ref(false)
// 防 Excel/Numbers 公式注入：以 = + - @ 开头的单元格会被当作公式执行，
// 前置单引号强制按文本处理（姓名/课程名等均为用户可录入字段）
const csvCell = (v) => {
  const s = String(v ?? '')
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${guarded.replace(/"/g, '""')}"`
}
async function onExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    // 后端 parsePagination 硬顶 pageSize=500，单页拉取会静默截断超量数据；
    // 循环翻页拉全量，与 leave/feedback/students 的导出一致
    const all = await fetchAllPages(getAttendances, buildParams({ page: 1 }), 500)
    const rows = all || []
    if (!rows.length) {
      ElMessage.info('当前筛选无记录可导出')
      return
    }
    const header = ['日期', '成员', '课程班级', '教练', '开始', '结束', '课时', '状态']
    const lines = [header.join(',')]
    rows.forEach((r) => {
      const dm = r.durationMin ? (r.durationMin / 60).toFixed(1).replace(/\.0$/, '') + '课时' : ''
      lines.push([
        r.date || '',
        r.studentName || '',
        r.courseName || '',
        r.coach || '',
        r.startTime || '',
        r.endTime || '',
        dm,
        statusText(r.status),
      ].map(csvCell).join(','))
    })
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `上课记录_${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    ElMessage.error('导出失败')
  } finally {
    exporting.value = false
  }
}

function renderTrend() {
  if (!trendChartRef.value) return
  if (!trendChart) trendChart = echarts.init(trendChartRef.value)
  const accent = cssVar('--t-accent', '#0071e3')
  const dates = trend.value.map((d) => d.date)
  const attended = trend.value.map((d) => d.attended)
  const totalArr = trend.value.map((d) => d.total)
  const hasData = trend.value.length > 0
  const option = {
    ...(hasData ? {} : {
      title: { text: '暂无数据', left: 'center', top: 'center', textStyle: { color: cssVar('--t-text-faint'), fontSize: 13, fontWeight: 400 } },
    }),
    grid: { top: 30, right: 16, bottom: 30, left: 44 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: cssVar('--t-bg-overlay'),
      borderColor: cssVar('--t-line-strong'),
      borderWidth: 1,
      textStyle: { color: cssVar('--t-text-1') },
    },
    legend: { data: ['出勤', '应到'], top: 0, right: 8, textStyle: { color: cssVar('--t-text-2'), fontSize: 12 } },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine: { lineStyle: { color: cssVar('--t-line-strong') } },
      axisTick: { show: false },
      axisLabel: { color: cssVar('--t-text-2'), fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: cssVar('--t-line') } },
      axisLabel: { color: cssVar('--t-text-2'), fontSize: 11 },
    },
    series: [
      {
        name: '出勤',
        type: 'bar',
        data: attended,
        barMaxWidth: 22,
        itemStyle: { color: accent, borderRadius: [3, 3, 0, 0] },
      },
      {
        name: '应到',
        type: 'bar',
        data: totalArr,
        barMaxWidth: 22,
        itemStyle: { color: hexToRgba(cssVar('--t-text-2', '#8A9199'), 0.35), borderRadius: [3, 3, 0, 0] },
      },
    ],
  }
  trendChart.setOption(option, true)
}

function onResize() {
  if (trendChart) trendChart.resize()
}

// 主题切换：setOption(option, true) 全量替换，颜色按新 token 重取
function onThemeChanged() {
  if (trendChart) renderTrend()
}

// 下拉改为远程搜索（轻量 /options 端点），避免全量拉取
async function loadStudentOptions(query = '') {
  try {
    const res = await getStudentOptions({ q: query })
    studentOptions.value = res.list || []
  } catch (e) { /* 无权限时跳过 */ }
}
async function loadCourseOptions(query = '') {
  try {
    const res = await getCourseOptions({ q: query })
    courseOptions.value = res.list || []
  } catch (e) { /* 跳过 */ }
}
async function loadTeacherOptions(query = '') {
  try {
    const res = await getTeacherOptions({ q: query })
    teacherOptions.value = res.list || []
  } catch (e) { /* 跳过 */ }
}

onMounted(() => {
  loadStudentOptions()
  loadCourseOptions()
  loadTeacherOptions()
  loadData()
  window.addEventListener('resize', onResize)
  // 主题切换后按新 token 重绘（ECharts canvas 不读 CSS 变量）
  window.addEventListener('theme-changed', onThemeChanged)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('theme-changed', onThemeChanged)
  if (trendChart) { trendChart.dispose(); trendChart = null }
})
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: var(--t-spacing-lg);
}
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 汇总卡片 */
.stat-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--t-spacing-lg);
  margin-bottom: var(--t-spacing-lg);
}
.stat-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-lg);
  padding: var(--t-spacing-lg);
  box-shadow: var(--t-card-shadow);
}
.stat-value {
  font-size: var(--v4-fs-5xl);
  font-weight: 700;
  color: var(--t-text-1);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.025em;
}
.stat-unit {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-text-2);
  margin-left: 2px;
}
.stat-label {
  margin-top: 6px;
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
}
.text-success { color: var(--t-success); }
.text-accent { color: var(--t-accent); }

/* 趋势图 */
.chart-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-lg);
  padding: var(--t-spacing-lg);
  margin-bottom: var(--t-spacing-lg);
  box-shadow: var(--t-card-shadow);
}
.chart-title {
  font-size: var(--t-fs-lg);
  font-weight: 600;
  color: var(--t-text-1);
  margin-bottom: var(--t-spacing-md);
}
.trend-chart {
  width: 100%;
  height: 280px;
}

/* 明细表 */
.table-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-lg);
  padding: var(--t-spacing-lg);
  box-shadow: var(--t-card-shadow);
}
.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--t-spacing-md);
}
.status-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--t-radius-sm);
  font-size: var(--t-fs-xs);
  font-weight: 600;
}
.st-present { color: var(--t-success); background: color-mix(in srgb, var(--t-success) 12%, transparent); }
.st-late { color: var(--t-warning); background: color-mix(in srgb, var(--t-warning) 12%, transparent); }
.st-absent { color: var(--t-danger); background: color-mix(in srgb, var(--t-danger) 12%, transparent); }
.st-leave { color: var(--t-text-2); background: var(--t-line); }

@media (max-width: 768px) {
  .stat-cards { grid-template-columns: repeat(2, 1fr); }
}
</style>
