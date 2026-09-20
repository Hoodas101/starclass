<template>
  <div class="page-shell">
    <!-- 顶部标题（hub 内嵌；embedded 时由 hub 提供，本页不重复） -->
    <PageHeader v-if="!embedded" title="班级管理" />
    <!-- 顶部操作栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <el-input
          v-model="searchKeyword"
          placeholder="搜索项目名称"
          :prefix-icon="Search"
          clearable
          style="width: 220px"
        />
        <span class="toolbar-count">共 {{ courses.length }} 个项目</span>
      </div>
      <div class="toolbar-right">
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出</el-button>
        <el-button type="primary" :icon="Plus" @click="openAddDialog()">
          新建项目
        </el-button>
      </div>
    </div>

    <!-- 项目卡片网格 -->
    <div v-loading="loading" class="class-grid">
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadCourses" />
      <div
        v-for="cls in filteredCourses"
        :key="cls.id"
        class="class-card"
        @click="openDetail(cls)"
      >
        <div class="class-card-banner" :style="{ background: cls.color || classFallback() }">
          <span class="class-card-category">{{ cls.category || '常规训练' }}</span>
        </div>

        <div class="class-card-body">
          <h3 class="class-card-name">{{ cls.name }}</h3>
          <p class="class-card-desc">{{ cls.description || '暂无描述' }}</p>

          <div class="class-card-info">
            <div class="info-item">
              <el-icon><User /></el-icon>
              <span>上限 {{ cls.max_students || '-' }} 人</span>
            </div>
            <div class="info-item">
              <el-icon><Clock /></el-icon>
              <span>{{ cls.duration || 90 }} 分钟/次</span>
            </div>
            <div class="info-item">
              <el-icon><Money /></el-icon>
              <span>¥{{ Number(cls.price_per_class || 0).toLocaleString() }}</span>
            </div>
            <div class="info-item">
              <el-icon><DataLine /></el-icon>
              <span>{{ cls.consume_classes || 1 }} 课时/次</span>
            </div>
          </div>

          <div class="class-card-footer">
            <StatusDot
              :tone="cls.archived ? 'neutral' : (cls.is_active !== 0 ? 'success' : 'warning')"
              :label="cls.archived ? '已归档' : (cls.is_active !== 0 ? '在售' : '已停用')"
              subtle
            />
            <span class="click-hint">点击查看详情</span>
          </div>
        </div>
      </div>

      <div v-if="!loading && filteredCourses.length === 0" class="empty-box">
        暂无项目，点击右上角「新建项目」创建
      </div>
    </div>

    <!-- 新建/编辑项目弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑项目' : '新建项目'"
      class="dlg-lg"
      destroy-on-close
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="formRules"
        label-width="auto"
        label-position="left"
      >
        <el-form-item label="项目名称" prop="name">
          <el-input v-model="form.name" placeholder="如：基础篮球 / 进阶篮球" />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="form.category" placeholder="如：篮球 / 体能" />
        </el-form-item>
        <el-form-item label="单次时长">
          <el-input-number v-model="form.duration" :min="30" :max="240" :step="15" />
          <span class="unit-text">分钟</span>
        </el-form-item>
        <el-form-item label="消耗课时">
          <el-input-number v-model="form.consumeClasses" :min="1" :max="10" />
        </el-form-item>
        <el-form-item label="人数上限">
          <el-input-number v-model="form.maxStudents" :min="1" :max="100" />
        </el-form-item>
        <el-form-item label="单次价格">
          <el-input-number v-model="form.pricePerClass" :min="0" :max="9999" :step="50" />
          <span class="unit-text">元</span>
        </el-form-item>
        <el-form-item label="标识色">
          <el-color-picker v-model="form.color" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="3" placeholder="项目说明" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <!-- 项目详情抽屉 -->
    <el-drawer v-model="detailVisible" :title="selectedClass?.name || '项目详情'" direction="rtl" size="var(--t-drawer-md)">
      <div v-if="selectedClass" class="class-detail">
        <div class="detail-banner" :style="{ background: selectedClass.color || classFallback() }">
          <span class="detail-category">{{ selectedClass.category || '常规训练' }}</span>
          <StatusDot
            :tone="selectedClass.archived ? 'neutral' : (selectedClass.is_active !== 0 ? 'success' : 'warning')"
            :label="selectedClass.archived ? '已归档' : (selectedClass.is_active !== 0 ? '在售' : '已停用')"
          />
        </div>
        <h3 class="detail-name">{{ selectedClass.name }}</h3>
        <p class="detail-desc">{{ selectedClass.description || '暂无描述' }}</p>

        <div class="detail-grid">
          <div class="detail-item">
            <span class="detail-label">人数上限</span>
            <span class="detail-value">{{ selectedClass.max_students || '-' }} 人</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">单次时长</span>
            <span class="detail-value">{{ selectedClass.duration || 90 }} 分钟</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">单次价格</span>
            <span class="detail-value">¥{{ Number(selectedClass.price_per_class || 0).toLocaleString() }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">消耗课时</span>
            <span class="detail-value">{{ selectedClass.consume_classes || 1 }} 课时/次</span>
          </div>
        </div>

        <div class="detail-actions">
          <el-button type="primary" :icon="Edit" @click="editFromDetail">编辑项目</el-button>
          <el-button :icon="CircleCheck" @click="handleToggleActive(selectedClass)">
            {{ selectedClass.is_active !== 0 ? '停用' : '启用' }}
          </el-button>
          <el-button :icon="FolderChecked" @click="handleArchive(selectedClass)">
            {{ selectedClass.archived ? '恢复' : '归档' }}
          </el-button>
          <el-button type="danger" :icon="Delete" @click="handleDelete(selectedClass)">删除项目</el-button>
        </div>
      </div>
    </el-drawer>
  </div>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出项目数据"
      description="选择时间范围后确认导出；留空导出全部项目。"
      @confirm="doExport"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, reactive, computed, onMounted } from 'vue'
import { Plus, Search, User, Clock, Money, DataLine, Download, Edit, Delete, CircleCheck, FolderChecked } from '@element-plus/icons-vue'
import { getCourses, addCourse, updateCourse, deleteCourse } from '@/api/modules'
import dayjs from 'dayjs'
import { exportXlsx } from '@/utils/xlsx'
import StatusDot from '@/components/StatusDot.vue'
import PageHeader from '@/components/PageHeader.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import { classFallback } from '@/utils/theme-colors'

const searchKeyword = ref('')
const courses = ref([])
const loading = ref(false)
const submitting = ref(false)

const error = ref('')

const loadCourses = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await getCourses({ includeInactive: '1' })
    courses.value = res.list || []
  } catch (e) {
    error.value = e?.message || '数据加载失败，请稍后重试'
    courses.value = []
  } finally {
    loading.value = false
  }
}

const filteredCourses = computed(() => {
  if (!searchKeyword.value) return courses.value
  const kw = searchKeyword.value.toLowerCase()
  return courses.value.filter(
    (c) => (c.name || '').toLowerCase().includes(kw) || (c.category || '').toLowerCase().includes(kw)
  )
})

const doExport = (range) => {
  const items = filteredCourses.value
  if (!items.length) {
    ElMessage.warning('暂无可导出的项目数据')
    return
  }
  const headers = ['项目名称', '分类', '描述', '人数上限', '时长(分钟)', '价格(元/次)', '消耗课时', '状态']
  const rows = items.map((c) => [
    c.name || '',
    c.category || '',
    c.description || '',
    c.max_students || '',
    c.duration || 90,
    Number(c.price_per_class || 0),
    c.consume_classes || 1,
    c.archived ? '已归档' : (c.is_active !== 0 ? '在售' : '已停用')
  ])
  exportXlsx(`项目列表_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '项目列表' })
  ElMessage.success(`已导出 ${rows.length} 个项目`)
}

// 新建 / 编辑
const dialogVisible = ref(false)
const formRef = ref(null)
const exportDialogRef = ref(null)
const editingId = ref('')
const editingIsActive = ref(1)

const form = reactive({
  name: '',
  category: '',
  duration: 90,
  consumeClasses: 1,
  maxStudents: 20,
  pricePerClass: 0,
  color: classFallback(),
  description: ''
})

const formRules = {
  name: [{ required: true, message: '请输入项目名称', trigger: 'blur' }]
}

const openAddDialog = (row) => {
  editingId.value = row?.id || ''
  editingIsActive.value = row?.is_active ?? 1
  Object.assign(form, {
    name: row?.name || '',
    category: row?.category || '',
    duration: row?.duration || 90,
    consumeClasses: row?.consume_classes || 1,
    maxStudents: row?.max_students || 20,
    pricePerClass: row?.price_per_class || 0,
    color: row?.color || classFallback(),
    description: row?.description || ''
  })
  dialogVisible.value = true
}

const submitForm = async () => {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    if (editingId.value) {
      await updateCourse(editingId.value, { ...form, isActive: editingIsActive.value })
      ElMessage.success('项目已更新')
    } else {
      await addCourse(form)
      ElMessage.success('项目已创建')
    }
    dialogVisible.value = false
    loadCourses()
  } catch (e) {
    // 拦截器已提示
  } finally {
    submitting.value = false
  }
}

const handleToggleActive = async (row) => {
  try {
    const next = row.is_active === 0 ? 1 : 0
    await updateCourse(row.id, { isActive: next })
    ElMessage.success(next ? '已启用' : '已停用')
    loadCourses()
  } catch (e) {
    // 取消或失败
  }
}

const handleArchive = async (row) => {
  try {
    const next = row.archived ? 0 : 1
    await updateCourse(row.id, { archived: next })
    ElMessage.success(next ? '已归档' : '已恢复')
    loadCourses()
  } catch (e) {
    // 取消或失败
  }
}

const handleDelete = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确定删除项目「${row.name}」？已产生上课、扣课或收入结转记录的项目不能删除（会导致课时与账目对不上），需先改为「停用」；仅排过课但尚未上过的项目可被删除。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除', confirmButtonClass: 'el-button--danger' }
    )
    await deleteCourse(row.id)
    ElMessage.success('已删除')
    loadCourses()
  } catch (e) {
    // 取消或失败
  }
}

// 项目详情
const detailVisible = ref(false)
const selectedClass = ref(null)

const openDetail = (cls) => {
  selectedClass.value = cls
  detailVisible.value = true
}

const editFromDetail = () => {
  detailVisible.value = false
  openAddDialog(selectedClass.value)
}

onMounted(loadCourses)
</script>

<style lang="scss" scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--t-spacing-lg);
  gap: var(--t-spacing-md);
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: var(--t-spacing-sm);
}

.page-title {
  font-size: var(--t-fs-2xl);
  font-weight: 700;
  color: var(--t-text-1);
  margin: 0;
}

.toolbar-count {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--t-spacing-sm);
  flex-wrap: wrap;
}

.class-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--t-spacing-lg);
}

.class-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.16s ease;

  &:hover {
    border-color: var(--t-accent-line);
  }
}

.class-card-banner {
  height: 72px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 14px 16px;
  position: relative;
  gap: 8px;

  // 顶部压暗遮罩：确保分类背景上的白字始终可读
  // 遮罩强度取决于 banner 的课程标识色（饱和中亮底），与页面明暗主题无关，
  // 故用固定黑色半透明而非 --t-scrim，两色主题下白字对比度一致达标。
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.15) 65%, rgba(0, 0, 0, 0));
    pointer-events: none;
  }

  .class-card-category {
    position: relative;
    z-index: 1;
    color: #fff;
    font-size: var(--t-fs-sm);
    font-weight: 600;
    background: rgba(0, 0, 0, 0.78);
    padding: 4px 12px;
    border-radius: 9999px;
    backdrop-filter: blur(4px);
  }

}

// 横幅上的白色文字/遮罩在深浅两色主题下均可读（banner 为课程标识色实底），无需按主题分支

.class-card-body {
  padding: 18px 20px 16px;

  .class-card-name {
    font-size: var(--t-fs-lg);
    font-weight: 700;
    color: var(--t-text-1);
    margin: 0 0 6px;
  }

  .class-card-desc {
    font-size: var(--t-fs-sm);
    color: var(--t-text-2);
    margin: 0 0 16px;
    min-height: 20px;
  }
}

.class-card-info {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 16px;
  margin-bottom: 16px;

  .info-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--t-fs-sm);
    color: var(--t-text-2);

    .el-icon {
      color: var(--t-text-3);
    }
  }
}

.class-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid var(--t-line);
}

.click-hint {
  font-size: var(--t-fs-xs);
  color: var(--t-text-faint);
}

.class-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.detail-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-radius: var(--t-radius-md);
}

.detail-category {
  color: #fff;
  font-size: var(--t-fs-sm);
  font-weight: 600;
}

.detail-name {
  font-size: var(--t-fs-xl);
  font-weight: 700;
  color: var(--t-text-1);
  margin: 0;
}

.detail-desc {
  font-size: var(--t-fs-sm);
  line-height: 1.7;
  color: var(--t-text-2);
  margin: 0;
}

.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.detail-item {
  background: var(--t-surface-hover);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-label {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.detail-value {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
}

.detail-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: var(--t-spacing-sm);
}

.detail-actions .el-button {
  margin-left: 0;
}

.unit-text {
  margin-left: 8px;
  color: var(--t-text-2);
  font-size: var(--t-fs-sm);
}

.empty-box {
  grid-column: 1 / -1;
  padding: var(--t-spacing-2xl) 0;
  text-align: center;
  color: var(--t-text-3);
  background: var(--t-surface);
  border-radius: var(--t-radius-card);
}

// 新建/编辑弹窗 footer 与全局 .dialog-footer 对齐
:deep(.el-dialog__footer) {
  display: flex;
  justify-content: flex-end;
  gap: var(--t-spacing-sm);
}
</style>
