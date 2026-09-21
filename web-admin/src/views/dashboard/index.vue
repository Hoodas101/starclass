<template>
  <div class="page-shell">
    <!-- 顶部页头（使用统一 PageHeader 组件，主标题位置与全站一致） -->
    <!-- 标题用 prop 单色（此前用 <i> 做双色标题，导致"数据看板"四字颜色不一致）
         全站统一单色，视觉更干净 -->
    <PageHeader title="数据看板">
      <el-radio-group v-model="dashboardScope" size="default" @change="onScopeChange">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="me">我的</el-radio-button>
      </el-radio-group>
    </PageHeader>

    <!-- 统计卡片 -->
    <div v-if="widgets.statCards !== false" class="stat-cards">
      <div
        v-for="(stat, si) in stats"
        :key="stat.key"
        class="stat-card"
        :class="{ 'is-clickable': stat.go }"
        :role="stat.go ? 'button' : undefined"
        :tabindex="stat.go ? 0 : undefined"
        :title="stat.go ? '查看详情' : undefined"
        @click="stat.go && router.push(stat.go)"
        @keydown.enter="stat.go && router.push(stat.go)"
        @keydown.space.prevent="stat.go && router.push(stat.go)"
      >
        <!-- 右下角水印图标：低对比大图标，增加质感但不干扰内容
             （对标班主任工作台的 .stat .ghost） -->
        <el-icon class="stat-ghost"><component :is="STAT_ICONS[stat.icon]" /></el-icon>
        <!-- 序号 01~08：给卡片清单感与秩序（对标 .stat .idx） -->
        <span class="stat-idx">{{ String(si + 1).padStart(2, '0') }}</span>
        <div class="stat-header">
          <span class="stat-label">{{ stat.label }}</span>
        </div>
        <div class="stat-value">
          <span class="stat-number v4-num-display is-md">{{ stat.value }}</span>
          <span class="stat-unit">{{ stat.unit }}</span>
        </div>
        <!-- 三态语义色：正=绿 / 负=红 / 无对比=中性灰
             原为二元判断 `trend > 0 ? 'up' : 'down'`，trend 为 0 时
             会落进 'down' 分支——「暂无对比」被染成红色，语义错误。 -->
        <div class="stat-trend" :class="stat.tone">
          <template v-if="stat.note">
            <span>{{ stat.note }}</span>
          </template>
          <template v-else>
            <el-icon>
              <CaretTop v-if="stat.trend > 0" />
              <CaretBottom v-else />
            </el-icon>
            <span>{{ Math.abs(stat.trend) }}% 较上周</span>
          </template>
        </div>
      </div>
    </div>

    <!-- 中部图表 -->
    <div class="charts-row">
      <!-- 到场趋势 -->
      <div v-if="widgets.attendance !== false" class="chart-card">
        <div class="chart-header">
          <h3>到场趋势</h3>
          <el-radio-group v-model="attendancePeriod" size="small" @change="onAttendancePeriodChange">
            <el-radio-button value="week">本周</el-radio-button>
            <el-radio-button value="month">本月</el-radio-button>
          </el-radio-group>
        </div>
        <div ref="attendanceChartRef" class="chart-body"></div>
      </div>

      <!-- 营收趋势（本月 vs 上月，借鉴 trycompai/crm 的 AreaTrend） -->
      <div v-if="widgets.statCards !== false" class="chart-card">
        <div class="chart-header">
          <h3>营收趋势</h3>
          <span class="chart-legend">
            <i class="legend-dot current"></i>本月
            <i class="legend-dot prev"></i>上月
          </span>
        </div>
        <div ref="revenueChartRef" class="chart-body"></div>
      </div>

      <!-- 产品占比（借鉴 trycompai/crm 的 DonutStat） -->
      <div v-if="widgets.products !== false" class="chart-card">
        <div class="chart-header">
          <h3>产品占比</h3>
          <span class="chart-sub">本月共 {{ productOrderCount }} 单</span>
        </div>
        <div ref="productDonutRef" class="chart-body"></div>
      </div>
    </div>

    <!-- 下部列表 -->
    <div class="lists-row">
      <!-- 近期签到动态 -->
      <div v-if="widgets.activity !== false" class="list-card">
        <div class="list-header">
          <h3>近期{{ $t('checkin') }}动态</h3>
          <el-link type="primary" underline="never" @click="router.push('/checkin')">查看全部</el-link>
        </div>
        <div class="activity-list">
          <div
            v-for="item in recentActivities"
            :key="item.id"
            class="activity-item"
          >
            <el-avatar :size="40" :src="item.avatar" :icon="UserFilled" />
            <div class="activity-info">
              <p class="activity-text">
                <strong>{{ item.student }}</strong>
                {{ item.action }}
                <span class="activity-course">{{ item.course }}</span>
              </p>
              <span class="activity-time">{{ item.time }}</span>
            </div>
            <StatusDot :tone="item.status === 'success' ? 'success' : item.status === 'warning' ? 'warning' : 'neutral'" :label="item.statusText" subtle />
          </div>
        </div>
      </div>

      <!-- 待处理事项 -->
    <div v-if="widgets.pending !== false" class="list-card">
        <div class="list-header">
          <h3>待处理事项</h3>
          <el-badge :value="pendingItems.length" class="pending-badge" />
        </div>
        <div class="pending-list">
          <div
            v-for="item in pendingItems"
            :key="item.id"
            class="pending-item"
          >
            <div class="pending-icon" :class="item.type">
              <el-icon :size="18">
                <component :is="item.icon" />
              </el-icon>
            </div>
            <div class="pending-info">
              <p class="pending-title">{{ item.title }}</p>
              <span class="pending-desc">{{ item.desc }}</span>
            </div>
            <el-button
              v-if="item.kind === 'followup'"
              text
              type="success"
              size="small"
              @click="completeFu(item)"
            >完成</el-button>
            <el-button v-else text type="primary" size="small" @click="goStudents">处理</el-button>
          </div>
        </div>
    </div>

    <!-- 本周签单排名 -->
      <div v-if="widgets.rankWeek !== false" class="list-card">
        <div class="list-header">
          <h3>本周签单排名</h3>
        </div>
        <div v-if="salesData.weekRanking.length" class="sales-ranking">
          <div v-for="(item, index) in salesData.weekRanking.slice(0, 5)" :key="item.salesperson" class="rank-item">
            <span class="rank-no" :class="index < 3 ? 'top' : ''">{{ index + 1 }}</span>
            <span class="rank-name">{{ item.salesperson }}</span>
            <div class="rank-meter"><div class="rank-meter-fill" :style="{ width: meterWidth(item.amount, weekMax) }"></div></div>
            <span class="rank-count">{{ item.count }}单</span>
            <span class="rank-amount">¥{{ Number(item.amount).toLocaleString() }}</span>
          </div>
        </div>
        <div v-else class="empty-hint">本周暂无签单记录</div>
      </div>

      <!-- 本月签单排名 -->
      <div v-if="widgets.rankMonth !== false" class="list-card">
        <div class="list-header">
          <h3>本月签单排名</h3>
          <span class="list-sub">1v1 销售 ¥{{ oneToOneText }} · {{ oneToOneCount }} 单</span>
        </div>
        <div v-if="salesData.monthRanking.length" class="sales-ranking">
          <div v-for="(item, index) in salesData.monthRanking.slice(0, 5)" :key="item.salesperson" class="rank-item">
            <span class="rank-no" :class="index < 3 ? 'top' : ''">{{ index + 1 }}</span>
            <span class="rank-name">{{ item.salesperson }}</span>
            <div class="rank-meter"><div class="rank-meter-fill" :style="{ width: meterWidth(item.amount, monthMax) }"></div></div>
            <span class="rank-count">{{ item.count }}单</span>
            <span class="rank-amount">¥{{ Number(item.amount).toLocaleString() }}</span>
          </div>
        </div>
        <div v-else class="empty-hint">本月暂无签单记录</div>
      </div>

      <!-- 本年签单排名 -->
      <div v-if="widgets.rankYear !== false" class="list-card">
        <div class="list-header">
          <h3>本年签单排名</h3>
        </div>
        <div v-if="salesData.yearRanking.length" class="sales-ranking">
          <div v-for="(item, index) in salesData.yearRanking.slice(0, 5)" :key="item.salesperson" class="rank-item">
            <span class="rank-no" :class="index < 3 ? 'top' : ''">{{ index + 1 }}</span>
            <span class="rank-name">{{ item.salesperson }}</span>
            <div class="rank-meter"><div class="rank-meter-fill" :style="{ width: meterWidth(item.amount, yearMax) }"></div></div>
            <span class="rank-count">{{ item.count }}单</span>
            <span class="rank-amount">¥{{ Number(item.amount).toLocaleString() }}</span>
          </div>
        </div>
        <div v-else class="empty-hint">本年暂无签单记录</div>
      </div>

      <!-- 销售产品统计（与小程序管理端一致） -->
      <div v-if="widgets.salesProducts !== false" class="list-card">
        <div class="list-header">
          <h3>销售产品统计</h3>
          <span class="list-sub">共 {{ productOrderCount }} 单</span>
        </div>
        <div v-if="salesData.itemStats.length" class="sales-ranking">
          <div
            v-for="(item, index) in salesData.itemStats.slice(0, 6)"
            :key="item.itemName"
            class="rank-item"
          >
            <span class="rank-no" :class="index < 3 ? 'top' : ''">{{ index + 1 }}</span>
            <span class="rank-name">{{ item.itemName }}</span>
            <span class="rank-count">{{ item.count }}单</span>
            <span class="rank-amount">¥{{ Number(item.amount).toLocaleString() }}</span>
          </div>
        </div>
        <div v-else class="empty-hint">本月暂无购买记录</div>
      </div>
    </div>

    <!-- 关注雷达：到期 / 欠费 / 连续缺勤 / 请假待审批 / 待跟进
         放在主内容区、与列表卡片同宽（此前放在右侧栏只有 300px，与整体不协调） -->
    <div class="radar-card">
      <div class="radar-head">
        <h3>关注雷达</h3>
        <span class="radar-total">{{ radarTotal }}</span>
      </div>

      <div v-if="attention.expiring.length" class="radar-sec">
        <div class="radar-sec-title">到期预警 <em>{{ attention.expiring.length }}</em></div>
        <div
          v-for="c in attention.expiring" :key="'exp-' + c.id"
          class="radar-item" role="button" tabindex="0"
          @click="router.push('/students')"
          @keydown.enter="router.push('/students')"
          @keydown.space.prevent="router.push('/students')"
        >
          <span class="radar-name">{{ c.student_name }}</span>
          <span class="radar-desc">{{ c.card_type_name }} · {{ daysLeftText(c.expires_at) }}</span>
        </div>
      </div>

      <div v-if="attention.arrears.length" class="radar-sec">
        <div class="radar-sec-title">待收欠费 <em>{{ attention.arrears.length }}</em></div>
        <div
          v-for="o in attention.arrears" :key="'arr-' + o.id"
          class="radar-item" role="button" tabindex="0"
          @click="router.push('/sales?tab=orders')"
          @keydown.enter="router.push('/sales?tab=orders')"
          @keydown.space.prevent="router.push('/sales?tab=orders')"
        >
          <span class="radar-name">{{ o.student_name || '未指定' }}</span>
          <span class="radar-desc">¥{{ Number(o.payable_amount || 0).toLocaleString() }} · {{ o.order_no }}</span>
        </div>
      </div>

      <div v-if="attention.absences.length" class="radar-sec">
        <div class="radar-sec-title">连续缺勤 <em>{{ attention.absences.length }}</em></div>
        <div
          v-for="a in attention.absences" :key="'abs-' + a.id"
          class="radar-item" role="button" tabindex="0"
          @click="router.push('/students')"
          @keydown.enter="router.push('/students')"
          @keydown.space.prevent="router.push('/students')"
        >
          <span class="radar-name">{{ a.name }}</span>
          <span class="radar-desc">最近 {{ a.absent_count }} 次全部缺席</span>
        </div>
      </div>

      <div v-if="attention.leaves.length" class="radar-sec">
        <div class="radar-sec-title">请假待审批 <em>{{ attention.leaves.length }}</em></div>
        <div
          v-for="l in attention.leaves" :key="'lv-' + l.id"
          class="radar-item" role="button" tabindex="0"
          @click="router.push('/operations?tab=leave')"
          @keydown.enter="router.push('/operations?tab=leave')"
          @keydown.space.prevent="router.push('/operations?tab=leave')"
        >
          <span class="radar-name">{{ l.student_name || '成员' }}</span>
          <span class="radar-desc">{{ l.course_name || '' }} {{ l.date || '' }} {{ l.start_time || '' }}</span>
        </div>
      </div>

      <div v-if="attention.followups.length" class="radar-sec">
        <div class="radar-sec-title">待跟进 <em>{{ attention.followups.length }}</em></div>
        <div
          v-for="f in attention.followups" :key="'fu-' + f.id"
          class="radar-item" role="button" tabindex="0"
          @click="router.push('/growth')"
          @keydown.enter="router.push('/growth')"
          @keydown.space.prevent="router.push('/growth')"
        >
          <span class="radar-name">{{ f.target_name || '未指定' }}</span>
          <span class="radar-desc">{{ f.reason || f.task_type }}</span>
        </div>
      </div>

      <div v-if="radarTotal === 0" class="radar-empty">暂无需要关注的事项</div>
        </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart, BarChart, PieChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, CanvasRenderer])
import dayjs from 'dayjs'
import { useRouter } from 'vue-router'
import { UserFilled, CaretTop, CaretBottom, Money, TrendCharts, DataLine, Coin, User, Checked, Calendar, Warning, Refresh, Bell } from '@element-plus/icons-vue'

// 统计卡右下角水印图标映射（stats 里的 icon 字段是字符串，需转成组件）
const STAT_ICONS = { Money, TrendCharts, DataLine, Coin, User, Checked, Calendar, Warning }

// 待处理事项的图标映射。
// 修复既有 bug：此前 icon 存的是**字符串**（'Refresh'/'Bell'），而
// `<component :is="item.icon" />` 需要**组件引用**才能渲染——项目用 unplugin
// 按需引入、无全局图标注册，所以字符串永远解析不出组件，图标一直不显示。
const PENDING_ICONS = { Refresh, Bell, Calendar }
import { getDashboard, getCharts, getCheckinRecords, getExpiringCards, getFollowUpsToday, completeFollowUp, getLeaves, getAttention } from '@/api/modules'
import { relativeTime } from '@/utils/format'
import StatusDot from '@/components/StatusDot.vue'
import PageHeader from '@/components/PageHeader.vue'
import { chartPalette } from '@/utils/theme-colors'
import { useSettingsStore } from '@/store/settings'
import { useUserStore } from '@/store/user'

const settingsStore = useSettingsStore()
const t = settingsStore.t
const userStore = useUserStore()

const router = useRouter()
// 范围切换状态记忆（CRM OverviewScopeToggle 一致体验）
const dashboardScope = ref(localStorage.getItem('edu_dash_scope') || 'all')

const onScopeChange = () => {
  localStorage.setItem('edu_dash_scope', dashboardScope.value)
  loadDashboard()
}

// 到场趋势“本周/本月”切换：重拉图表数据（后端按 period 返回 7 天或 30 天）
const onAttendancePeriodChange = () => {
  loadCharts()
}

// 今日日期文本
const todayText = computed(() => {
  const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${dayjs().format('YYYY年MM月DD日')} ${weekDays[dayjs().day()]}`
})

// ============================================
// 统计数据（来自 /api/admin/dashboard）
// ============================================
const formatMoney = (v) => Number(v || 0).toLocaleString('zh-CN')

const stats = ref([])
const dashLoading = ref(false)
const dashError = ref('')
const salesData = ref({ monthRanking: [], weekRanking: [], yearRanking: [], itemStats: [], oneToOne: { amount: 0, count: 0 } })
// localStorage 可能被旧版本写入损坏数据：解析失败时回退为空对象
let savedWidgets = {}
try { savedWidgets = JSON.parse(localStorage.getItem('edu_dash_widgets') || '{}') } catch (e) { savedWidgets = {} }
const widgets = ref(savedWidgets)

const oneToOneText = computed(() => Number(salesData.value.oneToOne?.amount || 0).toLocaleString())
const oneToOneCount = computed(() => salesData.value.oneToOne?.count || 0)
const productOrderCount = computed(() =>
  (salesData.value.itemStats || []).reduce((s, i) => s + (i.count || 0), 0)
)

// 排名进度条宽度（借鉴 trycompai/crm 的 ValueMeter）
const weekMax = computed(() => Math.max(1, ...(salesData.value.weekRanking || []).map((i) => Number(i.amount) || 0)))
const monthMax = computed(() => Math.max(1, ...(salesData.value.monthRanking || []).map((i) => Number(i.amount) || 0)))
const yearMax = computed(() => Math.max(1, ...(salesData.value.yearRanking || []).map((i) => Number(i.amount) || 0)))
const meterWidth = (amount, max) => `${Math.max(4, Math.round((Number(amount) || 0) / max * 100))}%`

const expireText = (ts) => {
  if (!ts) return '即将到期'
  const days = Math.ceil((Number(ts) - Date.now()) / 86400000)
  if (days <= 0) return '今天到期'
  if (days === 1) return '明天到期'
  return `${days} 天后到期`
}

const buildStats = (data) => {
  const { overview, today, revenue, alerts } = data
  // 连续缺勤学员（后端 alerts.attentionStudents，默认口径见 backend/routes/admin.js）
  attentionStudents.value = (alerts && alerts.attentionStudents) || []
  const deltaNote = (label, v) => (v != null ? `${label} ${v > 0 ? '+' : ''}${v}%` : '')
  const fmt = (v) => formatMoney(v)
  // 卡片即入口：点统计卡跳到对应页面（对标班主任工作台的 stat-go）
  const STAT_GO = {
    revenueToday: '/sales?tab=orders',
    revenueWeek: '/sales?tab=orders',
    revenueMonth: '/sales?tab=orders',
    revenueYear: '/sales?tab=orders',
    students: '/students',
    attendance: '/operations?tab=checkin',
    todayClasses: '/operations?tab=schedule',
    renewal: '/students',
  }
  stats.value = [
    {
      key: 'revenueToday',
      label: '今日收入',
      value: fmt(revenue.today),
      unit: '元',
      note: deltaNote('较昨日', revenue.todayDelta) || '暂无昨日对比',
      trend: revenue.todayDelta ?? 0,
      icon: 'Money'
    },
    {
      key: 'revenueWeek',
      label: '本周收入',
      value: fmt(revenue.week),
      unit: '元',
      note: deltaNote('较上周', revenue.weekDelta) || '本周暂无对比',
      trend: revenue.weekDelta ?? 0,
      icon: 'TrendCharts'
    },
    {
      key: 'revenueMonth',
      label: '本月收入',
      value: fmt(revenue.month),
      unit: '元',
      note: deltaNote('较上月', revenue.monthDelta) || '本月暂无对比',
      trend: revenue.monthDelta ?? 0,
      icon: 'DataLine'
    },
    {
      key: 'revenueYear',
      label: '本年收入',
      value: fmt(revenue.year),
      unit: '元',
      note: deltaNote('较去年', revenue.yearDelta) || '今年暂无对比',
      trend: revenue.yearDelta ?? 0,
      icon: 'Coin'
    },
    {
      key: 'students',
      label: '有效' + t('learner') + '数',
      value: String(overview.validMembers ?? overview.totalStudents ?? 0),
      unit: '人',
      note: '持有有效' + t('membership'),
      trend: 0,
      icon: 'User'
    },
    {
      key: 'attendance',
      label: '今日到场率',
      value: String(today.attendanceRate || 0).replace(/%$/, ''),
      unit: '%',
      note: `${today.checkins || 0} 人已${t('checkin')}`,
      trend: 0,
      icon: 'Checked'
    },
    {
      key: 'todayClasses',
      label: '今日课表',
      value: String(today.schedules || 0),
      unit: '节',
      note: `${overview.totalCourses || 0} 个在售活动`,
      trend: 0,
      icon: 'Calendar'
    },
    {
      key: 'renewal',
      label: '续期预警',
      value: String(alerts.expiringCards || 0),
      unit: '人',
      note: '7 天内到期',
      trend: 0,
      icon: 'Warning'
    }
  ].map((s) => ({
    ...s,
    // 三态语义色：正=绿 / 负=红 / 零或缺失=中性
    // （此前模板用 `trend > 0 ? 'up' : 'down'` 二元判断，trend=0 时
    //   会把「暂无对比」染成红色，与事实不符）
    tone: s.trend > 0 ? 'up' : (s.trend < 0 ? 'down' : ''),
    // 卡片即入口：有目标页的卡片可点击跳转
    go: STAT_GO[s.key] || '',
  }))
}

// ============================================
// 图表
// ============================================
const attendancePeriod = ref('week')
const attendanceChartRef = ref(null)
let attendanceChart = null
const revenueChartRef = ref(null)
let revenueChart = null
const productDonutRef = ref(null)
let productDonut = null

const chartData = ref({
  attendanceTrend: { labels: [], data: [] },
  revenueTrend: { labels: [], current: [], prev: [] },
  courseDist: [],
  productSales: []
})

const loadCharts = async () => {
  try {
    chartData.value = await getCharts({ period: attendancePeriod.value })
  } catch (e) {
    chartData.value = { attendanceTrend: { labels: [], data: [] }, revenueTrend: { labels: [], current: [], prev: [] }, courseDist: [], productSales: [] }
  }
  // 重建前先销毁旧实例：否则同一 DOM 反复 echarts.init 会累积实例造成内存泄漏
  //（切换 本周/本月 周期、主题切换都走这里，统一在入口 dispose）
  if (attendanceChart) { attendanceChart.dispose(); attendanceChart = null }
  if (revenueChart) { revenueChart.dispose(); revenueChart = null }
  if (productDonut) { productDonut.dispose(); productDonut = null }
  initAttendanceChart()
  initRevenueChart()
  initProductDonut()
}

// ECharts canvas 无法解析 CSS 变量，手动读取主题色
const cssVar = (name, fallback = '') => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback || undefined
}

// 将主题色（hex/rgb）转为带透明度的 rgba，供 ECharts areaStyle 等使用
const hexToRgba = (hex, alpha) => {
  const raw = (hex || '').trim()
  const rgbMatch = raw.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) return `rgba(${rgbMatch[1]},${rgbMatch[2]},${rgbMatch[3]},${alpha})`
  const h = raw.replace('#', '')
  if (h.length !== 6 && h.length !== 3) return `rgba(0,113,227,${alpha})` // 回退 Apple Blue
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

const onThemeChanged = () => {
  if (attendanceChart) { attendanceChart.dispose(); attendanceChart = null }
  if (revenueChart) { revenueChart.dispose(); revenueChart = null }
  if (productDonut) { productDonut.dispose(); productDonut = null }
  loadCharts()
}

// 到场趋势图
const initAttendanceChart = () => {
  if (!attendanceChartRef.value) return

  attendanceChart = echarts.init(attendanceChartRef.value)
  const trend = chartData.value.attendanceTrend
  const hasTrend = !!(trend.data && trend.data.length)
  const emptyTitle = hasTrend ? {} : {
    text: '暂无到场数据',
    left: 'center',
    top: 'center',
    textStyle: { color: cssVar('--t-text-faint'), fontSize: 13, fontWeight: 400 }
  }
  const option = {
    ...emptyTitle,
    grid: {
      top: 20,
      right: 20,
      bottom: 30,
      left: 50
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: cssVar('--t-bg-overlay'),
      borderColor: cssVar('--t-line-strong'),
      borderWidth: 1,
      textStyle: { color: cssVar('--t-text-1') },
      formatter: (params) => {
        const p = params[0]
        return `${p.name}<br/><span style="color:${cssVar('--t-accent')};font-weight:600">${p.value}%</span>`
      }
    },
    xAxis: {
      type: 'category',
      data: hasTrend ? trend.labels : [],
      axisLine: { lineStyle: { color: cssVar('--t-line-strong') } },
      axisTick: { show: false },
      axisLabel: { color: cssVar('--t-text-2'), fontSize: 12 }
    },
    yAxis: {
      type: 'value',
      max: 100,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: cssVar('--t-line') } },
      axisLabel: {
        color: cssVar('--t-text-2'),
        fontSize: 12,
        formatter: '{value}%'
      }
    },
    series: [
      {
        name: '到场率',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 8,
        data: hasTrend ? trend.data : [],
        lineStyle: { color: cssVar('--t-accent', '#0071e3'), width: 3 },
        itemStyle: { color: cssVar('--t-accent', '#0071e3'), borderWidth: 2, borderColor: cssVar('--t-bg') },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: hexToRgba(cssVar('--t-accent', '#0071e3'), 0.22) },
            { offset: 1, color: hexToRgba(cssVar('--t-accent', '#0071e3'), 0) }
          ])
        }
      }
    ]
  }
  attendanceChart.setOption(option)
}

// 营收趋势（本月 vs 上月，借鉴 trycompai/crm 的 AreaTrend）
const initRevenueChart = () => {
  if (!revenueChartRef.value) return
  revenueChart = echarts.init(revenueChartRef.value)
  const accent = cssVar('--t-accent', '#0071e3')
  const prev = chartPalette()[1]
  const rev = chartData.value.revenueTrend
  const hasRev = !!((rev.current && rev.current.length) || (rev.prev && rev.prev.length))
  const emptyTitle = hasRev ? {} : {
    text: '暂无营收数据',
    left: 'center',
    top: 'center',
    textStyle: { color: cssVar('--t-text-faint'), fontSize: 13, fontWeight: 400 }
  }
  const option = {
    ...emptyTitle,
    grid: { top: 20, right: 16, bottom: 30, left: 44 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: cssVar('--t-bg-overlay'),
      borderColor: cssVar('--t-line-strong'),
      borderWidth: 1,
      textStyle: { color: cssVar('--t-text-1') },
      valueFormatter: (v) => '¥' + Number(v || 0).toLocaleString()
    },
    legend: { show: false },
    xAxis: {
      type: 'category',
      data: rev.labels.length ? rev.labels : [],
      axisLine: { lineStyle: { color: cssVar('--t-line-strong') } },
      axisTick: { show: false },
      axisLabel: { color: cssVar('--t-text-2'), fontSize: 11, interval: 4 }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: cssVar('--t-line') } },
      axisLabel: { color: cssVar('--t-text-2'), fontSize: 11, formatter: (v) => (v >= 1000 ? (v / 1000) + 'k' : v) }
    },
    series: [
      {
        name: '上月',
        type: 'line',
        smooth: true,
        symbol: 'none',
        data: rev.prev,
        lineStyle: { color: prev, width: 2, type: 'dashed' },
        itemStyle: { color: prev },
        areaStyle: { color: hexToRgba(prev, 0.08) }
      },
      {
        name: '本月',
        type: 'line',
        smooth: true,
        symbol: 'none',
        data: rev.current,
        lineStyle: { color: accent, width: 3 },
        itemStyle: { color: accent },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: hexToRgba(accent, 0.22) },
            { offset: 1, color: hexToRgba(accent, 0) }
          ])
        }
      }
    ]
  }
  revenueChart.setOption(option)
}

// 产品占比环形图（借鉴 trycompai/crm 的 DonutStat）
const initProductDonut = () => {
  if (!productDonutRef.value) return
  productDonut = echarts.init(productDonutRef.value)
  const list = salesData.value.itemStats || []
  const palette = chartPalette()
  const option = {
    ...(list.length ? {} : {
      title: {
        text: '暂无产品销售',
        left: 'center',
        top: 'center',
        textStyle: { color: cssVar('--t-text-faint'), fontSize: 13, fontWeight: 400 }
      }
    }),
    tooltip: {
      trigger: 'item',
      backgroundColor: cssVar('--t-bg-overlay'),
      borderColor: cssVar('--t-line-strong'),
      borderWidth: 1,
      textStyle: { color: cssVar('--t-text-1') },
      formatter: '{b}<br/>¥{c}（{d}%）'
    },
    series: [
      {
        type: 'pie',
        radius: ['58%', '82%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: cssVar('--t-surface'), borderWidth: 3, borderRadius: 6 },
        label: { show: false },
        emphasis: {
          label: { show: true, fontSize: 13, fontWeight: 600, color: cssVar('--t-text-1') },
          scaleSize: 6
        },
        data: list.slice(0, 6).map((item, i) => ({
          name: item.itemName || '未命名产品',
          value: Number(item.amount || item.count || 0),
          itemStyle: { color: palette[i % palette.length] }
        }))
      }
    ]
  }
  productDonut.setOption(option)
}

// ============================================
// 近期签到动态（来自 /api/checkin/records）
// ============================================
const statusMap = {
  present: { status: 'success', text: '已' + t('checkin') },
  late: { status: 'warning', text: '迟到' },
  leave: { status: 'info', text: '请假' },
  absent: { status: 'danger', text: '缺席' }
}

const recentActivities = ref([])

const loadRecentActivities = async () => {
  try {
    const res = await getCheckinRecords({ page: 1, pageSize: 6 })
    recentActivities.value = (res.list || []).map((r) => {
      const st = statusMap[r.status] || { status: 'info', text: r.status }
      const timeText = r.checkin_time
        ? relativeTime(r.checkin_time)
        : r.date || ''
      return {
        id: r.id,
        student: r.student_name || '未知成员',
        action: r.status === 'leave' ? '请假：' : '完成了',
        course: r.course_name || '训练活动',
        time: timeText,
        avatar: '',
        status: st.status,
        statusText: st.text
      }
    })
  } catch (e) {
    recentActivities.value = []
  }
}

// ============================================
// 待处理事项（来自 /api/membership/expiring）
// ============================================
const pendingItems = ref([])
// 连续缺勤学员（由 loadDashboard 从 alerts 存入，供 loadPendingItems 消费）
const attentionStudents = ref([])

// ============================================
// 关注雷达（侧栏）—— 数据来自 /api/admin/attention 一次取全
// 四类：到期（7 天内）/ 欠费（待付款）/ 连续缺勤（7 次）/ 待跟进
// ============================================
const attention = ref({ expiring: [], followups: [], arrears: [], absences: [], leaves: [] })
const radarTotal = computed(() =>
  attention.value.expiring.length
  + attention.value.arrears.length
  + attention.value.absences.length
  + attention.value.leaves.length
  + attention.value.followups.length
)

// 到期倒计时文案：今天 / 明天 / N 天后
const daysLeftText = (expiresAt) => {
  const d = Math.ceil((Number(expiresAt || 0) - Date.now()) / 86400000)
  if (d <= 0) return '今天到期'
  if (d === 1) return '明天到期'
  return `${d} 天后到期`
}

const loadAttention = async () => {
  try {
    const res = await getAttention()
    attention.value = {
      expiring: (res && res.expiring) || [],
      followups: (res && res.followups) || [],
      arrears: (res && res.arrears) || [],
      absences: (res && res.absences) || [],
      leaves: (res && res.leaves) || [],
    }
  } catch (e) {
    // 无权限 / 网络异常：雷达整体降级为空，不影响看板其它区块
    attention.value = { expiring: [], followups: [], arrears: [], absences: [], leaves: [] }
  }
}

const loadPendingItems = async () => {
  const items = []
  // 续期提醒仅管理员/教练可见；销售无权访问该接口，跳过以免弹出权限错误提示
  const role = userStore.userRole
  if (role === 'admin' || role === 'coach') {
    try {
      const res = await getExpiringCards({ days: 7 })
      items.push(...(res.list || []).map((c) => ({
        id: 'renewal-' + c.id,
        kind: 'expiring',
        type: 'renewal',
        icon: Refresh,
        title: '续期提醒',
        desc: `${c.student_name || c.student_name_real || '成员'} 的${t('membership')}${expireText(c.expires_at)}`
      })))
    } catch (e) {
      /* 忽略 */
    }
  }
  // 待审批请假：对标班主任工作台的「关注雷达」——把需要老师当下处理的事
  // 聚合到一屏，而不是让用户逐个模块翻找
  try {
    const lv = await getLeaves({ status: 'pending' })
    items.push(...(lv?.list || []).map((r) => ({
      id: 'leave-' + r.id,
      kind: 'leave',
      type: 'leave',
      icon: Calendar,
      title: '请假待审批',
      desc: `${r.student_name || '成员'}：${r.course_name || ''} ${r.date || ''}`.trim()
    })))
  } catch (e) {
    /* 忽略 */
  }
  // 连续缺勤学员：数据来自 loadDashboard 的 alerts.attentionStudents
  // （后端聚合，默认口径：最近 30 天 ≥3 次考勤且全部缺席、请假不算、
  //   排除已退费/已归档；口径可在 backend/routes/admin.js 调整）
  items.push(...(attentionStudents.value || []).map((s) => ({
    id: 'att-' + s.id,
    kind: 'attention',
    type: 'refund',        // 复用红色警示样式——连续缺勤是负面信号
    icon: Warning,
    title: '连续缺勤',
    desc: `${s.name}：最近 30 天 ${s.absent} 次考勤全部缺席`
  })))
  // 跟进任务（借鉴 trycompai/crm 的 AgentTask 队列）
  try {
    const fu = await getFollowUpsToday()
    items.push(...(fu?.list || []).map((t) => ({
      id: 'fu-' + t.id,
      kind: 'followup',
      taskId: t.id,
      type: t.task_type,
      icon: Bell,
      title: t.taskTypeText || '跟进任务',
      desc: `${t.target_name || ''}：${t.reason || ''}`
    })))
  } catch (e) {
    /* 忽略 */
  }
  pendingItems.value = items.slice(0, 8)
}

const completeFu = async (item) => {
  if (!item.taskId) return
  try {
    await completeFollowUp(item.taskId, { note: '看板一键完成' })
    ElMessage.success('跟进任务已完成')
    loadPendingItems()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

const goStudents = () => {
  router.push('/students')
}

// ============================================
// 看板数据
// ============================================
const loadDashboard = async () => {
  dashLoading.value = true
  try {
    const data = await getDashboard({ scope: dashboardScope.value })
    buildStats(data)
    salesData.value = data.sales || { monthRanking: [], weekRanking: [], yearRanking: [], itemStats: [], oneToOne: { amount: 0, count: 0 } }
    dashError.value = ''
  } catch (e) {
    // 看板主数据加载失败：写 error 状态由 ListErrorState 呈现并提供重试，不再重复弹 toast（拦截器已提示）
    stats.value = []
    dashError.value = e?.message || '看板数据加载失败'
  } finally {
    dashLoading.value = false
  }
}

// ============================================
// 生命周期
// ============================================
let resizeHandler = null

onMounted(() => {
  // loadPendingItems 依赖 loadDashboard 写入的 attentionStudents（连续缺勤），
  // 必须等它完成——并行调用时待处理事项会漏掉「连续缺勤」这一类
  loadDashboard().then(() => loadPendingItems())
  loadRecentActivities()
  loadCharts()
  loadAttention()

  resizeHandler = () => {
    ;[attendanceChart, revenueChart, productDonut].forEach((c) => c?.resize())
  }
  window.addEventListener('resize', resizeHandler)
  window.addEventListener('theme-changed', onThemeChanged)
})

onUnmounted(() => {
  window.removeEventListener('resize', resizeHandler)
  window.removeEventListener('theme-changed', onThemeChanged)
  ;[attendanceChart, revenueChart, productDonut].forEach((c) => c?.dispose())
})
</script>

<style lang="scss" scoped>
// 统计卡片
.stat-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--t-spacing-lg);
  margin-bottom: var(--t-spacing-lg);
}

// ============================================
// 关注雷达（主内容区卡片，与 .list-card 同款，视觉上与其他列表卡片一致）
// ============================================
.radar-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: var(--t-spacing-lg);
  // 与上方 lists-row 分隔 + 底部留白（主内容区最后一个卡片）
  margin-top: var(--t-spacing-lg);
  margin-bottom: var(--t-spacing-lg);
  // 五类横向分列 → 卡片不会过高，与列表卡片的高度节奏协调
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--t-spacing-lg);
}

.radar-head {
  // 标题横跨整行（卡片是 grid 分列，标题不属于任何一列）
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--t-spacing-md);

  h3 {
    font-size: var(--t-fs-lg);
    font-weight: 600;
    margin: 0;
  }
}

.radar-total {
  font-size: var(--t-fs-2xl);
  font-weight: 900;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--t-text-1);
}

.radar-sec {
  margin-bottom: var(--t-spacing-md);

  &:last-child {
    margin-bottom: 0;
  }
}

.radar-sec-title {
  font-size: var(--t-fs-xs);
  font-weight: 600;
  color: var(--t-text-3);
  letter-spacing: 0.04em;
  margin-bottom: 6px;

  em {
    font-style: normal;
    color: var(--t-accent-text);
    font-weight: 700;
    margin-left: 4px;
  }
}

.radar-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
  border-bottom: 1px solid var(--t-line);
  cursor: pointer;

  &:last-child {
    border-bottom: none;
  }

  &:hover .radar-name {
    color: var(--t-accent-text);
  }
}

.radar-name {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-text-1);
}

.radar-desc {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-3);
}

.radar-empty {
  // 空态横跨整行（此时没有任何 radar-sec 子列）
  grid-column: 1 / -1;
  padding: var(--t-spacing-md);
  text-align: center;
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  border: 1px dashed var(--t-line-strong);
  border-radius: var(--t-radius-lg);
  background: var(--t-bg-alt);
}

.stat-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: 24px;
  position: relative;
  overflow: hidden;

  // 可点击的卡片（有目标页）：给出指针与 hover 反馈，
  // 让「信息」同时是「入口」——对标班主任工作台的 stat-go
  &.is-clickable {
    cursor: pointer;

    &:hover {
      border-color: var(--t-accent-line);
    }
  }
}

// 右下角水印图标：极浅色大图标，只做质感不抢内容
// （.stat-card 已 overflow:hidden，超出部分自然裁切）
.stat-ghost {
  position: absolute;
  right: -8px;
  bottom: -10px;
  width: 86px;
  height: 86px;
  color: var(--t-surface-hover);
  pointer-events: none;
  z-index: 0;
}

// 序号 01~08：右上角小字，给卡片清单感
.stat-idx {
  position: absolute;
  top: 14px;
  right: 16px;
  font-size: var(--t-fs-2xs);
  font-weight: 800;
  letter-spacing: 0.06em;
  color: var(--t-text-faint);
  font-variant-numeric: tabular-nums;
  z-index: 1;
}

.stat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  // 内容层抬到水印之上（水印是 z-index:0 的定位元素，会盖住静态内容）
  position: relative;
  z-index: 1;
}

.stat-label {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
  font-weight: 400;
}

.stat-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--t-radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
}

.stat-value {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-bottom: 8px;
  position: relative;
  z-index: 1;
}

.stat-number {
  font-size: var(--t-fs-3xl);
  font-weight: 900;
  color: var(--t-text-1);
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat-unit {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
  font-weight: 400;
}

.stat-trend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--t-fs-xs);
  font-weight: 500;
  margin-bottom: 8px;
  position: relative;
  z-index: 1;
  // 默认中性（无对比数据时）——不再被误染成红色
  color: var(--t-text-3);

  &.up {
    color: var(--t-success-text);
  }

  &.down {
    color: var(--t-danger-text);
  }
}

// 图表行
.charts-row {
  display: grid;
  grid-template-columns: 1.2fr 1fr 1fr;
  gap: var(--t-spacing-lg);
  margin-bottom: var(--t-spacing-lg);
}

.chart-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: var(--t-spacing-lg);
}

.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;

  h3 {
    font-size: var(--t-fs-xl);
    font-weight: 600;
    color: var(--t-text-1);
    margin: 0;
  }
}

.chart-legend {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 3px;

  &.current { background: var(--t-accent); }
  &.prev { background: var(--t-text-3); }
}

.chart-sub {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.chart-body {
  height: 240px;
}

// 列表行
.lists-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: var(--t-spacing-md);
}

.list-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: var(--t-spacing-lg);
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;

  h3 {
    font-size: var(--t-fs-xl);
    font-weight: 600;
    color: var(--t-text-1);
    margin: 0;
  }
}

// 签到动态
.activity-list {
  display: flex;
  flex-direction: column;
}

.activity-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;

  &:not(:last-child) {
    border-bottom: 1px solid var(--t-line);
  }
}

.activity-info {
  flex: 1;
  min-width: 0;
}

.activity-text {
  font-size: var(--t-fs-sm);
  color: var(--t-text-1);
  margin: 0 0 2px;

  strong {
    font-weight: 600;
  }

  .activity-course {
    color: var(--t-accent-text);
  }
}

.activity-time {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

// 待处理事项
.pending-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pending-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: var(--t-radius-md);
  background: transparent;
  transition: background 0.2s;

  &:hover {
    background: var(--t-surface-strong);
  }
}

.pending-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--t-radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;

  &.refund {
    background: color-mix(in srgb, var(--t-danger) 14%, transparent);
    color: var(--t-danger-text);
  }

  &.leave {
    background: color-mix(in srgb, var(--t-warning) 14%, transparent);
    color: var(--t-warning-text);
  }

  &.renewal {
    background: var(--t-accent-bg);
    color: var(--t-accent-text);
  }
}

.pending-info {
  flex: 1;
  min-width: 0;
}

.pending-title {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
  margin: 0 0 2px;
}

.pending-desc {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

// 响应式
@media (max-width: 1200px) {
  .stat-cards {
    grid-template-columns: repeat(2, 1fr);
  }

  .charts-row {
    grid-template-columns: 1fr;
  }

  .lists-row {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .stat-cards {
    grid-template-columns: 1fr;
  }

}

// 签单排名
.list-sub {
  font-size: var(--t-fs-xs);
  color: var(--t-accent-text);
}

// 入场动画（克制的 CRM 式微动效）
@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.stat-card,
.chart-card,
.list-card {
  animation: card-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.stat-card:nth-child(2) { animation-delay: 0.04s; }
.stat-card:nth-child(3) { animation-delay: 0.08s; }
.stat-card:nth-child(4) { animation-delay: 0.12s; }
.stat-card:nth-child(5) { animation-delay: 0.16s; }
.stat-card:nth-child(6) { animation-delay: 0.2s; }
.stat-card:nth-child(7) { animation-delay: 0.24s; }
.stat-card:nth-child(8) { animation-delay: 0.28s; }

.chart-card:nth-child(2) { animation-delay: 0.06s; }
.chart-card:nth-child(3) { animation-delay: 0.12s; }

@media (prefers-reduced-motion: reduce) {
  .stat-card,
  .chart-card,
  .list-card {
    animation: none;
  }
}

.sales-ranking {
  display: flex;
  flex-direction: column;
}

.rank-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;

  &:not(:last-child) {
    border-bottom: 1px solid var(--t-line);
  }
}

.rank-meter {
  flex: 1;
  min-width: 40px;
  height: 6px;
  border-radius: var(--t-radius-sm);
  background: var(--t-surface-hover);
  overflow: hidden;
}

.rank-meter-fill {
  height: 100%;
  border-radius: var(--t-radius-sm);
  background: var(--t-accent);
  transition: width var(--t-dur-base) var(--t-ease-standard);
}

@media (prefers-reduced-motion: reduce) {
  .rank-meter-fill {
    transition: none;
  }
}

.rank-no {
  width: 22px;
  height: 22px;
  border-radius: var(--t-radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--t-fs-xs);
  font-weight: 600;
  background: var(--t-surface-hover);
  color: var(--t-text-2);
  flex-shrink: 0;

  &.top {
    background: var(--t-accent-bg);
    color: var(--t-accent-strong);
  }
}

.rank-name {
  flex: 1;
  font-size: var(--t-fs-sm);
  font-weight: 500;
  color: var(--t-text-1);
}

.rank-count {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.rank-amount {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-text-1);
  min-width: 72px;
  text-align: right;
}

.empty-hint {
  padding: 24px 0;
  text-align: center;
  color: var(--t-text-2);
  font-size: var(--t-fs-sm);
}

.widget-tip {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  margin: 0 0 14px;
}

.widget-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.widget-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--t-radius-md);
  cursor: pointer;
  transition: background-color 0.2s ease;
}

.widget-option:hover {
  background: var(--t-surface-hover);
}

.widget-option-label {
  font-size: var(--t-fs-base);
  font-weight: 500;
  color: var(--t-text-1);
}
</style>
