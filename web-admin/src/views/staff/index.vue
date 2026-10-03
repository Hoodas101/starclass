<template>
  <div class="page-shell">
    <PageHeader v-if="!embedded" title="员工管理" />
    <!-- 顶部操作栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <el-input
          v-model="searchKeyword"
          placeholder="搜索员工姓名"
          :prefix-icon="Search"
          clearable
          style="width: 220px"
        />
        <span class="toolbar-count">共 {{ totalStaff }} 条</span>
      </div>
      <div class="toolbar-right">
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出</el-button>
        <el-button type="primary" :icon="Plus" @click="openAddDialog">
          添加员工
        </el-button>
      </div>
    </div>

    <!-- 员工表格 -->
    <div class="card table-container">
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadStaff" />
      <el-table v-else v-loading="loading" :data="pagedStaff" row-class-name="clickable-row" @row-click="openDetailDrawer" size="small" empty-text="暂无员工">
        <el-table-column label="姓名" min-width="100">
          <template #default="{ row }">
            <span class="staff-name">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="身份" min-width="90">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="row.role === 'admin' ? 'danger' : row.role === 'sales' ? 'warning' : 'primary'">
              {{ roleText(row.role) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="专长" min-width="100">
          <template #default="{ row }">{{ row.specialty || '-' }}</template>
        </el-table-column>
        <el-table-column label="手机号" min-width="140">
          <template #default="{ row }">{{ row.phone || '-' }}</template>
        </el-table-column>
        <el-table-column label="性别" min-width="72">
          <template #default="{ row }">{{ row.gender || '-' }}</template>
        </el-table-column>
        <el-table-column label="入职日期" min-width="120">
          <template #default="{ row }">{{ row.hire_date || '-' }}</template>
        </el-table-column>
        <el-table-column label="排课" min-width="80">
          <template #default="{ row }">
            <span class="schedule-count">{{ row.scheduleCount || 0 }} 节</span>
          </template>
        </el-table-column>
        <el-table-column label="简介" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.bio || '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" min-width="90">
          <template #default="{ row }">
            <StatusDot :tone="row.status === 'active' ? 'success' : 'neutral'" :label="row.status === 'active' ? '在职' : '离职'" subtle />
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="totalStaff"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @size-change="onSizeChange"
        />
      </div>
    </div>

    <!-- 员工详情抽屉（CRM RecordSheet 风格） -->
    <el-drawer
      v-model="detailDrawerVisible"
      :title="selectedStaff?.name"
      direction="rtl"
      size="var(--t-drawer-md)"
    >
      <div v-if="selectedStaff" class="staff-detail">
        <div class="detail-header">
          <EntityAvatar
            :name="selectedStaff.name"
            :src="selectedStaff.avatar"
            size="xl"
            :tone="selectedStaff.role === 'admin' ? 'warning' : selectedStaff.role === 'sales' ? 'accent' : 'info'"
          />
          <div class="detail-header-info">
            <h3>{{ selectedStaff.name }}</h3>
            <div class="detail-header-status">
              <StatusDot :tone="selectedStaff.status === 'active' ? 'success' : 'neutral'" :label="selectedStaff.status === 'active' ? '在职' : '离职'" />
              <span class="detail-role">{{ roleText(selectedStaff.role) }}</span>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h4>基本资料</h4>
          <div class="prop-rows">
            <div class="prop-row"><span class="prop-label">手机号</span><span class="prop-value">{{ selectedStaff.phone || '-' }}</span></div>
            <div class="prop-row"><span class="prop-label">性别</span><span class="prop-value">{{ selectedStaff.gender || '-' }}</span></div>
            <div class="prop-row"><span class="prop-label">入职日期</span><span class="prop-value">{{ selectedStaff.hire_date || '-' }}</span></div>
            <div class="prop-row"><span class="prop-label">擅长方向</span><span class="prop-value">{{ selectedStaff.specialty || '-' }}</span></div>
            <div class="prop-row"><span class="prop-label">未来排课</span><span class="prop-value prop-strong">{{ selectedStaff.scheduleCount || 0 }} 节</span></div>
            <div class="prop-row"><span class="prop-label">个人简介</span><span class="prop-value">{{ selectedStaff.bio || '-' }}</span></div>
          </div>
        </div>

        <div class="detail-section">
          <h4>权限范围</h4>
          <div v-if="(selectedStaff.permissions || []).length" class="perm-tags">
            <span v-for="p in selectedStaff.permissions" :key="p" class="perm-tag">{{ permText(p) }}</span>
          </div>
          <div v-else class="empty-hint">{{ selectedStaff.role === 'admin' ? '管理者拥有全部权限' : '未开放自定义权限' }}</div>
        </div>

        <div class="detail-actions">
          <el-button class="action-btn" @click="openAddDialog(selectedStaff)">编辑资料</el-button>
          <el-button
            class="action-btn"
            :type="selectedStaff.status === 'active' ? 'danger' : 'success'"
            plain
            @click="handleDelete(selectedStaff)"
          >{{ selectedStaff.status === 'active' ? '停用账号' : '启用账号' }}</el-button>
        </div>
      </div>
    </el-drawer>

    <!-- 添加员工弹窗 -->
    <el-dialog
      v-model="addDialogVisible"
      :title="editingId ? '编辑员工' : '添加员工'"
      class="dlg-lg"
      destroy-on-close
    >
      <el-form
        ref="addFormRef"
        :model="addForm"
        :rules="addRules"
        label-width="auto"
        label-position="left"
      >
        <el-form-item label="姓名" prop="name">
          <el-input v-model="addForm.name" placeholder="请输入姓名" />
        </el-form-item>
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="addForm.phone" placeholder="请输入手机号" />
        </el-form-item>
        <el-form-item label="专长" prop="specialty">
          <el-input v-model="addForm.specialty" placeholder="如：篮球 / 体能" />
        </el-form-item>
        <el-form-item label="性别">
          <el-radio-group v-model="addForm.gender">
            <el-radio value="男">男</el-radio>
            <el-radio value="女">女</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="员工身份">
          <el-radio-group v-model="addForm.role">
            <el-radio value="coach">{{ $t('instructor') }}</el-radio>
            <el-radio value="sales">{{ $t('sales') }}</el-radio>
            <el-radio value="admin">管理者</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="addForm.role !== 'admin'" label="功能权限">
          <el-checkbox-group v-model="addForm.permissions" class="perm-group">
            <el-checkbox v-for="p in permOptions" :key="p.key" :value="p.key">{{ p.label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <div v-else class="perm-admin-note">管理者拥有全部权限</div>
        <el-form-item label="入职日期" prop="hireDate">
          <el-date-picker
            v-model="addForm.hireDate"
            type="date"
            placeholder="选择入职日期"
            format="YYYY-MM-DD"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="简介">
          <el-input v-model="addForm.bio" type="textarea" :rows="3" placeholder="教师简介" />
        </el-form-item>
        <div v-if="!editingId" class="staff-add-hint">
          <el-icon :size="14"><InfoFilled /></el-icon>
          <span>员工创建后将自动开通小程序登录账号，初始密码为 123456，可在「个人资料」中修改。</span>
        </div>
      </el-form>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="addDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="submitting" @click="submitAdd">{{ editingId ? '保存修改' : '确认添加' }}</el-button>
        </div>
      </template>
    </el-dialog>
  </div>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出员工数据"
      description="员工列表为当前全员快照，不支持按时间筛选；确认后将导出全部员工。"
      @confirm="doExport"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { Plus, Search, UserFilled, Download, InfoFilled } from '@element-plus/icons-vue'
import { getTeachers, addTeacher, updateTeacher, deleteTeacher } from '@/api/modules'
import dayjs from 'dayjs'
import { exportXlsx } from '@/utils/xlsx'
import EntityAvatar from '@/components/EntityAvatar.vue'
import PageHeader from '@/components/PageHeader.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import StatusDot from '@/components/StatusDot.vue'
import { useSettingsStore } from '@/store/settings'

const settingsStore = useSettingsStore()
const t = settingsStore.t

const searchKeyword = ref('')
const loading = ref(false)
const submitting = ref(false)
const addDialogVisible = ref(false)
const addFormRef = ref(null)
const exportDialogRef = ref(null)
const editingId = ref('')
const currentPage = ref(1)
const pageSize = ref(10)

const staffList = ref([])

// 详情抽屉（CRM RecordSheet 风格）
const detailDrawerVisible = ref(false)
const selectedStaff = ref(null)

const openDetailDrawer = (row) => {
  selectedStaff.value = row
  detailDrawerVisible.value = true
}

const permText = (p) => ({
  dashboard: '数据看板',
  students: '成员管理',
  sales: '销售管理',
  schedule: '排期管理',
  checkin: '签到管理',
  growth: '增长中心',
  leave: '请假审批',
  points: '积分管理',
  notice: '通知中心',
  courses: '班级管理',
  coachstats: t('instructor') + '课时',
  parents: '家长沟通',
  feedback: '意见反馈',
  settings: '系统设置',
  staff: '员工管理',
}[p] || p)

const error = ref('')

const loadStaff = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await getTeachers({ includeInactive: '1' })
    staffList.value = res.list || []
  } catch (e) {
    error.value = e?.message || '数据加载失败，请稍后重试'
    staffList.value = []
  } finally {
    loading.value = false
  }
}

const doExport = (range) => {
  // 员工列表没有时间维度，时间范围不参与过滤：用户选了范围时如实告知，避免以为导出被截断
  if (range && range.length === 2) {
    ElMessage.warning('员工列表为当前全员快照，不支持按时间筛选，已导出全部')
  }
  const list = staffList.value
  if (!list.length) {
    ElMessage.warning('暂无可导出的员工数据')
    return
  }
  const headers = ['姓名', '身份', '手机号', '性别', '入职日期', '简介', '状态']
  const rows = list.map((t) => [
    t.name || '',
    roleText(t.role),
    t.phone || '',
    t.gender || '',
    t.hire_date || '',
    t.bio || '',
    t.status === 'active' ? '在职' : '离职'
  ])
  exportXlsx(`员工列表_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '员工列表' })
  ElMessage.success(`已导出 ${rows.length} 名员工`)
}

const filteredStaff = computed(() => {
  if (!searchKeyword.value) return staffList.value
  const kw = searchKeyword.value.toLowerCase()
  return staffList.value.filter(
    (s) => (s.name || '').includes(kw) || (s.phone || '').includes(kw) || (s.specialty || '').includes(kw)
  )
})
const totalStaff = computed(() => filteredStaff.value.length)
const pagedStaff = computed(() =>
  filteredStaff.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value)
)
watch(searchKeyword, () => { currentPage.value = 1 })
// 每页条数变化后回到第 1 页，避免停留在越界页码出现空列表
const onSizeChange = () => { currentPage.value = 1 }

const addForm = reactive({
  name: '',
  phone: '',
  specialty: '',
  gender: '男',
  role: 'coach',
  permissions: [],
  hireDate: '',
  bio: ''
})

const permOptions = [
  { key: 'dashboard', label: '数据看板' },
  { key: 'sales', label: '销售管理' },
  { key: 'students', label: '成员管理' },
  { key: 'schedule', label: '排课/活动' },
  { key: 'checkin', label: '今日点名' },
  { key: 'leave', label: '请假审批' },
  { key: 'growth', label: '增长中心' },
  { key: 'courses', label: '班级管理' },
  { key: 'notice', label: '发布通知' },
  { key: 'coachstats', label: t('instructor') + '课时' },
  { key: 'parents', label: '家长沟通' },
  { key: 'feedback', label: '意见反馈' },
]

const roleText = (r) => settingsStore.roleLabel(r)

const addRules = {
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确', trigger: 'blur' }
  ],
  specialty: [{ required: true, message: '请输入专长', trigger: 'blur' }],
  hireDate: [{ required: true, message: '请选择入职日期', trigger: 'change' }]
}

const openAddDialog = (row) => {
  editingId.value = row?.id || ''
  const role = row?.role || 'coach'
  Object.assign(addForm, {
    name: row?.name || '',
    phone: row?.phone || '',
    specialty: row?.specialty || '',
    gender: row?.gender === 'female' || row?.gender === '女' ? '女' : '男',
    role,
    permissions: role === 'admin' ? [] : (Array.isArray(row?.permissions) ? row.permissions : []),
    hireDate: row?.hire_date || '',
    bio: row?.bio || ''
  })
  addDialogVisible.value = true
}

const submitAdd = async () => {
  if (!addFormRef.value) return
  const valid = await addFormRef.value.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    if (editingId.value) {
      await updateTeacher(editingId.value, {
        ...addForm,
        role: addForm.role,
        permissions: addForm.role === 'admin' ? [] : addForm.permissions,
      })
      ElMessage.success('员工信息已更新')
    } else {
      await addTeacher({
        ...addForm,
        role: addForm.role,
        permissions: addForm.role === 'admin' ? [] : addForm.permissions,
      })
      ElMessage.success('员工添加成功')
    }
    addDialogVisible.value = false
    loadStaff()
  } catch (e) {
    // 拦截器已提示
  } finally {
    submitting.value = false
  }
}

const handleDelete = async (row) => {
  try {
    const enabling = row.status !== 'active'
    await ElMessageBox.confirm(
      enabling
        ? `确定重新启用员工「${row.name}」吗？`
        : `确定停用员工「${row.name}」吗？`,
      '提示', { type: 'warning', confirmButtonText: enabling ? '确认启用' : '确认停用', confirmButtonClass: enabling ? '' : 'el-button--danger' }
    )
    if (enabling) {
      await updateTeacher(row.id, { status: 'active' })
      ElMessage.success('已启用')
    } else {
      await deleteTeacher(row.id)
      ElMessage.success('已停用')
    }
    loadStaff()
  } catch (e) {
    // 取消或失败
  }
}

onMounted(loadStaff)
</script>

<style lang="scss" scoped>
.schedule-count {
  font-variant-numeric: tabular-nums;
  color: var(--t-text-2);
}

// 详情抽屉（CRM RecordSheet 风格）
.detail-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: var(--t-spacing-lg);
}

.detail-header-info {
  h3 {
    font-size: var(--t-fs-2xl);
    font-weight: 700;
    color: var(--t-text-1);
    margin: 0 0 6px;
  }
}

.detail-header-status {
  display: flex;
  align-items: center;
  gap: 10px;
}

.detail-role {
  font-size: var(--t-fs-xs);
  color: var(--t-accent-strong, var(--t-accent));
  font-weight: 600;
}

.detail-section {
  margin-bottom: var(--t-spacing-lg);

  h4 {
    font-size: var(--t-fs-xs);
    font-weight: 600;
    color: var(--t-text-3);
    margin: 0 0 8px;
    letter-spacing: 0.5px;
  }
}

.prop-rows {
  display: flex;
  flex-direction: column;
}

.prop-row {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 12px;
  padding: var(--t-spacing-sm) 0;
  border-bottom: 1px solid var(--t-line);

  &:last-child {
    border-bottom: none;
  }
}

.prop-label {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  line-height: 1.5;
}

.prop-value {
  font-size: var(--t-fs-sm);
  color: var(--t-text-1);
  line-height: 1.5;
  word-break: break-all;
}

.prop-strong {
  font-weight: 600;
  color: var(--t-accent-strong, var(--t-accent));
}

.perm-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.perm-tag {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
  background: var(--t-surface-hover);
  border: 1px solid var(--t-line);
  border-radius: $radius-lg;
  padding: 3px 9px;
}

.detail-actions {
  display: flex;
  gap: 10px;
  margin-top: var(--t-spacing-lg);
  padding-top: var(--t-spacing-md);
  border-top: 1px solid var(--t-line);
}
.detail-actions .action-btn {
  flex: 1;
  height: 38px;
  border-radius: $radius-xl;
  font-weight: 500;
}

.empty-hint {
  font-size: var(--t-fs-sm);
  color: var(--t-text-3);
}

.staff-name {
  font-weight: 600;
  color: var(--t-text-1);
}
.perm-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  width: 100%;
}
.perm-admin-note {
  width: 100%;
  font-size: var(--t-fs-sm);
  color: var(--t-accent-text);
  background: var(--t-accent-bg);
  border-radius: $radius-xl;
  padding: 8px 12px;
}

.staff-add-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  background: var(--t-surface-hover);
  border-radius: $radius-xl;
  padding: 8px 12px;
  margin-bottom: 8px;
}

// 响应式
@media (max-width: 768px) {
  .toolbar {
    flex-direction: column;
    align-items: flex-start;
  }

  .toolbar-right {
    flex-wrap: wrap;
    width: 100%;
  }
}
</style>
