<template>
  <div class="page-header">
    <div class="page-header-heading">
      <!-- 标题统一单色（此前加了 title slot 支持 <i> 双色标题，但 dashboard 用后
           出现"数据看板"四字颜色不一致；现在无页面用该 slot，移除避免死代码） -->
      <h2 class="page-header-title">{{ title }}</h2>
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
}

.page-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
</style>
