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
          accept=".csv,.tsv,.txt,.xlsx,.xls"
          :before-upload="handleFile"
        >
          <el-button type="primary" :icon="Upload">选择文件</el-button>
        </el-upload>
      </div>

      <!-- 表头诊断：新手常拿别家机构导出的表格直接上传，表头对不上时必须告诉他「你有什么」，
           而不是只说「缺少必填列」。非必填列匹配失败是静默丢数据，更要显式提示。 -->
      <div v-if="headerDiag && (headerDiag.missingRequired.length || headerDiag.unrecognized.length || headerDiag.sheet || headerDiag.encoding)" class="header-diag">
        <div v-if="headerDiag.missingRequired.length" class="preview-error-item">
          未找到必填列：{{ headerDiag.missingRequired.join('、') }}。你表格的表头是：{{ headerDiag.header.join('、') || '（空）' }}
        </div>
        <div v-if="headerDiag.unrecognized.length" class="preview-warn-item">
          未识别的列（将被忽略）：{{ headerDiag.unrecognized.join('、') }} —— 可改成模板列名后重新上传
        </div>
        <div v-if="headerDiag.headerRowIndex > 0" class="preview-warn-item">
          已自动识别第 {{ headerDiag.headerRowIndex + 1 }} 行为表头（忽略其上 {{ headerDiag.headerRowIndex }} 行标题）
        </div>
        <div v-if="headerDiag.sheet" class="preview-warn-item">已自动使用工作表「{{ headerDiag.sheet }}」</div>
        <div v-if="headerDiag.encoding" class="preview-warn-item">已按 {{ headerDiag.encoding }} 解码文件</div>
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

      <div v-if="importResult" class="import-result" :class="(importResult.failed.length || importWarnings.length) ? 'has-failed' : 'ok'">
        <p>
          导入完成：成功 {{ importResult.success }} 条，失败 {{ importResult.failed.length }} 条<template v-if="importSkipped.length">，另有 {{ importSkipped.length }} 条已存在被跳过</template><template v-if="importWarnings.length">，另有 {{ importWarnings.length }} 条未建立家长绑定</template>。
        </p>
        <div v-for="(f, i) in importResult.failed.slice(0, 6)" :key="i" class="preview-error-item">{{ f }}</div>
        <div v-for="(s, i) in importSkipped.slice(0, 6)" :key="'s' + i" class="preview-warn-item">{{ s }}</div>
        <div v-if="importSkipped.length > 6" class="preview-warn-item">… 其余 {{ importSkipped.length - 6 }} 条因已存在被跳过略</div>
        <div v-for="(w, i) in importWarnings.slice(0, 6)" :key="'w' + i" class="preview-warn-item">{{ w }}</div>
        <div v-if="importWarnings.length > 6" class="preview-warn-item">… 其余 {{ importWarnings.length - 6 }} 条未建立家长绑定略</div>
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
import { computed, ref } from 'vue'
import { Download, Upload } from '@element-plus/icons-vue'
import { parseCsv, csvToObjects, decodeTextFile } from '@/utils/csv'
import { exportXlsx } from '@/utils/xlsx'

const props = defineProps({
  title: { type: String, default: '批量导入' },
  // [{ key, label, required }]
  templateColumns: { type: Array, default: () => [] },
  // (rows: object[]) => Promise<{ success: number, failed: string[], warnings?: string[] }>
  importFn: { type: Function, required: true },
})

const visible = ref(false)
const previewRows = ref([])
const parseErrors = ref([])
const importing = ref(false)
const importResult = ref(null)
// 表头诊断信息（未识别列 / 缺失必填列 / 实际表头 / 使用的工作表 / 文件编码）
const headerDiag = ref(null)
// 未建立家长绑定的行（仅成员导入会返回 warnings；订单导入没有，故兜底为空数组）
const importWarnings = computed(() => (importResult.value && importResult.value.warnings) || [])
// 查重命中而跳过的行（仅成员导入会返回 skipped；订单导入没有，故兜底为空数组）。
// 必须显示出来，否则「导入 100 条只建了 60 条」在界面上完全看不出原因。
const importSkipped = computed(() => (importResult.value && importResult.value.skipped) || [])

const open = () => {
  visible.value = true
  previewRows.value = []
  parseErrors.value = []
  importResult.value = null
  headerDiag.value = null
}

const downloadTemplate = () => {
  exportXlsx(`${props.title}导入模板`, props.templateColumns.map((c) => c.label), [[]], { sheetName: '模板' })
}

const handleFile = (file) => {
  const lower = (file.name || '').toLowerCase()
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    const reader = new FileReader()
    reader.onload = () => {
      // 先解码再解析：固定 readAsText(file,'utf-8') 会把 GBK 文件读成乱码，而乱码字符非空，
      // 姓名列照样通过必填校验并入库。改为 UTF-8 优先、GBK 兜底，无法识别则明确报错。
      const { text, encoding, garbled } = decodeTextFile(reader.result)
      if (garbled) {
        ElMessage.error('文件编码无法识别（可能是 GBK 或二进制），请另存为 UTF-8 编码的 CSV 后重试')
        return
      }
      const rows = parseCsv(text)
      const parsed = csvToObjects(rows, props.templateColumns)
      applyParsed(parsed, { encoding, header: parsed.header || [] })
    }
    reader.readAsArrayBuffer(file)
    return false
  }
  // .xlsx / .xls：用 SheetJS 解析（371KB 重依赖，仅在真正导入 Excel 时动态加载）
  const reader = new FileReader()
  reader.onload = async (e) => {
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(e.target.result, { type: 'array' })
      // 多工作表：机构从其他系统导出的表常是「说明页 + 数据页」，此前只读第 1 个 → 解析 0 行且无提示。
      // 依次尝试各工作表，取第一个能解析出有效数据的。
      // 以「网格」而非对象模式读取：对象模式固定把第 1 行当表头，而机构台账常是
      // 「第 1 行标题 + 第 2 行列名」，会一列都匹配不上并导致整表错位一列。
      // 网格 + csvToObjects 内的表头行探测可自动定位真表头（CSV 与 XLSX 同一套逻辑）。
      let parsed = { objects: [], errors: [], unrecognized: [], missingRequired: [], header: [], headerRowIndex: 0 }
      let usedSheet = wb.SheetNames[0] || ''
      for (const name of wb.SheetNames) {
        const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false, blankrows: false })
        const r = csvToObjects(grid, props.templateColumns)
        usedSheet = name
        parsed = r
        if (r.objects.length) break
      }
      // 仅多工作表时提示使用了哪一张（单表无需打扰）
      applyParsed(parsed, { sheet: wb.SheetNames.length > 1 ? usedSheet : '', header: parsed.header || [] })
    } catch (err) {
      ElMessage.error('Excel 解析失败：' + (err && err.message ? err.message : err))
    }
  }
  reader.readAsArrayBuffer(file)
  return false
}

const applyParsed = (parsed, meta = {}) => {
  previewRows.value = parsed.objects || []
  parseErrors.value = parsed.errors || []
  headerDiag.value = {
    unrecognized: parsed.unrecognized || [],
    missingRequired: parsed.missingRequired || [],
    header: meta.header || [],
    sheet: meta.sheet || '',
    // 仅非 UTF-8 时提示（UTF-8 是常态，不必打扰）
    encoding: meta.encoding && meta.encoding !== 'utf-8' ? meta.encoding : '',
    // 标题行被跳过的提示：让用户知道系统认的是第几行
    headerRowIndex: parsed.headerRowIndex || 0,
  }
  importResult.value = null
  if (!previewRows.value.length && !parseErrors.value.length) {
    ElMessage.warning('未解析到有效数据，请检查文件格式与表头')
  }
}

const doImport = async () => {
  try {
    await ElMessageBox.confirm(
      `即将导入 ${previewRows.value.length} 条数据${parseErrors.value.length ? `，${parseErrors.value.length} 行存在问题将跳过` : ''}。姓名+手机号已存在的成员会被自动跳过、不会重复创建；任一行导入失败会整批回滚。请确认无误后再继续。`,
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

/* 警告不是失败：学员已导入成功，只是家长绑定没建上，用警示色而非报错色 */
.preview-warn-item {
  font-size: 12px;
  color: var(--t-warning-text);
  line-height: 1.7;
}

/* 表头诊断块：告诉用户「缺什么」的同时也告诉他「你有什么」 */
.header-diag {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
  background: var(--t-bg-alt);
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
