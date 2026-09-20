<template>
  <div class="page-shell">
    <!-- 顶部标题 -->
<PageHeader v-if="!embedded" title="销售管理" />
    <!-- 顶部操作栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
                <el-radio-group v-model="filterStatus" size="default" @change="onFilterChange">
          <el-radio-button value="">全部</el-radio-button>
          <el-radio-button value="paid">已收款</el-radio-button>
          <el-radio-button value="pending">待支付</el-radio-button>
          <el-radio-button value="refunded">已退款</el-radio-button>
          <el-radio-button value="cancelled">已取消</el-radio-button>
        </el-radio-group>
      </div>
      <div class="toolbar-right">
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          format="YYYY-MM-DD"
          value-format="YYYY-MM-DD"
          style="width: 260px"
          @change="onFilterChange"
        />
        <el-button :icon="Upload" @click="openImport">导入</el-button>
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreateDialog">新建销售单</el-button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="order-stats">
      <div class="order-stat-card">
        <span class="order-stat-label">今日收入</span>
        <span class="order-stat-value v4-num-display is-md">¥{{ todayAmount.toLocaleString() }}</span>
      </div>
      <div class="order-stat-card">
        <span class="order-stat-label">本月营收</span>
        <span class="order-stat-value v4-num-display is-md">¥{{ monthAmount.toLocaleString() }}</span>
      </div>
      <div class="order-stat-card">
        <span class="order-stat-label">本年营收</span>
        <span class="order-stat-value v4-num-display is-md">¥{{ yearAmount.toLocaleString() }}</span>
      </div>
      <div class="order-stat-card">
        <span class="order-stat-label">销售单数</span>
        <span class="order-stat-value v4-num-display is-md">{{ totalOrders }}</span>
      </div>
    </div>

    <!-- 订单表格 -->
    <div class="card table-container">
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadOrders" />
      <el-table v-else
        :data="orders"
        v-loading="loading"
        size="small"
        @filter-change="onColumnFilter"
        @row-click="openOrderDetail"
        row-class-name="clickable-row"
      >
        <el-table-column
          v-for="col in visibleCols"
          :key="col.key"
          :label="col.label"
          :width="col.width"
          :min-width="col.minWidth"
          :align="col.align"
          :column-key="col.key"
          :filters="col.key === 'status' ? ORDER_STATUS_FILTERS : undefined"
          :show-overflow-tooltip="col.tooltip"
        >
          <template #default="{ row, $index }">
            <template v-if="col.key === 'seq'">{{ $index + 1 }}</template>

            <span v-else-if="col.key === 'orderNo'" class="order-no">{{ row.order_no }}</span>

            <div v-else-if="col.key === 'student'" class="order-student">
              <span class="student-name">{{ row.student_name }}</span>
            </div>

            <span v-else-if="col.key === 'phone'" class="order-phone">{{ row.parent_phone || '-' }}</span>

            <span v-else-if="col.key === 'item'" class="order-course">
              {{ row.item_name || row.order_type }}
              <el-tag v-if="row.is_1v1" size="small" type="warning" effect="light" class="one-v-one-tag">1v1</el-tag>
            </span>

            <span v-else-if="col.key === 'amount'" class="order-amount">¥{{ Number(row.payable_amount || 0).toLocaleString() }}</span>
            <template v-else-if="col.key === 'salesperson'">{{ row.salesperson || '-' }}</template>
            <template v-else-if="col.key === 'date'">{{ row.paid_at ? formatDate(row.paid_at) : formatDate(row.created_at) }}</template>

            <template v-else-if="col.key === 'status'">
              <StatusDot
                :tone="row.status === 'paid' && Number(row.refunded_amount) > 0 ? 'warning' : (statusDotTone[row.status] || 'neutral')"
                :label="row.status === 'paid' && Number(row.refunded_amount) > 0 ? `部分退款 ¥${Number(row.refunded_amount).toLocaleString()}` : (statusTextMap[row.status] || row.status)"
                subtle
              />
            </template>

            <template v-else-if="col.key === 'remark'">{{ row.remark || '-' }}</template>

            <!-- 自定义字段兜底：直接显示行数据 -->
              <template v-else>{{ row[col.key] ?? '-' }}</template>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="totalOrders"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @current-change="onPageChange"
          @size-change="onPageChange"
        />
      </div>
    </div>

    <!-- 新建销售单弹窗 -->
    <el-dialog
      v-model="createDialogVisible"
      title="新建销售单"
      class="dlg-lg"
      destroy-on-close
    >
      <el-form
        ref="createFormRef"
        :model="createForm"
        :rules="createRules"
        label-width="auto"
        label-position="left"
      >
        <el-form-item :label="t('learner')" prop="studentId">
          <el-select
            v-model="createForm.studentId"
            filterable
            placeholder="选择/搜索成员"
            style="width: 100%"
          >
            <el-option
              v-for="s in studentOptions"
              :key="s.id"
              :label="`${s.name}${s.parent_phone ? '（' + s.parent_phone + '）' : ''}`"
              :value="s.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="产品服务" prop="cardTypeId">
          <el-select v-model="createForm.cardTypeId" placeholder="选择产品" style="width: 100%">
            <el-option
              v-for="c in cardTypes"
              :key="c.id"
              :label="`${c.name}（${c.valid_days}天/${c.total_classes}次）¥${c.price}`"
              :value="c.id"
            />
          </el-select>
        </el-form-item>

          <el-form-item label="签单人">
            <el-select
              v-model="createForm.salesperson"
              filterable
              allow-create
              default-first-option
              clearable
              placeholder="选择员工或直接填写"
              style="width: 100%"
            >
              <el-option v-for="s in staffOptions" :key="s.id" :label="s.name" :value="s.name" />
            </el-select>
          </el-form-item>

        <el-form-item label="收款日期">
          <el-date-picker
            v-model="createForm.paidAt"
            type="date"
            placeholder="默认今天"
            format="YYYY-MM-DD"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>

        <el-form-item label="订单类型">
          <el-checkbox v-model="createForm.is1v1">1v1 一对一课程</el-checkbox>
        </el-form-item>

        <el-form-item label="收款状态">
          <el-radio-group v-model="createForm.status">
            <el-radio-button value="paid">已收款</el-radio-button>
            <el-radio-button value="pending">挂账/待支付</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="createForm.remark" type="textarea" :rows="2" placeholder="付款方式、优惠说明等" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">确认创建</el-button>
      </template>
    </el-dialog>

    <!-- 退款弹窗 -->
    <el-dialog
      v-model="refundDialogVisible"
      title="订单退款"
      class="dlg-md"
    >
      <div v-if="refundOrder" class="refund-info">
        <div class="refund-row">
          <span class="refund-label">{{ t('learner') }}</span>
          <span class="refund-value">{{ refundOrder.student_name }}</span>
        </div>
        <div class="refund-row">
          <span class="refund-label">订单金额</span>
          <span class="refund-value danger">¥{{ orderAmount.toLocaleString() }}</span>
        </div>
        <div class="refund-row">
          <span class="refund-label">已累计退款</span>
          <span class="refund-value">{{ Number(refundOrder.refunded_amount) > 0 ? '¥' + Number(refundOrder.refunded_amount).toLocaleString() : '无' }}</span>
        </div>
        <div class="refund-row">
          <span class="refund-label">单号</span>
          <span class="refund-value">{{ refundOrder.order_no }}</span>
        </div>

        <!-- 退费规则提示 -->
        <div v-if="refundPreview" class="refund-rule-box">
          <div class="refund-rule-status">
            <el-tag :type="refundPreview.started ? 'warning' : 'success'" size="small" effect="light">
              {{ refundPreview.started ? '已开课' : '未开课' }}
            </el-tag>
            <span v-if="refundPreview.cardInfo" class="refund-card-info">
              <template v-if="refundPreview.cardInfo.mode === 'count'">
                剩余 {{ refundPreview.cardInfo.remaining }}/{{ refundPreview.cardInfo.total }} 次
              </template>
              <template v-else>
                剩余有效期 {{ refundPreview.cardInfo.unusedRatio }}%
              </template>
            </span>
          </div>
          <div class="refund-rule-reason">{{ refundPreview.reason }}</div>
        </div>

        <div class="refund-row">
          <span class="refund-label">退款方式</span>
          <el-radio-group v-model="refundMode" size="small">
            <el-radio-button value="rule">按规则</el-radio-button>
            <el-radio-button value="full">全额</el-radio-button>
            <el-radio-button value="custom">自定义</el-radio-button>
          </el-radio-group>
        </div>
        <div v-if="refundMode === 'custom'" class="refund-row">
          <span class="refund-label">退款金额</span>
          <el-input-number v-model="refundAmount" :min="1" :max="refundRemain" :step="10" style="width: 160px" />
          <span class="refund-amount-text">最多 ¥{{ refundRemain.toLocaleString() }}</span>
        </div>
        <div class="refund-row refund-final">
          <span class="refund-label">本次退款</span>
          <span class="refund-value danger">¥{{ refundFinal.toLocaleString() }}</span>
        </div>
        <p v-if="refundPreview?.needApproval" class="refund-approval-hint">
          按退费规则，本次退款需管理员审批，预计 {{ refundPreview.processDays }} 个工作日内到账。
        </p>
      </div>
      <template #footer>
        <el-button @click="refundDialogVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="confirmRefund">确认退款 ¥{{ refundFinal.toLocaleString() }}</el-button>
      </template>
    </el-dialog>

    <!-- 订单详情抽屉 -->
    <el-drawer v-model="orderDetailVisible" :title="`订单详情 ${detailOrder?.order_no || ''}`" direction="rtl" size="var(--t-drawer-md)">
      <div v-if="detailOrder" class="order-detail">
        <div class="detail-grid">
          <div class="detail-item">
            <span class="detail-label">{{ t('learner') }}</span>
            <span class="detail-value">{{ detailOrder.student_name }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">联系方式</span>
            <span class="detail-value">{{ detailOrder.parent_phone || '-' }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">项目</span>
            <span class="detail-value">{{ detailOrder.item_name || detailOrder.order_type }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">收款日期</span>
            <span class="detail-value">{{ formatDate(detailOrder.paid_at || detailOrder.created_at) }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">状态</span>
            <span class="detail-value">{{ statusTextMap[detailOrder.status] || detailOrder.status }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">已退款</span>
            <span class="detail-value">¥{{ Number(detailOrder.refunded_amount || 0).toLocaleString() }}</span>
          </div>
        </div>

        <el-divider />
        <h4 class="detail-edit-title">修改订单</h4>
        <el-form label-width="auto" label-position="left">
          <el-form-item label="金额（元）">
            <el-input-number v-model="editAmount" :min="0" :max="999999" :step="10" controls-position="right" style="width: 180px" />
          </el-form-item>
          <el-form-item label="签单人">
            <el-select
              v-model="editSalesperson"
              filterable
              allow-create
              default-first-option
              clearable
              placeholder="选择员工或直接填写"
              style="width: 220px"
            >
              <el-option v-for="s in staffOptions" :key="s.id" :label="s.name" :value="s.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="editRemark" type="textarea" :rows="2" placeholder="订单备注" style="width: 280px" />
          </el-form-item>
        </el-form>
        <el-button type="primary" :loading="savingEdit" @click="saveDetailEdit">保存修改</el-button>

        <el-divider />
        <div class="detail-actions">
          <el-button :icon="Printer" @click="printReceipt">打印收据</el-button>
          <el-button v-if="detailOrder.status === 'paid'" type="danger" @click="openRefundDialog(detailOrder)">退款</el-button>
          <el-button
            v-if="detailOrder.status === 'paid'"
            type="danger"
            plain
            @click="handleCancelOrder(detailOrder)"
          >
            取消订单
          </el-button>
        </div>
      </div>
    </el-drawer>

    <!-- 字段设置（双栏拖拽管理器） -->
    <ColumnSettingsDialog
      ref="colDialogRef"
      title="销售字段设置"
      :columns="orderColumnDefs"
      v-model:settings="columnSettings"
      :defaults="DEFAULT_COLUMN_SETTINGS"
      @save="saveColumns"
      no-button
    />

    <!-- 批量导入销售记录 -->
    <ImportCsvDialog
      ref="importDialogRef"
      title="销售记录"
      :template-columns="importColumns"
      :import-fn="doImportOrders"
    />
  </div>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出销售记录"
      description="选择时间范围后确认导出；留空导出全部销售记录。"
      @confirm="doExport"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { Plus, Download, Printer, Upload } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import {
  getOrders,
  getOrderStats,
  addOrder,
  importOrders,
  refundOrder as refundOrderApi,
  refundPreview as refundPreviewApi,
  updateOrder,
  cancelOrder,
  payOrder,
  getStudents,
  getCardTypes,
  getSettings,
  saveSettings,
  getExport,
  getStaffOptions
} from '@/api/modules'
import { exportXlsx } from '@/utils/xlsx'
import { fetchAllPages } from '@/utils/fetchAll'
import ColumnSettingsDialog from '@/components/ColumnSettingsDialog.vue'
import ImportCsvDialog from '@/components/ImportCsvDialog.vue'
import StatusDot from '@/components/StatusDot.vue'
import PageHeader from '@/components/PageHeader.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import { useSettingsStore } from '@/store/settings'

// 收据打印为 window.open 隔离文档，app 的 CSS 变量不生效；此处采用 --t-danger-text 真值 #C92A2A，避免游离 hex 与设计漂移
const RECEIPT_AMOUNT_COLOR = '#C92A2A'

const settingsStore = useSettingsStore()
const userStore = useUserStore()
const t = settingsStore.t

const route = useRoute()
const router = useRouter()

// 列表状态同步到 URL（借鉴 trycompai/crm 的 URL state）
const syncUrl = () => {
  const query = {}
  if (filterStatus.value) query.status = filterStatus.value
  if (dateRange.value && dateRange.value.length === 2) {
    query.start = dateRange.value[0]
    query.end = dateRange.value[1]
  }
  if (currentPage.value > 1) query.page = String(currentPage.value)
  router.replace({ query })
}

const onPageChange = () => {
  syncUrl()
  loadOrders()
}

const onFilterChange = () => {
  currentPage.value = 1
  syncUrl()
  loadOrders()
}

// 列头筛选（类似 Excel）：联动顶部状态筛选与后端查询
const onColumnFilter = (filters) => {
  const values = filters.status
  if (!values) return
  const val = values.length ? values[0] : ''
  if (filterStatus.value !== val) {
    filterStatus.value = val
    onFilterChange()
  }
}

// 批量导入销售记录
const importDialogRef = ref(null)
const importColumns = [
  { key: 'studentName', label: t('learner') + '姓名', required: true },
  { key: 'phone', label: '联系方式' },
  { key: 'itemName', label: '项目', required: true },
  { key: 'amount', label: '金额', required: true },
  { key: 'salesperson', label: '签单人' },
  { key: 'paidDate', label: '购买日期' },
  { key: 'orderNo', label: '收据单号' },
  { key: 'remark', label: '备注' },
]

const openImport = () => {
  importDialogRef.value?.open()
}

const doImportOrders = async (rows) => {
  const res = await importOrders({ rows })
  if (res.success > 0) loadOrders()
  return {
    success: res.success || 0,
    failed: (res.failed || []).map((f) => `第 ${f.row} 行：${f.reason}`),
  }
}

const filterStatus = ref('')
const dateRange = ref(null)
const exportDialogRef = ref(null)
const currentPage = ref(1)
const pageSize = ref(10)
const totalOrders = ref(0)
const loading = ref(false)
const submitting = ref(false)

const todayAmount = ref(0)
const monthAmount = ref(0)
const yearAmount = ref(0)

const orderColumnDefs = [
  { key: 'seq', label: '序号', minWidth: 54, align: 'center' },
  { key: 'orderNo', label: '收据单号', minWidth: 150, tooltip: true },
  { key: 'student', label: t('learner'), minWidth: 100 },
  { key: 'phone', label: '联系方式', minWidth: 116, tooltip: true },
  { key: 'item', label: '项目', minWidth: 120, tooltip: true },
  { key: 'amount', label: '购买金额', minWidth: 100, align: 'right' },
  { key: 'salesperson', label: '签单人', minWidth: 86, align: 'center' },
  { key: 'date', label: '收款日期', minWidth: 100 },
  { key: 'status', label: '状态', minWidth: 80, align: 'center' },
  { key: 'remark', label: '备注', minWidth: 100, tooltip: true },
]
const DEFAULT_COLUMN_SETTINGS = {
  seq: true, orderNo: true, student: true, phone: true, item: true, amount: true,
  salesperson: true, date: true, status: true, remark: true,
}
const columnSettings = ref({ ...DEFAULT_COLUMN_SETTINGS })
const colDialogRef = ref(null)

// 按用户设置的顺序渲染列
const visibleCols = computed(() => {
  const order = Array.isArray(columnSettings.value.order) ? columnSettings.value.order : []
  const all = orderColumnDefs.filter((c) => columnSettings.value[c.key] !== false)
  // 自定义字段（用户可添加/删除/隐藏）
  const customs = (columnSettings.value.customFields || [])
    .filter((k) => columnSettings.value[k] !== false)
    .map((k) => ({ key: k, label: k, custom: true, minWidth: 100, tooltip: true }))
  const merged = [...all, ...customs]
  const ordered = order.map((k) => merged.find((c) => c.key === k)).filter(Boolean)
  const rest = merged.filter((c) => !order.includes(c.key))
  return [...ordered, ...rest]
})

const saveColumns = async (settings) => {
  columnSettings.value = settings
  try {
    await saveSettings({ orders_columns: settings })
    ElMessage.success('字段设置已保存')
  } catch (e) {
    console.error('[导出]', e)
  }
}

const loadColumnSettings = async () => {
  try {
    const data = await getSettings()
    if (data?.orders_columns) {
      columnSettings.value = { ...DEFAULT_COLUMN_SETTINGS, ...data.orders_columns }
    }
  } catch (e) {
    // 使用默认值
  }
}

const statusTypeMap = {
  paid: 'success',
  pending: 'warning',
  refunded: 'info'
}

const ORDER_STATUS_FILTERS = [
  { text: '已收款', value: 'paid' },
  { text: '待支付', value: 'pending' },
  { text: '已退款', value: 'refunded' },
  { text: '已取消', value: 'cancelled' },
]

const statusDotTone = {
  paid: 'success',
  pending: 'warning',
  refunded: 'neutral',
  cancelled: 'danger',
}

const statusTextMap = {
  paid: '已收款',
  pending: '待支付',
  refunded: '已退款',
  cancelled: '已取消'
}

const orders = ref([])

const formatDate = (v) => {
  if (!v) return '-'
  const n = Number(v)
  if (Number.isNaN(n)) return String(v)
  return dayjs(n).format('YYYY-MM-DD')
}

const error = ref('')
// 请求序号：防止慢网下旧分页/筛选响应后到覆盖新结果
let loadSeq = 0

const loadOrders = async () => {
  error.value = ''
  loading.value = true
  const seq = ++loadSeq
  try {
    const params = {
      page: currentPage.value,
      pageSize: pageSize.value
    }
    if (filterStatus.value) params.status = filterStatus.value
    if (dateRange.value && dateRange.value.length === 2) {
      params.startDate = dateRange.value[0]
      params.endDate = dateRange.value[1]
    }
    const res = await getOrders(params)
    if (seq !== loadSeq) return
    orders.value = res.list || []
    totalOrders.value = res.total || 0
    // 营收统计改为后端汇总接口（覆盖全量订单，净额已扣除退款），解决“只看当前分页 10 行”少算问题
    getOrderStats().then((s) => {
      if (seq !== loadSeq) return
      todayAmount.value = s.today || 0
      monthAmount.value = s.month || 0
      yearAmount.value = s.year || 0
    }).catch(() => {})
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e?.message || '数据加载失败，请稍后重试'
    orders.value = []
    totalOrders.value = 0
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

// 新建销售单
const createDialogVisible = ref(false)
const createFormRef = ref(null)
const studentOptions = ref([])
const cardTypes = ref([])
const staffOptions = ref([])

const createForm = reactive({
  studentId: '',
  cardTypeId: '',
  salesperson: '',
  paidAt: '',
  is1v1: false,
  status: 'paid',
  remark: ''
})

const createRules = {
  studentId: [{ required: true, message: `请选择${t('learner')}`, trigger: 'change' }],
  cardTypeId: [{ required: true, message: '请选择产品', trigger: 'change' }]
}

const openCreateDialog = async () => {
  Object.assign(createForm, {
    studentId: '',
    cardTypeId: '',
    salesperson: '',
    paidAt: dayjs().format('YYYY-MM-DD'),
    is1v1: false,
    status: 'paid',
    remark: ''
  })
  try {
    const [stuRes, cardRes] = await Promise.all([getStudents({ page: 1, pageSize: 100 }), getCardTypes()])
    studentOptions.value = stuRes.list || []
    cardTypes.value = (cardRes.list || []).filter((c) => c.is_active !== 0)
  } catch (e) {
    // 拦截器已提示
  }
  createDialogVisible.value = true
}

const submitCreate = async () => {
  if (!createFormRef.value) return
  const valid = await createFormRef.value.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    await addOrder({
      studentId: createForm.studentId,
      cardTypeId: createForm.cardTypeId,
      salesperson: createForm.salesperson,
      remark: createForm.remark,
      is1v1: createForm.is1v1 ? 1 : 0,
      status: createForm.status,
      paidAt: createForm.paidAt ? dayjs(createForm.paidAt).valueOf() : undefined
    })
    ElMessage.success(createForm.status === 'paid'
      ? `销售单已创建，${t('membership')}已激活`
      : '销售单已创建（挂账，待收款）')
    createDialogVisible.value = false
    loadOrders()
  } catch (e) {
    // 拦截器已提示
  } finally {
    submitting.value = false
  }
}

// 退款
const refundDialogVisible = ref(false)
const refundOrder = ref(null)
const refundMode = ref('rule')
const refundAmount = ref(0)
const refundPreview = ref(null)

const openRefundDialog = async (order) => {
  refundOrder.value = order
  refundMode.value = 'rule'
  refundAmount.value = 0
  refundPreview.value = null
  refundDialogVisible.value = true
  try {
    const preview = await refundPreviewApi(order.id)
    refundPreview.value = preview
    // 默认按规则推荐金额；自定义金额默认填入可退余额
    refundAmount.value = preview.remain
    // 若规则推荐为全额，模式标记为 full；否则 rule
    if (preview.mode === 'full') refundMode.value = 'full'
    else refundMode.value = 'rule'
  } catch (e) {
    // 预览失败时降级为全额
    refundMode.value = 'full'
  }
}

const orderAmount = computed(() => Number(refundOrder.value?.payable_amount || 0))
const refundRemain = computed(() => {
  const soFar = Number(refundOrder.value?.refunded_amount) || 0
  return Math.max(0, orderAmount.value - soFar)
})
const ruleAmount = computed(() => Number(refundPreview.value?.amount) || 0)
const refundFinal = computed(() => {
  if (refundMode.value === 'full') return refundRemain.value
  if (refundMode.value === 'custom') return Math.max(0, Math.min(refundRemain.value, Number(refundAmount.value) || 0))
  // rule
  return Math.max(0, Math.min(refundRemain.value, ruleAmount.value))
})

const confirmRefund = async () => {
  if (refundFinal.value <= 0) {
    ElMessage.warning('退款金额必须大于 0')
    return
  }
  // 后端约定：退款金额偏离退费规则建议值超过 ¥1 时必须显式携带 confirmOverride，
  // 否则一律拒绝。此前前端从不发送该字段 —— 于是「自定义金额」退款必然被拒，
  // 形成「UI 有入口、点了就报错」的功能死锁。这里改为：偏离即先向用户确认，再带标记提交。
  const suggested = Number(refundPreview.value?.amount) || 0
  const deviate = suggested > 0 && Math.abs(refundFinal.value - suggested) > 1
  if (deviate) {
    try {
      await ElMessageBox.confirm(
        `按退费规则建议应退 ¥${suggested.toLocaleString()}（${
          refundPreview.value?.reason || '规则建议值'
        }），本次将退 ¥${refundFinal.value.toLocaleString()}。\n\n按规则外金额退款视为协商让利，不会回收卡内剩余权益，确认继续？`,
        '偏离退费规则',
        {
          type: 'warning',
          confirmButtonText: '仍按此金额退款',
          cancelButtonText: '返回修改',
        }
      )
    } catch (e) {
      return // 用户取消，不提交
    }
  }
  submitting.value = true
  try {
    const reasonMap = {
      rule: refundPreview.value?.reason || '按退费规则退款',
      full: '全额退款',
      custom: '自定义金额退款',
    }
    const res = await refundOrderApi(refundOrder.value.id, {
      reason: reasonMap[refundMode.value],
      refundAmount: refundFinal.value,
      ...(deviate ? { confirmOverride: true } : {}),
    })
    const clawbackTip = res.clawback ? `，${res.clawback}` : ''
    ElMessage.success(`${res.full ? '全额退款' : '部分退款'}成功${clawbackTip}`)
    refundDialogVisible.value = false
    if (orderDetailVisible.value) loadOrders()
    loadOrders()
  } catch (e) {
    // 拦截器已提示
  } finally {
    submitting.value = false
  }
}

// 订单详情（点击行进入）
const orderDetailVisible = ref(false)
const detailOrder = ref(null)
const editAmount = ref(0)
const editSalesperson = ref('')
const editRemark = ref('')
const savingEdit = ref(false)

const openOrderDetail = (order) => {
  detailOrder.value = order
  editAmount.value = Number(order.payable_amount || 0)
  editSalesperson.value = order.salesperson || ''
  editRemark.value = order.remark || ''
  orderDetailVisible.value = true
}

const saveDetailEdit = async () => {
  if (!detailOrder.value) return
  savingEdit.value = true
  try {
    await updateOrder(detailOrder.value.id, {
      payableAmount: editAmount.value,
      salesperson: editSalesperson.value,
      remark: editRemark.value,
    })
    ElMessage.success('订单已更新')
    orderDetailVisible.value = false
    loadOrders()
  } catch (e) {
    // 拦截器已提示
  } finally {
    savingEdit.value = false
  }
}

const handleCancelOrder = async (order) => {
  try {
    await ElMessageBox.confirm(
      `确定取消订单「${order.order_no}」？已发放的${t('membership')}与积分将回收。`,
      '取消订单',
      { type: 'warning', confirmButtonText: '确认取消', confirmButtonClass: 'el-button--danger' }
    )
    await cancelOrder(order.id)
    ElMessage.success('订单已取消')
    orderDetailVisible.value = false
    loadOrders()
  } catch (e) {
    // 用户主动取消（ElMessageBox 取消按钮 reject 值为 'cancel'）静默处理
    if (e === 'cancel') return
    // 真实 API / 网络错误：拦截器已统一提示
  }
}

// 确认收款：将 pending 订单标记为已收款（仅管理员；后端 POST /:id/pay 也强制 isAdminReq）
const confirmingPay = ref(false)
const handleConfirmPayment = async (order) => {
  try {
    await ElMessageBox.confirm(
      `确认收到订单「${order.order_no}」的款项，并将其标记为已收款？`,
      '确认收款',
      { type: 'warning', confirmButtonText: '确认收款', confirmButtonClass: 'el-button--success' }
    )
    confirmingPay.value = true
    await payOrder(order.id)
    ElMessage.success('已确认收款，订单状态更新为已收款')
    orderDetailVisible.value = false
    loadOrders()
  } catch (e) {
    // 用户主动取消（ElMessageBox 取消按钮 reject 值为 'cancel'）静默处理
    if (e === 'cancel') return
    // 真实 API / 网络错误：拦截器已提示业务/网络错误，无需重复弹 toast
  } finally {
    confirmingPay.value = false
  }
}

// HTML 转义：收据字段（会员名/项目/备注/签单人等）由销售/教练录入，直接拼入 HTML 有 XSS 风险
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  )

// 打印收据（单张订单，直接调用浏览器打印）
const printReceipt = () => {
  const o = detailOrder.value
  if (!o) return
  const w = window.open('', '_blank', 'width=420,height=640')
  if (!w) return
  const money = Number(o.payable_amount || 0).toLocaleString()
  const date = formatDate(o.paid_at || o.created_at)
  const statusText = statusTextMap[o.status] || o.status
  const row = (label, value) => `<tr><td>${label}</td><td>${escapeHtml(value)}</td></tr>`
  w.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>收款收据</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; padding: 32px; color: #111; max-width: 360px; margin: 0 auto; }
  h1 { font-size: 22px; text-align: center; margin: 0 0 4px; }
  .org { text-align: center; font-size: 12px; color: #666; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 8px 4px; border-bottom: 1px dashed #ddd; }
  td:first-child { color: #666; width: 84px; }
  .amount { font-size: 18px; font-weight: 700; color: ${RECEIPT_AMOUNT_COLOR}; }
  .footer { margin-top: 24px; text-align: center; font-size: 11px; color: #999; }
</style></head><body>
  <h1>收款收据</h1>
  <div class="org">${t('course')}收款凭证</div>
  <table>
    ${row('收据单号', o.order_no || '-')}
    ${row(t('learner'), o.student_name || '-')}
    ${row('项目', o.item_name || o.order_type || '-')}
    ${row('金额', '¥' + money)}
    ${row('收款日期', date)}
    ${row('签单人', o.salesperson || '-')}
    ${row('状态', statusText)}
    ${row('备注', o.remark || '-')}
  </table>
  <div class="footer">本收据由教务系统自动生成</div>
  <script>window.onload=function(){window.print();setTimeout(function(){window.close()},300)}<\/script>
</body></html>`)
  w.document.close()
}

// 导出
const doExport = async (range) => {
  const headers = ['序号', '收据单号', t('learner'), '联系方式', '项目', '金额', '签单人', '状态', '下单时间', '备注']
  const mapRow = (o, i) => [
    i + 1,
    o.order_no,
    o.student_name,
    o.parent_phone || '',
    parseItems(o.items),
    o.payable_amount != null ? Number(o.payable_amount) : '',
    o.salesperson || '',
    statusTextMap[o.status] || o.status,
    formatDate(o.created_at),
    o.remark || ''
  ]
  let rows = []
  // 管理员走后端全量导出；销售等角色无权限时回退到当前列表
  try {
    const params = { type: 'orders' }
    if (range && range.length === 2) {
      params.startDate = range[0]
      params.endDate = range[1]
    }
    const res = await getExport(params)
    const data = Array.isArray(res?.data) ? res.data : []
    rows = data.map(mapRow)
  } catch (e) {
    const params = {}
    if (filterStatus.value) params.status = filterStatus.value
    if (range && range.length === 2) {
      params.startDate = range[0]
      params.endDate = range[1]
    }
    const list = await fetchAllPages(getOrders, params)
    rows = list.map(mapRow)
  }
  if (!rows.length) {
    ElMessage.warning('暂无可导出的销售记录')
    return
  }
  exportXlsx(`销售记录_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '销售记录' })
  ElMessage.success(`已导出 ${rows.length} 条销售记录`)
}

const parseItems = (itemsJson) => {
  try {
    return JSON.parse(itemsJson || '[]').map((i) => i.itemName || '').filter(Boolean).join('、')
  } catch (e) {
    return ''
  }
}

onMounted(() => {
  // 从 URL 恢复列表状态
  const q = route.query
  if (q.status) filterStatus.value = String(q.status)
  if (q.start && q.end) dateRange.value = [String(q.start), String(q.end)]
  if (q.page) currentPage.value = Number(q.page) || 1
  loadOrders()
  loadColumnSettings()
  loadStaffOptions()
})

const loadStaffOptions = async () => {
  try {
    const res = await getStaffOptions()
    staffOptions.value = res.list || []
  } catch (e) {
    staffOptions.value = []
  }
}
</script>

<style lang="scss" scoped>
.order-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: var(--t-spacing-lg);
}

.order-stat-card {
  background: var(--t-surface);
  border-radius: var(--t-radius-card);
  padding: 24px;  display: flex;
  flex-direction: column;
  gap: 8px;

  .order-stat-label {
    font-size: var(--t-fs-sm);
    color: var(--t-text-2);
  }

  .order-stat-value {
    font-size: var(--v4-fs-5xl);
    font-weight: 700;
    color: var(--t-text-1);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    letter-spacing: -0.025em;

    &.warning {
      color: var(--t-danger-text);
    }
  }
}

.table-container {
  background: var(--t-surface);
  border-radius: var(--t-radius-card);
  padding: 24px;
  overflow-x: auto;
}

.order-phone {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;
}

.order-no {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

.column-tip {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
  margin: 0 0 16px;
}

.column-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px 8px;
}

.column-item {
  padding: 8px 10px;
  border-radius: var(--t-radius-card);
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  font-size: var(--t-fs-sm);
  color: var(--t-text-1);
}

.order-student {
  display: flex;
  align-items: center;
  gap: 10px;

  > div {
    display: flex;
    flex-direction: column;
  }

  .student-name {
    font-size: var(--t-fs-base);
    font-weight: 600;
    color: var(--t-text-1);
  }

  .student-phone {
    font-size: var(--t-fs-xs);
    color: var(--t-text-2);
  }
}

.order-amount {
  font-weight: 600;
  color: var(--t-text-1);
}

.refund-info {
  .refund-row {
    display: flex;
    justify-content: space-between;
    padding: 10px 0;
    border-bottom: 1px solid var(--t-line);

    &:last-child {
      border-bottom: none;
    }
  }

  .refund-label {
    color: var(--t-text-2);
    font-size: var(--t-fs-sm);
  }

  .refund-value {
    font-weight: 500;
    color: var(--t-text-1);

    &.danger {
      color: var(--t-danger-text);
      font-weight: 700;
    }
  }
}

.refund-row.refund-final {
  border-top: 1px dashed var(--t-line);
  margin-top: 4px;
}

.refund-amount-text {
  font-size: var(--t-fs-sm);
  color: var(--t-accent-text);
  margin-left: 8px;
}

.refund-rule-box {
  background: var(--t-accent-bg);
  border: 1px solid var(--t-accent-line);
  border-radius: $radius-md;
  padding: 12px 14px;
  margin: 12px 0;
}

.refund-rule-status {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.refund-card-info {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

.refund-rule-reason {
  font-size: var(--t-fs-sm);
  color: var(--t-text-1);
  line-height: 1.5;
}

.refund-approval-hint {
  margin: 10px 0 0;
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  line-height: 1.5;
}

.order-detail {
  .detail-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .detail-item {
    background: var(--t-surface-hover);
    border: 1px solid var(--t-line);
    border-radius: var(--t-radius-card);
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
    word-break: break-all;
  }

  .detail-edit-title {
    font-size: var(--t-fs-base);
    font-weight: 600;
    color: var(--t-text-1);
    margin: 0 0 10px;
  }

  .detail-actions {
    display: flex;
    gap: 10px;
    margin-top: 4px;
  }
}


:deep(.el-dialog__footer) {
  display: flex;
  justify-content: flex-end;
  gap: var(--t-spacing-sm);
}

@media (max-width: 900px) {
  .order-stats {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
