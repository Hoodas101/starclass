<template>
  <div class="page-shell">
    <!-- 顶部标题 -->
<PageHeader v-if="!embedded" title="成员管理" />
    <!-- 顶部操作栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <!-- aria-label：搜索框此前只有 placeholder，读屏下是「无名输入框」 -->
        <el-input
          v-model="searchKeyword"
          placeholder="搜索成员姓名/手机号"
          aria-label="搜索成员姓名或手机号"
          :prefix-icon="Search"
          clearable
          style="width: 220px"
          @change="onSearch"
          @clear="onSearch"
        />
      </div>
      <div class="toolbar-right">
        <!-- 表格密度切换：1366px 下 14 列会被挤到表头截断，紧凑模式可多容纳内容 -->
        <el-radio-group v-model="tableSize" size="small" class="density-switch" aria-label="表格密度">
          <el-radio-button value="small">紧凑</el-radio-button>
          <el-radio-button value="default">标准</el-radio-button>
        </el-radio-group>
        <el-dropdown trigger="click">
          <!-- 纯图标圆钮，读屏下原本无任何名称 -->
          <el-button :icon="ArrowDown" circle plain aria-label="更多操作（字段设置 / 导出 / 导入）" />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="colDialogRef?.open()">
                <el-icon><Setting /></el-icon>字段设置
              </el-dropdown-item>
              <el-dropdown-item @click="exportDialogRef?.open()">
                <el-icon><Download /></el-icon>导出
              </el-dropdown-item>
              <!-- 导出为「导入模板」格式：列名与顺序与导入模板一致，打通「导出 → 修正 → 再导入」闭环 -->
              <el-dropdown-item @click="doExportTemplate">
                <el-icon><Download /></el-icon>导出为导入模板
              </el-dropdown-item>
              <el-dropdown-item @click="openImport">
                <el-icon><Upload /></el-icon>导入
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button :type="selectMode ? 'primary' : 'default'" :icon="Finished" @click="toggleSelectMode">
          {{ selectMode ? '退出多选' : '多选' }}
        </el-button>
        <el-button type="primary" :icon="Plus" @click="openAddDialog">
          新建成员
        </el-button>
      </div>
    </div>

    <!-- 视图栏：一套「筛选 + 排序 + 字段顺序 + 列宽」的快照，可多套并存切换 -->
    <TableViewBar
      :views="viewList"
      :active-id="activeViewId"
      @select="applyView"
      @create="createView"
      @rename="renameView"
      @remove="removeView"
    />

    <!-- 数据概览 -->
    <div class="overview-strip">
      <div class="overview-item">
        <span class="overview-value v4-num-display is-md">{{ stats.totalStudents }}</span>
        <span class="overview-label">在册成员</span>
      </div>
      <div class="overview-item">
        <span class="overview-value v4-num-display is-md">{{ stats.totalCards }}</span>
        <span class="overview-label">{{ $t('membership') }}数</span>
      </div>
      <div class="overview-item warn">
        <span class="overview-value v4-num-display is-md">{{ stats.expiringCards }}</span>
        <span class="overview-label">7 天内到期</span>
      </div>
    </div>

    <!-- 成员表格 -->
    <div class="card table-container">
      <!-- 批量操作 -->
      <div v-if="selectMode" class="batch-bar">
        <span class="batch-count">已选 {{ selectedRows.length }} 名成员</span>
        <div class="batch-actions">
          <el-button size="small" @click="batchArchive(true)">归档选中</el-button>
          <el-button size="small" @click="batchArchive(false)">恢复选中</el-button>
          <el-button size="small" text @click="toggleSelectMode">退出多选</el-button>
        </div>
      </div>
      <ListErrorState v-if="!loading && error" :error="error" @retry="loadStudents" />
      <el-table v-else
        v-loading="loading"
        :data="filteredStudents"
        :size="tableSize"
        row-key="id"
        empty-text="暂无成员"
        @row-click="openDetailDrawer"
        @filter-change="onColumnFilter"
        @selection-change="selectedRows = $event"
        row-class-name="clickable-row"
      >
        <el-table-column v-if="selectMode" type="selection" width="40" fixed="left" />
        <el-table-column
          v-for="col in visibleCols"
          :key="col.key"
          :label="col.label"
          :width="colWidths[col.key] && colWidths[col.key].width"
          :min-width="colWidths[col.key] && colWidths[col.key].minWidth"
          :align="col.align"
          :fixed="col.fixed"
          :column-key="col.key"
          :filters="col.key === 'project' ? projectFilters : (col.key === 'status' ? STATUS_FILTERS : undefined)"
          :show-overflow-tooltip="col.tooltip"
        >
          <!-- 表头：单行（inline-flex）+ 自定义排序控件。
               排序完全由本控件承担（不挂 Element Plus 的 :sortable —— 它会自动插入
               caret-wrapper 上下箭头块级元素，与自定义箭头并存并撑成两行表头）。 -->
          <template #header>
            <SortableHeader
              :label="col.label"
              :state="sortState(col.key)"
              :priority="sortPriority(col.key)"
              :sortable="col.sortable !== false"
              @sort="(e) => onSortColumn(col.key, e)"
            />
          </template>
          <template #default="{ row, $index }">
            <!-- 序号跨页连续：$index+1 在翻到第 2 页时又从 1 开始 -->
            <template v-if="col.key === 'seq'">{{ (currentPage - 1) * pageSize + $index + 1 }}</template>
            <div v-else-if="col.key === 'info'" class="student-cell">
              <span class="student-name">{{ row.name }}</span>
            </div>

            <span v-else-if="col.key === 'memberNo'" class="member-no">{{ row.member_no || '-' }}</span>

            <span v-else-if="col.key === 'phone'" class="phone-cell">{{ row.parent_phone || row.phone || '-' }}</span>

            <span v-else-if="col.key === 'age'">{{ formatAge(row.age) }}</span>

            <span v-else-if="col.key === 'birthday'">{{ row.birthday || '-' }}</span>

            <template v-else-if="col.key === 'level'">
              <el-tag v-if="row.level" size="small" effect="plain">{{ row.level }}</el-tag>
              <span v-else class="text-muted">-</span>
            </template>

            <template v-else-if="col.key === 'project'">
              <el-tag v-if="row.card_type_name" size="small" effect="light" type="warning">
                {{ row.card_type_name }}
              </el-tag>
              <span v-else class="text-muted">未购卡</span>
            </template>

            <span
              v-else-if="col.key === 'remaining'"
              class="remaining-classes"
              :class="{ warning: !row.time_card_count && row.remaining_classes <= 5 }"
            >
              {{ row.time_card_count ? '不限·时效' : (row.remaining_classes || 0) + ' 次' }}
            </span>

            <span v-else-if="col.key === 'expires'">{{ formatCardExpiry(row.expires_at) }}</span>
            <span v-else-if="col.key === 'startDate'">{{ row.card_start_date ? formatDate(row.card_start_date) : '-' }}</span>
            <span v-else-if="col.key === 'latestPurchase'">{{ row.latest_purchase_date ? formatDate(row.latest_purchase_date) : '-' }}</span>
            <span v-else-if="col.key === 'purchaseCount'">{{ row.purchase_count || 0 }} 次</span>

            <span v-else-if="col.key === 'spent'" class="total-spent">{{ formatMoney(row.total_spent) }}</span>

            <!-- 加入时间统一 YYYY-MM-DD：Date.parse 对数值时间戳必然 NaN，且相对时间会
                 在同一列混出「3 天前」与「09-06」两种写法；「距今多久」移到 title 悬停 -->
            <template v-else-if="col.key === 'join'">
              <span :title="row.join_date ? relativeTime(Number(row.join_date)) : ''">{{ formatDate(row.join_date) }}</span>
            </template>

            <template v-else-if="col.key === 'lastActivity'">
              <span class="last-activity" :class="{ none: !row.last_activity_at }">
                {{ row.last_activity_at ? relativeTime(row.last_activity_at) : '从未出勤' }}
              </span>
            </template>

            <template v-else-if="col.key === 'status'">
              <StatusDot :tone="statusDotTone[row.status] || 'neutral'" :label="statusTextMap[row.status] || row.status" />
            </template>

            <!-- 自定义字段兜底：直接显示行数据 -->
            <template v-else>{{ row[col.key] ?? '-' }}</template>

          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <div class="pagination-wrap">
        <!-- layout 补 sizes + jumper：此前只声明了 :page-sizes 却没渲染 sizes，
             学员涨到 500 人后每页被锁死在 10 条，无法切换每页条数。
             pageSize 变化仍走 onSearch（内部已把 currentPage 重置为 1）。 -->
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="totalStudents"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @current-change="onPageChange"
          @size-change="onSearch"
        />
      </div>
    </div>

    <!-- 成员详情抽屉 -->
    <el-drawer
      v-model="detailDrawerVisible"
      :title="selectedStudent?.name"
      direction="rtl"
      size="520px"
    >
      <div v-if="selectedStudent" class="student-detail">
        <div class="detail-header">
          <EntityAvatar :name="selectedStudent.name" :src="selectedStudent.avatar" size="xl" tone="accent" />
          <div class="detail-header-info">
            <h3>{{ selectedStudent.name }}</h3>
            <div class="detail-header-status">
              <StatusDot :tone="statusDotTone[selectedStudent.status] || 'neutral'" :label="statusTextMap[selectedStudent.status] || selectedStudent.status" />
              <span v-if="selectedStudent.member_no" class="detail-header-no">{{ selectedStudent.member_no }}</span>
            </div>
          </div>
        </div>

        <!-- CRM RecordSheet 风格：概览 / 互动 双标签 -->
        <el-tabs v-model="detailTab" class="detail-tabs">
          <el-tab-pane label="概览" name="overview">
            <div class="detail-section">
              <h4>基本信息</h4>
              <div class="prop-rows">
                <div class="prop-row">
                  <span class="prop-label">姓名</span>
                  <template v-if="editingField === 'name'">
                    <el-input v-model="editValue" size="small" class="prop-input" autofocus @keyup.enter="saveEdit('name')" @blur="saveEdit('name')" />
                  </template>
                  <span v-else class="prop-value prop-editable" role="button" tabindex="0" @click="startEdit('name', selectedStudent.name)" @keydown.enter="startEdit('name', selectedStudent.name)" @keydown.space.prevent="startEdit('name', selectedStudent.name)">{{ selectedStudent.name || '-' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">性别</span>
                  <template v-if="editingField === 'gender'">
                    <el-select v-model="editValue" size="small" class="prop-input" @change="saveEdit('gender')">
                      <el-option label="男" value="男" />
                      <el-option label="女" value="女" />
                    </el-select>
                  </template>
                  <span v-else class="prop-value prop-editable" role="button" tabindex="0" @click="startEdit('gender', selectedStudent.gender)" @keydown.enter="startEdit('gender', selectedStudent.gender)" @keydown.space.prevent="startEdit('gender', selectedStudent.gender)">{{ selectedStudent.gender || '-' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">出生日期</span>
                  <template v-if="editingField === 'birthday'">
                    <el-date-picker v-model="editValue" type="date" size="small" value-format="YYYY-MM-DD" class="prop-input" @change="saveEdit('birthday')" />
                  </template>
                  <span v-else class="prop-value prop-editable" role="button" tabindex="0" @click="startEdit('birthday', selectedStudent.birthday)" @keydown.enter="startEdit('birthday', selectedStudent.birthday)" @keydown.space.prevent="startEdit('birthday', selectedStudent.birthday)">{{ selectedStudent.birthday || '-' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">年龄</span>
                  <span class="prop-value prop-static">{{ selectedStudent.age != null ? selectedStudent.age + ' 岁' : '-' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">训练级别</span>
                  <template v-if="editingField === 'level'">
                    <el-input v-model="editValue" size="small" class="prop-input" autofocus @keyup.enter="saveEdit('level')" @blur="saveEdit('level')" />
                  </template>
                  <span v-else class="prop-value prop-editable" role="button" tabindex="0" @click="startEdit('level', selectedStudent.level)" @keydown.enter="startEdit('level', selectedStudent.level)" @keydown.space.prevent="startEdit('level', selectedStudent.level)">{{ selectedStudent.level || '未设置' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">{{ $t('guardian') }}姓名</span>
                  <template v-if="editingField === 'parentName'">
                    <el-input v-model="editValue" size="small" class="prop-input" autofocus @keyup.enter="saveEdit('parentName')" @blur="saveEdit('parentName')" />
                  </template>
                  <span v-else class="prop-value prop-editable" role="button" tabindex="0" @click="startEdit('parentName', selectedStudent.parent_name)" @keydown.enter="startEdit('parentName', selectedStudent.parent_name)" @keydown.space.prevent="startEdit('parentName', selectedStudent.parent_name)">{{ selectedStudent.parent_name || '-' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">手机号</span>
                  <template v-if="editingField === 'parent_phone'">
                    <el-input v-model="editValue" size="small" class="prop-input" autofocus @keyup.enter="saveEdit('parent_phone')" @blur="saveEdit('parent_phone')" />
                  </template>
                  <span v-else class="prop-value prop-editable" role="button" tabindex="0" @click="startEdit('parent_phone', selectedStudent.parent_phone)" @keydown.enter="startEdit('parent_phone', selectedStudent.parent_phone)" @keydown.space.prevent="startEdit('parent_phone', selectedStudent.parent_phone)">{{ selectedStudent.parent_phone || '-' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">就读学校</span>
                  <template v-if="editingField === 'school'">
                    <el-input v-model="editValue" size="small" class="prop-input" autofocus @keyup.enter="saveEdit('school')" @blur="saveEdit('school')" />
                  </template>
                  <span v-else class="prop-value prop-editable" role="button" tabindex="0" @click="startEdit('school', selectedStudent.school)" @keydown.enter="startEdit('school', selectedStudent.school)" @keydown.space.prevent="startEdit('school', selectedStudent.school)">{{ selectedStudent.school || '-' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">年级</span>
                  <template v-if="editingField === 'grade'">
                    <el-input v-model="editValue" size="small" class="prop-input" autofocus @keyup.enter="saveEdit('grade')" @blur="saveEdit('grade')" />
                  </template>
                  <span v-else class="prop-value prop-editable" role="button" tabindex="0" @click="startEdit('grade', selectedStudent.grade)" @keydown.enter="startEdit('grade', selectedStudent.grade)" @keydown.space.prevent="startEdit('grade', selectedStudent.grade)">{{ selectedStudent.grade || '-' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">加入时间</span>
                  <!-- Date.parse 对数值时间戳返回 NaN，relativeTime 会把 NaN 原样吐到页面；改走统一 formatDate -->
                  <span class="prop-value prop-static">{{ formatDate(selectedStudent.join_date) }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">最近活跃</span>
                  <span class="prop-value prop-static">{{ selectedStudent.last_activity_at ? relativeTime(selectedStudent.last_activity_at) : '从未出勤' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">购买次数</span>
                  <span class="prop-value prop-static">{{ selectedStudent.purchase_count || 0 }} 次</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">剩余课时/次数</span>
                  <span class="prop-value prop-static">{{ selectedStudent.time_card_count ? '不限·时效' : (selectedStudent.remaining_classes || 0) + '次' }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">累计消费</span>
                  <span class="prop-value prop-strong prop-static">{{ formatMoney(selectedStudent.total_spent) }}</span>
                </div>
                <div class="prop-row">
                  <span class="prop-label">备注</span>
                  <template v-if="editingField === 'remark'">
                    <el-input v-model="editValue" size="small" class="prop-input" autofocus @keyup.enter="saveEdit('remark')" @blur="saveEdit('remark')" />
                  </template>
                  <span v-else class="prop-value prop-editable" role="button" tabindex="0" @click="startEdit('remark', selectedStudent.remark)" @keydown.enter="startEdit('remark', selectedStudent.remark)" @keydown.space.prevent="startEdit('remark', selectedStudent.remark)">{{ selectedStudent.remark || '点击添加备注' }}</span>
                </div>
              </div>
            </div>

            <div class="detail-section">
              <h4>{{ $t('membership') }}</h4>
              <div v-if="detailCards.length" class="detail-classes">
                <div
                  v-for="card in detailCards"
                  :key="card.id"
                  class="detail-class-item"
                >
                  <el-icon><CreditCard /></el-icon>
                  <div class="card-meta">
                    <div class="card-title-row">
                      <span class="card-name">
                        {{ card.card_type_name }}
                        <template v-if="card.billing_mode === 'count'">· 剩余 {{ card.remaining_classes }} 次</template>
                        <template v-else>· 时效制不限次数</template>
                      </span>
                      <StatusDot
                        :tone="isCardExpired(card) ? 'neutral' : (card.status === 'active' ? 'success' : card.status === 'paused' ? 'warning' : 'neutral')"
                        :label="isCardExpired(card) ? '已过期' : (card.status === 'active' ? '进行中' : card.status === 'paused' ? '已暂停' : '已失效')"
                        subtle
                      />
                    </div>
                    <span class="card-date">
                      {{ card.expires_at ? '到期 ' + formatCardExpiry(card.expires_at) : '未激活' }}
                      <template v-if="card.pause_total_ms"> · 已顺延 {{ Math.round(card.pause_total_ms / 86400000) }} 天</template>
                    </span>
                    <span v-if="card.status === 'paused' && card.pause_reason" class="card-date">
                      暂停原因：{{ card.pause_reason }}
                    </span>
                  </div>
                  <div class="card-actions">
                    <el-button v-if="card.status === 'active'" text type="warning" size="small" @click="handlePauseCard(card)">暂停</el-button>
                    <el-button v-if="card.status === 'paused'" text type="success" size="small" @click="handleResumeCard(card)">恢复</el-button>
                  </div>
                </div>
              </div>
              <div v-else class="empty-hint">暂无{{ $t('membership') }}</div>
            </div>

            <div class="detail-section">
              <h4>最近消费</h4>
              <div v-if="detailOrders.length" class="detail-checkins">
                <div
                  v-for="order in detailOrders"
                  :key="order.id"
                  class="checkin-record"
                >
                  <div class="checkin-dot" :class="order.status"></div>
                  <div class="checkin-info">
                    <span class="checkin-course">{{ order.order_type }} · ¥{{ order.payable_amount }}</span>
                    <span class="checkin-date">{{ order.paid_at ? relativeTime(order.paid_at) : '未支付' }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="empty-hint">暂无消费记录</div>
            </div>
          </el-tab-pane>

          <!-- 销售记录（对应 CRM 的 Deals tab） -->
          <el-tab-pane label="销售" :name="'orders'">
            <div class="detail-section">
              <h4>全部订单</h4>
              <div v-if="detailAllOrders.length" class="order-list">
                <div v-for="o in detailAllOrders" :key="o.id" class="order-item">
                  <div class="order-item-left">
                    <span class="order-item-name">{{ o.item_name || o.order_type || '销售单' }}</span>
                    <span class="order-item-no">{{ o.order_no || '' }}</span>
                  </div>
                  <div class="order-item-right">
                    <span class="order-item-amount">{{ formatMoney(o.payable_amount) }}</span>
                    <StatusDot
                      :tone="orderDotTone(o.status)"
                      :label="orderStatusText(o.status)"
                      subtle
                    />
                    <span class="order-item-date">{{ o.paid_at ? relativeTime(o.paid_at) : (o.created_at ? relativeTime(o.created_at) : '') }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="empty-hint">暂无销售记录</div>
            </div>
          </el-tab-pane>

          <!-- 互动时间线（借鉴 trycompai/crm 的 Activity feed） -->
          <el-tab-pane label="互动" name="activity">
            <div class="detail-section">
              <h4>训练点评</h4>
              <div v-if="detailComments.length" class="comment-list">
                <div v-for="c in detailComments" :key="c.id" class="comment-item">
                  <div class="comment-head">
                    <span class="comment-course">{{ c.courseName || '训练点评' }}</span>
                    <span class="comment-date">{{ formatDate(c.createdAt) }}</span>
                  </div>
                  <p class="comment-content">{{ c.content }}</p>
                  <span class="comment-coach">{{ c.coachName }}</span>
                </div>
              </div>
              <div v-else class="empty-hint">暂无点评，课后为成员写一条吧</div>
              <div class="comment-editor">
                <el-input
                  v-model="commentDraft"
                  type="textarea"
                  :rows="2"
                  maxlength="200"
                  show-word-limit
                  placeholder="记录本节课表现、进步与建议…"
                />
                <el-button type="primary" size="small" :loading="commentSaving" @click="saveComment">保存点评</el-button>
              </div>
            </div>
            <div class="detail-section">
              <h4>互动时间线</h4>
              <div v-if="detailTimeline.length" class="timeline-list">
                <div v-for="ev in detailTimeline" :key="ev.type + ev.eventAt + ev.title" class="timeline-item">
                  <div class="timeline-dot" :class="ev.type"></div>
                  <div class="timeline-content">
                    <div class="timeline-title">
                      {{ ev.title }}
                      <el-tag size="small" effect="plain" class="timeline-type-tag">{{ timelineTypeText(ev.type) }}</el-tag>
                    </div>
                    <div class="timeline-detail">{{ ev.detail }}</div>
                    <div class="timeline-date">{{ formatTimelineDate(ev.eventAt) }}</div>
                  </div>
                </div>
              </div>
              <div v-else class="empty-hint">暂无互动记录</div>
            </div>
          </el-tab-pane>
        </el-tabs>

        <div class="detail-footer">
          <el-button
            text
            type="primary"
            size="small"
            @click="editStudent(selectedStudent)"
          >编辑资料</el-button>
          <el-button
            text
            :type="selectedStudent.archived ? 'success' : 'danger'"
            size="small"
            @click="toggleArchive(selectedStudent)"
          >{{ selectedStudent.archived ? '恢复成员' : '归档成员' }}</el-button>
        </div>
      </div>
    </el-drawer>

    <!-- 新建成员弹窗 -->
    <el-dialog
      v-model="addDialogVisible"
      :title="editingId ? '编辑成员' : '新建成员'"
      destroy-on-close
      class="dlg-lg"
    >
      <el-form
        ref="addFormRef"
        :model="addForm"
        :rules="addRules"
        label-width="auto"
        label-position="left"
      >
        <el-form-item label="成员姓名" prop="name">
          <el-input v-model="addForm.name" placeholder="请输入成员姓名" />
        </el-form-item>
        <el-form-item label="性别" prop="gender">
          <el-radio-group v-model="addForm.gender">
            <el-radio value="男">男</el-radio>
            <el-radio value="女">女</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="出生日期">
          <el-date-picker
            v-model="addForm.birthday"
            type="date"
            placeholder="选择出生日期"
            format="YYYY-MM-DD"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item :label="`${$t('guardian')}姓名`" prop="parentName">
          <el-input v-model="addForm.parentName" :placeholder="`请输入${$t('guardian')}姓名`" />
        </el-form-item>
        <el-form-item :label="`${$t('guardian')}手机号`" prop="phone">
          <el-input v-model="addForm.phone" :placeholder="`${$t('guardian')}手机号（用于登录）`" maxlength="11" />
        </el-form-item>

        <div role="button" tabindex="0" class="more-toggle" @click="showMoreFields = !showMoreFields" @keydown.enter="showMoreFields = !showMoreFields" @keydown.space.prevent="showMoreFields = !showMoreFields">
          <el-icon :size="13" class="more-arrow" :class="{ open: showMoreFields }">
            <CaretBottom />
          </el-icon>
          <span>{{ showMoreFields ? '收起更多信息' : '更多信息' }}</span>
        </div>

        <template v-if="showMoreFields">
          <el-form-item label="就读学校">
            <el-input v-model="addForm.school" placeholder="请输入就读学校" />
          </el-form-item>
          <el-form-item label="年级">
            <el-input v-model="addForm.grade" placeholder="如：三年级" />
          </el-form-item>
          <el-form-item label="训练级别">
            <el-input v-model="addForm.level" placeholder="如：基础班 / 提高班 / 精英班" />
          </el-form-item>
          <el-form-item label="身高(cm)">
            <el-input-number v-model="addForm.height" :min="0" :max="250" :precision="1" controls-position="right" placeholder="身高" style="width: 100%" />
          </el-form-item>
          <el-form-item label="体重(kg)">
            <el-input-number v-model="addForm.weight" :min="0" :max="200" :precision="1" controls-position="right" placeholder="体重" style="width: 100%" />
          </el-form-item>
          <el-form-item label="BMI">
            <el-input-number v-model="addForm.bmi" :min="0" :max="60" :precision="1" controls-position="right" placeholder="BMI" style="width: 100%" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="addForm.remark" type="textarea" :rows="3" placeholder="备注信息" />
          </el-form-item>
        </template>
      </el-form>

      <template #footer>
        <el-button @click="addDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAdd">{{ editingId ? '保存修改' : '确认添加' }}</el-button>
      </template>
    </el-dialog>

    <!-- 字段设置（双栏拖拽管理器） -->
    <ColumnSettingsDialog
      ref="colDialogRef"
      title="成员字段设置"
      :columns="studentColumnDefs"
      v-model:settings="columnSettings"
      :defaults="DEFAULT_COLUMN_SETTINGS"
      :widths="customWidths"
      :auto-width="autoColumnWidth"
      @update:widths="onWidthsChange"
      @update:auto-width="onAutoWidthChange"
      @reset-widths="resetColumnWidths"
      @save="saveColumns"
      no-button
    />

    <!-- 批量导入成员 -->
    <ImportCsvDialog
      ref="importDialogRef"
      title="成员"
      :template-columns="importColumns"
      :import-fn="doImportStudents"
    />

    <!-- 导出确认弹窗 -->
    <ExportDialog
      ref="exportDialogRef"
      title="导出成员数据"
      description="选择时间范围后确认导出，文件将立即开始下载。"
      @confirm="doExport"
    />
  </div>
</template>

<script setup>
const props = defineProps({
  embedded: { type: Boolean, default: false },
})
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, Search, UserFilled, School, CreditCard, Download, Upload, Finished, CaretBottom, Setting, ArrowDown } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import { getStudents, getStudentDetail, addStudent, updateStudent, deleteStudent, pauseCard, resumeCard, getCardTypes, getSettings, saveSettings, getDashboard, getStudentTimeline, importStudents, getComments, addComment } from '@/api/modules'
import ColumnSettingsDialog from '@/components/ColumnSettingsDialog.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import PageHeader from '@/components/PageHeader.vue'
import TableViewBar from '@/components/TableViewBar.vue'
import SortableHeader from '@/components/SortableHeader.vue'
// 多维表格：排序（三态/多列/空值末尾）、列宽（canvas 实测 + 手动微调）、视图（整套快照）
import { sortRows, toggleSort, sortStateOf, sortPriorityOf } from '@/utils/tableSort'
import { computeAutoWidths, resolveColumnWidths } from '@/utils/tableWidth'
import { allViews, makeView, userViews, VIEW_ALL, VIEW_FILTERED } from '@/utils/tableView'
import ImportCsvDialog from '@/components/ImportCsvDialog.vue'
import { exportXlsx } from '@/utils/xlsx'
import { fetchAllPages } from '@/utils/fetchAll'
import { relativeTime, formatDate as formatDateStd, formatMoney } from '@/utils/format'
import { useSettingsStore } from '@/store/settings'

const settingsStore = useSettingsStore()
const t = settingsStore.t

const route = useRoute()
const router = useRouter()

const exportDialogRef = ref(null)

// 列表状态同步到 URL（借鉴 trycompai/crm 的 URL state：复制地址即可复现视图）
const syncUrl = () => {
  const query = {}
  if (searchKeyword.value) query.keyword = searchKeyword.value
  if (filterStatus.value) query.status = filterStatus.value
  if (filterProject.value) query.project = filterProject.value
  if (currentPage.value > 1) query.page = String(currentPage.value)
  router.replace({ query })
}

// ============================================
// 数据状态
// ============================================
const searchKeyword = ref('')
const filterStatus = ref('')
const filterProject = ref('')
const cardTypeOptions = ref([])
const showMoreFields = ref(false)
const stats = ref({ totalStudents: 0, totalCards: 0, expiringCards: 0 })
const selectedRows = ref([])

// 多选模式（平时不显示多选列，进入多选后才出现）
const selectMode = ref(false)
const toggleSelectMode = () => {
  selectMode.value = !selectMode.value
  selectedRows.value = []
}

// 页面顶部数据概览（复用看板数据，已带缓存）
const loadStats = async () => {
  try {
    const res = await getDashboard()
    stats.value = {
      totalStudents: res.overview?.totalStudents || 0,
      totalCards: res.overview?.totalCards || 0,
      expiringCards: res.alerts?.expiringCards || 0,
    }
  } catch (e) {
    // 使用默认 0
  }
}

const studentColumnDefs = [
  // sortable: false —— 序号是展示位次，排序它没有意义；filterable 用于列宽计算时预留筛选触发器占位
  { key: 'seq', label: '序号', minWidth: 56, align: 'center', sortable: false },
  // fixed:'left' 只加在最左侧的「姓名」上。
  // 需求原本希望固定「当前项目/剩余课时/到期日」，但 Element Plus 的固定列会被
  // 抽到独立的左固定层、按 DOM 顺序排在非固定列之前 —— 固定中间列会直接改变列序
  // （变成 当前项目|剩余课时|到期日|序号|姓名…），属于比截断更严重的回归。
  // 因此只固定视觉锚点「姓名」，横向滚动时始终能定位到是哪一行。
  { key: 'info', label: '姓名', minWidth: 100, tooltip: true, fixed: 'left' },
  { key: 'memberNo', label: t('learner') + '编号', minWidth: 90, align: 'left' },
  { key: 'phone', label: '联系方式', minWidth: 110, tooltip: true },
  { key: 'age', label: '年龄', minWidth: 56, align: 'right' },
  { key: 'birthday', label: '出生日期', minWidth: 100, align: 'left' },
  { key: 'level', label: '训练级别', minWidth: 80, align: 'left' },
  { key: 'project', label: '当前项目', minWidth: 120, tooltip: true, filterable: true },
  { key: 'remaining', label: '剩余课时/次数', minWidth: 100, align: 'right' },
  { key: 'expires', label: '到期日期', minWidth: 100 },
  { key: 'startDate', label: '开始日期', minWidth: 100 },
  { key: 'latestPurchase', label: '新购日期', minWidth: 100 },
  { key: 'purchaseCount', label: '购买次数', minWidth: 72, align: 'right' },
  { key: 'spent', label: '累计消费', minWidth: 100, align: 'right', tooltip: true },
  { key: 'join', label: '加入时间', minWidth: 100 },
  { key: 'lastActivity', label: '最近活跃', minWidth: 90, align: 'right' },
  { key: 'status', label: '状态', minWidth: 80, align: 'center', filterable: true },
]

// 列头筛选（类似 Excel）：状态联动后端，项目使用在售卡种枚举
const STATUS_FILTERS = [
  { text: '正常', value: 'active' },
  { text: '暂停', value: 'paused' },
  { text: '已结束', value: 'graduated' },
  { text: '已退费', value: 'refunded' },
  { text: '流失', value: 'churn' },
  { text: '流失/归档', value: 'archived' },
]
const projectFilters = computed(() => cardTypeOptions.value
  .filter((c) => c.is_active !== 0)
  .map((c) => ({ text: c.name, value: c.name })))
// 默认显示列。1366px 下 14 列会把表头挤到截断，因此把低频列默认折叠进「字段设置」
// （用户随时可在「字段设置」里打开，不影响已有自定义配置）：
//   编号(memberNo) / 累计消费(spent) / 新购日期(latestPurchase) / 开始日期(startDate) / 出生日期(birthday)
// 注：审计报告提到的「年级」在本表中并不存在对应列（年级只出现在新建成员表单里），故无从折叠。
const DEFAULT_COLUMN_SETTINGS = {
  seq: true, info: true, memberNo: false, phone: true, age: true, level: true, project: true, remaining: true,
  expires: true, startDate: false, latestPurchase: false, purchaseCount: true,
  spent: false, join: true, lastActivity: true, status: true, birthday: false,
}
const columnSettings = ref({ ...DEFAULT_COLUMN_SETTINGS })
const colDialogRef = ref(null)

// ==== 多维表格状态：排序 / 列宽 / 视图（与列显隐、顺序一起存进 students_columns）====
const sorts = ref([])                 // [{ key, state }]：三态，多列按优先级
const customWidths = ref({})          // { [key]: px } 手动列宽
const autoColumnWidth = ref(true)     // 列宽自适应开关
const activeViewId = ref(VIEW_FILTERED)

// 表头控件占位（P2-2）：排序箭头 + 优先级角标 + 列筛选触发器在表头里是常驻占位的，
// 自适应列宽若只量文字，会把「序号」这类短列名截断（实测 th 50px 扣内边距后只剩 15px）
const colExtra = (col) => (col.sortable === false ? 0 : 26) + (col.filterable ? 20 : 0)

// 按用户设置的顺序渲染列（未保存顺序时保持默认定义顺序）
const visibleCols = computed(() => {
  const order = Array.isArray(columnSettings.value.order) ? columnSettings.value.order : []
  const all = studentColumnDefs.filter((c) => columnSettings.value[c.key] !== false)
  // 自定义字段（用户可添加/删除/隐藏）
  const customs = (columnSettings.value.customFields || [])
    .filter((k) => columnSettings.value[k] !== false)
    .map((k) => ({ key: k, label: k, custom: true, minWidth: 100 }))
  const merged = [...all, ...customs]
  const ordered = order.map((k) => merged.find((c) => c.key === k)).filter(Boolean)
  const rest = merged.filter((c) => !order.includes(c.key))
  return [...ordered, ...rest]
})

// 自适应列宽：按当前页数据实测文本像素；关闭自适应时退回列定义宽度
const autoWidths = computed(() => {
  const cols = visibleCols.value
  if (!autoColumnWidth.value) {
    const out = {}
    for (const c of cols) out[c.key] = c.minWidth || 80
    return out
  }
  // 必须把 extra（表头排序箭头/筛选触发器占位）注入列定义，否则 P2-2 的预留不会生效
  const colsWithExtra = cols.map((c) => ({ ...c, extra: colExtra(c) }))
  return computeAutoWidths(colsWithExtra, filteredStudents.value, { textOf: (col, row) => cellText(col, row) })
})

// 最终列宽绑定（P2-3：只要存在任何手动列宽，全部列固定 width，避免相邻 min-width 列被压缩）
const colWidths = computed(() => resolveColumnWidths(visibleCols.value, customWidths.value, autoWidths.value))

const sortState = (key) => sortStateOf(sorts.value, key)
const sortPriority = (key) => sortPriorityOf(sorts.value, key)

// 点列头：升序 → 降序 → 取消；按住 Shift/Cmd 点击追加为次级排序
const onSortColumn = (key, { additive } = {}) => {
  sorts.value = toggleSort(sorts.value, key, additive)
  persistViews()
}

// 年龄：按出生日期实时计算（后端动态返回周岁），最多两位整数、无小数点。
// 必须先排空再转换：Number(null) === 0，旧写法的空值守卫形同虚设，
// 把「未填生日」渲染成「0 岁」（实测 245/360 名学员显示 0 岁，看起来像孩子 0 岁）。
const formatAge = (age) => {
  if (age === null || age === undefined || age === '') return '-'
  const n = Number(age)
  if (!Number.isFinite(n) || n < 0) return '-'
  return `${Math.min(Math.floor(n), 99)} 岁`
}

// 单元格纯文本：供列宽实测使用（与模板里的渲染保持一致，否则量出来的宽度对不上）
const cellText = (col, row) => {
  switch (col.key) {
    case 'seq': return '9999'
    case 'info': return row.name || ''
    case 'memberNo': return row.member_no || ''
    case 'phone': return row.parent_phone || row.phone || ''
    case 'age': return formatAge(row.age)
    case 'birthday': return row.birthday || ''
    case 'level': return row.level || ''
    case 'project': return row.card_type_name || '未购卡'
    case 'remaining': return row.time_card_count ? '不限·时效' : `${row.remaining_classes || 0} 次`
    case 'expires': return formatCardExpiry(row.expires_at)
    case 'startDate': return formatDate(row.card_start_date)
    case 'latestPurchase': return formatDate(row.latest_purchase_date)
    case 'purchaseCount': return `${row.purchase_count || 0} 次`
    case 'spent': return formatMoney(row.total_spent)
    case 'join': return formatDate(row.join_date)
    case 'lastActivity': return row.last_activity_at ? relativeTime(row.last_activity_at) : '从未出勤'
    case 'status': return statusTextMap[row.status] || row.status || ''
    default: return row[col.key] == null ? '' : String(row[col.key])
  }
}

// 排序取值：与 cellText 同源，保证「看到的」与「排的」是同一个值
const sortValueOf = (key, row) => {
  switch (key) {
    // 「序号」是展示位次，不参与排序（故列定义里 sortable: false）
    case 'age': return row.age === null || row.age === undefined || row.age === '' ? null : Number(row.age)
    case 'remaining': return row.time_card_count ? null : Number(row.remaining_classes || 0)
    case 'expires': return row.expires_at || null
    case 'startDate': return row.card_start_date || null
    case 'latestPurchase': return row.latest_purchase_date || null
    case 'purchaseCount': return Number(row.purchase_count || 0)
    case 'spent': return Number(row.total_spent || 0)
    case 'join': return row.join_date ? Number(row.join_date) : null
    case 'lastActivity': return row.last_activity_at || null
    default: return cellText({ key }, row)
  }
}

// 保存字段设置：`students_columns` 在设置表里是「一个键 = 一整个对象」的覆盖语义，
// 而前端持有的只是打开页面那一刻的快照 —— 直接写回会把期间其他写入无声抹掉
//（实测：外部写入两个视图后，本页保存一次字段设置，两个视图随即消失，用户毫无察觉）。
// 改为「先重读服务端 → 按本页管理的键合并 → 写回」。
const persistColumns = async (next) => {
  let remote = {}
  try {
    const cur = await getSettings()
    remote = (cur && cur.students_columns) || {}
  } catch (e) {
    // 读不到服务端就退化为直接写（不能因为一次读失败让保存整个失败）
    await saveSettings({ students_columns: next })
    return
  }
  // 本页管理的键覆盖服务端；服务端有、本页不管理的键（如别处新增的配置）保留
  const merged = { ...remote, ...next }
  columnSettings.value = merged
  await saveSettings({ students_columns: merged })
}

const saveColumns = async (settings) => {
  try {
    await persistColumns(settings)
    ElMessage.success('字段设置已保存')
  } catch (e) {
    // 拦截器已提示
  }
}

// ==== 视图：筛选 + 排序 + 字段顺序 + 列宽 的整套快照 ====
const views = ref([])
const viewList = computed(() => allViews(views.value))

const currentSnapshot = () => ({
  filters: { status: filterStatus.value, project: filterProject.value, keyword: searchKeyword.value },
  sorts: sorts.value,
  order: columnSettings.value.order || [],
  widths: customWidths.value,
})

// 排序/列宽/视图的落盘：与字段设置共用同一条「重读服务端 + 按键合并」写入路径。
// 连续点列头会连发写入，故做 300ms 去抖：既保证「点了就生效」，又避免写入风暴
// 与「读远端 → 合并 → 写回」在并发下互相覆盖导致先后错序。
let persistTimer = null
const persistViews = () => {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistColumns({
      ...columnSettings.value,
      sorts: sorts.value,
      widths: customWidths.value,
      autoColumnWidth: autoColumnWidth.value,
      views: views.value,
      activeViewId: activeViewId.value,
    }).catch(() => { /* 拦截器已提示 */ })
  }, 300)
}

const applyView = (id) => {
  activeViewId.value = id
  // 「当前筛选」= 保持现状（它不是快照，而是「我正在用的筛选态」）
  if (id === VIEW_FILTERED) return
  const v = id === VIEW_ALL
    ? { filters: {}, sorts: [], order: [], widths: {} }
    : userViews(views.value).find((x) => x.id === id)
  if (!v) return
  filterStatus.value = (v.filters && v.filters.status) || ''
  filterProject.value = (v.filters && v.filters.project) || ''
  searchKeyword.value = (v.filters && v.filters.keyword) || ''
  sorts.value = Array.isArray(v.sorts) ? v.sorts : []
  customWidths.value = v.widths || {}
  if (Array.isArray(v.order) && v.order.length) columnSettings.value = { ...columnSettings.value, order: v.order }
  onSearch()
  persistViews()
}

const createView = (name) => {
  const v = makeView(name, currentSnapshot())
  views.value = [...views.value, v]
  activeViewId.value = v.id
  persistViews()
  ElMessage.success(`已保存视图「${v.name}」`)
}

const renameView = (id, name) => {
  views.value = views.value.map((v) => (v.id === id ? { ...v, name } : v))
  persistViews()
}

const removeView = (id) => {
  views.value = views.value.filter((v) => v.id !== id)
  if (activeViewId.value === id) activeViewId.value = VIEW_FILTERED
  persistViews()
}

// 列宽一键复位（逐列手动微调的反操作）
const resetColumnWidths = () => {
  customWidths.value = {}
  persistViews()
}

// 「点了就生效」：列宽微调与自适应开关即时落盘，不需要再点一次「保存」
const onWidthsChange = (w) => {
  customWidths.value = w
  persistViews()
}
const onAutoWidthChange = (v) => {
  autoColumnWidth.value = !!v
  persistViews()
}

// 批量导入成员
const importDialogRef = ref(null)
// aliases：新手最常拿「其他机构导出的表格」直接上传，表头与本模板不同名。
// 归一化后按 label / key / aliases 匹配（见 utils/csv.js buildHeaderIndex），
// 否则「学员姓名 / 手机号 / 家长电话」这类同义表头一律识别不了。
const importColumns = [
  { key: 'name', label: '姓名', required: true, aliases: ['学员姓名', '学生姓名', '名字', '儿童姓名', '会员姓名', '会员', '会员名', '宝宝姓名', 'name'] },
  { key: 'gender', label: '性别', aliases: ['性别', 'gender'] },
  { key: 'birthday', label: '出生日期', aliases: ['生日', '出生年月', '出生日期(必填)', 'birthday'] },
  { key: 'school', label: '就读学校', aliases: ['学校', '就读学校', '幼儿园', 'school'] },
  { key: 'grade', label: '年级', aliases: ['年级', '班级', 'grade'] },
  { key: 'level', label: '训练级别', aliases: ['级别', '训练级别', 'level'] },
  { key: 'parentName', label: t('guardian') + '姓名', aliases: ['家长姓名', '家长', '联系人', '家长名字', 'parentName'] },
  { key: 'phone', label: '联系方式', aliases: ['手机号', '手机', '家长电话', '联系电话', '电话', 'tel', 'phone'] },
  { key: 'remark', label: '备注', aliases: ['备注', '说明', 'remark'] },
  { key: 'joinDate', label: '入会日期', aliases: ['入会日期', '报名日期', '购买日期', 'joinDate'] },
  { key: 'status', label: '状态', aliases: ['状态', 'status'] },
]

const openImport = () => {
  importDialogRef.value?.open()
}

const doImportStudents = async (rows) => {
  const res = await importStudents({ rows })
  if (res.success > 0) loadStudents()
  return {
    success: res.success || 0,
    failed: (res.failed || []).map((f) => `第 ${f.row} 行：${f.reason}`),
    // 学员已建成功、但家长绑定未建的行：不计入失败，必须单独提示，
    // 否则这些家长永远收不到通知且无人察觉
    warnings: (res.warnings || []).map((w) => `第 ${w.row} 行：${w.reason}`),
    // 查重命中而跳过的行：不算失败，但必须如实展示，
    // 否则老师会以为「导入 100 条只建了 60 条」是系统漏数据
    skipped: (res.skippedRows || []).map((s) => `第 ${s.row} 行：${s.reason}`),
  }
}

const loadColumnSettings = async () => {
  try {
    const data = await getSettings()
    if (data?.students_columns) {
      const s = data.students_columns
      columnSettings.value = { ...DEFAULT_COLUMN_SETTINGS, ...s }
      // 多维表格配置与列显隐同存一个键（students_columns）
      sorts.value = Array.isArray(s.sorts) ? s.sorts : []
      customWidths.value = s.widths || {}
      if (s.autoColumnWidth === false) autoColumnWidth.value = false
      views.value = userViews(s.views)
      activeViewId.value = s.activeViewId || VIEW_FILTERED
    }
  } catch (e) {
    // 使用默认值
  }
}
const currentPage = ref(1)
const pageSize = ref(10)
const totalStudents = ref(0)
const loading = ref(false)
// 表格密度：small=紧凑（默认，1366px 下可多容纳一列左右），default=标准
const tableSize = ref('small')

const statusTypeMap = {
  active: 'success',
  graduated: 'info',
  refunded: 'danger',
  archived: 'info',
}

const statusDotTone = {
  active: 'success',
  paused: 'warning',
  graduated: 'info',
  refunded: 'error',
  churn: 'warning',
  none: 'neutral',
  archived: 'neutral',
}

const statusTextMap = {
  active: '正常',
  paused: '暂停',
  graduated: '已结束',
  refunded: '已退费',
  churn: '流失',
  none: '未购卡',
  archived: '流失/归档',
}

const students = ref([])

// 委托到全站统一实现：兼容毫秒时间戳、'YYYY-MM-DD'，以及 SQLite TEXT 列写出的
// '1788059200000.0'（REAL 亲和）形态；本页统一用 '-' 作为空值占位。
const formatDate = (v) => (v === null || v === undefined || v === '' ? '-' : formatDateStd(v, '-'))

const formatCardExpiry = (v) => {
  if (!v) return '-'
  const n = Number(v)
  if (Number.isNaN(n)) return String(v)
  if (n >= 4102444800000) return '不限'
  return dayjs(n).format('YYYY-MM-DD')
}

const isCardExpired = (card) => !!card && card.status === 'active' && !!card.expires_at && Number(card.expires_at) < Date.now() && Number(card.expires_at) < 4102444800000

const error = ref('')
// 请求序号：慢网下连续搜索/翻页时，旧响应后到会覆盖新结果，回包时比对序号丢弃过期响应
let loadSeq = 0

const loadStudents = async () => {
  error.value = ''
  loading.value = true
  const seq = ++loadSeq
  try {
    const res = await getStudents({
      keyword: searchKeyword.value || undefined,
      status: filterStatus.value && filterStatus.value !== 'archived' ? filterStatus.value : undefined,
      archived: filterStatus.value === 'archived' ? '1' : undefined,
      project: filterProject.value || undefined,
      page: currentPage.value,
      pageSize: pageSize.value
    })
    if (seq !== loadSeq) return
    students.value = res.list || []
    totalStudents.value = res.total || 0
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e?.message || '数据加载失败，请稍后重试'
    students.value = []
    totalStudents.value = 0
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

const onSearch = () => {
  currentPage.value = 1
  syncUrl()
  loadStudents()
}

const onPageChange = () => {
  syncUrl()
  loadStudents()
}

// 列头筛选（类似 Excel）：联动顶部筛选与后端查询
const onColumnFilter = (filters) => {
  for (const [key, values] of Object.entries(filters)) {
    const val = values && values.length ? values[0] : ''
    if (key === 'status' && filterStatus.value !== val) {
      filterStatus.value = val
      onSearch()
    } else if (key === 'project' && filterProject.value !== val) {
      filterProject.value = val
      onSearch()
    }
  }
}

// 列表数据：服务端已完成筛选与分页，排序在客户端对当前页生效
// （纯前端排序的常规语义，与飞书多维表格一致；新增可排序列无需动后端）
const filteredStudents = computed(() => sortRows(students.value, sorts.value, sortValueOf))

// ============================================
// 详情抽屉
// ============================================
const detailDrawerVisible = ref(false)
const selectedStudent = ref(null)
const detailTab = ref('overview')

const openDetailDrawer = (student) => {
  if (selectMode.value) return
  selectedStudent.value = student
  detailTab.value = 'overview'
  detailCards.value = []
  detailOrders.value = []
  detailDrawerVisible.value = true
  loadStudentDetail(student.id)
}

const detailCards = ref([])
const detailOrders = ref([])
const detailAllOrders = ref([])
const detailTimeline = ref([])
const detailComments = ref([])
const commentDraft = ref('')
const commentSaving = ref(false)

const orderDotTone = (s) => ({ paid: 'success', pending: 'warning', refunded: 'neutral', cancelled: 'neutral' }[s] || 'neutral')
const orderStatusText = (s) => ({ paid: '已收款', pending: '待支付', refunded: '已退款', cancelled: '已取消' }[s] || s || '')

// 详情行内编辑（借鉴 trycompai/crm 的 InlineField）
const editingField = ref(null)
const editValue = ref('')

const EDIT_FIELDS = {
  name: (v) => ({ name: v }),
  gender: (v) => ({ gender: v }),
  birthday: (v) => ({ birthday: v }),
  level: (v) => ({ level: v }),
  parentName: (v) => ({ parentName: v }),
  parent_phone: (v) => ({ parentPhone: v }),
  school: (v) => ({ school: v }),
  grade: (v) => ({ grade: v }),
  remark: (v) => ({ remark: v }),
}

const startEdit = (field, value) => {
  editingField.value = field
  editValue.value = value ?? ''
}

const saveEdit = async (field) => {
  if (editingField.value !== field) return
  const payload = EDIT_FIELDS[field]?.(editValue.value)
  editingField.value = null
  if (!payload) return
  try {
    await updateStudent(selectedStudent.value.id, payload)
    ElMessage.success('已保存')
    loadStudentDetail(selectedStudent.value.id)
    loadStudents()
  } catch (e) {
    // 拦截器已提示
  }
}

const timelineTypeText = (t) => ({ enroll: '报名', order: '消费', attendance: '出勤', leave: '请假', points: '积分', feedback: '反馈' }[t] || '记录')

const formatTimelineDate = (ts) => {
  if (!ts) return '—'
  return dayjs(Number(ts)).format('YYYY-MM-DD HH:mm')
}

const loadStudentDetail = async (id) => {
  try {
    const res = await getStudentDetail(id)
    selectedStudent.value = { ...selectedStudent.value, ...res }
    detailCards.value = res.cards || []
    detailOrders.value = (res.orders || []).filter((o) => o.status === 'paid')
    detailAllOrders.value = res.orders || []
    getStudentTimeline(id).then((t) => {
      detailTimeline.value = t?.list || []
    }).catch(() => {
      detailTimeline.value = []
    })
    getComments({ studentId: id }).then((r) => {
      detailComments.value = r?.list || []
    }).catch(() => {
      detailComments.value = []
    })
  } catch (e) {
    // 错误已由拦截器提示
  }
}

const saveComment = async () => {
  if (!commentDraft.value.trim()) {
    ElMessage.warning('请填写点评内容')
    return
  }
  commentSaving.value = true
  try {
    await addComment({ studentId: selectedStudent.value.id, content: commentDraft.value.trim() })
    ElMessage.success('点评已保存，家长端可查看')
    commentDraft.value = ''
    const r = await getComments({ studentId: selectedStudent.value.id })
    detailComments.value = r?.list || []
  } catch (e) {
    // 拦截器已提示
  } finally {
    commentSaving.value = false
  }
}

const handlePauseCard = async (card) => {
  try {
    await ElMessageBox.prompt(`暂停后有效期将按暂停天数顺延。请输入暂停原因：`, `暂停${$t('membership')}`, {
      confirmButtonText: '确认暂停',
      cancelButtonText: '取消',
      inputPlaceholder: '如：外出旅游 / 伤病休养',
      inputValidator: (v) => (v && v.trim() ? true : '请输入暂停原因')
    }).then(async ({ value }) => {
      await pauseCard({ cardId: card.id, reason: value.trim() })
      ElMessage.success('已暂停，恢复时自动顺延有效期')
      if (selectedStudent.value) loadStudentDetail(selectedStudent.value.id)
    })
  } catch (e) {
    // 取消或失败
  }
}

const handleResumeCard = async (card) => {
  try {
    await ElMessageBox.confirm('恢复后将按暂停天数自动顺延有效期，确认恢复？', `恢复${$t('membership')}`, {
      confirmButtonText: '确认恢复',
      cancelButtonText: '取消',
      type: 'success'
    })
    const res = await resumeCard({ cardId: card.id })
    ElMessage.success(`已恢复，顺延 ${res.pausedDays || 0} 天`)
    if (selectedStudent.value) loadStudentDetail(selectedStudent.value.id)
  } catch (e) {
    // 取消或失败
  }
}

// ============================================
// 新建成员
// ============================================
const addDialogVisible = ref(false)
const addFormRef = ref(null)
const editingId = ref('')

const addForm = reactive({
  name: '',
  gender: '男',
  birthday: '',
  school: '',
  grade: '',
  level: '',
  height: undefined,
  weight: undefined,
  bmi: undefined,
  parentName: '',
  phone: '',
  remark: ''
})

const addRules = {
  name: [{ required: true, message: '请输入成员姓名', trigger: 'blur' }],
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确', trigger: 'blur' }
  ],
  parentName: [{ required: true, message: `请输入${t('guardian')}姓名`, trigger: 'blur' }]
}

const openAddDialog = () => {
  editingId.value = ''
  showMoreFields.value = false
  Object.assign(addForm, {
    name: '',
    gender: '男',
    birthday: '',
    school: '',
    grade: '',
    level: '',
    height: undefined,
    weight: undefined,
    bmi: undefined,
    parentName: '',
    phone: '',
    remark: ''
  })
  addDialogVisible.value = true
}

const submitAdd = async () => {
  if (!addFormRef.value) return

  const valid = await addFormRef.value.validate().catch(() => false)
  if (!valid) return

  try {
    if (editingId.value) {
      await updateStudent(editingId.value, {
        name: addForm.name,
        gender: addForm.gender,
        birthday: addForm.birthday,
        school: addForm.school,
        grade: addForm.grade,
        level: addForm.level,
        height: addForm.height || undefined,
        weight: addForm.weight || undefined,
        bmi: addForm.bmi || undefined,
        parentName: addForm.parentName,
        parentPhone: addForm.phone,
        remark: addForm.remark
      })
      ElMessage.success('成员信息已更新')
      if (detailDrawerVisible.value && selectedStudent.value) {
        loadStudentDetail(selectedStudent.value.id)
      }
    } else {
      const payload = {
        name: addForm.name,
        gender: addForm.gender,
        birthday: addForm.birthday,
        school: addForm.school,
        grade: addForm.grade,
        level: addForm.level,
        height: addForm.height || undefined,
        weight: addForm.weight || undefined,
        bmi: addForm.bmi || undefined,
        parentName: addForm.parentName,
        phone: addForm.phone,
        remark: addForm.remark
      }
      const res = await addStudent(payload)
      // 查重：手机号已存在时不静默建档。同一孩子被录两遍会让课时/积分/订单/考勤全裂成两份，
      // 且两边都可能已产生消费记录，几乎无法自动合并，只能人工核对返工。
      // 因此先让操作者确认，确认后才真正新建。
      if (res && res.duplicate && Array.isArray(res.candidates) && res.candidates.length) {
        const strong = res.candidates.filter((c) => c.strength === 'strong')
        const main = strong[0] || res.candidates[0]
        const more = res.candidates.length > 1 ? `（另有 ${res.candidates.length - 1} 条疑似）` : ''
        try {
          await ElMessageBox.confirm(
            `已存在「${main.name}」${main.member_no ? '（' + main.member_no + '）' : ''}使用同一家长手机号${more}，请确认是否为不同的人。`,
            '疑似重复档案',
            { confirmButtonText: '确认是不同的人，仍然新建', cancelButtonText: '取消', type: 'warning' }
          )
        } catch (e) {
          return // 取消：保持弹窗打开，便于操作者修改信息或改用已有档案
        }
        await addStudent({ ...payload, confirmDuplicate: true })
      }
      ElMessage.success('成员添加成功')
    }
    addDialogVisible.value = false
    loadStudents()
  } catch (e) {
    // 错误已由拦截器提示
  }
}

const editStudent = (student) => {
  editingId.value = student.id
  showMoreFields.value = false
  Object.assign(addForm, {
    name: student.name || '',
    gender: student.gender === 'male' || student.gender === '男' ? '男' : student.gender === 'female' || student.gender === '女' ? '女' : '男',
    birthday: student.birthday || '',
    school: student.school || '',
    grade: student.grade || '',
    level: student.level || '',
    height: student.height || undefined,
    weight: student.weight || undefined,
    bmi: student.bmi || undefined,
    parentName: student.parent_name || '',
    phone: student.parent_phone || '',
    remark: student.remark || ''
  })
  addDialogVisible.value = true
}

// 归档 / 恢复单个成员（退费、流失后归档隐藏，不删除）
const toggleArchive = async (student) => {
  const next = student.archived ? 0 : 1
  try {
    await ElMessageBox.confirm(
      next ? `归档后「${student.name}」将从列表中隐藏，数据保留可随时恢复，确定归档吗？` : `确定恢复「${student.name}」吗？`,
      next ? '归档成员' : '恢复成员',
      { confirmButtonText: next ? '归档' : '恢复', type: next ? 'warning' : 'success', confirmButtonClass: next ? 'el-button--danger' : '' }
    )
    await updateStudent(student.id, { archived: next })
    ElMessage.success(next ? '已归档' : '已恢复')
    detailDrawerVisible.value = false
    loadStudents()
  } catch (e) {
    // 取消或失败
  }
}

// 批量归档 / 恢复
const batchArchive = async (archive) => {
  if (!selectedRows.value.length) return
  try {
    // 危险操作确认文案统一含具体后果与影响范围：
    // 归档类操作明确「影响 N 名成员 + 从列表隐藏 + 数据保留可随时恢复」，
    // 与单条归档的文案口径一致（此前只说了「从列表隐藏」，没说是否可逆）。
    await ElMessageBox.confirm(
      archive
        ? `将归档选中的 ${selectedRows.value.length} 名成员，归档后他们从列表隐藏（数据保留，可随时恢复）。确定继续吗？`
        : `将恢复选中的 ${selectedRows.value.length} 名成员，恢复后他们重新出现在列表中。确定继续吗？`,
      archive ? '批量归档' : '批量恢复',
      { confirmButtonText: archive ? '归档' : '恢复', type: archive ? 'warning' : 'success', confirmButtonClass: archive ? 'el-button--danger' : '' }
    )
  } catch (e) {
    return // 用户取消
  }
  const verb = archive ? '归档' : '恢复'
  // 逐条执行，不用 Promise.all：Promise.all 在首个请求失败时立即 reject，
  // 而其余请求仍在飞行中 —— 结果是「一部分已改、一部分失败」但 catch 是空的，
  // 用户只看到"什么都没发生"，数据静默处于部分一致状态。
  // 改为串行后能精确拿到每条的结果，并如实反馈成功/失败明细。
  const targets = [...selectedRows.value]
  const done = []
  const failed = []
  for (const s of targets) {
    try {
      await updateStudent(s.id, { archived: archive ? 1 : 0 })
      done.push(s)
    } catch (e) {
      failed.push(s)
    }
  }
  if (failed.length === 0) {
    ElMessage.success(`已${verb} ${done.length} 名成员`)
  } else if (done.length === 0) {
    ElMessage.error(`${verb}失败：${failed.length} 名成员均未成功，请稍后重试`)
  } else {
    ElMessage.warning(
      `已${verb} ${done.length} 名，${failed.length} 名失败：${failed.map((s) => s.name).join('、')}`
    )
  }
  selectedRows.value = []
  loadStudents()
}

const doExport = async (range) => {
  // 按当前筛选条件循环拉取全量成员
  let list = []
  try {
    list = await fetchAllPages(getStudents, {
      keyword: searchKeyword.value || undefined,
      status: filterStatus.value && filterStatus.value !== 'archived' ? filterStatus.value : undefined,
      archived: filterStatus.value === 'archived' ? '1' : undefined,
      project: filterProject.value || undefined,
      startDate: range?.[0] || undefined,
      endDate: range?.[1] || undefined,
    })
  } catch (e) {
    ElMessage.warning('部分数据拉取失败，仅导出当前页')
    list = filteredStudents.value.length ? filteredStudents.value : students.value
  }
  if (!list.length) {
    ElMessage.warning('暂无可导出的成员数据')
    return
  }
  const headers = ['序号', t('learner') + '编号', '姓名', '性别', '年龄', '出生日期', '训练级别', '就读学校', '年级', t('guardian') + '姓名', '联系方式', '当前项目', '开始日期', '到期日期', '新购日期', '剩余课时', '累计消费', '购买次数', '状态']
  const rows = list.map((s, i) => [
    i + 1,
    s.member_no || '',
    s.name,
    s.gender === 'male' ? '男' : s.gender === 'female' ? '女' : s.gender || '',
    s.age != null ? s.age + '岁' : '',
    s.birthday || '',
    s.level || '',
    s.school || '',
    s.grade || '',
    s.parent_name || '',
    s.parent_phone || '',
    s.card_type_name || '未购卡',
    formatDate(s.card_start_date),
    formatCardExpiry(s.expires_at),
    formatDate(s.latest_purchase_date),
    s.remaining_classes ?? '',
    s.total_spent || 0,
    s.purchase_count || 0,
    statusTextMap[s.status] || s.status
  ])
  exportXlsx(`成员列表_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '成员列表' })
  ElMessage.success(`已导出 ${rows.length} 名成员`)
}

// 导出为「导入模板」格式：列名/顺序与导入模板一致，便于「导出 → 修改 → 再导入」闭环。
// 默认导出的是 23 个数据库原始字段（含 id / created_at 等内部列），无法直接再导入。
const doExportTemplate = () => {
  const list = filteredStudents.value || []
  if (!list.length) {
    ElMessage.warning('暂无可导出的成员数据')
    return
  }
  const headers = importColumns.map((c) => c.label)
  const pick = (s, key) => {
    switch (key) {
      case 'name': return s.name || ''
      case 'gender': return s.gender || ''
      case 'birthday': return s.birthday || ''
      case 'school': return s.school || ''
      case 'grade': return s.grade || ''
      case 'level': return s.level || ''
      case 'parentName': return s.parent_name || ''
      case 'phone': return s.parent_phone || ''
      case 'remark': return s.remark || ''
      // 走统一 formatDate：兼容毫秒时间戳与 'YYYY-MM-DD' 两种形态。
      // 旧写法 dayjs(Number(s.join_date)) 在 join_date 已是日期串时得到 NaN → 产出
      // 「Invalid Date」→ 再导入必然整行失败，闭环断裂。
      case 'joinDate': return s.join_date ? formatDate(s.join_date, '') : ''
      case 'status': return s.status || ''
      default: return ''
    }
  }
  const rows = list.map((s) => importColumns.map((c) => pick(s, c.key)))
  exportXlsx(`成员导入模板_${dayjs().format('YYYYMMDD')}`, headers, rows, { sheetName: '成员' })
  ElMessage.success(`已按导入模板格式导出 ${rows.length} 名成员`)
}

onMounted(() => {
  // 从 URL 恢复列表状态
  const q = route.query
  if (q.keyword) searchKeyword.value = String(q.keyword)
  if (q.status) filterStatus.value = String(q.status)
  if (q.project) filterProject.value = String(q.project)
  if (q.page) currentPage.value = Number(q.page) || 1
  // 记录关联直达（借鉴 trycompai/crm 的 RecordLink）：/students?focus=id 直接打开详情
  if (q.focus) {
    openDetailDrawer({ id: String(q.focus) })
  }
  loadStudents()
  loadStats()
  loadColumnSettings()
  getCardTypes().then((res) => {
    cardTypeOptions.value = (res.list || []).filter((c) => c.is_active !== 0)
  }).catch(() => {})
})
</script>

<style lang="scss" scoped>
// P2-1 表头独立内边距：表头只有一行（排序控件已 inline-flex、无 Element Plus 的
// caret-wrapper 块级箭头），沿用「与数据行等高」的宽松 padding 会让表头比数据行还厚
//（实测表头 63px、数据行仅 22px，视觉上「表头比内容还挤」）。
// 注：表头样式已收敛到 SortableHeader.vue，此处不再重复定义 .col-header（避免与组件样式打架）。
:deep(.el-table__header-wrapper th.el-table__cell) {
  padding: 6px 0;
}

// 密度切换：与工具栏按钮同高，不抢视觉
.density-switch {
  :deep(.el-radio-button__inner) {
    padding: 7px 12px;
  }
}

.last-activity {
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;

  &.none {
    color: var(--t-text-3);
  }
}

// 数据概览条
.overview-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--t-spacing-md);
  margin-bottom: var(--t-spacing-lg);
}
.overview-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--t-spacing-md) var(--t-spacing-lg);
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-xl);
}
.overview-item:hover {
  border-color: var(--t-line-strong);
}
.overview-value {
  font-size: var(--t-fs-2xl);
  font-weight: 900;
  color: var(--t-text-1);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  letter-spacing: -0.04em;
}
.overview-item.warn .overview-value {
  color: var(--t-warning-text);
}
.overview-label {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

// 编辑弹窗：更多信息折叠
.more-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: -4px 0 var(--t-spacing-md) 100px;
  font-size: var(--t-fs-sm);
  font-weight: 500;
  color: var(--t-accent-text);
  cursor: pointer;
  user-select: none;
  transition: color 160ms ease-out;
}
.more-toggle:hover {
  color: var(--t-accent-strong);
}
.more-arrow {
  transition: transform 200ms ease-out;
}
.more-arrow.open {
  transform: rotate(180deg);
}


// 成员单元格
.student-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.student-meta {
  display: flex;
  flex-direction: column;
}

.student-name {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
  line-height: 1.25;
}

.phone-cell {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;
}

// 批量操作栏
.batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--t-spacing-md);
  padding: var(--t-spacing-sm) var(--t-spacing-md);
  background: var(--t-accent-bg);
  border: 1px solid var(--t-accent-line);
  border-radius: var(--t-radius-xl);
}
.batch-count {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-accent-strong);
}
.batch-actions {
  display: flex;
  gap: 8px;
}

// 会员编号
.member-no {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  color: var(--t-text-2);
  font-variant-numeric: tabular-nums;
}

.column-tip {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
  margin: 0 0 16px;
}

.column-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px 8px;
}

.column-item {
  padding: 8px 10px;
  border-radius: var(--t-radius-xl);
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  font-size: var(--t-fs-sm);
  color: var(--t-text-1);
}

// 小组标签
.class-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

// 剩余训练时长
.remaining-classes {
  font-weight: 600;
  color: var(--t-text-1);

  &.warning {
    color: var(--t-warning-text);
  }
}

// 累计消费
.total-spent {
  font-weight: 600;
  color: var(--t-text-1);
}

// ============================================
// 详情抽屉
// ============================================
.student-detail {
  padding: 0 8px;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: var(--t-spacing-lg);
}

  .detail-header-info {
    h3 {
      font-size: var(--t-fs-2xl);
      font-weight: 700;
      color: var(--t-text-1);
      margin: 0 0 8px;
    }
  }

.detail-header-status {
  display: flex;
  align-items: center;
  gap: 10px;
}

.detail-header-no {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  font-variant-numeric: tabular-nums;
}

.detail-section {
  margin-bottom: 24px;

  h4 {
    font-size: var(--t-fs-xs);
    font-weight: 600;
    color: var(--t-text-3);
    margin: 0 0 12px;
    letter-spacing: 0.5px;
  }
}

.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.detail-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-label {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

.detail-value {
  font-size: var(--t-fs-base);
  font-weight: 500;
  color: var(--t-text-1);
}

// CRM 式属性行（label 左 · 值右）
.prop-rows {
  display: flex;
  flex-direction: column;
}

.prop-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 12px;
  padding: var(--t-spacing-sm) 0;
  border-bottom: 1px solid var(--t-line);

  &:last-child {
    border-bottom: none;
  }
}

.prop-label {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  line-height: 1.5;
}

.prop-value {
  font-size: var(--t-fs-sm);
  color: var(--t-text-1);
  line-height: 1.5;
  word-break: break-all;
}

.prop-editable {
  cursor: pointer;
  border-radius: var(--t-radius-md);
  padding: 1px 6px;
  margin: -1px -6px;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--t-surface-hover);
    color: var(--t-accent-strong, var(--t-accent));
  }
}

.prop-static {
  color: var(--t-text-2);
}

.prop-input {
  max-width: 240px;
}

.prop-strong {
  font-weight: 600;
  color: var(--t-accent-strong, var(--t-accent));
}

.detail-tabs {
  :deep(.el-tabs__item) {
    font-size: var(--t-fs-sm);
  }
}

.detail-footer {
  padding-top: 12px;
  border-top: 1px solid var(--t-line);
  display: flex;
  justify-content: flex-end;
}

// 销售记录（对应 CRM 的 Deals tab）
.order-list {
  display: flex;
  flex-direction: column;
}

.order-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--t-line);

  &:last-child {
    border-bottom: none;
  }
}

.order-item-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.order-item-name {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-text-1);
}

.order-item-no {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-faint);
  font-variant-numeric: tabular-nums;
}

.order-item-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.order-item-amount {
  font-size: var(--t-fs-sm);
  font-weight: 700;
  color: var(--t-accent-strong, var(--t-accent));
  font-variant-numeric: tabular-nums;
}

.order-item-date {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-faint);
  min-width: 52px;
  text-align: right;
}

.detail-classes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-class-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: transparent;
  border-radius: var(--t-radius-xl);
  font-size: var(--t-fs-base);
  color: var(--t-text-1);
}

.card-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.card-name {
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-text-1);
}

.card-date {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

.card-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.detail-checkins {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.checkin-record {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.checkin-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;

  &.present {
    background: var(--t-success);
  }

  &.absent {
    background: var(--t-danger);
  }

  &.late {
    background: var(--t-warning);
  }
}

.checkin-info {
  display: flex;
  flex-direction: column;
}

.checkin-course {
  font-size: var(--t-fs-base);
  font-weight: 500;
  color: var(--t-text-1);
}

.checkin-date {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

// 互动时间线（借鉴 trycompai/crm 的 Activity feed）
.timeline-list {
  position: relative;
  padding-left: 18px;

  &::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 4px;
    bottom: 4px;
    width: 1px;
    background: var(--t-line);
  }
}

.timeline-item {
  position: relative;
  padding: 0 0 16px;
}

.comment-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.comment-item {
  background: var(--t-surface-hover);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-xl);
  padding: 10px 12px;
}

.comment-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.comment-course {
  font-size: var(--t-fs-xs);
  font-weight: 600;
  color: var(--t-accent-text);
}

.comment-date {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-3);
}

.comment-content {
  font-size: var(--t-fs-sm);
  line-height: 1.6;
  color: var(--t-text-1);
  margin: 6px 0 4px;
  white-space: pre-wrap;
}

.comment-coach {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-3);
}

.comment-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.comment-editor .el-button {
  align-self: flex-end;
}

.timeline-dot {
  position: absolute;
  left: -18px;
  top: 4px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--t-text-3);

  &.enroll { background: var(--t-accent); }
  &.order { background: var(--t-success); }
  &.attendance { background: var(--t-accent); }
  &.leave { background: var(--t-warning); }
  &.points { background: var(--t-chart-6); }
  &.feedback { background: var(--t-danger); }
}

.timeline-content {
  background: transparent;
}

.timeline-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--t-fs-sm);
  font-weight: 600;
  color: var(--t-text-1);
}

.timeline-type-tag {
  font-size: var(--t-fs-2xs);
  // 移除 transform: scale(0.9)：它让声明 11px 的标签视觉缩到 9.9px（跌出字阶、中文笔画粘连），
  // 且 transform 不触发布局重排 → 标签仍占 44px 只画 39.6px，右侧留 4.4px 空洞、与文字间距也失真。
  // 保留 11px（字阶下限），如需更紧凑用 letter-spacing，不缩放字号。
}

.timeline-detail {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
  margin-top: 2px;
  line-height: 1.5;
  word-break: break-all;
}

.timeline-date {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-3);
  margin-top: 4px;
}

// 响应式
@media (max-width: 768px) {
  .toolbar {
    flex-direction: column;
    align-items: flex-start;
  }

  .toolbar-right {
    flex-wrap: wrap;
    width: 100%;
  }
}
</style>
