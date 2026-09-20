<template>
  <div class="page-shell">
    <PageHeader v-if="!embedded" title="产品管理" />
    <!-- 单一工具栏：二级下拉切换产品类型，避免双 tab 栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <el-select v-model="activeMode" style="width: 200px">
          <el-option :label="`上课 / ${$t('course')} / ${$t('membership')}服务`" value="membership" />
          <el-option label="其他商品 / 周边" value="goods" />
        </el-select>
      </div>
      <div class="toolbar-right">
        <el-button v-if="activeMode === 'membership'" type="primary" :icon="Plus" @click="openCardDialog()">新增{{ $t('membership') }}</el-button>
        <el-button v-else type="primary" :icon="Plus" @click="openGoodsDialog()">新增商品</el-button>
      </div>
    </div>

    <!-- 会员卡 / 课程服务 -->
    <template v-if="activeMode === 'membership'">
      <div class="section-head">
        <div>
          <h3 class="section-title">{{ $t('membership') }}产品</h3>
          <p class="section-desc">时效制与次数制（1v1/按次），价格与权益修改后即时同步到小程序</p>
        </div>
      </div>
      <div class="card table-container">
        <ListErrorState v-if="!loading && error" :error="error" @retry="load" />
        <el-table v-else :data="cardTypes" v-loading="loading" @row-click="openCardDialog" row-class-name="clickable-row" size="small">
          <el-table-column label="产品名称" min-width="150">
            <template #default="{ row }">
              <span class="product-name">{{ row.name }}</span>
              <el-tag v-if="row.billing_mode === 'count'" size="small" effect="light" type="warning" style="margin-left: 6px">按次</el-tag>
              <el-tag v-else size="small" effect="light" type="info" style="margin-left: 6px">时效</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="权益" min-width="160">
            <template #default="{ row }">
              <template v-if="row.billing_mode === 'count'">
                {{ row.total_classes }} 次<template v-if="row.valid_days"> · {{ row.valid_days }} 天</template>
              </template>
              <template v-else>{{ row.valid_days }} 天不限次</template>
            </template>
          </el-table-column>
          <el-table-column label="赠积分" min-width="90">
            <template #default="{ row }">
              <span v-if="row.points_reward">{{ row.points_reward }}</span>
              <span v-else class="text-faint">—</span>
            </template>
          </el-table-column>
          <el-table-column label="价格" min-width="130" align="right">
            <template #default="{ row }">
              <span class="price-text">¥{{ Number(row.price || 0).toLocaleString() }}</span>
            </template>
          </el-table-column>
          <el-table-column label="适用项目" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ row.course_scope || '全部项目' }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="90">
            <template #default="{ row }">
              <StatusDot :tone="row.is_active !== 0 ? 'success' : 'neutral'" :label="row.is_active !== 0 ? '在售' : '停用'" subtle />
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <!-- 实物商品 -->
    <template v-if="activeMode === 'goods'">
      <div class="section-head">
        <div>
          <h3 class="section-title">其他商品 / 周边</h3>
          <p class="section-desc">球衣、定制球衣、球鞋等实物商品，小程序{{ $t('membership') }}服务同步展示，购买请联系客服</p>
        </div>
      </div>
      <div class="card table-container">
        <ListErrorState v-if="!loading && error" :error="error" @retry="load" />
        <el-table v-else :data="goods" v-loading="loading" @row-click="openGoodsDialog" row-class-name="clickable-row" size="small">
          <el-table-column label="商品名称" min-width="160">
            <template #default="{ row }">
              <span class="product-name">{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column label="单位" min-width="100">
            <template #default="{ row }">{{ row.unit || '件' }}</template>
          </el-table-column>
          <el-table-column label="价格" min-width="130" align="right">
            <template #default="{ row }">
              <span class="price-text">¥{{ Number(row.price || 0).toLocaleString() }}</span>
            </template>
          </el-table-column>
          <el-table-column label="赠积分" min-width="90">
            <template #default="{ row }">
              <span v-if="row.points_reward">{{ row.points_reward }}</span>
              <span v-else class="text-faint">—</span>
            </template>
          </el-table-column>
          <el-table-column label="描述" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">{{ row.description || '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="90">
            <template #default="{ row }">
              <StatusDot :tone="row.is_active !== 0 ? 'success' : 'neutral'" :label="row.is_active !== 0 ? '在售' : '停用'" subtle />
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <!-- 会员卡编辑弹窗 -->
    <el-dialog v-model="cardDialogVisible" :title="editingCardId ? '编辑' + $t('membership') : '新增' + $t('membership')" class="dlg-md" destroy-on-close>
      <el-form ref="cardFormRef" :model="cardForm" :rules="cardRules" label-width="auto" label-position="left">
        <el-form-item label="产品名称" prop="name">
          <el-input v-model="cardForm.name" placeholder="如：月卡 / 季卡 / 年卡 / 1v1私教次卡" />
        </el-form-item>
        <el-form-item label="计费模式" prop="billingMode">
          <el-radio-group v-model="cardForm.billingMode">
            <el-radio-button value="time">时效制（不限次数）</el-radio-button>
            <el-radio-button value="count">次数制（1v1/按次）</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="cardForm.billingMode === 'count'" label="总次数" prop="totalClasses">
          <el-input-number v-model="cardForm.totalClasses" :min="1" :max="999" />
          <span class="unit-text">次</span>
        </el-form-item>
        <el-form-item label="有效天数" prop="validDays">
          <el-input-number v-model="cardForm.validDays" :min="0" :max="3650" />
          <span class="unit-text">{{ cardForm.billingMode === 'time' ? '天（期间不限次数）' : '天内有效（0 表示不限）' }}</span>
        </el-form-item>
        <el-form-item label="赠送积分" prop="pointsReward">
          <el-input-number v-model="cardForm.pointsReward" :min="0" :max="10000" />
          <span class="unit-text">分（销售登记收款时自动发放）</span>
        </el-form-item>
        <el-form-item label="价格" prop="price">
          <el-input-number v-model="cardForm.price" :min="0" :max="999999" :step="100" />
          <span class="unit-text">元</span>
        </el-form-item>
        <el-form-item label="适用项目">
          <el-input v-model="cardForm.courseScope" placeholder="留空表示全部项目" />
        </el-form-item>
        <el-form-item v-if="editingCardId" label="上架状态">
          <el-switch v-model="cardForm.isActive" :active-value="1" :inactive-value="0" active-text="在售" inactive-text="停用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cardDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submittingCard" @click="submitCard">保存</el-button>
      </template>
    </el-dialog>

    <!-- 实物商品编辑弹窗 -->
    <el-dialog v-model="goodsDialogVisible" :title="editingGoodsId ? '编辑商品' : '新增商品'" class="dlg-md" destroy-on-close>
      <el-form ref="goodsFormRef" :model="goodsForm" :rules="goodsRules" label-width="auto" label-position="left">
        <el-form-item label="商品名称" prop="name">
          <el-input v-model="goodsForm.name" placeholder="如：训练球服 / 定制球衣 / 篮球鞋" />
        </el-form-item>
        <el-form-item label="价格" prop="price">
          <el-input-number v-model="goodsForm.price" :min="0" :max="999999" :step="10" />
          <span class="unit-text">元</span>
        </el-form-item>
        <el-form-item label="单位">
          <el-input v-model="goodsForm.unit" placeholder="套 / 件 / 双" style="width: 120px" maxlength="4" />
        </el-form-item>
        <el-form-item label="赠送积分">
          <el-input-number v-model="goodsForm.pointsReward" :min="0" :max="10000" />
          <span class="unit-text">分（可选）</span>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="goodsForm.description" type="textarea" :rows="2" placeholder="尺码、颜色、材质等说明，选填" />
        </el-form-item>
        <el-form-item v-if="editingGoodsId" label="上架状态">
          <el-switch v-model="goodsForm.isActive" :active-value="1" :inactive-value="0" active-text="在售" inactive-text="停用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="goodsDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submittingGoods" @click="submitGoods">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import {
  getCardTypes, addCardType, updateCardType,
} from '@/api/modules'
import StatusDot from '@/components/StatusDot.vue'
import PageHeader from '@/components/PageHeader.vue'

defineProps({ embedded: { type: Boolean, default: false } })

const activeMode = ref('membership')
const loading = ref(false)
// 提交防重复：保存按钮的进行中状态（双击会重复创建）
const submittingCard = ref(false)
const submittingGoods = ref(false)
const allProducts = ref([])
const cardTypes = computed(() => allProducts.value.filter((p) => p.product_type !== 'goods'))
const goods = computed(() => allProducts.value.filter((p) => p.product_type === 'goods'))

const error = ref('')

const load = async () => {
  error.value = ''
  loading.value = true
  try {
    const res = await getCardTypes()
    allProducts.value = res.list || []
  } catch (e) {
    error.value = e?.message || '数据加载失败，请稍后重试'
    allProducts.value = []
  } finally {
    loading.value = false
  }
}

// ---- 会员卡 ----
const cardDialogVisible = ref(false)
const cardFormRef = ref(null)
const editingCardId = ref('')
const cardForm = reactive({ name: '', billingMode: 'time', validDays: 30, totalClasses: 8, pointsReward: 0, price: 0, courseScope: '', isActive: 1 })
const cardRules = {
  name: [{ required: true, message: '请输入产品名称', trigger: 'blur' }],
  price: [{ required: true, message: '请输入价格', trigger: 'change' }],
}
const openCardDialog = (row) => {
  editingCardId.value = row?.id || ''
  Object.assign(cardForm, {
    name: row?.name || '',
    billingMode: row?.billing_mode || 'time',
    validDays: row?.valid_days || 30,
    totalClasses: row?.total_classes || 8,
    pointsReward: row?.points_reward || 0,
    price: row?.price || 0,
    courseScope: row?.course_scope || '',
    isActive: row ? (row.is_active !== 0 ? 1 : 0) : 1,
  })
  cardDialogVisible.value = true
}
const submitCard = async () => {
  if (!cardFormRef.value) return
  const valid = await cardFormRef.value.validate().catch(() => false)
  if (!valid) return
  const payload = { ...cardForm, productType: 'membership' }
  submittingCard.value = true
  try {
    if (editingCardId.value) {
      await updateCardType(editingCardId.value, payload)
      ElMessage.success('已更新')
    } else {
      await addCardType(payload)
      ElMessage.success('已创建')
    }
    cardDialogVisible.value = false
    load()
  } catch (e) { /* 拦截器已提示 */ } finally {
    submittingCard.value = false
  }
}
// ---- 实物商品 ----
const goodsDialogVisible = ref(false)
const goodsFormRef = ref(null)
const editingGoodsId = ref('')
const goodsForm = reactive({ name: '', price: 0, unit: '件', pointsReward: 0, description: '', isActive: 1 })
const goodsRules = {
  name: [{ required: true, message: '请输入商品名称', trigger: 'blur' }],
  price: [{ required: true, message: '请输入价格', trigger: 'change' }],
}
const openGoodsDialog = (row) => {
  editingGoodsId.value = row?.id || ''
  Object.assign(goodsForm, {
    name: row?.name || '',
    price: row?.price || 0,
    unit: row?.unit || '件',
    pointsReward: row?.points_reward || 0,
    description: row?.description || '',
    isActive: row ? (row.is_active !== 0 ? 1 : 0) : 1,
  })
  goodsDialogVisible.value = true
}
const submitGoods = async () => {
  if (!goodsFormRef.value) return
  const valid = await goodsFormRef.value.validate().catch(() => false)
  if (!valid) return
  const payload = { ...goodsForm, productType: 'goods' }
  submittingGoods.value = true
  try {
    if (editingGoodsId.value) {
      await updateCardType(editingGoodsId.value, payload)
      ElMessage.success('已更新')
    } else {
      await addCardType(payload)
      ElMessage.success('已创建')
    }
    goodsDialogVisible.value = false
    load()
  } catch (e) { /* 拦截器已提示 */ } finally {
    submittingGoods.value = false
  }
}
onMounted(load)
</script>

<style lang="scss" scoped>
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: var(--t-spacing-md);
}
.section-title {
  font-weight: 600;
  color: var(--t-text-1);
  margin: 0;
}
.section-desc {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  margin: 4px 0 0;
}
.table-container {
  overflow-x: auto;
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
}
.product-name {
  font-weight: 500;
  color: var(--t-text-1);
}
.price-text {
  font-weight: 600;
  color: var(--t-accent-text);
  font-variant-numeric: tabular-nums;
}
.text-faint {
  color: var(--t-text-faint);
}
.unit-text {
  margin-left: 8px;
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

:deep(.el-dialog__footer) {
  display: flex;
  justify-content: flex-end;
  gap: var(--t-spacing-sm);
}
</style>
