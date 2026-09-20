<template>
  <div class="settings-page">
    <!-- 页面级大标题：与其他独立路由页保持一致，固定在内容区顶部。
         放在 .settings-layout 之外，避免影响内部 page-shell--narrow 的左对齐布局 -->
    <PageHeader title="系统设置" />
    <div class="settings-layout">
      <!-- 左侧导航 -->
      <div class="settings-nav">
        <div role="button" tabindex="0"
          v-for="tab in visibleTabs"
          :key="tab.key"
          class="nav-item"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key" @keydown.enter="activeTab = tab.key" @keydown.space.prevent="activeTab = tab.key"
        >
          <el-icon :size="18">
            <component :is="tab.icon" />
          </el-icon>
          <span>{{ tab.label }}</span>
        </div>
      </div>

      <!-- 右侧内容 -->
      <div class="settings-content page-shell page-shell--narrow">
        <!-- 机构信息 -->
        <div v-if="activeTab === 'org'" class="settings-section">
          <h3 class="section-title">机构信息</h3>
          <el-form ref="orgFormRef" :model="orgForm" :rules="orgRules" label-width="auto" label-position="left">
            <el-form-item label="机构名称" prop="name">
              <el-input v-model="orgForm.name" placeholder="请输入机构名称" />
            </el-form-item>
            <el-form-item label="联系电话">
              <el-input v-model="orgForm.phone" placeholder="请输入联系电话" />
            </el-form-item>
            <el-form-item label="机构地址">
              <el-input v-model="orgForm.address" type="textarea" :rows="2" placeholder="请输入机构地址" />
            </el-form-item>
            <el-form-item label="机构简介">
              <el-input v-model="orgForm.description" type="textarea" :rows="4" placeholder="请输入机构简介" />
            </el-form-item>
            <el-form-item label="客服电话">
              <el-input v-model="orgForm.servicePhone" maxlength="20" placeholder="家长端「联系客服」展示与拨打" />
            </el-form-item>
            <el-form-item label="Logo">
              <el-upload
                action="#"
                :auto-upload="false"
                :show-file-list="false"
                accept="image/*"
                :on-change="handleLogoChange"
              >
                <el-button :icon="orgForm.logo ? Picture : Upload">
                  {{ orgForm.logo ? '更换 Logo' : '上传 Logo' }}
                </el-button>
              </el-upload>
              <div v-if="orgForm.logo" class="logo-preview">
                <img :src="orgForm.logo" alt="机构 Logo" />
              </div>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="saveOrg">保存设置</el-button>
            </el-form-item>
          </el-form>
        </div>

        <!-- 积分规则 -->
        <div v-if="activeTab === 'points'" class="settings-section">
          <div class="section-head">
            <div>
              <h3 class="section-title">积分规则配置</h3>
              <p class="section-desc">设置成员获取与消耗积分的规则，可自定义新增；签到与购买奖励由系统自动发放</p>
            </div>
            <el-button :icon="Plus" @click="addPointsRule">新增规则</el-button>
          </div>

          <div class="rule-list">
            <div v-for="(rule, index) in pointsRules" :key="index" class="rule-card">
              <div class="rule-header">
                <el-input v-model="rule.name" placeholder="规则名称，如：打卡奖励" class="rule-name-input" />
                <div class="rule-header-actions">
                  <el-switch v-model="rule.enabled" />
                  <el-button text type="danger" size="small" :icon="Delete" @click="removePointsRule(index)" />
                </div>
              </div>
              <div class="rule-body">
                <el-form :model="rule" label-width="auto" label-position="left" size="default">
                  <el-form-item label="积分数量">
                    <el-input-number v-model="rule.points" :min="-1000" :max="10000" />
                    <span class="form-hint">正数为奖励，负数为扣减</span>
                  </el-form-item>
                  <el-form-item label="规则说明">
                    <el-input v-model="rule.description" placeholder="规则说明，例如：参与活动训练签到 +10 分" />
                  </el-form-item>
                </el-form>
              </div>
            </div>
          </div>

          <el-button type="primary" @click="savePoints">保存规则</el-button>
        </div>

        <!-- 推送规则 -->
        <div v-if="activeTab === 'notification'" class="settings-section">
          <h3 class="section-title">推送规则配置</h3>
          <p class="section-desc">配置系统自动推送通知的规则</p>

          <div class="rule-list">
            <div v-for="(rule, index) in notificationRules" :key="index" class="rule-card">
              <div class="rule-header">
                <div>
                  <span class="rule-name">{{ rule.name }}</span>
                  <span class="rule-tag">{{ rule.type }}</span>
                </div>
                <el-switch v-model="rule.enabled" />
              </div>
              <div class="rule-body">
                <el-form :model="rule" label-width="auto" label-position="left">
                  <el-form-item label="触发条件">
                    <el-input v-model="rule.trigger" placeholder="触发条件" />
                  </el-form-item>
                  <el-form-item label="提前时间">
                    <el-input-number v-model="rule.advanceTime" :min="0" :max="72" />
                    <span class="unit-text">小时</span>
                  </el-form-item>
                  <el-form-item v-if="rule.reminderDays !== undefined" label="提前天数">
                    <el-select
                      v-model="rule.reminderDays"
                      multiple
                      placeholder="选择到期前提醒天数"
                      style="width: 100%"
                    >
                      <el-option label="30 天" :value="30" />
                      <el-option label="15 天" :value="15" />
                      <el-option label="7 天" :value="7" />
                      <el-option label="3 天" :value="3" />
                      <el-option label="1 天" :value="1" />
                    </el-select>
                    <span class="unit-text">到期前自动提醒</span>
                  </el-form-item>
                  <el-form-item label="通知内容">
                    <el-input v-model="rule.template" type="textarea" :rows="2" placeholder="通知内容模板" />
                  </el-form-item>
                </el-form>
              </div>
            </div>
          </div>

          <div class="rule-actions">
            <el-button type="primary" @click="saveNotification">保存规则</el-button>
            <el-button :icon="Bell" :loading="renewalSending" @click="sendRenewalNow">立即发送续费提醒</el-button>
          </div>
          <p class="section-hint">「立即发送续费提醒」将按上方「续期提醒」的提前天数，向到期家长发送站内通知（同一档位只发一次）。</p>
        </div>

        <!-- 退费规则 -->
        <div v-if="activeTab === 'refund'" class="settings-section">
          <h3 class="section-title">退费规则配置</h3>
          <p class="section-desc">设置不同情况下的退费计算规则</p>

          <el-form :model="refundForm" label-width="auto" label-position="left">
            <el-form-item label="开课前退费">
              <el-radio-group v-model="refundForm.beforeStart">
                <el-radio value="full">全额退款</el-radio>
                <el-radio value="percent">扣除 {{ refundForm.beforeStartPercent }}%</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="refundForm.beforeStart === 'percent'" label="扣除比例">
              <el-input-number v-model="refundForm.beforeStartPercent" :min="0" :max="100" />
              <span class="unit-text">%</span>
            </el-form-item>

            <el-form-item label="开课后退费">
              <el-radio-group v-model="refundForm.afterStart">
                <el-radio value="unused">退还未消耗部分</el-radio>
                <el-radio value="percent">扣除 {{ refundForm.afterStartPercent }}% 手续费</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="refundForm.afterStart === 'percent'" label="手续费比例">
              <el-input-number v-model="refundForm.afterStartPercent" :min="0" :max="100" />
              <span class="unit-text">%</span>
            </el-form-item>

            <el-form-item label="退费审批">
              <el-switch v-model="refundForm.needApproval" active-text="需要管理员审批" />
            </el-form-item>

            <el-form-item label="退费时效">
              <el-input-number v-model="refundForm.processDays" :min="1" :max="30" />
              <span class="unit-text">个工作日内到账</span>
            </el-form-item>

            <el-form-item>
              <el-button type="primary" @click="saveRefund">保存规则</el-button>
            </el-form-item>
          </el-form>
        </div>

        <!-- 请假规则 -->
        <div v-if="activeTab === 'leave'" class="settings-section">
          <div class="section-head">
            <div>
              <h3 class="section-title">请假规则</h3>
              <p class="section-desc">家长请假流程与次数限制，保存后家长端同步展示</p>
            </div>
          </div>
          <el-form label-width="auto" label-position="left" style="max-width: 620px">
            <el-form-item label="请假需要审批">
              <el-switch v-model="leaveRules.requireApproval" />
              <span class="form-hint">开启后家长请假需管理员/教练在审批中心确认</span>
            </el-form-item>
            <el-form-item label="每月请假次数上限">
              <el-input-number v-model="leaveRules.monthlyLimit" :min="0" :max="20" />
              <span class="form-hint">0 表示不限次数</span>
            </el-form-item>
            <el-form-item label="请假扣减方式">
              <el-radio-group v-model="leaveRules.deductMode">
                <el-radio value="none">不扣减</el-radio>
                <el-radio value="class">扣课时</el-radio>
                <el-radio value="days">扣有效天数</el-radio>
              </el-radio-group>
              <div class="form-hint">扣课时仅对按次计费会员生效；扣天数仅对时效制会员生效</div>
            </el-form-item>
            <el-form-item v-if="leaveRules.deductMode !== 'none'" label="每次扣减数量">
              <el-input-number v-model="leaveRules.deductAmount" :min="1" :max="99" />
              <span class="form-hint">{{ leaveRules.deductMode === 'class' ? '节课时' : '天有效期' }}（审批通过后自动扣减）</span>
            </el-form-item>
            <el-form-item label="允许补课">
              <el-switch v-model="leaveRules.allowMakeup" />
              <span class="form-hint">允许请假成员后续补课，家长端可查看说明</span>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="savingLeave" @click="saveLeaveRules">保存规则</el-button>
            </el-form-item>
          </el-form>
        </div>

        <!-- 数据看板设置 -->
        <div v-if="activeTab === 'dashboard'" class="settings-section">
          <div class="section-head">
            <div>
              <h3 class="section-title">数据看板</h3>
              <p class="section-desc">选择首页数据看板展示的模块，开关即时生效</p>
            </div>
          </div>
          <div class="table-container dash-widgets">
            <div v-for="w in dashWidgets" :key="w.key" class="dash-widget-row">
              <span class="dash-widget-label">{{ w.label }}</span>
              <el-switch v-model="w.on" @change="saveDashWidgets" />
            </div>
          </div>
        </div>

        <!-- 数据备份 -->
        <div v-if="activeTab === 'backup'" class="settings-section">
          <div class="section-head">
            <div>
              <h3 class="section-title">数据备份</h3>
              <p class="section-desc">支持两种方式：下载完整数据库文件，或按业务模块导出 / 导入 JSON 数据</p>
            </div>
          </div>

          <!-- 方式一：完整数据库文件 -->
          <div class="backup-card">
            <div class="backup-card__head">
              <el-icon :size="18" class="backup-card__icon"><Document /></el-icon>
              <div>
                <div class="backup-card__title">完整数据库文件</div>
                <div class="backup-card__desc">导出整个 SQLite 数据库（.db），可用于整库恢复与迁移，体积更大</div>
              </div>
            </div>
            <div class="backup-box">
              <p class="backup-tip">备份文件包含全部成员、排课、订单、积分与系统设置数据，可在新环境直接恢复使用。</p>
              <el-button type="primary" :icon="Download" :loading="backingUp" @click="openDbDownload">下载备份</el-button>
            </div>
          </div>

          <!-- 方式二：按模块导出 / 导入 JSON -->
          <div class="backup-card">
            <div class="backup-card__head">
              <el-icon :size="18" class="backup-card__icon"><Upload /></el-icon>
              <div>
                <div class="backup-card__title">数据导出 / 导入（JSON）</div>
                <div class="backup-card__desc">可整体导出全部数据，或只勾选需要的模块；导入亦支持整体或分模块恢复</div>
              </div>
            </div>

            <div class="io-block">
              <div class="io-block__label">导出数据</div>
              <div class="module-grid">
                <el-checkbox
                  v-for="m in dataModules"
                  :key="m.key"
                  v-model="exportModules"
                  :value="m.key"
                  :label="m.label"
                  border
                  class="module-check"
                />
              </div>
              <div class="io-actions">
                <el-button
                  type="primary"
                  :icon="Download"
                  :loading="exporting"
                  :disabled="exportModules.length === 0"
                  @click="handleExportSelected"
                >导出所选模块</el-button>
                <el-button :icon="Download" :loading="exporting" :disabled="dataModules.length === 0" @click="handleExportAll">导出全部数据</el-button>
                <span class="io-hint" v-if="exportModules.length === 0">未选择模块时「导出所选模块」不可用，可点击「导出全部数据」</span>
              </div>
            </div>

            <el-divider />

            <div class="io-block">
              <div class="io-block__label">导入数据</div>
              <el-upload
                action="#"
                :auto-upload="false"
                :show-file-list="false"
                accept="application/json,.json"
                :on-change="onImportFileChange"
              >
                <el-button :icon="Upload" :loading="importing">选择 JSON 文件</el-button>
              </el-upload>

              <template v-if="importPayload">
                <p class="import-file-name">
                  <el-icon><Document /></el-icon>
                  {{ importFileName }}（含 {{ importModulesAll.length }} 个模块）
                </p>
                <div class="module-grid">
                  <el-checkbox
                    v-for="m in importModulesAll"
                    :key="m.key"
                    v-model="importModules"
                    :value="m.key"
                    :label="m.label"
                    border
                    class="module-check"
                  />
                </div>
                <div class="io-actions">
                  <el-switch v-model="importReplace" active-text="覆盖模式" inactive-text="合并模式" inline-prompt />
                  <el-tooltip content="合并模式：按主键覆盖/新增，不影响其它数据；覆盖模式：导入前先清空所选模块现有数据，用于完整回滚" placement="top">
                    <el-icon class="io-info"><QuestionFilled /></el-icon>
                  </el-tooltip>
                  <el-button
                    type="primary"
                    :icon="Upload"
                    :loading="importing"
                    :disabled="importModules.length === 0"
                    @click="handleImport"
                  >开始导入</el-button>
                  <span class="io-hint" v-if="importModules.length === 0">请至少选择一个要导入的模块</span>
                </div>
                <p class="io-note">模式说明：合并模式按主键 upsert（同 ID 覆盖、新 ID 新增）；覆盖模式会先删除所选模块全部数据再写入，建议先导出一份备份。</p>
              </template>

              <div v-if="importResult" class="io-result">
                <el-alert
                  :title="`导入完成：共写入 ${importResultTotal} 条记录`"
                  type="success"
                  :closable="false"
                  show-icon
                />
                <ul class="io-result__list">
                  <li v-for="(mod, key) in importResult.imported" :key="key">
                    <span class="io-result__name">{{ mod.label }}</span>
                    <span class="io-result__count">{{ mod.total }} 条</span>
                  </li>
                </ul>
                <p v-if="importResult.errors && importResult.errors.length" class="io-result__err">
                  {{ importResult.errors.join('；') }}
                </p>
              </div>
            </div>
          </div>

          <!-- 方式三：从备份文件恢复整库 -->
          <div class="backup-card">
            <div class="backup-card__head">
              <el-icon :size="18" class="backup-card__icon"><Refresh /></el-icon>
              <div>
                <div class="backup-card__title">从备份文件恢复</div>
                <div class="backup-card__desc">选择之前下载的 .db 备份文件，一键恢复整库（恢复前自动备份当前数据）</div>
              </div>
            </div>
            <div class="backup-box">
              <p class="backup-tip">将用所选 .db 文件<strong>覆盖当前整库</strong>。系统会先自动备份当前数据库，若恢复出错可回滚。头像等上传图片不在 .db 内，需另行拷贝 uploads 目录。</p>
              <el-upload
                action="#"
                :auto-upload="false"
                :show-file-list="true"
                :limit="1"
                accept=".db"
                :on-change="onRestoreFileChange"
                :on-exceed="onRestoreExceed"
              >
                <el-button :icon="Upload">选择 .db 备份文件</el-button>
              </el-upload>
              <div class="io-actions" style="margin-top: 12px">
                <el-button
                  type="warning"
                  :icon="Refresh"
                  :loading="restoring"
                  :disabled="!restoreFile"
                  @click="handleRestore"
                >恢复数据库</el-button>
                <span class="io-hint" v-if="!restoreFile">请先选择 .db 文件</span>
              </div>
              <div v-if="restoreResult" class="io-result">
                <el-alert
                  :title="`恢复完成，已自动备份恢复前状态：${restoreResult.safetyBackup}`"
                  type="success"
                  :closable="false"
                  show-icon
                />
                <p class="io-note">共恢复 {{ Object.keys(restoreResult.summary).length }} 张表。各表记录数见服务器日志。</p>
              </div>
            </div>
          </div>

          <!-- 方式四：服务器端自动备份管理 -->
          <div class="backup-card">
            <div class="backup-card__head">
              <el-icon :size="18" class="backup-card__icon"><FolderOpened /></el-icon>
              <div>
                <div class="backup-card__title">服务器自动备份管理</div>
                <div class="backup-card__desc">由系统定时生成的数据库备份，可在此查看、立即创建或删除（存储位置独立于「下载备份」）</div>
              </div>
            </div>
            <div class="backup-box">
              <div class="backup-actions">
                <el-button type="primary" :icon="Refresh" :loading="creatingBackup" @click="handleCreateBackup">立即备份</el-button>
                <el-button :icon="Download" :loading="backupLoading" @click="loadBackups">刷新列表</el-button>
              </div>
              <p class="backup-tip" v-if="backupConfig">
                保留策略：保留最近 {{ backupConfig.retention }} 个备份；备份目录（本地）：{{ backupDir }}
              </p>
              <el-table v-loading="backupLoading" :data="backupList" empty-text="暂无服务器备份" style="margin-top: 12px">
                <el-table-column prop="filename" label="文件名" min-width="220" show-overflow-tooltip />
                <el-table-column label="大小" width="120">
                  <template #default="{ row }">{{ formatSize(row.size) }}</template>
                </el-table-column>
                <el-table-column label="创建时间" width="180">
                  <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
                </el-table-column>
                <el-table-column label="操作" width="110" align="right">
                  <template #default="{ row }">
                    <el-button type="danger" link :icon="Delete" :loading="deletingFile === row.filename" @click="handleDeleteBackup(row.filename)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>
        </div>

        <!-- 确认弹窗：下载完整数据库 -->
        <el-dialog v-model="dbDownloadConfirmVisible" title="确认下载数据库备份" class="dlg-md" destroy-on-close>
          <div class="confirm-body">
            <p class="confirm-lead">即将下载<strong>完整数据库文件（.db）</strong>，可用于整库迁移或在其它电脑恢复使用。</p>
            <ul class="confirm-list">
              <li>包含全部业务数据：成员、排课、订单、积分、签到、会员卡、系统设置等。</li>
              <li>包含全部登录账号与密码哈希，换机器后仍可用原账号密码登录。</li>
              <li>文件为单一自包含文件，跨 Windows / macOS / Linux 通用。</li>
            </ul>
            <p class="confirm-warn">
              <el-icon><WarningFilled /></el-icon>
              注意：头像等上传图片保存在服务器 <code>uploads</code> 目录，<b>不包含在 .db 内</b>，如需一并迁移请另行拷贝该目录。
            </p>
          </div>
          <template #footer>
            <el-button @click="dbDownloadConfirmVisible = false">取消</el-button>
            <el-button type="primary" :loading="backingUp" @click="confirmDownloadBackup">确认下载</el-button>
          </template>
        </el-dialog>

        <!-- 确认弹窗：导出数据 -->
        <el-dialog v-model="exportConfirmVisible" :title="exportConfirmAll ? '确认导出全部数据' : '确认导出所选数据'" class="dlg-lg" destroy-on-close>
          <div class="confirm-body">
            <p class="confirm-lead">即将导出以下 {{ exportConfirmModules.length }} 个模块的数据，请确认导出内容：</p>
            <ul class="confirm-list">
              <li v-for="m in exportConfirmModules" :key="m.key">
                <span class="confirm-mod-name">{{ m.label }}</span>
                <span class="confirm-mod-desc">{{ m.desc }}</span>
              </li>
            </ul>
            <el-divider />
            <div class="confirm-date">
              <div class="confirm-date__label">导出时间范围（可选）</div>
              <el-date-picker
                v-model="exportDateRange"
                type="daterange"
                range-separator="至"
                start-placeholder="开始日期"
                end-placeholder="结束日期"
                value-format="x"
                :clearable="true"
                style="width: 100%"
              />
              <p class="confirm-hint">仅对带时间戳的模块（如订单、签到、支付、通知、线索等）生效；成员/课程等档案类模块不受限。留空表示导出全部时间的数据。</p>
            </div>
          </div>
          <template #footer>
            <el-button @click="exportConfirmVisible = false">取消</el-button>
            <el-button type="primary" :loading="exporting" @click="confirmExport">确认导出</el-button>
          </template>
        </el-dialog>

        <!-- 确认弹窗：导入数据 -->
        <el-dialog v-model="importConfirmVisible" title="确认导入数据" class="dlg-lg" destroy-on-close>
          <div class="confirm-body">
            <p class="confirm-file"><el-icon><Document /></el-icon> {{ importFileName }}</p>
            <p class="confirm-lead">即将以「{{ importReplace ? '覆盖' : '合并' }}」模式导入以下 {{ importModules.length }} 个模块：</p>
            <ul class="confirm-list">
              <li v-for="m in importConfirmModules" :key="m.key">
                <span class="confirm-mod-name">{{ m.label }}</span>
                <span class="confirm-mod-desc">{{ m.desc }}（约 {{ importModuleCounts[m.key] || 0 }} 条）</span>
              </li>
            </ul>
            <p class="confirm-warn" v-if="importReplace">
              <el-icon><WarningFilled /></el-icon>
              覆盖模式：导入前会先<strong>清空所选模块的现有数据</strong>再写入，用于完整回滚。建议先导出一份备份。
            </p>
            <p class="confirm-hint" v-else>
              合并模式：按主键覆盖/新增，不影响其它数据，可重复导入。
            </p>
          </div>
          <template #footer>
            <el-button @click="importConfirmVisible = false">取消</el-button>
            <el-button type="primary" :loading="importing" @click="confirmImport">确认导入</el-button>
          </template>
        </el-dialog>

        <!-- 确认弹窗：恢复数据库 -->
        <el-dialog v-model="restoreConfirmVisible" title="确认恢复数据库" class="dlg-md" destroy-on-close>
          <div class="confirm-body">
            <p class="confirm-file"><el-icon><Document /></el-icon> {{ restoreFile && restoreFile.name }}</p>
            <p class="confirm-lead">即将使用该 .db 文件<strong>覆盖当前整库</strong>。系统会先<strong>自动备份当前数据库</strong>，若恢复出错可回滚。</p>
            <ul class="confirm-list">
              <li>覆盖后，当前所有业务数据将被备份文件中的数据取代。</li>
              <li>头像等上传图片不在 .db 内，需另行拷贝 <code>uploads</code> 目录。</li>
              <li>登录态（token）不随库迁移，恢复后请用原账号密码重新登录。</li>
            </ul>
            <p class="confirm-warn">
              <el-icon><WarningFilled /></el-icon>
              此操作影响整库，请确认所选文件正确且来源可信。
            </p>
          </div>
          <template #footer>
            <el-button @click="restoreConfirmVisible = false">取消</el-button>
            <el-button type="warning" :loading="restoring" @click="confirmRestore">确认恢复</el-button>
          </template>
        </el-dialog>

        <!-- 称呼设置 -->
        <div v-if="activeTab === 'terms'" class="settings-section">
          <div class="section-head">
            <div>
              <h3 class="section-title">机构称呼设置</h3>
              <p class="section-desc">
                统一后台、家长小程序与微信通知中的角色与功能叫法，避免「教练/老师」「学员/会员」混用造成家长与员工困惑。
                选择一套预设方案，可再对单个称呼做微调。
              </p>
            </div>
          </div>

          <el-form label-width="auto" label-position="left" style="max-width: 720px">
            <el-form-item label="方案">
              <el-radio-group v-model="termSchemeSel">
                <el-radio-button v-for="s in schemeOptions" :key="s.key" :value="s.key">
                  {{ s.name }}
                  <span class="scheme-desc">{{ s.desc }}</span>
                </el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-divider content-position="left">逐项微调（留空则使用上方方案默认称呼）</el-divider>

            <el-form-item v-for="c in conceptOptions" :key="c.key" :label="c.label">
              <el-input
                v-model="termOverridesLocal[c.key]"
                :placeholder="`默认：${presetValue(c.key)}`"
                clearable
                style="max-width: 280px"
              />
              <span class="form-hint" v-if="termOverridesLocal[c.key]">当前生效：{{ termOverridesLocal[c.key] }}</span>
              <span class="form-hint" v-else>当前生效：{{ presetValue(c.key) }}</span>
            </el-form-item>

            <el-form-item>
              <el-button type="primary" :loading="termSaving" @click="saveTerms">保存称呼设置</el-button>
              <el-button @click="resetTerms">恢复方案默认</el-button>
            </el-form-item>
            <p class="section-hint">
              说明：本设置仅改变界面与通知中的“叫法”，不影响任何数据、权限或角色逻辑。修改后管理端即时生效，家长小程序下次打开自动同步。
            </p>
          </el-form>
        </div>

        <!-- 操作日志：audit_log 此前只写不读，出事之后无从追溯；本页让留痕真正可查 -->
        <div v-if="activeTab === 'audit'" class="settings-section">
          <div class="section-head">
            <div>
              <h3 class="section-title">操作日志</h3>
              <p class="section-desc">
                记录签到、报名、退款、薪资结算等关键操作的<strong>操作人、时间与变更前后</strong>。
                发现课时或账目对不上时，可在此查到是谁在什么时候改的。仅管理员可见。
              </p>
            </div>
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px">
            <el-select v-model="auditFilter.entity" placeholder="全部对象" clearable style="width: 160px">
              <el-option v-for="e in auditFilterOptions.entities" :key="e" :label="auditEntityLabel(e)" :value="e" />
            </el-select>
            <el-select v-model="auditFilter.action" placeholder="全部动作" clearable style="width: 160px">
              <el-option v-for="a in auditFilterOptions.actions" :key="a" :label="auditActionLabel(a)" :value="a" />
            </el-select>
            <el-date-picker
              v-model="auditRange"
              type="daterange"
              value-format="YYYY-MM-DD"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              style="width: 250px"
            />
            <el-button type="primary" :icon="Search" @click="onAuditSearch">查询</el-button>
            <el-button :icon="Refresh" @click="onAuditReset">重置</el-button>
          </div>

          <el-table v-loading="auditLoading" :data="auditLogs" size="small" border empty-text="暂无操作日志">
            <el-table-column label="时间" width="150">
              <template #default="{ row }">{{ fmtAuditTime(row.created_at) }}</template>
            </el-table-column>
            <el-table-column label="对象" width="110">
              <template #default="{ row }">{{ auditEntityLabel(row.entity) }}</template>
            </el-table-column>
            <el-table-column label="动作" width="110">
              <template #default="{ row }">{{ auditActionLabel(row.action) }}</template>
            </el-table-column>
            <el-table-column prop="entity_id" label="记录标识" min-width="150" show-overflow-tooltip />
            <el-table-column prop="actor_id" label="操作人" min-width="150" show-overflow-tooltip />
            <el-table-column label="变更内容" width="110" align="center">
              <template #default="{ row }">
                <el-popover v-if="row.before || row.after" placement="left" :width="380" trigger="click">
                  <template #reference>
                    <el-link type="primary" :underline="false">查看</el-link>
                  </template>
                  <div style="max-height: 340px; overflow: auto">
                    <div v-if="row.before" style="margin-bottom: 8px">
                      <div style="font-weight: 600; margin-bottom: 4px">变更前</div>
                      <pre style="margin: 0; white-space: pre-wrap; word-break: break-all">{{ fmtAuditJson(row.before) }}</pre>
                    </div>
                    <div v-if="row.after">
                      <div style="font-weight: 600; margin-bottom: 4px">变更后</div>
                      <pre style="margin: 0; white-space: pre-wrap; word-break: break-all">{{ fmtAuditJson(row.after) }}</pre>
                    </div>
                  </div>
                </el-popover>
                <span v-else>—</span>
              </template>
            </el-table-column>
          </el-table>

          <div style="margin-top: 12px; display: flex; justify-content: flex-end">
            <el-pagination
              layout="total, prev, pager, next"
              :total="auditTotal"
              :current-page="auditPage"
              :page-size="auditPageSize"
              @current-change="onAuditPageChange"
            />
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { Upload, Picture, Download, Bell, Plus, Delete, Document, QuestionFilled, WarningFilled, Refresh, FolderOpened, Search } from '@element-plus/icons-vue'
import request from '@/api/request'
import { getSettings, saveSettings, generateRenewalNotices, getDataModules, exportData, importData, getBackups, createBackup, deleteBackup, getAuditLogs } from '@/api/modules'
import { useSettingsStore } from '@/store/settings'
import { useUserStore } from '@/store/user'
import { SCHEMES, CONCEPTS } from '@/constants/terms'
import PageHeader from '@/components/PageHeader.vue'
// ============================================
// 标签页
// ============================================
const activeTab = ref('org')

const tabs = [
  { key: 'org', label: '机构信息', icon: 'OfficeBuilding' },
  { key: 'points', label: '积分规则', icon: 'Star' },
  { key: 'notification', label: '推送规则', icon: 'Bell' },
  { key: 'refund', label: '退费规则', icon: 'Money' },
  { key: 'leave', label: '请假规则', icon: 'Calendar' },
  { key: 'dashboard', label: '看板设置', icon: 'DataBoard' },
  { key: 'terms', label: '称呼设置', icon: 'EditPen' },
  { key: 'backup', label: '数据备份', icon: 'FolderOpened', adminOnly: true },
  { key: 'audit', label: '操作日志', icon: 'Tickets', adminOnly: true }
]

// 数据备份等仅管理员可见（其操作接口均为 adminOnly，非管理员访问会 403）
const userStore = useUserStore()
const isAdmin = computed(() => userStore.userRole === 'admin')
const visibleTabs = computed(() => tabs.filter((t) => !t.adminOnly || isAdmin.value))

// ============================================
// 数据看板模块开关（与首页看板共用 localStorage）
// ============================================
const DASH_DEFS = [
  { key: 'statCards', label: '统计卡片' },
  { key: 'attendance', label: '到场趋势' },
  { key: 'activity', label: '近期签到动态' },
  { key: 'pending', label: '待处理事项' },
  { key: 'rankWeek', label: '本周签单排名' },
  { key: 'rankMonth', label: '本月签单排名' },
  { key: 'rankYear', label: '本年签单排名' },
  { key: 'products', label: '销售产品统计' }
]
// localStorage 可能被旧版本写入损坏数据：解析失败时回退为空对象
let savedWidgets = {}
try { savedWidgets = JSON.parse(localStorage.getItem('edu_dash_widgets') || '{}') } catch (e) { savedWidgets = {} }
const dashWidgets = ref(DASH_DEFS.map((d) => ({ ...d, on: savedWidgets[d.key] !== false })))
const saveDashWidgets = () => {
  const obj = {}
  dashWidgets.value.forEach((w) => { obj[w.key] = w.on ? true : false })
  localStorage.setItem('edu_dash_widgets', JSON.stringify(obj))
}

// ============================================
// 数据备份下载
// ============================================
const backingUp = ref(false)
const dbDownloadConfirmVisible = ref(false)

const openDbDownload = () => {
  dbDownloadConfirmVisible.value = true
}

const confirmDownloadBackup = async () => {
  backingUp.value = true
  try {
    // 走统一请求实例（自动带鉴权、超时、401 登出），baseURL 由 VITE_API_BASE_URL / vite proxy 决定，
    // 不再硬编码本机地址，生产环境也能正确下载。
    const blob = await request.get('/admin/backup', { responseType: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `edu-admin-backup-${new Date().toISOString().slice(0, 10)}.db`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    ElMessage.success('备份已下载，请妥善保存')
    dbDownloadConfirmVisible.value = false
  } catch (e) {
    ElMessage.error('备份下载失败，请稍后重试')
  } finally {
    backingUp.value = false
  }
}

// ============================================
// 服务器自动备份管理（list / create / delete）—— 仅管理员可见（备份 tab 已 adminOnly）
// ============================================
const backupList = ref([])
const backupLoading = ref(false)
const creatingBackup = ref(false)
const deletingFile = ref('')
const backupConfig = ref(null)
const backupDir = ref('')

const loadBackups = async () => {
  backupLoading.value = true
  try {
    const res = await getBackups()
    backupList.value = (res && res.list) || []
    backupConfig.value = (res && res.config) || null
    backupDir.value = (res && res.backupDir) || ''
  } catch (e) {
    // 拦截器已提示业务/网络错误；列表留空，避免重复 toast
    backupList.value = []
  } finally {
    backupLoading.value = false
  }
}

const handleCreateBackup = async () => {
  creatingBackup.value = true
  try {
    await createBackup()
    ElMessage.success('备份已创建')
    await loadBackups()
  } catch (e) {
    // 拦截器已提示
  } finally {
    creatingBackup.value = false
  }
}

const handleDeleteBackup = async (filename) => {
  try {
    await ElMessageBox.confirm(`确定删除备份「${filename}」？删除后不可恢复。`, '删除备份', {
      type: 'warning',
      confirmButtonText: '确认删除',
      confirmButtonClass: 'el-button--danger',
    })
    deletingFile.value = filename
    await deleteBackup(filename)
    ElMessage.success('已删除')
    await loadBackups()
  } catch (e) {
    if (e === 'cancel') return
    // 拦截器已提示
  } finally {
    deletingFile.value = ''
  }
}

const formatSize = (b) => {
  if (b == null) return '-'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

const formatTime = (ts) => {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 切换到「数据备份」标签页时拉取服务器备份列表（仅管理员可见）
watch(activeTab, (t) => {
  if (t === 'backup') loadBackups()
})

// ============================================
// 数据导出 / 导入（JSON，按模块）
// ============================================
const dataModules = ref([])            // 后端返回的可导出模块清单 {key,label}
const exportModules = ref([])          // 导出时勾选的模块 key
const exporting = ref(false)

const importFile = ref(null)           // 选中的 File 对象
const importFileName = ref('')
const importPayload = ref(null)        // 解析后的 JSON 对象
const importModulesAll = ref([])       // 文件中包含的模块 {key,label}
const importModules = ref([])          // 导入时勾选的模块 key
const importReplace = ref(false)       // 覆盖模式
const importing = ref(false)
const importResult = ref(null)

const importResultTotal = computed(() => {
  if (!importResult.value) return 0
  return Object.values(importResult.value.imported || {}).reduce((sum, m) => sum + (m.total || 0), 0)
})

const loadDataModules = async () => {
  try {
    const res = await getDataModules()
    dataModules.value = (res && res.modules) || []
  } catch (e) {
    // 非管理员等情况下静默，模块清单仅供导出勾选使用
    dataModules.value = []
  }
}

// 触发浏览器下载 blob
const triggerDownload = (blob, filename) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// 导出确认弹窗相关
const exportConfirmVisible = ref(false)
const exportConfirmAll = ref(false)
const exportConfirmModules = ref([])
const exportDateRange = ref(null)

const handleExportSelected = () => {
  if (exportModules.value.length === 0) {
    ElMessage.warning('请先选择要导出的模块')
    return
  }
  exportConfirmAll.value = false
  const sel = new Set(exportModules.value)
  exportConfirmModules.value = dataModules.value.filter((m) => sel.has(m.key))
  exportDateRange.value = null
  exportConfirmVisible.value = true
}

const handleExportAll = () => {
  if (dataModules.value.length === 0) {
    ElMessage.warning('暂无可导出的模块，请稍后重试')
    return
  }
  exportConfirmAll.value = true
  exportConfirmModules.value = dataModules.value.slice()
  exportDateRange.value = null
  exportConfirmVisible.value = true
}

const confirmExport = async () => {
  exporting.value = true
  try {
    const params = {}
    if (!exportConfirmAll.value) {
      params.modules = exportConfirmModules.value.map((m) => m.key).join(',')
    }
    if (exportDateRange.value && exportDateRange.value.length === 2) {
      params.from = Number(exportDateRange.value[0])
      // 结束日期取当天 23:59:59.999，确保包含整天
      params.to = Number(exportDateRange.value[1]) + (24 * 60 * 60 * 1000 - 1)
    }
    const blob = await exportData(params)
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    triggerDownload(blob, `edu-data-${stamp}.json`)
    ElMessage.success(`已导出 ${exportConfirmModules.value.length} 个模块`)
    exportConfirmVisible.value = false
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    exporting.value = false
  }
}

const onImportFileChange = (file) => {
  if (!file || !file.raw) return
  importFile.value = file.raw
  importFileName.value = file.name
  importPayload.value = null
  importModulesAll.value = []
  importModules.value = []
  importResult.value = null

  const reader = new FileReader()
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result)
      if (!parsed || typeof parsed !== 'object' || !parsed.data) {
        throw new Error('文件格式不正确（缺少 data 字段）')
      }
      importPayload.value = parsed
      // 自动识别文件内包含的模块，并预选全部
      const keys = Object.keys(parsed.data)
      const moduleMap = Object.fromEntries(dataModules.value.map((m) => [m.key, m.label]))
      importModulesAll.value = keys.map((k) => ({ key: k, label: moduleMap[k] || k }))
      importModules.value = keys.slice()
    } catch (err) {
      ElMessage.error('解析失败：' + (err.message || '不是合法的 JSON 文件'))
      importFile.value = null
    }
  }
  reader.onerror = () => {
    ElMessage.error('文件读取失败，请重试')
  }
  reader.readAsText(file.raw)
}

// 导入确认弹窗相关
const importConfirmVisible = ref(false)
const importConfirmModules = ref([])
const importModuleCounts = ref({})

const handleImport = () => {
  if (!importPayload.value) {
    ElMessage.warning('请先选择要导入的 JSON 文件')
    return
  }
  if (importModules.value.length === 0) {
    ElMessage.warning('请至少选择一个要导入的模块')
    return
  }
  const sel = new Set(importModules.value)
  importConfirmModules.value = importModulesAll.value.filter((m) => sel.has(m.key))
  // 统计各模块记录条数（兼容 {tables:{...}} 与直接数组两种结构）
  const counts = {}
  for (const k of importModules.value) {
    const modData = importPayload.value.data[k]
    const tbl = modData && modData.tables ? modData.tables : modData
    let n = 0
    if (tbl && typeof tbl === 'object') {
      for (const t in tbl) if (Array.isArray(tbl[t])) n += tbl[t].length
    }
    counts[k] = n
  }
  importModuleCounts.value = counts
  importConfirmVisible.value = true
}

const confirmImport = async () => {
  importing.value = true
  try {
    const res = await importData(importPayload.value, {
      modules: importModules.value.join(','),
      replace: importReplace.value,
    })
    importResult.value = res
    importConfirmVisible.value = false
    // 清空已选文件与模块，避免重复误导入；导入结果保留供查看
    importPayload.value = null
    importFile.value = null
    importModules.value = []
    importModulesAll.value = []
    ElMessage.success('导入完成')
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    importing.value = false
  }
}

// ============================================
// 从 .db 备份文件恢复整库
// ============================================
const restoreFile = ref(null)
const restoring = ref(false)
const restoreResult = ref(null)
const restoreConfirmVisible = ref(false)

const onRestoreFileChange = (file) => {
  if (!file || !file.raw) return
  restoreFile.value = file.raw
  restoreResult.value = null
}

// 必须在 script 内声明：模板内联箭头里直接引用 ElMessage 会被编译成 _ctx.ElMessage，
// 按需引入（无全局注册）下运行时为 undefined，触发 exceed 即抛错
const onRestoreExceed = () => ElMessage.warning('一次仅能选择一个文件')

const handleRestore = () => {
  if (!restoreFile.value) {
    ElMessage.warning('请先选择 .db 文件')
    return
  }
  restoreConfirmVisible.value = true
}

const confirmRestore = async () => {
  restoring.value = true
  try {
    const res = await request.post('/settings/db-restore', restoreFile.value, {
      headers: { 'Content-Type': 'application/octet-stream' },
      responseType: 'json',
    })
    restoreResult.value = res
    restoreConfirmVisible.value = false
    ElMessage.success('数据库已恢复')
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    restoring.value = false
  }
}

// ============================================
// 称呼设置
// ============================================
const settingsStore = useSettingsStore()
const schemeOptions = Object.values(SCHEMES)
const conceptOptions = CONCEPTS
const termSchemeSel = ref('edu')
const termOverridesLocal = reactive({})
const termSaving = ref(false)

const presetValue = (key) => {
  const s = SCHEMES[termSchemeSel.value]
  return (s && s.terms[key]) || ''
}

const initTerms = () => {
  termSchemeSel.value = settingsStore.termScheme || 'edu'
  for (const k in termOverridesLocal) delete termOverridesLocal[k]
  const ov = settingsStore.termOverrides || {}
  Object.keys(ov).forEach((k) => { termOverridesLocal[k] = ov[k] })
}

const saveTerms = async () => {
  termSaving.value = true
  try {
    // 清理空串覆盖，避免冗余存储
    const clean = {}
    Object.keys(termOverridesLocal).forEach((k) => {
      if (termOverridesLocal[k] && String(termOverridesLocal[k]).trim()) clean[k] = String(termOverridesLocal[k]).trim()
    })
    await settingsStore.saveTermSettings(termSchemeSel.value, clean)
    ElMessage.success('称呼设置已保存，全端即时生效')
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    termSaving.value = false
  }
}

const resetTerms = () => {
  for (const k in termOverridesLocal) delete termOverridesLocal[k]
  ElMessage.info('已清空逐项微调，保存后恢复方案默认称呼')
}

// ============================================
// 账号安全（修改密码）已迁至「个人设置」页（views/profile/index.vue）：
// 该能力面向 admin/coach/sales 全部员工角色，而本页仅管理员可进入，
// 教练与销售此前没有任何自助改密入口。
// ============================================

onMounted(() => {
  loadSettings()
  loadDataModules()
})

// ============================================
// 操作日志（audit_log 只读查询）
//
// 为什么要有这一块：audit_log 此前只写不读——后端 40+ 处 recordAudit 持续留痕，
// 但没有任何查询入口，出事之后只能整库导出再人工翻找，等于没留痕。
// 本页提供按「对象 / 动作 / 日期」过滤的只读列表，让留痕真正可查。
// 接口为 adminOnly，教练与销售访问会 403（本页本身也仅管理员可进入）。
// ============================================
const auditLogs = ref([])
const auditTotal = ref(0)
const auditPage = ref(1)
const auditPageSize = ref(20)
const auditLoading = ref(false)
const auditRange = ref(null)
const auditFilter = reactive({ entity: '', action: '' })
// 下拉候选由接口从库内 DISTINCT 反查：硬编码在前端会随后端新增实体/动作而过期
const auditFilterOptions = ref({ entities: [], actions: [] })

// 英文枚举的中文对照；未收录的原样显示英文，不至于让管理员看到莫名其妙的空值
const AUDIT_ENTITY_LABELS = {
  attendance: '考勤', order: '订单', enrollment: '报名', schedule: '排期',
  student: '学员', membership_card: '会员卡', card_type: '卡种', refund: '退费',
  points: '积分', payroll: '薪资', course: '活动', class: '班级',
  class_member: '班级成员', teacher: '员工', lead: '线索',
  suppression: '预警抑制', user: '账号', data_import: '数据导入',
}
const AUDIT_ACTION_LABELS = {
  checkin_present: '签到', checkin_late: '签到(迟到)', checkin_absent: '签到(缺勤)',
  checkin_leave: '签到(请假)', checkin_absent_auto: '自动缺席', checkin_clear: '撤销签到',
  create: '新增', update: '修改', delete: '删除', cancel: '取消', pause: '暂停', resume: '恢复',
  activate: '开卡', deduct: '扣课时', refund: '退款', settle: '结算', void_settle: '作废结算',
  enroll: '报名', enroll_cancel: '取消报名', enroll_request: '报名申请',
  enroll_approve: '报名通过', enroll_reject: '报名驳回',
  add: '增加', consume: '消耗', adjust: '调整', remove: '移除',
  deactivate: '停用', lead_convert: '线索转化', import: '导入',
  change_password: '修改密码', leave_deduct: '请假扣课', update_amount: '改价',
}
const auditEntityLabel = (v) => AUDIT_ENTITY_LABELS[v] || v || '-'
const auditActionLabel = (v) => AUDIT_ACTION_LABELS[v] || v || '-'

function fmtAuditTime(ms) {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
// 历史脏数据可能不是合法 JSON（接口解析失败时会原样返回字符串），这里不能再抛
function fmtAuditJson(v) {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
}

async function loadAuditLogs() {
  auditLoading.value = true
  try {
    const params = { page: auditPage.value, pageSize: auditPageSize.value }
    if (auditFilter.entity) params.entity = auditFilter.entity
    if (auditFilter.action) params.action = auditFilter.action
    // 后端 end 为「含当日」，日期选择器给出的本就是含当日的区间，直接透传
    if (Array.isArray(auditRange.value) && auditRange.value.length === 2) {
      params.start = auditRange.value[0]
      params.end = auditRange.value[1]
    }
    // request 拦截器已剥掉外层 {code,data,message}，此处 res 即 payload
    const res = await getAuditLogs(params)
    auditLogs.value = (res && res.list) || []
    auditTotal.value = (res && res.total) || 0
    if (res && res.filters) auditFilterOptions.value = res.filters
  } catch (e) {
    // 非管理员等场景由拦截器提示，这里只保证表格不留上一页的陈旧数据
    auditLogs.value = []
    auditTotal.value = 0
  } finally {
    auditLoading.value = false
  }
}

const onAuditSearch = () => { auditPage.value = 1; loadAuditLogs() }
const onAuditPageChange = (p) => { auditPage.value = p; loadAuditLogs() }
const onAuditReset = () => {
  auditFilter.entity = ''
  auditFilter.action = ''
  auditRange.value = null
  auditPage.value = 1
  loadAuditLogs()
}

// 切到该标签时才加载：审计表只增不减，避免每次进设置页都白查一次
watch(activeTab, (v) => {
  if (v === 'audit' && auditLogs.value.length === 0 && !auditLoading.value) loadAuditLogs()
})

// ============================================
// 机构信息
// ============================================
const orgForm = reactive({
  name: '',
  phone: '',
  address: '',
  description: '',
  logo: '',
  servicePhone: ''
})
const orgFormRef = ref(null)
const orgRules = {
  name: [{ required: true, message: '请输入机构名称', trigger: 'blur' }]
}

// Logo 上传（base64 预览并随机构信息保存）
// 限制文件类型与体积，防止 base64 过大撑爆机构设置存储
const MAX_LOGO_SIZE = 2 * 1024 * 1024 // 2MB
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']
const handleLogoChange = (file) => {
  if (!file || !file.raw) return
  if (!LOGO_TYPES.includes(file.raw.type)) {
    ElMessage.warning('仅支持 PNG / JPG / SVG / WebP 图片')
    return
  }
  if (file.raw.size > MAX_LOGO_SIZE) {
    ElMessage.warning('Logo 图片不能超过 2MB，请压缩后再上传')
    return
  }
  const reader = new FileReader()
  reader.onload = (e) => {
    orgForm.logo = e.target.result
  }
  reader.readAsDataURL(file.raw)
}

const saveOrg = async () => {
  if (orgFormRef.value) {
    const valid = await orgFormRef.value.validate().catch(() => false)
    if (!valid) return
  }
  try {
    const { servicePhone, ...orgInfo } = orgForm
    await saveSettings({
      org_info: { ...orgInfo },
      service_phone: String(servicePhone || ''),
    })
    ElMessage.success('机构信息保存成功')
  } catch (e) {
    // 拦截器已提示
  }
}

// ============================================
// 积分规则
// ============================================
const DEFAULT_POINTS_RULES = [
  { name: '训练签到', enabled: true, points: 10, description: '参与活动训练由管理端/教练端点名签到，每次+10分' },
  { name: '分享训练', enabled: true, points: 20, description: '分享训练至微信好友/群，每周1次+20分' },
  { name: '购买产品送积分', enabled: true, points: 120, description: '管理端销售登记收款时自动发放：体验10/月卡20/季卡50/年卡120' }
]
const pointsRules = ref(DEFAULT_POINTS_RULES.map((r) => ({ ...r })))

const savePoints = async () => {
  try {
    await saveSettings({ points_rules: pointsRules.value })
    ElMessage.success('积分规则保存成功')
  } catch (e) {
    // 拦截器已提示
  }
}

const addPointsRule = () => {
  pointsRules.value.push({ name: '新规则', enabled: true, points: 10, description: '' })
}

const removePointsRule = (index) => {
  pointsRules.value.splice(index, 1)
}

// ============================================
// 推送规则
// ============================================
const DEFAULT_NOTIFICATION_RULES = [
  {
    name: '训练提醒',
    type: '微信通知',
    enabled: true,
    trigger: '活动开始前',
    advanceTime: 2,
    template: '您的孩子{{studentName}}今天有{{courseName}}活动，训练时间{{time}}，请准时到课。'
  },
  {
    name: '续期提醒',
    type: '微信通知',
    enabled: true,
    trigger: '到期前15/7/1天',
    advanceTime: 0,
    reminderDays: [15, 7, 1],
    template: '您的孩子{{studentName}}的会员卡即将到期，请及时续期。'
  },
  {
    name: '缺席通知',
    type: '微信通知',
    enabled: true,
    trigger: '成员未签到',
    advanceTime: 1,
    template: '您的孩子{{studentName}}今天{{courseName}}活动未到场，请确认情况。'
  }
]
const notificationRules = ref(DEFAULT_NOTIFICATION_RULES.map((r) => ({ ...r })))

const saveNotification = async () => {
  try {
    await saveSettings({ notification_rules: notificationRules.value })
    ElMessage.success('推送规则保存成功')
  } catch (e) {
    // 拦截器已提示
  }
}

const renewalSending = ref(false)
const sendRenewalNow = async () => {
  renewalSending.value = true
  try {
    const res = await generateRenewalNotices()
    ElMessage.success(res?.message || '续费提醒处理完成')
  } catch (e) {
    // 拦截器已提示业务/网络错误
  } finally {
    renewalSending.value = false
  }
}

// ============================================
// 退费规则
// ============================================
const refundForm = reactive({
  beforeStart: 'full',
  beforeStartPercent: 10,
  afterStart: 'unused',
  afterStartPercent: 20,
  needApproval: true,
  processDays: 7
})

const saveRefund = async () => {
  try {
    await saveSettings({ refund_rules: { ...refundForm } })
    ElMessage.success('退费规则保存成功')
  } catch (e) {
    // 拦截器已提示
  }
}

// ============================================
// 请假规则
// ============================================
const leaveRules = reactive({
  requireApproval: true,
  monthlyLimit: 0,
  deductMode: 'none',
  deductAmount: 1,
  allowMakeup: true,
})
const savingLeave = ref(false)

const saveLeaveRules = async () => {
  savingLeave.value = true
  try {
    await saveSettings({ leave_rules: { ...leaveRules } })
    ElMessage.success('请假规则保存成功')
  } catch (e) {
    // 拦截器已提示
  } finally {
    savingLeave.value = false
  }
}

// ============================================
// 加载设置
// ============================================
const loadSettings = async () => {
  try {
    const data = await getSettings()
    if (data?.org_info) Object.assign(orgForm, data.org_info)
    if (data?.service_phone) orgForm.servicePhone = data.service_phone
    if (Array.isArray(data?.points_rules) && data.points_rules.length > 0) pointsRules.value = data.points_rules
    if (Array.isArray(data?.notification_rules) && data.notification_rules.length > 0) notificationRules.value = data.notification_rules
    if (data?.refund_rules) Object.assign(refundForm, data.refund_rules)
    if (data?.leave_rules) {
      const lr = data.leave_rules
      leaveRules.deductMode = lr.deductMode || (lr.deductClass ? 'class' : 'none')
      leaveRules.deductAmount = lr.deductAmount || 1
      Object.assign(leaveRules, {
        requireApproval: lr.requireApproval !== false,
        monthlyLimit: lr.monthlyLimit || 0,
        allowMakeup: lr.allowMakeup !== false,
      })
    }
    // 同步称呼方案到全局 store（驱动 $t / $roleLabel）
    // 注意：后端 GET /api/settings 返回 snake_case 键（term_scheme / term_overrides），需对齐读取
    if (data?.term_scheme) settingsStore.termScheme = data.term_scheme
    if (data?.term_overrides) settingsStore.termOverrides = data.term_overrides || {}
    initTerms()
  } catch (e) {
    // 无保存记录时使用默认值
    pointsRules.value = DEFAULT_POINTS_RULES.map((r) => ({ ...r }))
    notificationRules.value = DEFAULT_NOTIFICATION_RULES.map((r) => ({ ...r }))
  }
}
</script>

<style lang="scss" scoped>
.settings-page {
  max-width: var(--t-content-max-narrow);
  margin: 0 auto;
}

// 设置布局
.settings-layout {
  display: flex;
  gap: var(--t-spacing-lg);
  align-items: flex-start;
  flex-wrap: wrap;
}

// 左侧导航
.settings-nav {
  width: 200px;
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: var(--t-spacing-md);
  position: sticky;
  top: 88px;
  flex-shrink: 0;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 12px 16px;
  border-radius: var(--t-radius-md);
  cursor: pointer;
  font-size: var(--t-fs-base);
  color: var(--t-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;

  &:hover {
    background: transparent;
  }

  &.active {
    background: var(--t-accent-bg);
    color: var(--t-accent-text);
    font-weight: 600;
  }
}

// 右侧内容
.settings-content {
  flex: 1 1 0;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
}

.settings-section {
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: 24px;
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
}

.section-title {
  font-size: var(--t-fs-2xl);
  font-weight: 600;
  color: var(--t-text-1);
  margin: 0 0 var(--t-spacing-md);
}

.section-desc {
  font-size: var(--t-fs-base);
  color: var(--t-text-2);
  margin: 0 0 24px;
}

.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: var(--t-spacing-lg);

  .section-desc {
    margin-bottom: 0;
  }
}

.table-container {
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  overflow: hidden;
}

.price-text {
  font-weight: 700;
  color: var(--t-text-1);
}

.unit-text {
  margin-left: 8px;
  color: var(--t-text-2);
  font-size: var(--t-fs-sm);
}

// 规则卡片列表
.rule-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 24px;
}

.rule-card {
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  overflow: hidden;
}

.rule-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}

.section-hint {
  font-size: var(--t-fs-sm);
  color: var(--t-text-3);
  margin: 10px 0 0;
  line-height: 1.6;
}

.dash-widgets {
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dash-widget-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: var(--t-radius-md);
  transition: background-color 0.16s ease-out;

  &:hover {
    background: var(--t-surface-hover);
  }
}

.dash-widget-label {
  font-size: var(--t-fs-base);
  color: var(--t-text-1);
}

.backup-box {
  max-width: 560px;
}

.backup-tip {
  font-size: var(--t-fs-sm);
  line-height: 1.7;
  color: var(--t-text-2);
  margin: 0 0 14px;
}

// 备份卡片（两种备份方式）
.backup-card {
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-card);
  padding: 20px;
  margin-bottom: 16px;

  &:last-child {
    margin-bottom: 0;
  }
}

.backup-card__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}

.backup-card__icon {
  color: var(--t-accent-text);
  background: var(--t-accent-bg);
  border-radius: var(--t-radius-md);
  padding: 8px;
  flex-shrink: 0;
  margin-top: 2px;
}

.backup-card__title {
  font-size: var(--t-fs-lg);
  font-weight: 600;
  color: var(--t-text-1);
}

.backup-card__desc {
  font-size: var(--t-fs-sm);
  color: var(--t-text-3);
  margin-top: 2px;
  line-height: 1.6;
}

// 导出/导入区块
.io-block {
  & + .io-block {
    margin-top: 8px;
  }
}

.io-block__label {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
  margin-bottom: 12px;
}

.module-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.module-check {
  margin-right: 0;
  margin-bottom: 0;
}

.io-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.io-hint {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.io-note {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  line-height: 1.6;
  margin: 12px 0 0;
}

.import-file-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--t-fs-sm);
  color: var(--t-text-1);
  background: var(--t-surface-hover);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
  padding: 8px 12px;
  margin: 0 0 12px;
}

.io-info {
  color: var(--t-text-3);
  cursor: help;
}

.io-result {
  margin-top: 16px;
}

.io-result__list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.io-result__list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--t-fs-sm);
  padding: 8px 12px;
  background: var(--t-surface-hover);
  border-radius: var(--t-radius-md);
}

.io-result__name {
  color: var(--t-text-1);
}

.io-result__count {
  color: var(--t-accent-text);
  font-weight: 600;
}

.io-result__err {
  font-size: var(--t-fs-xs);
  color: var(--t-danger);
  margin: 10px 0 0;
  line-height: 1.6;
}

.rule-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  background: transparent;
}

.rule-name {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
}

.rule-name-input {
  max-width: 320px;
  :deep(.el-input__inner) {
    font-weight: 600;
    font-size: var(--t-fs-base);
  }
}

.rule-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.form-hint {
  margin-left: 10px;
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
}

.rule-tag {
  font-size: var(--t-fs-xs);
  color: var(--t-accent-text);
  background: var(--t-accent-bg);
  padding: 2px 8px;
  border-radius: var(--t-radius-sm);
  margin-left: 8px;
}

.rule-body {
  padding: 20px;
}

.unit-text {
  margin-left: 8px;
  font-size: var(--t-fs-base);
  color: var(--t-text-2);
}

// 导入/导出/恢复 确认弹窗
.confirm-body {
  font-size: var(--t-fs-base);
  color: var(--t-text-1);
}

.confirm-lead {
  margin: 0 0 12px;
  line-height: 1.7;
}

.confirm-list {
  list-style: none;
  margin: 0 0 4px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.confirm-list li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  background: var(--t-surface-hover);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
  line-height: 1.6;
}

.confirm-mod-name {
  font-weight: 600;
  color: var(--t-text-1);
}

.confirm-mod-desc {
  font-size: var(--t-fs-sm);
  color: var(--t-text-2);
}

.confirm-file {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--t-fs-sm);
  color: var(--t-text-1);
  background: var(--t-surface-hover);
  border: 1px solid var(--t-line);
  border-radius: var(--t-radius-md);
  padding: 8px 12px;
  margin: 0 0 12px;
  word-break: break-all;
}

.confirm-warn {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 12px 0 0;
  padding: 10px 12px;
  font-size: var(--t-fs-sm);
  line-height: 1.7;
  color: var(--t-danger-text);
  background: color-mix(in srgb, var(--t-danger) 8%, transparent);
  border-radius: var(--t-radius-md);

  .el-icon {
    margin-top: 2px;
    flex-shrink: 0;
  }

  code {
    background: transparent;
    padding: 0 2px;
  }
}

.confirm-hint {
  font-size: var(--t-fs-xs);
  color: var(--t-text-3);
  line-height: 1.6;
  margin: 12px 0 0;
}

.confirm-date {
  &__label {
    font-size: var(--t-fs-base);
    font-weight: 600;
    color: var(--t-text-1);
    margin-bottom: 10px;
  }
}

// 响应式
@media (max-width: 768px) {
  .settings-layout {
    flex-direction: column;
  }

  .settings-nav {
    width: 100%;
    position: static;
    display: flex;
    overflow-x: auto;
    gap: 4px;
  }

  .nav-item {
    white-space: nowrap;
    flex-shrink: 0;
  }

  .settings-section {
    padding: 20px;
  }
}

.logo-preview {
  margin-top: 10px;
  width: 72px;
  height: 72px;
  border-radius: var(--t-radius-lg);
  overflow: hidden;
  border: 1px solid var(--t-line);
  background: var(--t-surface);
  display: flex;
  align-items: center;
  justify-content: center;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}
</style>
