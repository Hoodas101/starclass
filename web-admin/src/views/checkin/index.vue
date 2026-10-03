<template>
  <div class="page-shell">
    <!-- 顶部标题（hub 内嵌；embedded 时由 hub 提供，本页不重复） -->
<PageHeader v-if="!embedded" :title="`${$t('checkin')}管理`" />
    <!-- 顶部操作栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <el-date-picker
          v-model="selectedDate"
          type="date"
          placeholder="选择日期"
          format="YYYY-MM-DD"
          value-format="YYYY-MM-DD"
          style="width: 180px"
          @change="onDateChange"
        />
      </div>
      <div class="toolbar-right">
        <el-button :icon="Printer" :disabled="!selectedCourse" @click="printRoster">打印</el-button>
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出</el-button>
      </div>
    </div>

    <!-- 今日活动列表 -->
    <div class="today-courses">
      <h3 class="section-title">今日活动</h3>
      <div v-if="!loading && todayCourses.length === 0 && !error" class="no-courses-tip">
        <el-icon :size="18"><Calendar /></el-icon>
        <span>今日暂无{{ $t('course') }}安排，可在「排期管理」创建{{ $t('course') }}</span>
      </div>
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadTodayCourses" />
      <div class="course-cards">
        <div role="button" tabindex="0"
          v-for="course in todayCourses"
          :key="course.id"
          class="course-card"
          :class="{ active: selectedCourse?.id === course.id }"
          @click="selectCourse(course)" @keydown.enter="selectCourse(course)" @keydown.space.prevent="selectCourse(course)"
        >
          <div class="course-card-header">
            <span class="course-card-name">{{ course.name }}</span>
            <StatusDot
              :tone="course.status === 'ongoing' ? 'success' : course.status === 'upcoming' ? 'info' : 'neutral'"
              :label="course.statusText"
              subtle
            />
          </div>
          <div class="course-card-info">
            <el-icon><Clock /></el-icon>
            <span>{{ course.time }}</span>
          </div>
          <div class="course-card-info">
            <el-icon><User /></el-icon>
            <span>{{ course.teacher }}</span>
          </div>
          <div class="course-card-info">
            <el-icon><Location /></el-icon>
            <span>{{ course.classroom }}</span>
          </div>
          <div class="course-card-stats">
            <div class="stat">
              <span class="stat-num">{{ course.checkedIn }}</span>
              <span class="stat-label">已签到</span>
            </div>
            <div class="stat-divider"></div>
            <div class="stat">
              <span class="stat-num">{{ course.total }}</span>
              <span class="stat-label">总人数</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 签到确认区域 -->
    <div v-if="selectedCourse" class="checkin-area">
      <div class="checkin-header">
        <div>
          <h3 class="section-title">{{ selectedCourse.name }} - {{ $t('checkin') }}确认</h3>
          <p class="checkin-subtitle">
            {{ selectedCourse.time }} · {{ selectedCourse.classroom }} · {{ selectedCourse.teacher }}
          </p>
        </div>
        <div class="checkin-actions">
          <el-button :icon="UserFilled" @click="markAllPresent">一键全到</el-button>
          <el-button type="primary" :icon="Check" :loading="submitting" @click="confirmCheckin">确认到场</el-button>
        </div>
      </div>

      <!-- 成员头像网格 -->
      <div class="student-grid">
        <div
          v-for="student in courseStudents"
          :key="student.id"
          class="student-card"
          :class="student.status"
          role="button"
          tabindex="0"
          :aria-label="`${student.name}：${statusTextMap[student.status]}`"
          @click="toggleStudentStatus(student)"
          @keydown.enter.prevent="toggleStudentStatus(student)"
          @keydown.space.prevent="toggleStudentStatus(student)"
        >
          <div class="student-avatar-wrapper">
            <el-avatar :size="56" :src="student.avatar" :icon="UserFilled" />
            <div class="status-indicator">
              <el-icon v-if="student.status === 'present'" :size="12" color="var(--t-success)"><Check /></el-icon>
              <el-icon v-else-if="student.status === 'late'" :size="12" color="var(--t-warning)"><Clock /></el-icon>
              <el-icon v-else-if="student.status === 'absent'" :size="12" color="var(--t-danger)"><Close /></el-icon>
            </div>
          </div>
          <span class="student-name">{{ student.name }}</span>
          <span class="student-status-text">
            {{ statusTextMap[student.status] }}
          </span>
        </div>
      </div>

      <!-- 签到统计 -->
      <div class="checkin-stats">
        <div class="checkin-stat-card">
          <div class="checkin-stat-icon present">
            <el-icon><Check /></el-icon>
          </div>
          <div class="checkin-stat-info">
            <span class="checkin-stat-value">{{ presentCount }}</span>
            <span class="checkin-stat-label">到场</span>
          </div>
          <div class="checkin-stat-bar">
            <div class="bar-fill present" :style="{ width: presentRate + '%' }"></div>
          </div>
          <span class="checkin-stat-rate">{{ presentRate }}%</span>
        </div>

        <div class="checkin-stat-card">
          <div class="checkin-stat-icon late">
            <el-icon><Clock /></el-icon>
          </div>
          <div class="checkin-stat-info">
            <span class="checkin-stat-value">{{ lateCount }}</span>
            <span class="checkin-stat-label">迟到</span>
          </div>
          <div class="checkin-stat-bar">
            <div class="bar-fill late" :style="{ width: lateRate + '%' }"></div>
          </div>
          <span class="checkin-stat-rate">{{ lateRate }}%</span>
        </div>

        <div class="checkin-stat-card">
          <div class="checkin-stat-icon absent">
            <el-icon><Close /></el-icon>
          </div>
          <div class="checkin-stat-info">
            <span class="checkin-stat-value">{{ absentCount }}</span>
            <span class="checkin-stat-label">缺席</span>
          </div>
          <div class="checkin-stat-bar">
            <div class="bar-fill absent" :style="{ width: absentRate + '%' }"></div>
          </div>
          <span class="checkin-stat-rate">{{ absentRate }}%</span>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="empty-state">
      <el-empty :description="`请选择一门活动开始${$t('checkin')}确认`" />
    </div>
  </div>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      :title="`导出${$t('checkin')}数据`"
      description="选择时间范围后确认导出，未选择时默认导出选中日期。"
      default-shortcut="today"
      @confirm="doExport"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, computed, onMounted } from 'vue'
import dayjs from 'dayjs'
import { getSchedules, getScheduleDetail, checkinTeacher, getExport } from '@/api/modules'
import { Download, Printer, UserFilled, Check, Close, Calendar, Clock, Location, User } from '@element-plus/icons-vue'
import { exportXlsx } from '@/utils/xlsx'
import ExportDialog from '@/components/ExportDialog.vue'
import StatusDot from '@/components/StatusDot.vue'
import PageHeader from '@/components/PageHeader.vue'
import { useSettingsStore } from '@/store/settings'

// ============================================
// 数据
// ============================================
const selectedDate = ref(dayjs().format('YYYY-MM-DD'))
const selectedCourse = ref(null)

const statusTextMap = {
  pending: '待签到',
  present: '已签到',
  late: '迟到',
  absent: '缺席',
  leave: '请假'
}

const todayCourses = ref([])
const courseStudents = ref([])
const loading = ref(false)
const submitting = ref(false)
const exportDialogRef = ref(null)

const error = ref('')

// 机构名（打印表头用）：设置页写入 settings.org_info.name，全局 store 启动时已加载
const settingsStore = useSettingsStore()

// 切换日期：必须清空已选课程与名单，否则用户可能对上一个日期的排期误提交点名
const onDateChange = () => {
  if (selectedCourse.value) {
    selectedCourse.value = null
    courseStudents.value = []
    ElMessage.info('已切换日期，请重新选择课程')
  }
  loadTodayCourses()
}

const loadTodayCourses = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await getSchedules({
      startDate: selectedDate.value,
      endDate: selectedDate.value,
      pageSize: 50
    })
    const now = dayjs()
    todayCourses.value = (res.list || []).map((s) => {
      const start = dayjs(`${s.date}T${s.start_time}`)
      const end = dayjs(`${s.date}T${s.end_time}`)
      const isOngoing = now.isAfter(start) && now.isBefore(end)
      const isUpcoming = now.isBefore(start)
      return {
        id: s.id,
        name: s.course_name || '训练活动',
        time: `${s.start_time} - ${s.end_time}`,
        teacher: s.teacher_name || '待定',
        classroom: s.classroom_name || '待定',
        status: isOngoing ? 'ongoing' : isUpcoming ? 'upcoming' : 'finished',
        statusText: isOngoing ? '进行中' : isUpcoming ? '未开始' : '已结束',
        checkedIn: s.checked_in_count || 0,
        total: s.enrolled_count || 0
      }
    })
  } catch (e) {
    error.value = e?.message || '数据加载失败，请稍后重试'
    todayCourses.value = []
  } finally {
    loading.value = false
  }
}

const loadCourseStudents = async (course) => {
  try {
    const detail = await getScheduleDetail(course.id)
    const students = detail.students || []
    courseStudents.value = students.map((s) => ({
      id: s.student_id,
      name: s.student_name || '未知成员',
      avatar: '',
      status: s.checkin_status || 'pending'
    }))
  } catch (e) {
    courseStudents.value = []
  }
}

// ============================================
// 计算属性
// ============================================
const presentCount = computed(() => courseStudents.value.filter((s) => s.status === 'present').length)
const lateCount = computed(() => courseStudents.value.filter((s) => s.status === 'late').length)
const absentCount = computed(() => courseStudents.value.filter((s) => s.status === 'absent').length)
const totalCount = computed(() => courseStudents.value.length)

const presentRate = computed(() => (totalCount.value ? Math.round((presentCount.value / totalCount.value) * 100) : 0))
const lateRate = computed(() => (totalCount.value ? Math.round((lateCount.value / totalCount.value) * 100) : 0))
const absentRate = computed(() => (totalCount.value ? Math.round((absentCount.value / totalCount.value) * 100) : 0))

// ============================================
// 方法
// ============================================
const selectCourse = async (course) => {
  selectedCourse.value = course
  await loadCourseStudents(course)
}

const doExport = async (range) => {
  const [start, end] = range || [selectedDate.value || dayjs().format('YYYY-MM-DD'), selectedDate.value || dayjs().format('YYYY-MM-DD')]
  const sheets = []

  // 课表（范围内课程安排）
  try {
    const res = await getSchedules({ startDate: start, endDate: end, pageSize: 500 })
    const list = res?.list || []
    if (list.length) {
      sheets.push({
        name: '课程安排',
        headers: ['日期', '时间', '活动', '教师', '场地', '报名人数', '人数上限'],
        rows: list.map((s) => [
          s.date || '',
          `${s.start_time || ''}-${s.end_time || ''}`,
          s.course_name || '',
          s.teacher_name || '',
          s.classroom_name || '',
          s.enrolled_count || 0,
          s.max_students || ''
        ])
      })
    }
  } catch (e) { /* 忽略 */ }

  // 签到明细（范围内出勤记录）
  try {
    const res = await getExport({ type: 'checkin', startDate: start, endDate: end })
    const list = Array.isArray(res?.data) ? res.data : []
    if (list.length) {
      const statusText = { present: '已签到', late: '迟到', absent: '缺席', pending: '待签到' }
      sheets.push({
        name: '签到明细',
        headers: ['日期', '成员', '活动', '状态', '签到时间'],
        rows: list.map((a) => [
          a.date || '',
          a.student_name || '',
          a.course_name || '',
          statusText[a.status] || a.status || '',
          a.checkin_time ? dayjs(Number(a.checkin_time)).format('YYYY-MM-DD HH:mm') : ''
        ])
      })
    }
  } catch (e) { /* 忽略 */ }

  if (!sheets.length) {
    ElMessage.warning('所选时间段暂无课表或签到数据')
    return
  }
  exportXlsx(`签到管理_${start}_至_${end}`, sheets)
  ElMessage.success('导出成功')
}

// 切换成员签到状态（循环：待签到 → 已签到 → 迟到 → 请假 → 待签到）
const toggleStudentStatus = (student) => {
  const statusOrder = ['pending', 'present', 'late', 'absent']
  const currentIndex = statusOrder.indexOf(student.status)
  const nextIndex = (currentIndex + 1) % statusOrder.length
  student.status = statusOrder[nextIndex]
}

// 一键全到
const markAllPresent = () => {
  courseStudents.value.forEach((s) => {
    if (s.status === 'pending') {
      s.status = 'present'
    }
  })
  ElMessage.success('已标记全部成员为到场')
}

// 确认到场
const confirmCheckin = async () => {
  if (!selectedCourse.value || courseStudents.value.length === 0) {
    ElMessage.warning('请先选择活动')
    return
  }
  if (submitting.value) return
  // 未操作的成员（pending）提交时会按“已签到”保存，二次确认避免误提交
  const pendingCount = courseStudents.value.filter((s) => s.status === 'pending').length
  try {
    await ElMessageBox.confirm(
      pendingCount > 0
        ? `有 ${pendingCount} 名${$t('learner')}尚未操作，将按「已签到」保存。确认提交签到结果？`
        : '确认提交当前签到结果？',
      '确认签到',
      { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' }
    )
  } catch (e) {
    return
  }
  submitting.value = true
  try {
    const res = await checkinTeacher({
      scheduleId: selectedCourse.value.id,
      attendances: courseStudents.value.map((s) => ({
        studentId: s.id,
        status: s.status === 'pending' ? 'present' : s.status
      }))
    })
    // 后端对「暂停卡」等场景会逐条返回 warning（如未扣课未计积分）：去重后合并提示
    const warnings = [...new Set((res?.results || []).map((r) => r.warning).filter(Boolean))]
    if (warnings.length) {
      ElMessage.warning(`签到已保存。${warnings.join('；')}`)
    } else {
      ElMessage.success('签到已保存')
    }
    loadTodayCourses()
  } catch (e) {
    // 点名失败（如到店次数已达上限）由拦截器展示后端具体文案，此处不覆盖
  } finally {
    submitting.value = false
  }
}

// HTML 转义：打印窗口里拼接的学员姓名/课程名/教师名等均可能被用户录入，
// 不转义会被注入脚本（订单页有同类 escapeHtml，此处复制本地实现以避免跨文件耦合）
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]))

// 打印当前课程名单/签到表：新开窗口写入 HTML → 唤起打印，不强制关窗，
// 用户点「取消」后可再次打印（订单页的 setTimeout 强关窗口会导致预览消失且无法重试）
const printRoster = () => {
  if (!selectedCourse.value) {
    ElMessage.warning('请先选择课程')
    return
  }
  const orgName = settingsStore.settings?.org_info?.name || '训练机构'
  const course = selectedCourse.value
  const rows = courseStudents.value.map((s, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(statusTextMap[s.status] || s.status)}</td>
        <td class="sign"></td>
      </tr>`).join('')
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>${escapeHtml(course.name)} 签到表</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .org { font-size: 14px; color: #555; margin: 0 0 16px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 24px; font-size: 13px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #999; padding: 8px 10px; text-align: left; }
  th { background: #f2f2f2; }
  td.sign { width: 180px; }
  .foot { margin-top: 16px; font-size: 12px; color: #666; }
  .no-print { display: flex; gap: 8px; margin-bottom: 16px; }
  .no-print button { padding: 6px 16px; font-size: 13px; cursor: pointer; }
  @media print { body { margin: 12mm; } .no-print { display: none; } }
</style></head><body>
<div class="no-print">
  <button onclick="window.print()">打印</button>
  <button onclick="window.close()">关闭</button>
</div>
<h1>${escapeHtml(course.name)} · 签到表</h1>
<p class="org">${escapeHtml(orgName)}</p>
<div class="meta">
  <span>日期：${escapeHtml(selectedDate.value)}</span>
  <span>时间：${escapeHtml(course.time)}</span>
  <span>教师：${escapeHtml(course.teacher)}</span>
  <span>场地：${escapeHtml(course.classroom)}</span>
  <span>应到 ${courseStudents.value.length} 人</span>
</div>
<table>
  <thead><tr><th style="width:48px">序号</th><th>姓名</th><th style="width:120px">签到状态</th><th>签名</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4">暂无学员名单</td></tr>'}</tbody>
</table>
<p class="foot">打印时间：${new Date().toLocaleString('zh-CN')}</p>
</body></html>`

  const w = window.open('', '_blank')
  if (!w) {
    ElMessage.warning('浏览器拦截了打印窗口，请允许弹出窗口后重试')
    return
  }
  w.document.open()
  w.document.write(html)
  w.document.close()

  // 自动唤起一次打印；用标志位避免 load 与兜底定时器重复触发
  let printed = false
  const doPrint = () => {
    if (printed) return
    printed = true
    try { w.focus(); w.print() } catch (e) { /* 用户可手动点「打印」重试 */ }
  }
  if (w.document.readyState === 'complete') {
    setTimeout(doPrint, 200)
  } else {
    w.addEventListener('load', doPrint, { once: true })
    setTimeout(doPrint, 800)
  }
}

onMounted(loadTodayCourses)
</script>

<style lang="scss" scoped>
// 顶部操作栏
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--t-spacing-lg);
}

.page-title {
  font-size: var(--t-fs-2xl);
  font-weight: 700;
  color: var(--t-text-1);
  margin: 0;
}

.section-title {
  font-size: var(--t-fs-2xl);
  font-weight: 600;
  color: var(--t-text-1);
  margin: 0 0 16px;
}

// 今日活动
.today-courses {
  margin-bottom: var(--t-spacing-xl);
}

.course-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.course-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: var(--t-spacing-lg);
  cursor: pointer;
  transition: border-color var(--t-dur-fast) var(--t-ease-standard), background-color var(--t-dur-fast) var(--t-ease-standard);

  &:hover {
    border-color: var(--t-accent-line);
  }

  &.active {
    border-color: var(--t-accent-text);
    box-shadow: none;
  }
}

.course-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.course-card-name {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
}

.course-card-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
  margin-bottom: 6px;
}

.course-card-stats {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--t-line);

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;

    .stat-num {
      font-size: var(--t-fs-xl);
      font-weight: 700;
      color: var(--t-text-1);
    }

    .stat-label {
      font-size: var(--t-fs-xs);
      color: var(--t-text-2);
    }
  }

  .stat-divider {
    width: 1px;
    height: 32px;
    background: var(--t-surface-strong);
  }
}

// 签到确认区域
.checkin-area {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: 24px;
}

.checkin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--t-spacing-lg);
}

.checkin-subtitle {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
  margin: 4px 0 0;
}

.checkin-actions {
  display: flex;
  gap: 12px;
}

// 成员网格
.student-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: var(--t-spacing-md);
  margin-bottom: var(--t-spacing-xl);
}

.student-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 12px;
  border-radius: var(--t-radius-md);
  cursor: pointer;
  transition: transform var(--t-dur-base) var(--t-ease-standard), box-shadow var(--t-dur-base) var(--t-ease-standard), border-color var(--t-dur-base) var(--t-ease-standard), background-color var(--t-dur-base) var(--t-ease-standard);
  border: 2px solid transparent;

  &:hover {
    background: transparent;
  }

  &.present {
    background: color-mix(in srgb, var(--t-success) 6%, transparent);
    border-color: color-mix(in srgb, var(--t-success) 20%, transparent);
  }

  &.late {
    background: color-mix(in srgb, var(--t-warning) 6%, transparent);
    border-color: color-mix(in srgb, var(--t-warning) 20%, transparent);
  }

  &.absent {
    background: color-mix(in srgb, var(--t-danger) 6%, transparent);
    border-color: color-mix(in srgb, var(--t-danger) 20%, transparent);
  }
}

.student-avatar-wrapper {
  position: relative;
  margin-bottom: 8px;
}

.status-indicator {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--t-surface);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: none;
}

.student-name {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-text-1);
  margin-bottom: 2px;
}

.student-status-text {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

// 签到统计
.checkin-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--t-spacing-md);
  padding-top: var(--t-spacing-lg);
  border-top: 1px solid var(--t-line);
}

.checkin-stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: var(--t-spacing-md);
  background: transparent;
  border-radius: var(--t-radius-md);
}

.checkin-stat-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--t-radius-md);
  display: flex;
  align-items: center;
  justify-content: center;

  &.present {
    background: color-mix(in srgb, var(--t-success) 10%, transparent);
    color: var(--t-success-text);
  }

  &.late {
    background: color-mix(in srgb, var(--t-warning) 10%, transparent);
    color: var(--t-warning-text);
  }

  &.absent {
    background: color-mix(in srgb, var(--t-danger) 10%, transparent);
    color: var(--t-danger-text);
  }
}

.checkin-stat-info {
  display: flex;
  flex-direction: column;

  .checkin-stat-value {
    font-size: var(--t-fs-xl);
    font-weight: 700;
    color: var(--t-text-1);
  }

  .checkin-stat-label {
    font-size: var(--t-fs-xs);
    color: var(--t-text-2);
  }
}

.checkin-stat-bar {
  flex: 1;
  height: 6px;
  background: var(--t-surface-strong);
  border-radius: var(--t-radius-sm);
  overflow: hidden;

  .bar-fill {
    height: 100%;
    border-radius: var(--t-radius-sm);
    transition: width var(--t-dur-base) var(--t-ease-standard);

    &.present {
      background: var(--t-success);
    }

    &.late {
      background: var(--t-warning);
    }

    &.absent {
      background: var(--t-danger);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .bar-fill,
    .course-card,
    .student-card {
      transition: none;
    }
  }
}

.checkin-stat-rate {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
}

// 空状态
.empty-state {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: var(--t-spacing-2xl);
}

.no-courses-tip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 20px;
  margin-bottom: 16px;
  border: 1px dashed var(--t-line-strong);
  border-radius: var(--t-radius-card);
  background: var(--t-surface);
  color: var(--t-text-2);
  font-size: var(--t-fs-sm);
}

// 响应式
@media (max-width: 768px) {
  .checkin-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }

  .checkin-stats {
    grid-template-columns: 1fr;
  }

  .student-grid {
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  }
}
</style>
