<template>
  <div class="view-bar">
    <button
      v-for="v in views"
      :key="v.id"
      class="view-chip"
      :class="{ active: v.id === activeId, system: v.system }"
      type="button"
      :title="v.system ? '系统视图（不可删除）' : '双击重命名'"
      @click="$emit('select', v.id)"
      @dblclick="rename(v)"
    >
      <span class="view-chip-name">{{ v.name }}</span>
      <el-icon v-if="!v.system" class="view-chip-del" @click.stop="remove(v)"><Close /></el-icon>
    </button>
    <button class="view-add" type="button" @click="create">+ 新建视图</button>
  </div>
</template>

<script setup>
import { Close } from '@element-plus/icons-vue'

defineProps({
  // [{ id, name, system? }]
  views: { type: Array, required: true },
  activeId: { type: String, default: '' },
})
const emit = defineEmits(['select', 'create', 'rename', 'remove'])

const askName = async (title, inputValue) => {
  try {
    const { value } = await ElMessageBox.prompt('视图保存当前的筛选、排序、字段顺序与列宽', title, {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue,
      inputValidator: (v) => (String(v == null ? '' : v).trim() ? true : '名称不能为空'),
    })
    return String(value).trim().slice(0, 12)
  } catch (e) {
    return null // 用户取消
  }
}

const create = async () => {
  const name = await askName('新建视图', '新视图')
  if (name) emit('create', name)
}

const rename = async (v) => {
  if (v.system) return
  const name = await askName('重命名视图', v.name)
  if (name && name !== v.name) emit('rename', v.id, name)
}

const remove = async (v) => {
  if (v.system) return
  try {
    await ElMessageBox.confirm(`删除视图「${v.name}」？该操作不影响任何业务数据。`, '删除视图', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch (e) {
    return
  }
  emit('remove', v.id)
}
</script>

<style lang="scss" scoped>
.view-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-height: 28px;
}

.view-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--t-radius-md);
  border: 1px solid var(--t-line);
  background: var(--t-bg);
  color: var(--t-text-2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;

  &:hover {
    border-color: var(--t-accent-line);
    color: var(--t-accent);
  }

  &.active {
    background: var(--t-accent-bg);
    border-color: var(--t-accent-line);
    color: var(--t-accent);
    font-weight: 600;
  }

  &.system .view-chip-name {
    // 系统视图不可删，用弱化样式与用户视图区分
    opacity: 0.9;
  }
}

.view-chip-name {
  white-space: nowrap;
}

.view-chip-del {
  font-size: 12px;
  opacity: 0.5;

  &:hover {
    opacity: 1;
    color: var(--t-danger-text);
  }
}

.view-add {
  height: 28px;
  padding: 0 10px;
  border-radius: var(--t-radius-md);
  border: 1px dashed var(--t-line);
  background: transparent;
  color: var(--t-text-3);
  font-size: 12px;
  cursor: pointer;

  &:hover {
    border-color: var(--t-accent-line);
    color: var(--t-accent);
  }
}
</style>
