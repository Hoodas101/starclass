<template>
  <el-popover
    v-model:visible="visible"
    trigger="click"
    placement="bottom-end"
    width="640"
    popper-class="column-settings-pop"
    :show-arrow="false"
    :offset="8"
    @show="initOrder"
  >
    <template #reference>
      <span v-if="noButton" style="display: none" aria-hidden="true"></span>
      <button v-else class="btn-config" type="button">
        <el-icon><Setting /></el-icon>
        <span>字段设置</span>
      </button>
    </template>

    <div class="cs-head">
      <div class="cs-title">字段设置</div>
      <span class="cs-sub">拖拽或箭头调整顺序 · 点击眼睛显示/隐藏</span>
    </div>

    <div class="cs-layout">
      <!-- 显示字段 -->
      <div class="cs-pane">
        <div class="cs-pane-head">
          <span class="cs-pane-title">显示字段</span>
          <span class="cs-pane-count">{{ orderedKeys.length }} 项</span>
        </div>
        <div class="column-list cs-list">
          <div
            v-for="(key, idx) in orderedKeys"
            :key="key"
            class="column-item cs-row"
            :class="{ 'cs-row-dragging': dragIndex === idx }"
            draggable="true"
            @dragstart="onDragStart($event, idx)"
            @dragover.prevent
            @drop="onDrop(idx)"
            @dragend="dragIndex = null"
          >
            <el-icon class="cs-grip" :size="16"><Rank /></el-icon>
            <span class="cs-label">{{ labelOf(key) }}</span>
            <div class="cs-ops">
              <el-button text aria-label="上移此列" :disabled="idx === 0" class="cs-icon-btn" @click="move(idx, -1)">
                <el-icon><ArrowUp /></el-icon>
              </el-button>
              <el-button text aria-label="下移此列" :disabled="idx === orderedKeys.length - 1" class="cs-icon-btn" @click="move(idx, 1)">
                <el-icon><ArrowDown /></el-icon>
              </el-button>
              <el-button text aria-label="隐藏此列" class="cs-icon-btn cs-eye" @click="hide(idx)">
                <el-icon><View /></el-icon>
              </el-button>
            </div>
          </div>
          <div v-if="orderedKeys.length === 0" class="cs-empty">全部字段已隐藏</div>
        </div>
      </div>

      <!-- 隐藏字段 -->
      <div class="cs-pane cs-pane-dim">
        <div class="cs-pane-head">
          <span class="cs-pane-title">隐藏字段</span>
          <span class="cs-pane-count">{{ hiddenKeys.length }} 项</span>
        </div>
        <div class="cs-list">
          <div v-for="key in hiddenKeys" :key="key" class="column-item cs-row cs-row-hidden">
            <span class="cs-label">{{ labelOf(key) }}</span>
            <el-button text aria-label="显示此列" class="cs-icon-btn" @click="show(key)">
              <el-icon><Hide /></el-icon>
            </el-button>
            <el-button
              v-if="isCustom(key)"
              text
              aria-label="删除此自定义字段"
              class="cs-icon-btn cs-del"
              @click="removeCustom(key)"
            >
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
          <div v-if="hiddenKeys.length === 0" class="cs-empty">没有隐藏字段</div>
        </div>
      </div>
    </div>

    <!-- 自定义字段 -->
    <div v-if="customizable" class="cs-custom">
      <el-input
        v-model="customName"
        size="small"
        placeholder="添加自定义字段名"
        maxlength="12"
        clearable
        @keyup.enter="addCustom"
      />
      <el-button size="small" type="primary" :icon="Plus" @click="addCustom">添加</el-button>
    </div>
    <div v-if="customizable" class="cs-custom-tip">自定义字段显示表格中对应列的内容，可随时隐藏或删除</div>

    <!-- 列宽：自适应（canvas 实测文本像素）+ 逐列手动微调 + 一键复位。
         留空 = 跟随自适应；填了就按该值固定（此时其余列也会一并固定，避免相邻列被压缩）。 -->
    <div class="cs-widths">
      <div class="cs-widths-head">
        <span class="cs-pane-title">列宽</span>
        <label class="cs-widths-auto">
          <el-switch :model-value="autoWidth" size="small" @update:model-value="$emit('update:autoWidth', $event)" />
          <span>自适应</span>
        </label>
        <el-button text size="small" @click="$emit('reset-widths')">一键复位</el-button>
      </div>
      <div class="cs-widths-list">
        <div v-for="key in orderedKeys" :key="key" class="cs-width-row">
          <span class="cs-width-label">{{ labelOf(key) }}</span>
          <el-input-number
            :model-value="widths[key]"
            size="small"
            :min="40"
            :max="600"
            :step="10"
            controls-position="right"
            placeholder="自动"
            @update:model-value="(v) => setWidth(key, v)"
          />
        </div>
      </div>
    </div>

    <div class="cs-footer">
      <el-button text @click="resetDefaults">恢复默认</el-button>
      <div class="cs-footer-right">
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </div>
    </div>
  </el-popover>
</template>

<script setup>
import { ref, computed } from 'vue'
import { Setting, Rank, ArrowUp, ArrowDown, View, Hide, Plus, Delete } from '@element-plus/icons-vue'

const props = defineProps({
  columns: { type: Array, required: true },
  settings: { type: Object, required: true },
  defaults: { type: Object, required: true },
  noButton: { type: Boolean, default: false },
  customizable: { type: Boolean, default: true },
  // 列宽：{ [key]: px } 手动值；autoWidth 为自适应开关
  widths: { type: Object, default: () => ({}) },
  autoWidth: { type: Boolean, default: true },
})
const emit = defineEmits(['update:settings', 'save', 'update:widths', 'update:autoWidth', 'reset-widths'])

// 留空 = 跟随自适应；填了就按该值固定
const setWidth = (key, v) => {
  const next = { ...(props.widths || {}) }
  const n = Number(v)
  if (v === null || v === undefined || v === '' || Number.isNaN(n) || n <= 0) delete next[key]
  else next[key] = n
  emit('update:widths', next)
}

const visible = ref(false)
const orderedKeys = ref([])
const dragIndex = ref(null)
const customName = ref('')

const keyOf = (def) => def.key
const labelOf = (key) => (props.columns.find((c) => c.key === key) || {}).label || key

const customFields = () => (Array.isArray(props.settings.customFields) ? props.settings.customFields : [])
const allKeys = () => [...props.columns.map(keyOf), ...customFields()]

const visibleKeys = () => allKeys().filter((k) => props.settings[k] !== false)
const hiddenKeys = computed(() => allKeys().filter((k) => props.settings[k] === false))
const isCustom = (key) => customFields().includes(key)

const addCustom = () => {
  const name = customName.value.trim()
  if (!name) return
  if (allKeys().includes(name)) return
  if (customFields().length >= 10) return
  emit('update:settings', {
    ...props.settings,
    customFields: [...customFields(), name],
    [name]: true,
  })
  customName.value = ''
  orderedKeys.value.push(name)
}

const removeCustom = (key) => {
  const next = { ...props.settings }
  next.customFields = customFields().filter((k) => k !== key)
  delete next[key]
  emit('update:settings', next)
  orderedKeys.value = orderedKeys.value.filter((k) => k !== key)
}

const initOrder = () => {
  const saved = Array.isArray(props.settings.order) ? props.settings.order : null
  const visibleNow = visibleKeys()
  if (saved && saved.length) {
    const rest = visibleNow.filter((k) => !saved.includes(k))
    orderedKeys.value = [...saved.filter((k) => visibleNow.includes(k)), ...rest]
  } else {
    orderedKeys.value = visibleNow
  }
}

// 创建时即初始化，确保首次渲染就位；打开弹层时再按最新设置刷新
initOrder()

const move = (idx, dir) => {
  const target = idx + dir
  if (target < 0 || target >= orderedKeys.value.length) return
  const arr = [...orderedKeys.value]
  ;[arr[idx], arr[target]] = [arr[target], arr[idx]]
  orderedKeys.value = arr
}

const onDragStart = (e, idx) => {
  dragIndex.value = idx
  e.dataTransfer.effectAllowed = 'move'
}

const onDrop = (targetIdx) => {
  if (dragIndex.value === null || dragIndex.value === targetIdx) return
  const arr = [...orderedKeys.value]
  const [moved] = arr.splice(dragIndex.value, 1)
  arr.splice(targetIdx, 0, moved)
  orderedKeys.value = arr
  dragIndex.value = null
}

const hide = (idx) => {
  const key = orderedKeys.value[idx]
  orderedKeys.value = orderedKeys.value.filter((k) => k !== key)
  applySetting(key, false)
}

const show = (key) => {
  orderedKeys.value.push(key)
  applySetting(key, true)
}

const applySetting = (key, val) => {
  emit('update:settings', { ...props.settings, [key]: val })
}

// 「恢复默认」只应重置列显隐与顺序，不能顺手清掉行高、列宽自适应、排序、视图等非列偏好
//（旧写法 `{ ...defaults }` 会把它们一并抹掉，用户点一次「恢复默认」就丢了已调好的行高与开关）
const resetDefaults = () => {
  const def = { ...props.defaults }
  delete def.order
  delete def.customFields
  orderedKeys.value = allKeys().filter((k) => def[k] !== false)
  emit('update:settings', { ...props.settings, ...def, order: orderedKeys.value })
}

const save = () => {
  emit('save', { ...props.settings, order: orderedKeys.value })
  visible.value = false
}

// 供父组件通过 ref 打开
defineExpose({
  open: () => {
    initOrder()
    visible.value = true
  },
})
</script>

<style lang="scss">
/* 弹层级样式（teleport 到 body，需非 scoped） */
.column-settings-pop {
  --el-popover-padding: 16px;
  border-radius: var(--t-radius-lg) !important;
  border: 1px solid var(--t-line) !important;
  box-shadow: var(--t-elevation-float) !important;
  transform-origin: top right;
}

.cs-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}
.cs-title {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
}
.cs-sub {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.cs-layout {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 12px;
}

.cs-pane {
  border: 1px solid var(--t-line);
  border-radius: 12px;
  background: var(--t-surface);
  overflow: hidden;
}
.cs-pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--t-line);
  background: var(--t-bg-elev);
}
.cs-pane-title {
  font-size: var(--t-fs-xs);
  font-weight: 600;
  color: var(--t-text-1);
}
.cs-pane-count {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  font-variant-numeric: tabular-nums;
}

.cs-list {
  max-height: 300px;
  overflow-y: auto;
  padding: 6px;
}

.cs-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--t-radius-md);
  transition: background-color 160ms ease-out, transform 160ms ease-out;
}
.cs-row:hover {
  background: var(--t-surface-hover);
}
.cs-row:active {
  transform: scale(0.985);
}
.cs-row-dragging {
  background: var(--t-accent-bg);
  box-shadow: none;
}
.cs-row-hidden {
  justify-content: space-between;
}
.cs-row + .cs-row {
  margin-top: 2px;
}

.cs-grip {
  color: var(--t-text-faint);
  cursor: grab;
  flex-shrink: 0;
}
.cs-label {
  flex: 1;
  min-width: 0;
  font-size: var(--t-fs-sm);
  color: var(--t-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-row-hidden .cs-label {
  color: var(--t-text-2);
}

.cs-ops {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.cs-icon-btn {
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--t-text-3);
  transition: color 160ms ease-out, background-color 160ms ease-out, transform 160ms ease-out;
}
.cs-icon-btn:hover {
  color: var(--t-text-1);
  background: var(--t-hover-bg);
}
.cs-icon-btn:active {
  transform: scale(0.9);
}
.cs-eye:hover {
  color: var(--t-danger-text);
}

.cs-empty {
  padding: 24px 0;
  text-align: center;
  font-size: var(--t-fs-xs);
  color: var(--t-text-faint);
}

.cs-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--t-line);
}
.cs-footer-right {
  display: flex;
  gap: 8px;
}

.cs-custom {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.cs-custom-tip {
  font-size: 11px;
  color: var(--t-text-3);
  margin-top: 6px;
  line-height: 1.5;
}

.cs-del {
  color: var(--t-danger-text) !important;
}

/* 列宽区 */
.cs-widths {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--t-line);
}

.cs-widths-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.cs-widths-auto {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 12px;
  color: var(--t-text-2);
  cursor: pointer;
}

.cs-widths-list {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 14px;
  max-height: 150px;
  overflow-y: auto;
}

.cs-width-row {
  display: flex;
  align-items: center;
  gap: 8px;

  .el-input-number {
    width: 104px;
  }
}

.cs-width-label {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--t-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .cs-layout {
    grid-template-columns: 1fr;
  }
}
</style>
