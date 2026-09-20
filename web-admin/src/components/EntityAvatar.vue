<template>
  <span
    class="entity-avatar"
    :class="[`size-${size}`, `tone-${tone}`]"
    :title="name"
  >
    <img v-if="showImg" :src="src" alt="" class="entity-avatar-img" @error="showImg = false" />
    <span v-else class="entity-avatar-initials">{{ initials }}</span>
  </span>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  name: { type: String, default: '' },
  src: { type: String, default: '' },
  size: { type: String, default: 'default' }, // xs / sm / default / lg / xl
  tone: { type: String, default: 'accent' }, // accent / neutral / success / warning / danger / info
})

const showImg = ref(!!props.src)

const initials = computed(() => {
  const n = (props.name || '').trim()
  if (!n) return '?'
  return /[\u4e00-\u9fa5]/.test(n[0]) ? n[0] : n[0].toUpperCase()
})
</script>

<style lang="scss" scoped>
.entity-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 12px;
  overflow: hidden;
  user-select: none;
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s cubic-bezier(0.16, 1, 0.3, 1);

  &.size-xs { width: 22px; height: 22px; border-radius: 8px; font-size: var(--t-fs-2xs); }
  &.size-sm { width: 28px; height: 28px; border-radius: 50%; font-size: var(--t-fs-xs); }
  &.size-default { width: 36px; height: 36px; border-radius: 50%; font-size: var(--t-fs-base); }
  &.size-lg { width: 44px; height: 44px; border-radius: 50%; font-size: var(--t-fs-lg); }
  &.size-xl { width: 56px; height: 56px; border-radius: 8px; font-size: var(--t-fs-xl); }

  &.tone-accent { background: color-mix(in srgb, var(--t-accent) 14%, transparent); color: var(--t-accent-strong, var(--t-accent)); }
  &.tone-neutral { background: var(--t-surface-strong); color: var(--t-text-2); }
  &.tone-success { background: color-mix(in srgb, var(--t-success) 14%, transparent); color: var(--t-success-text); }
  &.tone-warning { background: color-mix(in srgb, var(--t-warning) 14%, transparent); color: var(--t-warning-text); }
  &.tone-danger { background: color-mix(in srgb, var(--t-danger) 14%, transparent); color: var(--t-danger-text); }
  &.tone-info { background: color-mix(in srgb, var(--t-info) 16%, transparent); color: var(--t-info); }

}

.entity-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.entity-avatar-initials {
  font-weight: 600;
  line-height: 1;
}
</style>
