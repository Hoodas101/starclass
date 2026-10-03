<template>
  <div class="page-shell">
    <!-- 顶部标题 -->
<PageHeader v-if="!embedded" title="意见反馈" />
    <div class="toolbar">
      <div class="toolbar-left">
                <el-radio-group v-model="filterStatus" size="default" @change="onFilterChange">
          <el-radio-button value="">全部</el-radio-button>
          <el-radio-button value="pending">待处理</el-radio-button>
          <el-radio-button value="done">已处理</el-radio-button>
        </el-radio-group>
      </div>
      <div class="toolbar-right">
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出</el-button>
      </div>
    </div>

    <div class="card table-container">
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadList" />
      <el-table v-else :data="list" v-loading="loading" size="small" empty-text="暂无反馈" @row-click="openDetail" row-class-name="clickable-row">
        <el-table-column label="用户" min-width="120">
          <template #default="{ row }">
            <span class="user-name">{{ row.user_name || '用户' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="反馈内容" min-width="280" show-overflow-tooltip>
          <template #default="{ row }">{{ row.content }}</template>
        </el-table-column>
        <el-table-column label="联系方式" min-width="120">
          <template #default="{ row }">{{ row.contact || '-' }}</template>
        </el-table-column>
        <el-table-column label="提交时间" min-width="100">
          <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="状态" min-width="100">
          <template #default="{ row }">
            <StatusDot :tone="row.status === 'pending' ? 'warning' : 'success'" :label="row.status === 'pending' ? '待处理' : '已处理'" subtle />
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
    <!-- 反馈详情弹窗 -->
    <el-dialog v-model="detailVisible" title="反馈详情" class="dlg-lg">
      <div v-if="detail" class="feedback-detail">
        <div class="fd-row"><span class="fd-label">用户</span><span class="fd-value">{{ detail.user_name || '用户' }}</span></div>
        <div class="fd-row"><span class="fd-label">联系方式</span><span class="fd-value">{{ detail.contact || '-' }}</span></div>
        <div class="fd-row"><span class="fd-label">提交时间</span><span class="fd-value">{{ formatDate(detail.created_at) }}</span></div>
        <div class="fd-row"><span class="fd-label">状态</span><span class="fd-value"><StatusDot :tone="detail.status === 'pending' ? 'warning' : 'success'" :label="detail.status === 'pending' ? '待处理' : '已处理'" subtle /></span></div>
        <div class="fd-content">
          <div class="fd-label">反馈内容</div>
          <div class="fd-text">{{ detail.content }}</div>
        </div>
        <div v-if="detail.reply" class="fd-content fd-reply">
          <div class="fd-label">机构回复</div>
          <div class="fd-text fd-reply-text">{{ detail.reply }}</div>
          <div class="fd-reply-meta">{{ detail.replied_by || '管理员' }} · {{ formatDate(detail.reply_at) }}</div>
        </div>
        <div v-else class="fd-content">
          <div class="fd-label">机构回复</div>
          <el-input
            v-model="replyText"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="输入回复内容，家长端将展示该回复（留空则不回复）"
          />
        </div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="detailVisible = false">关闭</el-button>
          <el-button
            v-if="detail && !detail.reply"
            type="primary"
            :loading="replySubmitting"
            :disabled="!replyText.trim()"
            @click="submitReply"
          >回复并标记已处理</el-button>
          <el-button v-if="detail && detail.status === 'pending'" type="success" @click="toggleFromDetail('done')">标记已处理</el-button>
          <el-button v-else-if="detail" type="warning" plain @click="toggleFromDetail('pending')">重新打开</el-button>
        </div>
      </template>
    </el-dialog>
  </div>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出反馈数据"
      description="选择时间范围后确认导出，留空导出全部反馈。"
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
import { getFeedback, updateFeedbackStatus, replyFeedback } from '@/api/modules'
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

const formatDate = (v) => (v ? dayjs(Number(v)).format('YYYY-MM-DD HH:mm') : '-')

const error = ref('')

// 状态筛选此前没有 @change/ watch，点击「待处理/已处理」列表不刷新；
// 而导出按 filterStatus 过滤 —— 屏幕与导出口径不一致。此处补齐联动。
const onFilterChange = () => {
  currentPage.value = 1
  loadList()
}

// 每页条数变化后回到第 1 页，避免停留在越界页码导致空列表
const onSizeChange = () => {
  currentPage.value = 1
  loadList()
}

const loadList = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await getFeedback({
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
    items = await fetchAllPages(getFeedback, {
      status: filterStatus.value || undefined,
      startDate: range?.[0] || undefined,
      endDate: range?.[1] || undefined,
    })
  } catch (e) {
    ElMessage.warning('部分数据拉取失败，仅导出当前页')
    items = list.value
  }
  if (!items.length) {
    ElMessage.warning('暂无可导出的反馈记录')
    return
  }
  const headers = ['用户', '反馈内容', '联系方式', '提交时间', '状态']
  const rows = items.map((row) => [
    row.user_name || '用户',
    row.content || '',
    row.contact || '',
    formatDate(row.created_at),
    row.status === 'pending' ? '待处理' : '已处理'
  ])
  exportXlsx(`意见反馈_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '意见反馈' })
  ElMessage.success(`已导出 ${rows.length} 条反馈`)
}

const detailVisible = ref(false)
const detail = ref(null)
const replyText = ref('')
const replySubmitting = ref(false)
const openDetail = (row) => {
  detail.value = row
  replyText.value = ''
  detailVisible.value = true
}

const submitReply = async () => {
  if (!detail.value || !replyText.value.trim()) return
  replySubmitting.value = true
  try {
    await replyFeedback(detail.value.id, { reply: replyText.value.trim() })
    ElMessage.success('已回复，家长端可见')
    detailVisible.value = false
    loadList()
  } catch (e) {
    // 失败保留弹窗与已输入内容，可重试
  } finally {
    replySubmitting.value = false
  }
}

const toggleFromDetail = async (status) => {
  if (!detail.value) return
  const ok = await handleToggle(detail.value, status)
  if (ok) {
    detailVisible.value = false // 确认并成功才关闭；取消/失败保留弹窗
  }
}

const handleToggle = async (row, status) => {
  const label = status === 'done' ? '确认已处理该反馈？' : '确认重新打开该反馈？'
  try {
    await ElMessageBox.confirm(label, '提示', { type: 'warning' })
  } catch (e) {
    return false // 用户取消确认框，不执行任何操作
  }
  try {
    await updateFeedbackStatus(row.id, { status })
    ElMessage.success(status === 'done' ? '已标记处理' : '已重新打开')
    loadList()
    return true
  } catch (e) {
    return false // 请求失败：不翻转本地状态，刷新后保持一致
  }
}

onMounted(loadList)
</script>

<style lang="scss" scoped>
.user-name {
  font-weight: 600;
  color: var(--t-text-1);
}
.fd-reply-text {
  border-left: 3px solid var(--t-accent, #0071e3);
  padding-left: 10px;
  white-space: pre-wrap;
}
.fd-reply-meta {
  margin-top: 4px;
  font-size: var(--t-fs-xs, 12px);
  color: var(--t-text-3, #909399);
}
</style>
