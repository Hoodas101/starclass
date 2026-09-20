<template>
  <div class="page-header">
    <div class="page-header-heading">
      <!-- title slot 优先：允许页面用 <i> 做双色标题（主词近黑 + 副词浅灰）
           未传 slot 时回退到 title prop，对现有调用方完全向后兼容 -->
      <h2 class="page-header-title">
        <slot name="title">{{ title }}</slot>
      </h2>
    </div>
    <div v-if="$slots.default" class="page-header-actions">
      <slot />
    </div>
  </div>
</template>

<script setup>
// description 已移除：项目规范「标题下不显示解释性副标题」，
// 该 prop 声明后从未在 template 中渲染，全仓亦无调用方传入，属历史遗留死 prop。
defineProps({
  title: { type: String, default: '' },
})
</script>

<style lang="scss" scoped>
// 页头布局/边框/间距统一走全局 .page-header（index.scss），此处仅细化标题与描述
.page-header {
  margin-bottom: var(--t-spacing-lg);
}

.page-header-heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.page-header-title {
  font-size: var(--t-fs-2xl);
  font-weight: 600;
  color: var(--t-text-1);
  margin: 0;
  letter-spacing: 0.01em;
  line-height: var(--t-leading-snug);

  // 双色标题：<i> 作副词用浅灰，主词保持近黑
  // 一句话分两层，比整句纯黑更透气（对标班主任工作台的 .gtit i）
  :deep(i) {
    font-style: normal;
    color: var(--t-text-3);
  }
}

.page-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
</style>
