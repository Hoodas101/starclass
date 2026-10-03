<template>
  <div class="page-shell">
    <!-- 单一工具栏：模式切换用二级下拉，避免双 tab 栏 + 双横线 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <el-select v-model="activeMode" style="width: 140px">
          <el-option label="补课安排" value="assign" />
          <el-option label="补课记录" value="records" />
          <el-option label="调课" value="reschedule" />
        </el-select>

        <template v-if="activeMode === 'assign'">
          <el-input v-model="searchKey" :placeholder="`搜索${$t('learner')}姓名`" style="width: 200px" clearable @clear="loadEligible" @keyup.enter="loadEligible" />
          <el-date-picker v-model="dateRange" type="daterange" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" value-format="YYYY-MM-DD" style="width: 260px" @change="loadEligible" />
        </template>

        <template v-if="activeMode === 'records'">
          <el-select v-model="recordFilter.status" placeholder="状态" clearable style="width: 120px" @change="loadRecords">
            <el-option label="待补课" value="pending" />
            <el-option label="已完成" value="completed" />
            <el-option label="已取消" value="cancelled" />
          </el-select>
        </template>

        <template v-if="activeMode === 'reschedule'">
          <el-select
            v-model="rescheduleForm.originalScheduleId"
            filterable
            clearable
            placeholder="选择原排期"
            remote
            :remote-method="loadRescheduleOptions"
            style="width: 340px"
            @change="loadOriginalStudents"
          >
            <el-option
              v-for="s in rescheduleScheduleOptions"
              :key="s.id"
              :label="s.label"
              :value="s.id"
            />
          </el-select>
        </template>
      </div>
      <div class="toolbar-right">
        <el-button @click="refreshActive">刷新</el-button>
      </div>
    </div>

    <!-- 补课安排 -->
    <div v-if="activeMode === 'assign'" class="card table-container">
      <ListErrorState v-if="!loading1 && error1" :error="error1" @retry="loadEligible" />
      <el-table v-else :data="filteredEligible" v-loading="loading1" size="small" @row-click="openAssign" row-class-name="clickable-row">
        <el-table-column :label="$t('learner')" prop="student_name" min-width="100" />
        <el-table-column :label="`原${$t('course')}`" prop="course_name" min-width="120" />
        <el-table-column label="原日期" prop="date" min-width="110" />
        <el-table-column label="时间" min-width="100">
          <template #default="{ row }">{{ row.start_time }} - {{ row.end_time }}</template>
        </el-table-column>
        <el-table-column label="状态" prop="status" min-width="80">
          <template #default="{ row }">
            <el-tag :type="row.status === 'absent' ? 'danger' : 'warning'" size="small">
              {{ row.status === 'absent' ? '缺席' : '请假' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="补课状态" min-width="100">
          <template #default="{ row }">
            <el-tag v-if="row.hasMakeup" :type="row.makeupStatus === 'completed' ? 'success' : 'info'" size="small">
              {{ row.makeupStatus === 'completed' ? '已补课' : '待补课' }}
            </el-tag>
            <span v-else class="text-muted">未安排</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 补课记录 -->
    <div v-if="activeMode === 'records'" class="card table-container">
      <ListErrorState v-if="!loading2 && error2" :error="error2" @retry="loadRecords" />
      <el-table v-else :data="recordList" v-loading="loading2" size="small" @row-click="openRecordDetail" row-class-name="clickable-row">
        <el-table-column :label="$t('learner')" prop="student_name" min-width="100" />
        <el-table-column label="类型" min-width="80">
          <template #default="{ row }">
            <el-tag :type="row.type === 'reschedule' ? 'warning' : 'primary'" size="small">
              {{ row.type === 'reschedule' ? '调课' : '补课' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="原课程" prop="original_course_name" min-width="100" />
        <el-table-column label="原日期" prop="original_date" min-width="100" />
        <el-table-column :label="`补课${$t('course')}`" prop="makeup_course_name" min-width="100" />
        <el-table-column label="补课日期" prop="makeup_date" min-width="100" />
        <el-table-column label="状态" min-width="80">
          <template #default="{ row }">
            <el-tag :type="row.status === 'completed' ? 'success' : row.status === 'cancelled' ? 'info' : 'warning'" size="small">
              {{ { pending: '待补课', completed: '已完成', cancelled: '已取消' }[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 调课 -->
    <div v-if="activeMode === 'reschedule'" class="card table-container">
      <ListErrorState v-if="!loading3 && error3" :error="error3" @retry="loadOriginalStudents" />
      <el-table v-else :data="rescheduleStudents" v-loading="loading3" size="small">
        <el-table-column :label="$t('learner')" prop="student_name" min-width="120" />
        <el-table-column label="状态" min-width="100">
          <template #default>
            <el-tag size="small" type="info">待签到</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" plain @click="openReschedule(row)">调课</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading3 && !rescheduleStudents.length && !error3" class="reschedule-empty">
        该排期暂无可调课成员（仅支持未签到的在册成员）
      </div>
    </div>

    <!-- 补课记录详情对话框 -->
    <el-dialog v-model="recordDetailVisible" title="补课记录详情" class="dlg-md">
      <div v-if="recordDetail" class="record-detail">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item :label="$t('learner')">{{ recordDetail.student_name }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ recordDetail.type === 'reschedule' ? '调课' : '补课' }}</el-descriptions-item>
          <el-descriptions-item :label="`原${$t('course')}`">{{ recordDetail.original_course_name }} ({{ recordDetail.original_date }})</el-descriptions-item>
          <el-descriptions-item :label="`补课${$t('course')}`">{{ recordDetail.makeup_course_name || '-' }} ({{ recordDetail.makeup_date || '-' }})</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="recordDetail.status === 'completed' ? 'success' : recordDetail.status === 'cancelled' ? 'info' : 'warning'" size="small">
              {{ { pending: '待补课', completed: '已完成', cancelled: '已取消' }[recordDetail.status] }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </div>
      <template #footer>
        <el-button @click="recordDetailVisible = false">关闭</el-button>
        <el-button v-if="recordDetail && recordDetail.status === 'pending'" type="danger" plain @click="cancelFromDetail">取消补课</el-button>
      </template>
    </el-dialog>

    <!-- 安排补课对话框 -->
    <el-dialog v-model="assignVisible" title="安排补课" class="dlg-lg">
      <el-descriptions :column="1" border size="small" style="margin-bottom: 16px">
        <el-descriptions-item :label="$t('learner')">{{ currentRow?.student_name }}</el-descriptions-item>
        <el-descriptions-item :label="`原${$t('course')}`">{{ currentRow?.course_name }} ({{ currentRow?.date }} {{ currentRow?.start_time }}-{{ currentRow?.end_time }})</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="auto">
        <el-form-item label="补课排期">
          <el-select v-model="assignForm.makeupScheduleId" filterable placeholder="选择补课排期" style="width: 100%">
            <el-option v-for="s in scheduleOptions" :key="s.id" :label="`${s.course_name} | ${s.date} ${s.start_time}-${s.end_time} (${s.enrolled_count}/${s.max_students || '-'})`" :value="s.id" :disabled="s.enrolled_count >= (s.max_students || 999)" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="assignForm.note" type="textarea" :rows="2" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleAssign">确认安排</el-button>
      </template>
    </el-dialog>

    <!-- 调课对话框 -->
    <el-dialog v-model="rescheduleVisible" title="调课" class="dlg-lg">
      <el-descriptions :column="1" border size="small" style="margin-bottom: 16px">
        <el-descriptions-item :label="$t('learner')">{{ rescheduleRow?.student_name }}</el-descriptions-item>
        <el-descriptions-item label="原排期">{{ originalScheduleLabel || '-' }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="auto">
        <el-form-item label="目标排期">
          <el-select v-model="rescheduleForm.newScheduleId" filterable remote :remote-method="loadRescheduleOptions" placeholder="选择目标排期" style="width: 100%">
            <el-option
              v-for="s in rescheduleScheduleOptions"
              :key="s.id"
              :label="`${s.course_name} | ${s.date} ${s.start_time}-${s.end_time} (${s.enrolled_count}/${s.max_students || '-'})`"
              :value="s.id"
              :disabled="s.id === rescheduleForm.originalScheduleId || s.enrolled_count >= (s.max_students || 999)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="rescheduleForm.note" type="textarea" :rows="2" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rescheduleVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleReschedule">确认调课</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { getMakeupEligible, assignMakeup, cancelMakeup, getMakeupRecords, getSchedules, getScheduleDetail, getScheduleOptions, rescheduleStudent } from '@/api/modules'

defineProps({ embedded: Boolean })

const activeMode = ref('assign')
const loading1 = ref(false)
const loading2 = ref(false)
const loading3 = ref(false)
const submitting = ref(false)
const searchKey = ref('')
const dateRange = ref(null)
const eligibleList = ref([])
const recordList = ref([])
const recordFilter = reactive({ status: '' })
const assignVisible = ref(false)
const currentRow = ref(null)
const scheduleOptions = ref([])
const assignForm = reactive({ makeupScheduleId: '', note: '' })

// 调课（reschedule）
const error3 = ref('')
const rescheduleScheduleOptions = ref([])
const rescheduleStudents = ref([])
const rescheduleVisible = ref(false)
const rescheduleRow = ref(null)
const rescheduleForm = reactive({ originalScheduleId: '', newScheduleId: '', note: '' })

const originalScheduleLabel = computed(() => {
  const s = rescheduleScheduleOptions.value.find((x) => x.id === rescheduleForm.originalScheduleId)
  return s ? `${s.course_name} | ${s.date} ${s.start_time}-${s.end_time}` : ''
})

const filteredEligible = computed(() => {
  if (!searchKey.value) return eligibleList.value
  return eligibleList.value.filter(r => r.student_name?.includes(searchKey.value))
})

const error1 = ref('')

async function loadEligible() {
  error1.value = ''
  loading1.value = true
  try {
    const params = {}
    if (dateRange.value?.[0]) params.dateFrom = dateRange.value[0]
    if (dateRange.value?.[1]) params.dateTo = dateRange.value[1]
    const res = await getMakeupEligible(params)
    eligibleList.value = res.list || []
  } catch (e) {
    error1.value = e?.message || '数据加载失败，请稍后重试'
  } finally {
    loading1.value = false
  }
}

const error2 = ref('')

async function loadRecords() {
  error2.value = ''
  loading2.value = true
  try {
    const params = {}
    if (recordFilter.status) params.status = recordFilter.status
    const res = await getMakeupRecords(params)
    recordList.value = res.list || []
  } catch (e) {
    error2.value = e?.message || '数据加载失败，请稍后重试'
  } finally {
    loading2.value = false
  }
}

async function openAssign(row) {
  currentRow.value = row
  assignForm.makeupScheduleId = ''
  assignForm.note = ''
  assignVisible.value = true
  try {
    const res = await getSchedules({ pageSize: 100 })
    scheduleOptions.value = (res.list || []).filter(s => s.status === 'scheduled')
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

async function handleAssign() {
  if (!assignForm.makeupScheduleId) return ElMessage.warning('请选择补课排期')
  submitting.value = true
  try {
    await assignMakeup({
      studentId: currentRow.value.student_id,
      originalScheduleId: currentRow.value.schedule_id,
      makeupScheduleId: assignForm.makeupScheduleId,
      note: assignForm.note,
    })
    ElMessage.success('补课已安排')
    assignVisible.value = false
    loadEligible()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    submitting.value = false
  }
}

const recordDetailVisible = ref(false)
const recordDetail = ref(null)
function openRecordDetail(row) {
  recordDetail.value = row
  recordDetailVisible.value = true
}
async function cancelFromDetail() {
  if (!recordDetail.value) return
  // 仅当接口真正成功才改本地状态并关闭弹窗：
  // 旧实现无论用户点「取消」还是接口失败都会把记录标成「已取消」，制造假成功
  const ok = await handleCancel(recordDetail.value)
  if (!ok) return
  recordDetail.value.status = 'cancelled'
  recordDetailVisible.value = false
}

/**
 * 取消补课安排。
 * @returns {Promise<boolean>} 成功 true；用户取消确认框或接口失败均 false
 */
async function handleCancel(row) {
  try {
    await ElMessageBox.confirm(
      `确认取消「${row.student_name}」在 ${row.makeup_date || '所选日期'} 的补课安排？取消后该次补课需重新安排，家长端不再显示。`,
      '取消补课',
      { type: 'warning', confirmButtonText: '确认取消', cancelButtonText: '返回', confirmButtonClass: 'el-button--danger' }
    )
  } catch (e) {
    return false // 用户主动取消确认框，不做任何状态变更
  }
  try {
    await cancelMakeup({ id: row.id })
    ElMessage.success('已取消')
    loadRecords()
    return true
  } catch (e) {
    return false // 接口失败：拦截器已提示错误，不翻转本地状态
  }
}

// 调课：加载可选排期（进行中）
async function loadRescheduleOptions(query = '') {
  try {
    const res = await getScheduleOptions({ q: query })
    rescheduleScheduleOptions.value = res.list || []
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

// 调课：加载原排期下「尚未签到」的在册成员（后端要求原排期无签到记录）
async function loadOriginalStudents() {
  error3.value = ''
  const sid = rescheduleForm.originalScheduleId
  if (!sid) {
    rescheduleStudents.value = []
    return
  }
  loading3.value = true
  try {
    const detail = await getScheduleDetail(sid)
    rescheduleStudents.value = (detail.students || []).filter(
      (s) => (s.checkin_status || 'pending') === 'pending'
    )
  } catch (e) {
    error3.value = e?.message || '数据加载失败'
  } finally {
    loading3.value = false
  }
}

function openReschedule(row) {
  rescheduleRow.value = row
  rescheduleForm.newScheduleId = ''
  rescheduleForm.note = ''
  rescheduleVisible.value = true
}

async function handleReschedule() {
  if (!rescheduleForm.newScheduleId) return ElMessage.warning('请选择目标排期')
  if (rescheduleForm.newScheduleId === rescheduleForm.originalScheduleId) {
    return ElMessage.warning('目标排期不能与原排期相同')
  }
  submitting.value = true
  try {
    await rescheduleStudent({
      studentId: rescheduleRow.value.student_id,
      originalScheduleId: rescheduleForm.originalScheduleId,
      newScheduleId: rescheduleForm.newScheduleId,
      note: rescheduleForm.note,
    })
    ElMessage.success('调课成功')
    rescheduleVisible.value = false
    loadOriginalStudents()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    submitting.value = false
  }
}

function refreshActive() {
  if (activeMode.value === 'assign') loadEligible()
  else if (activeMode.value === 'records') loadRecords()
  else if (activeMode.value === 'reschedule') {
    loadRescheduleOptions().then(() => {
      if (rescheduleForm.originalScheduleId) loadOriginalStudents()
    })
  }
}

onMounted(() => {
  loadEligible()
  loadRecords()
})

// 切换到「调课」模式时加载排期数据
watch(activeMode, async (mode) => {
  if (mode === 'reschedule') {
    await loadRescheduleOptions()
    if (rescheduleForm.originalScheduleId) await loadOriginalStudents()
  }
})
</script>

<style scoped>
.text-muted {
  color: var(--t-text-faint);
  font-size: var(--t-fs-xs);
}

.reschedule-empty {
  padding: var(--t-spacing-xl) 0;
  text-align: center;
  color: var(--t-text-faint);
  font-size: var(--t-fs-sm);
}

:deep(.el-dialog__footer) {
  display: flex;
  justify-content: flex-end;
  gap: var(--t-spacing-sm);
}
</style>
