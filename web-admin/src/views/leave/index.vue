<template>
  <div class="page-shell">
    <!-- 顶部标题（hub 内嵌；embedded 时由 hub 提供，本页不重复） -->
<PageHeader v-if="!embedded" title="请假管理" />
    <div class="toolbar">
      <div class="toolbar-left">
                <el-radio-group v-model="filterStatus" size="default" @change="onFilterChange">
          <el-radio-button value="">全部</el-radio-button>
          <el-radio-button value="pending">待审批</el-radio-button>
          <el-radio-button value="approved">已批准</el-radio-button>
          <el-radio-button value="rejected">已驳回</el-radio-button>
        </el-radio-group>
      </div>
      <div class="toolbar-right">
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出</el-button>
      </div>
    </div>

    <div class="card table-container">
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadList" />
      <el-table v-else :data="list" v-loading="loading" size="small" @row-click="openApprove" row-class-name="clickable-row">
        <el-table-column label="成员" min-width="100" >
          <template #default="{ row }">
            <span class="student-name">{{ row.student_name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="活动" min-width="140"  show-overflow-tooltip>
          <template #default="{ row }">{{ row.course_name }}</template>
        </el-table-column>
        <el-table-column label="请假时间" min-width="130" >
          <template #default="{ row }">{{ row.date }} {{ row.start_time }}</template>
        </el-table-column>
        <el-table-column label="请假原因" min-width="160"  show-overflow-tooltip>
          <template #default="{ row }">{{ row.reason }}</template>
        </el-table-column>
        <el-table-column label="家长电话" min-width="120" >
          <template #default="{ row }">{{ row.parent_phone || '-' }}</template>
        </el-table-column>
        <el-table-column label="申请时间" min-width="100" >
          <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="状态" min-width="100">
          <template #default="{ row }">
            <StatusDot :tone="statusDotTone[row.status] || 'neutral'" :label="statusTextMap[row.status] || row.status" subtle />
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @current-change="loadList"
          @size-change="onSizeChange"
        />
      </div>
    </div>
  </div>

    <!-- 请假审批弹窗 -->
    <el-dialog v-model="approveVisible" title="请假审批" class="dlg-md">
      <div v-if="current" class="leave-detail">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="成员">{{ current.student_name }}</el-descriptions-item>
          <el-descriptions-item label="活动">{{ current.course_name }}</el-descriptions-item>
          <el-descriptions-item label="请假时间">{{ current.date }} {{ current.start_time }}</el-descriptions-item>
          <el-descriptions-item label="家长电话">{{ current.parent_phone || '-' }}</el-descriptions-item>
          <el-descriptions-item label="申请时间">{{ formatDate(current.created_at) }}</el-descriptions-item>
          <el-descriptions-item label="请假原因">{{ current.reason }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <StatusDot :tone="statusDotTone[current.status]" :label="statusTextMap[current.status]" subtle />
          </el-descriptions-item>
          <el-descriptions-item v-if="current.review_note" label="审批备注">{{ current.review_note }}</el-descriptions-item>
        </el-descriptions>
      </div>
      <template #footer>
        <el-button @click="approveVisible = false">关闭</el-button>
        <template v-if="current && current.status === 'pending'">
          <el-button type="danger" plain @click="rejectFromDialog">驳回</el-button>
          <el-button type="success" @click="approveFromDialog">批准</el-button>
        </template>
      </template>
    </el-dialog>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出请假数据"
      description="选择时间范围后确认导出，留空导出全部请假记录。"
      @confirm="doExport"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, onMounted } from 'vue'
import { Download } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { getLeaves, approveLeave } from '@/api/modules'
import { exportXlsx } from '@/utils/xlsx'
import { fetchAllPages } from '@/utils/fetchAll'
import ExportDialog from '@/components/ExportDialog.vue'
import StatusDot from '@/components/StatusDot.vue'
import PageHeader from '@/components/PageHeader.vue'

const filterStatus = ref('')
const list = ref([])
const loading = ref(false)
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)
const exportDialogRef = ref(null)

const statusDotTone = { pending: 'warning', approved: 'success', rejected: 'error' }
const statusTextMap = { pending: '待审批', approved: '已批准', rejected: '已驳回' }

const formatDate = (v) => (v ? dayjs(Number(v)).format('YYYY-MM-DD HH:mm') : '-')

const error = ref('')

// 状态筛选此前没有 @change/ watch：点击「待审批/已批准」列表纹丝不动，
// 而导出却按 filterStatus 过滤 —— 屏幕与导出结果不一致，用户以为系统丢数据。
const onFilterChange = () => {
  currentPage.value = 1
  loadList()
}

// 每页条数变化后必须回到第 1 页：否则停留在旧页码可能越过新的总页数，出现空列表
const onSizeChange = () => {
  currentPage.value = 1
  loadList()
}

const loadList = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await getLeaves({
      status: filterStatus.value || undefined,
      page: currentPage.value,
      pageSize: pageSize.value
    })
    list.value = res.list || []
    total.value = res.total || 0
  } catch (e) {
    error.value = e?.message || '数据加载失败，请稍后重试'
    list.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

const doExport = async (range) => {
  let items = []
  try {
    items = await fetchAllPages(getLeaves, {
      status: filterStatus.value || undefined,
      startDate: range?.[0] || undefined,
      endDate: range?.[1] || undefined,
    })
  } catch (e) {
    ElMessage.warning('部分数据拉取失败，仅导出当前页')
    items = list.value
  }
  if (!items.length) {
    ElMessage.warning('暂无可导出的请假记录')
    return
  }
  const headers = ['成员', '活动', '请假时间', '请假原因', '家长电话', '申请时间', '状态']
  const rows = items.map((row) => [
    row.student_name || '',
    row.course_name || '',
    `${row.date || ''} ${row.start_time || ''}`.trim(),
    row.reason || '',
    row.parent_phone || '',
    formatDate(row.created_at),
    statusTextMap[row.status] || row.status
  ])
  exportXlsx(`请假记录_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '请假记录' })
  ElMessage.success(`已导出 ${rows.length} 条请假记录`)
}

const approveVisible = ref(false)
const current = ref(null)
const openApprove = (row) => {
  current.value = row
  approveVisible.value = true
}
const approveFromDialog = async () => {
  if (!current.value) return
  const ok = await handleApprove(current.value)
  if (ok) approveVisible.value = false // 确认并成功才关闭；取消/失败保留弹窗
}
const rejectFromDialog = async () => {
  if (!current.value) return
  const ok = await handleReject(current.value)
  if (ok) approveVisible.value = false
}

const handleApprove = async (row) => {
  try {
    await ElMessageBox.confirm(`批准「${row.student_name}」在 ${row.date} ${row.start_time} 的请假？`, '批准请假', {
      confirmButtonText: '批准',
      cancelButtonText: '取消',
      type: 'success'
    })
  } catch (e) {
    return false // 用户取消确认框，不执行任何操作
  }
  try {
    await approveLeave(row.id, { action: 'approve' })
    ElMessage.success('已批准，家长将收到通知')
    loadList()
    return true
  } catch (e) {
    return false // 请求失败：不翻转本地状态，刷新后保持一致
  }
}

const handleReject = async (row) => {
  let note = ''
  try {
    // 危险操作：确认框写清「对象 + 后果」，并把确认按钮染红，避免误点
    const { value } = await ElMessageBox.prompt(
      `确认驳回「${row.student_name}」在 ${row.date} ${row.start_time} 的请假申请？驳回后该次请假不生效，家长将收到驳回通知。`,
      '驳回请假',
      {
        confirmButtonText: '确认驳回',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
        inputPlaceholder: '驳回原因（选填）'
      }
    )
    note = value || ''
  } catch (e) {
    return false // 用户取消确认框，不执行任何操作
  }
  try {
    await approveLeave(row.id, { action: 'reject', note })
    ElMessage.success('已驳回')
    loadList()
    return true
  } catch (e) {
    return false // 请求失败：不翻转本地状态，刷新后保持一致
  }
}

onMounted(loadList)
</script>

<style lang="scss" scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--t-spacing-lg);
  flex-wrap: wrap;
  gap: var(--t-spacing-md);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: var(--t-spacing-md);
  flex-wrap: wrap;
}

.page-title {
  font-size: var(--t-fs-2xl);
  font-weight: 700;
  color: var(--t-text-1);
  margin: 0;
}

.student-name {
  font-weight: 600;
  color: var(--t-text-1);
}

.review-note {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

// 审批弹窗 footer 与全局 .dialog-footer 对齐（右对齐 + 统一间距）
:deep(.el-dialog__footer) {
  display: flex;
  justify-content: flex-end;
  gap: var(--t-spacing-sm);
}


</style>
