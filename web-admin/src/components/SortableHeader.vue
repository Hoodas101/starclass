<template>
  <span class="col-header" :title="title || label">
    <span class="col-header-text">{{ label }}</span>
    <span
      v-if="sortable"
      class="col-sort"
      :class="{ 'is-asc': state === 1, 'is-desc': state === 2 }"
      role="button"
      :aria-label="`按${label}排序`"
      @click.stop="onSort"
    >
      <span class="col-sort-arrow">{{ arrow }}</span>
      <span v-if="priority > 1" class="col-sort-priority">{{ priority }}</span>
    </span>
  </span>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  label: { type: String, default: '' },
  title: { type: String, default: '' },
  // 0=未排序 1=升序 2=降序（tableSort.js 的三态）
  state: { type: Number, default: 0 },
  // 多列排序时的优先级（1 起；>1 显示角标）
  priority: { type: Number, default: 0 },
  sortable: { type: Boolean, default: true },
})
const emit = defineEmits(['sort'])

const arrow = computed(() => (props.state === 1 ? '↑' : props.state === 2 ? '↓' : '↕'))

// 按住 Shift/Cmd/Ctrl 点击 = 追加为次级排序（多列优先级）
const onSort = (e) => emit('sort', { additive: !!(e && (e.shiftKey || e.metaKey || e.ctrlKey)) })
</script>

<style lang="scss">
// 表头单行：此前 .col-header 是 block，块级盒会撑出空行，表头高度达 63px（数据行仅 22px）。
// 改 inline-flex + nowrap，文字/箭头/角标强制同排。
.col-header {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
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
  cursor: pointer;
  opacity: 0.35;
  line-height: 1;
  transition: opacity 0.15s;

  &:hover {
    opacity: 0.85;
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
</style>
