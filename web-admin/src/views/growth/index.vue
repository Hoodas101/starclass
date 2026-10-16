<template>
  <div class="page-shell">
    <!-- 顶部标题 -->
<PageHeader v-if="!embedded" title="招生漏斗" />
    <!-- 顶部操作栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <el-select v-model="activeSection" style="width: 220px">
          <el-option label="线索管理" value="leads" />
          <el-option label="跟进任务" value="followups" />
          <el-option label="续费预警" value="renewal" />
          <el-option label="课时预警" value="lowclasses" />
          <el-option label="流失预警" value="churn" />
          <el-option label="转介绍" value="referrals" />
          <el-option label="跟进建议" value="suggestions" />
        </el-select>
      </div>
      <div class="toolbar-right">
        <el-button :icon="Download" @click="exportDialogRef?.open()">导出数据</el-button>
        <el-button type="primary" :icon="Plus" @click="openLeadDialog()">新建线索</el-button>
      </div>
    </div>

    <!-- 视图栏 + 字段设置：七个区块共用一套表格配置（按当前区块切换列定义） -->
    <div class="growth-viewbar">
      <TableViewBar
        :views="growthViews"
        :active-id="growthActiveView"
        @select="(id) => growthApplyView(id)"
        @create="(name) => growthCreateView(name)"
        @rename="growthRenameView"
        @remove="growthRemoveView"
      />
      <ColumnSettingsDialog
        title="增长字段设置"
        :columns="growthDefs"
        v-model:settings="growthSettings"
        :defaults="GROWTH_DEFAULTS"
        :widths="growthCustomWidths"
        :auto-width="growthAutoWidth"
        @update:widths="growthOnWidths"
        @update:auto-width="growthOnAutoWidth"
        @reset-widths="growthResetWidths"
      />
    </div>

    <!-- 漏斗概览 -->
    <div class="funnel-cards">
      <div class="funnel-card" v-for="s in funnel.stages" :key="s.stage">
        <div class="funnel-label">{{ s.label }}</div>
        <div class="funnel-count">{{ s.count }}</div>
      </div>
      <div class="funnel-card accent">
        <div class="funnel-label">转化率</div>
        <div class="funnel-count">{{ funnel.conversion }}%</div>
      </div>
    </div>

    <div class="metric-row">
      <div class="metric-card">
        <span class="metric-label">本月成交</span>
        <span class="metric-value">{{ funnel.monthOrder?.count || 0 }} 单 · ¥{{ Number(funnel.monthOrder?.amount || 0).toLocaleString() }}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">本月新建线索</span>
        <span class="metric-value">{{ funnel.monthLeads || 0 }}</span>
      </div>
      <div class="metric-card warn">
        <span class="metric-label">待跟进线索</span>
        <span class="metric-value">{{ funnel.followUp || 0 }}</span>
      </div>
    </div>

    <!-- 各区块通过二级下拉切换 -->
    <template v-if="activeSection === 'leads'">
        <div class="lead-view-bar">
          <el-radio-group v-model="leadView" size="small" @change="onLeadViewChange">
            <el-radio-button value="list">列表</el-radio-button>
            <el-radio-button value="kanban">管道</el-radio-button>
          </el-radio-group>
        </div>
        <div class="card table-container">
          <div class="filter-row">
            <el-input v-model="leadKeyword" placeholder="搜索姓名 / 电话" :prefix-icon="Search" clearable style="width: 200px" @change="onLeadFilterChange" @clear="onLeadFilterChange" />
            <el-select v-model="leadStage" placeholder="全部阶段" clearable style="width: 130px" @change="onLeadFilterChange">
              <el-option v-for="s in stageOptions" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
            <el-select v-model="leadSource" placeholder="全部来源" clearable style="width: 130px" @change="onLeadFilterChange">
              <el-option v-for="s in sourceOptions" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
          </div>
          <ListErrorState v-if="!leadLoading && errorLeads" :error="errorLeads" @retry="loadLeads" />
          <el-table v-else :data="growthSorted" v-loading="leadLoading" @row-click="openLeadDialog" row-class-name="clickable-row" size="small">
            <el-table-column
              v-for="col in growthVisible"
              :key="col.key"
              :label="col.label"
              :width="growthWidths[col.key] && growthWidths[col.key].width"
              :min-width="growthWidths[col.key] && growthWidths[col.key].minWidth"
              :fixed="col.fixed"
              :show-overflow-tooltip="col.tooltip"
            >
              <template #header>
                <SortableHeader
                  :label="col.label"
                  :state="growthSortState(col.key)"
                  :priority="growthSortPriority(col.key)"
                  :sortable="col.sortable !== false"
                  @sort="(e) => growthOnSort(col.key, e)"
                  @resize="(w) => growthOnResize(col.key, w)"
                />
              </template>
              <template #default="{ row }">
                <div v-if="col.render === 'leadName'" class="lead-name-cell">
                  <EntityAvatar :name="row.name" size="sm" :tone="row.stage === 'deal' ? 'success' : row.stage === 'lost' ? 'neutral' : 'accent'" />
                  <span class="lead-name">{{ row.name }}</span>
                  <el-tag v-if="row.source === 'referral'" size="small" effect="light" type="warning" style="margin-left: 2px">转介绍</el-tag>
                </div>
                <StatusDot v-else-if="col.render === 'stage'" :tone="stageDotTone(row.stage)" :label="row.stageText" subtle />
                <el-rate v-else-if="col.render === 'intent'" :model-value="row.intent_level" disabled :colors="['var(--t-warning)', 'var(--t-warning)', 'var(--t-warning)']" />
                <template v-else-if="col.render === 'source'">{{ sourceText(row.source) }}</template>
                <!-- next_follow_at 是未来时间，必须用 relativeDue：relativeTime 只处理过去
                     （diff = now - ts），未来时间会落进 diff < 1 分钟的分支而恒显示「刚刚」。 -->
                <template v-else-if="col.render === 'due'">{{ row.next_follow_at ? relativeDue(row.next_follow_at) : '—' }}</template>
                <template v-else>{{ row[col.key] }}</template>
              </template>
            </el-table-column>
          </el-table>
          <div class="pagination-wrap">
            <el-pagination v-model:current-page="leadPage" v-model:page-size="leadPageSize" :total="leadTotal" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next, jumper" background @current-change="loadLeads" @size-change="onLeadSizeChange" />
          </div>
        </div>

        <!-- 管道视图（借鉴 trycompai/crm 的 Deal pipeline） -->
        <div v-if="leadView === 'kanban'" class="pipeline-board" v-loading="pipelineLoading">
          <div v-for="col in pipelineColumns" :key="col.stage" class="pipeline-col">
            <div class="pipeline-col-header">
              <span class="pipeline-col-name">{{ col.label }}</span>
              <span class="pipeline-col-count">{{ col.items.length }}</span>
            </div>
            <div class="pipeline-col-body">
              <div role="button" tabindex="0" v-for="row in col.items" :key="row.id" class="pipeline-card" @click="openLeadDialog(row)" @keydown.enter="openLeadDialog(row)" @keydown.space.prevent="openLeadDialog(row)">
                <div class="pipeline-card-top">
                  <div class="pipeline-card-name-wrap">
                    <EntityAvatar :name="row.name" size="xs" />
                    <span class="pipeline-card-name">{{ row.name }}</span>
                  </div>
                  <el-tag v-if="row.source === 'referral'" size="small" effect="light" type="warning">转介绍</el-tag>
                </div>
                <div class="pipeline-card-phone">{{ row.phone || '未留电话' }}</div>
                <div class="pipeline-card-meta">
                  <el-rate :model-value="row.intent_level" disabled size="small" :colors="['var(--t-warning)', 'var(--t-warning)', 'var(--t-warning)']" />
                  <span class="pipeline-card-follow">跟进：{{ row.salesperson || '—' }}</span>
                </div>
                <div class="pipeline-card-footer">
                  <span v-if="row.next_follow_at" class="pipeline-card-next">下次 {{ relativeDue(row.next_follow_at) }}</span>
                  <el-select
                    v-model="row.stage"
                    size="small"
                    class="pipeline-stage-select"
                    :disabled="row.status === 'converted'"
                    @click.stop
                    @change="(val) => moveStage(row, val)"
                  >
                    <el-option v-for="s in stageOptions" :key="s.value" :label="s.label" :value="s.value" />
                  </el-select>
                </div>
              </div>
              <div v-if="!col.items.length" class="pipeline-col-empty">暂无线索</div>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="activeSection === 'followups'">
        <div class="card table-container">
          <div class="filter-row">
            <el-input v-model="fuKeyword" placeholder="搜索姓名 / 电话" :prefix-icon="Search" clearable style="width: 200px" @change="onFuFilterChange" @clear="onFuFilterChange" />
            <el-select v-model="fuStatus" placeholder="全部状态" clearable style="width: 130px" @change="onFuFilterChange">
              <el-option label="待办" value="pending" />
              <el-option label="已完成" value="done" />
              <el-option label="已取消" value="cancelled" />
            </el-select>
            <el-select v-model="fuType" placeholder="全部类型" clearable style="width: 130px" @change="onFuFilterChange">
              <el-option v-for="(label, value) in fuTypeOptions" :key="value" :label="label" :value="value" />
            </el-select>
            <el-button :icon="MagicStick" @click="handleGenerate">生成跟进任务</el-button>
            <el-button type="primary" :icon="Plus" @click="openFuDialog()">新建跟进</el-button>
          </div>
          <ListErrorState v-if="!fuLoading && errorFU" :error="errorFU" @retry="loadFollowUps" />
          <el-table v-else :data="growthSorted" v-loading="fuLoading" row-class-name="clickable-row" @row-click="onFollowupTap" size="small">
            <el-table-column
              v-for="col in growthVisible"
              :key="col.key"
              :label="col.label"
              :width="growthWidths[col.key] && growthWidths[col.key].width"
              :min-width="growthWidths[col.key] && growthWidths[col.key].minWidth"
              :show-overflow-tooltip="col.tooltip"
            >
              <template #header>
                <SortableHeader
                  :label="col.label"
                  :state="growthSortState(col.key)"
                  :priority="growthSortPriority(col.key)"
                  :sortable="col.sortable !== false"
                  @sort="(e) => growthOnSort(col.key, e)"
                  @resize="(w) => growthOnResize(col.key, w)"
                />
              </template>
              <template #default="{ row }">
                <template v-if="col.render === 'target'">
                  <span class="lead-name">{{ row.target_name || '—' }}</span>
                  <el-tag v-if="row.target_type === 'lead'" size="small" effect="plain" type="warning" style="margin-left: 6px">线索</el-tag>
                  <el-tag v-else size="small" effect="plain" type="info" style="margin-left: 6px">成员</el-tag>
                </template>
                <el-tag v-else-if="col.render === 'taskType'" :type="fuTagType(row.task_type)" size="small" effect="light">{{ row.taskTypeText }}</el-tag>
                <span v-else-if="col.render === 'fuDue'" :class="{ 'fu-overdue': row.status === 'pending' && Number(row.due_at) < Date.now() }">{{ relativeDue(row.due_at) }}</span>
                <StatusDot
                  v-else-if="col.render === 'fuStatus'"
                  :tone="row.status === 'pending' ? 'warning' : row.status === 'done' ? 'success' : 'neutral'"
                  :label="row.status === 'pending' ? '待办' : row.status === 'done' ? '已完成' : '已取消'"
                  subtle
                />
                <template v-else>{{ row[col.key] }}</template>
              </template>
            </el-table-column>
          </el-table>
          <div class="pagination-wrap">
            <el-pagination v-model:current-page="fuPage" v-model:page-size="fuPageSize" :total="fuTotal" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next, jumper" background @current-change="loadFollowUps" @size-change="onFuSizeChange" />
          </div>
        </div>
      </template>

      <template v-else-if="activeSection === 'renewal'">
        <div class="card table-container">
          <el-table :data="growthSorted" v-loading="renewalLoading" @row-click="(row) => goStudents(row.studentId)" row-class-name="clickable-row" size="small">
            <el-table-column
              v-for="col in growthVisible"
              :key="col.key"
              :label="col.label"
              :width="growthWidths[col.key] && growthWidths[col.key].width"
              :min-width="growthWidths[col.key] && growthWidths[col.key].minWidth"
              :fixed="col.fixed"
            >
              <template #header>
                <SortableHeader
                  :label="col.label"
                  :state="growthSortState(col.key)"
                  :priority="growthSortPriority(col.key)"
                  :sortable="col.sortable !== false"
                  @sort="(e) => growthOnSort(col.key, e)"
                  @resize="(w) => growthOnResize(col.key, w)"
                />
              </template>
              <template #default="{ row }">
                <template v-if="col.render === 'date'">{{ formatDate(row[col.key]) }}</template>
                <StatusDot
                  v-else-if="col.render === 'daysLeft'"
                  :tone="row.expired ? 'error' : row.daysLeft <= 7 ? 'warning' : 'neutral'"
                  :label="row.expired ? '已过期' : row.daysLeft + ' 天'"
                  subtle
                />
                <StatusDot
                  v-else-if="col.render === 'followUp'"
                  :tone="row.followUp ? 'success' : 'neutral'"
                  :label="row.followUp ? '跟进中' : '未跟进'"
                  subtle
                />
                <el-button
                  v-else-if="col.render === 'renewAction'"
                  link
                  type="primary"
                  size="small"
                  :disabled="!!row.followUp"
                  @click.stop="quickFollowUp(row, 'renewal')"
                >{{ row.followUp ? '已建' : '建跟进' }}</el-button>
                <template v-else>{{ row[col.key] }}</template>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="renewalList.length === 0" class="empty-tip">暂无需要续费的成员：近 15 天内没有到期卡，也没有过期未续的卡。</div>
        </div>
      </template>

      <template v-else-if="activeSection === 'lowclasses'">
        <div class="card table-container">
          <el-table :data="growthSorted" v-loading="lowClassLoading" @row-click="(row) => goStudents(row.student_id)" row-class-name="clickable-row" size="small">
            <el-table-column
              v-for="col in growthVisible"
              :key="col.key"
              :label="col.label"
              :width="growthWidths[col.key] && growthWidths[col.key].width"
              :min-width="growthWidths[col.key] && growthWidths[col.key].minWidth"
              :fixed="col.fixed"
            >
              <template #header>
                <SortableHeader
                  :label="col.label"
                  :state="growthSortState(col.key)"
                  :priority="growthSortPriority(col.key)"
                  :sortable="col.sortable !== false"
                  @sort="(e) => growthOnSort(col.key, e)"
                  @resize="(w) => growthOnResize(col.key, w)"
                />
              </template>
              <template #default="{ row }">
                <StatusDot
                  v-if="col.render === 'lowRemaining'"
                  :tone="row.remaining_classes <= 2 ? 'error' : 'warning'"
                  :label="row.remaining_classes + ' 节'"
                  subtle
                />
                <template v-else-if="col.render === 'date'">{{ formatDate(row[col.key]) }}</template>
                <StatusDot
                  v-else-if="col.render === 'followUp'"
                  :tone="row.followUp ? 'success' : 'neutral'"
                  :label="row.followUp ? '跟进中' : '未跟进'"
                  subtle
                />
                <el-button
                  v-else-if="col.render === 'lowAction'"
                  link
                  type="primary"
                  size="small"
                  :disabled="!!row.followUp"
                  @click.stop="quickFollowUp(row, 'low_class')"
                >{{ row.followUp ? '已建' : '建跟进' }}</el-button>
                <template v-else>{{ row[col.key] }}</template>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="lowClassList.length === 0" class="empty-tip">暂无课时不足的成员，消耗节奏健康。</div>
        </div>
      </template>

      <template v-else-if="activeSection === 'churn'">
        <div class="card table-container">
          <el-table :data="growthSorted" v-loading="churnLoading" @row-click="(row) => goStudents(row.studentId)" row-class-name="clickable-row" size="small">
            <el-table-column
              v-for="col in growthVisible"
              :key="col.key"
              :label="col.label"
              :width="growthWidths[col.key] && growthWidths[col.key].width"
              :min-width="growthWidths[col.key] && growthWidths[col.key].minWidth"
            >
              <template #header>
                <SortableHeader
                  :label="col.label"
                  :state="growthSortState(col.key)"
                  :priority="growthSortPriority(col.key)"
                  :sortable="col.sortable !== false"
                  @sort="(e) => growthOnSort(col.key, e)"
                  @resize="(w) => growthOnResize(col.key, w)"
                />
              </template>
              <template #default="{ row }">
                <template v-if="col.render === 'daysSince'">{{ row.daysSince != null ? row.daysSince + ' 天' : '—' }}</template>
                <StatusDot v-else-if="col.render === 'churnRisk'" :tone="row.risk === 'high' ? 'error' : 'warning'" :label="row.risk === 'high' ? '高' : '中'" subtle />
                <StatusDot v-else-if="col.render === 'churnExpired'" :tone="row.expired ? 'error' : 'neutral'" :label="row.expired ? '已过期' : '未续费'" subtle />
                <template v-else>{{ row[col.key] }}</template>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="churnList.length === 0" class="empty-tip">暂无流失风险成员，出勤保持得很好。</div>
        </div>
      </template>

      <template v-else-if="activeSection === 'referrals'">
        <div class="metric-row">
          <div class="metric-card">
            <span class="metric-label">转介绍线索</span>
            <span class="metric-value">{{ referrals.total }}</span>
          </div>
          <div class="metric-card">
            <span class="metric-label">已成交</span>
            <span class="metric-value">{{ referrals.converted }}</span>
          </div>
          <div class="metric-card accent">
            <span class="metric-label">转介绍转化率</span>
            <span class="metric-value">{{ referrals.conversion }}%</span>
          </div>
        </div>
        <div class="card table-container">
          <el-table :data="growthSorted" v-loading="referralLoading" size="small">
            <el-table-column
              v-for="col in growthVisible"
              :key="col.key"
              :label="col.label"
              :width="growthWidths[col.key] && growthWidths[col.key].width"
              :min-width="growthWidths[col.key] && growthWidths[col.key].minWidth"
              :show-overflow-tooltip="col.tooltip"
            >
              <template #header>
                <SortableHeader
                  :label="col.label"
                  :state="growthSortState(col.key)"
                  :priority="growthSortPriority(col.key)"
                  :sortable="col.sortable !== false"
                  @sort="(e) => growthOnSort(col.key, e)"
                  @resize="(w) => growthOnResize(col.key, w)"
                />
              </template>
              <template #default="{ row }">
                <StatusDot v-if="col.render === 'stage'" :tone="stageDotTone(row.stage)" :label="row.stageText" subtle />
                <template v-else-if="col.render === 'date'">{{ formatDate(row[col.key]) }}</template>
                <template v-else>{{ row[col.key] }}</template>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <div class="growth-tip">转介绍激励：在「系统设置 → 积分规则」配置老带新奖励积分，成交后在「积分管理」发放奖励。</div>
      </template>

      <template v-else-if="activeSection === 'suggestions'">
        <div class="card table-container">
          <div class="filter-row">
            <el-checkbox v-model="sugOnlyActionable" @change="loadSuggestions">仅看需要跟进</el-checkbox>
            <span class="sug-count">共 {{ suggestions.length }} 条建议</span>
          </div>
          <ListErrorState v-if="!sugLoading && errorSug" :error="errorSug" @retry="loadSuggestions" />
          <el-table v-else :data="growthSorted" v-loading="sugLoading" @row-click="(row) => openLeadDialog(row)" row-class-name="clickable-row" size="small">
            <el-table-column
              v-for="col in growthVisible"
              :key="col.key"
              :label="col.label"
              :width="growthWidths[col.key] && growthWidths[col.key].width"
              :min-width="growthWidths[col.key] && growthWidths[col.key].minWidth"
              :fixed="col.fixed"
              :show-overflow-tooltip="col.tooltip"
            >
              <template #header>
                <SortableHeader
                  :label="col.label"
                  :state="growthSortState(col.key)"
                  :priority="growthSortPriority(col.key)"
                  :sortable="col.sortable !== false"
                  @sort="(e) => growthOnSort(col.key, e)"
                  @resize="(w) => growthOnResize(col.key, w)"
                />
              </template>
              <template #default="{ row }">
                <div v-if="col.render === 'leadName'" class="lead-name-cell">
                  <EntityAvatar :name="row.name" size="sm" :tone="row.stage === 'deal' ? 'success' : row.stage === 'lost' ? 'neutral' : 'accent'" />
                  <span class="lead-name">{{ row.name }}</span>
                  <el-tag v-if="row.source === 'referral'" size="small" effect="light" type="warning" style="margin-left: 2px">转介绍</el-tag>
                </div>
                <StatusDot v-else-if="col.render === 'stage'" :tone="stageDotTone(row.stage)" :label="row.stageText" subtle />
                <el-tag v-else-if="col.render === 'priority'" :type="sugTagType(row.priority)" size="small" effect="light">{{ sugPriorityLabel(row.priority) }}</el-tag>
                <div v-else-if="col.render === 'evidence'" class="evi-chips">
                  <el-tag v-for="(ev, i) in row.evidence" :key="i" size="small" effect="plain" type="info">{{ ev.label }}</el-tag>
                </div>
                <template v-else-if="col.render === 'suggestAction'">
                  <el-button v-if="row.suggestedNextStage" type="primary" link size="small" @click.stop="moveStage(row, row.suggestedNextStage)">
                    推进到「{{ stageOptions.find((s) => s.value === row.suggestedNextStage)?.label }}」
                  </el-button>
                  <el-button v-else link size="small" @click.stop="openLeadDialog(row)">查看</el-button>
                </template>
                <template v-else>{{ row[col.key] }}</template>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!sugLoading && !errorSug && suggestions.length === 0" class="empty-tip">当前没有需要跟进的线索，跟进节奏很健康。</div>
        </div>
        <div class="growth-tip">「跟进建议」由系统基于线索阶段、停留时长、约定跟进时间、关联成员报名/到课等已观测事实实时推算，仅作提醒，最终由销售判断。</div>
      </template>

    <!-- 线索编辑弹窗 -->
    <el-dialog v-model="leadDialogOpen" :title="leadForm.id ? '编辑线索' : '新建线索'" class="dlg-md">
      <el-form ref="leadFormRef" :model="leadForm" :rules="leadRules" label-position="top">
        <div class="form-grid">
          <el-form-item label="姓名" prop="name">
            <el-input v-model="leadForm.name" placeholder="家长/成员姓名" maxlength="20" />
          </el-form-item>
          <el-form-item label="电话" prop="phone">
            <el-input v-model="leadForm.phone" placeholder="手机号" maxlength="11" />
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="线索来源">
            <el-select v-model="leadForm.source" style="width: 100%">
              <el-option v-for="s in sourceOptions" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="阶段">
            <el-select v-model="leadForm.stage" style="width: 100%">
              <el-option v-for="s in stageOptions" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="意向度">
            <el-rate v-model="leadForm.intentLevel" :colors="['var(--t-warning)', 'var(--t-warning)', 'var(--t-warning)']" />
          </el-form-item>
          <el-form-item label="跟进人">
            <el-input v-model="leadForm.salesperson" :placeholder="`${$t('sales')} / ${$t('instructor')}`" maxlength="20" />
          </el-form-item>
        </div>
        <el-form-item label="关联成员（选填，转成交可发奖励积分）">
          <el-select
            v-model="leadForm.studentId"
            filterable
            clearable
            placeholder="选择已登记成员（可空）"
            style="width: 100%"
          >
            <el-option v-for="s in leadStudentOptions" :key="s.id" :label="`${s.name}${s.parent_phone ? '（' + s.parent_phone + '）' : ''}`" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="下次跟进时间">
          <el-date-picker v-model="leadForm.nextFollowAt" type="datetime" placeholder="选择跟进时间" format="YYYY-MM-DD HH:mm" value-format="x" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="leadForm.note" type="textarea" :rows="2" placeholder="来源细节、需求、沟通记录" maxlength="200" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button v-if="leadForm.id" type="danger" plain @click="removeLead({ id: leadForm.id, name: leadForm.name })">删除</el-button>
        <el-button @click="leadDialogOpen = false">取消</el-button>
        <el-button v-if="leadForm.id && leadForm.status !== 'converted' && leadForm.stage !== 'deal'" type="success" plain @click="convertFromDialog">转成交</el-button>
        <el-button type="primary" @click="saveLead">{{ leadForm.id ? '保存' : '创建' }}</el-button>
      </template>
    </el-dialog>

    <!-- 跟进任务详情弹窗 -->
    <el-dialog v-model="fuDetailOpen" title="跟进任务" class="dlg-sm">
      <div v-if="fuDetail" class="fu-detail">
        <div class="fu-detail-row"><span class="fu-label">跟进对象</span><span class="fu-value">{{ fuDetail.target_name }}</span></div>
        <div class="fu-detail-row"><span class="fu-label">电话</span><span class="fu-value">{{ fuDetail.phone || '—' }}</span></div>
        <div class="fu-detail-row"><span class="fu-label">类型</span><span class="fu-value">{{ fuTypeOptions[fuDetail.task_type] || fuDetail.task_type }}</span></div>
        <div class="fu-detail-row"><span class="fu-label">负责人</span><span class="fu-value">{{ fuDetail.owner || '—' }}</span></div>
        <div class="fu-detail-row"><span class="fu-label">到期时间</span><span class="fu-value">{{ formatDateTime(fuDetail.due_at) }}</span></div>
        <div class="fu-detail-row"><span class="fu-label">跟进原因</span><span class="fu-value">{{ fuDetail.reason }}</span></div>
        <div class="fu-detail-row" v-if="fuDetail.note"><span class="fu-label">结果备注</span><span class="fu-value">{{ fuDetail.note }}</span></div>
      </div>
      <template #footer>
        <el-button @click="fuDetailOpen = false">关闭</el-button>
        <el-button v-if="fuDetail && fuDetail.status === 'pending'" type="danger" plain @click="cancelFuFromDetail">取消任务</el-button>
        <el-button v-if="fuDetail && fuDetail.status === 'pending'" type="success" @click="completeFuFromDetail">完成跟进</el-button>
      </template>
    </el-dialog>

    <!-- 新建跟进任务弹窗 -->
    <el-dialog v-model="fuDialogOpen" title="新建跟进任务" class="dlg-md">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="跟进类型">
            <el-radio-group v-model="fuForm.targetType">
              <el-radio-button value="student">{{ $t('learner') }}</el-radio-button>
              <el-radio-button value="lead">线索</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="fuForm.targetType === 'student' ? '选择成员' : '选择线索'" required>
            <el-select
              v-if="fuForm.targetType === 'student'"
              v-model="fuForm.targetId"
              filterable
              placeholder="选择成员"
              style="width: 100%"
              @change="onFuTargetChange"
            >
              <el-option v-for="s in fuStudentOptions" :key="s.id" :label="s.name" :value="String(s.id)" />
            </el-select>
            <el-select
              v-else
              v-model="fuForm.targetId"
              filterable
              placeholder="选择线索"
              style="width: 100%"
              @change="onFuTargetChange"
            >
              <el-option v-for="l in fuLeadOptions" :key="l.id" :label="`${l.name}${l.phone ? '（' + l.phone + '）' : ''}`" :value="String(l.id)" />
            </el-select>
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="任务类型">
            <el-select v-model="fuForm.taskType" style="width: 100%">
              <el-option v-for="(label, value) in fuTypeOptions" :key="value" :label="label" :value="value" />
            </el-select>
          </el-form-item>
          <el-form-item label="负责人">
            <el-input v-model="fuForm.owner" :placeholder="`${$t('sales')} / ${$t('instructor')}姓名`" maxlength="20" />
          </el-form-item>
        </div>
        <el-form-item label="跟进原因" required>
          <el-input v-model="fuForm.reason" type="textarea" :rows="2" placeholder="为什么跟进，例如：体验课后回访、提醒续费" maxlength="100" show-word-limit />
        </el-form-item>
        <el-form-item label="到期时间">
          <el-date-picker v-model="fuForm.dueAt" type="datetime" placeholder="选择到期时间" format="YYYY-MM-DD HH:mm" value-format="x" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="fuDialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="savingFu" @click="saveFu">新建任务</el-button>
      </template>
    </el-dialog>
  </div>

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出增长数据"
      description="选择时间范围后确认导出，留空导出全部数据。"
      @confirm="doExport"
    />
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { Search, Plus, Download, MagicStick } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import {
  getGrowthFunnel, getLeads, addLead, updateLead, deleteLead, convertLead,
  getChurnList, getRenewalList, getLowClasses, getReferrals, setLeadStage,
  getLeadSuggestions,
  getFollowUps, createFollowUp, completeFollowUp, cancelFollowUp, generateFollowUps,
  getStudents,
} from '@/api/modules'
import { exportXlsx } from '@/utils/xlsx'
import { fetchAllPages } from '@/utils/fetchAll'
import { relativeTime, relativeDue } from '@/utils/format'
import EntityAvatar from '@/components/EntityAvatar.vue'
import StatusDot from '@/components/StatusDot.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import PageHeader from '@/components/PageHeader.vue'
import SortableHeader from '@/components/SortableHeader.vue'
import TableViewBar from '@/components/TableViewBar.vue'
import ColumnSettingsDialog from '@/components/ColumnSettingsDialog.vue'
import { useTableKit, headerExtra } from '@/composables/useTableKit'

const router = useRouter()
const activeSection = ref('leads')
const exportDialogRef = ref(null)

const stageOptions = [
  { value: 'new', label: '新线索' },
  { value: 'contacted', label: '已联系' },
  { value: 'trial', label: '体验中' },
  { value: 'deal', label: '已成交' },
  { value: 'lost', label: '已流失' },
]
const sourceOptions = [
  { value: 'natural', label: '自然到访' },
  { value: 'referral', label: '转介绍' },
  { value: 'offline', label: '地推活动' },
  { value: 'online', label: '线上广告' },
  { value: 'other', label: '其他' },
]
const sourceText = (v) => sourceOptions.find((s) => s.value === v)?.label || v
const stageTagType = (s) => ({ new: 'info', contacted: 'primary', trial: 'warning', deal: 'success', lost: 'danger' }[s] || 'info')
const stageDotTone = (s) => ({ new: 'neutral', contacted: 'info', trial: 'warning', deal: 'success', lost: 'error' }[s] || 'neutral')

// 漏斗
const funnel = reactive({ stages: [], conversion: 0, monthOrder: {}, monthLeads: 0, followUp: 0 })
const loadFunnel = async () => {
  try {
    const res = await getGrowthFunnel()
    Object.assign(funnel, res)
  } catch (e) { /* 忽略 */ }
}

// 线索
const leads = ref([])
const leadTotal = ref(0)
const leadPage = ref(1)
const leadPageSize = ref(10)
const leadLoading = ref(false)
const leadKeyword = ref('')
const leadStage = ref('')
const leadSource = ref('')

const errorLeads = ref('')

// 筛选/每页条数变化时回到第 1 页：否则在第 N 页改条件可能落到新的空页
const onLeadFilterChange = () => { leadPage.value = 1; loadLeads() }
const onLeadSizeChange = () => { leadPage.value = 1; loadLeads() }

const loadLeads = async () => {
  errorLeads.value = ''
  leadLoading.value = true
  const seq = ++leadsSeq
  try {
    const res = await getLeads({
      page: leadPage.value, pageSize: leadPageSize.value,
      keyword: leadKeyword.value || undefined,
      stage: leadStage.value || undefined,
      source: leadSource.value || undefined,
    })
    if (seq !== leadsSeq) return
    leads.value = res?.list || []
    leadTotal.value = res?.total || 0
  } catch (e) {
    if (seq !== leadsSeq) return
    errorLeads.value = e?.message || '数据加载失败，请稍后重试'
    leads.value = []
  } finally {
    if (seq === leadsSeq) leadLoading.value = false
  }
}

const leadDialogOpen = ref(false)
const leadFormRef = ref(null)
const leadForm = reactive({ id: '', name: '', phone: '', source: 'natural', stage: 'new', intentLevel: 3, nextFollowAt: null, note: '', salesperson: '', studentId: '', status: '' })
const leadRules = {
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  phone: [{ pattern: /^1\d{10}$/, message: '请输入11位有效手机号', trigger: 'blur' }],
}
const leadStudentOptions = ref([])

const openLeadDialog = async (row) => {
  Object.assign(leadForm, row
    ? { id: row.id, name: row.name, phone: row.phone, source: row.source, stage: row.stage, intentLevel: row.intent_level ?? row.intentLevel, nextFollowAt: row.next_follow_at ?? row.nextFollowAt, note: row.note, salesperson: row.salesperson, studentId: row.student_id || row.studentId || '', status: row.status || '' }
    : { id: '', name: '', phone: '', source: 'natural', stage: 'new', intentLevel: 3, nextFollowAt: null, note: '', salesperson: '', studentId: '', status: '' })
  // 关联成员选项（在籍成员，供转成交发奖励积分使用）
  try {
    const res = await getStudents({ page: 1, pageSize: 200, status: 'active', archived: '0' })
    leadStudentOptions.value = res?.list || []
  } catch (e) {
    leadStudentOptions.value = []
  }
  leadDialogOpen.value = true
  // 上次编辑残留的校验红字清空
  nextTick(() => leadFormRef.value?.clearValidate())
}

const saveLead = async () => {
  const valid = await leadFormRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    if (leadForm.id) {
      await updateLead(leadForm.id, { ...leadForm })
    } else {
      await addLead({ ...leadForm })
    }
    ElMessage.success(leadForm.id ? '已保存' : '线索已创建')
    leadDialogOpen.value = false
    loadLeads(); loadFunnel()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

const removeLead = async (row) => {
  try {
    await ElMessageBox.confirm(`确定删除线索「${row.name}」吗？`, '删除确认', { type: 'warning', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' })
  } catch (e) {
    return // 用户取消
  }
  await deleteLead(row.id)
  ElMessage.success('已删除')
  loadLeads(); loadFunnel()
}

// 转成交：可选择一并建档 + 生成待收银订单。
// 此前销售点完「成交」还要去成员页把同一个孩子重录一遍（姓名/手机号/家长），
// 是典型的重复录入；这里让一次点击把线索→成员→订单串起来。
const runConvert = async (id, leadName, hasStudent) => {
  let createStudent = false
  if (!hasStudent) {
    try {
      await ElMessageBox.confirm(
        `是否同时为「${leadName}」创建成员档案并生成待收银订单？\n后续只需在收银台补全卡种与金额。若该线索的手机号已存在成员，系统会自动关联到已有档案而不会重复新建。`,
        '一并建档',
        {
          confirmButtonText: '建档并生成订单',
          cancelButtonText: '仅标记成交',
          type: 'warning',
        }
      )
      createStudent = true
    } catch (e) {
      createStudent = false // 取消 / 关闭 → 仅标记成交
    }
  }
  const res = await convertLead(id, { createStudent, createOrder: createStudent })
  let msg = '已标记成交'
  if (res && res.studentLinked) msg = '已标记成交，并关联到已有成员档案（未重复新建）'
  else if (res && res.studentCreated) msg = '已标记成交，已创建成员档案与待收银订单'
  else if (res && res.studentSkipped) msg = `已标记成交；${res.studentSkipped}`
  ElMessage.success(msg)
  // 一个家长手机号可能绑定多个孩子（兄弟姐妹），此时无法自动判断应关联谁
  if (res && res.duplicate && res.duplicate.length > 1) {
    ElMessageBox.alert(
      `该线索的手机号关联了 ${res.duplicate.length} 名成员，未能自动判断应关联哪一个。请到成员页手动关联，或改用能唯一标识该成员的手机号后重试。`,
      '需人工确认关联成员',
      { type: 'warning' }
    )
  }
}

const handleConvert = async (row) => {
  try {
    await ElMessageBox.confirm(`确认将「${row.name}」标记为已成交？`, '转成交', { type: 'success' })
  } catch (e) {
    return // 用户取消
  }
  await runConvert(row.id, row.name, !!row.student_id)
  loadLeads(); loadFunnel()
}

const convertFromDialog = async () => {
  try {
    await ElMessageBox.confirm(`确认将「${leadForm.name}」标记为已成交？`, '转成交', { type: 'success' })
  } catch (e) {
    return // 用户取消
  }
  await runConvert(leadForm.id, leadForm.name, !!leadForm.student_id)
  leadDialogOpen.value = false
  loadLeads(); loadFunnel()
}

// 跟进任务详情
const fuDetailOpen = ref(false)
const fuDetail = ref(null)
const openFuDetail = (row) => {
  fuDetail.value = row
  fuDetailOpen.value = true
}
const completeFuFromDetail = async () => {
  const row = fuDetail.value
  if (!row) return
  const { value } = await ElMessageBox.prompt(`完成跟进「${row.target_name}」？可填写跟进结果备注`, '完成跟进', {
    confirmButtonText: '完成',
    cancelButtonText: '取消',
    inputPlaceholder: '例如：已电话联系家长，约定周六到店体验',
    inputValue: row.note || '',
  }).catch(() => ({ value: undefined }))
  if (value === undefined) return
  await completeFollowUp(row.id, { note: value || '' })
  ElMessage.success('已完成')
  fuDetailOpen.value = false
  loadFollowUps()
}
const cancelFuFromDetail = async () => {
  const row = fuDetail.value
  if (!row) return
  try {
    await ElMessageBox.confirm(`确定取消「${row.target_name}」的跟进任务吗？`, '取消跟进', { type: 'warning', confirmButtonText: '取消', confirmButtonClass: 'el-button--danger' })
  } catch (e) {
    return // 用户取消
  }
  try {
    await cancelFollowUp(row.id)
    ElMessage.success('已取消')
    fuDetailOpen.value = false
    loadFollowUps()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

// ============================================
// 销售管道（借鉴 trycompai/crm 的 Deal pipeline）
// ============================================
const leadView = ref('list')
const pipelineLoading = ref(false)
const pipelineAll = ref([])

const pipelineColumns = computed(() =>
  stageOptions.map((s) => ({
    ...s,
    items: pipelineAll.value.filter((l) => l.stage === s.value),
  }))
)

// 请求序号：防止慢网下旧搜索/翻页响应后到覆盖新结果
let leadsSeq = 0
let pipelineSeq = 0

const loadPipeline = async () => {
  pipelineLoading.value = true
  const seq = ++pipelineSeq
  try {
    const res = await getLeads({ page: 1, pageSize: 100, keyword: leadKeyword.value || undefined, source: leadSource.value || undefined })
    if (seq !== pipelineSeq) return
    pipelineAll.value = (res?.list || []).filter((l) => l.status !== 'lost')
  } catch (e) {
    if (seq !== pipelineSeq) return
    pipelineAll.value = []
  } finally {
    if (seq === pipelineSeq) pipelineLoading.value = false
  }
}

const onLeadViewChange = (val) => {
  if (val === 'kanban') loadPipeline()
}

const moveStage = async (row, stage) => {
  try {
    await setLeadStage(row.id, { stage })
    row.stageText = stageOptions.find((s) => s.value === stage)?.label || stage
    if (stage === 'deal') row.status = 'converted'
    ElMessage.success(`已推进到「${stageOptions.find((s) => s.value === stage)?.label}」`)
    loadPipeline(); loadFunnel(); loadLeads(); loadSuggestions()
  } catch (e) {
    loadPipeline()
    // 拦截器已提示业务/网络错误
  }
}

// ============================================
// 跟进任务（借鉴 trycompai/crm 的 Activity.dueAt + AgentTask 队列）
// ============================================
const followUps = ref([])
const fuTotal = ref(0)
const fuPage = ref(1)
const fuPageSize = ref(10)
const fuLoading = ref(false)
const fuKeyword = ref('')
const fuStatus = ref('')
const fuType = ref('')
const fuTypeOptions = { renewal: '续费跟进', lead_followup: '线索跟进', trial_followup: '体验跟进', churn_winback: '流失挽回', low_class: '课时续费', other: '其他' }
const fuTagType = (t) => ({ renewal: 'warning', lead_followup: 'primary', trial_followup: 'success', churn_winback: 'danger', low_class: 'danger', other: 'info' }[t] || 'info')

const errorFU = ref('')

// 筛选/每页条数变化时回到第 1 页
const onFuFilterChange = () => { fuPage.value = 1; loadFollowUps() }
const onFuSizeChange = () => { fuPage.value = 1; loadFollowUps() }

const loadFollowUps = async () => {
  errorFU.value = ''
  fuLoading.value = true
  try {
    const res = await getFollowUps({
      page: fuPage.value,
      pageSize: fuPageSize.value,
      keyword: fuKeyword.value || undefined,
      status: fuStatus.value || undefined,
      taskType: fuType.value || undefined,
    })
    followUps.value = res?.list || []
    fuTotal.value = res?.total || 0
  } catch (e) {
    errorFU.value = e?.message || '数据加载失败，请稍后重试'
    followUps.value = []
  } finally {
    fuLoading.value = false
  }
}

const handleGenerate = async () => {
  try {
    const res = await generateFollowUps()
    ElMessage.success(res.message || '已生成')
    loadFollowUps()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

const fuDialogOpen = ref(false)
const savingFu = ref(false)   // 提交防重复：创建跟进任务时置灰
const fuStudentOptions = ref([])
const fuLeadOptions = ref([])
const fuForm = reactive({ targetType: 'student', targetId: '', targetName: '', phone: '', taskType: 'other', owner: '', reason: '', dueAt: null })
const openFuDialog = async () => {
  Object.assign(fuForm, { targetType: 'student', targetId: '', targetName: '', phone: '', taskType: 'other', owner: '', reason: '', dueAt: Date.now() + 86400000 })
  fuDialogOpen.value = true
  try {
    const [stuRes, leadRes] = await Promise.all([
      getStudents({ page: 1, pageSize: 200, status: 'active', archived: '0' }),
      getLeads({ page: 1, pageSize: 100 })
    ])
    fuStudentOptions.value = stuRes?.list || []
    fuLeadOptions.value = leadRes?.list || []
  } catch (e) {
    // 拦截器已提示
  }
}

const onFuTargetChange = (id) => {
  const list = fuForm.targetType === 'student' ? fuStudentOptions.value : fuLeadOptions.value
  const item = list.find((x) => String(x.id) === String(id))
  if (item) {
    fuForm.targetName = item.name
    fuForm.phone = item.phone || ''
  }
}

const saveFu = async () => {
  if (!fuForm.targetId) { ElMessage.warning('请选择跟进对象'); return }
  if (!fuForm.reason) { ElMessage.warning('请填写跟进原因'); return }
  savingFu.value = true
  try {
    await createFollowUp({
      targetType: fuForm.targetType,
      targetId: String(fuForm.targetId),
      targetName: fuForm.targetName,
      phone: fuForm.phone,
      taskType: fuForm.taskType,
      reason: fuForm.reason,
      owner: fuForm.owner,
      dueAt: fuForm.dueAt,
    })
    ElMessage.success('跟进任务已创建')
    fuDialogOpen.value = false
    loadFollowUps()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    savingFu.value = false
  }
}

const handleCompleteFu = async (row) => {
  const { value } = await ElMessageBox.prompt(`完成跟进「${row.target_name}」？可填写跟进结果备注`, '完成跟进', {
    confirmButtonText: '完成',
    cancelButtonText: '取消',
    inputPlaceholder: '例如：已电话联系家长，约定周六到店体验',
    inputValue: row.note || '',
  }).catch(() => ({ value: undefined }))
  if (value === undefined) return
  try {
    await completeFollowUp(row.id, { note: value || '' })
    ElMessage.success('已完成')
    loadFollowUps()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

const handleCancelFu = async (row) => {
  try {
    await ElMessageBox.confirm(`确定取消「${row.target_name}」的跟进任务吗？`, '取消跟进', { type: 'warning', confirmButtonText: '取消', confirmButtonClass: 'el-button--danger' })
  } catch (e) {
    return // 用户取消
  }
  try {
    await cancelFollowUp(row.id)
    ElMessage.success('已取消')
    loadFollowUps()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

// 记录关联（CRM RecordLink）：成员任务直达成员详情，线索任务回到线索管理
const onFollowupTap = (row) => {
  if (row.status === 'pending') {
    openFuDetail(row)
    return
  }
  if (row.target_type === 'student' && row.target_id && row.target_id !== 'manual') {
    router.push(`/students?focus=${row.target_id}`)
  } else if (row.target_type === 'lead') {
    // 回到「线索管理」区块。旧写法 router.push('/growth?tab=leads') 会命中旧路径
    // redirect → /sales?tab=growth，重定向会丢弃原 query 且区块不切换 —— 点了没反应。
    // 改为跳真实路由 /sales?tab=growth，并直接把区块切到 leads。
    activeSection.value = 'leads'
    router.push({ path: '/sales', query: { tab: 'growth' } }).catch(() => {})
  }
}

const formatDateTime = (ts) => {
  if (!ts) return '—'
  return dayjs(Number(ts)).format('MM-DD HH:mm')
}

// 续费预警
const renewalList = ref([])
const renewalLoading = ref(false)
const loadRenewal = async () => {
  renewalLoading.value = true
  try {
    const res = await getRenewalList({ warnIn: 15 })
    renewalList.value = res?.list || []
  } finally { renewalLoading.value = false }
}

// 低课时预警
const lowClassList = ref([])
const lowClassLoading = ref(false)
const loadLowClasses = async () => {
  lowClassLoading.value = true
  try {
    const res = await getLowClasses({ threshold: 5 })
    lowClassList.value = res?.list || []
  } finally { lowClassLoading.value = false }
}

// 预警清单一键建跟进：免去切到「跟进任务」区块重新选人填原因
const quickFollowUp = async (row, taskType) => {
  const studentId = row.studentId || row.student_id
  const name = row.studentName || row.student_name
  if (!studentId) { ElMessage.warning('该记录未关联成员，无法建立跟进'); return }
  const reason = taskType === 'low_class'
    ? `「${row.cardType || row.card_type_name || '次卡'}」仅剩 ${row.remainingClasses ?? row.remaining_classes} 节，需提醒续课`
    : `「${row.cardType || row.card_type_name || '会员卡'}」${row.expired ? '已过期' : `${row.daysLeft} 天后到期`}，需提醒续费`
  try {
    await createFollowUp({
      targetType: 'student',
      targetId: String(studentId),
      targetName: name,
      taskType,
      reason,
    })
    ElMessage.success('跟进任务已创建')
    loadRenewal(); loadLowClasses(); loadFollowUps()
  } catch (e) {
    // 拦截器已提示业务/网络错误
  }
}

// 流失预警
const churnList = ref([])
const churnLoading = ref(false)
const loadChurn = async () => {
  churnLoading.value = true
  try {
    const res = await getChurnList()
    churnList.value = res?.list || []
  } finally { churnLoading.value = false }
}

// 转介绍
const referrals = reactive({ total: 0, converted: 0, conversion: 0, list: [] })
const referralLoading = ref(false)
const loadReferrals = async () => {
  referralLoading.value = true
  try {
    const res = await getReferrals()
    Object.assign(referrals, res)
  } finally { referralLoading.value = false }
}

// ============================================
// 跟进建议（业务层证据→建议，单一计算源）
// ============================================
const suggestions = ref([])
const sugLoading = ref(false)
const errorSug = ref('')
const sugOnlyActionable = ref(false)
const sugTagType = (p) => ({ urgent: 'danger', high: 'warning', normal: 'info', low: '', none: 'success' }[p] || 'info')
const sugPriorityLabel = (p) => ({ urgent: '紧急', high: '高', normal: '普通', low: '低', none: '无需跟进' }[p] || p)

// ============================================
// 多维表格：排序 / 列宽 / 视图（与学员档案、销售表同一套能力）
// 七个区块共用**一个** kit：同一时刻只渲染一个区块，visibleDefs/sortedRows 恒与当前区块一致。
// render 字段驱动单元格渲染（各区块单元格差异大，逐列声明渲染类型）。
// 注意：列显隐/列宽按「列 key」共享 —— 同名 key（如 phone）在多个区块会一起显隐或同宽。
// 这是有意的：七套独立配置对使用者是负担，且同名列语义本就相同（都是「电话」）。
// ============================================
const GROWTH_DEFS = {
  leads: [
    { key: 'name', label: '姓名', minWidth: 120, render: 'leadName' },
    { key: 'phone', label: '电话', minWidth: 130, render: 'text' },
    { key: 'stage', label: '阶段', minWidth: 100, render: 'stage' },
    { key: 'intent_level', label: '意向度', minWidth: 140, render: 'intent' },
    { key: 'source', label: '来源', minWidth: 100, render: 'source' },
    { key: 'salesperson', label: '跟进人', minWidth: 100, render: 'text' },
    { key: 'next_follow_at', label: '下次跟进', minWidth: 130, render: 'due' },
  ],
  followups: [
    { key: 'target_name', label: '跟进对象', minWidth: 150, render: 'target' },
    { key: 'phone', label: '电话', minWidth: 130, render: 'text' },
    { key: 'task_type', label: '类型', minWidth: 100, render: 'taskType' },
    { key: 'reason', label: '跟进原因', minWidth: 220, tooltip: true, render: 'text' },
    { key: 'owner', label: '负责人', minWidth: 100, render: 'text' },
    { key: 'due_at', label: '到期时间', minWidth: 130, render: 'fuDue' },
    { key: 'status', label: '状态', minWidth: 90, render: 'fuStatus' },
  ],
  renewal: [
    { key: 'studentName', label: '成员', minWidth: 140, render: 'text' },
    { key: 'cardType', label: '卡种', minWidth: 110, render: 'text' },
    { key: 'expiresAt', label: '到期时间', minWidth: 150, render: 'date' },
    { key: 'daysLeft', label: '剩余天数', minWidth: 100, render: 'daysLeft' },
    { key: 'recentAttendance', label: '近30天出勤', minWidth: 110, render: 'text' },
    { key: 'followUp', label: '跟进状态', minWidth: 110, render: 'followUp' },
    { key: 'actions', label: '操作', minWidth: 120, fixed: 'right', sortable: false, render: 'renewAction' },
  ],
  lowclasses: [
    { key: 'student_name', label: '成员', minWidth: 140, render: 'text' },
    { key: 'card_type_name', label: '卡种', minWidth: 120, render: 'text' },
    { key: 'remaining_classes', label: '剩余课时', minWidth: 100, render: 'lowRemaining' },
    { key: 'expires_at', label: '到期时间', minWidth: 150, render: 'date' },
    { key: 'recent_count', label: '近30天出勤', minWidth: 110, render: 'text' },
    { key: 'followUp', label: '跟进状态', minWidth: 110, render: 'followUp' },
    { key: 'actions', label: '操作', minWidth: 120, fixed: 'right', sortable: false, render: 'lowAction' },
  ],
  churn: [
    { key: 'name', label: '成员', minWidth: 140, render: 'text' },
    { key: 'lastAttendance', label: '最后出勤', minWidth: 140, render: 'text' },
    { key: 'daysSince', label: '停课天数', minWidth: 110, render: 'daysSince' },
    { key: 'risk', label: '风险等级', minWidth: 110, render: 'churnRisk' },
    { key: 'expired', label: '状态', minWidth: 110, render: 'churnExpired' },
  ],
  referrals: [
    { key: 'name', label: '姓名', minWidth: 140, render: 'text' },
    { key: 'phone', label: '电话', minWidth: 140, render: 'text' },
    { key: 'stage', label: '阶段', minWidth: 100, render: 'stage' },
    { key: 'note', label: '备注', minWidth: 200, tooltip: true, render: 'text' },
    { key: 'created_at', label: '录入时间', minWidth: 150, render: 'date' },
  ],
  suggestions: [
    { key: 'name', label: '姓名', minWidth: 130, render: 'leadName' },
    { key: 'stage', label: '阶段', minWidth: 100, render: 'stage' },
    { key: 'priority', label: '优先级', minWidth: 100, render: 'priority' },
    // 证据是标签数组，排序无意义
    { key: 'evidence', label: '证据（已观测事实）', minWidth: 280, render: 'evidence', sortable: false },
    { key: 'suggestedAction', label: '建议动作', minWidth: 260, tooltip: true, render: 'text' },
    { key: 'actions', label: '操作', minWidth: 130, fixed: 'right', sortable: false, render: 'suggestAction' },
  ],
}
const GROWTH_DEFAULTS = Object.fromEntries(
  Object.values(GROWTH_DEFS).flat().map((c) => [c.key, true])
)

const growthDefs = computed(() => GROWTH_DEFS[activeSection.value] || [])
const growthRows = computed(() => ({
  leads: leads.value,
  followups: followUps.value,
  renewal: renewalList.value,
  lowclasses: lowClassList.value,
  churn: churnList.value,
  referrals: referrals.list,
  suggestions: suggestions.value,
}[activeSection.value] || []))

// 单元格纯文本：供列宽实测（与模板渲染保持一致）
const growthText = (col, row) => {
  switch (col.render) {
    case 'leadName': return row.name || ''
    case 'stage': return row.stageText || ''
    case 'intent': return '★'.repeat(Number(row.intent_level) || 0)
    case 'source': return sourceText(row.source)
    case 'due': return row.next_follow_at ? relativeDue(row.next_follow_at) : ''
    case 'target': return row.target_name || ''
    case 'taskType': return row.taskTypeText || ''
    case 'fuDue': return relativeDue(row.due_at)
    case 'fuStatus': return row.status === 'pending' ? '待办' : row.status === 'done' ? '已完成' : '已取消'
    case 'date': return formatDate(row[col.key])
    case 'daysLeft': return row.expired ? '已过期' : `${row.daysLeft} 天`
    case 'followUp': return row.followUp ? '跟进中' : '未跟进'
    case 'renewAction': case 'lowAction': return ''
    case 'daysSince': return row.daysSince != null ? `${row.daysSince} 天` : ''
    case 'churnRisk': return row.risk === 'high' ? '高' : '中'
    case 'churnExpired': return row.expired ? '已过期' : '未续费'
    case 'priority': return sugPriorityLabel(row.priority)
    case 'evidence': return (row.evidence || []).map((e) => e.label).join(' ')
    case 'suggestAction': return ''
    default: return row[col.key] == null ? '' : String(row[col.key])
  }
}
// 排序取值：金额/数量/时间按数值或时间戳，其余按文本（中文走拼音序）
const growthSortValue = (key, row) => {
  switch (key) {
    case 'intent_level': return Number(row.intent_level || 0)
    case 'daysLeft': return Number(row.daysLeft || 0)
    case 'daysSince': return row.daysSince == null ? null : Number(row.daysSince)
    case 'recentAttendance': case 'recent_count': return Number(row[key] || 0)
    case 'next_follow_at': return row.next_follow_at || null
    case 'due_at': return row.due_at || null
    case 'expiresAt': case 'expires_at': return row[key] || null
    case 'created_at': return row.created_at || null
    default: return growthText({ key, render: (GROWTH_DEFS[activeSection.value] || []).find((c) => c.key === key)?.render }, row)
  }
}

const {
  settings: growthSettings, visibleDefs: growthVisible, colWidths: growthWidths,
  sortedRows: growthSorted, sortState: growthSortState, sortPriority: growthSortPriority,
  onSort: growthOnSort, onResize: growthOnResize,
  customWidths: growthCustomWidths, autoColumnWidth: growthAutoWidth,
  onWidthsChange: growthOnWidths, onAutoWidthChange: growthOnAutoWidth, resetWidths: growthResetWidths,
  viewList: growthViews, activeViewId: growthActiveView,
  applyView: growthApplyView, createView: growthCreateView, renameView: growthRenameView,
  removeView: growthRemoveView, load: growthLoadKit,
} = useTableKit({
  settingsKey: 'growth_columns',
  defs: () => growthDefs.value,
  rows: growthRows,
  textOf: growthText,
  getValue: growthSortValue,
  defaults: GROWTH_DEFAULTS,
  extraOf: headerExtra,
})

const loadSuggestions = async () => {
  errorSug.value = ''
  sugLoading.value = true
  try {
    const res = await getLeadSuggestions({ onlyActionable: sugOnlyActionable.value ? '1' : '0', limit: 200 })
    suggestions.value = res?.list || []
  } catch (e) {
    errorSug.value = e?.message || '数据加载失败，请稍后重试'
    suggestions.value = []
  } finally {
    sugLoading.value = false
  }
}

const formatDate = (ts) => {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const goStudents = (id) => router.push(`/students?focus=${id}`)

// 导出全部增长数据（线索 / 续费预警 / 课时预警 / 流失预警）
const doExport = async (range) => {
  const sheets = []
  try {
    const items = await fetchAllPages(getLeads, {
      keyword: leadKeyword.value || undefined,
      stage: leadStage.value || undefined,
      source: leadSource.value || undefined,
      startDate: range?.[0] || undefined,
      endDate: range?.[1] || undefined,
    })
    if (items.length) {
      sheets.push({
        name: '线索管理',
        headers: ['姓名', '电话', '阶段', '意向度', '来源', '跟进人', '下次跟进', '备注'],
        rows: items.map((row) => [
          row.name || '',
          row.phone || '',
          stageOptions.find((s) => s.value === row.stage)?.label || row.stage || '',
          row.intent_level ?? '',
          sourceText(row.source),
          row.salesperson || '',
          row.next_follow_at ? formatDate(row.next_follow_at) : '—',
          row.note || ''
        ])
      })
    }
  } catch (e) { /* 忽略 */ }

  if (renewalList.value.length) {
    sheets.push({
      name: '续费预警',
      headers: ['成员', '卡种', '到期时间', '剩余天数', '近30天出勤'],
      rows: renewalList.value.map((row) => [
        row.studentName || '',
        row.cardType || '',
        formatDate(row.expiresAt),
        row.expired ? '已过期' : `${row.daysLeft} 天`,
        row.recentAttendance ?? ''
      ])
    })
  }

  if (lowClassList.value.length) {
    sheets.push({
      name: '课时预警',
      headers: ['成员', '卡种', '剩余课时', '到期时间', '近30天出勤'],
      rows: lowClassList.value.map((row) => [
        row.student_name || '',
        row.card_type_name || '',
        row.remaining_classes ?? '',
        formatDate(row.expires_at),
        row.recent_count ?? ''
      ])
    })
  }

  if (churnList.value.length) {
    sheets.push({
      name: '流失预警',
      headers: ['成员', '最后出勤', '停课天数', '风险等级', '状态'],
      rows: churnList.value.map((row) => [
        row.name || '',
        row.lastAttendance || '',
        row.daysSince != null ? `${row.daysSince} 天` : '—',
        row.risk === 'high' ? '高' : '中',
        row.expired ? '已过期' : '未续费'
      ])
    })
  }

  let fuItems = followUps.value
  try {
    if (range && range.length === 2) {
      fuItems = await fetchAllPages(getFollowUps, {
        startDate: range[0],
        endDate: range[1],
      })
    }
  } catch (e) { /* 忽略，使用当前列表 */ }
  if (fuItems.length) {
    sheets.push({
      name: '跟进任务',
      headers: ['对象', '电话', '类型', '原因', '负责人', '到期时间', '状态'],
      rows: fuItems.map((row) => [
        row.target_name || '',
        row.phone || '',
        row.taskTypeText || '',
        row.reason || '',
        row.owner || '',
        formatDateTime(row.due_at),
        row.status === 'pending' ? '待办' : row.status === 'done' ? '已完成' : '已取消'
      ])
    })
  }

  if (!sheets.length) {
    ElMessage.warning('暂无可导出的增长数据')
    return
  }
  exportXlsx(`增长中心_${dayjs().format('YYYYMMDD')}`, sheets)
  ElMessage.success(`已导出 ${sheets.length} 个工作表`)
}

onMounted(() => {
  growthLoadKit()
  loadFunnel(); loadLeads(); loadRenewal(); loadLowClasses(); loadChurn(); loadReferrals(); loadFollowUps()
})

watch(activeSection, (v) => {
  if (v === 'suggestions') loadSuggestions()
})
</script>

<style lang="scss" scoped>
.funnel-cards {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: var(--t-spacing-md);
  margin-bottom: var(--t-spacing-lg);
}

.funnel-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-lg);
  padding: var(--t-spacing-md);  text-align: center;

  &.accent {
    background: var(--t-accent-bg);
    border-color: var(--t-accent-line);

    .funnel-count { color: var(--t-accent-text); }
  }
}

.funnel-label {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  margin-bottom: var(--t-spacing-xs);
}

.funnel-count {
  font-size: var(--t-fs-2xl);
  font-weight: 700;
  color: var(--t-text-1);
  font-variant-numeric: tabular-nums;
}

.metric-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--t-spacing-md);
  margin-bottom: var(--t-spacing-lg);
}

.metric-card {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-lg);
  padding: var(--t-spacing-md) var(--t-spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--t-spacing-xs);
  &.accent {
    background: var(--t-accent-bg);
    border-color: var(--t-accent-line);
    .metric-value { color: var(--t-accent-text); }
  }
}

.metric-label { font-size: var(--t-fs-xs); color: var(--t-text-3); }
.metric-value { font-size: var(--t-fs-base); font-weight: 700; color: var(--t-text-1); font-variant-numeric: tabular-nums; }


.table-container {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-lg);
  padding: 24px;  overflow-x: auto;
}

.filter-row {
  display: flex;
  gap: var(--t-spacing-md);
  margin-bottom: var(--t-spacing-lg);
  flex-wrap: wrap;
}

.lead-name { font-weight: 600; color: var(--t-text-1); }
.lead-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.empty-tip {
  text-align: center;
  color: var(--t-text-3);
  padding: var(--t-spacing-2xl) 0;
  font-size: var(--t-fs-base);
}

.evi-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sug-count {
  align-self: center;
  margin-left: auto;
  color: var(--t-text-3);
  font-size: var(--t-fs-sm);
}

.growth-tip {
  margin-top: var(--t-spacing-lg);
  padding: var(--t-spacing-md) var(--t-spacing-lg);
  border-radius: var(--t-radius-lg);
  background: var(--t-accent-bg);
  border: 1px solid var(--t-accent-line);
  color: var(--t-accent-text);
  font-size: var(--t-fs-sm);
}

// 管道视图（借鉴 trycompai/crm 的 Deal pipeline）
.lead-view-bar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: var(--t-spacing-md);
}

.pipeline-board {
  display: grid;
  grid-template-columns: repeat(5, minmax(220px, 1fr));
  gap: var(--t-spacing-md);
  margin-top: var(--t-spacing-lg);
  overflow-x: auto;
  padding-bottom: 8px;
}

.pipeline-col {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-lg);
  padding: var(--t-spacing-md);
  min-height: 320px;
}

.pipeline-col-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--t-spacing-sm);
  padding: 0 4px;
}

.pipeline-col-name {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-text-2);
}

.pipeline-col-count {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  background: var(--t-accent-bg);
  border-radius: var(--t-radius-lg);
  padding: 1px 8px;
}

.pipeline-col-body {
  display: flex;
  flex-direction: column;
  gap: var(--t-spacing-sm);
}

.pipeline-card {
  background: var(--t-bg);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-lg);
  padding: var(--t-spacing-sm) var(--t-spacing-md);
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;

  &:hover {
    border-color: var(--t-accent-text);
    box-shadow: none;
  }
}

.pipeline-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--t-spacing-xs);
}

.pipeline-card-name {
  font-weight: 600;
  font-size: var(--t-fs-base);
  color: var(--t-text-1);
}

.pipeline-card-name-wrap {
  display: flex;
  align-items: center;
  gap: var(--t-spacing-sm);
  min-width: 0;
}

.pipeline-card-phone {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  margin: var(--t-spacing-xs) 0 var(--t-spacing-sm);
}

.pipeline-card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pipeline-card-follow {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.pipeline-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--t-spacing-sm);
  margin-top: var(--t-spacing-sm);
}

.pipeline-card-next {
  font-size: var(--t-fs-xs);
  color: var(--t-warning-text);
}

.fu-overdue {
  color: var(--t-danger-text);
  font-weight: 600;
}

.pipeline-stage-select {
  width: 108px;
}

.pipeline-col-empty {
  text-align: center;
  color: var(--t-text-3);
  font-size: var(--t-fs-sm);
  padding: var(--t-spacing-xl) 0;
  border: 1px dashed var(--t-line);
  border-radius: var(--t-radius-lg);
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--t-spacing-md);
}

@media (max-width: 900px) {
  .funnel-cards { grid-template-columns: repeat(3, 1fr); }
  .metric-row { grid-template-columns: 1fr; }
  .form-grid { grid-template-columns: 1fr; }
}


.fu-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fu-detail-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  font-size: var(--t-fs-base);
}
.fu-label {
  flex: 0 0 72px;
  color: var(--t-text-3);
}
.fu-value {
  flex: 1;
  color: var(--t-text-1);
  word-break: break-all;
}

.growth-viewbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
</style>
