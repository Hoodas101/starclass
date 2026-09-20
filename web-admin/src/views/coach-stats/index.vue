<template>
  <div class="page-shell">
    <PageHeader v-if="!embedded" :title="isAdmin ? $t('instructor') + '课时' : '我的课时统计'" />
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-count">{{ isAdmin ? '按月核算 · 灵活计费规则' : '仅供本人查看' }}</span>
      </div>
      <div class="toolbar-right">
        <el-date-picker
          v-model="month"
          type="month"
          placeholder="选择月份"
          format="YYYY年MM月"
          value-format="YYYY-MM"
          :clearable="false"
          style="width: 150px"
          @change="onMonthChange"
        />
        <template v-if="isAdmin">
          <el-button
            type="success"
            :icon="Money"
            :loading="settling"
            :disabled="monthSettled"
            @click="settleNow"
          >{{ monthSettled ? '本月已结算' : '确认结算' }}</el-button>
          <el-button :icon="Download" @click="openExport('detail')">导出课时明细</el-button>
          <el-button type="primary" :icon="Download" @click="openExport('settlement')">导出薪资结算</el-button>
        </template>
      </div>
    </div>

    <!-- 管理员：本月薪资结算 -->
    <template v-if="isAdmin">
      <div class="section-title">本月薪资结算（{{ monthLabel }}）</div>
      <div class="card table-container">
        <ListErrorState v-if="!loading && error" :error="error" @retry="load" />
        <el-table v-else
          :data="settlement"
          v-loading="loading"
          empty-text="本月暂无排课记录"
          @row-click="openDetailDrawer"
          row-class-name="clickable-row" size="small">
          <el-table-column v-if="showCol('coach')" :label="$t('instructor')" min-width="100">
            <template #default="{ row }">
              <span class="coach-name">{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column label="手机号" min-width="130">
            <template #default="{ row }">{{ row.phone || '-' }}</template>
          </el-table-column>
          <el-table-column v-if="showCol('classes')" label="本月课次" min-width="100" align="right">
            <template #default="{ row }">
              <span class="num-strong">{{ row.classes }}</span> 节
            </template>
          </el-table-column>
          <el-table-column v-if="showCol('students')" label="本月人次" min-width="100" align="right">
            <template #default="{ row }">
              <span class="num-strong">{{ row.students }}</span> 人次
            </template>
          </el-table-column>
          <el-table-column v-if="showCol('amount')" label="本月应发" min-width="140" align="right">
            <template #default="{ row }">
              <span class="fee-amount">¥{{ row.amount.toLocaleString() }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="showCol('fee')" label="课时费/节" min-width="120" align="right">
            <template #default="{ row }">
              <span class="fee-amount">¥{{ Number(row.classFee || 0).toLocaleString() }}</span>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="settlement.length" class="settlement-total">
          本月应发合计：
          <span class="fee-amount total">¥{{ totalAmount.toLocaleString() }}</span>
          <span class="settlement-note">按各{{ $t('instructor') }}薪资规则计算（按课时 / 按人头 / 混合），人数按实际签到计算</span>
        </div>
        <!-- 未结算提示是老板最容易漏看的财务口径警示，单独成行并用 warning 色强调 -->
        <div v-if="settlement.length && !monthSettled" class="settlement-unsettled-tip">
          ⚠ 本月尚未结算：点击「确认结算」后，课酬才计入财务报表净利润（当前净利润为虚高值）。
        </div>
        <div v-else-if="settlement.length && monthSettled" class="settlement-note">
          本月已结算入账，净利润已扣减课酬。
        </div>
      </div>

      <!-- 结算记录 -->
      <div class="section-title">结算记录</div>
      <div class="card table-container">
        <el-table :data="payrollLogs" v-loading="loadingLogs" empty-text="暂无结算记录，点击「确认结算」生成本月结算" size="small">
          <el-table-column label="月份" min-width="90">
            <template #default="{ row }">{{ monthLabelOf(row.month) }}</template>
          </el-table-column>
          <el-table-column :label="$t('instructor')" min-width="100">
            <template #default="{ row }">
              <span class="coach-name">{{ row.teacher_name }}</span>
            </template>
          </el-table-column>
          <el-table-column label="课次" min-width="80" align="right">
            <template #default="{ row }">{{ row.lesson_count }} 节</template>
          </el-table-column>
          <el-table-column label="结算金额" min-width="120" align="right">
            <template #default="{ row }">
              <span class="fee-amount">¥{{ Number(row.amount || 0).toLocaleString() }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" min-width="90">
            <template #default="{ row }">
              <StatusDot :tone="row.status === 'settled' ? 'success' : 'neutral'" :label="row.status === 'settled' ? '已结算' : '已作废'" subtle />
            </template>
          </el-table-column>
          <el-table-column label="结算时间" min-width="150">
            <!-- 作废记录后端已清空 paid_at：显示「—」而非回落 created_at（避免"已作废却有结算时间"的误导） -->
            <template #default="{ row }">{{ row.status === 'settled' ? fmtTime(row.paid_at || row.created_at) : '—' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.status === 'settled'" link type="danger" @click="voidLog(row)">作废</el-button>
              <span v-else class="settlement-note">—</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="settlement-note settlement-footnote">结算是按月整批进行的：作废该月<b>全部</b>结算记录后，方可重新「确认结算」；历史记录不会自动重算。</div>
      </div>

      <!-- 各周期概览 -->
      <div class="section-title">各周期概览</div>
      <div class="card table-container">
        <el-table :data="rows" v-loading="loading" size="small">
          <el-table-column :label="$t('instructor')" min-width="100">
            <template #default="{ row }">
              <span class="coach-name">{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column label="手机号" min-width="130">
            <template #default="{ row }">{{ row.phone || '-' }}</template>
          </el-table-column>
          <el-table-column v-for="p in periods" :key="p.key" :label="p.label" min-width="130">
            <template #default="{ row }">
              <span class="period-inline"><b>{{ row[p.key].classes }}</b> 节 · <b>{{ row[p.key].students }}</b> 人次</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" min-width="90">
            <template #default="{ row }">
              <StatusDot :tone="row.status === 'active' ? 'success' : 'neutral'" :label="row.status === 'active' ? '在职' : '停用'" subtle />
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 薪资规则配置弹窗 -->
      <el-dialog v-model="ruleDialogVisible" :title="`薪资规则 — ${ruleTarget?.name || ''}`" class="dlg-lg" destroy-on-close>
        <PayRuleEditor v-model="ruleDraft" />
        <template #footer>
          <div class="dialog-footer">
            <el-button @click="ruleDialogVisible = false">取消</el-button>
            <el-button type="primary" :loading="savingRule" @click="saveRule">保存规则</el-button>
          </div>
        </template>
      </el-dialog>

      <!-- 教练详情抽屉 -->
      <el-drawer v-model="detailVisible" :title="`${detailData?.teacher?.name || ''} · 课时明细（${monthLabel}）`" direction="rtl" size="720px">
        <div v-if="detailData" class="drawer-head">
          <div class="drawer-stats">
            <div class="stat-item">
              <span class="stat-num">{{ detailData.totals.classes }}</span>
              <span class="stat-label">课次</span>
            </div>
            <div class="stat-divider"></div>
            <div class="stat-item">
              <span class="stat-num">{{ detailData.totals.students }}</span>
              <span class="stat-label">人次</span>
            </div>
            <div class="stat-divider"></div>
            <div class="stat-item">
              <span class="stat-num fee-amount">¥{{ detailData.totals.amount.toLocaleString() }}</span>
              <span class="stat-label">应发薪资</span>
            </div>
          </div>
          <div class="drawer-rule-card" @click="openRuleDialog(detailTarget)">
            <div class="rule-card-left">
              <span class="rule-card-label">薪资规则</span>
              <span class="rule-card-value">{{ detailData.summary }}</span>
            </div>
            <el-icon class="rule-card-arrow"><ArrowRight /></el-icon>
          </div>
        </div>
        <el-table :data="detailData?.rows || []" max-height="520" empty-text="本月暂无排课" size="small">
          <el-table-column label="日期" min-width="110">
            <template #default="{ row }">{{ row.date }}</template>
          </el-table-column>
          <el-table-column label="活动" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">{{ row.courseName }}</template>
          </el-table-column>
          <el-table-column label="时间" min-width="130">
            <template #default="{ row }">{{ row.startTime }} - {{ row.endTime }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="80">
            <template #default="{ row }">
              <StatusDot :tone="row.status === 'scheduled' ? 'success' : 'warning'" :label="statusText[row.status] || row.status" subtle />
            </template>
          </el-table-column>
          <el-table-column label="报名" min-width="72">
            <template #default="{ row }">{{ row.enrolledCount }} 人</template>
          </el-table-column>
          <el-table-column label="签到" min-width="72">
            <template #default="{ row }">
              <span class="attended-num">{{ row.attended }}</span> 人
            </template>
          </el-table-column>
          <el-table-column label="计算说明" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.calcText }}</template>
          </el-table-column>
          <el-table-column label="金额（元）" min-width="110" align="right">
            <template #default="{ row }">
              <span class="fee-amount">{{ row.lessonAmount.toLocaleString() }}</span>
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <el-button :icon="Download" @click="openExport('one')">导出明细</el-button>
          <el-button @click="detailVisible = false">关闭</el-button>
        </template>
      </el-drawer>

      <!-- 字段设置 -->
      <ColumnSettingsDialog
        ref="colDialogRef"
        :title="$t('instructor') + '课时字段设置'"
        :columns="coachColumnDefs"
        v-model:settings="colSettings"
        :defaults="DEFAULT_COLUMN_SETTINGS"
        @save="saveColSettings"
        no-button
      />
    </template>

    <!-- 教练本人 -->
    <template v-else>
      <div class="self-grid">
        <div v-for="p in selfPeriods" :key="p.key" class="self-card">
          <span class="self-label">{{ p.label }}</span>
          <div class="self-nums">
            <span class="self-num v4-num-display is-md">{{ p.classes }}</span>
            <span class="self-num-label">上课节数</span>
          </div>
          <div class="self-nums people">
            <span class="self-num v4-num-display is-md">{{ p.students }}</span>
            <span class="self-num-label">上课人次</span>
          </div>
        </div>
      </div>
      <div v-if="selfPay" class="self-pay-card">
        <div class="self-pay-head">
          <span class="self-pay-title">本月薪资</span>
          <span class="self-pay-rule">{{ selfPay.summary }}</span>
        </div>
        <div class="self-pay-nums">
          <span class="self-pay-amount v4-num-display is-md">¥{{ selfPay.totals.amount.toLocaleString() }}</span>
          <span class="self-pay-detail">{{ selfPay.totals.classes }} 节 · {{ selfPay.totals.students }} 人次（按实际签到人数计算）</span>
        </div>
      </div>
      <div class="self-tip">上课节数 = 已排课未取消的课时；上课人次 = 已签到（含迟到）的成员人次；薪资规则由管理员配置，可查看本人当月预估。</div>
    </template>
  </div>

    <!-- 导出确认弹窗（课时明细 / 薪资结算 / 单人明细共用） -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出数据"
      description="选择时间范围后确认导出；未选择时默认导出本月。"
      default-shortcut="month"
      @confirm="doExport"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, computed, onMounted } from 'vue'
import { Download, ArrowRight, Money } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'
import {
  getCoachStats,
  getAdminCoachStats,
  getCoachClasses,
  getAdminCoachClasses,
  getPayrollCoaches,
  getPayrollCoachDetail,
  updatePayrollRule,
  getMyPayroll,
  settlePayroll,
  getPayrollLogs,
  voidPayrollLog,
} from '@/api/modules'
import { exportXlsx } from '@/utils/xlsx'
import ExportDialog from '@/components/ExportDialog.vue'
import StatusDot from '@/components/StatusDot.vue'
import PageHeader from '@/components/PageHeader.vue'
import PayRuleEditor from '@/components/PayRuleEditor.vue'
import ColumnSettingsDialog from '@/components/ColumnSettingsDialog.vue'

const userStore = useUserStore()
const settingsStore = useSettingsStore()
const t = settingsStore.t
const isAdmin = computed(() => userStore.userRole === 'admin')
const loading = ref(false)
const month = ref(dayjs().format('YYYY-MM'))
const exportDialogRef = ref(null)
const exportAction = ref('detail')
const monthLabel = computed(() => month.value.replace('-', '年') + '月')
const monthLabelOf = (m) => (m ? String(m).replace('-', '年') + '月' : '—')
const fmtTime = (v) => {
  if (!v) return '—'
  const d = dayjs(Number(v) || v)
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : String(v)
}
const rows = ref([])
const settlement = ref([])
const selfPeriods = ref([])
const selfPay = ref(null)
const statusText = { scheduled: '正常', adjusted: '调整', cancelled: '取消' }

const periods = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'year', label: '本年' },
  { key: 'total', label: '累计' },
]

const monthRange = () => {
  const [y, m] = month.value.split('-').map(Number)
  const start = `${month.value}-01`
  const end = `${month.value}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
  return { startDate: start, endDate: end }
}

const effectiveRange = (range) => (range && range.length === 2
  ? { startDate: range[0], endDate: range[1] }
  : monthRange())

const totalAmount = computed(() => settlement.value.reduce((s, r) => s + (r.amount || 0), 0))

const error = ref('')

const load = async () => {
  error.value = ''
  loading.value = true
  try {
    if (isAdmin.value) {
      const [stats, payroll] = await Promise.all([
        getAdminCoachStats(month.value),
        getPayrollCoaches({ month: month.value }),
      ])
      rows.value = stats.list || []
      const feeMap = {}
      for (const c of rows.value) feeMap[c.teacherId] = Number(c.classFee) || 0
      settlement.value = (payroll.list || []).map((c) => ({
        ...c,
        phone: c.phone || '',
        classFee: feeMap[c.teacherId] || c.payRule?.baseRate || 0,
      }))
    } else {
      const [data, pay] = await Promise.all([
        getCoachStats(month.value),
        getMyPayroll({ month: month.value }),
      ])
      selfPeriods.value = periods.map((p) => ({
        key: p.key, label: p.label,
        classes: data[p.key]?.classes || 0,
        students: data[p.key]?.students || 0,
      }))
      selfPay.value = pay || null
    }
  } catch (e) {
    error.value = e?.message || '数据加载失败，请稍后重试'
    rows.value = []
    settlement.value = []
  } finally {
    loading.value = false
  }
}

// ============ 按月结算（写入 payroll_logs，净利润随之扣减课酬） ============
const settling = ref(false)
const loadingLogs = ref(false)
const payrollLogs = ref([])
// 全量列表接口有 LIMIT 200 窗口：记录变多后旧月份会掉出窗口，
// 仅靠窗口判断「本月已结算」会误判成未结算 → 单独拉当前选中月份的记录做判定。
// null = 该月尚未加载（回退用窗口列表判断，避免首屏空窗期按钮闪变）
const monthLogs = ref(null)
const monthSettled = computed(() => {
  const src = monthLogs.value !== null ? monthLogs.value : payrollLogs.value
  return src.some((r) => r.month === month.value && r.status === 'settled')
})

const loadLogs = async (m) => {
  if (!isAdmin.value) return
  loadingLogs.value = true
  try {
    const res = await getPayrollLogs(m)
    if (m) monthLogs.value = res.list || []
    else payrollLogs.value = res.list || []
  } catch (e) {
    if (m) monthLogs.value = []
    else payrollLogs.value = []
  } finally {
    loadingLogs.value = false
  }
}

const refreshLogs = () => Promise.all([loadLogs(), loadLogs(month.value)])

const onMonthChange = () => {
  monthLogs.value = null
  load()
  loadLogs(month.value)
}

const settleCount = computed(() => settlement.value.filter((r) => (r.amount || 0) > 0).length)

const settleNow = async () => {
  if (!settleCount.value) {
    ElMessage.warning('本月暂无应付课酬（金额为 0 的教练不会被结算）')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确认结算 ${monthLabel.value} 全部${t('instructor')}课时费（${settleCount.value} 位 · 合计 ¥${totalAmount.value.toLocaleString()}）？结算后课酬将计入财务报表净利润，如需重算需先作废本月结算记录。`,
      '确认薪资结算',
      { type: 'warning', confirmButtonText: '确认结算', cancelButtonText: '取消' }
    )
  } catch (e) {
    return // 用户取消
  }
  settling.value = true
  try {
    const res = await settlePayroll(month.value)
    ElMessage.success(
      `已结算 ${res.settled} 位 · ¥${Number(res.totalAmount || 0).toLocaleString()}`
      + (res.clamped ? '（截至今日已发生的课节；月底后可作废重算补入剩余课程）' : '')
    )
    await Promise.all([refreshLogs(), load()])
  } catch (e) { /* 拦截器已提示（如"该月已结算"） */ } finally {
    settling.value = false
  }
}

const voidLog = async (row) => {
  // 结算是整月批量：作废单行后该月若还剩其它 settled 记录，「确认结算」仍被锁定——提前讲清，避免老板逐条找不到按钮
  // 计数来源：正在查看的月份用 monthLogs（该月全量，不受列表 200 条窗口限制），其余月份回落窗口列表
  const src = row.month === month.value && monthLogs.value ? monthLogs.value : payrollLogs.value
  const others = src.filter((r) => r.month === row.month && r.status === 'settled' && r.id !== row.id).length
  const extra = others > 0 ? `\n该月另有 ${others} 位${t('instructor')}的结算记录，需全部作废后才能重新「确认结算」。` : '\n作废后可对该月重新「确认结算」。'
  try {
    await ElMessageBox.confirm(
      `作废「${row.teacher_name}」${monthLabelOf(row.month)} 的结算记录（¥${Number(row.amount || 0).toLocaleString()}）？作废后净利润不再扣减该笔课酬。${extra}`,
      '确认作废',
      { type: 'warning', confirmButtonText: '作废', cancelButtonText: '取消' }
    )
  } catch (e) {
    return
  }
  try {
    await voidPayrollLog(row.id)
    ElMessage.success('已作废')
    await refreshLogs()
  } catch (e) { /* 拦截器已提示 */ }
}

// ============ 薪资规则配置 ============
const ruleDialogVisible = ref(false)
const ruleTarget = ref(null)
const ruleDraft = ref(null)
const savingRule = ref(false)

const openRuleDialog = (row) => {
  ruleTarget.value = row
  ruleDraft.value = row.payRule || null
  ruleDialogVisible.value = true
}

const saveRule = async () => {
  if (!ruleTarget.value) return
  savingRule.value = true
  try {
    const res = await updatePayrollRule(ruleTarget.value.teacherId, ruleDraft.value)
    ElMessage.success(`已保存「${ruleTarget.value.name}」薪资规则`)
    ruleDialogVisible.value = false
    // 刷新结算数据
    await load()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    savingRule.value = false
  }
}

// ============ 教练详情抽屉 ============
const detailVisible = ref(false)
const detailData = ref(null)
const detailTarget = ref(null)

const openDetailDrawer = async (row) => {
  try {
    const res = await getPayrollCoachDetail(row.teacherId, { month: month.value })
    detailData.value = res
    detailTarget.value = row
    detailVisible.value = true
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

// ============ 字段设置（本地持久化） ============
const coachColumnDefs = [
  { key: 'coach', label: t('instructor') },
  { key: 'classes', label: '本月课次' },
  { key: 'students', label: '本月人次' },
  { key: 'amount', label: '本月应发' },
  { key: 'fee', label: '课时费/节' },
]
const DEFAULT_COLUMN_SETTINGS = {
  coach: true, classes: true, students: true, amount: true, fee: true,
}
// localStorage 可能被旧版本写入损坏数据：解析失败时回退为空对象
let savedCols = {}
try { savedCols = JSON.parse(localStorage.getItem('edu_coach_cols') || '{}') } catch (e) { savedCols = {} }
const colSettings = ref(savedCols)
const showCol = (key) => colSettings.value[key] !== false
const colDialogRef = ref(null)
const saveColSettings = (settings) => {
  colSettings.value = settings
  localStorage.setItem('edu_coach_cols', JSON.stringify(settings))
  ElMessage.success('字段设置已保存')
}

// ============ 导出 ============
const buildRows = (list) => {
  return (list || []).map((r) => [
    r.date || '',
    r.courseName || '',
    r.startTime || '',
    r.endTime || '',
    statusText[r.status] || r.status || '',
    r.enrolledCount || 0,
    r.attended || 0,
    r.calcText || '',
    r.lessonAmount || 0,
  ])
}

const openExport = (action) => {
  exportAction.value = action
  exportDialogRef.value?.open()
}

const doExport = async (range) => {
  if (exportAction.value === 'settlement') return doExportSettlement(range)
  if (exportAction.value === 'one') return doExportOne(range)
  return doExportDetail(range)
}

const doExportDetail = async (range) => {
  try {
    const res = await getAdminCoachClasses(effectiveRange(range))
    const list = res.list || []
    if (!list.length) { ElMessage.warning('所选时间段暂无排课记录'); return }
    const headers = ['日期', '活动', '开始时间', '结束时间', '状态', '报名人数', '签到人数', t('instructor')]
    const rows = list.map((r) => [
      r.date || '', r.course_name || '', r.start_time || '', r.end_time || '',
      statusText[r.status] || r.status || '', r.enrolled_count || 0, r.attended || 0, r.teacher_name || '',
    ])
    const totalClasses = list.length
    const totalAttended = list.reduce((s, r) => s + (r.attended || 0), 0)
    rows.push(['', '', '', '', '', `合计 ${totalClasses} 节`, `签到 ${totalAttended} 人次`, ''])
    exportXlsx(`课时明细_${month.value}`, headers, rows, { sheetName: '课时明细' })
    ElMessage.success(`已导出 ${totalClasses} 节课时明细`)
  } catch (e) { /* 拦截器已提示 */ }
}

const doExportSettlement = async (range) => {
  try {
    if (!settlement.value.length) { ElMessage.warning('本月暂无排课记录'); return }
    const headers = [t('instructor'), '手机号', '本月课时', '本月人次', '课时费/节', '薪资规则', '本月应发（元）']
    const rows = settlement.value.map((r) => [
      r.name, r.phone || '', r.classes, r.students, r.classFee || 0, r.ruleSummary, r.amount || 0,
    ])
    rows.push(['', '', '', '', '', '合计', totalAmount.value])
    exportXlsx(`薪资结算_${month.value}`, headers, rows, { sheetName: '薪资结算' })
    ElMessage.success('已导出薪资结算表')
  } catch (e) { /* 拦截器已提示 */ }
}

const doExportOne = async (range) => {
  try {
    const row = detailTarget.value
    if (!row) return
    const res = await getPayrollCoachDetail(row.teacherId, { month: month.value })
    const list = res.rows || []
    if (!list.length) { ElMessage.warning(`该${t('instructor')}本月暂无排课`); return }
    const headers = ['日期', '活动', '开始时间', '结束时间', '状态', '报名人数', '签到人数', '计算说明', '金额（元）']
    const rows = buildRows(list)
    rows.push(['', '', '', '', '', '', '', '合计', res.totals.amount])
    exportXlsx(`薪资明细_${row.name}_${month.value}`, headers, rows, { sheetName: '薪资明细' })
    ElMessage.success(`已导出「${row.name}」薪资明细`)
  } catch (e) { /* 拦截器已提示 */ }
}

onMounted(() => {
  load()
  refreshLogs()
})
</script>

<style lang="scss" scoped>
.coach-name { display: block; font-weight: 600; color: var(--t-text-1); }

.table-container {
  margin-bottom: var(--t-spacing-lg);
}

.num-strong { font-weight: 700; color: var(--t-text-1); font-variant-numeric: tabular-nums; }
.fee-amount { font-weight: 700; color: var(--t-accent-strong); font-variant-numeric: tabular-nums; }
.fee-amount.total { font-size: var(--t-fs-lg); }
.period-inline {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;
  b {
    color: var(--t-text-1);
    font-weight: 600;
  }
}
.settlement-total {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-top: var(--t-spacing-md);
  padding-top: var(--t-spacing-md);
  border-top: 1px solid var(--t-line);
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
}
.settlement-note { font-size: var(--t-fs-xs); font-weight: 400; color: var(--t-text-3); }
.settlement-footnote { margin-top: var(--t-spacing-sm, 8px); }
.settlement-unsettled-tip {
  margin-top: var(--t-spacing-sm, 8px);
  font-size: var(--t-fs-sm);
  color: var(--t-warning-text);
  background: color-mix(in srgb, var(--t-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--t-warning) 28%, transparent);
  border-radius: var(--t-radius-sm, 6px);
  padding: 6px 10px;
}
.attended-num { font-weight: 700; color: var(--t-text-1); }

.drawer-head {
  display: flex;
  flex-direction: column;
  gap: var(--t-spacing-md);
  margin-bottom: var(--t-spacing-lg);
}
.drawer-stats {
  display: flex;
  align-items: center;
  gap: var(--t-spacing-lg);
  padding: var(--t-spacing-md) var(--t-spacing-lg);
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-xl);
}
.stat-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat-num {
  font-size: var(--t-fs-2xl);
  font-weight: 700;
  color: var(--t-text-1);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.stat-item .fee-amount {
  font-size: var(--t-fs-2xl);
}
.stat-label {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}
.stat-divider {
  width: 1px;
  height: 32px;
  background: var(--t-line);
}
.drawer-rule-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--t-spacing-md) var(--t-spacing-lg);
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-xl);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.drawer-rule-card:hover {
  border-color: var(--t-accent-line);
  background: var(--t-surface-hover);
}
.rule-card-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.rule-card-label {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-text-1);
  white-space: nowrap;
}
.rule-card-value {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rule-card-arrow {
  font-size: var(--t-fs-base);
  color: var(--t-text-3);
  flex-shrink: 0;
}

.self-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
.self-card { background: var(--t-surface); border: 1px solid var(--t-line); border-radius: var(--t-radius-xl); padding: 24px; }
.self-label { font-size: var(--t-fs-sm); font-weight: 600; color: var(--t-accent-text); }
.self-nums { display: flex; align-items: baseline; gap: 8px; margin-top: var(--t-spacing-md); }
.self-num { font-size: var(--v4-fs-5xl); font-weight: 700; color: var(--t-text-1); font-variant-numeric: tabular-nums; line-height: 1; letter-spacing: -0.025em; }
.self-nums.people .self-num { color: var(--t-accent-strong); }
.self-num-label { font-size: var(--t-fs-xs); color: var(--t-text-3); }
.self-pay-card {
  margin-top: var(--t-spacing-md);
  background: linear-gradient(135deg, var(--t-accent-bg), var(--t-surface-hover));
  border: 1px solid var(--t-accent-line);
  border-radius: var(--t-radius-xl);
  padding: 24px;
}
.self-pay-head { display: flex; align-items: baseline; gap: 12px; }
.self-pay-title { font-size: var(--t-fs-base); font-weight: 700; color: var(--t-text-1); }
.self-pay-rule { font-size: var(--t-fs-sm); color: var(--t-accent-text); }
.self-pay-nums { display: flex; align-items: baseline; gap: var(--t-spacing-md); margin-top: var(--t-spacing-sm); flex-wrap: wrap; }
.self-pay-amount { font-size: var(--v4-fs-5xl); font-weight: 700; color: var(--t-accent-strong); font-variant-numeric: tabular-nums; line-height: 1; letter-spacing: -0.025em; }
.self-pay-detail { font-size: var(--t-fs-xs); color: var(--t-text-2); }
.self-tip { margin-top: var(--t-spacing-md); font-size: var(--t-fs-xs); color: var(--t-text-3); background: var(--t-surface); border: 1px solid var(--t-line); border-radius: var(--t-radius-xl); padding: var(--t-spacing-sm) var(--t-spacing-md); }
</style>
