<template>
  <div class="page-shell">
    <!-- 顶部标题 -->
    <PageHeader v-if="!embedded" title="通知中心" />
    <!-- 顶部操作栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-count">共 {{ total }} 条通知</span>
      </div>
      <div class="toolbar-right">
        <el-input
          v-model="keyword"
          placeholder="搜索通知标题"
          :prefix-icon="Search"
          clearable
          style="width: 220px"
          @change="onFilterChange"
          @clear="onFilterChange"
        />
        <el-select v-model="priority" placeholder="全部优先级" clearable style="width: 130px" @change="onFilterChange">
          <el-option label="紧急" value="urgent" />
          <el-option label="重要" value="important" />
          <el-option label="提醒" value="normal" />
        </el-select>
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出</el-button>
        <el-button type="primary" :icon="Plus" @click="openPublish">发布通知</el-button>
      </div>
    </div>

    <!-- 通知历史 -->
    <div class="card table-container">
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadList" />
      <el-table v-else :data="list" v-loading="loading" size="small" @row-click="viewDetail" row-class-name="clickable-row">
        <el-table-column label="标题" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="notice-title-cell">
              <span class="notice-priority" :class="'p-' + (row.priority || 'normal')"></span>
              <span>{{ row.title }}</span>
              <span v-if="row.isBroadcast" class="notice-broadcast">广播</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="摘要" min-width="200" prop="summary" show-overflow-tooltip />
        <el-table-column label="优先级" min-width="90">
          <template #default="{ row }">
            <StatusDot :tone="priorityDotTone(row.priority)" :label="row.priorityText" subtle />
          </template>
        </el-table-column>
        <el-table-column label="送达 / 已读" min-width="110">
          <template #default="{ row }">
            <span class="read-stat">{{ row.readCount }} / {{ row.deliveredCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="发布时间" min-width="140">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="page"
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

    <!-- 发布通知弹窗 -->
    <el-dialog v-model="dialogOpen" title="发布通知" class="dlg-lg">
      <el-form ref="publishFormRef" :model="form" :rules="publishRules" label-position="top">
        <el-form-item label="通知标题" prop="title">
          <el-input v-model="form.title" placeholder="输入通知标题" maxlength="50" show-word-limit />
        </el-form-item>
        <el-form-item label="通知内容" prop="content">
          <el-input v-model="form.content" type="textarea" :rows="4" placeholder="输入通知详情内容" maxlength="500" show-word-limit />
        </el-form-item>
        <el-form-item label="优先级">
          <el-radio-group v-model="form.priority">
            <el-radio-button value="urgent">紧急</el-radio-button>
            <el-radio-button value="important">重要</el-radio-button>
            <el-radio-button value="normal">提醒</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="发送范围">
          <el-select v-model="form.groupName" clearable placeholder="全部家长（不分组）" style="width: 100%">
            <el-option v-for="g in groups" :key="g" :label="g" :value="g" />
          </el-select>
        </el-form-item>
      </el-form>
      <template v-if="showPreview">
        <el-divider content-position="left">家长端预览</el-divider>
        <div class="notice-preview">
          <div class="np-head">
            <span class="np-title">{{ form.title || '通知标题' }}</span>
            <span class="np-tag" :class="'np-' + (form.priority || 'normal')">
              {{ { urgent: '紧急', important: '重要', normal: '提醒' }[form.priority || 'normal'] }}
            </span>
          </div>
          <div class="np-meta">
            {{ form.groupName ? '仅限 ' + form.groupName : '全部家长' }} · 发送后即时可见
          </div>
          <div class="np-body">
            <template v-for="(b, i) in previewBlocks" :key="i">
              <div v-if="b.type === 'title'" class="np-block-title">{{ b.text }}</div>
              <div v-else-if="b.type === 'list'" class="np-block-list">
                <span class="np-dot"></span>
                <span>{{ b.text }}</span>
              </div>
              <p v-else class="np-block-para">{{ b.text }}</p>
            </template>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogOpen = false">取消</el-button>
          <el-button @click="showPreview = !showPreview">{{ showPreview ? '收起预览' : '预览' }}</el-button>
          <el-button type="primary" :loading="publishing" @click="publish">发布</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 通知详情弹窗 -->
    <el-dialog v-model="detailOpen" title="通知详情" class="dlg-lg">
      <div v-if="detail" class="notice-detail">
        <div class="notice-detail-title">{{ detail.title }}</div>
        <div class="notice-detail-meta">
          <StatusDot :tone="priorityDotTone(detail.priority)" :label="detail.priorityText" subtle />
          <span class="notice-detail-time">{{ formatTime(detail.createdAt) }}</span>
        </div>
        <div class="notice-detail-content">{{ detail.content || detail.detail || detail.summary }}</div>
        <div class="notice-detail-stat">已读 {{ detail.readCount }} / 送达 {{ detail.deliveredCount }}</div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button type="danger" plain @click="deleteFromDetail">删除通知</el-button>
          <el-button type="primary" @click="detailOpen = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>
  </div>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出通知记录"
      description="选择时间范围后确认导出，留空导出全部通知。"
      @confirm="doExport"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, computed, onMounted, nextTick } from 'vue'
import { Search, Plus, Download } from '@element-plus/icons-vue'
import { getNoticeAdminList, publishNotice, deleteNotice, getCourses } from '@/api/modules'
import dayjs from 'dayjs'
import { exportXlsx } from '@/utils/xlsx'
import { fetchAllPages } from '@/utils/fetchAll'
import ExportDialog from '@/components/ExportDialog.vue'
import StatusDot from '@/components/StatusDot.vue'
import PageHeader from '@/components/PageHeader.vue'

const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const keyword = ref('')
const priority = ref('')
const exportDialogRef = ref(null)

const dialogOpen = ref(false)
const publishing = ref(false)
const form = ref({ title: '', content: '', priority: 'normal', groupName: '' })
const showPreview = ref(false)
const publishFormRef = ref(null)

// 表单校验：把「必填」落到具体字段（此前用裸 required，只在提交时弹一条笼统 toast，
// 标题填了内容没填时用户只能逐个试）。trim 后为空同样视为未填，避免全空格标题发布出去。
const trimRequired = (message) => ({
  validator: (_rule, value, callback) => {
    if (String(value ?? '').trim()) callback()
    else callback(new Error(message))
  },
  trigger: 'blur',
})
const publishRules = {
  title: [trimRequired('请输入通知标题')],
  content: [trimRequired('请输入通知内容')],
}

// 正文排版预览：空行分段、`# ` 小标题、`- `/`• ` 要点（与小程序发布预览同规则）
const previewBlocks = computed(() => {
  const lines = String(form.value.content || '').split('\n')
  const blocks = []
  let para = ''
  const flush = () => {
    if (para.trim()) {
      blocks.push({ type: 'para', text: para.trim() })
      para = ''
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { flush(); continue }
    if (line.startsWith('# ')) {
      flush()
      blocks.push({ type: 'title', text: line.slice(2).trim() })
    } else if (/^[-•]\s/.test(line)) {
      flush()
      blocks.push({ type: 'list', text: line.replace(/^[-•]\s/, '') })
    } else {
      para += (para ? '\n' : '') + line
    }
  }
  flush()
  return blocks
})

const openPublish = () => {
  showPreview.value = false
  // 重置草稿：此前取消弹窗后残留上一次内容，下次打开会误发旧草稿
  form.value = { title: '', content: '', priority: 'normal', groupName: '' }
  dialogOpen.value = true
  // 弹窗未 destroy-on-close，表单常驻：清空上一次遗留的校验红字
  nextTick(() => publishFormRef.value?.clearValidate())
}

const detailOpen = ref(false)
const detail = ref(null)

// 分组下拉动态加载在售班级（与小程序发布通知一致，避免选组后家长端收不到）
const groups = ref([])
const loadGroups = async () => {
  try {
    const res = await getCourses()
    groups.value = (res?.list || [])
      .filter((c) => c.is_active !== 0)
      .map((c) => c.name)
      .filter(Boolean)
  } catch (e) {
    groups.value = []
  }
}

const error = ref('')

// 筛选/分页条件变化时回到第 1 页：否则在第 3 页改关键词可能落在新的空页上
const onFilterChange = () => {
  page.value = 1
  loadList()
}
const onSizeChange = () => {
  page.value = 1
  loadList()
}

const loadList = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await getNoticeAdminList({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value || undefined,
      priority: priority.value || undefined,
    })
    list.value = res?.list || []
    total.value = res?.total || 0
  } catch (e) {
    error.value = e?.message || '数据加载失败，请稍后重试'
    list.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadList()
  loadGroups()
})

const doExport = async (range) => {
  try {
    const items = await fetchAllPages(getNoticeAdminList, {
      keyword: keyword.value || undefined,
      priority: priority.value || undefined,
      startDate: range?.[0] || undefined,
      endDate: range?.[1] || undefined
    })
    if (!items.length) {
      ElMessage.warning('暂无可导出的通知')
      return
    }
    const headers = ['标题', '摘要', '内容', '优先级', '送达/已读', '发布时间']
    const rows = items.map((row) => [
      row.title || '',
      row.summary || '',
      row.content || '',
      row.priorityText || row.priority || '',
      `${row.readCount || 0} / ${row.deliveredCount || 0}`,
      formatTime(row.createdAt)
    ])
    exportXlsx(`通知记录_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '通知记录' })
    ElMessage.success(`已导出 ${rows.length} 条通知`)
  } catch (e) {
    // 拦截器已提示
  }
}

const publish = async () => {
  if (!publishFormRef.value) return
  const valid = await publishFormRef.value.validate().catch(() => false)
  if (!valid) return
  publishing.value = true
  try {
    await publishNotice({
      title: form.value.title.trim(),
      content: form.value.content.trim(),
      priority: form.value.priority,
      category: 'system',
      groupName: form.value.groupName,
    })
    ElMessage.success('通知已发布，家长端即刻可见')
    dialogOpen.value = false
    showPreview.value = false
    form.value = { title: '', content: '', priority: 'normal', groupName: '' }
    loadList()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    publishing.value = false
  }
}

const viewDetail = (row) => {
  detail.value = row
  detailOpen.value = true
}

const deleteFromDetail = async () => {
  if (!detail.value) return
  const ok = await handleDelete(detail.value)
  if (ok) detailOpen.value = false // 确认并成功才关闭；取消/失败保留详情弹窗
}

const handleDelete = async (row) => {
  try {
    await ElMessageBox.confirm(`确定删除通知「${row.title}」吗？删除后家长端将不可见。`, '删除通知', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger'
    })
  } catch (e) {
    return false // 用户取消确认框
  }
  try {
    await deleteNotice(row.id)
    ElMessage.success('已删除')
    loadList()
    return true
  } catch (e) {
    return false // 请求失败：刷新后保持一致
  }
}

const priorityDotTone = (p) => ({ urgent: 'error', important: 'warning', normal: 'neutral' }[p] || 'neutral')

const formatTime = (ts) => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

</script>

<style lang="scss" scoped>
.notice-title-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.notice-priority {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;

  &.p-urgent { background: var(--t-danger); }
  &.p-important { background: var(--t-warning); }
  &.p-normal { background: var(--t-accent); }
}

.read-stat {
  font-variant-numeric: tabular-nums;
  color: var(--t-text-2);
}

.notice-detail-title {
  font-size: var(--t-fs-xl);
  font-weight: 700;
  color: var(--t-text-1);
  margin-bottom: 12px;
}

.notice-detail-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.notice-detail-time {
  font-size: var(--t-fs-sm);
  color: var(--t-text-3);
}

.notice-detail-content {
  font-size: var(--t-fs-lg);
  line-height: 1.8;
  color: var(--t-text-1);
  white-space: pre-wrap;
  word-break: break-word;
  padding: 16px;
  border-radius: var(--t-radius-lg);
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  margin-bottom: 16px;
}

.notice-detail-stat {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
}

/* 发布预览（家长端效果） */
.notice-preview {
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-lg);
  background: var(--t-surface);
  padding: 16px;
  margin-bottom: 8px;
}

.np-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.np-title {
  font-size: var(--t-fs-xl);
  font-weight: 700;
  color: var(--t-text-1);
}

.np-tag {
  font-size: var(--t-fs-xs);
  padding: 2px 10px;
  border-radius: var(--t-radius-full);
  flex-shrink: 0;
}

.np-urgent { background: color-mix(in srgb, var(--t-danger) 12%, transparent); color: var(--t-danger-text); }
.np-important { background: color-mix(in srgb, var(--t-warning) 14%, transparent); color: var(--t-warning-text); }
.np-normal { background: color-mix(in srgb, var(--t-text-2) 16%, transparent); color: var(--t-text-2); }

.np-meta {
  font-size: var(--t-fs-sm);
  color: var(--t-text-3);
  margin-bottom: 12px;
}

.np-body {
  font-size: var(--t-fs-lg);
  line-height: 1.7;
  color: var(--t-text-1);
  background: var(--t-bg);
  border-radius: var(--t-radius-md);
  padding: 12px 14px;
}

.np-block-title {
  font-size: var(--t-fs-lg);
  font-weight: 700;
  margin: 4px 0 8px;
}

.np-block-para {
  margin: 0 0 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

.np-block-list {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 6px;
}

.np-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--t-accent);
  margin-top: 8px;
  flex-shrink: 0;
}
</style>
