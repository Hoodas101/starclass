<template>
  <div class="page-shell">
    <!-- 顶部标题 -->
    <PageHeader v-if="!embedded" title="积分管理" />
    <!-- 顶部操作栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-count">与小程序端积分实时同步</span>
      </div>
      <div class="toolbar-right">
        <el-input v-model="keyword" placeholder="搜索成员姓名 / 电话" :prefix-icon="Search" clearable style="width: 220px" @change="loadList" @clear="loadList" @keyup.enter="loadList" />
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出</el-button>
        <el-button :type="selectMode ? 'primary' : 'default'" :icon="selectMode ? 'Check' : 'Finished'" @click="toggleSelectMode">
          {{ selectMode ? '退出多选' : '多选' }}
        </el-button>
      </div>
    </div>

    <!-- 积分总览 -->
    <div class="metric-row">
      <div class="metric-card">
        <span class="metric-label">积分账户</span>
        <span class="metric-value">{{ summary.accounts }}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">累计发放</span>
        <span class="metric-value">{{ summary.totalEarned }}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">累计消耗</span>
        <span class="metric-value">{{ summary.totalConsumed }}</span>
      </div>
      <div class="metric-card accent">
        <span class="metric-label">当前总余额</span>
        <span class="metric-value">{{ summary.totalBalance }}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">人均余额</span>
        <span class="metric-value">{{ summary.avgBalance }}</span>
      </div>
    </div>

    <!-- 成员积分列表 -->
    <div class="card table-container">
      <!-- 多选批量操作栏 -->
      <div v-if="selectMode" class="batch-bar">
        <span class="batch-count">已选 {{ selectedRows.length }} 人</span>
        <div class="batch-actions">
          <el-button size="small" type="success" :disabled="!selectedRows.length" @click="openBatchAdjust">统一加分</el-button>
          <el-button size="small" @click="selectedRows = []">清空选择</el-button>
          <el-button size="small" text @click="toggleSelectMode">退出多选</el-button>
        </div>
      </div>
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadList" />
      <el-table v-else :data="list" v-loading="loading" size="small" @row-click="openLogs" @selection-change="selectedRows = $event" row-class-name="clickable-row">
        <el-table-column v-if="selectMode" type="selection" width="40" />
        <el-table-column label="排名" min-width="56">
          <template #default="{ $index }">
            <span class="rank-no" :class="{ top: $index < 3 }">{{ $index + 1 }}</span>
          </template>
        </el-table-column>
        <el-table-column label="成员" min-width="120">
          <template #default="{ row }">
            <div class="student-cell">
              <EntityAvatar :name="row.student_name || row.student_id" size="sm" />
              <span class="student-name">{{ row.student_name || row.student_id }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="电话" min-width="120" prop="phone" />
        <el-table-column label="当前积分" min-width="100" align="right">
          <template #default="{ row }">
            <span class="balance-num">{{ row.balance }}</span>
          </template>
        </el-table-column>
        <el-table-column label="累计获得" min-width="90" prop="total_earned" align="right" />
        <el-table-column label="累计消耗" min-width="90" prop="total_consumed" align="right" />
      </el-table>
      <div class="pagination-wrap">
        <el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="total, prev, pager, next" background @current-change="loadList" />
      </div>
    </div>

    <!-- 成员积分详情抽屉 -->
    <el-drawer v-model="logsOpen" size="var(--t-drawer-md)" :title="`${logStudent ? logStudent.student_name : ''} · 积分详情`">
      <div v-if="logStudent" class="detail-body">
        <div class="detail-header">
          <EntityAvatar :name="logStudent.student_name || logStudent.student_id" size="xl" tone="success" />
          <div class="detail-header-info">
            <h3>{{ logStudent.student_name || logStudent.student_id }}</h3>
            <span class="detail-phone">{{ logStudent.phone || '-' }}</span>
          </div>
        </div>

        <div class="detail-stats">
          <div class="detail-stat">
            <span class="detail-stat-num balance-num">{{ logStudent.balance }}</span>
            <span class="detail-stat-label">当前积分</span>
          </div>
          <div class="detail-stat">
            <span class="detail-stat-num">{{ logStudent.total_earned || 0 }}</span>
            <span class="detail-stat-label">累计获得</span>
          </div>
          <div class="detail-stat">
            <span class="detail-stat-num">{{ logStudent.total_consumed || 0 }}</span>
            <span class="detail-stat-label">累计消耗</span>
          </div>
        </div>

        <div class="detail-actions">
          <el-button type="success" plain size="small" @click="openAdjust(logStudent, 'earn')">发放积分</el-button>
          <el-button type="warning" plain size="small" @click="openAdjust(logStudent, 'consume')">扣减积分</el-button>
          <el-button type="primary" plain size="small" :icon="Download" :disabled="!logs.length" @click="openExport('logs')">导出明细</el-button>
        </div>

        <div class="detail-section">
          <h4>积分明细</h4>
          <el-table :data="logs" v-loading="logsLoading" size="small">
            <el-table-column label="类型" min-width="72">
              <template #default="{ row }">
                <span class="log-amount" :class="row.type === 'earn' ? 'earn' : 'consume'">
                  {{ row.type === 'earn' && Number(row.amount) > 0 ? '+' : '-' }}{{ Math.abs(Number(row.amount) || 0) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="原因" min-width="150" prop="reason" show-overflow-tooltip />
            <el-table-column label="时间" min-width="140">
              <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
            </el-table-column>
          </el-table>
          <div v-if="logs.length === 0 && !logsLoading" class="empty-tip">暂无积分流水</div>
        </div>
      </div>
    </el-drawer>

    <!-- 积分调整弹窗（支持单个 / 多选批量） -->
    <el-dialog v-model="adjustOpen" :title="batchAdjust ? `批量${adjustType === 'earn' ? '发放' : '扣减'}积分（${selectedRows.length} 人）` : (adjustType === 'earn' ? '发放积分' : '扣减积分')" class="dlg-sm">
      <div v-if="adjustStudent && !batchAdjust" class="adjust-student">
        成员：<strong>{{ adjustStudent.student_name }}</strong>（当前 {{ adjustStudent.balance }} 分）
      </div>
      <div v-else-if="batchAdjust" class="adjust-student">
        将 {{ adjustType === 'earn' ? '发放' : '扣减' }} <strong>{{ adjustAmount }}</strong> 分给选中的 <strong>{{ selectedRows.length }}</strong> 名成员
      </div>
      <el-form label-position="top">
        <el-form-item :label="adjustType === 'earn' ? '发放积分' : '扣减积分'" required>
          <el-input-number v-model="adjustAmount" :min="1" :max="9999" style="width: 100%" />
        </el-form-item>
        <el-form-item label="原因" required>
          <el-input v-model="adjustReason" placeholder="如：转介绍奖励 / 活动积分 / 兑换扣减" maxlength="50" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustOpen = false">取消</el-button>
        <el-button :type="adjustType === 'earn' ? 'success' : 'warning'" :loading="adjusting" @click="saveAdjust">
          {{ batchAdjust ? '确认批量' + (adjustType === 'earn' ? '发放' : '扣减') : (adjustType === 'earn' ? '发放' : '扣减') }}
        </el-button>
      </template>
    </el-dialog>
  </div>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出积分数据"
      description="选择时间范围后确认导出；留空导出全部成员积分。"
      @confirm="doExportByAction"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, reactive, onMounted } from 'vue'
import { Search, Download } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { getPointsSummary, getPointsList, getPointsLogs, adjustPoints } from '@/api/modules'
import { exportXlsx } from '@/utils/xlsx'
import { fetchAllPages } from '@/utils/fetchAll'
import EntityAvatar from '@/components/EntityAvatar.vue'
import PageHeader from '@/components/PageHeader.vue'
import ExportDialog from '@/components/ExportDialog.vue'

const summary = reactive({ accounts: 0, totalEarned: 0, totalConsumed: 0, totalBalance: 0, avgBalance: 0 })
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = 10
const loading = ref(false)
const keyword = ref('')

// 多选模式（平时不显示多选列，进入多选后才出现）
const selectMode = ref(false)
const selectedRows = ref([])

const toggleSelectMode = () => {
  selectMode.value = !selectMode.value
  selectedRows.value = []
}

const loadSummary = async () => {
  try {
    const res = await getPointsSummary()
    Object.assign(summary, res)
  } catch (e) { /* 忽略 */ }
}

const error = ref('')

const loadList = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await getPointsList({ page: page.value, pageSize, keyword: keyword.value || undefined })
    list.value = res?.list || []
    total.value = res?.total || 0
  } catch (e) {
    error.value = e?.message || '数据加载失败，请稍后重试'
    list.value = []
  } finally {
    loading.value = false
  }
}

const doExport = async (range) => {
  try {
    const list = await fetchAllPages(getPointsList, { keyword: keyword.value || undefined })
    if (!list.length) {
      ElMessage.warning('暂无可导出的积分数据')
      return
    }
    const headers = ['排名', '成员', '电话', '当前积分', '累计获得', '累计消耗']
    const rows = list.map((row, i) => [
      i + 1,
      row.student_name || row.student_id,
      row.phone || '',
      row.balance ?? 0,
      row.total_earned ?? 0,
      row.total_consumed ?? 0
    ])
    exportXlsx(`积分管理_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '成员积分' })
    ElMessage.success(`已导出 ${rows.length} 名成员积分`)
  } catch (e) {
    // 拦截器已提示
  }
}

// 明细
const logsOpen = ref(false)
const logs = ref([])
const logsLoading = ref(false)
const logStudent = ref(null)
const exportDialogRef = ref(null)
const openLogs = async (row) => {
  if (selectMode.value) return
  logStudent.value = row
  logsOpen.value = true
  logsLoading.value = true
  try {
    const res = await getPointsLogs({ studentId: row.student_id, page: 1, pageSize: 50 })
    logs.value = res?.list || []
  } catch (e) {
    logs.value = []
  } finally {
    logsLoading.value = false
  }
}

// 导出弹窗：动作分发（logs=成员积分明细 / list=全员积分表）
const exportAction = ref('list')
const openExport = (action) => {
  exportAction.value = action
  exportDialogRef.value?.open()
}

const doExportByAction = async (range) => {
  if (exportAction.value === 'logs') return doExportLogs(range)
  return doExport(range)
}

// 导出当前成员的积分明细（时间序列流水）
const doExportLogs = (range) => {
  if (!logs.value.length) { ElMessage.warning('暂无可导出的积分明细'); return }
  const headers = ['类型', '变动', '变动后余额', '原因', '时间']
  const typeText = { earn: '获得', consume: '消耗', refund: '退款回收', checkin: '签到' }
  const rows = logs.value.map((l) => [
    typeText[l.type] || l.type,
    (l.type === 'earn' || l.type === 'checkin' ? '+' : '-') + (l.amount ?? 0),
    l.balance ?? '',
    l.reason || '',
    formatTime(l.created_at),
  ])
  const filtered = range && range.length === 2
    ? rows.filter((r) => r[4] >= range[0] && r[4] <= range[1] + ' 23:59:59')
    : rows
  if (!filtered.length) { ElMessage.warning('所选时间段暂无积分明细'); return }
  exportXlsx(`积分明细_${logStudent.value?.student_name || '成员'}_${dayjs().format('YYYYMMDD')}`, headers, filtered, { sheetName: '积分明细' })
  ElMessage.success(`已导出 ${filtered.length} 条积分明细`)
}

// 调整
const adjustOpen = ref(false)
const adjustStudent = ref(null)
const adjustType = ref('earn')
const adjustAmount = ref(10)
const adjustReason = ref('')
const adjusting = ref(false)
const batchAdjust = ref(false)

const openAdjust = (row, type) => {
  adjustStudent.value = row
  batchAdjust.value = false
  adjustType.value = type
  adjustAmount.value = type === 'earn' ? 10 : 1
  adjustReason.value = type === 'earn' ? '积分奖励' : '积分兑换'
  adjustOpen.value = true
}

const openBatchAdjust = () => {
  if (!selectedRows.value.length) return
  adjustStudent.value = null
  batchAdjust.value = true
  adjustType.value = 'earn'
  adjustAmount.value = 10
  adjustReason.value = '批量积分奖励'
  adjustOpen.value = true
}

const saveAdjust = async () => {
  if (!adjustReason.value) { ElMessage.warning('请填写原因'); return }
  // 扣减前预校验余额：避免负余额 / 超发；批量时若有人不足则整体拦截，保证原子性
  if (adjustType.value === 'consume') {
    const targets = batchAdjust.value ? selectedRows.value : [adjustStudent.value]
    const insufficient = (targets || []).filter((r) => Number(r?.balance || 0) < adjustAmount.value)
    if (insufficient.length) {
      ElMessage.warning(`有 ${insufficient.length} 名成员当前积分不足 ${adjustAmount.value}，已取消本次扣减`)
      return
    }
  }
  adjusting.value = true
  try {
    if (batchAdjust.value) {
      // 逐行提交非原子：失败时如实告知已成功的条数，避免用户误以为整批未生效/整批生效
      let done = 0
      for (const row of selectedRows.value) {
        try {
          await adjustPoints({
            studentId: row.student_id,
            type: adjustType.value,
            amount: adjustAmount.value,
            reason: adjustReason.value,
          })
          done += 1
        } catch (e) {
          ElMessage.error(`${row.student_name || row.student_id} 调整失败（已成功 ${done} 条，后续中断）`)
          break
        }
      }
      if (done === selectedRows.value.length) {
        ElMessage.success(`已${adjustType.value === 'earn' ? '发放' : '扣减'} ${done} 名成员积分`)
      }
      selectedRows.value = []
    } else {
      await adjustPoints({
        studentId: adjustStudent.value.student_id,
        type: adjustType.value,
        amount: adjustAmount.value,
        reason: adjustReason.value,
      })
      ElMessage.success(adjustType.value === 'earn' ? '积分已发放' : '积分已扣减')
    }
    adjustOpen.value = false
    loadList(); loadSummary()
    if (logsOpen.value && !batchAdjust.value) openLogs(adjustStudent.value)
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    adjusting.value = false
  }
}

const formatTime = (ts) => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(() => { loadSummary(); loadList() })
</script>

<style lang="scss" scoped>
.metric-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--t-spacing-md);
  margin-bottom: var(--t-spacing-lg);
}

.metric-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-xl);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  &.accent {
    background: var(--t-accent-bg);
    border-color: var(--t-accent-line);
    .metric-value { color: var(--t-accent-text); }
  }
}

.metric-label { font-size: var(--t-fs-xs); color: var(--t-text-3); }
.metric-value { font-size: var(--t-fs-lg); font-weight: 700; color: var(--t-text-1); font-variant-numeric: tabular-nums; }

.rank-no {
  font-weight: 600;
  color: var(--t-text-3);
  font-variant-numeric: tabular-nums;

  &.top { color: var(--t-accent-text); font-weight: 700; }
}

.student-name { font-weight: 600; color: var(--t-text-1); }
.balance-num { font-size: var(--t-fs-lg); font-weight: 700; color: var(--t-accent-text); font-variant-numeric: tabular-nums; }

// 多选模式
.batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--t-spacing-sm) var(--t-spacing-md);
  margin-bottom: var(--t-spacing-md);
  background: var(--t-accent-bg);
  border: 1px solid var(--t-accent-line);
  border-radius: var(--t-radius-xl);
}

.batch-count {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-accent-strong, var(--t-accent));
}

.batch-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}


.student-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

// 成员详情抽屉
.detail-header {
  display: flex;
  align-items: center;
  gap: var(--t-spacing-md);
  margin-bottom: var(--t-spacing-lg);
}

  .detail-header-info {
    h3 {
      font-size: var(--t-fs-2xl);
    font-weight: 700;
    color: var(--t-text-1);
    margin: 0 0 4px;
  }
}

.detail-phone {
  font-size: var(--t-fs-sm);
  color: var(--t-text-3);
  font-variant-numeric: tabular-nums;
}

.detail-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--t-spacing-sm);
  margin-bottom: var(--t-spacing-md);
}

.detail-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: var(--t-spacing-md) var(--t-spacing-sm);
  background: var(--t-surface-hover);
  border-radius: var(--t-radius-xl);
}

.detail-stat-num {
  font-size: var(--t-fs-xl);
  font-weight: 700;
  color: var(--t-text-1);
  font-variant-numeric: tabular-nums;
}

.detail-stat-label {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.detail-actions {
  display: flex;
  gap: var(--t-spacing-sm);
  margin-bottom: var(--t-spacing-md);
}

.detail-section {
  h4 {
    font-size: var(--t-fs-xs);
    font-weight: 600;
    color: var(--t-text-3);
    margin: 0 0 var(--t-spacing-sm);
    letter-spacing: 0.5px;
  }
}

.log-amount {
  font-weight: 700;
  font-variant-numeric: tabular-nums;

  &.earn { color: var(--t-success-text); }
  &.consume { color: var(--t-warning-text); }
}

.logs-summary {
  margin-bottom: 16px;
  padding: 12px 16px;
  border-radius: var(--t-radius-xl);
  background: var(--t-accent-bg);
  border: 1px solid var(--t-accent-line);
  color: var(--t-text-1);
  font-size: var(--t-fs-base);
}

.empty-tip { text-align: center; color: var(--t-text-3); padding: var(--t-spacing-2xl) 0; font-size: var(--t-fs-base); }

.adjust-student {
  margin-bottom: 16px;
  font-size: var(--t-fs-base);
  color: var(--t-text-2);
}

@media (max-width: 1000px) {
  .metric-row { grid-template-columns: repeat(2, 1fr); }
}
</style>
