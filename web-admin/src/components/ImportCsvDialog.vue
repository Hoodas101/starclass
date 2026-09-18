<template>
  <el-dialog v-model="visible" :title="title" class="dlg-lg" destroy-on-close>
    <div class="import-body">
      <div class="import-steps">
        <p>1. 下载模板，按表头填写数据（必填列不能为空）；</p>
        <p>2. 上传填写好的 <b>.xlsx / .xls / .csv</b> 文件（模板本身即为 Excel，可直接填好再上传）；</p>
        <p>3. 上传后预览前 5 行，确认无误后点击「开始导入」。</p>
      </div>

      <div class="import-toolbar">
        <el-button :icon="Download" @click="downloadTemplate">下载模板</el-button>
        <el-upload
          :show-file-list="false"
          accept=".csv,.xlsx,.xls"
          :before-upload="handleFile"
        >
          <el-button type="primary" :icon="Upload">选择文件</el-button>
        </el-upload>
      </div>

      <div v-if="previewRows.length" class="import-preview">
        <div class="preview-head">
          <span>共解析 {{ previewRows.length }} 行数据</span>
          <span v-if="parseErrors.length" class="preview-err">{{ parseErrors.length }} 行有问题（跳过）</span>
        </div>
        <el-table :data="previewRows.slice(0, 8)" size="small" max-height="240">
          <el-table-column
            v-for="col in templateColumns"
            :key="col.key"
            :label="col.label"
            :prop="col.key"
            show-overflow-tooltip
          />
        </el-table>
        <div v-if="parseErrors.length" class="preview-errors">
          <div v-for="(e, i) in parseErrors.slice(0, 6)" :key="i" class="preview-error-item">{{ e }}</div>
          <div v-if="parseErrors.length > 6" class="preview-error-item">… 其余 {{ parseErrors.length - 6 }} 条略</div>
        </div>
      </div>

      <div v-if="importResult" class="import-result" :class="importResult.failed.length ? 'has-failed' : 'ok'">
        <p>导入完成：成功 {{ importResult.success }} 条，失败 {{ importResult.failed.length }} 条。</p>
        <div v-for="(f, i) in importResult.failed.slice(0, 6)" :key="i" class="preview-error-item">{{ f }}</div>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button
        type="primary"
        :loading="importing"
        :disabled="!previewRows.length"
        @click="doImport"
      >开始导入</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue'
import { Download, Upload } from '@element-plus/icons-vue'
import { parseCsv, csvToObjects } from '@/utils/csv'
import { exportXlsx } from '@/utils/xlsx'

const props = defineProps({
  title: { type: String, default: '批量导入' },
  // [{ key, label, required }]
  templateColumns: { type: Array, default: () => [] },
  // (rows: object[]) => Promise<{ success: number, failed: string[] }>
  importFn: { type: Function, required: true },
})

const visible = ref(false)
const previewRows = ref([])
const parseErrors = ref([])
const importing = ref(false)
const importResult = ref(null)

const open = () => {
  visible.value = true
  previewRows.value = []
  parseErrors.value = []
  importResult.value = null
}

const downloadTemplate = () => {
  exportXlsx(`${props.title}导入模板`, props.templateColumns.map((c) => c.label), [[]], { sheetName: '模板' })
}

const handleFile = (file) => {
  const lower = (file.name || '').toLowerCase()
  if (lower.endsWith('.csv')) {
    const reader = new FileReader()
    reader.onload = () => {
      const rows = parseCsv(String(reader.result || ''))
      const { objects, errors } = csvToObjects(rows, props.templateColumns)
      applyParsed(objects, errors)
    }
    reader.readAsText(file, 'utf-8')
    return false
  }
  // .xlsx / .xls：用 SheetJS 解析首个工作表（371KB 重依赖，仅在真正导入 Excel 时动态加载）
  const reader = new FileReader()
  reader.onload = async (e) => {
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(e.target.result, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      const json = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
      const { objects, errors } = xlsxToObjects(json, props.templateColumns)
      applyParsed(objects, errors)
    } catch (err) {
      ElMessage.error('Excel 解析失败：' + (err && err.message ? err.message : err))
    }
  }
  reader.readAsArrayBuffer(file)
  return false
}

// 将 Excel 首个工作表（对象数组，键为表头文字）映射为按 col.key 取值的对象数组
const xlsxToObjects = (json, columns) => {
  const objects = []
  const errors = []
  json.forEach((rec, ri) => {
    const norm = {}
    Object.keys(rec || {}).forEach((k) => {
      norm[String(k).trim()] = rec[k]
    })
    const obj = {}
    columns.forEach((col) => {
      let v = norm[col.label]
      if (v === undefined || v === '') v = norm[col.key]
      obj[col.key] = v == null ? '' : String(v).trim()
    })
    const required = columns.filter((c) => c.required)
    const missing = required.filter((c) => !obj[c.key]?.trim())
    if (missing.length) {
      errors.push(`第 ${ri + 2} 行：缺少必填列「${missing.map((m) => m.label).join('、')}」`)
    } else {
      objects.push(obj)
    }
  })
  return { objects, errors }
}

const applyParsed = (objects, errors) => {
  previewRows.value = objects
  parseErrors.value = errors
  importResult.value = null
  if (!objects.length && !errors.length) {
    ElMessage.warning('未解析到有效数据，请检查文件格式')
  }
}

const doImport = async () => {
  try {
    await ElMessageBox.confirm(
      `即将导入 ${previewRows.value.length} 条数据${parseErrors.value.length ? `，${parseErrors.value.length} 行存在问题将跳过` : ''}。导入会按现有接口规则新增记录（按自然键去重），请确认无误后再继续。`,
      '确认导入',
      { type: 'warning', confirmButtonText: '开始导入', cancelButtonText: '取消' }
    )
  } catch (e) {
    return // 用户取消
  }
  importing.value = true
  try {
    const res = await props.importFn(previewRows.value)
    importResult.value = res
    if (res.success > 0) ElMessage.success(`导入成功 ${res.success} 条`)
    previewRows.value = []
    parseErrors.value = []
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    importing.value = false
  }
}

defineExpose({ open })
</script>

<style lang="scss" scoped>
.import-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.import-steps {
  p {
    margin: 0 0 6px;
    font-size: 13px;
    color: var(--t-text-2);
    line-height: 1.6;
  }
}

.import-toolbar {
  display: flex;
  gap: 10px;
}

.import-preview {
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-lg);
  overflow: hidden;
}

.preview-head {
  display: flex;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--t-text-2);
  background: var(--t-surface-hover);
  border-bottom: 1px solid var(--t-line);
}

.preview-err {
  color: var(--t-danger-text);
}

.preview-errors {
  padding: 8px 12px;
  background: color-mix(in srgb, var(--t-danger) 6%, transparent);
}

.preview-error-item {
  font-size: 12px;
  color: var(--t-danger-text);
  line-height: 1.7;
}

.import-result {
  border-radius: var(--t-radius-lg);
  padding: 10px 14px;
  font-size: 13px;

  p {
    margin: 0 0 4px;
  }

  &.ok {
    background: color-mix(in srgb, var(--t-success) 8%, transparent);
    color: var(--t-success-text);
  }

  &.has-failed {
    background: color-mix(in srgb, var(--t-warning) 8%, transparent);
    color: var(--t-text-1);
  }
}
</style>
