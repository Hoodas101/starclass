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

      <!-- 多工作表选择：机构台账常按年度分表（26销售/25销售/24销售），默认全选有数据的表 -->
      <div v-if="sheetOptions.length > 1" class="sheet-picker">
        <div class="sheet-picker-head">
          共 {{ sheetOptions.length }} 个工作表，勾选要导入的（默认全选有数据的表）
        </div>
        <el-checkbox-group v-model="selectedSheets" @change="applySelection">
          <el-checkbox
            v-for="s in sheetOptions"
            :key="s.name"
            :value="s.name"
            :disabled="!s.importable"
          >
            {{ s.name }}（{{ s.importable }} 条可导入<template v-if="s.rows !== s.importable">，共 {{ s.rows }} 行</template>）
          </el-checkbox>
        </el-checkbox-group>
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
        <div v-if="headerDiag.sheet" class="preview-warn-item">{{ headerDiag.sheet }}</div>
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
  // (rows: object[]) => Promise<{ success: number, failed: string[], warnings?: string[], skipped?: string[] }>
  importFn: { type: Function, required: true },
  // 各调用方按导入类型配置确认文案（去重口径不同：成员按姓名+手机号、订单按收据单号）
  confirmRules: { type: String, default: '' },
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

// 多工作表：机构导出的销售台账常按年度分表（26销售/25销售/24销售）。
// 旧实现「取第一个能解析出数据的表就 break」，其余工作表**静默丢失**（实测 416 行从未被读取）。
const sheetOptions = ref([])   // [{ name, rows, importable, parsed }]
const selectedSheets = ref([]) // 勾选的表名

const open = () => {
  visible.value = true
  previewRows.value = []
  parseErrors.value = []
  importResult.value = null
  headerDiag.value = null
  sheetOptions.value = []
  selectedSheets.value = []
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
      // 以「网格」而非对象模式读取：对象模式固定把第 1 行当表头，而机构台账常是
      // 「第 1 行标题 + 第 2 行列名」，会一列都匹配不上并导致整表错位一列。
      // 网格 + csvToObjects 内的表头行探测可自动定位真表头（CSV 与 XLSX 同一套逻辑）。
      // 全部工作表都解析一遍，交给用户勾选（默认全选有数据的表），不再「取第一张就 break」。
      sheetOptions.value = wb.SheetNames.map((name) => {
        const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false, blankrows: false })
        const r = csvToObjects(grid, props.templateColumns)
        return { name, rows: grid.length, importable: r.objects.length, parsed: r }
      })
      const usable = sheetOptions.value.filter((o) => o.importable > 0)
      selectedSheets.value = usable.map((o) => o.name)
      if (!usable.length) {
        // 一张都解析不出数据时仍要给出诊断（缺失必填列 / 未识别列 / 表头行）
        const first = sheetOptions.value[0]
        applyParsed(first ? first.parsed : { objects: [], errors: [], unrecognized: [], missingRequired: [], header: [], headerRowIndex: 0 },
          { header: (first && first.parsed.header) || [] })
        return
      }
      applySelection()
    } catch (err) {
      ElMessage.error('Excel 解析失败：' + (err && err.message ? err.message : err))
    }
  }
  reader.readAsArrayBuffer(file)
  return false
}

// 按勾选的工作表合并解析结果（未勾选的表在预览头部明确提示，避免「以为全导了」）
const applySelection = () => {
  const chosen = sheetOptions.value.filter((o) => selectedSheets.value.includes(o.name))
  const merged = { objects: [], errors: [], unrecognized: [], missingRequired: [], header: [], headerRowIndex: 0 }
  for (const o of chosen) {
    const p = o.parsed
    merged.objects.push(...p.objects)
    // 错误信息带表名前缀：多表合并后用户才知道该去哪张表改
    merged.errors.push(...p.errors.map((e) => `[${o.name}] ${e}`))
    if (!merged.header.length) merged.header = p.header
    if (!merged.headerRowIndex && p.headerRowIndex) merged.headerRowIndex = p.headerRowIndex
    if (p.missingRequired.length) merged.missingRequired = p.missingRequired
  }
  const skippedSheets = sheetOptions.value.filter((o) => o.importable > 0 && !selectedSheets.value.includes(o.name))
  const parts = []
  if (chosen.length > 1) parts.push(`已合并 ${chosen.length} 个工作表：${chosen.map((o) => o.name).join('、')}`)
  if (skippedSheets.length) parts.push(`另有 ${skippedSheets.length} 个工作表未勾选：${skippedSheets.map((o) => o.name).join('、')}`)
  applyParsed(merged, { sheet: parts.join('；'), header: merged.header })
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
    // 去重口径按导入类型由调用方给出（成员看姓名+手机号、订单看收据单号）。
    // 旧文案对所有类型共用一段，订单导入也显示「姓名+手机号已存在的成员会被自动跳过」——
    // 规则串台；且「任一行失败整批回滚」不准确（行级校验失败只影响该行）。
    const rules = props.confirmRules || '行级校验失败只影响该行，不影响其余行。'
    await ElMessageBox.confirm(
      `即将导入 ${previewRows.value.length} 条数据${parseErrors.value.length ? `，${parseErrors.value.length} 行存在问题将跳过` : ''}。${rules}请确认无误后再继续。`,
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
    // toast 带上全量数字：此前 114 行失败时仍弹绿色「导入成功 23 条」，与失败量完全不成比例
    const failedN = (res.failed || []).length
    const skippedN = (res.skipped || []).length
    const warnN = (res.warnings || []).length
    const parts = [`成功 ${res.success || 0} 条`]
    if (failedN) parts.push(`失败 ${failedN} 条`)
    if (skippedN) parts.push(`跳过 ${skippedN} 条`)
    if (warnN) parts.push(`警告 ${warnN} 条`)
    const summary = `导入完成：${parts.join(' / ')}，详情见下方结果`
    if (failedN || skippedN || warnN) ElMessage.warning(summary)
    else ElMessage.success(summary)
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

/* 多工作表选择器 */
.sheet-picker {
  padding: 10px 12px;
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
  background: var(--t-bg-soft, transparent);
}

.sheet-picker-head {
  font-size: 12px;
  color: var(--t-text-2);
  margin-bottom: 6px;
}

.sheet-picker .el-checkbox-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

.sheet-picker .el-checkbox {
  margin-right: 0;
}
</style>
