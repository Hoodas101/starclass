<template>
  <div class="page-shell">
    <!-- 顶部标题 -->
    <PageHeader v-if="!embedded" title="家长沟通" />
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-count">共 {{ total }} 名{{ $t('learner') }}</span>
      </div>
      <div class="toolbar-right">
        <el-input
          v-model="keyword"
          placeholder="搜索家长姓名 / 手机号"
          :prefix-icon="Search"
          clearable
          style="width: 240px"
        />
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出</el-button>
        <el-button :icon="Bell" @click="openSuppressionDialog">勿扰名单</el-button>
      </div>
    </div>

    <div class="card table-container">
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadParents" />
      <el-table v-else
        :data="filteredList"
        v-loading="loading"
        empty-text="暂无家长数据"
        @row-click="openParentDetail"
        row-class-name="clickable-row"
        size="small">
        <el-table-column label="#" min-width="56">
          <template #default="{ $index }">{{ $index + 1 }}</template>
        </el-table-column>
        <el-table-column :label="t('learner') + '姓名'" min-width="130" sortable>
          <template #default="{ row }">
            <span class="member-name">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="电话" min-width="120" prop="phone" />
        <el-table-column label="家长1" min-width="140">
          <template #default="{ row }">
            <div v-if="row.parents[0]" class="pa-col">
              <span class="pl-name">{{ row.parents[0].parent_name }}</span>
              <span v-if="row.parents[0].relation" class="pl-rel">{{ row.parents[0].relation }}</span>
              <span class="pl-phone">{{ row.parents[0].parent_phone }}</span>
            </div>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="家长2" min-width="140">
          <template #default="{ row }">
            <div v-if="row.parents[1]" class="pa-col">
              <span class="pl-name">{{ row.parents[1].parent_name }}</span>
              <span v-if="row.parents[1].relation" class="pl-rel">{{ row.parents[1].relation }}</span>
              <span class="pl-phone">{{ row.parents[1].parent_phone }}</span>
            </div>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="90" align="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click.stop="openSendForRow(row)">发通知</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 家长详情抽屉 -->
    <el-drawer v-model="detailVisible" :title="selectedParent?.name || t('learner') + '详情'" direction="rtl" size="var(--t-drawer-md)">
      <div v-if="selectedParent" class="parent-detail">
        <div class="detail-head">
          <span class="detail-name">{{ selectedParent.name }}</span>
        </div>

        <el-divider />
        <h4 class="detail-subtitle">绑定家长（{{ selectedParent.parents.length }}）</h4>
        <div v-if="selectedParent.parents.length" class="member-list">
          <div v-for="pa in selectedParent.parents" :key="pa.parent_phone" class="member-item">
            <div class="pa-info">
              <span class="member-name">{{ pa.parent_name }}</span>
              <span v-if="pa.relation" class="pa-rel">{{ pa.relation }}</span>
              <span class="pa-phone">{{ pa.parent_phone }}</span>
            </div>
            <div class="pa-ops">
              <el-button text type="primary" size="small" @click="openSendDialog(pa)">发通知</el-button>
              <el-button text size="small" @click="openAddSuppression(pa)">勿扰</el-button>
            </div>
          </div>
        </div>
        <div v-else class="empty-hint">未绑定家长</div>
      </div>
    </el-drawer>

    <!-- 选择通知家长弹窗 -->
    <el-dialog v-model="pickVisible" title="选择通知家长" class="dlg-sm">
      <div class="pick-list">
        <div
          v-for="pa in sendPickRow?.parents || []"
          :key="pa.parent_phone"
          class="pick-item"
          @click="pickSend(pa)"
        >
          <span class="pl-name">{{ pa.parent_name }}</span>
          <span v-if="pa.relation" class="pl-rel">{{ pa.relation }}</span>
          <span class="pl-phone">{{ pa.parent_phone }}</span>
        </div>
      </div>
    </el-dialog>

    <!-- 添加勿扰弹窗 -->
    <el-dialog v-model="addSupVisible" title="标记勿扰" class="dlg-sm">
      <el-form label-position="top">
        <el-form-item label="手机号">
          <el-input :model-value="supTarget?.parent_phone" disabled />
        </el-form-item>
        <el-form-item label="家长姓名">
          <el-input :model-value="supTarget?.parent_name" disabled />
        </el-form-item>
        <el-form-item label="原因">
          <el-input v-model="supReason" type="textarea" :rows="2" placeholder="如：已退费且不再接收营销信息 / 家长要求不打扰" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="addSupVisible = false">取消</el-button>
          <el-button type="danger" @click="submitAddSuppression">确认勿扰</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 勿扰名单管理弹窗 -->
    <el-dialog v-model="supListVisible" title="勿扰名单" class="dlg-lg">
      <div v-if="supList.length" class="sup-list">
        <div v-for="s in supList" :key="s.id" class="sup-item">
          <div class="sup-info">
            <span class="sup-name">{{ s.name || '未知家长' }}</span>
            <span class="sup-phone">{{ s.phone }}</span>
            <span v-if="s.reason" class="sup-reason">{{ s.reason }}</span>
          </div>
          <el-button text type="danger" size="small" @click="removeSuppression(s)">移除</el-button>
        </div>
      </div>
      <div v-else class="empty-hint">暂无勿扰名单</div>
      <div class="sup-tip">被标记勿扰的家长将不再接收营销类通知，课程与系统通知不受影响。</div>
    </el-dialog>

    <!-- 发送通知弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="`发送通知给 ${sendTarget?.parent_name || ''}`"
      destroy-on-close
      class="dlg-lg"
    >
      <el-form :model="sendForm" label-width="auto" label-position="left">
        <el-form-item label="标题" required>
          <el-input v-model="sendForm.title" placeholder="通知标题" maxlength="40" />
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input v-model="sendForm.content" type="textarea" :rows="5" placeholder="通知内容" maxlength="500" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="sending" @click="submitSend">发送</el-button>
        </div>
      </template>
    </el-dialog>
  </div>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      :title="`导出${t('learner')}数据`"
      :description="`选择时间范围后确认导出；留空导出全部${t('learner')}。`"
      @confirm="doExport"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, computed, onMounted } from 'vue'
import { Search, Download, Bell } from '@element-plus/icons-vue'
import { getParents, sendMessage, getSuppressions, addSuppression, deleteSuppression } from '@/api/modules'
import dayjs from 'dayjs'
import { exportXlsx } from '@/utils/xlsx'
import PageHeader from '@/components/PageHeader.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import { useSettingsStore } from '@/store/settings'

const settingsStore = useSettingsStore()
const t = settingsStore.t

const list = ref([])
const total = ref(0)
const loading = ref(false)
const keyword = ref('')

const dialogVisible = ref(false)
const sending = ref(false)
const sendTarget = ref(null)
const exportDialogRef = ref(null)
const sendForm = ref({ title: '', content: '' })

// 勿扰名单（借鉴 trycompai/crm 的 SuppressedContact）
const addSupVisible = ref(false)
const supTarget = ref(null)
const supReason = ref('')
const supListVisible = ref(false)
const supList = ref([])

const openAddSuppression = (row) => {
  supTarget.value = row
  supReason.value = ''
  addSupVisible.value = true
}

const submitAddSuppression = async () => {
  try {
    await addSuppression({
      phone: supTarget.value?.parent_phone,
      name: supTarget.value?.parent_name || '',
      type: 'marketing',
      reason: supReason.value || '家长要求不打扰',
    })
    ElMessage.success('已标记勿扰，该家长不再接收营销类通知')
    addSupVisible.value = false
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

const openSuppressionDialog = async () => {
  supListVisible.value = true
  try {
    const res = await getSuppressions()
    supList.value = res?.list || []
  } catch (e) {
    supList.value = []
  }
}

const removeSuppression = async (s) => {
  try {
    await deleteSuppression(s.id)
    ElMessage.success('已移除勿扰')
    supList.value = supList.value.filter((x) => x.id !== s.id)
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

const error = ref('')

const loadParents = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await getParents()
    // 按会员聚合：一个会员可绑定多位家长，家长信息并排展示
    const raw = res.list || []
    const map = new Map()
    for (const p of raw) {
      for (const s of p.students || []) {
        if (!map.has(s.id)) map.set(s.id, { id: s.id, name: s.name, parents: [] })
        const entry = map.get(s.id)
        const dup = entry.parents.some((x) => x.parent_phone === p.parent_phone)
        if (!dup) {
          entry.parents.push({
            parent_name: p.parent_name,
            parent_phone: p.parent_phone,
            parent_openid: p.parent_openid,
            relation: p.relation || '',
          })
        }
      }
    }
    list.value = [...map.values()]
    total.value = list.value.length
  } catch (e) {
    error.value = e?.message || '数据加载失败，请稍后重试'
    list.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

const filteredList = computed(() => {
  if (!keyword.value) return list.value
  const kw = keyword.value.toLowerCase()
  return list.value.filter(
    (m) =>
      (m.name || '').toLowerCase().includes(kw) ||
      (m.parents || []).some(
        (pa) =>
          (pa.parent_name || '').toLowerCase().includes(kw) ||
          (pa.parent_phone || '').includes(kw)
      )
  )
})

const doExport = (range) => {
  if (range && range.length === 2) {
    ElMessage.warning('家长通讯录为当前全员快照，不支持按时间筛选，已导出全部')
  }
  const items = filteredList.value
  if (!items.length) {
    ElMessage.warning(`暂无可导出的${t('learner')}数据`)
    return
  }
  const headers = ['序号', t('learner') + '姓名', '家长1姓名', '家长1关系', '家长1电话', '家长2姓名', '家长2关系', '家长2电话']
  const rows = items.map((m, i) => {
    const p1 = m.parents[0] || {}
    const p2 = m.parents[1] || {}
    return [
      i + 1,
      m.name || '',
      p1.parent_name || '',
      p1.relation || '',
      p1.parent_phone || '',
      p2.parent_name || '',
      p2.relation || '',
      p2.parent_phone || ''
    ]
  })
  exportXlsx(`家长通讯录_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '家长通讯录' })
  ElMessage.success(`已导出 ${rows.length} 位${t('learner')}`)
}

// 发送通知：一位家长直接发送，多位家长先选择
const pickVisible = ref(false)
const sendPickRow = ref(null)

const openSendForRow = (row) => {
  if (!row.parents.length) {
    ElMessage.warning(`该${t('learner')}未绑定${t('guardian')}，无法发送通知`)
    return
  }
  if (row.parents.length === 1) {
    openSendDialog(row.parents[0])
    return
  }
  sendPickRow.value = row
  pickVisible.value = true
}

const pickSend = (pa) => {
  pickVisible.value = false
  openSendDialog(pa)
}

const openSendDialog = (row) => {
  if (!row.parent_openid) {
    ElMessage.warning(`该家长未绑定小程序，暂无法发送通知`)
    return
  }
  sendTarget.value = row
  sendForm.value = { title: '', content: '' }
  dialogVisible.value = true
}

// 家长详情（点击行进入）
const detailVisible = ref(false)
const selectedParent = ref(null)

const openParentDetail = (row) => {
  selectedParent.value = row
  detailVisible.value = true
}

const submitSend = async () => {
  if (!sendForm.value.title.trim() || !sendForm.value.content.trim()) {
    ElMessage.warning('请填写标题与内容')
    return
  }
  sending.value = true
  try {
    await sendMessage({
      userId: sendTarget.value.parent_openid,
      title: sendForm.value.title.trim(),
      content: sendForm.value.content.trim(),
    })
    ElMessage.success('已发送，家长在小程序通知中心可查看')
    dialogVisible.value = false
  } catch (e) {
    // 拦截器已提示
  } finally {
    sending.value = false
  }
}

onMounted(loadParents)
</script>

<style lang="scss" scoped>
.member-name {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
}

.parent-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pa-col {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  justify-content: flex-start;
  min-width: 0;
}

.parent-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.pl-index {
  width: 18px;
  height: 18px;
  border-radius: var(--t-radius-full);
  background: var(--t-accent-bg);
  color: var(--t-accent-strong);
  font-size: var(--t-fs-2xs);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.pl-name {
  font-size: var(--t-fs-sm);
  font-weight: 500;
  color: var(--t-text-1);
  white-space: nowrap;
}

.pl-rel {
  font-size: var(--t-fs-2xs);
  color: var(--t-accent-text);
  background: var(--t-accent-bg);
  border-radius: var(--t-radius-sm);
  padding: 1px 6px;
  white-space: nowrap;
}

.pl-phone {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.text-muted {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.pick-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pick-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
  cursor: pointer;
  transition: border-color 0.16s ease-out, background-color 0.16s ease-out;

  &:hover {
    border-color: var(--t-accent-line);
    background: var(--t-surface-hover);
  }
}

.pa-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.pa-rel {
  font-size: var(--t-fs-2xs);
  color: var(--t-accent-text);
  background: var(--t-accent-bg);
  border-radius: var(--t-radius-sm);
  padding: 1px 6px;
}

.pa-phone {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;
}

.pa-ops {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
}

// 勿扰名单
.sup-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 420px;
  overflow-y: auto;
}

.sup-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
}

.sup-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.sup-name {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
}

.sup-phone {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;
}

.sup-reason {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.sup-tip {
  margin-top: 12px;
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  line-height: 1.6;
}


.parent-detail {
  .detail-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .detail-name {
    font-size: var(--t-fs-2xl);
    font-weight: 700;
    color: var(--t-text-1);
  }

  .detail-phone {
    font-size: var(--t-fs-sm);
    color: var(--t-text-2);
    margin-top: 6px;
    font-variant-numeric: tabular-nums;
  }

  .detail-subtitle {
    font-size: var(--t-fs-base);
    font-weight: 600;
    color: var(--t-text-1);
    margin: 0 0 10px;
  }

  .member-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .member-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    background: var(--t-surface-hover);
    border: 1px solid var(--t-line);
    border-radius: var(--t-radius-md);
  }

  .member-name {
    font-size: var(--t-fs-base);
    font-weight: 600;
    color: var(--t-text-1);
  }

  .member-state {
    font-size: var(--t-fs-xs);
    color: var(--t-accent-text);
  }

  .detail-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .detail-actions .el-button {
    margin-left: 0;
  }

  .empty-hint {
    font-size: var(--t-fs-sm);
    color: var(--t-text-3);
  }
}
</style>
