<template>
  <div class="page-shell">
    <PageHeader v-if="!embedded" title="试听预约" />

    <!-- 筛选栏 -->
    <div class="toolbar">
      <div class="toolbar-left filters">
        <el-select v-model="status" placeholder="全部状态" clearable style="width: 140px" @change="onFilterChange">
          <el-option v-for="o in statusOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <div class="toolbar-right">
        <el-button :icon="Refresh" @click="loadData">刷新</el-button>
      </div>
    </div>

    <div class="card table-container">
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadData" />
      <template v-else>
        <el-table :data="list" v-loading="loading" size="small">
          <el-table-column label="提交时间" min-width="140">
            <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="学员" min-width="130">
            <template #default="{ row }">
              <div class="trial-name">{{ row.student_name || '-' }}</div>
              <div v-if="studentMeta(row)" class="trial-sub">{{ studentMeta(row) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="家长 / 电话" min-width="170">
            <template #default="{ row }">
              <div>{{ row.parent_name || '—' }}</div>
              <div class="trial-sub">{{ row.parent_phone || '—' }}</div>
            </template>
          </el-table-column>
          <el-table-column label="意向课程" min-width="130" show-overflow-tooltip>
            <template #default="{ row }">{{ row.course_name || '未指定' }}</template>
          </el-table-column>
          <el-table-column label="期望时间" min-width="150">
            <template #default="{ row }">{{ preferredText(row) }}</template>
          </el-table-column>
          <el-table-column label="备注" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.note || '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="100">
            <template #default="{ row }">
              <StatusDot :tone="statusTone(row.status)" :label="statusText(row.status)" subtle />
            </template>
          </el-table-column>
          <el-table-column label="处理结果" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.status === 'pending'">—</span>
              <span v-else>{{ row.handle_note || (row.status === 'assigned' ? '已安排试听' : '已拒绝') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="130" fixed="right">
            <template #default="{ row }">
              <template v-if="row.status === 'pending'">
                <el-button type="primary" link size="small" @click.stop="openAssignDialog(row)">安排</el-button>
                <el-button type="danger" link size="small" @click.stop="handleReject(row)">拒绝</el-button>
              </template>
              <span v-else class="trial-sub">已处理</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="pagination-wrap">
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :total="total"
            :page-sizes="[10, 20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            background
            @current-change="loadData"
            @size-change="loadData"
          />
        </div>
      </template>
    </div>

    <!-- 安排试听弹窗 -->
    <el-dialog v-model="assignVisible" title="安排试听" class="dlg-md" destroy-on-close>
      <div class="assign-info">
        <div class="assign-row">
          <span class="assign-label">学员</span>
          <span class="assign-value">{{ current?.student_name || '—' }}</span>
        </div>
        <div class="assign-row">
          <span class="assign-label">家长</span>
          <span class="assign-value">{{ current?.parent_name || '—' }} {{ current?.parent_phone || '' }}</span>
        </div>
        <div class="assign-row">
          <span class="assign-label">期望时间</span>
          <span class="assign-value">{{ current ? preferredText(current) : '—' }}</span>
        </div>
      </div>
      <el-form label-position="top">
        <el-form-item label="关联排期（选填）">
          <el-select
            v-model="assignForm.scheduleId"
            filterable
            remote
            clearable
            :remote-method="loadScheduleOptions"
            placeholder="搜索排期，例如：体验课"
            style="width: 100%"
          >
            <el-option v-for="s in scheduleOptions" :key="s.id" :label="s.label" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注（选填）">
          <el-input
            v-model="assignForm.note"
            type="textarea"
            :rows="2"
            placeholder="例如：已电话确认周六 10:00 到店"
            maxlength="100"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitAssign">确认安排</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, reactive, onMounted } from 'vue'
import dayjs from 'dayjs'
import { Refresh } from '@element-plus/icons-vue'
import PageHeader from '@/components/PageHeader.vue'
import StatusDot from '@/components/StatusDot.vue'
import { getTrialList, updateTrial, getScheduleOptions } from '@/api/modules'

// 状态枚举与后端一致（backend/routes/trial.js）：
// apply 写入 'pending'；PUT /:id 按 action 置为 'assigned'（assign）或 'rejected'（reject）。
const statusOptions = [
  { value: 'pending', label: '待处理' },
  { value: 'assigned', label: '已安排' },
  { value: 'rejected', label: '已拒绝' },
]
const statusText = (s) => statusOptions.find((o) => o.value === s)?.label || s || '-'
const statusTone = (s) => ({ pending: 'warning', assigned: 'success', rejected: 'neutral' }[s] || 'neutral')

const status = ref('')
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)
const error = ref('')

const loadData = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await getTrialList({
      page: page.value,
      pageSize: pageSize.value,
      status: status.value || undefined,
    })
    list.value = res?.list || []
    total.value = res?.total || 0
  } catch (e) {
    // 列表加载失败：写 error 状态由 ListErrorState 呈现并提供重试（拦截器已提示业务/网络错误）
    error.value = e?.message || '加载试听预约失败'
    list.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

const onFilterChange = () => {
  page.value = 1
  loadData()
}

const formatTime = (ts) => (ts ? dayjs(Number(ts)).format('YYYY-MM-DD HH:mm') : '—')

const studentMeta = (row) => {
  const parts = []
  if (row?.student_age) parts.push(`${row.student_age} 岁`)
  if (row?.student_gender) parts.push(row.student_gender)
  return parts.join(' · ')
}

const preferredText = (row) => {
  const parts = [row?.preferred_date, row?.preferred_time].filter(Boolean)
  return parts.length ? parts.join(' ') : '未指定'
}

// ============================================
// 安排试听
// ============================================
const assignVisible = ref(false)
const current = ref(null)
const submitting = ref(false)
const scheduleOptions = ref([])
const assignForm = reactive({ scheduleId: '', note: '' })

const openAssignDialog = (row) => {
  current.value = row
  assignForm.scheduleId = ''
  assignForm.note = ''
  scheduleOptions.value = []
  assignVisible.value = true
  loadScheduleOptions('')
}

const loadScheduleOptions = async (query = '') => {
  try {
    const res = await getScheduleOptions({ q: query })
    scheduleOptions.value = res?.list || []
  } catch (e) {
    scheduleOptions.value = []
  }
}

const submitAssign = async () => {
  if (!current.value) return
  submitting.value = true
  try {
    await updateTrial(current.value.id, {
      action: 'assign',
      scheduleId: assignForm.scheduleId || '',
      note: assignForm.note || '',
    })
    ElMessage.success('已安排试听')
    assignVisible.value = false
    loadData()
  } catch (e) {
    // 错误信息已由拦截器提示
  } finally {
    submitting.value = false
  }
}

// ============================================
// 拒绝预约
// ============================================
const handleReject = async (row) => {
  const { value } = await ElMessageBox.prompt(
    `拒绝「${row.student_name}」的试听预约？可填写原因（家长会收到通知）`,
    '拒绝预约',
    {
      confirmButtonText: '确认拒绝',
      cancelButtonText: '取消',
      inputPlaceholder: '例如：该时段已满，请改约其他时间',
      inputValue: '',
    }
  ).catch(() => ({ value: undefined }))
  if (value === undefined) return
  try {
    await updateTrial(row.id, { action: 'reject', note: value || '' })
    ElMessage.success('已拒绝该预约')
    loadData()
  } catch (e) {
    // 错误信息已由拦截器提示
  }
}

onMounted(loadData)
</script>

<style scoped>
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: var(--t-spacing-lg);
}

.trial-name {
  font-weight: 600;
  color: var(--t-text-1);
}

.trial-sub {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.assign-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--t-spacing-md) var(--t-spacing-lg);
  margin-bottom: var(--t-spacing-lg);
  border-radius: var(--t-radius-lg);
  background: var(--t-surface-hover);
  border: 1px solid var(--t-line);
}

.assign-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  font-size: var(--t-fs-base);
}

.assign-label {
  flex: 0 0 64px;
  color: var(--t-text-3);
}

.assign-value {
  flex: 1;
  color: var(--t-text-1);
  word-break: break-all;
}
</style>
