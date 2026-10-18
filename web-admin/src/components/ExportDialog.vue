<!-- 导出确认弹窗：选择时间范围 → 二次确认 → 执行导出 -->
<template>
  <el-dialog
    :model-value="visible"
    :title="title"
    width="440px"
    :close-on-click-modal="false"
    @update:model-value="(v) => (visible = v)"
    @closed="onClosed"
    append-to-body
  >
    <div class="export-dialog-body">
      <p class="export-dialog-desc">{{ description }}</p>
      <div class="export-dialog-row">
        <span class="export-dialog-label">导出时间范围</span>
        <ExportRangePicker v-model="range" :default-shortcut="defaultShortcut" />
      </div>
      <p class="export-dialog-tip">留空表示导出全部数据；按所选时间范围筛选后生成 Excel 文件。</p>
    </div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="exporting" @click="confirm">
        {{ exporting ? '导出中…' : '确认导出' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue'
import ExportRangePicker from './ExportRangePicker.vue'

const props = defineProps({
  title: { type: String, default: '导出数据' },
  description: { type: String, default: '选择时间范围后确认导出，文件将立即开始下载。' },
  defaultShortcut: { type: String, default: null },
})
const emit = defineEmits(['confirm'])

const visible = ref(false)
const range = ref(null)
const exporting = ref(false)

const open = () => {
  range.value = applyDefaultShortcut(props.defaultShortcut)
  exporting.value = false
  visible.value = true
}

const applyDefaultShortcut = (key) => {
  if (!key) return null
  const now = new Date()
  const fmt = (d) => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  const daysAgo = (n) => {
    const d = new Date()
    d.setDate(d.getDate() - n)
    return d
  }
  const map = {
    today: [fmt(now), fmt(now)],
    7: [fmt(daysAgo(6)), fmt(now)],
    30: [fmt(daysAgo(29)), fmt(now)],
    month: [`${fmt(now).slice(0, 7)}-01`, fmt(now)],
    year: [`${now.getFullYear()}-01-01`, fmt(now)],
  }
  return map[key] || null
}

const confirm = () => {
  if (exporting.value) return
  exporting.value = true
  // 把「完成」回调交给父级：父级在导出真正结束时调用它，弹窗才会关闭。
  // 此前写的是 `await emit('confirm', ...)` —— emit 不返回父级 Promise，
  // await 立即通过，弹窗在导出**开始瞬间**就关闭、按钮「导出中…」形同虚设，
  // 用户会重复点击触发重复请求与重复下载。
  const done = () => {
    exporting.value = false
    visible.value = false
  }
  emit('confirm', range.value ? [...range.value] : null, done)
}

const onClosed = () => {
  range.value = null
  exporting.value = false
}

defineExpose({ open })
</script>

<style scoped>
.export-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.export-dialog-desc {
  margin: 0;
  font-size: 13px;
  color: var(--t-text-2);
  line-height: 1.5;
}
.export-dialog-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.export-dialog-label {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--t-text-1);
  font-weight: 500;
}
.export-dialog-tip {
  margin: 0;
  font-size: 12px;
  color: var(--t-text-3);
}
</style>
