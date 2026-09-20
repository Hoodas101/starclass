<template>
  <div class="page-shell">
    <!-- 顶部标题（hub 内嵌；embedded 时由 hub 提供，本页不重复） -->
<PageHeader v-if="!embedded" title="排期管理" />
    <!-- 顶部操作栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
                <el-radio-group v-model="viewMode" size="default" @change="loadSchedules">
          <el-radio-button value="day">日视图</el-radio-button>
          <el-radio-button value="week">周视图</el-radio-button>
          <el-radio-button value="month">月视图</el-radio-button>
          <el-radio-button value="list">列表</el-radio-button>
        </el-radio-group>
      </div>
      <div class="toolbar-right">
        <el-select v-model="filterTeacher" placeholder="全部教师" clearable style="width: 140px" @change="loadSchedules">
          <el-option v-for="t in teachers" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
        <el-select v-model="filterClassroom" placeholder="全部场地" clearable style="width: 140px" @change="loadSchedules">
          <el-option v-for="c in classrooms" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出</el-button>
        <el-button type="primary" :icon="Plus" @click="openScheduleDialog()">
          新建排期
        </el-button>
      </div>
    </div>

    <!-- 时间网格视图（日 / 周）—— 支持拖拽改期 -->
    <div v-if="viewMode === 'week' || viewMode === 'day'" class="week-view" :style="{ '--hour-h': HOUR_H + 'px' }">
      <div class="week-nav">
        <el-button text aria-label="上一周期" @click="prevPeriod">
          <el-icon><ArrowLeft /></el-icon>
        </el-button>
        <span class="week-range">{{ navLabel }}</span>
        <el-button text aria-label="下一周期" @click="nextPeriod">
          <el-icon><ArrowRight /></el-icon>
        </el-button>
        <el-button text @click="goToday">今天</el-button>
        <div class="range-control">
          <el-select v-model="rangeStart" size="small" style="width: 88px" @change="applyRange">
            <el-option v-for="h in rangeOptions" :key="h" :label="`${h}:00`" :value="h" :disabled="h >= rangeEnd" />
          </el-select>
          <span class="range-sep">至</span>
          <el-select v-model="rangeEnd" size="small" style="width: 88px" @change="applyRange">
            <el-option v-for="h in rangeOptions" :key="h" :label="`${h}:00`" :value="h" :disabled="h <= rangeStart" />
          </el-select>
        </div>
        <span v-if="loading" class="loading-hint">拖拽课块可改时间/日期，点击可编辑</span>
      </div>

      <div class="calendar-grid">
        <div class="grid-header">
          <div class="time-header"></div>
          <div
            v-for="day in timeGridDays"
            :key="day.date"
            class="day-header"
            :class="{ today: day.isToday }"
          >
            <span class="day-name">{{ day.name }}</span>
            <span class="day-date">{{ day.dateNum }}</span>
          </div>
        </div>

        <div class="grid-body">
          <div class="time-column">
            <div v-for="hour in timeSlots" :key="hour" class="time-slot-label">
              {{ hour }}:00
            </div>
          </div>
          <div class="day-columns">
            <div
              v-for="day in timeGridDays"
              :key="day.date"
              class="day-column"
              :class="{ 'drag-over': dragOverDate === day.date }"
              @dragover.prevent="onDragOver(day.date)"
              @drop="onDrop($event, day.date)"
            >
              <div class="day-grid">
                <div v-for="hour in timeSlots" :key="hour" class="hour-cell"></div>
              </div>
              <div role="button" tabindex="0"
                v-for="course in dayCourses(day.date)"
                :key="course.id"
                class="course-block"
                :class="{ compact: courseMinutes(course) < 60, dragging: dragState && dragState.id === course.id }"
                :style="courseStyle(course, dayCourses(day.date))"
                draggable="true"
                @dragstart="onDragStart($event, course)"
                @dragend="onDragEnd"
                @click="openEditDialog(course)" @keydown.enter="openEditDialog(course)" @keydown.space.prevent="openEditDialog(course)"
              >
                <span class="course-name" :style="{ color: courseTextColor(course.color) }">
                  {{ course.course_name }}
                </span>
                <span v-if="courseMinutes(course) >= 60" class="course-teacher">
                  <el-icon class="meta-icon"><User /></el-icon>{{ course.teacher_name || '待定' }}
                </span>
                <span class="course-time">
                  <el-icon class="meta-icon"><Clock /></el-icon>{{ course.start_time }}-{{ course.end_time }}
                </span>
                <span v-if="courseMinutes(course) >= 60" class="course-count">
                  <el-icon class="meta-icon"><UserFilled /></el-icon>{{ course.enrolled_count || 0 }} / {{ course.max_students || '-' }} 人
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 月视图 —— 点击某天跳转到日视图 -->
    <div v-else-if="viewMode === 'month'" class="month-view">
      <div class="week-nav">
        <el-button text aria-label="上一周期" @click="prevPeriod">
          <el-icon><ArrowLeft /></el-icon>
        </el-button>
        <span class="week-range">{{ navLabel }}</span>
        <el-button text aria-label="下一周期" @click="nextPeriod">
          <el-icon><ArrowRight /></el-icon>
        </el-button>
        <el-button text @click="goToday">今天</el-button>
        <span v-if="loading" class="loading-hint">加载中…</span>
      </div>

      <div class="month-grid">
        <div class="month-weekday-row">
          <div v-for="w in monthWeekdays" :key="w" class="month-weekday">{{ w }}</div>
        </div>
        <div v-for="(week, wi) in monthCells" :key="wi" class="month-week">
          <div role="button" tabindex="0"
            v-for="cell in week"
            :key="cell.date"
            class="month-cell"
            :class="{ 'out-month': !cell.inMonth, today: cell.isToday }"
            @click="openDayFromMonth(cell)" @keydown.enter="openDayFromMonth(cell)" @keydown.space.prevent="openDayFromMonth(cell)"
          >
            <div class="month-cell-head">
              <span class="month-date">{{ cell.dateNum }}</span>
              <span v-if="dayCourses(cell.date).length" class="month-count">{{ dayCourses(cell.date).length }}</span>
            </div>
            <div class="month-events">
              <div
                v-for="ev in dayCourses(cell.date).slice(0, 3)"
                :key="ev.id"
                class="month-event"
                :style="{ background: ev.color + '18', borderLeft: '3px solid ' + ev.color }"
                :title="ev.course_name + ' ' + ev.start_time + '-' + ev.end_time"
              >
                <span class="month-event-name">{{ ev.course_name }}</span>
                <span class="month-event-time">{{ ev.start_time }}</span>
              </div>
              <div v-if="dayCourses(cell.date).length > 3" class="month-more">+{{ dayCourses(cell.date).length - 3 }} 更多</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 列表视图 -->
    <div v-else-if="viewMode === 'list'" class="list-view">
      <div class="card table-container">
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadSchedules" />
      <el-table v-else
        :data="schedules"
        v-loading="loading"
        size="small"
        @row-click="openEditDialog"
        row-class-name="clickable-row">
        <el-table-column prop="date" label="日期" min-width="100"  />
        <el-table-column label="活动名称" min-width="140"  show-overflow-tooltip>
          <template #default="{ row }">
            <span class="course-dot" :style="{ background: row.color || classFallback() }"></span>
            {{ row.course_name }}
          </template>
        </el-table-column>
        <el-table-column label="授课教师" min-width="120" >
          <template #default="{ row }">
            <span class="teacher-cell">
              <EntityAvatar :name="row.teacher_name || '待定'" size="xs" tone="info" />
              {{ row.teacher_name || '待定' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="场地" min-width="100" >
          <template #default="{ row }">{{ row.classroom_name || '待定' }}</template>
        </el-table-column>
        <el-table-column label="训练时间" min-width="140" >
          <template #default="{ row }">{{ row.start_time }}-{{ row.end_time }}</template>
        </el-table-column>
        <el-table-column label="人数" min-width="100" >
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.enrolled_count || 0 }} / {{ row.max_students || '-' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="重复" min-width="80" >
          <template #default="{ row }">
            <el-tag v-if="row.is_recursive" size="small" type="warning" effect="light">周期</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">单次</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" min-width="90" >
          <template #default="{ row }">
            <StatusDot :tone="row.status === 'scheduled' ? 'success' : 'neutral'" :label="row.status === 'scheduled' ? '进行中' : '已结束'" subtle />
          </template>
        </el-table-column>
      </el-table>

        <div class="pagination-wrap">
          <el-pagination
            v-model:current-page="currentPage"
            v-model:page-size="pageSize"
            :total="totalSchedules"
            layout="total, prev, pager, next"
            background
            @current-change="loadSchedules"
            @size-change="loadSchedules"
          />
        </div>
      </div>
    </div>

    <!-- 新建/编辑排期弹窗 -->
    <el-dialog
      v-model="scheduleDialogVisible"
      :title="editingId ? '编辑排期' : '新建排期'"
      class="dlg-lg"
      destroy-on-close
    >
      <el-form
        ref="scheduleFormRef"
        :model="scheduleForm"
        :rules="scheduleRules"
        label-width="auto"
        label-position="left"
      >
        <el-form-item label="活动名称" prop="courseId">
          <el-select v-model="scheduleForm.courseId" placeholder="选择活动" style="width: 100%">
            <el-option v-for="c in courses" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>

        <el-form-item label="目标分组">
          <el-select v-model="scheduleForm.groupCourseId" clearable placeholder="全体（不限制）" style="width: 100%">
            <el-option v-for="c in courses" :key="c.id" :label="'仅限「' + c.name + '」成员报名'" :value="c.id" />
          </el-select>
          <div v-if="scheduleForm.groupCourseId" class="group-hint">选择后仅该班成员可报名，防止跨班/乱报名</div>
        </el-form-item>

        <el-form-item label="授课教师" prop="teacherId">
          <el-select v-model="scheduleForm.teacherId" placeholder="选择教师" clearable style="width: 100%">
            <el-option v-for="t in teachers" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
        </el-form-item>

        <el-form-item label="场地" prop="classroomId">
          <el-select v-model="scheduleForm.classroomId" placeholder="选择场地" clearable style="width: 100%">
            <el-option v-for="c in classrooms" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>

        <el-form-item label="训练日期" prop="date">
          <el-date-picker
            v-model="scheduleForm.date"
            type="date"
            placeholder="选择日期"
            format="YYYY-MM-DD"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>

        <el-form-item label="时间段" prop="timeRange">
          <el-time-picker
            v-model="scheduleForm.timeRange"
            is-range
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            format="HH:mm"
            value-format="HH:mm"
            style="width: 100%"
          />
        </el-form-item>

        <template v-if="!editingId">
          <el-form-item label="重复规则" prop="repeat">
            <el-select v-model="scheduleForm.repeat" placeholder="不重复" style="width: 100%">
              <el-option label="不重复" value="none" />
              <el-option label="每天" value="daily" />
              <el-option label="每周（选择星期）" value="weekly" />
              <el-option label="按天数间隔" value="custom" />
            </el-select>
          </el-form-item>

          <el-form-item v-if="scheduleForm.repeat === 'weekly'" label="重复星期" prop="weekDays">
            <el-checkbox-group v-model="scheduleForm.weekDays">
              <el-checkbox v-for="d in weekOptions" :key="d.value" :label="d.value" :value="d.value">
                {{ d.label }}
              </el-checkbox>
            </el-checkbox-group>
          </el-form-item>

          <el-form-item v-if="scheduleForm.repeat === 'custom'" label="间隔天数" prop="intervalDays">
            <el-input-number v-model="scheduleForm.intervalDays" :min="1" :max="90" />
            <span class="form-hint">从开始日期起，每隔 N 天排一次</span>
          </el-form-item>

          <el-form-item v-if="scheduleForm.repeat !== 'none'" label="结束日期" prop="endDate">
            <el-date-picker
              v-model="scheduleForm.endDate"
              type="date"
              placeholder="重复到哪一天"
              format="YYYY-MM-DD"
              value-format="YYYY-MM-DD"
              :disabled-date="(d) => d < new Date(scheduleForm.date + 'T00:00:00')"
              style="width: 100%"
            />
          </el-form-item>
        </template>

        <el-form-item label="人数上限">
          <el-input-number v-model="scheduleForm.maxStudents" :min="0" :max="200" />
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="scheduleForm.remark" type="textarea" :rows="2" placeholder="选填" />
        </el-form-item>
      </el-form>

      <template #footer>
        <div class="dlg-footer">
          <el-button
            v-if="isAdmin"
            type="danger"
            plain
            :disabled="!editingId"
            @click="deleteCurrentSchedule"
          >取消排期</el-button>
          <span class="dlg-footer-right">
            <el-button @click="scheduleDialogVisible = false">取消</el-button>
            <el-button type="primary" :loading="submitting" @click="submitSchedule">确认排期</el-button>
          </span>
        </div>
      </template>
    </el-dialog>
  </div>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出排期数据"
      description="选择时间范围后确认导出，未选择时默认导出当前周。"
      @confirm="doExport"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import dayjs from 'dayjs'
import { Plus, ArrowLeft, ArrowRight, Download, User, Clock, UserFilled } from '@element-plus/icons-vue'
import {
  getTeachers,
  getClassrooms,
  getCourses,
  getSchedules,
  addSchedule,
  addRecursiveSchedule,
  updateSchedule,
  deleteSchedule,
  checkScheduleConflict,
} from '@/api/modules'
import { exportXlsx } from '@/utils/xlsx'
import { fetchAllPages } from '@/utils/fetchAll'
import ExportDialog from '@/components/ExportDialog.vue'
import EntityAvatar from '@/components/EntityAvatar.vue'
import StatusDot from '@/components/StatusDot.vue'
import PageHeader from '@/components/PageHeader.vue'
import { usePerm } from '@/composables/usePerm'
import { classFallback, teacherColors, courseTextColor } from '@/utils/theme-colors'
import { themeTick } from '@/utils/theme'

// 主题切换时重取行配色（加载时固化进数据，需随主题刷新）
watch(themeTick, () => {
  schedules.value = schedules.value.map((s) => ({
    ...s,
    color: teacherColor(s.teacher_id, courseColor(s.course_id)),
  }))
})

// 取消排期仅管理员可用（后端 DELETE /schedules/:id 仅管理员可调用）
const isAdmin = computed(() => usePerm().role.value === 'admin')

const viewMode = ref('week')
const filterTeacher = ref('')
const filterClassroom = ref('')
const exportDialogRef = ref(null)
const loading = ref(false)
const submitting = ref(false)

// ============================================
// 基础资源
// ============================================
const teachers = ref([])
const classrooms = ref([])
const courses = ref([])

const loadResources = async () => {
  try {
    const [tRes, cRes, courseRes] = await Promise.all([
      getTeachers(),
      getClassrooms(),
      getCourses()
    ])
    teachers.value = tRes.list || []
    classrooms.value = cRes.list || []
    courses.value = courseRes.list || []
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

// ============================================
// 时间网格视图（日 / 周）
// ============================================
// 周从周一开始（dayjs 默认周日为周首，需手动换算）
const startOfWeek = (d) => {
  const offset = (d.day() + 6) % 7
  return d.subtract(offset, 'day').startOf('day')
}
// 统一锚点日期：日 / 周 / 月视图都基于它推算可见区间
const anchorDate = ref(dayjs())
const weekStart = computed(() => startOfWeek(anchorDate.value))
const schedules = ref([])

const weekDays = computed(() => {
  const days = []
  const weekNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  for (let i = 0; i < 7; i++) {
    const date = weekStart.value.add(i, 'day')
    days.push({
      date: date.format('YYYY-MM-DD'),
      name: weekNames[i],
      dateNum: date.format('MM/DD'),
      isToday: date.isSame(dayjs(), 'day')
    })
  }
  return days
})

// 日视图只渲染单日；周视图渲染整周 7 列
const timeGridDays = computed(() => {
  if (viewMode.value === 'day') {
    const d = anchorDate.value
    const wn = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.day()]
    return [{
      date: d.format('YYYY-MM-DD'),
      name: wn,
      dateNum: d.format('MM/DD'),
      isToday: d.isSame(dayjs(), 'day')
    }]
  }
  return weekDays.value
})

// 导航标签随视图切换
const navLabel = computed(() => {
  if (viewMode.value === 'day') {
    const d = anchorDate.value
    const wn = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.day()]
    return `${d.format('MM月DD日')} ${wn}`
  }
  if (viewMode.value === 'month') return anchorDate.value.format('YYYY年MM月')
  return `${weekStart.value.format('MM月DD日')} - ${weekStart.value.add(6, 'day').format('MM月DD日')}`
})

// 周视图：自定义时间范围（持久化）
const rangeOptions = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
const savedRange = (() => {
  try {
    const r = JSON.parse(localStorage.getItem('edu_schedule_range') || 'null')
    if (r && rangeOptions.includes(r.start) && rangeOptions.includes(r.end) && r.end > r.start) return r
  } catch (e) { /* 忽略 */ }
  return { start: 8, end: 21 }
})()
const rangeStart = ref(savedRange.start)
const rangeEnd = ref(savedRange.end)

const applyRange = () => {
  if (rangeEnd.value <= rangeStart.value) rangeEnd.value = rangeStart.value + 1
  localStorage.setItem('edu_schedule_range', JSON.stringify({ start: rangeStart.value, end: rangeEnd.value }))
}

const timeSlots = computed(() => {
  const arr = []
  for (let h = rangeStart.value; h < rangeEnd.value; h++) arr.push(h)
  return arr
})

// 行高自动调整：默认 13 小时约 44px；范围变大行高变小（下限保证 1 小时卡片文字完整），范围变小行高变大
const HOUR_H = computed(() => Math.round(Math.min(104, Math.max(88, 1232 / (rangeEnd.value - rangeStart.value)))))
const DAY_START_HOUR = computed(() => rangeStart.value)

// 按教练稳定映射配色；无教练时回退课程色（主题感知：暗色下用提亮色板）
const teacherColor = (teacherId, fallback) => {
  const palette = teacherColors()
  if (!teacherId) return fallback || classFallback()
  let h = 0
  for (const ch of String(teacherId)) h = (h * 31 + ch.charCodeAt(0)) % 997
  return palette[h % palette.length]
}

const courseColor = (courseId) => {
  return courses.value.find((c) => c.id === courseId)?.color || classFallback()
}

// 课程文字色为共享工具（主题感知：亮色压暗 / 暗色提亮），render 期间调用自动随主题切换更新

const error = ref('')

const loadSchedules = async () => {
  error.value = ''
  loading.value = true
  try {
    const params = {}
    // 周/月视图按当前区间查询并完整展示（禁用分页）；
    // 列表视图不限定范围，按分页展示全部排期，避免“只能看本周”而无法查阅历史/未来排期
    if (viewMode.value === 'week') {
      params.startDate = weekStart.value.format('YYYY-MM-DD')
      params.endDate = weekStart.value.add(6, 'day').format('YYYY-MM-DD')
      params.page = 1
      params.pageSize = 500
    } else if (viewMode.value === 'month') {
      params.startDate = anchorDate.value.startOf('month').format('YYYY-MM-DD')
      params.endDate = anchorDate.value.endOf('month').format('YYYY-MM-DD')
      params.page = 1
      params.pageSize = 500
    } else {
      params.page = currentPage.value
      params.pageSize = pageSize.value
    }
    if (filterTeacher.value) params.teacherId = filterTeacher.value
    if (filterClassroom.value) params.classroomId = filterClassroom.value

    const res = await getSchedules(params)
    schedules.value = (res.list || []).map((s) => ({
      ...s,
      color: teacherColor(s.teacher_id, courseColor(s.course_id))
    }))
    totalSchedules.value = res.total || 0
  } catch (e) {
    error.value = e?.message || '数据加载失败，请稍后重试'
    schedules.value = []
    totalSchedules.value = 0
  } finally {
    loading.value = false
  }
}

// 上/下一段：日视图 ±1 天，月视图 ±1 月，周视图 ±7 天
const stepDir = (dir) => {
  if (viewMode.value === 'day') anchorDate.value = anchorDate.value.add(dir, 'day')
  else if (viewMode.value === 'month') anchorDate.value = anchorDate.value.add(dir, 'month')
  else anchorDate.value = anchorDate.value.add(dir * 7, 'day')
  loadSchedules()
}
const prevPeriod = () => stepDir(-1)
const nextPeriod = () => stepDir(1)

const goToday = () => {
  anchorDate.value = dayjs()
  loadSchedules()
}

const dayCourses = (date) => schedules.value.filter((s) => s.date === date)

// 按开始时间精确垂直定位：top 与 height 均由分钟换算
const toMinutes = (t) => {
  if (!t) return 0
  const [h, m] = t.split(':').map(Number)
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

const courseMinutes = (course) =>
  toMinutes(course.end_time) - toMinutes(course.start_time)

const courseStyle = (course, siblings) => {
  const start = toMinutes(course.start_time)
  const end = toMinutes(course.end_time)
  const top = (start - DAY_START_HOUR.value * 60) * (HOUR_H.value / 60) + 1
  const height = Math.max(24, (end - start) * (HOUR_H.value / 60) - 2)
  const color = course.color || classFallback()
  const base = {
    top: `${top}px`,
    height: `${height}px`,
    background: color + '18',
    borderLeft: `3px solid ${color}`,
  }
  // 同一时段多课程：自动并排，避免互相遮挡
  const overlaps = (a, b) =>
    a.id !== b.id &&
    toMinutes(a.start_time) < toMinutes(b.end_time) &&
    toMinutes(b.start_time) < toMinutes(a.end_time)
  const group = (siblings || []).filter((s) => overlaps(course, s) || s.id === course.id)
    .sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time) || (a.id < b.id ? -1 : 1))
  if (group.length <= 1) {
    return { ...base, left: '6px', right: '6px' }
  }
  const seg = 100 / group.length
  const idx = group.findIndex((g) => g.id === course.id)
  return {
    ...base,
    left: `calc(${idx * seg}% + 4px)`,
    width: `calc(${seg}% - 8px)`,
  }
}

// ============================================
// 拖拽改期（日 / 周时间网格）
// ============================================
const dragState = ref(null)
const dragOverDate = ref('')

const onDragStart = (e, course) => {
  const start = toMinutes(course.start_time)
  dragState.value = { id: course.id, durationMin: Math.max(15, toMinutes(course.end_time) - start) }
  e.dataTransfer.effectAllowed = 'move'
  try { e.dataTransfer.setData('text/plain', String(course.id)) } catch (_) { /* 部分浏览器不支持 */ }
}
const onDragEnd = () => { dragState.value = null; dragOverDate.value = '' }
const onDragOver = (date) => { dragOverDate.value = date }

const minutesToTime = (min) => {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// 拖到某天的网格列：按落点 Y 位置换算新开始时间（15 分钟吸附），保持时长不变
const onDrop = async (e, targetDate) => {
  const state = dragState.value
  dragOverDate.value = ''
  if (!state) return
  e.preventDefault()
  try {
    const rect = e.currentTarget.getBoundingClientRect()
    const offsetY = e.clientY - rect.top
    const snap = 15
    let minutes = DAY_START_HOUR.value * 60 + (offsetY / HOUR_H.value) * 60
    minutes = Math.round(minutes / snap) * snap
    minutes = Math.max(DAY_START_HOUR.value * 60, Math.min(rangeEnd.value * 60 - state.durationMin, minutes))
    const startT = minutesToTime(minutes)
    const endT = minutesToTime(minutes + state.durationMin)
    const course = schedules.value.find((s) => s.id === state.id)
    const unchanged = course && course.date === targetDate && course.start_time === startT && course.end_time === endT
    if (unchanged) { dragState.value = null; return }
    loading.value = true
    await updateSchedule(state.id, { date: targetDate, startTime: startT, endTime: endT })
    ElMessage.success('排期时间已更新')
    await loadSchedules()
  } catch (err) {
    // 错误信息已由拦截器统一提示
  } finally {
    loading.value = false
    dragState.value = null
  }
}

// ============================================
// 月视图
// ============================================
const monthWeekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const monthCells = computed(() => {
  const gridStart = startOfWeek(anchorDate.value.startOf('month'))
  const weeks = []
  for (let w = 0; w < 6; w++) {
    const row = []
    for (let d = 0; d < 7; d++) {
      const dt = gridStart.add(w * 7 + d, 'day')
      row.push({
        date: dt.format('YYYY-MM-DD'),
        dateNum: dt.format('D'),
        inMonth: dt.month() === anchorDate.value.month(),
        isToday: dt.isSame(dayjs(), 'day')
      })
    }
    weeks.push(row)
  }
  return weeks
})

const openDayFromMonth = (cell) => {
  anchorDate.value = dayjs(cell.date)
  viewMode.value = 'day'
  loadSchedules()
}

// ============================================
// 列表视图
// ============================================
const currentPage = ref(1)
const pageSize = ref(20)
const totalSchedules = ref(0)

// ============================================
// 新建 / 编辑排期
// ============================================
const scheduleDialogVisible = ref(false)
const scheduleFormRef = ref(null)
const editingId = ref('')

const weekOptions = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 0 }
]

const defaultForm = () => ({
  courseId: '',
  groupCourseId: '',
  teacherId: '',
  classroomId: '',
  date: dayjs().format('YYYY-MM-DD'),
  timeRange: [dayjs('09:00', 'HH:mm'), dayjs('10:30', 'HH:mm')],
  repeat: 'none',
  weekDays: [1, 3, 5],
  intervalDays: 2,
  endDate: '',
  maxStudents: 20,
  remark: ''
})

const scheduleForm = reactive(defaultForm())

const scheduleRules = {
  courseId: [{ required: true, message: '请选择活动', trigger: 'change' }],
  date: [{ required: true, message: '请选择日期', trigger: 'change' }],
  timeRange: [{ required: true, message: '请选择时间段', trigger: 'change' }],
  endDate: [{ required: true, message: '请选择结束日期', trigger: 'change' }]
}

const openScheduleDialog = () => {
  editingId.value = ''
  Object.assign(scheduleForm, defaultForm())
  scheduleDialogVisible.value = true
}

const openEditDialog = async (row) => {
  editingId.value = row.id
  Object.assign(scheduleForm, {
    courseId: row.course_id || '',
    groupCourseId: row.group_course_id || '',
    teacherId: row.teacher_id || '',
    classroomId: row.classroom_id || '',
    date: row.date || dayjs().format('YYYY-MM-DD'),
    timeRange: [dayjs(row.start_time || '09:00', 'HH:mm'), dayjs(row.end_time || '10:30', 'HH:mm')],
    repeat: 'none',
    weekDays: [1, 3, 5],
    intervalDays: 2,
    endDate: '',
    maxStudents: row.max_students || 20,
    remark: row.remark || ''
  })
  // 活动已被停用/归档时，下拉选项里没有该活动，编辑时会显示原始 ID：
  // 拉取含停用的全量活动列表并合并进选项，保证回显正常且保存不丢数据
  if (row.course_id && !courses.value.some((c) => c.id === row.course_id)) {
    try {
      const all = await getCourses({ includeInactive: '1' })
      const missed = (all.list || []).filter((c) => !courses.value.some((x) => x.id === c.id))
      if (missed.length) courses.value = courses.value.concat(missed)
    } catch (e) {
      // 拉取失败时保持现状，保存仍会携带原始 courseId
    }
  }
  scheduleDialogVisible.value = true
}

const submitSchedule = async () => {
  if (!scheduleFormRef.value) return
  const valid = await scheduleFormRef.value.validate().catch(() => false)
  if (!valid) return

  const payload = {
    courseId: scheduleForm.courseId,
    // 显式传空串表示“清除”，后端据此更新；未传字段才保持原值
    teacherId: scheduleForm.teacherId,
    classroomId: scheduleForm.classroomId,
    date: scheduleForm.date,
    startTime: scheduleForm.timeRange[0].format('HH:mm'),
    endTime: scheduleForm.timeRange[1].format('HH:mm'),
    maxStudents: scheduleForm.maxStudents,
    remark: scheduleForm.remark,
    groupCourseId: scheduleForm.groupCourseId,
    groupName: scheduleForm.groupCourseId
      ? (courses.value.find((c) => c.id === scheduleForm.groupCourseId)?.name || '')
      : ''
  }

  // 提交前冲突检测（教师 / 场地 / 学员）：命中后由用户确认，带 confirmOverride 重试放行。
  // 该接口后端限定管理员（isAdminReq），教练端跳过预检，仍由创建/修改接口兜底拦截。
  if (isAdmin.value) {
    try {
      const conflict = await checkScheduleConflict({
        teacherId: payload.teacherId,
        classroomId: payload.classroomId,
        date: payload.date,
        startTime: payload.startTime,
        endTime: payload.endTime,
        groupCourseId: payload.groupCourseId,
        excludeId: editingId.value || undefined
      })
      if (conflict?.conflict) {
        await ElMessageBox.confirm(conflict.message, '排期冲突', {
          type: 'warning',
          confirmButtonText: '仍然保存',
          cancelButtonText: '返回修改'
        })
        payload.confirmOverride = true
      }
    } catch (e) {
      // 用户取消确认（'cancel'/'close'）→ 终止提交；其余异常（网络等）继续提交，由后端兜底
      if (e === 'cancel' || e === 'close') return
    }
  }

  submitting.value = true
  try {
    if (editingId.value) {
      await updateSchedule(editingId.value, payload)
      ElMessage.success('排期已更新')
    } else if (scheduleForm.repeat === 'none') {
      await addSchedule(payload)
      ElMessage.success('排期创建成功')
    } else {
      const res = await addRecursiveSchedule({
        ...payload,
        repeatType: scheduleForm.repeat,
        weekDays: scheduleForm.weekDays,
        intervalDays: scheduleForm.intervalDays,
        startDate: scheduleForm.date,
        endDate: scheduleForm.endDate
      })
      ElMessage.success(`已生成 ${res.count || 0} 次排期`)
    }

    scheduleDialogVisible.value = false
    loadSchedules()
  } catch (e) {
    // 错误信息已由拦截器提示
  } finally {
    submitting.value = false
  }
}

// 取消/删除排期（仅管理员；带二次确认 + 家长通知提醒）
const deleteCurrentSchedule = async () => {
  if (!editingId.value) return
  const name = courses.value.find((c) => c.id === scheduleForm.courseId)?.name || '该排期'
  try {
    await ElMessageBox.confirm(
      `确定取消排期「${name}」？已报名家长将收到取消通知，且不可恢复。`,
      '取消排期',
      { type: 'warning', confirmButtonText: '确认取消', confirmButtonClass: 'el-button--danger' }
    )
  } catch (e) {
    return
  }
  submitting.value = true
  try {
    await deleteSchedule(editingId.value)
    ElMessage.success('排期已取消')
    scheduleDialogVisible.value = false
    loadSchedules()
  } catch (e) {
    // 拦截器已提示
  } finally {
    submitting.value = false
  }
}

const doExport = async (range) => {
  const headers = ['日期', '活动', '教师', '场地', '开始时间', '结束时间', '已报人数', '人数上限', '重复', '状态']
  // 优先使用自定义导出范围，未选择时默认导出当前可见区间（日/月/周）
  let defaultStart, defaultEnd
  if (viewMode.value === 'day') {
    defaultStart = anchorDate.value.format('YYYY-MM-DD')
    defaultEnd = anchorDate.value.format('YYYY-MM-DD')
  } else if (viewMode.value === 'month') {
    defaultStart = anchorDate.value.startOf('month').format('YYYY-MM-DD')
    defaultEnd = anchorDate.value.endOf('month').format('YYYY-MM-DD')
  } else {
    defaultStart = weekStart.value.format('YYYY-MM-DD')
    defaultEnd = weekStart.value.add(6, 'day').format('YYYY-MM-DD')
  }
  const params = range && range.length === 2
    ? { startDate: range[0], endDate: range[1] }
    : { startDate: defaultStart, endDate: defaultEnd }
  if (filterTeacher.value) params.teacherId = filterTeacher.value
  if (filterClassroom.value) params.classroomId = filterClassroom.value
  let list = []
  try {
    list = await fetchAllPages(getSchedules, params)
  } catch (e) {
    list = schedules.value
  }
  const rows = list.map((s) => [
    s.date,
    s.course_name || '',
    s.teacher_name || '',
    s.classroom_name || '',
    s.start_time,
    s.end_time,
    s.enrolled_count || 0,
    s.max_students || '',
    s.is_recursive ? '周期' : '单次',
    s.status === 'scheduled' ? '进行中' : s.status
  ])
  if (!rows.length) {
    ElMessage.warning('暂无可导出的排期数据')
    return
  }
  exportXlsx(`排期表_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '排期表' })
  ElMessage.success(`已导出 ${rows.length} 条排期`)
}

onMounted(() => {
  loadResources()
  loadSchedules()
})

onBeforeUnmount(() => {})
</script>

<style lang="scss" scoped>
.teacher-cell {
  display: inline-flex;
  align-items: center;
  gap: var(--t-spacing-sm);
}

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
  gap: var(--t-spacing-md);
}

.page-title {
  font-size: var(--t-fs-2xl);
  font-weight: 700;
  color: var(--t-text-1);
  margin: 0;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--t-spacing-sm);
  flex-wrap: wrap;
}

.week-view {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: 24px;
}

.week-nav {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: var(--t-spacing-lg);
  padding-bottom: var(--t-spacing-md);
  border-bottom: 1px solid var(--t-line);
}

.week-range {
  font-size: var(--t-fs-lg);
  font-weight: 600;
  color: var(--t-text-1);
  min-width: 0;
}

.range-control {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.range-sep {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.loading-hint {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

.calendar-grid {
  overflow-x: auto;
}

.grid-header {
  display: flex;
  border-bottom: 1px solid var(--t-line);
  padding-bottom: 8px;
}

.time-header {
  width: 60px;
  flex-shrink: 0;
}

.day-header {
  flex: 1;
  text-align: center;
  min-width: 100px;
  padding: 2px 4px;

  .day-name {
    display: block;
    font-size: var(--t-fs-2xs);
    color: var(--t-text-2);
    font-weight: 500;
  }

  .day-date {
    display: block;
    font-size: var(--t-fs-base);
    font-weight: 700;
    color: var(--t-text-1);
    margin-top: 0;
  }

  &.today {
    .day-date {
      color: var(--t-text-1);
      position: relative;
      padding-bottom: 6px;

      &::after {
        content: '';
        position: absolute;
        left: 50%;
        bottom: 0;
        transform: translateX(-50%);
        width: 16px;
        height: 3px;
        border-radius: var(--t-radius-sm);
        background: var(--t-accent);
      }
    }
  }
}

.grid-body {
  display: flex;
  border-bottom: 1px solid var(--t-line);
  padding-top: 4px;
}

.time-column {
  width: 60px;
  flex-shrink: 0;
}

.time-slot-label {
  height: var(--hour-h, 44px);
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding-right: 12px;
  font-size: var(--t-fs-2xs);
  color: var(--t-text-2);
  padding-top: 2px;
}

.day-columns {
  flex: 1;
  display: flex;
}

.day-column {
  flex: 1;
  border-left: 1px solid var(--t-line);
  position: relative;
}

.day-grid {
  position: absolute;
  inset: 0;
}

.hour-cell {
  height: var(--hour-h, 44px);
  position: relative;
  border-top: 1px solid var(--t-line);
}

.course-block {
  position: absolute;
  left: 6px;
  right: 6px;
  border-radius: var(--t-radius-md);
  padding: 6px 10px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
  transition: box-shadow 0.16s ease;

  &:hover {
    box-shadow: var(--t-card-shadow-hover);
    z-index: 2;
  }
}

// 短课（<60 分钟）：标题 + 时间横向排布，保证小卡片内文字完整
.course-block.compact {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 0 10px;

  .course-name {
    flex: 1;
    min-width: 0;
  }

  .course-time {
    flex-shrink: 0;
    line-height: 1.2;
  }
}

.course-name {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta-icon {
  vertical-align: -1px;
  margin-right: 3px;
  font-size: 11px;
  opacity: 0.7;
}

.course-teacher {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.course-time {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.course-count {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.course-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 8px;
}

.form-hint {
  margin-left: 12px;
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

.group-hint {
  margin-top: 6px;
  font-size: var(--t-fs-xs);
  color: var(--t-accent-text);
  background: var(--t-accent-bg);
  border-radius: var(--t-radius-md);
  padding: 6px 10px;
  line-height: 1.5;
}

// 新建/编辑弹窗 footer 与全局 .dialog-footer 对齐
:deep(.el-dialog__footer) {
  display: flex;
  justify-content: flex-end;
  gap: var(--t-spacing-sm);
}

.dlg-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: var(--t-spacing-sm);
}

.dlg-footer-right {
  display: flex;
  gap: var(--t-spacing-sm);
}

// 拖拽改期时的视觉反馈
.course-block.dragging {
  opacity: 0.4;
}

.day-column.drag-over {
  background: var(--t-accent-bg);
  box-shadow: inset 0 0 0 2px var(--t-accent);
}

// 月视图
.month-view {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: 24px;
}

.month-grid {
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
  overflow: hidden;
}

.month-weekday-row {
  display: flex;
  background: var(--t-surface-hover);
  border-bottom: 1px solid var(--t-line);
}

.month-weekday {
  flex: 1;
  text-align: center;
  font-size: var(--t-fs-2xs);
  color: var(--t-text-2);
  padding: 8px 0;
  font-weight: 500;
}

.month-week {
  display: flex;
  border-bottom: 1px solid var(--t-line);
  min-height: 104px;
}

.month-week:last-child {
  border-bottom: none;
}

.month-cell {
  flex: 1;
  border-left: 1px solid var(--t-line);
  padding: 6px 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: background 0.15s ease;
}

.month-cell:first-child {
  border-left: none;
}

.month-cell:hover {
  background: var(--t-surface-hover);
}

.month-cell.out-month {
  background: var(--t-surface-hover);
}

.month-cell.out-month .month-date {
  color: var(--t-text-3);
}

.month-cell.today .month-date {
  color: #fff;
  background: var(--t-accent);
  border-radius: 50%;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.month-cell-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.month-date {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-text-1);
}

.month-count {
  font-size: var(--t-fs-2xs);
  color: var(--t-accent-text);
  background: var(--t-accent-bg);
  border-radius: 9999px;
  padding: 0 6px;
  font-weight: 600;
}

.month-events {
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
}

.month-event {
  border-radius: var(--t-radius-sm);
  padding: 2px 6px;
  font-size: 11px;
  line-height: 1.3;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}

.month-event-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
  color: var(--t-text-1);
}

.month-event-time {
  flex-shrink: 0;
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;
}

.month-more {
  font-size: 11px;
  color: var(--t-text-2);
  padding-left: 2px;
}
</style>
