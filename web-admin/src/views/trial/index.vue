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
          <el-table-column :label="$t('learner')" min-width="130">
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
              <!-- 已安排的试听：可一键转正式学员，打通「试听 → 学员 → 开卡」主链路 -->
              <el-button
                v-else-if="row.status === 'assigned'"
                type="primary"
                link
                size="small"
                @click.stop="openConvertDialog(row)"
              >转正式学员</el-button>
              <span v-else class="trial-sub">{{ row.status === 'assigned' ? '已安排' : '已处理' }}</span>
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
            @size-change="onPageSizeChange"
          />
        </div>
      </template>
    </div>

    <!-- 安排试听弹窗 -->
    <el-dialog v-model="assignVisible" title="安排试听" class="dlg-md" destroy-on-close>
      <div class="assign-info">
        <div class="assign-row">
          <span class="assign-label">{{ $t('learner') }}</span>
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

    <!-- 转正式学员弹窗：串联「建学员 → 试听成交 → 引导开卡」 -->
    <el-dialog v-model="convertVisible" title="转正式学员" class="dlg-md" destroy-on-close>
      <div v-loading="convertLoading">
        <div class="assign-info">
          <div class="assign-row">
            <span class="assign-label">试听{{ $t('learner') }}</span>
            <span class="assign-value">{{ convertingTrial?.student_name || '—' }}</span>
          </div>
          <div class="assign-row">
            <span class="assign-label">家长 / 电话</span>
            <span class="assign-value">{{ convertingTrial?.parent_name || '—' }} {{ convertingTrial?.parent_phone || '' }}</span>
          </div>
          <div class="assign-row">
            <span class="assign-label">意向课程</span>
            <span class="assign-value">{{ convertingTrial?.course_name || '未指定' }}</span>
          </div>
        </div>

        <!-- 学员已建档但成交失败时保留，重试无需重复建档 -->
        <el-alert
          v-if="createdStudentId"
          type="success"
          :closable="false"
          show-icon
          title="学员已建档，转化失败时可直接重试，无需重复建档"
          class="convert-alert"
        />

        <el-form ref="convertFormRef" :model="convertForm" :rules="convertRules" label-width="auto" label-position="left">
          <el-form-item :label="`${$t('learner')}姓名`" prop="name">
            <el-input v-model="convertForm.name" placeholder="必填" />
          </el-form-item>
          <el-form-item label="家长手机号" prop="phone">
            <el-input v-model="convertForm.phone" maxlength="11" placeholder="用于家长登录与通知；非法号码仍会建档但不绑定家长" />
          </el-form-item>
          <el-form-item label="性别">
            <el-select v-model="convertForm.gender" clearable placeholder="未填写" style="width: 100%">
              <el-option label="男" value="男" />
              <el-option label="女" value="女" />
            </el-select>
          </el-form-item>
          <el-form-item label="生日">
            <el-date-picker
              v-model="convertForm.birthday"
              type="date"
              format="YYYY-MM-DD"
              value-format="YYYY-MM-DD"
              placeholder="未填写"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="convertForm.remark" type="textarea" :rows="2" placeholder="选填" />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="convertVisible = false">取消</el-button>
        <el-button type="primary" :loading="convertSubmitting" @click="submitConvert">确认转化</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, reactive, computed, onMounted } from 'vue'
import dayjs from 'dayjs'
import { useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import PageHeader from '@/components/PageHeader.vue'
import StatusDot from '@/components/StatusDot.vue'
import {
  getTrialList,
  updateTrial,
  getScheduleOptions,
  getTrialDetail,
  addStudent,
  convertTrial,
} from '@/api/modules'
import { usePerm } from '@/composables/usePerm'

// 转化链路要调 POST /students（后端限管理员），故入口仅对管理员开放，
// 避免销售角色点进去必然 403
const isAdmin = computed(() => usePerm().role.value === 'admin')
const router = useRouter()

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

// 每页条数变化：回到第 1 页，避免停留在超出新总页数的页码上显示空列表
const onPageSizeChange = () => {
  page.value = 1
  loadData()
}

// ============================================
// 转正式学员（试听 → 建学员 → 成交 → 引导开卡）
// ============================================
const convertVisible = ref(false)
const convertLoading = ref(false)
const convertSubmitting = ref(false)
const convertingTrial = ref(null)
const convertFormRef = ref(null)
// 已建档学员 ID：转化失败时保留，重试时跳过「建学员」这一步（已完成的步骤不回滚）
const createdStudentId = ref('')
const convertForm = reactive({ name: '', phone: '', gender: '', birthday: '', remark: '' })
const convertRules = {
  name: [{ required: true, message: '请填写学员姓名', trigger: 'blur' }],
}

const openConvertDialog = async (row) => {
  convertingTrial.value = row
  createdStudentId.value = ''
  Object.assign(convertForm, {
    name: row?.student_name || '',
    phone: row?.parent_phone || '',
    gender: row?.student_gender || '',
    birthday: '',
    remark: row?.note || '',
  })
  convertVisible.value = true
  // 拉详情以取更完整的预填字段；字段缺失时留空由用户补全
  convertLoading.value = true
  try {
    const detail = await getTrialDetail(row.id)
    const p = detail?.studentPayload || {}
    convertForm.name = p.name || convertForm.name
    convertForm.phone = p.phone || p.parentPhone || convertForm.phone
    convertForm.gender = p.gender || convertForm.gender
    convertForm.birthday = p.birthday || convertForm.birthday
    convertForm.remark = p.remark || convertForm.remark
  } catch (e) {
    // 详情接口异常时退回列表行预填，不阻断转化
  } finally {
    convertLoading.value = false
  }
}

// 建档：处理「强重复」二次确认与后端 warning（非法手机号不阻断建档，但必须提示）
const createStudentForConvert = async () => {
  const payload = {
    name: convertForm.name.trim(),
    phone: convertForm.phone.trim(),
    gender: convertForm.gender,
    birthday: convertForm.birthday,
    remark: convertForm.remark,
  }
  let res
  try {
    res = await addStudent(payload)
  } catch (e) {
    return null // 拦截器已提示（403 权限 / 手机号占用等）
  }
  if (res?.duplicate) {
    const names = (res.candidates || []).map((c) => `${c.name}(${c.member_no || '—'})`).join('、')
    try {
      await ElMessageBox.confirm(
        `已存在同手机号学员：${names || '—'}。确认仍要新建一名学员？`,
        '疑似重复建档',
        { type: 'warning', confirmButtonText: '仍然新建', cancelButtonText: '取消' }
      )
    } catch (e) {
      return null
    }
    try {
      res = await addStudent({ ...payload, confirmDuplicate: true })
    } catch (e) {
      return null
    }
    if (res?.duplicate) {
      ElMessage.error('仍未能建立学员，请核对信息后重试')
      return null
    }
  }
  if (!res?.id) {
    ElMessage.error('学员创建失败，请稍后重试')
    return null
  }
  const warnings = res.warnings || []
  if (warnings.length) {
    ElMessage.warning(warnings.map((w) => w.reason).filter(Boolean).join('；'))
  }
  return res.id
}

const submitConvert = async () => {
  if (!convertingTrial.value) return
  if (!convertFormRef.value) return
  const valid = await convertFormRef.value.validate().catch(() => false)
  if (!valid) return
  convertSubmitting.value = true
  try {
    // 步骤 1：建学员（若已建过则跳过，支持转化失败后直接重试）
    let studentId = createdStudentId.value
    if (!studentId) {
      studentId = await createStudentForConvert()
      if (!studentId) return // 失败原因已提示，保留原状
      createdStudentId.value = studentId
    }

    // 步骤 2：标记试听成交（幂等）
    let conv
    try {
      conv = await convertTrial(convertingTrial.value.id, { studentId })
    } catch (e) {
      // 学员已建好但成交失败：不回滚，保留 studentId 供重试
      ElMessage.warning('学员已创建，请重试转化')
      return
    }
    if (conv?.alreadyConverted) {
      ElMessage.info('该试听已转化')
    } else {
      ElMessage.success('已转为正式学员')
    }
    convertVisible.value = false
    loadData()

    // 步骤 3：引导开卡。订单页不支持 query 预选学员，故仅跳转并提示手动选择学员。
    try {
      await ElMessageBox.confirm(
        '学员已建档。是否现在前往订单页为其开卡？',
        '转化成功',
        { type: 'success', confirmButtonText: '去开卡', cancelButtonText: '稍后' }
      )
      router.push({ path: '/sales', query: { tab: 'orders' } })
    } catch (e) {
      // 用户选择稍后处理
    }
  } finally {
    convertSubmitting.value = false
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

.convert-alert {
  margin-bottom: var(--t-spacing-md);
}
</style>
