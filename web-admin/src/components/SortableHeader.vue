<template>
  <!-- 整表头可点（P2-9）：点列名文字即在三态间切换，不再要求点准右侧那个很淡的小箭头 -->
  <span class="col-header" :title="title || label" @click="onSort">
    <span class="col-header-text">{{ label }}</span>
    <span
      v-if="sortable"
      class="col-sort"
      :class="{ 'is-asc': state === 1, 'is-desc': state === 2 }"
      aria-hidden="true"
    >
      <span class="col-sort-arrow">{{ arrow }}</span>
      <span v-if="priority > 1" class="col-sort-priority">{{ priority }}</span>
    </span>
    <!-- 表头右缘拖拽把手（P2-10）：与「字段设置 → 列宽」互补，拖拽即时预览、松手落盘 -->
    <span
      v-if="resizable"
      class="col-resize"
      role="separator"
      aria-label="拖拽调整列宽"
      @mousedown.stop.prevent="startResize"
      @click.stop
    />
  </span>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'

const props = defineProps({
  label: { type: String, default: '' },
  title: { type: String, default: '' },
  // 0=未排序 1=升序 2=降序（tableSort.js 的三态）
  state: { type: Number, default: 0 },
  // 多列排序时的优先级（1 起；>1 显示角标）
  priority: { type: Number, default: 0 },
  sortable: { type: Boolean, default: true },
  resizable: { type: Boolean, default: true },
})
const emit = defineEmits(['sort', 'resize'])

const arrow = computed(() => (props.state === 1 ? '↑' : props.state === 2 ? '↓' : '↕'))

// 按住 Shift/Cmd/Ctrl 点击 = 追加为次级排序（多列优先级）
const onSort = (e) => {
  if (!props.sortable) return
  emit('sort', { additive: !!(e && (e.shiftKey || e.metaKey || e.ctrlKey)) })
}

// ── 列宽拖拽 ──
// 监听挂在 document 上：指针拖出表头甚至拖出表格时仍然跟手，不会「拖着拖着就断了」。
const startX = ref(0)
const startW = ref(0)
let thEl = null
let dragging = false

const onMove = (e) => {
  if (!dragging || !thEl) return
  const w = Math.max(40, startW.value + (e.clientX - startX.value))
  // 拖拽过程只改 th 的宽度做实时预览，不改数据模型（避免每次 mousemove 都触发重渲染）
  thEl.style.width = `${w}px`
  thEl.style.minWidth = `${w}px`
}

const onUp = (e) => {
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseup', onUp)
  if (dragging && thEl) {
    const w = Math.max(40, Math.round(startW.value + (e.clientX - startX.value)))
    thEl.style.width = ''
    thEl.style.minWidth = ''
    emit('resize', w)
  }
  dragging = false
  thEl = null
}

const startResize = (e) => {
  thEl = e.currentTarget.closest('th')
  if (!thEl) return
  dragging = true
  startX.value = e.clientX
  startW.value = thEl.offsetWidth
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseup', onUp)
})
</script>

<style lang="scss">
// 表头单行：此前 .col-header 是 block，块级盒会撑出空行，表头高度达 63px（数据行仅 22px）。
// 改 inline-flex + nowrap，文字/箭头/角标强制同排。
.col-header {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.col-header-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-sort {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
  opacity: 0.35;
  line-height: 1;
  transition: opacity 0.15s;

  .col-header:hover & {
    opacity: 0.75;
  }

  &.is-asc,
  &.is-desc {
    opacity: 1;
    color: var(--t-accent);
    font-weight: 700;
  }
}

.col-sort-arrow {
  font-size: 11px;
}

.col-sort-priority {
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  padding: 0 1px;
}

// 拖拽把手：贴表头内容区右缘，命中区 6px（视觉上不占位）
.col-resize {
  position: absolute;
  top: -4px;
  right: -6px;
  width: 6px;
  height: calc(100% + 8px);
  cursor: col-resize;
  z-index: 3;

  &:hover {
    background: var(--t-accent-line);
  }
}
</style>
