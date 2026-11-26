<template>
  <div class="batch-daily-tasks">
    <div class="main-layout">
      <!-- Left Column -->
      <div class="left-column">
        <n-card v-if="saltOnceRows.length" title="盐场参与一次" size="small" style="margin-bottom: 12px">
          <p>先逐号布阵行军，再逐号核验到达并攻击。每号至少等待120秒；结果不明时禁止重攻。请保持页面打开。</p>
          <div v-for="row in saltOnceRows" :key="row.tokenId" style="margin-bottom: 6px; overflow-wrap: anywhere">
            {{ tokens.find(t => t.id === row.tokenId)?.name || row.tokenId }}：
            {{ ({pending:'待布阵',preparing:'布阵中',targeting:'选址中',submitting:'提交行军中',marching:'行军中',ready:'待攻击',fighting:'战斗中',completed:'已完成',failed:'失败',unknown:'待核验（禁止重攻）',stopped:'已停止'})[row.state] }}
            · 尝试 {{ row.attempts }}/3
            <span v-if="row.target"> · 目标 {{ row.target.buildingId }}</span>
            <span v-if="row.marchStartedAt"> · 行军 {{ new Date(row.marchStartedAt).toLocaleTimeString() }}</span>
            <span v-if="row.error"> · {{ row.error }}</span>
          </div>
          <n-button size="small" :disabled="!isSaltOnceRunning()" @click="stopSaltOnce">停止盐场任务</n-button>
        </n-card>

        <SaltDiagnosticsPanel />
        <AutoWeeklyPanel
          :config="autoConfig" :now="autoNow" :activity="autoActivity"
          :batches="autoBatches" :groups="tokenGroups" :today="autoToday" :week="autoWeek"
          :records="autoRecords" :runtime-state="autoRuntimeState"
          :error="autoStorageError || autoRuntimeState.error"
          @save="saveAutoConfig" @retry="retryAutoPlan"
        />

        <!-- Header -->
        <div class="page-header">
          <h2>批量日常任务</h2>
          <div class="batch-header-actions">
            <n-button
              type="primary"
              @click="startBatch"
              :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
              size="medium"
            >
              {{ (isRunning || autoExecutionActive || scheduledExecutionActive) ? "执行中..." : "开始执行" }}
            </n-button>
            <n-button
              @click="stopBatch"
              :disabled="!(isRunning || autoExecutionActive || scheduledExecutionActive)"
              type="error"
              size="medium"
            >
              停止
            </n-button>
            <n-button
              @click="openTemplateManagerModal"
              type="info"
              size="medium"
            >
              任务模板
            </n-button>
            <n-button @click="openBatchSettings" type="default" size="medium">
              <template #icon>
                <n-icon>
                  <Settings />
                </n-icon>
              </template>
              设置
            </n-button>
          </div>
        </div>

        <div class="batch-tools">
          <div class="batch-tools-row">
            <span>共 {{ scheduledTasks.length }} 个定时任务</span>
            <span v-if="shortestCountdownTask" class="schedule-countdown">
              即将执行：{{ shortestCountdownTask.task.name }} ({{ shortestCountdownTask.countdown.formatted }})
            </span>
            <span v-else class="batch-tools-hint">暂无定时任务</span>
            <div class="batch-tools-buttons">
              <n-button type="primary" size="small" @click="openTaskModal">新增定时任务</n-button>
              <n-button size="small" @click="showTasksModal = true">查看定时任务</n-button>
            </div>
          </div>
          <div id="config-transfer" class="batch-tools-row config-transfer-row">
            <span class="batch-tools-label">配置迁移</span>
            <div class="batch-tools-buttons">
              <n-button size="small" :disabled="configTransferBusy" @click="showConfigExport = true">导出配置</n-button>
              <n-upload class="config-upload" :show-file-list="false" :disabled="configTransferBusy"
                accept=".json" :default-upload="false" :file-list="[]" @change="importConfig">
                <n-button size="small" :disabled="configTransferBusy">导入配置</n-button>
              </n-upload>
            </div>
          </div>
        </div>

        <!-- Token Selection -->
        <n-card title="账号列表" class="token-list-card">
          <div style="margin-bottom: 16px">
            <!-- 分组管理和选择 -->
            <n-space vertical style="width: 100%">
              <!-- 分组选择部分 -->
              <div
                v-if="tokenGroups.length > 0"
                class="group-selection-section"
              >
                <div
                  style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                  "
                >
                  <label style="font-weight: 500; color: #333">分组选择</label>
                  <n-button
                    size="small"
                    type="error"
                    text
                    @click="clearAllGroupSelection"
                  >
                    一键清除所有分组选择
                  </n-button>
                </div>
                <div style="display: flex; gap: 8px; flex-wrap: wrap">
                  <div
                    v-for="group in tokenGroups"
                    :key="group.id"
                    @click="toggleGroupSelection(group.id)"
                    :style="{
                      padding: '8px 12px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      backgroundColor: isGroupSelected(group.id)
                        ? group.color
                        : 'transparent',
                      border: `2px solid ${group.color}`,
                      color: isGroupSelected(group.id) ? 'white' : group.color,
                      fontWeight: isGroupSelected(group.id) ? '600' : '400',
                      transition: 'all 0.3s ease',
                      userSelect: 'none',
                    }"
                  >
                    {{ group.name }} ({{
                      getValidGroupTokenIds(group.id).length
                    }})
                  </div>
                </div>
              </div>

              <!-- 分组管理按钮 -->
              <div
                style="
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <n-button
                  type="info"
                  size="small"
                  @click="showGroupManageModal = true"
                >
                  管理分组
                </n-button>
                <span
                  v-if="selectedGroups.length > 0"
                  style="font-size: 12px; color: #86909c"
                >
                  已选择 {{ selectedGroups.length }} 个分组，包含
                  {{ selectedTokens.length }} 个账号
                </span>
              </div>
            </n-space>
          </div>

          <!-- 排序按钮组 -->
          <div class="sort-buttons" style="margin-bottom: 12px">
            <n-space align="center">
              <n-button-group size="small">
                <n-button
                  @click="toggleSort('name')"
                  :type="sortConfig.field === 'name' ? 'primary' : 'default'"
                >
                  名称 {{ getSortIcon("name") }}
                </n-button>
                <n-button
                  @click="toggleSort('server')"
                  :type="sortConfig.field === 'server' ? 'primary' : 'default'"
                >
                  服务器 {{ getSortIcon("server") }}
                </n-button>
                <n-button
                  @click="toggleSort('createdAt')"
                  :type="
                    sortConfig.field === 'createdAt' ? 'primary' : 'default'
                  "
                >
                  创建时间 {{ getSortIcon("createdAt") }}
                </n-button>
                <n-button
                  @click="toggleSort('lastUsed')"
                  :type="
                    sortConfig.field === 'lastUsed' ? 'primary' : 'default'
                  "
                >
                  最后使用 {{ getSortIcon("lastUsed") }}
                </n-button>
              </n-button-group>
            </n-space>
          </div>

          <n-space vertical>
            <n-checkbox
              :checked="isAllSelected"
              :indeterminate="isIndeterminate"
              @update:checked="handleSelectAll"
            >
              全选
            </n-checkbox>
            <n-checkbox-group v-model:value="selectedTokens">
              <n-grid
                :x-gap="12"
                :y-gap="8"
                :cols="batchSettings.tokenListColumns"
              >
                <n-grid-item v-for="token in sortedTokens" :key="token.id">
                  <div class="token-row">
                    <n-checkbox
                      :value="token.id"
                      :label="token.name"
                      style="flex: 1"
                    >
                      <div class="token-item">
                        <span>{{ token.name }}</span>
                        <n-tag
                          size="small"
                          :type="getStatusType(token.id)"
                          style="margin-left: 8px"
                        >
                          {{ getStatusText(token.id) }}
                        </n-tag>
                        <!-- 显示token所属的分组 -->
                        <div
                          v-if="tokenStore.getTokenGroups(token.id).length > 0"
                          style="
                            margin-left: 8px;
                            display: inline-flex;
                            gap: 4px;
                            flex-wrap: wrap;
                          "
                        >
                          <n-tag
                            v-for="group in tokenStore.getTokenGroups(token.id)"
                            :key="group.id"
                            size="small"
                            :color="{ color: group.color, textColor: 'white' }"
                            style="font-size: 11px"
                          >
                            {{ group.name }}
                          </n-tag>
                        </div>
                      </div>
                    </n-checkbox>
                    <n-button
                      size="tiny"
                      circle
                      @click.stop="openSettings(token)"
                    >
                      <template #icon>
                        <n-icon>
                          <Settings />
                        </n-icon>
                      </template>
                    </n-button>
                  </div>
                </n-grid-item>
              </n-grid>
            </n-checkbox-group>
          </n-space>
        </n-card>

        <!-- Batch Functions -->
        <n-card title="批量功能列表" style="margin-top: 16px">
          <n-tabs type="line" animated>
            <n-tab-pane name="daily" tab="日常">
              <n-space>
                <n-button
                  size="small"
                  :disabled="isRunning || autoExecutionActive || scheduledExecutionActive || selectedTokens.length === 0"
                  @click="handleRefreshTokens"
                >
                  刷新Token
                </n-button>
                <n-button size="small"
                  :disabled="isRunning || autoExecutionActive || scheduledExecutionActive || selectedTokens.length === 0"
                  @click="handleBonfireSignup"
                  title="团长或副团长在北京时间周五至周日为俱乐部报名，已报名自动跳过"
                >篝火报名</n-button>
                <n-button size="small" :disabled="isRunning || autoExecutionActive || scheduledExecutionActive" @click="showJianghuMarket = true">一键江湖黑市</n-button>
                <n-button size="small"
                  :disabled="isRunning || autoExecutionActive || scheduledExecutionActive || !selectedTokens.length"
                  title="竞技场未完成时挑战1次。普通日最多10抽，本期第7天经服务器确认后使用剩余祈愿券"
                  @click="handlePhoenixPrayer">凤仪祈愿</n-button>
                <n-button
                  size="small"
                  @click="claimHangUpRewards"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  领取挂机
                </n-button>
                <n-button
                  size="small"
                  @click="batchAddHangUpTime"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键加钟
                </n-button>
                <n-button
                  size="small"
                  @click="resetBottles"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  重置罐子
                </n-button>
                <n-button
                  size="small"
                  @click="batchlingguanzi"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键领取罐子
                </n-button>
                <n-button
                  size="small"
                  @click="openApplyLegionModal"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  批量申请俱乐部
                </n-button>
                <n-button
                  size="small"
                  @click="batchclubsign"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键俱乐部签到
                </n-button>
                <n-button
                  size="small"
                  @click="batchStudy"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键答题
                </n-button>
                <n-button
                  size="small"
                  @click="batcharenafight"
                  :disabled="
                    (isRunning || autoExecutionActive || scheduledExecutionActive) ||
                    selectedTokens.length === 0 ||
                    !isarenaActivityOpen
                  "
                >
                  一键竞技场战斗3次
                </n-button>
                <n-button
                  size="small"
                  @click="openBlackMarketPurchaseModal"
                >
                  黑市清单配置
                </n-button>
                <!-- FORMATION_DISPATCH_V1 -->
                <n-button
                  size="small"
                  @click="openFormationDispatchModal"
                  :disabled="isRunning || autoExecutionActive || scheduledExecutionActive"
                >
                  阵容下发配置
                </n-button>
                <n-button
                  size="small"
                  @click="store_purchase"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键黑市采购
                </n-button>
                <n-button
                  size="small"
                  @click="collection_claimfreereward"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键领取珍宝阁
                </n-button>
                <n-button
                  size="small"
                  @click="batchGenieSweep"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键灯神扫荡
                </n-button>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="dungeon" tab="副本">
              <n-space>
                <n-button size="small" :disabled="isRunning || autoExecutionActive || scheduledExecutionActive || !selectedTokens.length" @click="showGenieChallenge = true">普通灯神挑战</n-button>
                <n-button size="small" @click="batchSaltOnce"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0">盐场参与一次</n-button>
                <n-button size="small" @click="batchCampChallengePet({ manual: true })"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0">营地空投保底</n-button>
                <n-button
                  size="small"
                  @click="climbTower"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键爬塔
                </n-button>
                <n-button
                  size="small"
                  @click="batchmengjing"
                  :disabled="
                    (isRunning || autoExecutionActive || scheduledExecutionActive) ||
                    selectedTokens.length === 0 ||
                    !ismengjingActivityOpen
                  "
                >
                  一键梦境
                </n-button>
                <n-button
                  size="small"
                  @click="skinChallenge"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键换皮闯关
                </n-button>
                <n-button
                  size="small"
                  @click="batchClaimPeachTasks"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键领取蟠桃园任务
                </n-button>
                <n-button
                  size="small"
                  @click="batchBuyDreamItems"
                  :disabled="
                    (isRunning || autoExecutionActive || scheduledExecutionActive) ||
                    selectedTokens.length === 0 ||
                    !ismengjingActivityOpen
                  "
                >
                  一键购买梦境商品
                </n-button>              
                <n-popselect
                  :value="footballPick"
                  :options="footballPickOptions"
                  trigger="click"
                  @update:value="onFootballPickChange"
                >
                  <n-button
                    size="small"
                    :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                  >
                    一键竞猜({{ footballPickLabel }})
                  </n-button>
                </n-popselect>
                <n-button
                  size="small"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                  @click="showApexGuessModal = true"
                >
                  逐鹿盐山竞猜/补领奖
                </n-button>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="weirdTower" tab="怪异塔">
              <n-space>
                <n-input-number
                  v-model:value="weirdTowerMaxClimb"
                  class="weird-tower-count-input"
                  size="small"
                  :min="1"
                  :precision="0"
                  :show-button="false"
                  placeholder="次数"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive)"
                />
                <span class="weird-tower-count-unit">次</span>
                <n-button
                  size="small"
                  @click="climbWeirdTower"
                  :disabled="
                    (isRunning || autoExecutionActive || scheduledExecutionActive) ||
                    selectedTokens.length === 0 ||
                    !isWeirdTowerActivityOpen
                  "
                >
                  一键爬怪异塔
                </n-button>
                <!-- WEIRD_TOWER_INTEGRATED_FINAL_V4: keep all legacy buttons -->
                <n-button
                  size="small"
                  type="primary"
                  @click="batchWeirdTowerIntegrated"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0 || !isWeirdTowerActivityOpen"
                >
                  一键怪异塔综合处理
                </n-button>
                <n-button
                  size="small"
                  @click="batchUseItems"
                  :disabled="
                    (isRunning || autoExecutionActive || scheduledExecutionActive) ||
                    selectedTokens.length === 0 ||
                    !isWeirdTowerActivityOpen
                  "
                >
                  一键使用怪异塔道具
                </n-button>
                <n-button
                  size="small"
                  @click="batchMergeItems"
                  :disabled="
                    (isRunning || autoExecutionActive || scheduledExecutionActive) ||
                    selectedTokens.length === 0 ||
                    !isWeirdTowerActivityOpen
                  "
                >
                  一键怪异塔合成
                </n-button>
                <n-button
                  size="small"
                  @click="batchClaimFreeEnergy"
                  :disabled="
                    (isRunning || autoExecutionActive || scheduledExecutionActive) ||
                    selectedTokens.length === 0 ||
                    !isWeirdTowerActivityOpen
                  "
                >
                  一键领取怪异塔免费道具
                </n-button>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="resource" tab="资源">
              <n-space>
                <n-button
                  size="small"
                  @click="openHelperModal('box')"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  批量开箱
                </n-button>
                <n-button
                  size="small"
                  @click="openHelperModal('pointsBox')"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  按积分开箱
                </n-button>
                <n-button
                  size="small"
                  @click="batchClaimBoxPointReward"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  领取宝箱积分
                </n-button>
                <n-button
                  size="small"
                  @click="openHelperModal('fish')"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  批量钓鱼
                </n-button>
                <n-button
                  size="small"
                  @click="openHelperModal('recruit')"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  批量招募
                </n-button>
                <n-button
                  size="small"
                  @click="openRedeemCodeModal"
                >
                  兑换码配置与兑换
                </n-button>
                <n-button
                  size="small"
                  @click="batchHeroUpgrade"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键英雄升星
                </n-button>
                <n-button
                  size="small"
                  @click="batchBookUpgrade"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键图鉴升星
                </n-button>
                <n-button
                  size="small"
                  @click="batchClaimStarRewards"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键领取图鉴奖励
                </n-button>
                <n-button
                  size="small"
                  @click="legion_storebuygoods"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键购买四圣碎片
                </n-button>
                <n-button
                  size="small"
                  @click="legionStoreBuySkinCoins"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键购买俱乐部5皮肤币
                </n-button>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="legacy" tab="功法">
              <n-space>
                <n-button
                  size="small"
                  @click="batchLegacyClaim"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  批量功法残卷领取
                </n-button>
                <n-button
                  size="small"
                  @click="showLegacyGiftModal = true"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  批量功法残卷赠送
                </n-button>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="monthly" tab="月度">
              <n-space>
                <n-button
                  size="small"
                  @click="batchTopUpFish"
                  :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || selectedTokens.length === 0"
                >
                  一键钓鱼补齐
                </n-button>
                <n-button
                  size="small"
                  @click="batchTopUpArena"
                  :disabled="
                    (isRunning || autoExecutionActive || scheduledExecutionActive) ||
                    selectedTokens.length === 0 ||
                    !isarenaActivityOpen
                  "
                >
                  一键竞技场补齐
                </n-button>
                <n-button
                  size="small"
                  @click="openWarGuessModal"
                  :disabled="
                    (isRunning || autoExecutionActive || scheduledExecutionActive) ||
                    selectedTokens.length === 0 ||
                    !isWarGuessActivityOpen
                  "
                  :title="isWarGuessActivityOpen ? '' : warGuessActivityTip"
                >
                  月赛助威
                </n-button>
              </n-space>
            </n-tab-pane>
          </n-tabs>
        </n-card>
      </div>

      <!-- Right Column - Execution Log -->
      <div class="right-column">
        <n-card class="log-card">
          <template #header>
            <div class="custom-card-header">
              <div class="card-title">
                {{
                  currentRunningTokenName
                    ? `正在执行: ${currentRunningTokenName}`
                    : "执行日志"
                }}
                <span
                  style="margin-left: 12px; font-size: 12px; color: #86909c"
                >
                  {{ logs.length }}/{{ batchSettings.maxLogEntries || 1000 }}
                </span>
              </div>
              <div class="log-header-controls">
                <n-checkbox v-model:checked="autoScrollLog" size="small">
                  自动滚动
                </n-checkbox>
                <n-checkbox v-model:checked="filterErrorsOnly" size="small">
                  只看错误
                </n-checkbox>
                <n-tag v-if="errorCount > 0" type="error" size="small">
                  {{ errorCount }} 个错误
                </n-tag>
                <n-button size="small" @click="clearLogs"> 清空日志 </n-button>
                <n-button size="small" @click="copyLogs"> 复制日志 </n-button>
              </div>
            </div>
          </template>
          <n-progress
            type="line"
            :percentage="currentProgress"
            :indicator-placement="'inside'"
            processing
          />
          <div class="log-container" ref="logContainer">
            <div
              v-for="(log, index) in filteredLogs"
              :key="index"
              class="log-item"
              :class="log.type"
            >
              <span class="time">{{ log.time }}</span>
              <span class="message">{{ log.message }}</span>
            </div>
          </div>
        </n-card>
      </div>
    </div>

    <!-- Settings Modal -->
    <n-modal
      v-model:show="showSettingsModal"
      preset="card"
      :title="`任务设置 - ${currentSettingsTokenName}`"
      style="width: 90%; max-width: 400px"
    >
      <div class="settings-content">
        <div class="settings-grid">
          <div class="setting-item">
            <label class="setting-label">竞技场阵容</label>
            <n-select
              v-model:value="currentSettings.arenaFormation"
              :options="formationOptions"
              size="small"
            />
          </div>
          <div class="setting-item">
            <label class="setting-label">爬塔阵容</label>
            <n-select
              v-model:value="currentSettings.towerFormation"
              :options="formationOptions"
              size="small"
            />
          </div>
          <div class="setting-item">
            <label class="setting-label">BOSS阵容</label>
            <n-select
              v-model:value="currentSettings.bossFormation"
              :options="formationOptions"
              size="small"
            />
          </div>
          <div class="setting-item">
            <label class="setting-label">BOSS次数</label>
            <n-select
              v-model:value="currentSettings.bossTimes"
              :options="bossTimesOptions"
              size="small"
            />
          </div>
          <div class="setting-switches">
            <div class="switch-row">
              <span class="switch-label">领罐子</span
              ><n-switch v-model:value="currentSettings.claimBottle" />
            </div>
            <div class="switch-row">
              <span class="switch-label">领挂机</span
              ><n-switch v-model:value="currentSettings.claimHangUp" />
            </div>
            <div class="switch-row">
              <span class="switch-label">竞技场</span
              ><n-switch v-model:value="currentSettings.arenaEnable" />
            </div>
            <div class="switch-row">
              <span class="switch-label">开宝箱</span
              ><n-switch v-model:value="currentSettings.openBox" />
            </div>
            <div class="switch-row">
              <span class="switch-label">领取邮件奖励</span
              ><n-switch v-model:value="currentSettings.claimEmail" />
            </div>
            <div class="switch-row">
              <span class="switch-label">黑市购买物品</span
              ><n-switch v-model:value="currentSettings.blackMarketPurchase" />
            </div>
            <div class="switch-row">
              <span class="switch-label">付费招募</span
              ><n-switch v-model:value="currentSettings.payRecruit" />
            </div>
          </div>
        </div>
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button type="primary" @click="saveSettings">保存设置</n-button>
        </div>
      </div>
    </n-modal>

    <!-- Task Template Modal -->
    <n-modal
      v-model:show="showTaskTemplateModal"
      preset="card"
      :title="currentTemplateId ? '编辑任务模板' : '任务模板设置'"
      style="width: 90%; max-width: 400px"
    >
      <div class="settings-content">
        <div class="settings-grid">
          <div class="setting-item">
            <label class="setting-label">模板名称</label>
            <n-input
              v-model:value="currentTemplateName"
              placeholder="请输入模板名称"
              size="small"
            />
          </div>
          <div class="setting-item">
            <label class="setting-label">竞技场阵容</label>
            <n-select
              v-model:value="currentTemplate.arenaFormation"
              :options="formationOptions"
              size="small"
            />
          </div>
          <div class="setting-item">
            <label class="setting-label">爬塔阵容</label>
            <n-select
              v-model:value="currentTemplate.towerFormation"
              :options="formationOptions"
              size="small"
            />
          </div>
          <div class="setting-item">
            <label class="setting-label">BOSS阵容</label>
            <n-select
              v-model:value="currentTemplate.bossFormation"
              :options="formationOptions"
              size="small"
            />
          </div>
          <div class="setting-item">
            <label class="setting-label">BOSS次数</label>
            <n-select
              v-model:value="currentTemplate.bossTimes"
              :options="bossTimesOptions"
              size="small"
            />
          </div>
          <div class="setting-switches">
            <div class="switch-row">
              <span class="switch-label">领罐子</span
              ><n-switch v-model:value="currentTemplate.claimBottle" />
            </div>
            <div class="switch-row">
              <span class="switch-label">领挂机</span
              ><n-switch v-model:value="currentTemplate.claimHangUp" />
            </div>
            <div class="switch-row">
              <span class="switch-label">竞技场</span
              ><n-switch v-model:value="currentTemplate.arenaEnable" />
            </div>
            <div class="switch-row">
              <span class="switch-label">开宝箱</span
              ><n-switch v-model:value="currentTemplate.openBox" />
            </div>
            <div class="switch-row">
              <span class="switch-label">领取邮件奖励</span
              ><n-switch v-model:value="currentTemplate.claimEmail" />
            </div>
            <div class="switch-row">
              <span class="switch-label">黑市购买物品</span
              ><n-switch v-model:value="currentTemplate.blackMarketPurchase" />
            </div>
            <div class="switch-row">
              <span class="switch-label">付费招募</span
              ><n-switch v-model:value="currentTemplate.payRecruit" />
            </div>
          </div>
        </div>
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button
            @click="showTaskTemplateModal = false"
            style="margin-right: 12px"
            >取消</n-button
          >
          <n-button @click="saveTaskTemplate" type="primary">保存模板</n-button>
        </div>
      </div>
    </n-modal>

    <!-- Apply Template Modal -->
    <n-modal
      v-model:show="showApplyTemplateModal"
      preset="card"
      title="应用任务模板"
      style="width: 90%; max-width: 600px"
    >
      <div class="settings-content">
        <div class="settings-grid">
          <div class="setting-item">
            <label class="setting-label">选择模板</label>
            <n-select
              v-model:value="selectedTemplateId"
              :options="taskTemplates"
              label-field="name"
              value-field="id"
              placeholder="请选择要应用的模板"
              size="small"
              style="width: 100%"
            />
          </div>
          <div class="setting-item">
            <label class="setting-label">选择账号</label>

            <!-- 分组快速选择 -->
            <div
              style="
                margin-bottom: 12px;
                border-bottom: 1px solid #eee;
                padding-bottom: 8px;
              "
            >
              <div style="font-size: 12px; color: #86909c; margin-bottom: 8px">
                快速选择分组：
              </div>
              <div style="display: flex; gap: 6px; flex-wrap: wrap">
                <n-button
                  v-for="group in tokenGroups"
                  :key="group.id"
                  size="small"
                  @click="
                    () => {
                      const groupTokenIds = getValidGroupTokenIds(group.id);
                      groupTokenIds.forEach((id) => {
                        if (!selectedTokensForApply.includes(id)) {
                          selectedTokensForApply.push(id);
                        }
                      });
                    }
                  "
                  :style="{
                    borderColor: group.color,
                    color: group.color,
                  }"
                  ghost
                >
                  {{ group.name }}
                </n-button>
                <div
                  v-if="tokenGroups.length === 0"
                  style="font-size: 12px; color: #ccc"
                >
                  暂无分组
                </div>
              </div>
            </div>

            <n-checkbox
              :checked="isAllSelectedForApply"
              :indeterminate="isIndeterminateForApply"
              @update:checked="handleSelectAllForApply"
            >
              全选
            </n-checkbox>
            <n-checkbox-group
              v-model:value="selectedTokensForApply"
              style="margin-top: 8px"
            >
              <n-grid :cols="2" :x-gap="12" :y-gap="8">
                <n-grid-item v-for="token in sortedTokens" :key="token.id">
                  <n-checkbox :value="token.id">{{ token.name }}</n-checkbox>
                </n-grid-item>
              </n-grid>
            </n-checkbox-group>
          </div>
        </div>
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button @click="showApplyTemplateModal = false">取消</n-button>
          <n-button
            @click="applyTemplate"
            type="success"
            :disabled="
              !selectedTemplateId || selectedTokensForApply.length === 0
            "
            >应用模板</n-button
          >
        </div>
      </div>
    </n-modal>

    <!-- Template Manager Modal -->
    <n-modal
      v-model:show="showTemplateManagerModal"
      preset="card"
      title="任务模板管理"
      style="width: 90%; max-width: 800px"
    >
      <div class="settings-content">
        <div
          class="modal-header-actions"
          style="
            margin-bottom: 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          "
        >
          <div>
            <n-button type="primary" @click="openNewTemplateModal"
              >新增模板</n-button
            >
            <n-button
              @click="openApplyTemplateModal"
              type="success"
              style="margin-left: 8px"
              >应用模板</n-button
            >
            <n-button
              @click="openAccountTemplateModal"
              type="info"
              style="margin-left: 8px"
              >查看账号模板引用</n-button
            >
          </div>
          <n-input placeholder="搜索模板" size="small" style="width: 200px" />
        </div>

        <!-- Template List -->
        <div
          class="template-list"
          style="max-height: 400px; overflow-y: auto; margin-bottom: 16px"
        >
          <n-card
            v-for="template in filteredTaskTemplates"
            :key="template.id"
            size="small"
            style="margin-bottom: 12px"
          >
            <div
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <div>
                <h4 style="margin: 0; margin-bottom: 8px">
                  {{ template.name }}
                </h4>
                <div style="font-size: 12px; color: #86909c">
                  创建时间: {{ new Date(template.createdAt).toLocaleString() }}
                  <span v-if="template.updatedAt"
                    >, 更新时间:
                    {{ new Date(template.updatedAt).toLocaleString() }}</span
                  >
                </div>
              </div>
              <div style="display: flex; gap: 8px">
                <n-button size="small" @click="openEditTemplateModal(template)"
                  >编辑</n-button
                >
                <n-button
                  size="small"
                  type="error"
                  @click="deleteTaskTemplate(template.id)"
                  >删除</n-button
                >
              </div>
            </div>
          </n-card>
          <div
            v-if="filteredTaskTemplates.length === 0"
            style="text-align: center; padding: 24px; color: #86909c"
          >
            暂无模板
          </div>
        </div>

        <!-- Actions -->
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button @click="showTemplateManagerModal = false">关闭</n-button>
        </div>
      </div>
    </n-modal>

    <!-- Account Template References Modal -->
    <n-modal
      v-model:show="showAccountTemplateModal"
      preset="card"
      title="账号模板引用查看"
      style="width: 90%; max-width: 800px"
    >
      <div class="settings-content">
        <div
          class="modal-header-actions"
          style="
            margin-bottom: 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          "
        >
          <div>
            <span>共 {{ filteredAccountTemplates.length }} 个账号</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center">
            <label style="font-size: 12px; color: #86909c">按模板筛选:</label>
            <n-select
              v-model:value="selectedTemplateForFilter"
              :options="taskTemplates"
              label-field="name"
              value-field="id"
              placeholder="全部模板"
              size="small"
              @update:value="filterAccountTemplates"
              style="width: 180px"
            />
          </div>
        </div>

        <!-- Account Template List -->
        <div
          class="account-template-list"
          style="max-height: 400px; overflow-y: auto; margin-bottom: 16px"
        >
          <n-card
            v-for="item in filteredAccountTemplates"
            :key="item.tokenId"
            size="small"
            style="margin-bottom: 12px"
          >
            <div
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <div>
                <h4 style="margin: 0; margin-bottom: 4px">
                  {{ item.tokenName }}
                </h4>
              </div>
              <div>
                <n-tag
                  :type="item.templateId ? 'success' : 'default'"
                  size="small"
                >
                  {{ item.templateName }}
                </n-tag>
              </div>
            </div>
          </n-card>
          <div
            v-if="filteredAccountTemplates.length === 0"
            style="text-align: center; padding: 24px; color: #86909c"
          >
            暂无账号数据
          </div>
        </div>

        <!-- Actions -->
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button @click="showAccountTemplateModal = false">关闭</n-button>
        </div>
      </div>
    </n-modal>

    <!-- Legacy Gift Modal -->
    <n-modal
      v-model:show="showLegacyGiftModal"
      preset="card"
      title="批量功法残卷赠送"
      style="width: 90%; max-width: 600px"
    >
      <div class="settings-content">
        <div class="settings-grid">
          <!-- 接收者ID输入 -->
          <div class="setting-item">
            <label class="setting-label">接收者ID</label>
            <n-space>
              <n-input-number
                v-model:value="recipientIdInput"
                placeholder="ID"
                :show-button="false"
                @update:value="clearRecipientError"
                style="width: 180px"
              />
              <n-input
                v-model:value="securityPassword"
                placeholder="请输入安全密码"
                type="password"
                @input="clearRecipientError"
                style="width: 180px"
              />
              <n-button
                type="primary"
                @click="queryRecipientInfo"
                :disabled="
                  !recipientIdInput || isQueryingRecipient || !securityPassword
                "
              >
                查询
              </n-button>
            </n-space>
            <n-text
              v-if="recipientIdError"
              type="error"
              style="margin-top: 5px; display: block"
            >
              {{ recipientIdError }}
            </n-text>
          </div>

          <!-- 接收者信息展示 -->
          <div class="setting-item" v-if="recipientInfo">
            <label class="setting-label">接收者信息</label>
            <div
              class="recipient-info"
              style="
                background: #f7f8fa;
                padding: 16px;
                border-radius: 8px;
                border: 1px solid #e5e7eb;
                display: flex;
                align-items: flex-start;
                gap: 16px;
                transition: all 0.3s ease;
              "
            >
              <!-- 头像部分 -->
              <div
                class="avatar-container"
                style="
                  position: relative;
                  width: 80px;
                  height: 80px;
                  border-radius: 50%;
                  overflow: hidden;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  transition: all 0.3s ease;
                "
              >
                <img
                  v-if="recipientInfo.avatarUrl && !avatarLoadError"
                  :src="recipientInfo.avatarUrl"
                  alt="角色头像"
                  style="
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    transition: all 0.3s ease;
                  "
                  @error="handleAvatarError"
                  @load="handleAvatarLoad"
                />
                <!-- 头像加载失败或未设置时的 fallback -->
                <div
                  v-else
                  class="avatar-fallback"
                  style="
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 100%;
                    height: 100%;
                    color: white;
                    font-size: 24px;
                    font-weight: bold;
                    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                  "
                >
                  {{ (recipientInfo.name || "未知角色")[0] || "?" }}
                </div>
                <!-- 加载指示器 -->
                <div
                  v-if="isAvatarLoading"
                  class="avatar-loading"
                  style="
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 50%;
                  "
                >
                  <div
                    class="loading-spinner"
                    style="
                      width: 30px;
                      height: 30px;
                      border: 3px solid rgba(255, 255, 255, 0.3);
                      border-top: 3px solid white;
                      border-radius: 50%;
                      animation: spin 1s linear infinite;
                    "
                  ></div>
                </div>
              </div>

              <!-- 角色信息部分 -->
              <div class="role-info" style="flex: 1; min-width: 0">
                <div
                  style="
                    margin-bottom: 12px;
                    font-size: 18px;
                    font-weight: bold;
                    color: #1d2129;
                    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
                  "
                >
                  {{ recipientInfo.name || "未知角色" }}
                </div>
                <div
                  class="role-info-grid"
                  style="
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 12px;
                  "
                >
                  <div class="info-item">
                    <div
                      class="info-label"
                      style="
                        font-size: 12px;
                        color: #86909c;
                        margin-bottom: 2px;
                      "
                    >
                      角色ID
                    </div>
                    <div
                      class="info-value"
                      style="font-size: 14px; font-weight: 500; color: #1d2129"
                    >
                      {{ recipientInfo.roleId }}
                    </div>
                  </div>
                  <div class="info-item">
                    <div
                      class="info-label"
                      style="
                        font-size: 12px;
                        color: #86909c;
                        margin-bottom: 2px;
                      "
                    >
                      服务器
                    </div>
                    <div
                      class="info-value"
                      style="font-size: 14px; font-weight: 500; color: #1d2129"
                    >
                      {{ recipientInfo.serverName }}
                    </div>
                  </div>
                  <div class="info-item">
                    <div
                      class="info-label"
                      style="
                        font-size: 12px;
                        color: #86909c;
                        margin-bottom: 2px;
                      "
                    >
                      战力
                    </div>
                    <div
                      class="info-value"
                      style="font-size: 16px; font-weight: 600; color: #667eea"
                    >
                      {{ recipientInfo.power }} {{ recipientInfo.powerUnit }}
                    </div>
                  </div>
                  <div class="info-item">
                    <div
                      class="info-label"
                      style="
                        font-size: 12px;
                        color: #86909c;
                        margin-bottom: 2px;
                      "
                    >
                      军团
                    </div>
                    <div
                      class="info-value"
                      style="font-size: 14px; font-weight: 500; color: #1d2129"
                    >
                      {{ recipientInfo.legionName || "无" }}
                    </div>
                  </div>
                  <div class="info-item" style="grid-column: 1 / -1">
                    <div
                      class="info-label"
                      style="
                        font-size: 12px;
                        color: #86909c;
                        margin-bottom: 2px;
                      "
                    >
                      军团ID
                    </div>
                    <div
                      class="info-value"
                      style="font-size: 14px; font-weight: 500; color: #1d2129"
                    >
                      {{ recipientInfo.legionId || "无" }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 赠送数量 -->
          <div class="setting-item">
            <label class="setting-label">赠送数量</label>
            <n-input-number
              v-model:value="giftQuantity"
              :min="1"
              :max="1000"
              :step="1"
              placeholder="请输入赠送数量"
            />
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button
            @click="showLegacyGiftModal = false"
            style="margin-right: 12px"
            >取消</n-button
          >
          <n-button
            type="primary"
            @click="confirmLegacyGift"
            :disabled="!recipientIdInput || !recipientInfo"
          >
            开始赠送
          </n-button>
        </div>
      </div>
    </n-modal>

    <!-- Helper Modal (开箱/钓鱼/招募/按积分开箱) -->
    <n-modal
      v-model:show="showHelperModal"
      preset="card"
      :title="helperModalTitle"
      style="width: 90%; max-width: 400px"
    >
      <div class="settings-content">
        <div class="settings-grid">
          <div class="setting-item" v-if="helperType === 'box'">
            <label class="setting-label">宝箱类型</label>
            <n-select
              v-model:value="helperSettings.boxType"
              :options="boxTypeOptions"
              size="small"
            />
          </div>
          <div class="setting-item" v-if="helperType === 'fish'">
            <label class="setting-label">鱼竿类型</label>
            <n-select
              v-model:value="helperSettings.fishType"
              :options="fishTypeOptions"
              size="small"
            />
          </div>
          <div class="setting-item" v-if="helperType === 'pointsBox'">
            <label class="setting-label">目标积分</label>
            <n-input-number
              v-model:value="helperSettings.targetPoints"
              :min="1"
              :max="1000000"
              :step="100"
              size="small"
              style="width: 100%"
            />
          </div>
          <n-alert
            v-if="helperType === 'pointsBox'"
            type="info"
            style="margin-bottom: 12px"
          >
            目标为本次新增积分；每次开10个，可能少量超出目标。木质保留200个。<br />
            每轮开箱后领取积分奖励并刷新库存；1为最高优先级。保存的顺序、开关和目标也用于定时任务。
          </n-alert>
          <div v-if="helperType === 'pointsBox'" style="grid-column: 1 / -1">
            <div v-for="row in boxPointDraft" :key="row.id" style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
              <span style="width:70px">{{ row.name }}宝箱</span>
              <n-switch v-model:value="row.enabled" />
              <n-select :value="row.priority" :options="boxPriorityOptions" style="width:120px" @update:value="value => changeBoxPriority(row.id, value)" />
            </div>
            <n-button size="small" @click="saveBoxPointConfig">保存开箱配置</n-button>
          </div>
          <div class="setting-item" v-if="helperType !== 'pointsBox'">
            <label class="setting-label">消耗数量（10的倍数）</label>
            <n-input-number
              v-model:value="helperSettings.count"
              :min="10"
              :max="10000"
              :step="10"
              size="small"
            />
          </div>
        </div>
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button @click="showHelperModal = false" style="margin-right: 12px"
            >取消</n-button
          >
          <n-button type="primary" @click="executeHelper">开始执行</n-button>
        </div>
      </div>
    </n-modal>

    <n-modal v-model:show="showRedeemCodeModal" preset="card" title="兑换码配置与兑换" style="width: 90%; max-width: 600px">
      <n-alert type="info" style="margin-bottom: 12px">支持换行、空格、逗号或分号分隔；已兑换记录会自动跳过。保存后可加入定时任务。</n-alert>
      <n-input v-model:value="redeemDraft.codes" type="textarea" placeholder="每行填写一个兑换码" :autosize="{ minRows: 6, maxRows: 12 }" />
      <n-input v-model:value="redeemDraft.platform" placeholder="平台类型，默认 h5" style="margin-top: 12px" />
      <n-space justify="end" style="margin-top: 16px">
        <n-button @click="showRedeemCodeModal = false">取消</n-button>
        <n-button @click="saveRedeemCodeConfig">保存配置</n-button>
        <n-button type="primary" :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || !selectedTokens.length || !redeemDraft.codes.trim()" @click="executeRedeemCodes">保存并兑换</n-button>
      </n-space>
    </n-modal>

    <!-- FORMATION_DISPATCH_V1: 手动阵容槽1下发，不接入定时任务 -->
    <n-modal
      v-model:show="showFormationDispatchModal"
      preset="card"
      title="阵容槽1下发配置"
      style="width: 94%; max-width: 820px"
    >
      <n-alert type="warning" style="margin-bottom: 12px">
        固定下发至阵容槽1。执行前会逐账号校验是否拥有5名目标武将，完成后恢复该账号原本正在使用的阵容槽。
        “同步等级”默认关闭；开启后仅向上升级武将。若目标等级低于当前等级，会直接跳过，不执行重生，以避免精铁装备与鱼灵被本功能重置。
      </n-alert>

      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px">
        <span style="font-weight: 500">同步武将实际等级</span>
        <n-switch v-model:value="formationDispatchDraft.syncLevel" />
      </div>

      <div
        v-for="slot in formationDispatchDraft.slots"
        :key="slot.position"
        style="display: grid; grid-template-columns: 80px minmax(260px, 1fr) 180px; gap: 12px; align-items: center; margin-bottom: 12px"
      >
        <strong>位置 {{ slot.position + 1 }}</strong>
        <n-select
          v-model:value="slot.heroId"
          :options="formationHeroOptions"
          filterable
          clearable
          placeholder="选择英雄"
        />
        <n-input-number
          v-model:value="slot.level"
          :min="1"
          :max="5500"
          :precision="0"
          clearable
          placeholder="目标等级"
          :disabled="!formationDispatchDraft.syncLevel"
          style="width: 100%"
        />
      </div>

      <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px">
        等级留空表示该武将不调整等级；关闭“同步武将实际等级”时，所有等级设置均不会执行。
      </div>

      <n-space justify="end" style="margin-top: 16px">
        <n-button @click="showFormationDispatchModal = false">取消</n-button>
        <n-button @click="saveFormationDispatchConfig">保存配置</n-button>
        <n-button
          type="primary"
          :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || !selectedTokens.length"
          @click="executeFormationDispatch"
        >
          保存并下发到所选账号
        </n-button>
      </n-space>
    </n-modal>

    <n-modal v-model:show="showApexGuessModal" preset="card" title="逐鹿盐山竞猜/补领奖" style="width: 94%; max-width: 480px">
      <n-space vertical :size="16">
        <n-text>已选择 {{ selectedTokens.length }} 个账号。默认使用第一赛季配置表自动识别赛程，仅处理当前竞猜期的前一期奖励。</n-text>
        <n-form-item label="手动指定赛程ID（默认关闭）" :show-feedback="false">
          <n-space align="center">
            <n-switch
              v-model:value="apexUseManualScheduleId"
              :disabled="isRunning || autoExecutionActive || scheduledExecutionActive"
            />
            <n-text>{{ apexUseManualScheduleId ? "手动ID已启用：优先使用下方输入值" : "自动识别已启用：忽略下方手动ID" }}</n-text>
          </n-space>
        </n-form-item>
        <n-form-item label="手动赛程ID" :show-feedback="false">
          <n-input-number
            v-model:value="apexScheduleId"
            :min="1"
            :max="Number.MAX_SAFE_INTEGER"
            :precision="0"
            :show-button="false"
            placeholder="仅在开启手动ID时填写"
            :disabled="!apexUseManualScheduleId || isRunning || autoExecutionActive || scheduledExecutionActive"
            style="width: 100%"
          />
        </n-form-item>
        <n-text depth="3">自动模式仅识别第一赛季64强至决赛的唯一开放赛程。若没有唯一开放赛程，程序停止新竞猜；手动模式开启但ID无效时也不会回退自动识别。</n-text>
        <n-space justify="end">
          <n-button @click="showApexGuessModal = false">取消</n-button>
          <n-button
            type="primary"
            :disabled="isRunning || autoExecutionActive || scheduledExecutionActive || selectedTokens.length === 0 || (apexUseManualScheduleId && apexScheduleId == null)"
            @click="handleApexGuessStart"
          >{{ apexUseManualScheduleId ? "使用手动ID开始" : "自动识别并开始" }}</n-button>
        </n-space>
      </n-space>
    </n-modal>

    <n-modal v-model:show="showBlackMarketPurchaseModal" preset="card" title="黑市采购清单配置" style="width: 94%; max-width: 760px">
      <h3>主线 4000 关以下 · 整组最高价</h3>
      <p>单位为金砖，0 表示不买。限价保存在本机，采购时检查当前货架，首轮最多刷新一次。</p>
      <n-space wrap :size="[12, 0]">
        <n-form-item v-for="goods in lowMarketGoods" :key="goods.goodsId"
          :label="`${goods.name} ×${goods.quantity}`" :show-feedback="false">
          <n-input-number v-model:value="lowMarketDraft[goods.goodsId]" :min="0" :precision="0"
            :aria-label="`${goods.name}整组最高价`" style="width: 132px" />
        </n-form-item>
      </n-space>
      <h3>主线 4000 关起 · 服务器采购清单</h3>
      <n-alert type="info" style="margin-bottom: 12px">“保存配置”只保存到本机。“保存并下发”会将下方服务器清单同步给所选账号，保留采购次数。</n-alert>
      <n-space style="margin-bottom: 12px">
        <n-button @click="blackMarketDraft.push(createBlackMarketPurchaseEntry())">新增条目</n-button>
        <n-button @click="blackMarketDraft = defaultBlackMarketPurchaseList.map(item => ({ ...item }))">填入常用清单</n-button>
      </n-space>
      <div v-for="(item, index) in blackMarketDraft" :key="index" style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px">
        <n-select :value="item.itemId" :options="blackMarketItemOptions" filterable placeholder="选择物品" style="width: 200px" @update:value="value => Object.assign(item, createBlackMarketPurchaseEntry(value))" />
        <n-input-number v-model:value="item.itemId" :min="1" :precision="0" placeholder="物品 ID" style="width: 140px" />
        <n-input-number v-model:value="item.discount" :min="1" :max="10" :precision="0" placeholder="折扣 1–10" style="width: 140px" />
        <n-button type="error" secondary @click="blackMarketDraft.splice(index, 1)">删除</n-button>
      </div>
      <n-space justify="end" style="margin-top: 16px">
        <n-button @click="showBlackMarketPurchaseModal = false">取消</n-button>
        <n-button @click="saveBlackMarketPurchaseConfig">保存配置</n-button>
        <n-button type="primary" :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || !selectedTokens.length || !blackMarketDraft.length" @click="executeBlackMarketSync">保存并下发到所选账号</n-button>
      </n-space>
    </n-modal>

    <n-modal v-model:show="showApplyLegionModal" preset="card" title="批量申请俱乐部" style="width: 94%; max-width: 680px">
      <n-alert type="info" style="margin-bottom: 12px">已加入俱乐部的账号会跳过。手动点击提交会重新发送申请，旧的提交记录不会阻止本次操作；申请提交后仍需等待审核。</n-alert>
      <n-space align="center" style="margin-bottom: 12px">
        <n-input v-model:value="applyLegionTargetId" placeholder="输入目标俱乐部 ID" :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive)" style="width: 240px" />
        <n-button :loading="applyLegionLoading" :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || !selectedTokens.length || !normalizeLegionId(applyLegionTargetId)" @click="fetchApplyLegionTargetInfo">查询俱乐部</n-button>
      </n-space>
      <n-alert v-if="applyLegionError" type="error" style="margin-bottom: 12px">{{ applyLegionError }}</n-alert>
      <n-card v-if="applyLegionPreview" size="small" style="margin-bottom: 12px">
        <div>{{ applyLegionPreview.name }}（ID：{{ applyLegionPreview.id }}）</div>
        <div>等级：{{ applyLegionPreview.level }} · 成员：{{ applyLegionPreview.memberCount }}</div>
        <div>本次选中 {{ selectedTokens.length }} 个账号</div>
      </n-card>
      <n-checkbox v-model:checked="allowLegionResubmit" :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive)">上次申请超时或结果不明时：我已在游戏内核对，允许本次重新提交</n-checkbox>
      <n-space justify="end" style="margin-top: 16px">
        <n-button @click="showApplyLegionModal = false">关闭</n-button>
        <n-button type="primary" :disabled="(isRunning || autoExecutionActive || scheduledExecutionActive) || !selectedTokens.length || !applyLegionPreview" @click="handleBatchApplyLegion">向已查询的俱乐部提交申请</n-button>
      </n-space>
    </n-modal>

    <!-- Dream Buy Modal -->
    <n-modal
      v-model:show="showDreamBuyModal"
      preset="card"
      title="梦境商品购买配置"
      style="width: 90%; max-width: 600px"
    >
      <div class="settings-content">
        <div class="settings-grid">
          <n-alert type="info" show-icon style="margin-bottom: 12px">
            优先级：单独勾选 ＞ 黑市周 ＞ 等级自动识别。每个账号只使用一种清单，只购买当前商店中存在的商品。
            <div style="margin-top: 6px">保存后生效模式：{{ dreamBuyModeLabel }}</div>
          </n-alert>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px">
            <span>单独购买（默认关闭，优先使用下方勾选清单）</span>
            <n-switch v-model:value="dreamBuyManualEnabled" />
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px">
            <span>黑市周（默认关闭，需手动开启）</span>
            <n-switch v-model:value="dreamBuyBlackMarketEnabled" />
          </div>
          <div v-if="dreamBuyManualEnabled" style="margin-bottom: 12px; color: var(--text-secondary)">
            单独购买已开启，黑市周和自动模板暂不生效。未勾选商品时不购买，不会回退到其他模板。
          </div>
          <div v-else style="margin-bottom: 12px; color: var(--text-secondary)">
            单独勾选清单已保留但不生效。自动模板使用主公等级，不使用主线关卡；恰好4000级归入第一个模板。
          </div>
          <details style="margin-bottom: 16px">
            <summary style="cursor: pointer; font-weight: bold">查看三个购买模板</summary>
            <div v-for="template in dreamPurchaseTemplates" :key="template.id" style="padding: 10px 0; border-bottom: 1px solid var(--border-color)">
              <strong>{{ template.name }}</strong> · {{ template.rule }}
              <div v-for="(merchant, id) in merchantConfig" :key="id" style="margin-top: 4px; line-height: 1.6">
                {{ merchant.name }}：{{ dreamPurchaseTemplateSummary(template, id) }}
              </div>
            </div>
          </details>

          <div style="display: flex; gap: 12px; margin-bottom: 12px">
            <n-button size="small" type="warning" @click="selectGoldItems" :disabled="!dreamBuyManualEnabled">
              一键勾选金币商品
            </n-button>
            <n-button size="small" @click="selectAllItems" :disabled="!dreamBuyManualEnabled"> 全选所有 </n-button>
            <n-button size="small" @click="clearAllItems" :disabled="!dreamBuyManualEnabled"> 清空选择 </n-button>
          </div>

          <div
            v-for="(merchant, id) in merchantConfig"
            :key="id"
            style="margin-bottom: 16px"
          >
            <div style="font-weight: bold; margin-bottom: 8px">
              {{ merchant.name }}
            </div>
            <n-grid :cols="3" :x-gap="12" :y-gap="8">
              <n-grid-item v-for="(item, index) in merchant.items" :key="index">
                <n-checkbox
                  :value="`${id}-${index}`"
                  :checked="dreamBuyList.includes(`${id}-${index}`)"
                  :disabled="!dreamBuyManualEnabled"
                  @update:checked="
                    (checked) => toggleDreamItem(`${id}-${index}`, checked)
                  "
                >
                  {{ dreamPurchaseItemLabel(id, index) }}
                </n-checkbox>
              </n-grid-item>
            </n-grid>
          </div>
        </div>
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button
            @click="showDreamBuyModal = false"
            style="margin-right: 12px"
            >取消</n-button
          >
          <n-button type="primary" @click="saveDreamBuyConfig"
            >保存配置</n-button
          >
        </div>
      </div>
    </n-modal>

    <!-- Tasks List Modal -->
    <n-modal
      v-model:show="showTasksModal"
      preset="card"
      title="定时任务列表"
      style="width: 90%; max-width: 800px"
    >
      <div class="tasks-list" style="max-height: 600px; overflow-y: auto">
        <div
          v-for="task in scheduledTasks"
          :key="task.id"
          class="task-item"
          style="
            margin-bottom: 16px;
            padding: 12px;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
          "
        >
          <div
            style="
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 8px;
            "
          >
            <div style="font-weight: bold">{{ task.name }}</div>
            <n-switch
              v-model:value="task.enabled"
              @update:value="toggleTaskEnabled(task.id, $event)"
            >
            </n-switch>
          </div>
          <div style="margin-bottom: 4px">
            <span style="color: #6b7280">运行类型：</span>
            <span>{{
              task.runType === "daily" ? "每天固定时间" : "Cron表达式"
            }}</span>
          </div>
          <div style="margin-bottom: 4px">
            <span style="color: #6b7280">运行时间：</span>
            <span>{{
              task.runType === "daily" ? task.runTime : task.cronExpression
            }}</span>
          </div>
          <div style="margin-bottom: 4px">
            <span style="color: #6b7280">下次执行：</span>
            <span
              :style="{
                fontWeight: 'bold',
                color: taskCountdowns[task.id]?.isNearExecution
                  ? '#ff4d4f'
                  : '#1677ff',
              }"
            >
              {{
                task.enabled
                  ? taskCountdowns[task.id]?.formatted || "计算中..."
                  : "已禁用"
              }}
            </span>
          </div>
          <div style="margin-bottom: 4px">
            <span style="color: #6b7280">选中账号：</span>
            <span>{{ task.selectedTokens.length }} 个</span>
          </div>
          <div style="margin-bottom: 8px">
            <span style="color: #6b7280">选中任务：</span>
            <span>{{ task.selectedTasks.length }} 个</span>
            <div v-if="task.selectedTasks.includes('batchApplyLegion')">申请目标俱乐部：{{ task.legionApplyTargetId || '未配置' }}</div>
          </div>
          <div style="display: flex; gap: 8px">
            <n-button size="tiny" @click="editTask(task)"> 编辑 </n-button>
            <n-button size="tiny" type="error" @click="deleteTask(task.id)">
              删除
            </n-button>
            <n-button
              size="tiny"
              type="info"
              secondary
              :loading="executingTaskIds.includes(task.id)"
              @click="manualExecuteTask(task)"
            >
              立即执行
            </n-button>
          </div>
        </div>
        <div
          v-if="scheduledTasks.length === 0"
          style="text-align: center; padding: 24px; color: #6b7280"
        >
          暂无定时任务
        </div>
      </div>
    </n-modal>

    <!-- Task Modal -->
    <n-modal
      v-model:show="showTaskModal"
      preset="card"
      :title="editingTask ? '编辑定时任务' : '新增定时任务'"
      style="width: 90%; max-width: 600px"
    >
      <div class="settings-content">
        <div class="settings-grid">
          <div class="setting-item">
            <label class="setting-label">任务名称</label>
            <n-input
              v-model:value="taskForm.name"
              placeholder="请输入任务名称"
            />
          </div>
          <div class="setting-item">
            <label class="setting-label">运行类型</label>
            <n-radio-group
              v-model:value="taskForm.runType"
              @update:value="resetRunType"
            >
              <n-radio value="daily">每天固定时间</n-radio>
              <n-radio value="cron">Cron表达式</n-radio>
            </n-radio-group>
          </div>
          <div class="setting-item" v-if="taskForm.runType === 'daily'">
            <label class="setting-label">运行时间</label>
            <n-time-picker v-model:value="taskForm.runTime" format="HH:mm" />
          </div>
          <div class="setting-item" v-if="taskForm.runType === 'cron'">
            <label class="setting-label">Cron表达式</label>
            <n-input
              v-model:value="taskForm.cronExpression"
              placeholder="请输入Cron表达式"
              @input="parseCronExpression"
            />

            <!-- Cron表达式解析结果 -->
            <div class="cron-parser" v-if="taskForm.cronExpression">
              <div v-if="cronValidation.valid" class="cron-validation success">
                <n-text type="success">✓ {{ cronValidation.message }}</n-text>
              </div>
              <div v-else class="cron-validation error">
                <n-text type="error">✗ {{ cronValidation.message }}</n-text>
              </div>

              <!-- 未来执行时间 -->
              <div
                v-if="cronValidation.valid && cronNextRuns.length > 0"
                class="cron-next-runs"
              >
                <h4>未来5次执行时间：</h4>
                <ul>
                  <li v-for="(run, index) in cronNextRuns" :key="index">
                    {{ run }}
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <div class="setting-item">
            <div
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
              "
            >
              <label class="setting-label">选择账号</label>
              <n-space size="small">
                <n-button size="small" @click="selectAllTokens">
                  全选
                </n-button>
                <n-button size="small" @click="deselectAllTokens">
                  全不选
                </n-button>
              </n-space>
            </div>

            <!-- 分组快速选择 (仅在定时任务中显示) -->
            <div style="margin-bottom: 12px">
              <div
                style="
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  margin-bottom: 8px;
                "
              >
                <div style="font-size: 12px; color: #86909c">
                  快速选择分组：
                </div>
                <n-button
                  type="primary"
                  size="tiny"
                  text
                  @click="showGroupManageModal = true"
                >
                  管理分组
                </n-button>
              </div>
              <div
                v-if="tokenGroups.length === 0"
                style="font-size: 12px; color: #ccc"
              >
                暂无分组
              </div>
              <div style="display: flex; gap: 6px; flex-wrap: wrap">
                <n-button
                  v-for="group in tokenGroups"
                  :key="group.id"
                  size="small"
                  :type="
                    taskScheduleSelectedGroupIds.includes(group.id)
                      ? 'primary'
                      : 'default'
                  "
                  @click="
                    () => {
                      const index = taskScheduleSelectedGroupIds.indexOf(
                        group.id,
                      );
                      const groupTokenIds = getValidGroupTokenIds(group.id);

                      if (index > -1) {
                        // 取消选择该分组
                        taskScheduleSelectedGroupIds.splice(index, 1);
                        taskForm.selectedTokens =
                          taskForm.selectedTokens.filter(
                            (id) => !groupTokenIds.includes(id),
                          );
                      } else {
                        // 选择该分组
                        taskScheduleSelectedGroupIds.push(group.id);
                        groupTokenIds.forEach((id) => {
                          if (!taskForm.selectedTokens.includes(id)) {
                            taskForm.selectedTokens.push(id);
                          }
                        });
                      }
                    }
                  "
                  :style="{
                    borderColor: group.color,
                  }"
                >
                  {{ group.name }}
                </n-button>
              </div>
            </div>

            <n-checkbox-group v-model:value="taskForm.selectedTokens">
              <n-grid :cols="2" :x-gap="12" :y-gap="8">
                <n-grid-item v-for="token in sortedTokens" :key="token.id">
                  <n-checkbox :value="token.id">{{ token.name }}</n-checkbox>
                </n-grid-item>
              </n-grid>
            </n-checkbox-group>
          </div>
          <div class="setting-item">
            <div
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
              "
            >
              <label class="setting-label">选择任务</label>
              <n-space size="small">
                <n-button size="small" @click="selectAllTasks"> 全选 </n-button>
                <n-button size="small" @click="deselectAllTasks">
                  全不选
                </n-button>
              </n-space>
            </div>

            <div v-if="taskForm.selectedTasks.includes('batchApplyLegion')" style="margin-bottom: 12px">
              <label class="setting-label">申请的目标俱乐部 ID</label>
              <n-input v-model:value="taskForm.legionApplyTargetId" placeholder="请先在手动入口验证此俱乐部，再配置定时申请" />
              <div style="font-size: 12px; margin-top: 6px">每条任务分别保存目标；已提交或结果未确认的本地记录会阻止自动重复申请。</div>
            </div>
            <n-checkbox-group v-model:value="taskForm.selectedTasks">
              <n-tabs
                type="line"
                animated
                size="small"
                pane-style="padding-top: 12px;"
                default-value="daily"
              >
                <n-tab-pane
                  v-for="group in taskGroupDefinitions"
                  :key="group.name"
                  :name="group.name"
                  :tab="group.label"
                >
                  <n-grid :cols="2" :x-gap="12" :y-gap="8">
                    <n-grid-item
                      v-for="task in groupedAvailableTasks[group.name]"
                      :key="task.value"
                    >
                      <n-checkbox :value="task.value">{{
                        task.label
                      }}</n-checkbox>
                    </n-grid-item>
                  </n-grid>
                </n-tab-pane>

                <n-tab-pane
                  v-if="
                    groupedAvailableTasks['other'] &&
                    groupedAvailableTasks['other'].length > 0
                  "
                  name="other"
                  tab="其他"
                >
                  <n-grid :cols="2" :x-gap="12" :y-gap="8">
                    <n-grid-item
                      v-for="task in groupedAvailableTasks['other']"
                      :key="task.value"
                    >
                      <n-checkbox :value="task.value">{{
                        task.label
                      }}</n-checkbox>
                    </n-grid-item>
                  </n-grid>
                </n-tab-pane>
              </n-tabs>
            </n-checkbox-group>
          </div>
        </div>
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button @click="showTaskModal = false" style="margin-right: 12px"
            >取消</n-button
          >
          <n-button type="primary" @click="saveTask">保存</n-button>
        </div>
      </div>
    </n-modal>

    <!-- Batch Settings Modal -->
    <n-modal
      v-model:show="showBatchSettingsModal"
      preset="card"
      title="任务设置"
      style="width: 90%; max-width: 700px"
    >
      <div class="settings-content">
        <n-grid :cols="2" :x-gap="24">
          <!-- 左列：批量操作设置 -->
          <n-grid-item>
            <n-divider title-placement="left" style="margin: 1px 0 8px 0"
              >批量操作设置</n-divider
            >
            <div class="settings-grid">
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">开箱数量(10倍)</label>
                <n-input-number
                  v-model:value="batchSettings.boxCount"
                  :min="10"
                  :max="10000"
                  :step="10"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">钓鱼数量(10倍)</label>
                <n-input-number
                  v-model:value="batchSettings.fishCount"
                  :min="10"
                  :max="10000"
                  :step="10"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">招募数量(10倍)</label>
                <n-input-number
                  v-model:value="batchSettings.recruitCount"
                  :min="10"
                  :max="10000"
                  :step="10"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">默认宝箱类型</label>
                <n-select
                  v-model:value="batchSettings.defaultBoxType"
                  :options="boxTypeOptions"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">默认鱼竿类型</label>
                <n-select
                  v-model:value="batchSettings.defaultFishType"
                  :options="fishTypeOptions"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">按积分开箱目标</label>
                <n-input-number
                  v-model:value="batchSettings.targetBoxPoints"
                  :min="1"
                  :max="1000000"
                  :step="100"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">梦境商品购买配置</label>
                <n-button size="small" @click="openDreamBuyModal"
                  >点击配置</n-button
                >
              </div>
            </div>
            <n-divider title-placement="left" style="margin: 12px 0 8px 0"
              >功法赠送设置</n-divider
            >
            <div class="settings-grid">
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">接收者ID</label>
                <n-input-number
                  v-model:value="batchSettings.receiverId"
                  placeholder="ID"
                  size="small"
                  style="width: 100px"
                  :show-button="false"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">密码</label>
                <n-input
                  v-model:value="batchSettings.password"
                  type="password"
                  placeholder="密码"
                  size="small"
                  style="width: 100px"
                />
              </div>
            </div>
            <n-divider title-placement="left" style="margin: 12px 0 8px 0"
              >PushPlus 通知</n-divider
            >
            <div class="settings-grid" style="display: block">
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                  margin-bottom: 10px;
                "
              >
                <div>
                  <label class="setting-label">启用 PushPlus</label>
                  <div style="font-size: 12px; color: #86909c">
                    仅定时批量任务和主线推图整轮结束时通知
                  </div>
                </div>
                <n-switch v-model:value="pushPlusSettings.enabled" />
              </div>
              <div class="setting-item" style="display: block">
                <label class="setting-label">PushPlus Token</label>
                <n-input
                  v-model:value="pushPlusSettings.token"
                  type="password"
                  show-password-on="click"
                  placeholder="默认留空，不会发送通知"
                  autocomplete="off"
                  style="margin-top: 6px"
                />
                <div
                  style="
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-top: 8px;
                  "
                >
                  <n-button
                    size="small"
                    :loading="pushPlusTesting"
                    @click="testPushPlus"
                  >
                    测试通知
                  </n-button>
                  <n-button size="small" tertiary @click="clearPushPlusConfig">
                    清除 Token
                  </n-button>
                  <span
                    v-if="pushPlusStatus"
                    style="font-size: 12px; color: #86909c"
                    >{{ pushPlusStatus }}</span
                  >
                </div>
              </div>
            </div>
          </n-grid-item>
          <!-- 右列：延迟与连接设置 -->
          <n-grid-item>
            <n-divider title-placement="left" style="margin: 1px 0 8px 0"
              >延迟设置(ms)</n-divider
            >
            <div class="settings-grid">
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">命令延迟</label>
                <n-input-number
                  v-model:value="batchSettings.commandDelay"
                  :min="100"
                  :max="2000"
                  :step="100"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">任务间延迟</label>
                <n-input-number
                  v-model:value="batchSettings.taskDelay"
                  :min="100"
                  :max="2000"
                  :step="100"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">操作延迟</label>
                <n-input-number
                  v-model:value="batchSettings.actionDelay"
                  :min="100"
                  :max="2000"
                  :step="100"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">战斗延迟</label>
                <n-input-number
                  v-model:value="batchSettings.battleDelay"
                  :min="100"
                  :max="2000"
                  :step="100"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">刷新延迟</label>
                <n-input-number
                  v-model:value="batchSettings.refreshDelay"
                  :min="500"
                  :max="3000"
                  :step="100"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">长延迟</label>
                <n-input-number
                  v-model:value="batchSettings.longDelay"
                  :min="1000"
                  :max="10000"
                  :step="500"
                  size="small"
                  style="width: 100px"
                />
              </div>
            </div>
            <n-divider title-placement="left" style="margin: 12px 0 8px 0"
              >连接设置</n-divider
            >
            <div class="settings-grid">
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">最大并发数</label>
                <n-input-number
                  v-model:value="batchSettings.maxActive"
                  :min="1"
                  :max="20"
                  :step="1"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">连接超时(ms)</label>
                <n-input-number
                  v-model:value="batchSettings.connectionTimeout"
                  :min="1000"
                  :max="30000"
                  :step="1000"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">重连等待(ms)</label>
                <n-input-number
                  v-model:value="batchSettings.reconnectDelay"
                  :min="100"
                  :max="5000"
                  :step="100"
                  size="small"
                  style="width: 100px"
                />
              </div>
            </div>
            <n-divider title-placement="left" style="margin: 12px 0 8px 0"
              >系统设置</n-divider
            >
            <div class="settings-grid">
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">列表每行数量</label>
                <n-input-number
                  v-model:value="batchSettings.tokenListColumns"
                  :min="1"
                  :max="10"
                  :step="1"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">最大日志条目</label>
                <n-input-number
                  v-model:value="batchSettings.maxLogEntries"
                  :min="100"
                  :max="5000"
                  :step="100"
                  size="small"
                  style="width: 100px"
                />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
              >
                <label class="setting-label">定时刷新页面</label>
                <n-switch v-model:value="batchSettings.enableRefresh" />
              </div>
              <div
                class="setting-item"
                style="
                  flex-direction: row;
                  justify-content: space-between;
                  align-items: center;
                "
                v-if="batchSettings.enableRefresh"
              >
                <label class="setting-label">刷新间隔(分钟)</label>
                <n-input-number
                  v-model:value="batchSettings.refreshInterval"
                  :min="10"
                  :max="1440"
                  :step="30"
                  size="small"
                  style="width: 100px"
                />
              </div>
            </div>
          </n-grid-item>
        </n-grid>
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button
            @click="showBatchSettingsModal = false"
            style="margin-right: 12px"
            >取消</n-button
          >
          <n-button type="primary" @click="saveBatchSettings"
            >保存设置</n-button
          >
        </div>
      </div>
    </n-modal>

    <!-- War Guess Modal -->
    <n-modal
      v-model:show="showWarGuessModal"
      preset="card"
      title="月赛助威"
      style="width: 90%; max-width: 800px"
    >
      <div class="settings-content">
        <div class="settings-grid" style="display: block">
          <div
            style="
              margin-bottom: 16px;
              display: flex;
              align-items: center;
              gap: 12px;
            "
          >
            <span style="font-size: 16px">拍手器:</span>
            <n-input-number
              v-model:value="warGuessCoin"
              placeholder="拍手器"
              :min="1"
              :max="20"
              style="width: 120px"
            >
            </n-input-number>
            <n-button
              type="primary"
              @click="handleWarGuessCheer"
              :disabled="!selectedWarGuessLegionId || (isRunning || autoExecutionActive || scheduledExecutionActive)"
            >
              助威
            </n-button>
            <n-button @click="fetchWarGuessRank" :loading="warGuessLoading">
              刷新数据
            </n-button>
          </div>

          <n-data-table
            :columns="warGuessColumns"
            :data="warGuessList"
            :loading="warGuessLoading"
            :row-key="(row) => row.id"
            :checked-row-keys="
              selectedWarGuessLegionId ? [selectedWarGuessLegionId] : []
            "
            @update:checked-row-keys="
              (keys) => (selectedWarGuessLegionId = keys[0])
            "
            :row-props="warGuessRowProps"
            style="height: 400px; flex: 1"
            flex-height
          />
        </div>
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button @click="showWarGuessModal = false">关闭</n-button>
        </div>
      </div>
    </n-modal>

    <ConfigExportDialog v-if="showConfigExport" :accounts="sortedTokens" :groups="tokenGroups"
      :busy="configTransferBusy" @close="showConfigExport = false" @export="exportConfig" />

    <!-- Token Group Management Modal -->
    <n-modal
      v-model:show="showGroupManageModal"
      preset="card"
      title="分组管理"
      style="width: 90%; max-width: 800px"
    >
      <div class="settings-content">
        <!-- 创建新分组 -->
        <n-divider title-placement="left" style="margin: 0 0 16px 0">
          创建新分组
        </n-divider>
        <div style="margin-bottom: 24px">
          <div
            style="
              display: flex;
              gap: 12px;
              align-items: center;
              margin-bottom: 12px;
              flex-wrap: wrap;
            "
          >
            <n-input
              v-model:value="newGroupName"
              placeholder="输入分组名称"
              style="width: 200px"
              size="small"
            />
            <div style="display: flex; gap: 8px; align-items: center">
              <span style="font-size: 12px">选择颜色:</span>
              <div style="display: flex; gap: 6px">
                <div
                  v-for="color in groupColors"
                  :key="color"
                  :style="{
                    width: '24px',
                    height: '24px',
                    backgroundColor: color,
                    borderRadius: '4px',
                    border:
                      newGroupColor === color
                        ? '3px solid #000'
                        : '2px solid #ddd',
                    cursor: 'pointer',
                    transition: 'transform 0.2s',
                  }"
                  @click="newGroupColor = color"
                  @mouseover="$event.target.style.transform = 'scale(1.1)'"
                  @mouseleave="$event.target.style.transform = 'scale(1)'"
                />
              </div>
            </div>
            <n-button type="primary" size="small" @click="createNewGroup">
              创建分组
            </n-button>
          </div>

          <!-- 选择包含的账号 -->
          <div
            style="
              background: #f9f9f9;
              padding: 12px;
              border-radius: 8px;
              border: 1px solid #eee;
            "
          >
            <div
              style="
                display: flex;
                justify-content: space-between;
                margin-bottom: 8px;
              "
            >
              <span style="font-size: 13px; font-weight: bold"
                >包含账号 ({{ newGroupSelectedTokens.length }})</span
              >
              <n-space size="small">
                <n-button size="tiny" @click="selectAllNewGroup">全选</n-button>
                <n-button size="tiny" @click="deselectAllNewGroup"
                  >全不选</n-button
                >
              </n-space>
            </div>
            <div style="max-height: 150px; overflow-y: auto">
              <n-checkbox-group v-model:value="newGroupSelectedTokens">
                <n-grid :cols="3" :x-gap="12" :y-gap="8">
                  <n-grid-item v-for="token in sortedTokens" :key="token.id">
                    <n-checkbox :value="token.id">{{ token.name }}</n-checkbox>
                  </n-grid-item>
                </n-grid>
              </n-checkbox-group>
            </div>
          </div>
        </div>

        <!-- 分组列表 -->
        <n-divider title-placement="left" style="margin: 0 0 16px 0">
          分组列表
        </n-divider>
        <div
          style="
            max-height: 500px;
            overflow-y: auto;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 12px;
          "
        >
          <div
            v-for="group in tokenGroups"
            :key="group.id"
            style="
              padding: 12px;
              border: 1px solid #e5e7eb;
              border-radius: 6px;
              margin-bottom: 12px;
              background: #fafafa;
            "
          >
            <div
              style="
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                gap: 12px;
              "
            >
              <div style="flex: 1">
                <!-- 编辑模式 -->
                <div
                  v-if="editingGroupId === group.id"
                  style="display: flex; gap: 8px"
                >
                  <n-input
                    v-model:value="editingGroupName"
                    placeholder="分组名称"
                    size="small"
                    style="width: 150px"
                  />
                  <div style="display: flex; gap: 6px; align-items: center">
                    <div
                      v-for="color in groupColors"
                      :key="color"
                      :style="{
                        width: '20px',
                        height: '20px',
                        backgroundColor: color,
                        borderRadius: '4px',
                        border:
                          editingGroupColor === color
                            ? '3px solid #000'
                            : '2px solid #ddd',
                        cursor: 'pointer',
                      }"
                      @click="editingGroupColor = color"
                    />
                  </div>
                  <n-button
                    size="small"
                    type="primary"
                    @click="saveEditGroup"
                    style="width: 60px"
                  >
                    保存
                  </n-button>
                  <n-button
                    size="small"
                    @click="cancelEditGroup"
                    style="width: 60px"
                  >
                    取消
                  </n-button>
                </div>
                <!-- 显示模式 -->
                <div v-else>
                  <div
                    style="
                      display: flex;
                      align-items: center;
                      gap: 8px;
                      margin-bottom: 8px;
                    "
                  >
                    <div
                      :style="{
                        width: '16px',
                        height: '16px',
                        backgroundColor: group.color,
                        borderRadius: '3px',
                      }"
                    />
                    <span style="font-weight: 500; font-size: 14px">
                      {{ group.name }}
                    </span>
                    <n-tag size="small" type="info">
                      {{ getValidGroupTokenIds(group.id).length }} 个账号
                    </n-tag>
                  </div>
                  <div
                    style="
                      display: flex;
                      gap: 4px;
                      flex-wrap: wrap;
                      margin-bottom: 8px;
                    "
                  >
                    <div
                      v-for="tokenId in getValidGroupTokenIds(group.id)"
                      :key="tokenId"
                      style="
                        padding: 2px 8px;
                        background: white;
                        border: 1px solid #ddd;
                        border-radius: 4px;
                        font-size: 12px;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                      "
                    >
                      {{ tokens.find((t) => t.id === tokenId)?.name }}
                      <n-button
                        size="tiny"
                        type="error"
                        text
                        @click="removeTokenFromSelectedGroup(group.id, tokenId)"
                      >
                        ×
                      </n-button>
                    </div>
                  </div>
                  <!-- 添加token到分组 -->
                  <div style="margin-bottom: 8px">
                    <n-select
                      placeholder="添加账号到分组"
                      size="small"
                      filterable
                      :options="
                        tokens
                          .filter(
                            (t) =>
                              !getValidGroupTokenIds(group.id).includes(t.id),
                          )
                          .map((t) => ({ label: t.name, value: t.id }))
                      "
                      @update:value="
                        (tokenId) => {
                          if (tokenId) {
                            addTokenToSelectedGroup(group.id, tokenId);
                          }
                        }
                      "
                    />
                  </div>
                </div>
              </div>

              <!-- 操作按钮 -->
              <div
                style="display: flex; gap: 8px"
                v-if="editingGroupId !== group.id"
              >
                <n-button size="small" @click="startEditGroup(group.id)">
                  编辑
                </n-button>
                <n-button
                  size="small"
                  type="error"
                  @click="deleteGroup(group.id)"
                >
                  删除
                </n-button>
              </div>
            </div>
          </div>

          <div
            v-if="tokenGroups.length === 0"
            style="text-align: center; padding: 24px; color: #86909c"
          >
            暂无分组，请创建一个新分组
          </div>
        </div>

        <!-- 关闭按钮 -->
        <div class="modal-actions" style="margin-top: 20px; text-align: right">
          <n-button @click="showGroupManageModal = false">关闭</n-button>
        </div>
      </div>
    </n-modal>
  </div>
  <JianghuMarketModal v-model:show="showJianghuMarket" v-model:list="jianghuList" :running="isRunning" :can-start="selectedTokens.length > 0 && !autoExecutionActive && !scheduledExecutionActive" :rows="jianghuRows" @save="saveJianghuList" @start="handleJianghuStart" @stop="stopJianghuMarket" />
  <GenieChallengeModal v-model:show="showGenieChallenge" v-model:config="genieConfig"
    :rows="genieRows" :running="isRunning || autoExecutionActive || scheduledExecutionActive"
    :selected-count="selectedTokens.length" :can-start="genieCanStart"
    @start="handleGenieStart" @stop="stopBatch" />
</template>

<script setup>
import { DEFAULT_GENIE_ATTEMPTS, normalizeGeniePlan } from "@/utils/batch/genieChallengePlan.js";
import GenieChallengeModal from "@/components/Batch/GenieChallengeModal.vue";
import JianghuMarketModal from "@/components/Batch/JianghuMarketModal.vue";
import { removeRetiredTasks } from "../utils/batch/retiredActivities.js";
import { batchPhoenixPrayer } from "@/utils/batch/tasksPhoenixPrayer.js";
import { createTasksJianghuMarket } from "@/utils/batch/tasksJianghuMarket.js";
import { createMarketLedger, normalizeMarketList } from "@/utils/batch/jianghuMarket.js";
import { createTechnologyLedger } from "@/utils/batch/genieTechnology.js";
import { createTasksGenieChallenge, createGenieLedger, withGenieLock } from "@/utils/batch/tasksGenieChallenge.js";
import { createBottleTaskContext } from "@/utils/batch/bottleWorkflow.js";
import { dailyConnectionFailure } from "@/utils/batch/dailyConnectionPolicy.js";
import { normalizeBoxRules } from "@/utils/batch/boxPointsRuntime.js";
// Import required dependencies
import {
  ref,
  computed,
  nextTick,
  reactive,
  watch,
  onActivated,
  onMounted,
  onBeforeUnmount,
  h,
} from "vue";
import AutoWeeklyPanel from "@/components/Batch/AutoWeeklyPanel.vue";
import SaltDiagnosticsPanel from "@/components/Batch/SaltDiagnosticsPanel.vue";
import { getActivityCycle, getGameNow, isAutoTaskOpen } from "@/utils/autoSchedule/activityCycle.js";
import { getVerificationMetadata } from "@/utils/batch/taskResult.js";
import { summarizeEntries } from "@/utils/autoSchedule/scheduleGuard.js";
import { useAutoSchedule } from "@/utils/autoSchedule/useAutoSchedule.js";
import { useTokenStore, gameTokens, tokenGroups } from "@/stores/tokenStore";
import { $emit } from "@/stores/events/index.ts";
import { DailyTaskRunner } from "@/utils/dailyTaskRunner";
import { createConnectionSlots } from "@/utils/batch/connectionSlots.js";
import { classifyBatchDailyError } from "@/utils/batch/dailyErrorPolicy";
import { taskPreemptionCoordinator } from "@/utils/taskPreemptionCoordinator";
import {
  buildBatchDailyPushReport,
  clearPushPlusToken,
  enqueuePushPlusNotification,
  loadPushPlusSettings,
  savePushPlusSettings,
} from "@/utils/pushPlusNotifier";
import { preloadQuestions } from "@/utils/studyQuestionsFromJSON.js";
import { useMessage } from "naive-ui";
import useIndexedDB from "@/hooks/useIndexedDB";
import ConfigExportDialog from "@/components/Batch/ConfigExportDialog.vue";
import { exportBinArchive, restoreBinArchive } from "@/utils/binConfigArchive.js";
import { transformToken } from "@/utils/token";
import { createTokenBinAccess, exportTokenRecords, importTokenRecords, remapTokenIds } from "@/utils/tokenRefreshSource.js";
import { Settings } from "@vicons/ionicons5";
import { DEFAULT_WEIRD_TOWER_MAX_CLIMB } from "@/utils/towerClimbLimit.js";

// Import batch task modules
import {
  // Constants
  boxTypeOptions,
  fishTypeOptions,
  formationOptions,
  bossTimesOptions,
  availableTasks,
  FISH_TARGET,
  ARENA_TARGET,
  taskColumns,
  defaultSettings,
  defaultBatchSettings,
  defaultTemplate,
  defaultTaskForm,
  defaultHelperSettings,
  // Cron utilities
  validateCronField,
  validateCronExpression,
  parseCronField,
  calculateNextRuns,
  calculateNextExecutionTime,
  formatTimeDifference,
  matchesCronExpression,
  // Connection manager
  createConnectionManager,
  getActivityStatus,
  getTodayStartSec,
  isTodayAvailable,
  calculateMonthProgress,
  pickArenaTargetId,
  // Log utilities
  createLogManager,
  addTaskSaveLog,
  // Task factories
  createTasksToken,
  createTasksHangUp,
  createTasksBottle,
  createTasksTower,
  createTasksItem,
  createTasksDungeon,
  createTasksArena,
  createTasksStore,
  createTasksLegacy,
  createTasksFootball,
  createTasksApex,
  createTasksUpstreamExtras,
  createTasksLegionApply,
  createTasksCampChallenge,
  createTasksSaltOnce,
  normalizeLegionId,
  normalizeRedeemCodes,
} from "@/utils/batch";

import { defaultLowMarketLimits, validLowMarketLimits, lowMarketGoods } from "@/utils/batch/dailyBlackMarket.js";
import { blackMarketItemCatalog, createBlackMarketPurchaseEntry, defaultBlackMarketPurchaseList, normalizeBlackMarketPurchaseList } from "@/utils/batch/blackMarketConfig.js";
import { createTasksBonfire } from "@/utils/batch/tasksBonfire.js";
import { createScheduledTaskAdapters } from "@/utils/batch/scheduledTaskAdapters.js";
import { createTasksFormationDispatch } from "@/utils/batch/tasksFormationDispatch.js";
import { createDefaultFormationDispatchConfig, normalizeFormationDispatchConfig, validateFormationDispatchConfig } from "@/utils/batch/formationDispatchConfig.js";
import { HERO_DICT } from "@/utils/HeroList.js";
// DREAM_PURCHASE_TEMPLATES_V1
import { merchantConfig, goldItemsConfig, dreamPurchaseTemplates, dreamPurchaseItemLabel, dreamPurchaseTemplateSummary } from "@/utils/dreamConstants";

// Initialize token store, message service, and task runner
const tokenStore = useTokenStore();
const message = useMessage();
const weirdTowerMaxClimb = ref(DEFAULT_WEIRD_TOWER_MAX_CLIMB);

// 排序配置（从localStorage读取，与TokenImport共享）
const savedSortConfig = localStorage.getItem("tokenSortConfig");
const sortConfig = ref(
  savedSortConfig
    ? JSON.parse(savedSortConfig)
    : {
        field: "createdAt", // 排序字段：name, server, createdAt, lastUsed
        direction: "asc", // 排序方向：asc, desc
      },
);

// 计算属性 - 从gameData中获取塔相关信息
const evoTowerInfo = computed(() => {
  const data = tokenStore.gameData?.evoTowerInfo || null;
  return data;
});

const weirdTowerData = computed(() => {
  return evoTowerInfo.value?.evoTower || null;
});

const currentTowerId = computed(() => {
  return weirdTowerData.value?.towerId || 0;
});

const towerEnergy = computed(() => {
  return weirdTowerData.value?.energy || 0;
});

// 排序后的游戏角色Token列表
const sortedTokens = computed(() => {
  return [...tokenStore.gameTokens].sort((tokenA, tokenB) => {
    let valueA, valueB;

    // 根据排序字段获取比较值
    switch (sortConfig.value.field) {
      case "name":
        valueA = tokenA.name?.toLowerCase() || "";
        valueB = tokenB.name?.toLowerCase() || "";
        break;
      case "server":
        valueA = tokenA.server?.toLowerCase() || "";
        valueB = tokenB.server?.toLowerCase() || "";
        break;
      case "createdAt":
        valueA = new Date(tokenA.createdAt || 0).getTime();
        valueB = new Date(tokenB.createdAt || 0).getTime();
        break;
      case "lastUsed":
        valueA = new Date(tokenA.lastUsed || 0).getTime();
        valueB = new Date(tokenB.lastUsed || 0).getTime();
        break;
      default:
        valueA = tokenA.name?.toLowerCase() || "";
        valueB = tokenB.name?.toLowerCase() || "";
    }

    // 根据排序方向比较值
    if (valueA < valueB) {
      return sortConfig.value.direction === "asc" ? -1 : 1;
    }
    if (valueA > valueB) {
      return sortConfig.value.direction === "asc" ? 1 : -1;
    }
    return 0;
  });
});

// 切换排序
const toggleSort = (field) => {
  if (sortConfig.value.field === field) {
    // 如果点击的是当前排序字段，则切换排序方向
    sortConfig.value.direction =
      sortConfig.value.direction === "asc" ? "desc" : "asc";
  } else {
    // 如果点击的是新的排序字段，则默认升序
    sortConfig.value.field = field;
    sortConfig.value.direction = "asc";
  }

  // 保存排序设置到localStorage
  localStorage.setItem("tokenSortConfig", JSON.stringify(sortConfig.value));
};

// 获取排序图标
const getSortIcon = (field) => {
  if (sortConfig.value.field !== field) return null;
  return sortConfig.value.direction === "asc" ? "↑" : "↓";
};

const tokens = computed(() => tokenStore.gameTokens);
const ismengjingActivityOpen = computed(() => {
  const day = getGameNow(autoNow.value).weekday;
  return day === 0 || day === 1 || day === 3 || day === 4;
});
const isarenaActivityOpen = computed(() => {
  const hour = new Date().getHours();
  return hour >= 6 && hour < 22;
});
// Shared Beijing cycle also refreshes across midnight/noon without reloading the page.
const getCurrentActivityWeek = computed(() => getActivityCycle(autoNow.value).label);
const isWeirdTowerActivityOpen = computed(() => {
  const { weekday, hour } = getGameNow(autoNow.value);
  return getCurrentActivityWeek.value === "黑市周" && (weekday !== 5 || hour >= 12);
});

// 获取本月第四个周日的日期
const getFourthSundayOfMonth = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  // 当月第一天
  const firstDay = new Date(year, month, 1);
  const dayOfWeek = firstDay.getDay(); // 0-6

  // 计算第一个周日的日期 (1号是周日则为1，否则为 1 + 7 - dayOfWeek)
  let firstSundayDate = 1 + ((7 - dayOfWeek) % 7);

  // 仅针对2026年3月进行特殊处理
  if (year === 2026 && month === 2 && dayOfWeek === 0) {
    firstSundayDate = 8;
  }

  // 第四个周日 = 第一个周日 + 21天
  return new Date(year, month, firstSundayDate + 21);
};

const isWarGuessActivityOpen = computed(() => {
  const now = new Date();

  // 手动修正：2026年3月1日开放
  if (
    now.getFullYear() === 2026 &&
    now.getMonth() === 2 &&
    now.getDate() === 1
  ) {
    const hour = now.getHours();
    const minute = now.getMinutes();
    if (hour < 19 || (hour === 19 && minute <= 55)) return true;
  }

  const fourthSunday = getFourthSundayOfMonth();

  // 检查是否是今天
  if (now.getDate() !== fourthSunday.getDate()) return false;

  // 检查时间 00:00 - 19:55
  const hour = now.getHours();
  const minute = now.getMinutes();
  if (hour > 19 || (hour === 19 && minute > 55)) return false;

  return true;
});

const warGuessActivityTip = computed(() => {
  if (isWarGuessActivityOpen.value) return "";

  const fourthSunday = getFourthSundayOfMonth();
  const month = fourthSunday.getMonth() + 1;
  const date = fourthSunday.getDate();
  return `月赛助威仅在每月第四个周日 (${month}月${date}日) 00:00-19:55 开放`;
});

const selectedTokens = ref([]);
const tokenStatus = ref({}); // { tokenId: 'waiting' | 'running' | 'completed' | 'failed' }
const saltOnceRows = ref([]);
const isRunning = ref(false);
const autoExecutionActive = ref(false);
const scheduledExecutionActive = ref(false);
const shouldStop = ref(false);

// =====================
// Token分组管理状态
// =====================
const showGroupManageModal = ref(false);
const showGroupSelectModal = ref(false);
const selectedGroups = ref([]); // 选中的分组ID列表
const newGroupName = ref("");
const newGroupColor = ref("#1677ff");
const newGroupSelectedTokens = ref([]); // 新建分组时选中的Token ID列表
const editingGroupId = ref(null);
const editingGroupName = ref("");
const editingGroupColor = ref("");
const taskScheduleSelectedGroupIds = ref([]); // 定时任务中通过分组按钮选中的分组ID列表
const groupColors = [
  "#1677ff", // 蓝色
  "#52c41a", // 绿色
  "#faad14", // 橙色
  "#f5222d", // 红色
  "#722ed1", // 紫色
  "#13c2c2", // 青色
  "#eb2f96", // 粉色
  "#fa8c16", // 赤红色
];

// ======================
// War Guess Feature
// ======================
const showWarGuessModal = ref(false);
const warGuessList = ref([]);
const warGuessLoading = ref(false);
const warGuessCoin = ref(20);
const selectedWarGuessLegionId = ref(null);
const currentGuessCount = ref(0);

const formatPower = (power) => {
  if (!power) return "0";
  if (power >= 100000000) {
    return (power / 100000000).toFixed(2) + "亿";
  }
  if (power >= 10000) {
    return (power / 10000).toFixed(2) + "万";
  }
  return power.toString();
};

const warGuessColumns = [
  {
    type: "selection",
    multiple: false,
  },
  { title: "ID", key: "id", width: 100 },
  {
    title: "头像",
    key: "logo",
    render(row) {
      return h("img", {
        src: row.logo,
        style: { width: "30px", height: "30px", borderRadius: "50%" },
      });
    },
    width: 60,
  },
  { title: "区服", key: "serverId", width: 80 },
  { title: "俱乐部", key: "name", width: 120 },
  {
    title: "战力",
    key: "power",
    render(row) {
      return formatPower(row.power);
    },
    width: 100,
  },
  { title: "红淬", key: "quenchNum" },
  { title: "已助威", key: "guessNum" },
  {
    title: "总热度",
    key: "totalNum",
    render(row) {
      return formatPower(row.totalNum || 0);
    },
    width: 100,
  },
];

const warGuessRowProps = (row) => {
  return {
    style: "cursor: pointer",
    onClick: () => {
      selectedWarGuessLegionId.value = row.id;
    },
  };
};

const openWarGuessModal = () => {
  showWarGuessModal.value = true;
  // Reset selection
  selectedWarGuessLegionId.value = null;
  warGuessList.value = [];

  // Auto fetch if tokens selected
  if (selectedTokens.value.length > 0) {
    fetchWarGuessRank();
  }
};

const fetchWarGuessRank = async () => {
  if (selectedTokens.value.length === 0) {
    message.warning("请先选择一个账号用于获取月赛助威数据");
    return;
  }

  const tokenId = selectedTokens.value[0];
  const token = tokens.value.find((t) => t.id === tokenId);

  warGuessLoading.value = true;
  try {
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `正在使用 ${token.name} 获取月赛助威数据...`,
      type: "info",
    });

    // Ensure connection
    const status = tokenStore.getWebSocketStatus(tokenId);
    if (status !== "connected") {
      tokenStore.createWebSocketConnection(tokenId, token.token, token.wsUrl);
      await new Promise((r) => setTimeout(r, 2000)); // Wait for connection
    }

    // Fetch rank
    const res = await tokenStore.sendMessageWithPromise(
      tokenId,
      "warguess_getrank",
      { bfId: "" },
      5000,
    );

    if (res && res.list) {
      let list = [];
      if (Array.isArray(res.list)) {
        list = res.list;
      } else {
        list = Object.values(res.list);
      }

      // Sort by totalNum desc
      warGuessList.value = list
        .sort((a, b) => (b.totalNum || 0) - (a.totalNum || 0))
        .slice(0, 20);
    } else {
      message.warning("获取月赛助威数据为空");
    }
  } catch (error) {
    console.error("Fetch rank error:", error);
    message.error("获取月赛助威数据失败: " + error.message);
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `获取月赛助威数据失败: ${error.message}`,
      type: "error",
    });
  } finally {
    warGuessLoading.value = false;
  }
};

const handleWarGuessCheer = async () => {
  if (!selectedWarGuessLegionId.value) {
    message.warning("请先选择一个俱乐部");
    return;
  }
  // Close modal
  showWarGuessModal.value = false;
  // Call the batch function
  await batchWarGuessCheer(selectedWarGuessLegionId.value, warGuessCoin.value);
};

// Settings Modal State
const showSettingsModal = ref(false);
const currentSettingsTokenId = ref(null);
const currentSettingsTokenName = ref("");
const currentSettings = reactive({
  arenaFormation: 1,
  towerFormation: 1,
  bossFormation: 1,
  bossTimes: 2,
  claimBottle: true,
  payRecruit: true,
  openBox: true,
  arenaEnable: true,
  claimHangUp: true,
  claimEmail: true,
  blackMarketPurchase: true,
});

// Task Template State
const showTaskTemplateModal = ref(false);
const showApplyTemplateModal = ref(false);
const showTemplateManagerModal = ref(false);
const showAccountTemplateModal = ref(false);
const taskTemplates = ref([]);
const selectedTemplateId = ref(null);
const selectedTokensForApply = ref([]);
const currentTemplateName = ref("");
const currentTemplateId = ref(null); // 用于编辑现有模板
const currentTemplate = reactive({
  arenaFormation: 1,
  towerFormation: 1,
  bossFormation: 1,
  bossTimes: 2,
  claimBottle: true,
  payRecruit: true,
  openBox: true,
  arenaEnable: true,
  claimHangUp: true,
  claimEmail: true,
  blackMarketPurchase: true,
});

// Account Template References
const accountTemplateReferences = ref([]);
const filteredAccountTemplates = ref([]);
const selectedTemplateForFilter = ref(null);

// Computed for Apply Template
const isAllSelectedForApply = computed(() => {
  return (
    selectedTokensForApply.value.length === sortedTokens.value.length &&
    sortedTokens.value.length > 0
  );
});

const isIndeterminateForApply = computed(() => {
  return (
    selectedTokensForApply.value.length > 0 &&
    selectedTokensForApply.value.length < sortedTokens.value.length
  );
});

// Computed for Template Manager
const filteredTaskTemplates = computed(() => {
  return taskTemplates.value;
});

// Helper Modal State
const showHelperModal = ref(false);
const helperType = ref("box"); // 'box' | 'fish' | 'recruit'
const helperSettings = reactive({
  boxType: 2001,
  fishType: 1,
  count: 100,
  targetPoints: 1000,
});

const helperModalTitle = computed(() => {
  const titles = {
    box: "批量开宝箱",
    fish: "批量钓鱼",
    recruit: "批量招募",
    pointsBox: "按积分开箱",
  };
  return titles[helperType.value] || "批量助手";
});

// Batch Settings State
const showBatchSettingsModal = ref(false);

const defaultDreamPurchaseList = [];
for (const merchantId in goldItemsConfig) {
  goldItemsConfig[merchantId].forEach((index) => {
    defaultDreamPurchaseList.push(`${merchantId}-${index}`);
  });
}

const batchSettings = reactive({
  dreamPurchaseList: defaultDreamPurchaseList,
  dreamPurchaseManualEnabled: false,
  dreamPurchaseBlackMarketEnabled: false,
  boxCount: 100,
  fishCount: 100,
  recruitCount: 100,
  cdkCodes: "",
  cdkPlatformType: "h5",
  blackMarketPurchaseList: [],
  lowMarketLimits: defaultLowMarketLimits(),
  formationDispatchConfig: createDefaultFormationDispatchConfig(),
  defaultBoxType: 2001,
  defaultFishType: 1,
  targetBoxPoints: 1000,
  boxPointRules: normalizeBoxRules(),
  receiverId: "",
  password: "",
  tokenListColumns: 2,
  // 延迟配置（毫秒）
  commandDelay: 500, // 命令间延迟
  taskDelay: 500, // 任务间延迟
  actionDelay: 300, // 一般操作延迟（开箱、钓鱼、招募等）
  battleDelay: 500, // 战斗延迟（竞技场等）
  refreshDelay: 1000, // 刷新延迟（发车刷新等）
  longDelay: 3000, // 长延迟（功法赠送等）
  // 其他配置
  maxActive: 2,
  connectionTimeout: 10000,
  reconnectDelay: 1000,
  maxLogEntries: 1000,
  // 页面刷新配置
  enableRefresh: false,
  refreshInterval: 360, // 分钟
});

const pushPlusSettings = reactive(loadPushPlusSettings());
const pushPlusTesting = ref(false);
const pushPlusStatus = ref("");

const reloadPushPlusSettings = () => {
  Object.assign(pushPlusSettings, loadPushPlusSettings());
  pushPlusStatus.value = "";
};

const testPushPlus = async () => {
  const token = String(pushPlusSettings.token || "").trim();
  if (!token) {
    pushPlusStatus.value = "请先填写 Token";
    message.warning("请先填写 PushPlus Token");
    return;
  }

  pushPlusTesting.value = true;
  pushPlusStatus.value = "正在发送测试通知…";
  try {
    const now = new Date();
    const result = await enqueuePushPlusNotification({
      title: `XYZW PushPlus 测试｜${now.toLocaleTimeString()}`,
      content: `<h3>PushPlus 配置测试成功</h3><div>时间：${now.toLocaleString()}</div><div>此消息仅用于验证 Token。</div>`,
      settings: { enabled: true, token },
    });
    if (result.status === "accepted") {
      pushPlusStatus.value = "请求已被 PushPlus 接收";
      message.success("PushPlus 测试请求已接收");
    } else {
      const reason = result.error || result.reason || "未知原因";
      pushPlusStatus.value = `测试失败：${reason}`;
      message.error(`PushPlus 测试失败：${reason}`);
    }
  } catch (error) {
    const reason = error?.message || String(error);
    pushPlusStatus.value = `测试失败：${reason}`;
    message.error(`PushPlus 测试失败：${reason}`);
  } finally {
    pushPlusTesting.value = false;
  }
};

const clearPushPlusConfig = () => {
  try {
    Object.assign(pushPlusSettings, clearPushPlusToken());
    pushPlusStatus.value = "Token 已清除，通知已关闭";
    message.success("PushPlus Token 已清除");
  } catch (error) {
    message.error(error?.message || "清除 PushPlus Token 失败");
  }
};

const normalizeExtrasSettings = () => {
  batchSettings.cdkCodes = typeof batchSettings.cdkCodes === "string" ? batchSettings.cdkCodes : "";
  batchSettings.cdkPlatformType = typeof batchSettings.cdkPlatformType === "string" ? batchSettings.cdkPlatformType.trim() || "h5" : "h5";
  batchSettings.blackMarketPurchaseList = normalizeBlackMarketPurchaseList(batchSettings.blackMarketPurchaseList);
  batchSettings.formationDispatchConfig = normalizeFormationDispatchConfig(batchSettings.formationDispatchConfig);
  // Remove retired smart-departure settings from old localStorage/imported configs.
  ["carMinColor", "useGoldRefreshFallback", "smartDepartureGoldThreshold", "smartDepartureRecruitThreshold", "smartDepartureJadeThreshold", "smartDepartureTicketThreshold", "smartDepartureMatchAll"].forEach((key) => delete batchSettings[key]);
};

// Load batch settings from localStorage
const loadBatchSettings = () => {
  try {
    const saved = localStorage.getItem("batchSettings");
    if (saved) {
      const parsed = JSON.parse(saved);
      Object.assign(batchSettings, parsed);
      normalizeExtrasSettings();
    }
  } catch (error) {
    console.error("Failed to load batch settings:", error);
  }
};

// Save batch settings to localStorage
const saveBatchSettings = () => {
  try {
    localStorage.setItem("batchSettings", JSON.stringify(batchSettings));
    Object.assign(pushPlusSettings, savePushPlusSettings(pushPlusSettings));
    message.success("定时批量任务设置已保存");
    showBatchSettingsModal.value = false;
  } catch (error) {
    console.error("Failed to save batch settings:", error);
    message.error("保存设置失败");
  }
};

// Open batch settings modal
const openBatchSettings = () => {
  loadBatchSettings();
  reloadPushPlusSettings();
  showBatchSettingsModal.value = true;
};

// Load settings on component mount
loadBatchSettings();

// ======================
// Legacy Gift Feature
// ======================

// Legacy Gift Modal State
const showLegacyGiftModal = ref(false);
const recipientIdInput = ref("");
const recipientIdError = ref("");
const recipientInfo = ref(null);
const isQueryingRecipient = ref(false);
const giftQuantity = ref(10);
const securityPassword = ref(""); // 安全密码
// 头像加载状态
const isAvatarLoading = ref(false);
const avatarLoadError = ref(false);

// ======================
// Scheduled Tasks Feature
// ======================

// Scheduled Tasks State Management
const scheduledTasks = ref([]); // List of all scheduled tasks
const showTaskModal = ref(false); // Control the visibility of the add/edit task modal
const showTasksModal = ref(false); // Control the visibility of the tasks list modal
const editingTask = ref(null); // Currently editing task
const taskForm = reactive({
  name: "", // Task name
  runType: "daily", // 'daily' or 'cron'
  runTime: null, // Daily run time (HH:mm format)
  cronExpression: "", // Cron expression for complex scheduling
  selectedTokens: [], // Selected token IDs
  selectedTasks: [], // Selected task function names
  legionApplyTargetId: "",
  enabled: true, // Whether the task is enabled
});

// 任务分组定义
const taskGroupDefinitions = [
  {
    name: "daily",
    label: "日常",
    tasks: [
      "startBatch",
      "claimHangUpRewards",
      "batchAddHangUpTime",
      "resetBottles",
      "batchlingguanzi",
      "batchclubsign",
      "batchApplyLegion",
      "batchRefreshTokens",
      "batchStudy",
      "batcharenafight",
      "batchBonfireSignup",
      "batchPhoenixPrayer",
      "batchJianghuMarket",
      "batchApexGuess",
      "store_syncpurchaseconfig",
      "store_purchase",
      "collection_claimfreereward",
      "batchGenieSweep",
    ],
  },
  {
    name: "dungeon",
    label: "副本",
    tasks: [
      "climbTower",
      "batchSaltOnce", // SALT_SCHEDULE_V1
      "batchCampChallengePet",
      "batchmengjing",
      "skinChallenge",
      "batchClaimPeachTasks",
      "batchBuyDreamItems",
    ],
  },
  {
    name: "weirdTower",
    label: "怪异塔",
    tasks: [
      "climbWeirdTower",
      "batchWeirdTowerIntegrated",
      "batchUseItems",
      "batchMergeItems",
      "batchClaimFreeEnergy",
    ],
  },
  {
    name: "resource",
    label: "资源",
    tasks: [
      "batchOpenBox",
      "batchOpenBoxByPoints",
      "batchClaimBoxPointReward",
      "batchFish",
      "batchRecruit",
      "batchRedeemCodes",
      "legion_storebuygoods",
    ],
  },
  {
    name: "legacy",
    label: "功法",
    tasks: ["batchLegacyClaim", "batchLegacyGiftSendEnhanced"],
  },
  {
    name: "monthly",
    label: "月度",
    tasks: ["batchTopUpFish", "batchTopUpArena"],
  },
];

// 计算属性，根据 taskGroupDefinitions 将 availableTasks 分组
const groupedAvailableTasks = computed(() => {
  const groups = {};
  taskGroupDefinitions.forEach((group) => {
    groups[group.name] = availableTasks.filter((task) =>
      group.tasks.includes(task.value),
    );
  });

  // 处理未分组的任务
  const groupedTaskValues = taskGroupDefinitions.flatMap((g) => g.tasks);
  const otherTasks = availableTasks.filter(
    (task) => !groupedTaskValues.includes(task.value),
  );
  if (otherTasks.length > 0) {
    groups["other"] = otherTasks;
  }

  return groups;
});

// Cron表达式解析相关变量
const cronValidation = ref({ valid: true, message: "" });
const cronNextRuns = ref([]);

// 注: availableTasks, taskColumns 已从 @/utils/batch 导入

// ======================
// Scheduled Tasks Storage
// ======================

// Track executing tasks for UI loading state
const executingTaskIds = ref([]);

// Manual execute task
const manualExecuteTask = async (task) => {
  if (executingTaskIds.value.includes(task.id)) return;
  if (autoRuntime.hasPending || scheduledExecutionActive.value || isRunning.value) {
    message.warning("已有批量任务正在排队或执行，请结束后再手工执行定时任务");
    return;
  }

  // Reset stop flag if not running, to allow manual execution
  if (!isRunning.value && shouldStop.value) {
    shouldStop.value = false;
  }

  executingTaskIds.value.push(task.id);
  try {
    message.info(`开始执行任务: ${task.name}`);
    await executeScheduledTask(task);
    message.success(`任务 ${task.name} 执行完成`);
  } catch (e) {
    console.error(`执行任务 ${task.name} 失败:`, e);
    message.error(`任务 ${task.name} 执行失败`);
  } finally {
    executingTaskIds.value = executingTaskIds.value.filter(
      (id) => id !== task.id,
    );
  }
};

// Load scheduled tasks from localStorage
const loadScheduledTasks = () => {
  try {
    const saved = localStorage.getItem("scheduledTasks");

    if (saved) {
      const parsed = JSON.parse(saved);

      // Ensure we have an array
      scheduledTasks.value = Array.isArray(parsed) ? parsed.map(removeRetiredTasks) : [];
      if (JSON.stringify(scheduledTasks.value) !== saved) {
        try { localStorage.setItem("scheduledTasks", JSON.stringify(scheduledTasks.value)); }
        catch { console.warn("旧活动定时项已在当前页面清理，配置保存失败；下次加载会重新清理"); }
      }
    } else {
      scheduledTasks.value = [];
    }
  } catch (error) {
    console.error("Failed to load scheduled tasks:", error);
    scheduledTasks.value = [];
  }
};

// Save scheduled tasks to localStorage
const saveScheduledTasks = () => {
  try {
    const dataToSave = JSON.stringify(scheduledTasks.value);

    localStorage.setItem("scheduledTasks", dataToSave);
    // Verify save was successful
    const saved = localStorage.getItem("scheduledTasks");
  } catch (error) {
    console.error("Failed to save scheduled tasks:", error);
  }
};

// Open task modal for adding new task
const openTaskModal = () => {
  editingTask.value = null;
  Object.assign(taskForm, {
    name: "",
    runType: "daily",
    runTime: undefined,
    cronExpression: "",
    selectedTokens: [],
    selectedTasks: [],
    legionApplyTargetId: "",
    enabled: true,
  });
  taskScheduleSelectedGroupIds.value = [];
  showTaskModal.value = true;
};

// Edit existing task
const editTask = (task) => {
  editingTask.value = task;
  const taskData = { ...task };
  if (
    task.runType === "daily" &&
    task.runTime &&
    typeof task.runTime === "string"
  ) {
    const [hours, minutes] = task.runTime.split(":").map(Number);
    const now = new Date();
    taskData.runTime = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hours,
      minutes,
    );
  }
  Object.assign(taskForm, taskData, { legionApplyTargetId: String(taskData.legionApplyTargetId ?? "") });
  taskScheduleSelectedGroupIds.value = [];
  showTaskModal.value = true;
};

// 注: validateCronExpression 已从 @/utils/batch 导入

// Parse cron expression and calculate next execution times
const parseCronExpression = (expression) => {
  // Validate the expression first
  const validation = validateCronExpression(expression);
  cronValidation.value = validation;

  if (!validation.valid) {
    cronNextRuns.value = [];
    return;
  }

  // Parse the expression and calculate next runs
  const cronParts = expression.split(" ").filter(Boolean);
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] =
    cronParts;

  // Calculate next 5 execution times
  const nextRuns = calculateNextRuns(
    minuteField,
    hourField,
    dayOfMonthField,
    monthField,
    dayOfWeekField,
    5,
  );
  cronNextRuns.value = nextRuns;
};

// 注: calculateNextRuns 已从 @/utils/batch 导入

// Save task (create or update)
const saveTask = () => {
  if (!taskForm.name) {
    message.warning("请输入任务名称");
    return;
  }

  if (taskForm.runType === "daily" && !taskForm.runTime) {
    message.warning("请选择运行时间");
    return;
  }

  if (taskForm.runType === "cron") {
    if (!taskForm.cronExpression) {
      message.warning("请输入Cron表达式");
      return;
    }

    // Validate cron expression
    const validation = validateCronExpression(taskForm.cronExpression);
    if (!validation.valid) {
      message.warning(validation.message);
      return;
    }
  }

  if (taskForm.selectedTokens.length === 0) {
    message.warning("请选择至少一个账号");
    return;
  }

  if (taskForm.selectedTasks.length === 0) {
    message.warning("请选择至少一个任务");
    return;
  }

  if (taskForm.selectedTasks.includes("batchApplyLegion") && !normalizeLegionId(taskForm.legionApplyTargetId)) {
    message.warning("请填写有效的目标俱乐部 ID");
    return;
  }

  // Format runTime as string for storage
  let formattedRunTime = null;
  if (taskForm.runType === "daily" && taskForm.runTime) {
    const time = new Date(taskForm.runTime);
    formattedRunTime = time.toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const taskData = {
    id: editingTask.value?.id || "task_" + Date.now(),
    name: taskForm.name,
    runType: taskForm.runType,
    runTime: formattedRunTime,
    cronExpression: taskForm.runType === "cron" ? taskForm.cronExpression : "",
    selectedTokens: [...taskForm.selectedTokens],
    selectedTasks: [...taskForm.selectedTasks],
    legionApplyTargetId: taskForm.selectedTasks.includes("batchApplyLegion") ? normalizeLegionId(taskForm.legionApplyTargetId) : null,
    enabled: taskForm.enabled,
  };

  let isNew = !editingTask.value;

  if (editingTask.value) {
    // Update existing task
    const index = scheduledTasks.value.findIndex(
      (t) => t.id === editingTask.value.id,
    );
    if (index !== -1) {
      scheduledTasks.value[index] = taskData;
    }
  } else {
    // Add new task
    scheduledTasks.value.push(taskData);
  }

  saveScheduledTasks();

  // Add log entry for task save
  addTaskSaveLog(taskData, isNew, addLog);

  showTaskModal.value = false;
  message.success("定时任务已保存");
};

// Delete task
const deleteTask = (taskId) => {
  const task = scheduledTasks.value.find((t) => t.id === taskId);
  if (task) {
    scheduledTasks.value = scheduledTasks.value.filter((t) => t.id !== taskId);
    saveScheduledTasks();
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 定时任务 ${task.name} 已删除 ===`,
      type: "info",
    });
    message.success("定时任务已删除");
  }
};

// Toggle task enabled state
const toggleTaskEnabled = (taskId, enabled) => {
  const task = scheduledTasks.value.find((t) => t.id === taskId);
  if (task) {
    task.enabled = enabled;
    saveScheduledTasks();
    message.success(`定时任务已${enabled ? "启用" : "禁用"}`);
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 定时任务 ${task.name} 已${enabled ? "启用" : "禁用"} ===`,
      type: "info",
    });
  }
};

// 注: addTaskSaveLog 已从 @/utils/batch 导入，调用时需传入 addLog

// Reset run type related fields
const resetRunType = () => {
  if (taskForm.runType === "daily") {
    taskForm.cronExpression = "";
  } else {
    taskForm.runTime = undefined;
  }
};

// Select all tokens
const selectAllTokens = () => {
  taskForm.selectedTokens = tokens.value.map((token) => token.id);
};

// Deselect all tokens
const deselectAllTokens = () => {
  taskForm.selectedTokens = [];
};

// Select all tasks
const selectAllTasks = () => {
  taskForm.selectedTasks = availableTasks.map((task) => task.value);
};

// Deselect all tasks
const deselectAllTasks = () => {
  taskForm.selectedTasks = [];
};

// ======================
// Import/Export Config
// ======================

const showConfigExport = ref(false);
const configTransferBusy = ref(false);
const configBinAccess = createTokenBinAccess(useIndexedDB());

function downloadConfig(data, prefix) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${prefix}_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  try { link.click(); }
  finally {
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const exportConfig = async ({ ids, format = "config", includeBin = true } = {}) => {
  if (configTransferBusy.value) return;
  configTransferBusy.value = true;
  try {
    const accounts = [...tokens.value];
    const validTokenIds = new Set(ids ?? accounts.map(account => account.id));
    const selected = accounts.filter(account => validTokenIds.has(account.id));
    if (!selected.length) throw new Error("请至少选择一个账号");
    if (validTokenIds.size !== selected.length) throw new Error("账号列表已变化，请重新打开导出窗口");
    if (format === "bin") {
      const archive = await exportBinArchive(selected, accounts, configBinAccess, tokenGroups.value);
      downloadConfig(archive, "xyzw_bins");
      showConfigExport.value = false;
      message.success(`已导出 ${archive.files.length} 份原始 BIN，包含 ${archive.tokenGroups.length} 个分组`);
      return;
    }
    const allSelected = selected.length === accounts.length;
    const exported = await exportTokenRecords(selected, configBinAccess, includeBin, accounts);
    // Filter scheduled tasks: remove invalid token IDs from selectedTokens
    const filteredScheduledTasks = scheduledTasks.value
      .map(({ connectedTokens: _runtimeOnly, ...task }) => ({
        ...task,
        selectedTokens:
          task.selectedTokens?.filter((tokenId) =>
            validTokenIds.has(tokenId),
          ) || [],
      }))
      .filter((task) => task.selectedTokens.length > 0); // Remove tasks with no valid tokens

    // Gather token settings
    const tokenSettings = [];
    selected.forEach((token) => {
      const settings = localStorage.getItem(`daily-settings:${token.id}`);
      if (settings) {
        try {
          tokenSettings.push({
            tokenId: token.id,
            settings: JSON.parse(settings),
          });
        } catch (e) {
          console.warn(`Failed to parse settings for token ${token.id}`, e);
        }
      }
    });

    const exportData = {
      version: "1.2",
      ...(allSelected ? {} : { scope: "selected-accounts" }),
      exportTime: new Date().toISOString(),
      tokens: exported.records,
      scheduledTasks: filteredScheduledTasks,
      tokenGroups: tokenGroups.value.map(group => ({
        ...group, tokenIds: group.tokenIds.filter(id => validTokenIds.has(id)),
      })).filter(group => allSelected || group.tokenIds.length),
      tokenSettings,
    };
    if (allSelected) {
      exportData.autoWeeklySchedule = autoConfig.value;
      exportData.batchSettings = {
        dreamPurchaseList: [...batchSettings.dreamPurchaseList],
        dreamPurchaseManualEnabled: batchSettings.dreamPurchaseManualEnabled === true,
        dreamPurchaseBlackMarketEnabled: batchSettings.dreamPurchaseBlackMarketEnabled === true,
        boxCount: batchSettings.boxCount,
        fishCount: batchSettings.fishCount,
        recruitCount: batchSettings.recruitCount,
        cdkCodes: batchSettings.cdkCodes,
        cdkPlatformType: batchSettings.cdkPlatformType,
        blackMarketPurchaseList: batchSettings.blackMarketPurchaseList,
        lowMarketLimits: batchSettings.lowMarketLimits,
        formationDispatchConfig: batchSettings.formationDispatchConfig,
        defaultBoxType: batchSettings.defaultBoxType,
        defaultFishType: batchSettings.defaultFishType,
        commandDelay: batchSettings.commandDelay,
        taskDelay: batchSettings.taskDelay,
        actionDelay: batchSettings.actionDelay,
        battleDelay: batchSettings.battleDelay,
        refreshDelay: batchSettings.refreshDelay,
        longDelay: batchSettings.longDelay,
        maxActive: batchSettings.maxActive,
        tokenListColumns: batchSettings.tokenListColumns,
      };
    }

    downloadConfig(exportData, "xyzw_config");
    showConfigExport.value = false;

    message.success(
      `导出成功: ${exportData.tokens.length} 个账号, ${exportData.scheduledTasks.length} 个定时任务，含 ${exported.included} 份原始BIN`,
    );
    if (exported.missing) message.warning(`${exported.missing} 个账号缺少原始BIN；目标设备仍需补导BIN`);
  } catch (error) {
    message.error(error.message || "配置导出失败");
  } finally { configTransferBusy.value = false; }
};

// Import tokens and scheduled tasks configuration
const importConfig = async ({ file }) => {
  if (configTransferBusy.value) return;
  configTransferBusy.value = true;
  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const importData = JSON.parse(e.target.result);

        if (importData?.format === "xyzw-bin-archive") {
          const restore = async () => {
            const result = await restoreBinArchive(importData, {
              accounts: gameTokens, groups: tokenGroups, storage: localStorage,
              access: configBinAccess, authenticate: transformToken,
            });
            message.success(`新增 ${result.added} 个账号，已存在或文件内重复 ${result.duplicates} 个，写入 ${result.restoredBins} 份 BIN，文件含 ${result.groupCount} 个分组`);
          };
          if (globalThis.navigator?.locks) {
            await navigator.locks.request("xyzw:bin-config-import", { ifAvailable: true }, lock => {
              if (!lock) throw new Error("其他标签页正在导入 BIN，请稍后重试");
              return restore();
            });
          } else {
            await restore();
          }
          return;
        }

        // Validate structure
        if (
          !importData.version ||
          !Array.isArray(importData.tokens) ||
          !Array.isArray(importData.scheduledTasks)
        ) {
          message.error("无效的配置文件格式");
          return;
        }

        const originalTokens = gameTokens.value;
        const originalSnapshot = JSON.stringify(originalTokens);
        const restored = await importTokenRecords(importData.tokens, originalTokens, configBinAccess);
        if (JSON.stringify(gameTokens.value) !== originalSnapshot) throw new Error("导入期间账号列表变化，请重试");
        gameTokens.value = restored.tokens;
        const importedTokens = restored.added;
        const mapIds = ids => remapTokenIds(ids, restored.idMap);
        // 分批迁移两份选区时合并成员；整份旧备份仍保留原有合并规则。
        const mergeMembers = (local, incoming) => {
          const members = mapIds(local);
          if (importData.scope !== "selected-accounts") return members;
          const imported = (incoming || []).filter(id => restored.idMap.has(id));
          return [...new Set([...members, ...mapIds(imported)])];
        };
        let importedTasks = 0;

        // Import scheduled tasks
        if (Array.isArray(importData.scheduledTasks)) {
          importData.scheduledTasks.map(removeRetiredTasks).forEach((task) => {
            const existing = scheduledTasks.value.find((t) => t.id === task.id);
            if (existing) existing.selectedTokens = mergeMembers(existing.selectedTokens, task.selectedTokens);
            if (!existing && task.id) {
              scheduledTasks.value.push({ ...task, selectedTokens: mapIds(task.selectedTokens) });
              importedTasks++;
            }
          });
          saveScheduledTasks();
        }

        // Merge missing groups only; preserve existing memberships and old import behavior.
        if (Array.isArray(importData.tokenGroups)) {
          const validIds = new Set(gameTokens.value.map((token) => token.id));
          importData.tokenGroups.forEach((group) => {
            const existing = tokenGroups.value.find(item => item.id === group?.id);
            if (existing) existing.tokenIds = mergeMembers(existing.tokenIds, group.tokenIds).filter(id => validIds.has(id));
            if (typeof group?.id === "string" && typeof group.name === "string" && Array.isArray(group.tokenIds)
              && !tokenGroups.value.some((item) => item.id === group.id)) {
              tokenGroups.value.push({ id: group.id, name: group.name, color: group.color || "#1677ff",
                tokenIds: mapIds(group.tokenIds).filter((id) => validIds.has(id)) });
            }
          });
        }
        if (importData.autoWeeklySchedule && typeof importData.autoWeeklySchedule === "object") {
          if ((await saveAutoConfig(importData.autoWeeklySchedule)) === false)
            throw new Error("自动周计划配置保存失败");
        }

        // Import batch settings if provided
        if (importData.batchSettings) {
          Object.assign(batchSettings, { dreamPurchaseManualEnabled: false, dreamPurchaseBlackMarketEnabled: false }, importData.batchSettings);
          normalizeExtrasSettings();
          saveBatchSettings();
        }

        // Import token settings
        if (Array.isArray(importData.tokenSettings)) {
          importData.tokenSettings.forEach((item) => {
            if (item.tokenId && item.settings) {
              localStorage.setItem(
                `daily-settings:${restored.idMap.get(item.tokenId) || item.tokenId}`,
                JSON.stringify(item.settings),
              );
            }
          });
        }

        message.success(
          `导入成功: ${importedTokens} 个新账号，修复 ${restored.repaired} 个已有账号，恢复 ${restored.restoredBins} 份BIN，${importedTasks} 个新定时任务`,
        );
        if (restored.missing) message.warning(`${restored.missing} 个账号缺少原始BIN，可保留配置；刷新前需补导BIN`);
      } catch (error) {
        // 不打印原配置或解析异常对象，避免带出认证数据。
        message.error(error instanceof SyntaxError ? "配置JSON格式无效" : (error.message || "配置导入失败"));
      } finally { configTransferBusy.value = false; }
    };
    reader.onerror = () => { configTransferBusy.value = false; message.error("配置文件读取失败"); };
    reader.readAsText(file.file);
  } catch {
    configTransferBusy.value = false;
    message.error("配置文件读取失败");
  }
};

// ======================
// Scheduled Tasks Countdown
// ======================

// 注: parseCronField, calculateNextExecutionTime, formatTimeDifference 已从 @/utils/batch 导入

const PREEMPTION_LEAD_MS = 2 * 60 * 1000;
const PREEMPTION_ACK_TIMEOUT_MS = 30000;
const PREEMPTION_RESUME_TIMEOUT_MS = 60000;
let preparedPreemption = null;
let scheduledExecutionChain = Promise.resolve();
let scheduledQueueDepth = 0;

const createPreemptionEntry = (task, scheduledAt, source) => {
  const requestId = taskPreemptionCoordinator.createRequestId("daily");
  const entry = {
    requestId,
    taskId: task.id,
    taskName: task.name,
    scheduledAt,
    source,
    claimed: false,
    response: null,
    promise: null,
  };

  entry.promise = taskPreemptionCoordinator
    .requestPreemption(
      {
        requestId,
        taskId: task.id,
        taskName: task.name,
        scheduledAt,
        selectedTokens: [...(task.selectedTokens || [])],
      },
      PREEMPTION_ACK_TIMEOUT_MS,
    )
    .then((response) => {
      if (response?.ready === false) {
        throw new Error(response.error || "推图会话未能完成抢占");
      }
      entry.response = response;
      if (response?.hadActivePush) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 已暂停主线推图，等待执行定时任务: ${task.name} ===`,
          type: "warning",
        });
      }
      return response;
    });

  return entry;
};

const prepareScheduledPreemption = (task, scheduledAt) => {
  if (!taskPreemptionCoordinator.hasActivePushPresence()) return;

  if (
    preparedPreemption
    && Math.abs(Number(preparedPreemption.scheduledAt) - Number(scheduledAt)) <= PREEMPTION_LEAD_MS
  ) {
    return;
  }

  if (preparedPreemption?.response?.hadActivePush && !preparedPreemption.claimed) {
    // 配置发生变化时先归还旧租约，防止推图长期停留在抢占状态。
    taskPreemptionCoordinator
      .requestResume(
        { requestId: preparedPreemption.requestId, reason: "schedule-replaced" },
        PREEMPTION_RESUME_TIMEOUT_MS,
      )
      .catch((error) => console.error("释放旧推图抢占租约失败", error));
  }

  preparedPreemption = createPreemptionEntry(task, scheduledAt, "lead-time");
  preparedPreemption.promise.catch((error) => {
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 定时任务抢占准备失败: ${error.message} ===`,
      type: "error",
    });
  });
};

const acquireTaskPreemption = async (task, isScheduledExecution) => {
  const now = Date.now();
  if (
    preparedPreemption
    && Math.abs(now - Number(preparedPreemption.scheduledAt || now)) <= 3 * 60 * 1000
  ) {
    preparedPreemption.claimed = true;
    await preparedPreemption.promise;
    return preparedPreemption;
  }

  if (!taskPreemptionCoordinator.hasActivePushPresence()) return null;

  const entry = createPreemptionEntry(task, now, isScheduledExecution ? "scheduled-now" : "manual");
  entry.claimed = true;
  await entry.promise;
  if (isScheduledExecution) preparedPreemption = entry;
  return entry;
};

const releasePreemptionLease = async (entry, reason = "task-finished") => {
  if (!entry) return;
  let response = entry.response;
  if (!response && entry.promise) {
    try {
      response = await entry.promise;
    } catch {
      response = null;
    }
  }

  if (response?.hadActivePush) {
    const result = await taskPreemptionCoordinator.requestResume(
      { requestId: entry.requestId, reason },
      PREEMPTION_RESUME_TIMEOUT_MS,
    );
    if (result?.resumed === false && result?.reason !== "snapshot-not-found") {
      throw new Error(result?.error || "恢复主线推图失败");
    }
    addLog({
      time: new Date().toLocaleTimeString(),
      message: "=== 批量日常结束，主线推图恢复指令已完成 ===",
      type: "success",
    });
  }

  if (preparedPreemption?.requestId === entry.requestId) {
    preparedPreemption = null;
  }
};

const enqueueScheduledTask = (task, executionKey, runAuto) => {
  scheduledQueueDepth += 1;
  scheduledExecutionChain = scheduledExecutionChain
    .then(() => runAuto ? runAuto() : executeScheduledTask(task, { scheduled: true, executionKey }))
    .catch((error) => {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `=== 定时任务队列执行失败: ${error.message} ===`,
        type: "error",
      });
    })
    .finally(async () => {
      scheduledQueueDepth = Math.max(0, scheduledQueueDepth - 1);
      if (scheduledQueueDepth === 0 && preparedPreemption) {
        const entry = preparedPreemption;
        try {
          await releasePreemptionLease(entry);
        } catch (error) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== 主线推图恢复失败: ${error.message} ===`,
            type: "error",
          });
        }
      }
    });
  return scheduledExecutionChain;
};

// Task countdowns ref
const taskCountdowns = ref({});
const nextExecutionTimes = ref({});

// Update countdowns for all tasks
const updateCountdowns = () => {
  const now = Date.now();
  let nearestTask = null;
  let nearestExecutionTime = Infinity;

  scheduledTasks.value.forEach((task) => {
    if (!task.enabled) {
      // Clear countdown for disabled tasks
      delete taskCountdowns.value[task.id];
      return;
    }

    if (
      !nextExecutionTimes.value[task.id] ||
      nextExecutionTimes.value[task.id] <= now
    ) {
      // Calculate next execution time if not set or passed
      nextExecutionTimes.value[task.id] = calculateNextExecutionTime(task);
    }

    if (nextExecutionTimes.value[task.id]) {
      const timeDiff = nextExecutionTimes.value[task.id] - now;
      taskCountdowns.value[task.id] = {
        remainingTime: Math.max(0, timeDiff),
        formatted: formatTimeDifference(Math.max(0, timeDiff)),
        isNearExecution: timeDiff < 5 * 60 * 1000, // Less than 5 minutes
      };
      if (timeDiff > 0 && timeDiff < nearestExecutionTime) {
        nearestTask = task;
        nearestExecutionTime = timeDiff;
      }
    }
  });

  if (nearestTask && nearestExecutionTime <= PREEMPTION_LEAD_MS) {
    prepareScheduledPreemption(nearestTask, nextExecutionTimes.value[nearestTask.id]);
  }

  if (
    preparedPreemption
    && !preparedPreemption.claimed
    && now > Number(preparedPreemption.scheduledAt || 0) + 60 * 1000
  ) {
    const staleEntry = preparedPreemption;
    releasePreemptionLease(staleEntry, "schedule-missed").catch((error) => {
      console.error("释放过期推图抢占租约失败", error);
    });
  }
};

// 计算最短倒计时任务
const shortestCountdownTask = computed(() => {
  if (scheduledTasks.value.length === 0) return null;

  let shortestTask = null;
  let shortestTime = Infinity;

  // 遍历所有任务，找到倒计时最短的任务
  scheduledTasks.value.forEach((task) => {
    if (!task.enabled) return;

    const countdown = taskCountdowns.value[task.id];
    if (countdown && countdown.remainingTime < shortestTime) {
      shortestTime = countdown.remainingTime;
      shortestTask = {
        task,
        countdown,
      };
    }
  });

  return shortestTask;
});

// Start countdown interval
let countdownInterval = null;

const startCountdown = () => {
  // Clear any existing interval
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }

  // Update countdowns immediately
  updateCountdowns();

  // Update countdowns every second
  countdownInterval = setInterval(updateCountdowns, 1000);
};

// ======================
// Scheduled Tasks Scheduler
// ======================

// Initialize scheduled tasks from localStorage
loadScheduledTasks();

// Watch for changes to scheduledTasks for debugging
watch(
  scheduledTasks,
  (newVal) => {
    // Reset countdowns when tasks change
    nextExecutionTimes.value = {};
    taskCountdowns.value = {};
    updateCountdowns();
  },
  { deep: true },
);

// 修复TimePicker的"Invalid time value"错误：确保runTime的初始值不是null
watch(
  () => showTaskModal.value,
  (isVisible) => {
    if (isVisible && !taskForm.runTime) {
      // 当模态框显示且runTime为null时，将其设置为undefined
      taskForm.runTime = undefined;
    }
  },
);

// Task scheduler variables - moved to component level scope
const intervalId = ref(null);
let lastTaskExecution = null;
let healthCheckInterval = null;
const pageLoadTime = Date.now();

// Health check for the scheduler
const healthCheck = () => {
  // If interval is not running, restart it
  if (!intervalId.value) {
    console.error(
      `[${new Date().toISOString()}] Task scheduler interval is not running, restarting...`,
    );
    startScheduler();
  }

  // Check for page refresh
  if (batchSettings.enableRefresh && batchSettings.refreshInterval > 0) {
    const elapsedMinutes = (Date.now() - pageLoadTime) / 1000 / 60;
    if (elapsedMinutes >= batchSettings.refreshInterval) {
      if (!isRunning.value && !autoRuntime.hasPending && !autoExecutionActive.value && !scheduledExecutionActive.value && scheduledQueueDepth === 0) {
        console.log(
          `[${new Date().toISOString()}] Refreshing page as scheduled (Interval: ${batchSettings.refreshInterval}m, Elapsed: ${elapsedMinutes.toFixed(1)}m)`,
        );
        window.location.reload();
      } else {
        console.log(
          `[${new Date().toISOString()}] Scheduled refresh postponed due to running task`,
        );
      }
    }
  }
};

// Start the scheduler
const startScheduler = () => {
  // Clear any existing interval first
  if (intervalId.value) {
    clearInterval(intervalId.value);
  }

  // Check every 10 seconds instead of 60 seconds for more timely task execution
  intervalId.value = setInterval(() => {
    try {
      const now = new Date();
      const currentTime = now.toLocaleTimeString("zh-CN", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      // Don't skip all tasks if isRunning is true, just skip individual task execution if already running
      const tasksToRun = scheduledTasks.value.filter((task) => task.enabled);

      if (tasksToRun.length === 0) {
        return;
      }

      tasksToRun.forEach((task) => {
        let shouldRun = false;
        let reason = "";

        if (task.runType === "daily") {
          // Check if current time matches the scheduled time
          const taskTime = task.runTime;
          const nowTime = now.toLocaleTimeString("zh-CN", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
          });
          shouldRun = nowTime === taskTime;
          reason = `currentTime=${nowTime}, taskTime=${taskTime}, match=${shouldRun}`;
        } else if (task.runType === "cron") {
          // Improved cron expression parsing using shared utility
          try {
            shouldRun = matchesCronExpression(task.cronExpression, now);
          } catch (error) {
            console.error(
              `[${new Date().toISOString()}] Error parsing cron expression ${task.cronExpression}:`,
              error,
            );
            addLog({
              time: currentTime,
              message: `=== 解析定时任务 ${task.name} 的Cron表达式失败: ${error.message} ===`,
              type: "error",
            });
            return;
          }
        }

        if (shouldRun) {
          // Check if the task was already executed in the last minute to avoid duplicate execution
          const taskExecutionKey = `${task.id}_${now.getDate()}_${now.getHours()}_${now.getMinutes()}`;
          const lastExecutionKey = localStorage.getItem(
            `lastTaskExecution_${task.id}`,
          );

          if (lastExecutionKey !== taskExecutionKey) {
            // Update last execution time
            localStorage.setItem(
              `lastTaskExecution_${task.id}`,
              taskExecutionKey,
            );

            // Execute the task
            lastTaskExecution = Date.now();
            enqueueScheduledTask(task, taskExecutionKey);
          } else {
            // Only log once per minute to avoid spamming logs
            // But since we check every 10s, this might log multiple times if we don't track logged state
            // For now, we can skip logging "already executed" to keep logs clean
          }
        }
      });
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error in task scheduler:`,
        error,
      );
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `=== 定时任务调度服务发生错误: ${error.message} ===`,
        type: "error",
      });
    }
  }, 10000); // Check every 10 seconds
};

// Token刷新等待处理函数
const handleTokenRefreshWaiting = (data) => {
  addLog({
    time: new Date().toLocaleTimeString(),
    message: `Token刷新限流等待中，预计等待 ${data.waitSeconds} 秒（队列: ${data.queueSize}）`,
    type: "warning",
  });
};

// Debug: Log initial state when component mounts
onMounted(() => {
  // Start the task scheduler after all functions are initialized
  scheduleTaskExecution();
  // Start countdown timer
  startCountdown();
  loadTaskTemplates();
  // 监听Token刷新等待事件
  $emit.on("token:refresh:waiting", handleTokenRefreshWaiting);
});

// KeepAlive 页面重新显示时，后台期间新增的日志不会再次触发 addLog。
// 在激活后的下一帧主动滚动，确保 DOM 已恢复并完成布局。
onActivated(() => {
  scrollLogToBottom();
});

// Cleanup countdown interval on unmount
onBeforeUnmount(() => {
  stopGenieChallenge();
  stopSaltOnce();
  if (preparedPreemption) {
    releasePreemptionLease(preparedPreemption, "batch-page-unmounted").catch((error) => {
      console.error("批量日常页面卸载时恢复推图失败", error);
    });
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  // 移除Token刷新等待事件监听
  $emit.off("token:refresh:waiting", handleTokenRefreshWaiting);

  // Cleanup task scheduler intervals
  if (intervalId.value) {
    clearInterval(intervalId.value);
    intervalId.value = null;
    addLog({
      time: new Date().toLocaleTimeString(),
      message: "=== 定时任务调度服务已停止 ===",
      type: "info",
    });
  }

  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
});

// Task scheduler - ensure it runs properly
const scheduleTaskExecution = () => {
  // Log the start of the scheduler
  addLog({
    time: new Date().toLocaleTimeString(),
    message: "=== 定时任务调度服务已启动 ===",
    type: "info",
  });

  // Start the scheduler
  startScheduler();

  // Health check every 5 minutes instead of 1 hour for more frequent safety checks
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }
  healthCheckInterval = setInterval(healthCheck, 5 * 60 * 1000);

  // Initial health check
  healthCheck();
};

// Verify task dependencies - 只验证基础依赖，WebSocket连接由具体任务函数处理
const verifyTaskDependencies = async (task) => {
  if (task.selectedTasks?.includes("batchApplyLegion") && !normalizeLegionId(task.legionApplyTargetId)) {
    addLog({ time: new Date().toLocaleTimeString(), type: "error", message: "定时申请俱乐部缺少有效的目标 ID，任务已取消" });
    return false;
  }
  addLog({
    time: new Date().toLocaleTimeString(),
    message: `=== 开始验证定时任务 ${task.name} 的依赖 ===`,
    type: "info",
  });

  // Verify localStorage is available
  try {
    localStorage.setItem("test", "test");
    localStorage.removeItem("test");
    addLog({
      time: new Date().toLocaleTimeString(),
      message: "✅ localStorage可用",
      type: "info",
    });
  } catch (error) {
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `❌ localStorage不可用: ${error.message}`,
      type: "error",
    });
    return false;
  }

  // Verify token store is available
  if (!tokenStore || !tokenStore.gameTokens) {
    addLog({
      time: new Date().toLocaleTimeString(),
      message: "❌ Token存储不可用",
      type: "error",
    });
    return false;
  }

  // Verify task functions exist
  for (const taskName of task.selectedTasks) {
    const taskFunction = resolveScheduledTaskFunction(taskName);
    if (typeof taskFunction !== "function") {
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `❌ 任务函数不存在: ${taskName}`,
        type: "error",
      });
      return false;
    }
  }

  // 直接使用所有选中的token，WebSocket连接由具体任务函数内部管理
  // ensureConnection函数会自动处理并行连接和连接池管理
  const connectedTokens = task.selectedTokens.map((tokenId) => {
    const tokenName =
      tokenStore.gameTokens.find((t) => t.id === tokenId)?.name || tokenId;
    return { id: tokenId, name: tokenName };
  });

  // Log connection status
  addLog({
    time: new Date().toLocaleTimeString(),
    message: `✅ 将使用 ${connectedTokens.length} 个账号执行任务`,
    type: "info",
  });

  // Store connected tokens for execution
  task.connectedTokens = connectedTokens.map((t) => t.id);

  addLog({
    time: new Date().toLocaleTimeString(),
    message: `=== 定时任务 ${task.name} 的依赖验证通过，将执行 ${connectedTokens.length} 个账号 ===`,
    type: "success",
  });
  return true;
};

const SCHEDULED_TERMINAL_STATUSES = new Set([
  "completed",
  "warning",
  "partial",
  "failed",
  "skipped",
  "stopped",
  "unavailable",
]);

const createScheduledReportCollector = (task, startedAt) => {
  const taskNames = [...new Set(task.selectedTasks || [])];
  const tokenIds = [...new Set((task.selectedTokens || []).map(String))];
  const taskLabels = new Map(
    availableTasks.map((item) => [item.value, item.label]),
  );
  const accounts = new Map();
  const runId = `${Number(startedAt).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let executionClient = "临时执行端";
  try {
    const key = "xyzw_report_client_v1";
    const saved = globalThis.localStorage?.getItem(key);
    executionClient = /^client-[a-z0-9]{6,16}$/.test(saved || "") ? saved : `client-${Math.random().toString(36).slice(2, 12)}`;
    globalThis.localStorage?.setItem(key, executionClient);
  } catch { /* Browser storage is optional. */ }

  tokenIds.forEach((tokenId) => {
    const token = tokens.value.find((item) => String(item.id) === tokenId);
    accounts.set(tokenId, {
      tokenId,
      name: token?.name || tokenId,
      tasks: new Map(
        taskNames.map((taskName) => [
          taskName,
          { status: "waiting", details: [], warnings: [] },
        ]),
      ),
    });
  });

  const update = (taskName, tokenId, status, details = [], warnings = [], metadata = {}) => {
    const account = accounts.get(String(tokenId));
    if (!account || !account.tasks.has(taskName)) return;
    const normalizedDetails = (Array.isArray(details) ? details : [details])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    account.tasks.set(taskName, {
      status: String(status || "failed"),
      details: normalizedDetails,
      observations: (Array.isArray(metadata.observations) ? metadata.observations : []).map(String).filter(Boolean),
      ...getVerificationMetadata({ status, details: normalizedDetails, warnings, ...metadata }),
      warnings: (Array.isArray(warnings) ? warnings : [warnings])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    });
  };

  const markTask = (taskName, ids, status, details = []) => {
    (ids || tokenIds).forEach((tokenId) => {
      update(taskName, tokenId, status, details);
      tokenStatus.value[tokenId] = status;
    });
  };

  const markPending = (status, details) => {
    accounts.forEach((account) => {
      account.tasks.forEach((entry, taskName) => {
        if (!SCHEDULED_TERMINAL_STATUSES.has(entry.status)) {
          update(taskName, account.tokenId, status, details);
          tokenStatus.value[account.tokenId] = status;
        }
      });
    });
  };

  const createStatusRef = (taskName) => {
    const state = {};
    return {
      recordResult(tokenId, status, details = [], warnings = [], metadata = {}) {
        state[tokenId] = status; tokenStatus.value[tokenId] = status;
        update(taskName, tokenId, status, details, warnings, metadata);
      },
      value: new Proxy(state, {
        get(target, property) {
          return target[property];
        },
        set(target, property, status) {
          target[property] = status;
          tokenStatus.value[property] = status;
          update(taskName, property, status);
          return true;
        },
      }),
    };
  };

  const applyTaskResult = (taskName, result) => {
    if (!Array.isArray(result)) return;
    result.forEach((accountResult) => {
      if (
        accountResult?.tokenId === null
        || accountResult?.tokenId === undefined
      ) {
        return;
      }
      tokenStatus.value[accountResult.tokenId] = accountResult.status || "warning";
      update(
        taskName,
        accountResult.tokenId,
        accountResult.status || "warning",
        accountResult.details || accountResult.exceptions || [],
        accountResult.warnings || [],
        accountResult,
      );
    });
  };

  const finalizeTask = (taskName, ids, errorReason = "") => {
    (ids || tokenIds).forEach(tokenId => {
      const entry = accounts.get(String(tokenId))?.tasks.get(taskName);
      if (!entry) return;
      if (!SCHEDULED_TERMINAL_STATUSES.has(entry.status)) {
        const detail = errorReason || `结果待核验：${taskName} 已返回，但账号状态仍为 ${entry.status}；不会自动重试`;
        update(taskName, tokenId, errorReason ? "failed" : "warning", detail, errorReason ? [] : [detail]);
        tokenStatus.value[tokenId] = errorReason ? "failed" : "warning";
      } else if (entry.status === "failed" && entry.details.length === 0) {
        update(taskName, tokenId, "failed", errorReason || "任务已报告失败，但执行器未提供详细原因", entry.warnings);
      }
    });
  };

  const finish = ({ onLog } = {}) => {
    markPending("warning", "结果待核验：定时任务提前结束，未收到最终结果；不会自动重试");
    const reportAccounts = [...accounts.values()].map((account) => {
      const entries = [...account.tasks.entries()];
      const completedCount = entries.filter(([, entry]) =>
        ["completed", "skipped"].includes(entry.status) && !entry.verificationRequired,
      ).length;
      const abnormalEntries = entries.filter(([, entry]) =>
        ["partial", "failed", "stopped", "unavailable"].includes(
          entry.status,
        ),
      );
      let status = summarizeEntries(entries.map(([, entry]) => entry)).status;

      const warnings = entries.flatMap(([taskName, entry]) => {
        const label = taskLabels.get(taskName) || taskName;
        return [...new Set([...(entry.warnings || []), ...(entry.status === "warning" ? entry.details : [])])].map(detail => `${label}（${detail}）`);
      });
      if (abnormalEntries.length === 0 &&
          (warnings.length > 0 || entries.some(([, entry]) => entry.status === "warning"))) {
        status = "warning";
      }

      const exceptions = abnormalEntries.map(([taskName, entry]) => {
        const label = taskLabels.get(taskName) || taskName;
        return entry.details.length > 0
          ? `${label}（${entry.details.join("、")}）`
          : label;
      });
      return {
        name: account.name,
        status,
        completedCount,
        totalCount: entries.length,
        exceptions,
        warnings,
        warningCount: warnings.length,
        observations: entries.flatMap(([taskName, entry]) => {
          const label = taskLabels.get(taskName) || taskName;
          const watched = /盐罐|罐子|挂机|加钟|残卷|爬塔|梦境/.test(label);
          const resultLabels = { completed: "完成", skipped: "跳过", warning: "警告/待核验", partial: "部分异常", failed: "失败", stopped: "停止", unavailable: "账号异常" };
          const lines = [...(entry.observations || [])];
          if (watched && ["completed", "skipped"].includes(entry.status)) lines.push(...entry.details);
          return [`${label}：${entry.verificationRequired ? "含待核验" : resultLabels[entry.status] || entry.status}`,
            ...[...new Set(lines)].map(line => `${label}｜${line}`)];
        }),
        unverifiedWarningCount: entries.filter(([, entry]) => entry.status === "warning" && entry.verificationRequired).length,
        taskCounts: entries.reduce((counts, [, entry]) => {
          counts[entry.status] = (counts[entry.status] || 0) + 1;
          return counts;
        }, {}),
        verificationRequired: entries.some(([, entry]) => entry.verificationRequired),
        verificationCount: entries.filter(([, entry]) => entry.verificationRequired).length,
        verificationDetails: [...new Set(entries.flatMap(([taskName, entry]) => {
          const label = taskLabels.get(taskName) || taskName;
          return (entry.verificationDetails || []).map(detail => `${label}（${detail}）`);
        }))],
      };
    });

    // Full diagnostics belong to the page log, independently of PushPlus settings.
    // Preserve all result text before the notification builder makes a short overview.
    if (typeof onLog === "function") {
      onLog({ time: new Date().toLocaleTimeString(), type: "info",
        message: `[定时汇总][${runId}] 版本20261023.4｜${task.name}｜执行端${executionClient}｜顺序：${taskNames.map(name => taskLabels.get(name) || name).join(" → ")}` });
      const labels = { completed: "完成", skipped: "跳过", warning: "警告", partial: "部分异常", failed: "失败", stopped: "停止", unavailable: "账号异常" };
      for (const account of reportAccounts) {
        const details = [...new Set([...account.exceptions, ...account.verificationDetails,
          ...account.warnings, ...account.observations])];
        onLog({ time: new Date().toLocaleTimeString(),
          type: ["partial", "failed", "unavailable"].includes(account.status) ? "error" : account.verificationRequired || account.status === "warning" ? "warning" : "info",
          message: `[汇总][${runId}][${account.name}] ${labels[account.status] || account.status}${account.verificationRequired ? "（含待核验）" : ""}｜完成/跳过${account.completedCount}/${account.totalCount}\n${details.join("\n")}` });
      }
    }
    return buildBatchDailyPushReport({
      taskName: task.name,
      startedAt,
      finishedAt: Date.now(),
      selectedTaskCount: taskNames.length,
      runId, executionClient,
      taskOrder: taskNames.map(name => taskLabels.get(name) || name),
      accounts: reportAccounts,
    });
  };

  const snapshot = () => {
    markPending("warning", "结果待核验：定时任务提前结束，未收到最终结果；不会自动重试");
    return summarizeEntries([...accounts.values()].flatMap((account) =>
      [...account.tasks.entries()].map(([taskName, entry]) => ({ tokenId: account.tokenId, taskName, ...entry })),
    ));
  };

  return {
    snapshot,
    applyTaskResult,
    createStatusRef,
    finalizeTask,
    finish,
    markPending,
    markTask,
  };
};

const createScheduledAdapters = (deps) => createScheduledTaskAdapters({
  deps,
  storage: localStorage,
  locks: globalThis.navigator?.locks,
  openReadOnly: openGenieReadOnly,
  closeReadOnly: closeGenieReadOnly,
  rows: ref([]),
});

const createScopedScheduledTaskFunctions = (scopedTokenStatus, bottleTaskContext) => {
  const deps = createTaskDeps({ tokenStatus: scopedTokenStatus, bottleTaskContext });
  return {
    startBatch: () => startBatch({ tokenStatusRef: scopedTokenStatus, bottleTaskContext }),
    ...createTasksToken(deps),
    ...createTasksHangUp(deps),
    ...createTasksBottle(deps),
    ...createTasksTower(deps),
    ...createTasksItem(deps),
    ...createTasksDungeon(deps),
    ...createTasksArena(deps),
    ...createTasksStore(deps),
    ...createTasksLegacy(deps),
    ...createTasksUpstreamExtras(deps),
    ...createTasksLegionApply(deps),
    ...createTasksCampChallenge(deps),
    ...createScheduledAdapters(deps),
    // Reuse the page instance: preserve stop/unmount/health-check ownership.
    batchSaltOnce: () => batchSaltOnce({ tokenStatusRef: scopedTokenStatus }),
  };
};

// 定时任务函数白名单
// 用显式映射替代 eval，避免任意代码执行风险和构建警告
const resolveScheduledTaskFunction = (taskName, options = {}) => {
  const taskFunctions = options.tokenStatusRef || options.bottleTaskContext
    ? createScopedScheduledTaskFunctions(options.tokenStatusRef || tokenStatus, options.bottleTaskContext)
    : {
        ...createScheduledAdapters(createTaskDeps()),
        startBatch,
        batchRefreshTokens,
        claimHangUpRewards,
        batchAddHangUpTime,
        resetBottles,
        batchlingguanzi,
        climbTower,
        climbWeirdTower,
        batchStudy,
        batchOpenBox,
        batchOpenBoxByPoints,
        batchClaimBoxPointReward,
        batchFish,
        batchRecruit,
        batchRedeemCodes,
        store_syncpurchaseconfig,
        batchmengjing,
        batchclubsign,
        batchApplyLegion,
        batchSaltOnce,
        batchCampChallenge,
        batchCampChallengePet,
        batchCampClaimTasks,
        batcharenafight,
        batchTopUpFish,
        batchTopUpArena,
        batchClaimFreeEnergy,
        skinChallenge,
        legion_storebuygoods,
        store_purchase,
        collection_claimfreereward,
        batchLegacyClaim,
        batchLegacyGiftSendEnhanced,
        batchWeirdTowerIntegrated,
        batchUseItems,
        batchMergeItems,
        batchClaimPeachTasks,
        batchGenieSweep,
        batchBuyDreamItems,
      };

  return Object.prototype.hasOwnProperty.call(taskFunctions, taskName)
    ? taskFunctions[taskName]
    : undefined;
};

// Execute a scheduled task with dependency verification
const executeScheduledTask = async (task, options = {}) => {
  while (isRunning.value || scheduledExecutionActive.value) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  scheduledExecutionActive.value = true;
  shouldStop.value = false;
  try {

  const isScheduledExecution = options.scheduled === true;
  const reportStartedAt = Date.now();
  const reportCollector = isScheduledExecution
    ? createScheduledReportCollector(task, reportStartedAt)
    : null;
  let preemptionLease = null;
  let availableTokens = [];
  const bottleTaskContext = createBottleTaskContext({ dailyGoal: task.selectedTasks?.includes("startBatch") });

  addLog({
    time: new Date().toLocaleTimeString(),
    message: `=== 开始执行定时任务: ${task.name} ===`,
    type: "info",
  });

  try {
    if (!task.selectedTasks?.every(name => name === "batchRefreshTokens"))
      preemptionLease = await acquireTaskPreemption(task, isScheduledExecution);

    // Verify dependencies before executing task
    const dependenciesValid = await verifyTaskDependencies(task);
    if (!dependenciesValid) {
      reportCollector?.markPending("failed", "依赖验证失败");
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `=== 定时任务 ${task.name} 依赖验证失败，取消执行 ===`,
        type: "error",
      });
      return;
    }

    // Filter out tokens that don't exist in current tokens.value
    availableTokens = (
      task.connectedTokens || task.selectedTokens
    ).filter((tokenId) => {
      return tokens.value.some((t) => t.id === tokenId);
    });

    const missingTokens = (task.connectedTokens || task.selectedTokens).filter(
      (tokenId) => {
        return !tokens.value.some((t) => t.id === tokenId);
      },
    );

    if (missingTokens.length > 0) {
      (task.selectedTasks || []).forEach((taskName) => {
        reportCollector?.markTask(
          taskName,
          missingTokens,
          "unavailable",
          "账号不存在",
        );
      });
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `⚠️  跳过不存在的Token: ${missingTokens.join(", ")}`,
        type: "warning",
      });
    }

    if (availableTokens.length === 0) {
      reportCollector?.markPending("unavailable", "没有可用账号");
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `=== 定时任务 ${task.name} 没有可用的Token，取消执行 ===`,
        type: "error",
      });
      return;
    }

    // Always use the latest selectedTokens from the task that exist in current tokens.value
    selectedTokens.value = [...availableTokens];

    // Stop state was reset once at the chain boundary.

    // 所有任务链按顺序执行，避免同一账号的任务互相关闭连接。
    const executeSelectedTask = async (taskName) => {
      const taskLabel =
        availableTasks.find((item) => item.value === taskName)?.label || taskName;
      const skipTask = (reason) => {
        reportCollector?.markTask(
          taskName,
          availableTokens,
          "skipped",
          reason,
        );
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `跳过任务: ${taskLabel} (${reason})`,
          type: "warning",
        });
      };

      if (shouldStop.value) {
        reportCollector?.markTask(
          taskName,
          availableTokens,
          "stopped",
          "执行前已请求停止",
        );
        return;
      }

      try {
        if (options.autoWeekly) {
          if (!isAutoTaskOpen(taskName, Date.now(), task.manualCycleOverride)) {
            skipTask("当前北京时间不在活动开放范围");
            return;
          }
          selectedTokens.value = [...availableTokens];
        }


        if (
          ["batchmengjing", "batchBuyDreamItems"].includes(taskName) &&
          !options.autoWeekly && !ismengjingActivityOpen.value
        ) {
          skipTask("不在梦境开放时间");
          return;
        }

        if (
          ["batchTopUpArena", "batcharenafight"].includes(taskName) &&
          !isarenaActivityOpen.value
        ) {
          skipTask("不在竞技场开放时间");
          return;
        }

        if (
          [
            "climbWeirdTower",
            "batchWeirdTowerIntegrated",
            "batchUseItems",
            "batchMergeItems",
            "batchClaimFreeEnergy",
          ].includes(taskName) &&
          !options.autoWeekly && !isWeirdTowerActivityOpen.value
        ) {
          skipTask("不在怪异塔开放时间");
          return;
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `执行任务: ${taskLabel}`,
          type: "info",
        });

        const scopedTokenStatus = reportCollector?.createStatusRef(taskName);
        const taskFunction = resolveScheduledTaskFunction(taskName, {
          tokenStatusRef: scopedTokenStatus,
          bottleTaskContext,
        });
        if (typeof taskFunction !== "function") {
          reportCollector?.markTask(
            taskName,
            availableTokens,
            "failed",
            "任务函数不存在",
          );
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `任务函数不存在: ${taskName}`,
            type: "error",
          });
          return;
        }

        let taskResult;
        if (
          [
            "batchOpenBox",
            "batchOpenBoxByPoints",
            "batchFish",
            "batchRecruit",
            "batchLegacyGiftSendEnhanced",
          ].includes(taskName)
        ) {
          taskResult = await taskFunction(true);
        } else if (taskName === "batchApplyLegion") {
          taskResult = await taskFunction(task.legionApplyTargetId);
        } else {
          taskResult = await taskFunction();
        }
        reportCollector?.applyTaskResult(taskName, taskResult);
      } catch (error) {
        const reason = error?.message || String(error);
        reportCollector?.finalizeTask(taskName, availableTokens, reason);
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `任务执行失败: ${taskLabel} - ${reason}`,
          type: "error",
        });
      } finally {
        reportCollector?.finalizeTask(taskName, availableTokens);
      }
    };

    // Same account tasks share a socket: finish one task before starting the next.
    for (const name of task.selectedTasks) await executeSelectedTask(name);

    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 定时任务执行完成: ${task.name} ===`,
      type: "success",
    });
  } catch (error) {
    reportCollector?.markPending(
      "failed",
      error?.message || "定时任务执行失败",
    );
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 定时任务执行失败: ${error.message} ===`,
      type: "error",
    });
    console.error(
      `[${new Date().toISOString()}] Error executing scheduled task ${task.name}:`,
      error,
    );
  } finally {
    // 确保日常任务连接完全释放后再允许重建推图 Session。
    for (const tokenId of task.selectedTasks?.every(name => name === "batchRefreshTokens") ? [] : availableTokens) {
      try {
        if (typeof tokenStore.closeWebSocketConnectionAsync === "function") {
          await tokenStore.closeWebSocketConnectionAsync(tokenId);
        } else {
          tokenStore.closeWebSocketConnection(tokenId);
        }
      } catch (error) {
        console.warn(`定时任务清理连接失败 [${tokenId}]`, error);
      }
    }

    if (!isScheduledExecution && preemptionLease) {
      try {
        await releasePreemptionLease(preemptionLease, "manual-task-finished");
      } catch (error) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 手动任务结束后恢复推图失败: ${error.message} ===`,
          type: "error",
        });
      }
    }

    if (reportCollector) {
      options.onResult?.(reportCollector.snapshot());
      try {
        const report = reportCollector.finish({ onLog: addLog });
        enqueuePushPlusNotification({
          ...report,
          dedupeKey: options.autoWeekly ? options.executionKey : `daily:${options.executionKey || `${task.id || task.name}:${reportStartedAt}`}`,
        })
          .then((result) => {
            if (result.status === "accepted") {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== PushPlus 已接收定时任务汇总: ${task.name} ===`,
                type: "success",
              });
            } else if (result.status === "failed") {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== PushPlus 定时任务汇总发送失败: ${result.error} ===`,
                type: "error",
              });
            }
          })
          .catch((error) => {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== PushPlus 定时任务汇总发送失败: ${error?.message || error} ===`,
              type: "error",
            });
          });
      } catch (error) {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 生成或发送 PushPlus 汇总失败: ${error?.message || error} ===`,
          type: "error",
        });
      }
    }
  }
  } finally {
    isRunning.value = false;
    scheduledExecutionActive.value = false;
  }
};

// 注: boxTypeOptions, fishTypeOptions 已从 @/utils/batch 导入

const openHelperModal = (type) => {
  helperType.value = type;
  showHelperModal.value = true;
};

// 批量功法残卷赠送相关方法
const clearRecipientError = () => {
  recipientIdError.value = "";
};

const validateRecipientId = (value) => {
  if (!value || value === "") {
    return true; // 允许为空，由按钮禁用控制
  }
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) {
    recipientIdError.value = "请输入有效的数字ID";
    return false;
  }
  return true;
};

// 头像处理方法
const handleAvatarLoad = () => {
  isAvatarLoading.value = false;
  avatarLoadError.value = false;
};

const handleAvatarError = () => {
  isAvatarLoading.value = false;
  avatarLoadError.value = true;
};

const resetAvatarState = () => {
  isAvatarLoading.value = true;
  avatarLoadError.value = false;
};

const queryRecipientInfo = async () => {
  // 1. 输入验证
  if (!recipientIdInput.value || recipientIdInput.value === "") {
    recipientIdError.value = "请输入接收者ID";
    return;
  }

  const recipientId = Number(recipientIdInput.value);
  if (!Number.isInteger(recipientId) || recipientId <= 0) {
    recipientIdError.value = "请输入有效的数字ID";
    return;
  }

  // 2. 检查选中账号
  if (selectedTokens.value.length === 0) {
    recipientIdError.value = "请先选择要操作的角色";
    return;
  }

  // 3. 初始化状态
  isQueryingRecipient.value = true;
  recipientIdError.value = "";
  recipientInfo.value = null;
  // 重置头像状态
  resetAvatarState();

  const firstTokenId = selectedTokens.value[0];
  const token = tokens.value.find((t) => t.id === firstTokenId);

  // 记录开始查询
  addLog({
    time: new Date().toLocaleTimeString(),
    message: `=== 开始查询接收者信息: 使用账号 ${token.name} (ID: ${firstTokenId}) ===`,
    type: "info",
  });

  try {
    // 确保WebSocket连接
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `正在建立WebSocket连接...`,
      type: "info",
    });

    // 使用现有的ensureConnection函数，它已经包含了重连机制
    await ensureConnection(firstTokenId);

    addLog({
      time: new Date().toLocaleTimeString(),
      message: `WebSocket连接成功`,
      type: "success",
    });

    // 发送查询命令
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `正在发送查询命令，接收者ID: ${recipientId}`,
      type: "info",
    });

    // 延长超时时间到10秒，确保有足够时间处理
    const resp = await tokenStore.sendMessageWithPromise(
      firstTokenId,
      "rank_getroleinfo",
      {
        bottleType: 0,
        includeBottleTeam: false,
        isSearch: false,
        roleId: recipientId,
      },
      10000,
    );

    addLog({
      time: new Date().toLocaleTimeString(),
      message: `查询命令发送成功，正在处理响应...`,
      type: "info",
    });

    // 处理查询结果
    console.log("rank_getroleinfo 响应结果:", resp);

    // 兼容不同的响应结构
    const roleData = resp?.role || resp?.roleInfo;

    if (roleData) {
      // 构建完整的角色信息，移除等级和VIP字段
      recipientInfo.value = {
        roleId: roleData.roleId || roleData.role?.roleId,
        name: roleData.name || roleData.role?.name,
        // 添加头像URL
        avatarUrl:
          resp?.roleInfo?.headImg ||
          roleData?.headImg ||
          roleData?.role?.headImg ||
          "",
        // 战力转换为亿为单位
        power: (function (p) {
          const billion = 100000000;
          return (p / billion).toFixed(2);
        })(roleData.power || roleData.role?.power || 0),
        powerUnit: "亿",
        // 扩展更多角色信息
        serverName: roleData.serverName || roleData.role?.serverName || "",
        legionName: resp?.legionInfo?.name || "",
        legionId: resp?.legionInfo?.id || 0,
      };

      // 格式化角色名，处理特殊字符
      const displayName = recipientInfo.value.name || "未知角色";

      addLog({
        time: new Date().toLocaleTimeString(),
        message: `=== 查询成功: 找到角色 ${displayName} (ID: ${recipientInfo.value.roleId})，战力: ${recipientInfo.value.power}${recipientInfo.value.powerUnit} ===`,
        type: "success",
      });

      message.success("查询成功");
    } else {
      const errorMsg = "未找到该角色信息";
      recipientIdError.value = errorMsg;

      addLog({
        time: new Date().toLocaleTimeString(),
        message: `=== 查询失败: ${errorMsg} ===`,
        type: "error",
      });

      message.error(errorMsg);
    }
  } catch (error) {
    // 详细的错误处理
    console.error("查询接收者信息失败:", error);

    let errorMsg = "查询失败";
    let logType = "error";

    // 根据错误类型提供更友好的错误信息
    if (error.message.includes("连接失败")) {
      errorMsg = "WebSocket连接失败，请检查网络或账号状态";
    } else if (
      error.message.includes("timeout") ||
      error.message.includes("超时")
    ) {
      errorMsg = "查询超时，请稍后重试";
      logType = "warning";
    } else if (error.message.includes("200160")) {
      errorMsg = "功法系统未开启";
    } else {
      errorMsg = `查询失败: ${error.message}`;
    }

    recipientIdError.value = errorMsg;

    // 记录错误日志
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== ${errorMsg} ===`,
      type: logType,
    });

    // 显示用户友好的错误提示
    message.error(errorMsg);
  } finally {
    isQueryingRecipient.value = false;

    // 记录查询完成
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 查询操作完成 ===`,
      type: "info",
    });
  }
};

const confirmLegacyGift = async () => {
  if (!recipientIdInput.value || !recipientInfo.value) {
    message.error("请先查询并确认接收者信息");
    return;
  }

  if (!securityPassword.value) {
    message.error("请输入安全密码");
    return;
  }

  // 调用增强版批量赠送功能
  await batchLegacyGiftSendEnhanced();

  // 关闭模态框
  showLegacyGiftModal.value = false;
  // 清空安全密码
  securityPassword.value = "";
};

const boxPointDraft = ref(normalizeBoxRules());
const boxPriorityOptions = [1, 2, 3, 4].map(value => ({ label: `优先级 ${value}`, value }));
watch(showHelperModal, visible => {
  if (visible && helperType.value === "pointsBox") {
    boxPointDraft.value = normalizeBoxRules(batchSettings.boxPointRules);
    helperSettings.targetPoints = batchSettings.targetBoxPoints;
  }
});
const changeBoxPriority = (id, priority) => {
  const row = boxPointDraft.value.find(r => r.id === id);
  const other = boxPointDraft.value.find(r => r.priority === priority);
  if (other) other.priority = row.priority;
  row.priority = priority;
};
const saveBoxPointConfig = () => {
  const target = Number(helperSettings.targetPoints);
  if (!Number.isSafeInteger(target) || target < 1 || target > 1000000 || !boxPointDraft.value.some(r => r.enabled)) {
    message.warning("目标必须为1至1000000的整数，至少开启一种宝箱"); return false;
  }
  return persistExtras({ targetBoxPoints: target, boxPointRules: normalizeBoxRules(boxPointDraft.value) });
};
const executeHelper = () => {
  if (helperType.value === "pointsBox" && !saveBoxPointConfig()) return;
  if (helperType.value !== "pointsBox") {
    if (helperSettings.count % 10 !== 0 || helperSettings.count < 10) {
      message.warning("消耗数量必须是10的整数倍，最小为10");
      return;
    }
  }
  showHelperModal.value = false;
  if (helperType.value === "box") {
    batchOpenBox();
  } else if (helperType.value === "fish") {
    batchFish();
  } else if (helperType.value === "recruit") {
    batchRecruit();
  } else if (helperType.value === "pointsBox") {
    batchOpenBoxByPoints();
  }
};

// 弹窗使用独立草稿；取消不会改变正在执行或已保存的配置。
const showRedeemCodeModal = ref(false);
const showBlackMarketPurchaseModal = ref(false);
const showFormationDispatchModal = ref(false);
const formationDispatchDraft = ref(createDefaultFormationDispatchConfig());
const redeemDraft = reactive({ codes: "", platform: "h5" });
const blackMarketDraft = ref([]);
const lowMarketDraft = ref(defaultLowMarketLimits());
const blackMarketItemOptions = blackMarketItemCatalog.map(item => ({ label: item.label, value: item.itemId }));
const formationHeroOptions = Object.entries(HERO_DICT)
  .map(([heroId, meta]) => ({
    label: `${meta?.name || `英雄${heroId}`} · ${meta?.type || "未知"} · ID ${heroId}`,
    value: Number(heroId),
  }))
  .sort((left, right) => left.value - right.value);
const persistExtras = (patch) => {
  try {
    localStorage.setItem("batchSettings", JSON.stringify({ ...batchSettings, ...patch }));
    Object.assign(batchSettings, patch);
    message.success("配置已保存");
    return true;
  } catch (error) { message.error(`保存失败：${error.message}`); return false; }
};
const openRedeemCodeModal = () => {
  redeemDraft.codes = batchSettings.cdkCodes;
  redeemDraft.platform = batchSettings.cdkPlatformType;
  showRedeemCodeModal.value = true;
};
const saveRedeemCodeConfig = () => persistExtras({
  cdkCodes: normalizeRedeemCodes(redeemDraft.codes).join("\n"),
  cdkPlatformType: redeemDraft.platform.trim() || "h5",
});
const executeRedeemCodes = async () => {
  if (isRunning.value || !selectedTokens.value.length || !normalizeRedeemCodes(redeemDraft.codes).length) return;
  if (!saveRedeemCodeConfig()) return;
  showRedeemCodeModal.value = false;
  await batchRedeemCodes();
};
const openBlackMarketPurchaseModal = () => {
  blackMarketDraft.value = normalizeBlackMarketPurchaseList(batchSettings.blackMarketPurchaseList);
  lowMarketDraft.value = { ...batchSettings.lowMarketLimits };
  showBlackMarketPurchaseModal.value = true;
};
const saveBlackMarketPurchaseConfig = () => {
  if (blackMarketDraft.value.some(item => !Number.isInteger(item.itemId) || item.itemId < 1 || !Number.isInteger(item.discount) || item.discount < 1 || item.discount > 10)) {
    message.error("请填写有效物品 ID 和 1–10 的整数折扣"); return false;
  }
  if (!validLowMarketLimits(lowMarketDraft.value)) {
    message.error("请为五种商品填写非负整数限价，0 表示不买"); return false;
  }
  return persistExtras({ blackMarketPurchaseList: normalizeBlackMarketPurchaseList(blackMarketDraft.value),
    lowMarketLimits: { ...lowMarketDraft.value } });
};
const executeBlackMarketSync = async () => {
  if (isRunning.value || !selectedTokens.value.length || !blackMarketDraft.value.length) return;
  if (!saveBlackMarketPurchaseConfig()) return;
  showBlackMarketPurchaseModal.value = false;
  await store_syncpurchaseconfig();
};

// FORMATION_DISPATCH_V1
const openFormationDispatchModal = () => {
  formationDispatchDraft.value = normalizeFormationDispatchConfig(
    batchSettings.formationDispatchConfig,
  );
  showFormationDispatchModal.value = true;
};

const saveFormationDispatchConfig = () => {
  const validation = validateFormationDispatchConfig(
    formationDispatchDraft.value,
  );
  if (!validation.valid) {
    message.error(validation.errors.join("；"));
    return false;
  }
  formationDispatchDraft.value = validation.config;
  return persistExtras({ formationDispatchConfig: validation.config });
};

const executeFormationDispatch = async () => {
  if (
    isRunning.value ||
    autoExecutionActive.value ||
    !selectedTokens.value.length
  )
    return;

  if (!saveFormationDispatchConfig()) return;
  const config = normalizeFormationDispatchConfig(formationDispatchDraft.value);
  showFormationDispatchModal.value = false;
  await batchFormationDispatch(config);
};

// 俱乐部申请：目标/账号变化后撤销旧预览，异步旧查询不能重新启用申请按钮。
const showApplyLegionModal = ref(false);
const applyLegionTargetId = ref("");
const applyLegionPreview = ref(null);
const applyLegionError = ref("");
const applyLegionLoading = ref(false);
const allowLegionResubmit = ref(false);
let applyLegionGeneration = 0;
const clearApplyLegionPreview = () => {
  applyLegionGeneration++;
  applyLegionPreview.value = null;
  applyLegionError.value = "";
  allowLegionResubmit.value = false;
};
watch([applyLegionTargetId, () => selectedTokens.value.join("|")], clearApplyLegionPreview, { flush: "sync" });
watch(showApplyLegionModal, show => { if (!show) clearApplyLegionPreview(); }, { flush: "sync" });
const openApplyLegionModal = () => {
  clearApplyLegionPreview();
  showApplyLegionModal.value = true;
};
const fetchApplyLegionTargetInfo = async () => {
  const id = normalizeLegionId(applyLegionTargetId.value);
  const tokenId = selectedTokens.value[0];
  if (!id || !tokenId || isRunning.value) return;
  clearApplyLegionPreview();
  const generation = applyLegionGeneration;
  const isCurrent = () => generation === applyLegionGeneration && showApplyLegionModal.value;
  applyLegionLoading.value = true;
  try {
    const preview = await queryLegionById(tokenId, id, { isCurrent });
    if (isCurrent()) applyLegionPreview.value = preview;
  } catch (error) {
    if (isCurrent()) applyLegionError.value = error.message || "查询失败";
  } finally { applyLegionLoading.value = false; }
};
const handleBatchApplyLegion = async () => {
  const id = normalizeLegionId(applyLegionTargetId.value);
  if (isRunning.value || !selectedTokens.value.length || !id || applyLegionPreview.value?.id !== id) return;
  const allowResubmit = allowLegionResubmit.value;
  showApplyLegionModal.value = false;
  await batchApplyLegion(id, { allowResubmit, manual: true });
};

// Dream Buy Modal Logic
const showDreamBuyModal = ref(false);
const dreamBuyList = ref([]);
const dreamBuyManualEnabled = ref(false);
const dreamBuyBlackMarketEnabled = ref(false);
const dreamBuyModeLabel = computed(() => dreamBuyManualEnabled.value ? "单独勾选" : dreamBuyBlackMarketEnabled.value ? "黑市周" : "按每个账号的主公等级自动识别");

const openDreamBuyModal = () => {
  // Load saved settings
  dreamBuyList.value = Array.isArray(batchSettings.dreamPurchaseList) ? [...batchSettings.dreamPurchaseList] : [];
  dreamBuyManualEnabled.value = batchSettings.dreamPurchaseManualEnabled === true;
  dreamBuyBlackMarketEnabled.value = batchSettings.dreamPurchaseBlackMarketEnabled === true;
  showDreamBuyModal.value = true;
};

const toggleDreamItem = (itemKey, checked) => {
  if (checked) {
    if (!dreamBuyList.value.includes(itemKey)) {
      dreamBuyList.value.push(itemKey);
    }
  } else {
    dreamBuyList.value = dreamBuyList.value.filter((k) => k !== itemKey);
  }
};

const saveDreamBuyConfig = () => {
  if (!persistExtras({
    dreamPurchaseList: [...dreamBuyList.value],
    dreamPurchaseManualEnabled: dreamBuyManualEnabled.value,
    dreamPurchaseBlackMarketEnabled: dreamBuyBlackMarketEnabled.value,
  })) return;
  showDreamBuyModal.value = false;
};

const selectGoldItems = () => {
  const newSelection = new Set(dreamBuyList.value);

  for (const merchantId in goldItemsConfig) {
    const items = goldItemsConfig[merchantId];
    items.forEach((index) => {
      newSelection.add(`${merchantId}-${index}`);
    });
  }

  dreamBuyList.value = Array.from(newSelection);
};

const selectAllItems = () => {
  const newSelection = new Set(dreamBuyList.value);

  for (const merchantId in merchantConfig) {
    const items = merchantConfig[merchantId].items;
    items.forEach((_, index) => {
      newSelection.add(`${merchantId}-${index}`);
    });
  }

  dreamBuyList.value = Array.from(newSelection);
};

const clearAllItems = () => {
  dreamBuyList.value = [];
};

// 注: formationOptions, bossTimesOptions 已从 @/utils/batch 导入

const loadSettings = (tokenId) => {
  try {
    const raw = localStorage.getItem(`daily-settings:${tokenId}`);
    const defaultSettings = {
      arenaFormation: 1,
      towerFormation: 1,
      bossFormation: 1,
      bossTimes: 2,
      claimBottle: true,
      payRecruit: true,
      openBox: true,
      arenaEnable: true,
      claimHangUp: true,
      claimEmail: true,
      blackMarketPurchase: true,
    };
    return raw ? { ...defaultSettings, ...JSON.parse(raw) } : defaultSettings;
  } catch (error) {
    console.error("Failed to load settings:", error);
    return null;
  }
};

const openSettings = (token) => {
  currentSettingsTokenId.value = token.id;
  currentSettingsTokenName.value = token.name;
  const saved = loadSettings(token.id);
  Object.assign(currentSettings, saved);
  showSettingsModal.value = true;
};

const saveSettings = () => {
  if (currentSettingsTokenId.value) {
    localStorage.setItem(
      `daily-settings:${currentSettingsTokenId.value}`,
      JSON.stringify(currentSettings),
    );
    message.success(`已保存 ${currentSettingsTokenName.value} 的设置`);
    showSettingsModal.value = false;
  }
};

// Task Template Functions
const openTaskTemplateModal = () => {
  // 加载模板列表
  loadTaskTemplates();
  // 重置当前模板
  Object.assign(currentTemplate, {
    arenaFormation: 1,
    towerFormation: 1,
    bossFormation: 1,
    bossTimes: 2,
    claimBottle: true,
    payRecruit: true,
    openBox: true,
    arenaEnable: true,
    claimHangUp: true,
    claimEmail: true,
    blackMarketPurchase: true,
  });
  currentTemplateName.value = "";
  showTaskTemplateModal.value = true;
};

const loadTaskTemplates = () => {
  const templates = localStorage.getItem("task-templates");
  const parsed = templates ? JSON.parse(templates) : [];
  taskTemplates.value = parsed;
  return parsed;
};

const openApplyTemplateModal = () => {
  // 加载模板列表
  loadTaskTemplates();
  // 重置选择
  selectedTemplateId.value = null;
  selectedTokensForApply.value = [];
  showApplyTemplateModal.value = true;
};

const handleSelectAllForApply = (checked) => {
  if (checked) {
    selectedTokensForApply.value = sortedTokens.value.map((token) => token.id);
  } else {
    selectedTokensForApply.value = [];
  }
};

const applyTemplate = () => {
  if (!selectedTemplateId.value || selectedTokensForApply.value.length === 0) {
    message.error("请选择模板和要应用的账号");
    return;
  }

  // 找到选中的模板
  const templates = loadTaskTemplates();
  const template = templates.find((t) => t.id === selectedTemplateId.value);
  if (!template) {
    message.error("模板不存在");
    return;
  }

  // 应用模板到选中的账号
  let successCount = 0;
  selectedTokensForApply.value.forEach((tokenId) => {
    // 保存账号设置时同时保存模板ID
    const accountSettings = {
      ...template.settings,
      templateId: template.id, // 记录模板ID
    };
    localStorage.setItem(
      `daily-settings:${tokenId}`,
      JSON.stringify(accountSettings),
    );
    successCount++;
  });

  message.success(`已成功应用模板到 ${successCount} 个账号`);
  showApplyTemplateModal.value = false;
};

// Template Manager Functions
const openTemplateManagerModal = () => {
  // 加载模板列表
  loadTaskTemplates();
  showTemplateManagerModal.value = true;
};

const openEditTemplateModal = (template) => {
  // 加载模板数据到当前编辑模板
  currentTemplateId.value = template.id;
  currentTemplateName.value = template.name;
  Object.assign(currentTemplate, template.settings);
  showTaskTemplateModal.value = true;
};

const updateTaskTemplate = () => {
  if (!currentTemplateName.value.trim()) {
    message.error("请输入模板名称");
    return;
  }

  // 找到并更新模板
  const templates = loadTaskTemplates();
  const templateIndex = templates.findIndex(
    (t) => t.id === currentTemplateId.value,
  );
  if (templateIndex === -1) {
    message.error("模板不存在");
    return;
  }

  // 更新模板
  templates[templateIndex] = {
    ...templates[templateIndex],
    name: currentTemplateName.value.trim(),
    settings: {
      ...currentTemplate,
    },
    updatedAt: new Date().toISOString(),
  };

  // 保存模板到localStorage
  localStorage.setItem("task-templates", JSON.stringify(templates));

  // 更新模板列表
  taskTemplates.value = templates;

  message.success(`已更新模板 "${templates[templateIndex].name}"`);
  showTaskTemplateModal.value = false;

  // 重置编辑状态
  resetTemplateForm();
};

const deleteTaskTemplate = (templateId) => {
  // 确认删除
  if (confirm("确定要删除这个模板吗？")) {
    // 找到并删除模板
    const templates = loadTaskTemplates();
    const filteredTemplates = templates.filter((t) => t.id !== templateId);

    // 保存模板到localStorage
    localStorage.setItem("task-templates", JSON.stringify(filteredTemplates));

    // 更新模板列表
    taskTemplates.value = filteredTemplates;

    message.success("模板已删除");
  }
};

const resetTemplateForm = () => {
  currentTemplateId.value = null;
  currentTemplateName.value = "";
  Object.assign(currentTemplate, {
    arenaFormation: 1,
    towerFormation: 1,
    bossFormation: 1,
    bossTimes: 2,
    claimBottle: true,
    payRecruit: true,
    openBox: true,
    arenaEnable: true,
    claimHangUp: true,
    claimEmail: true,
    blackMarketPurchase: true,
  });
};

const openAccountTemplateModal = () => {
  // 加载账号模板引用关系
  loadAccountTemplateReferences();
  showAccountTemplateModal.value = true;
};

const loadAccountTemplateReferences = () => {
  const templates = loadTaskTemplates();
  const references = [];

  // 遍历所有账号，获取其模板引用
  sortedTokens.value.forEach((token) => {
    const settingsStr = localStorage.getItem(`daily-settings:${token.id}`);
    if (settingsStr) {
      try {
        const settings = JSON.parse(settingsStr);
        const templateId = settings.templateId;
        const template = templates.find((t) => t.id === templateId);

        references.push({
          tokenId: token.id,
          tokenName: token.name,
          templateId: templateId,
          templateName: template ? template.name : "未引用模板",
        });
      } catch (e) {
        console.error(`解析账号 ${token.name} 的设置失败:`, e);
      }
    } else {
      // 没有设置的账号
      references.push({
        tokenId: token.id,
        tokenName: token.name,
        templateId: null,
        templateName: "未引用模板",
      });
    }
  });

  accountTemplateReferences.value = references;
  filteredAccountTemplates.value = references;
};

const filterAccountTemplates = () => {
  if (!selectedTemplateForFilter.value) {
    filteredAccountTemplates.value = accountTemplateReferences.value;
  } else {
    filteredAccountTemplates.value = accountTemplateReferences.value.filter(
      (item) => item.templateId === selectedTemplateForFilter.value,
    );
  }
};

const openNewTemplateModal = () => {
  // 重置表单，准备创建新模板
  resetTemplateForm();
  showTaskTemplateModal.value = true;
};

// 修改saveTaskTemplate函数，支持新增和编辑
const saveTaskTemplate = () => {
  if (!currentTemplateName.value.trim()) {
    message.error("请输入模板名称");
    return;
  }

  const templates = loadTaskTemplates();

  if (currentTemplateId.value) {
    // 更新现有模板
    updateTaskTemplate();
  } else {
    // 创建新模板
    const template = {
      id: Date.now().toString(),
      name: currentTemplateName.value.trim(),
      settings: {
        ...currentTemplate,
      },
      createdAt: new Date().toISOString(),
    };

    // 添加新模板
    templates.push(template);
    localStorage.setItem("task-templates", JSON.stringify(templates));

    // 更新模板列表
    taskTemplates.value = templates;

    message.success(`已保存模板 "${template.name}"`);
    showTaskTemplateModal.value = false;

    // 重置表单
    resetTemplateForm();
  }
};

const currentRunningTokenId = ref(null);
const currentProgress = ref(0);
const logs = ref([]);
const logContainer = ref(null);
const autoScrollLog = ref(true);
const filterErrorsOnly = ref(false);
const errorCount = computed(() => {
  return logs.value.filter((log) => log.type === "error").length;
});

const filteredLogs = computed(() => {
  if (filterErrorsOnly.value) {
    return logs.value.filter((log) => log.type === "error");
  }
  return logs.value;
});

const currentRunningTokenName = computed(() => {
  const t = tokens.value.find((x) => x.id === currentRunningTokenId.value);
  return t ? t.name : "";
});

const scrollLogToBottom = async () => {
  if (!autoScrollLog.value) return;
  await nextTick();

  const scroll = () => {
    try {
      const element = logContainer.value;
      if (element && autoScrollLog.value) {
        element.scrollTop = element.scrollHeight;
      }
    } catch (error) {
      console.warn("Failed to scroll log container:", error);
    }
  };

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(scroll);
  } else {
    scroll();
  }
};

// Selection logic
const isAllSelected = computed(
  () =>
    selectedTokens.value.length === tokens.value.length &&
    tokens.value.length > 0,
);
const isIndeterminate = computed(
  () =>
    selectedTokens.value.length > 0 &&
    selectedTokens.value.length < tokens.value.length,
);

const handleSelectAll = (checked) => {
  if (checked) {
    selectedTokens.value = tokens.value.map((t) => t.id);
  } else {
    selectedTokens.value = [];
  }
};

const getStatusType = (tokenId) => {
  const status = tokenStatus.value[tokenId];
  if (status === "completed") return "success";
  if (status === "warning") return "warning";
  if (status === "failed") return "error";
  if (status === "partial" || status === "stopped") return "warning";
  if (status === "skipped") return "default";
  if (status === "unavailable") return "error";
  if (status === "running") return "info";
  return "default";
};

const getStatusText = (tokenId) => {
  const status = tokenStatus.value[tokenId];
  if (status === "completed") return "已完成";
  if (status === "warning") return "有警告";
  if (status === "failed") return "失败";
  if (status === "partial") return "部分异常";
  if (status === "skipped") return "已跳过";
  if (status === "stopped") return "已停止";
  if (status === "unavailable") return "不可用";
  if (status === "running") return "执行中";
  return "等待中";
};

// =====================
// Token分组管理相关方法
// =====================

/**
 * 创建新分组
 */
const createNewGroup = () => {
  if (!newGroupName.value.trim()) {
    message.warning("请输入分组名称");
    return;
  }

  const newGroup = tokenStore.createTokenGroup(
    newGroupName.value.trim(),
    newGroupColor.value,
  );

  // 添加选中的Token到新分组
  if (newGroupSelectedTokens.value.length > 0) {
    newGroupSelectedTokens.value.forEach((tokenId) => {
      tokenStore.addTokenToGroup(newGroup.id, tokenId);
    });
  }

  message.success("分组创建成功");
  newGroupName.value = "";
  newGroupColor.value = "#1677ff";
  newGroupSelectedTokens.value = [];
};

const selectAllNewGroup = () => {
  newGroupSelectedTokens.value = sortedTokens.value.map((t) => t.id);
};

const deselectAllNewGroup = () => {
  newGroupSelectedTokens.value = [];
};

/**
 * 删除分组
 */
const deleteGroup = (groupId) => {
  if (confirm("确定要删除这个分组吗？分组中的token不会被删除。")) {
    tokenStore.deleteTokenGroup(groupId);
    message.success("分组已删除");
  }
};

/**
 * 保存编辑的分组
 */
const saveEditGroup = () => {
  if (!editingGroupId.value) return;

  if (!editingGroupName.value.trim()) {
    message.warning("请输入分组名称");
    return;
  }

  tokenStore.updateTokenGroup(editingGroupId.value, {
    name: editingGroupName.value.trim(),
    color: editingGroupColor.value,
  });

  message.success("分组已更新");
  editingGroupId.value = null;
  editingGroupName.value = "";
  editingGroupColor.value = "";
};

/**
 * 开始编辑分组
 */
const startEditGroup = (groupId) => {
  const group = tokenGroups.value.find((g) => g.id === groupId);
  if (group) {
    editingGroupId.value = groupId;
    editingGroupName.value = group.name;
    editingGroupColor.value = group.color;
  }
};

/**
 * 取消编辑分组
 */
const cancelEditGroup = () => {
  editingGroupId.value = null;
  editingGroupName.value = "";
  editingGroupColor.value = "";
};

/**
 * 切换分组选择状态
 */
const toggleGroupSelection = (groupId) => {
  const index = selectedGroups.value.indexOf(groupId);
  if (index > -1) {
    selectedGroups.value.splice(index, 1);
  } else {
    selectedGroups.value.push(groupId);
  }

  // 更新selectedTokens
  updateSelectedTokensFromGroups();
};

/**
 * 判断分组是否被选中
 */
const isGroupSelected = (groupId) => {
  return selectedGroups.value.includes(groupId);
};

/**
 * 根据选中的分组更新selectedTokens
 */
const updateSelectedTokensFromGroups = () => {
  const tokenIds = new Set();

  selectedGroups.value.forEach((groupId) => {
    const validTokenIds = tokenStore.getValidGroupTokenIds(groupId);
    validTokenIds.forEach((id) => tokenIds.add(id));
  });

  selectedTokens.value = Array.from(tokenIds);
};

/**
 * 一键清除所有分组选择
 */
const clearAllGroupSelection = () => {
  selectedGroups.value = [];
  selectedTokens.value = [];
};

/**
 * 添加token到分组
 */
const addTokenToSelectedGroup = (groupId, tokenId) => {
  tokenStore.addTokenToGroup(groupId, tokenId);
  message.success("已将token添加到分组");
};

/**
 * 从分组移除token
 */
const removeTokenFromSelectedGroup = (groupId, tokenId) => {
  tokenStore.removeTokenFromGroup(groupId, tokenId);
  message.success("已将token从分组移除");
};

/**
 * 获取分组中有效的token ID列表（用于模板中展示）
 */
const getValidGroupTokenIds = (groupId) => {
  return tokenStore.getValidGroupTokenIds(groupId);
};

/**
 * 获取分组中的token列表
 */
const getGroupTokenList = (groupId) => {
  const tokenIds = tokenStore.getValidGroupTokenIds(groupId);
  return tokens.value.filter((t) => tokenIds.includes(t.id));
};

// 注: pickArenaTargetId, FISH_TARGET, ARENA_TARGET, getTodayStartSec, isTodayAvailable, calculateMonthProgress 已从 @/utils/batch 导入

const addLog = (log) => {
  // 添加日志数据到数组
  logs.value.push(log);

  // 限制logs数组大小，防止内存占用过大
  const maxLogEntries = batchSettings.maxLogEntries || 1000;
  if (logs.value.length > maxLogEntries) {
    logs.value = logs.value.slice(-maxLogEntries);
  }

  scrollLogToBottom();
};

watch(autoScrollLog, (newValue) => {
  if (newValue) scrollLogToBottom();
});

const copyLogs = () => {
  if (logs.value.length === 0) {
    message.warning("没有可复制的日志");
    return;
  }
  const logText = logs.value
    .map((log) => `${log.time} ${log.message}`)
    .join("\n");
  navigator.clipboard
    .writeText(logText)
    .then(() => {
      message.success("日志已复制到剪贴板");
    })
    .catch((err) => {
      message.error("复制日志失败: " + err.message);
    });
};

const clearLogs = () => {
  logs.value = [];
  message.success("日志已清空");
};

// BATCH_RUNTIME_FIX_20261015: ownership and cancellation at connection boundaries.
const connectionQueue = createConnectionSlots();
const connectionAttempts = new Map();
const throwIfBatchStopped = () => {
  if (shouldStop.value) throw Object.assign(new Error("用户已停止，未建立后续连接"), { stopped: true });
};
const releaseConnectionSlot = (tokenId) => connectionQueue.release(tokenId);
const waitForConnection = async (tokenId, timeout = batchSettings.connectionTimeout) => {
  const end = Date.now() + Math.max(1, Number(timeout) || 10000);
  while (Date.now() < end) {
    throwIfBatchStopped();
    if (tokenStore.getWebSocketStatus(tokenId) === "connected") return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
};
const ensureConnection = (tokenId, maxRetries = 2) => {
  if (connectionAttempts.has(tokenId)) return connectionAttempts.get(tokenId);
  const attempt = (async () => {
    let owned = false;
    try {
      throwIfBatchStopped();
      if (!tokens.value.some((token) => token.id === tokenId)) throw new Error(`账号不存在: ${tokenId}`);
      if (tokenStore.getWebSocketStatus(tokenId) !== "connected") {
        while (connectionQueue.active >= Math.max(1, Number(batchSettings.maxActive) || 1)) {
          throwIfBatchStopped();
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throwIfBatchStopped();
        if (!connectionQueue.reserve(tokenId)) throw new Error(`账号连接名额已占用: ${tokenId}`);
        owned = true;
        let connected = false;
        // Preserve existing behavior: one bounded reconnect, no business-command replay.
        for (let index = 0; index < (maxRetries > 0 ? 2 : 1); index++) {
          throwIfBatchStopped();
          const token = tokens.value.find((item) => item.id === tokenId);
          if (!token) throw new Error(`账号已移除: ${tokenId}`);
          addLog({ time: new Date().toLocaleTimeString(), type: "info",
            message: `[连接][${token.name || tokenId}] ${index ? "正在重连" : "正在连接"}... (队列: ${connectionQueue.active}/${batchSettings.maxActive})` });
          tokenStore.createWebSocketConnection(tokenId, token.token, token.wsUrl);
          connected = await waitForConnection(tokenId);
          if (connected) break;
          const close = tokenStore.closeWebSocketConnectionAsync || tokenStore.closeWebSocketConnection;
          await close.call(tokenStore, tokenId);
          if (index === 0 && maxRetries > 0) {
            const end = Date.now() + Math.max(0, Number(batchSettings.reconnectDelay) || 0);
            while (Date.now() < end) {
              throwIfBatchStopped();
              await new Promise((resolve) => setTimeout(resolve, Math.min(200, end - Date.now())));
            }
          }
        }
        if (!connected) throw new Error("连接失败 (重试后仍超时)");
      }
      throwIfBatchStopped();
      let initializationCommand = "role_getroleinfo";
      try {
        await tokenStore.sendMessageWithPromise(tokenId, initializationCommand, {}, 5000);
        throwIfBatchStopped();
        initializationCommand = "fight_startlevel";
        const response = await tokenStore.sendMessageWithPromise(tokenId, initializationCommand, {}, 5000);
        if (response?.battleData?.version) tokenStore.setBattleVersion(response.battleData.version);
      } catch (error) {
        if (error?.stopped) throw error;
        addLog({ time: new Date().toLocaleTimeString(), type: "warning", message: `[连接][${tokens.value.find(item => item.id === tokenId)?.name || tokenId}] 初始化数据失败：阶段=连接初始化；命令=${initializationCommand}；${error.message}` });
      }
      throwIfBatchStopped();
      return true;
    } catch (error) {
      if (owned) {
        try {
          const close = tokenStore.closeWebSocketConnectionAsync || tokenStore.closeWebSocketConnection;
          await close.call(tokenStore, tokenId);
        } finally { releaseConnectionSlot(tokenId); }
      }
      throw error;
    }
  })();
  connectionAttempts.set(tokenId, attempt);
  attempt.finally(() => connectionAttempts.delete(tokenId)).catch(() => {});
  return attempt;
};

const createTaskDeps = (overrides = {}) => ({
  selectedTokens,
  tokens,
  tokenStatus,
  isRunning,
  shouldStop: {
    get value() { return shouldStop.value; },
    set value(value) { if (value || !scheduledExecutionActive.value) shouldStop.value = value; },
  },
  ensureConnection,
  releaseConnectionSlot,
  connectionQueue,
  batchSettings,
  tokenStore,
  addLog,
  message,
  currentRunningTokenId,
  // 延迟配置
  delayConfig: {
    command: batchSettings.commandDelay,
    task: batchSettings.taskDelay,
    action: batchSettings.actionDelay,
    battle: batchSettings.battleDelay,
    refresh: batchSettings.refreshDelay,
    long: batchSettings.longDelay,
  },
  // 其他特定依赖
  logs,
  logContainer,
  autoScrollLog,
  nextTick,
  // 设置相关
  currentSettings,
  helperSettings,
  weirdTowerMaxClimb,
  // 功法赠送相关
  recipientIdInput,
  recipientInfo,
  securityPassword,
  giftQuantity,
  // 竞技场相关辅助函数
  pickArenaTargetId,
  getTodayStartSec,
  isTodayAvailable,
  calculateMonthProgress,
  // 配置加载函数
  loadSettings,
  ...overrides,
});

const { batchRedeemCodes, store_syncpurchaseconfig } = createTasksUpstreamExtras(createTaskDeps());

const { queryLegionById, batchApplyLegion } = createTasksLegionApply(createTaskDeps());
const { batchCampChallenge, batchCampChallengePet, batchCampClaimTasks } = createTasksCampChallenge(createTaskDeps());
const { batchSaltOnce, stopSaltOnce, isSaltOnceRunning } = createTasksSaltOnce({ ...createTaskDeps(), saltOnceRows });
const { batchFormationDispatch } = createTasksFormationDispatch(createTaskDeps());

// Manual four-nation plan; preflight runs after the single Start action.
const showGenieChallenge = ref(false);
const genieConfig = ref({ attemptsByNation: { ...DEFAULT_GENIE_ATTEMPTS }, stopOnLoss: false, allowInitialProbe: true, useTechnology: true, upgradeEmptyTechnology: false });
const genieRows = ref([]);
const genieCanStart = computed(() => {
  if (!selectedTokens.value.length) return false;
  try { normalizeGeniePlan(genieConfig.value); return true; } catch { return false; }
});
const closeGenieReadOnly = async (id) => {
  const client = tokenStore.getWebSocketClient(id);
  // Drop a timed-out queued challenge before closing; never replay on reconnect.
  if (client) { client.sendQueue = []; client.autoReconnectEnabled = false; }
  try { await tokenStore.closeWebSocketConnectionAsync(id); }
  finally { releaseConnectionSlot(id); }
};
const openGenieReadOnly = async (id, stopped) => {
  if (stopped()) throw new Error("stopped");
  if (tokenStore.getWebSocketStatus(id) === "connected") {
    const existing = tokenStore.getWebSocketClient(id);
    if (existing) existing.autoReconnectEnabled = false;
    return;
  }
  while (connectionQueue.active >= Math.max(1, Number(batchSettings.maxActive) || 1)) {
    if (stopped()) throw new Error("stopped");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!connectionQueue.reserve(id)) throw new Error("connection busy");
  try {
    const token = tokens.value.find(t => t.id === id);
    if (!token) throw new Error("missing account");
    await tokenStore.createWebSocketConnection(id, token.token, token.wsUrl);
    const client = tokenStore.getWebSocketClient(id);
    if (client) client.autoReconnectEnabled = false;
    const end = Date.now() + Math.max(1000, Number(batchSettings.connectionTimeout) || 10000);
    while (tokenStore.getWebSocketStatus(id) !== "connected") {
      if (stopped() || Date.now() >= end) throw new Error("connection stopped or timed out");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) { await closeGenieReadOnly(id); throw error; }
};
const { batchGenieChallenge, stopGenieChallenge } = createTasksGenieChallenge({
  ...createTaskDeps(), rows: genieRows, ledger: createGenieLedger(localStorage), technologyLedger: createTechnologyLedger(localStorage),
  isBusy: () => isRunning.value || autoExecutionActive.value || scheduledExecutionActive.value,
  openReadOnly: openGenieReadOnly, closeReadOnly: closeGenieReadOnly,
  acquireLease: () => acquireTaskPreemption({ name: "普通灯神挑战" }, false),
  releaseLease: lease => releasePreemptionLease(lease, "genie-finished"),
});
const handleGenieStart = async () => {
  if (!genieCanStart.value || isRunning.value || autoExecutionActive.value || scheduledExecutionActive.value) return;
  try { await withGenieLock(navigator.locks, () => batchGenieChallenge(JSON.parse(JSON.stringify(genieConfig.value)))); }
  catch { message.error("灯神任务未完成，请核验状态"); }
};



// Independent manual weekly shop; does not change daily/weekly automatic chains.
const handlePhoenixPrayer = async () => {
  try {
    await batchPhoenixPrayer({
      ...createTaskDeps(),
      isBusy: () => isRunning.value || autoExecutionActive.value || scheduledExecutionActive.value,
      openReadOnly: openGenieReadOnly, closeReadOnly: closeGenieReadOnly,
      acquireLease: () => acquireTaskPreemption({ name: "凤仪祈愿" }, false),
      releaseLease: lease => releasePreemptionLease(lease, "phoenix-finished"),

    });
  } catch (error) { message.error(error?.message || "凤仪祈愿执行异常"); }
};

const showJianghuMarket = ref(false), jianghuRows = ref([]);
const jianghuList = ref((() => { try { const saved=JSON.parse(localStorage.getItem('xyzw_jianghu_list_v1')||'[]'); return saved.length ? normalizeMarketList(saved) : []; } catch { return []; } })());
const saveJianghuList = () => {
  try { const list=jianghuList.value.length ? normalizeMarketList(jianghuList.value) : []; localStorage.setItem('xyzw_jianghu_list_v1',JSON.stringify(list));message.success('江湖黑市清单已保存，未执行购买');return true; }
  catch { message.error('清单保存失败');return false; }
};
const {batchJianghuMarket,stopJianghuMarket}=createTasksJianghuMarket({
 ...createTaskDeps(),rows:jianghuRows,ledger:createMarketLedger(localStorage),
 isBusy:()=>isRunning.value||autoExecutionActive.value||scheduledExecutionActive.value,
 openReadOnly:openGenieReadOnly,closeReadOnly:closeGenieReadOnly,
 acquireLease:()=>acquireTaskPreemption({name:'一键江湖黑市'},false),
 releaseLease:lease=>releasePreemptionLease(lease,'jianghu-finished'),
});
const handleJianghuStart=async()=>{
 if(isRunning.value||autoExecutionActive.value||scheduledExecutionActive.value||!selectedTokens.value.length)return;
 if(!saveJianghuList())return;
 if(!navigator.locks?.request){message.error('浏览器不支持跨标签互斥，未执行购买');return;}
 try{await navigator.locks.request('xyzw-jianghu-market-v1',{ifAvailable:true},async lock=>{
  if(!lock){message.warning('其他标签页正在执行江湖黑市');return;}
  await batchJianghuMarket(JSON.parse(JSON.stringify(jianghuList.value)));
 });}catch{message.error('江湖黑市执行异常，请核对日志');}
};

// 篝火报名独立手动入口，复用现有连接清理和任务互斥。
const { batchBonfireSignup } = createTasksBonfire({
  ...createTaskDeps(), storage: localStorage,
  isBusy: () => isRunning.value || autoExecutionActive.value || scheduledExecutionActive.value,
  openReadOnly: openGenieReadOnly, closeReadOnly: closeGenieReadOnly,
  acquireLease: () => acquireTaskPreemption({ name: "篝火报名" }, false),
  releaseLease: lease => releasePreemptionLease(lease, "bonfire-finished"),
});
const handleBonfireSignup = async () => {
  if (isRunning.value || autoExecutionActive.value || scheduledExecutionActive.value || !selectedTokens.value.length) return;
  if (!navigator.locks?.request) { message.error("浏览器不支持跨标签互斥，未提交报名"); return; }
  try {
    await navigator.locks.request("xyzw-bonfire-signup-v1", { ifAvailable: true }, async lock => {
      if (!lock) { message.warning("其他标签页正在执行篝火报名"); return; }
      await batchBonfireSignup();
    });
  } catch { message.error("篝火报名未完成，请查看日志"); }
};

// 初始化任务模块
const { batchRefreshTokens } = createTasksToken(createTaskDeps());
const handleRefreshTokens = async () => {
  if (isRunning.value || autoExecutionActive.value || scheduledExecutionActive.value || !selectedTokens.value.length) return;
  // Reset at the manual entry only; scheduled chains keep their existing stop state.
  shouldStop.value = false;
  return batchRefreshTokens();
};
const tasksHangUp = createTasksHangUp(createTaskDeps());
const {
  claimHangUpRewards,
  batchAddHangUpTime,
  batchStudy,
  batchclubsign,
  batchWarGuessCheer,
} = tasksHangUp;

const tasksBottle = createTasksBottle(createTaskDeps());
const { resetBottles, batchlingguanzi } = tasksBottle;

const tasksTower = createTasksTower(createTaskDeps());
const {
  climbTower,
  climbWeirdTower,
  batchClaimFreeEnergy,
  skinChallenge,
  batchUseItems,
  batchMergeItems,
  batchWeirdTowerIntegrated,
} = tasksTower;

const tasksItem = createTasksItem(createTaskDeps());
const {
  batchOpenBox,
  batchOpenBoxByPoints,
  batchClaimBoxPointReward,
  batchFish,
  batchRecruit,
  batchHeroUpgrade,
  batchBookUpgrade,
  batchClaimStarRewards,
  batchClaimPeachTasks,
  batchGenieSweep,
} = tasksItem;

const tasksDungeon = createTasksDungeon(createTaskDeps());
const { batchmengjing, batchBuyDreamItems } =
  tasksDungeon;

const tasksArena = createTasksArena(createTaskDeps());
const { batcharenafight, batchTopUpFish, batchTopUpArena } = tasksArena;

const tasksStore = createTasksStore(createTaskDeps());
const {
  legion_storebuygoods,
  legionStoreBuySkinCoins,
  store_purchase,
  collection_claimfreereward,
} = tasksStore;

const tasksLegacy = createTasksLegacy(createTaskDeps());
const { batchLegacyClaim, batchLegacyGiftSendEnhanced } = tasksLegacy;

const tasksFootball = createTasksFootball(createTaskDeps());
const { batchFootballBet } = tasksFootball;

const tasksApex = createTasksApex(createTaskDeps());
const { batchApexGuess } = tasksApex;

// 逐鹿盐山竞猜配置：默认自动识别；手动ID开关默认关闭
const showApexGuessModal = ref(false);
const apexScheduleId = ref(null);
const apexUseManualScheduleId = ref(false);
const handleApexGuessStart = async () => {
  if (isRunning.value || autoExecutionActive.value || scheduledExecutionActive.value || !selectedTokens.value.length) return;
  if (apexUseManualScheduleId.value && apexScheduleId.value == null) return;
  if (!navigator.locks?.request) { message.error("浏览器不支持跨标签互斥，逐鹿盐山竞猜未执行"); return; }
  showApexGuessModal.value = false;
  try {
    return await navigator.locks.request("xyzw-apex-guess-v1", { ifAvailable: true }, async lock => {
      if (!lock) { message.warning("其他标签页正在执行逐鹿盐山竞猜"); return; }
      return batchApexGuess({
        useManualScheduleId: apexUseManualScheduleId.value,
        manualScheduleId: apexScheduleId.value,
      });
    });
  } catch (error) { message.error(error?.message || "逐鹿盐山竞猜执行异常，请核对日志"); }
};

// 盐杯竞猜 pick 选择
const footballPick = ref(3);
const footballPickOptions = [
  { label: "主胜", value: 1 },
  { label: "平局", value: 2 },
  { label: "客胜", value: 3 },
];
const footballPickLabel = computed(() => {
  return footballPickOptions.find((o) => o.value === footballPick.value)?.label || "";
});
const onFootballPickChange = async (val) => {
  footballPick.value = val;
  await batchFootballBet(val);
};

const startBatch = async (options = {}) => {
  if (selectedTokens.value.length === 0) return [];

  const statusRef = options.tokenStatusRef || tokenStatus;
  const bottleTaskContext = options.bottleTaskContext || createBottleTaskContext({ dailyGoal: true });
  const selectedTokenIds = [...selectedTokens.value];

  isRunning.value = true;
  if (!scheduledExecutionActive.value) shouldStop.value = false;
  // 不再重置logs数组，保留之前的日志
  // logs.value = [];

  // Reset status
  selectedTokenIds.forEach((id) => {
    statusRef.value[id] = "waiting";
  });

  // 并行执行任务，但通过connectionQueue限制并发连接数
  const taskPromises = selectedTokenIds.map(async (tokenId) => {
    const token = tokens.value.find((item) => item.id === tokenId);
    const tokenName = token?.name || tokenId;
    if (shouldStop.value) {
      statusRef.value[tokenId] = "stopped";
      return {
        tokenId,
        name: tokenName,
        status: "stopped",
        exceptions: ["执行前已请求停止"],
      };
    }

    statusRef.value[tokenId] = "running";

    const accountStartedAt = Date.now();
    let retryCount = 0;
    const MAX_RETRIES = 1;
    let success = false;
    let accountStatus = "failed";
    let exceptions = [];
    let warnings = [];
    let executionFinished = false;
    let observations = [];
    let queueMs = 0, activeStartedAt = null;
    let runCounts = { completedCount: 0, warningCount: 0, failedCount: 0, verificationCount: 0, unexecutedCount: null };

    while (retryCount <= MAX_RETRIES && !success) {
      if (shouldStop.value) break;

      try {
        if (retryCount === 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `[日常][${tokenName}] 开始`,
            type: "info",
          });
        } else {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== 尝试重试: ${tokenName} (第${retryCount}次) ===`,
            type: "info",
          });
        }

        await ensureConnection(tokenId);
        activeStartedAt = Date.now();
        queueMs = activeStartedAt - accountStartedAt;

        // Create runner with delay settings
        const runner = new DailyTaskRunner(tokenStore, {
          commandDelay: batchSettings.commandDelay,
          taskDelay: batchSettings.taskDelay,
        }, { classifyError: classifyBatchDailyError, bottleTaskContext, productionLogs: true, verboseLogs: true });

        // Run tasks
        const runResult = await runner.run(tokenId, {
          shouldStop: () => shouldStop.value,
          onLog: (log) => addLog(log),
          onProgress: (p) => {
            // 每个token维护自己的进度
          },
        });

        success = true;
        exceptions = (runResult?.failedTasks || []).map((taskResult) =>
          taskResult.error
            ? `${taskResult.name}：${taskResult.error}`
            : taskResult.name,
        );
        warnings = (runResult?.warningTasks || []).map((taskResult) =>
          `${taskResult.name}${taskResult.code == null ? "" : ` [${taskResult.code}]`}：${taskResult.warning}`,
        );
        executionFinished = true;
        observations = [...(runResult?.observations || [])];
        runCounts = {
          completedCount: runResult?.completedCount || 0,
          warningCount: runResult?.warningCount || 0,
          failedCount: runResult?.failedCount || 0,
          skippedCount: runResult?.skippedCount || 0,
          verificationCount: runResult?.verificationCount || 0,
          unexecutedCount: runResult?.unexecutedCount || 0,
        };
        if (runResult?.aborted) {
          exceptions.push(runResult.abortReason);
          warnings = warnings.filter(detail => !detail.includes(runResult.abortReason));
        }
        if (runResult?.stopped) exceptions.push("用户已停止，后续日常未执行");
        accountStatus = runResult?.stopped ? "stopped" : exceptions.length > 0 ? "partial"
          : warnings.length > 0 ? "warning" : "completed";
        statusRef.value[tokenId] = accountStatus;
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `[日常][${tokenName}] ${runResult?.stopped ? "已停止" : runResult?.aborted ? "已中止" : "结束"}：完成${runCounts.completedCount} 跳过${runCounts.skippedCount} 普通警告${Math.max(0, runCounts.warningCount - runCounts.verificationCount)} 待核验${runCounts.verificationCount} 异常${runCounts.failedCount}${runCounts.unexecutedCount ? ` 未执行${runCounts.unexecutedCount}` : ""}；耗时${Math.round((Date.now() - accountStartedAt) / 1000)}秒`,
          type: ["partial", "failed"].includes(accountStatus) ? "error" : accountStatus === "completed" ? "success" : "warning",
        });
      } catch (error) {
        if (error?.stopped || shouldStop.value) {
          accountStatus = "stopped";
          exceptions = ["用户已停止，后续日常未执行"];
          statusRef.value[tokenId] = "stopped";
          break;
        }
        if (dailyConnectionFailure(error, tokenStore, tokenId)) {
          accountStatus = "warning";
          warnings = [`结果待核验：日常连接或请求中断（${error?.message || "未知原因"}），未重跑整轮日常`];
          exceptions = [];
          runCounts.warningCount = 1;
          runCounts.verificationCount = 1;
          observations.push("日常前置阶段中断：任务清单尚未返回，未执行子项数量未知；未重跑整轮日常");
          statusRef.value[tokenId] = accountStatus;
          addLog({ time: new Date().toLocaleTimeString(), type: "warning", message: `${tokenName} ${warnings[0]}` });
          break;
        }
        const classified = classifyBatchDailyError(error);
        if (classified.level === "warning") {
          accountStatus = "warning";
          warnings = [`前置步骤 [${classified.code}]：${classified.message}；后续日常未执行`];
          runCounts.warningCount = 1;
          runCounts.verificationCount = 1;
          observations.push("日常前置步骤结束：后续日常未执行，任务清单尚未返回");
          exceptions = [];
          statusRef.value[tokenId] = "warning";
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `[${tokenName}] 本轮已结束 - 警告[${classified.code}]: ${classified.message}；后续日常未执行`,
            type: "warning",
          });
          break;
        }
        console.error(error);
        if (retryCount < MAX_RETRIES && !shouldStop.value) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${tokenName} 执行出错: ${error.message}，等待3秒后重试...`,
            type: "warning",
          });
          // Wait for potential token refresh in store
          await new Promise((r) => setTimeout(r, 3000));
          retryCount++;
        } else {
          accountStatus = "failed";
          exceptions = [error?.message || String(error)];
          statusRef.value[tokenId] = "failed";
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${tokenName} 执行失败: ${error.message}`,
            type: "error",
          });
          break;
        }
      } finally {
        // 完成后关闭连接并释放槽位
        if (typeof tokenStore.closeWebSocketConnectionAsync === "function") {
          await tokenStore.closeWebSocketConnectionAsync(tokenId);
        } else {
          tokenStore.closeWebSocketConnection(tokenId);
        }
        releaseConnectionSlot(tokenId);

      }
    }

    if (!success && shouldStop.value) {
      accountStatus = "stopped";
      exceptions = ["执行过程中手动停止"];
      statusRef.value[tokenId] = "stopped";
    }

    return {
      tokenId,
      name: tokenName,
      status: accountStatus,
      exceptions,
      warnings,
      executionFinished,
      observations: [
        `子项：完成${runCounts.completedCount || 0}，跳过${runCounts.skippedCount || 0}，普通警告${Math.max(0, (runCounts.warningCount || 0) - (runCounts.verificationCount || 0))}，待核验${runCounts.verificationCount || 0}，异常${runCounts.failedCount || 0}，未执行${runCounts.unexecutedCount == null ? "未知（任务清单尚未返回）" : runCounts.unexecutedCount}`,
        `总耗时${Math.round((Date.now() - accountStartedAt) / 1000)}秒；连接前等待及建连${Math.round(queueMs / 1000)}秒；连接后${activeStartedAt === null ? "未开始" : `${Math.round((Date.now() - activeStartedAt) / 1000)}秒`}`,
        ...observations,
      ],
      ...runCounts,
    };
  });

  // 等待所有任务完成
  const accountResults = await Promise.all(taskPromises);

  // 等待所有任务完成后再继续
  await new Promise((r) => setTimeout(r, 1000));

  isRunning.value = false;
  currentRunningTokenId.value = null;
  const abnormalCount = accountResults.filter((item) =>
    ["partial", "failed", "stopped", "unavailable"].includes(item.status),
  ).length;
  const warningCount = accountResults.filter((item) => item.warningCount > 0).length;
  if (abnormalCount || warningCount) {
    message.warning(`批量日常已结束：${warningCount}个账号有警告，${abnormalCount}个账号有异常`);
  } else {
    message.success("批量任务执行结束");
  }
  return accountResults;
};

const stopBatch = () => {
  stopGenieChallenge();
  stopSaltOnce();
  shouldStop.value = true;
  addLog({
    time: new Date().toLocaleTimeString(),
    message: "正在停止...",
    type: "warning",
  });
};
// Auto plans share the existing queue, executor, result collector and PushPlus path.
const {
  config: autoConfig, now: autoNow, records: autoRecords, today: autoToday, week: autoWeek,
  batches: autoBatches, activity: autoActivity, runtimeState: autoRuntimeState,
  storageError: autoStorageError, save: saveAutoConfig, runtime: autoRuntime,
} = useAutoSchedule({
  groups: tokenGroups,
  tokens,
  enqueue: (plan, key, run) => enqueueScheduledTask({ name: `[自动计划] ${plan.label}` }, key, run),
  waitForIdle: async () => {
    while (isRunning.value) await new Promise((resolve) => setTimeout(resolve, 500));
  },
  execute: async (task, key) => {
    autoExecutionActive.value = true;
    let result;
    try {
      await executeScheduledTask(task, { scheduled: true, autoWeekly: true, executionKey: key,
        onResult: (value) => { result = value; } });
      return result;
    } finally {
      autoExecutionActive.value = false;
    }
  },
  log: (text, type) => addLog({ time: new Date().toLocaleTimeString(), message: text, type }),
});
const retryAutoPlan = (plan) => {
  try { autoRuntime.retry(plan); }
  catch (error) { message.warning(error.message); }
};
</script>

<style scoped>
.batch-daily-tasks {
  padding: 20px;
  height: 100vh;
  box-sizing: border-box;
  overflow: hidden;
}

.main-layout {
  display: flex;
  gap: 20px;
  height: 100%;
  overflow: hidden;
}

.left-column {
  flex: 1;
  overflow-y: auto;
  min-width: 0;
  padding-right: 8px;
}

.right-column {
  width: 400px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  height: 700px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}

.page-header h2 {
  margin: 0;
}

.batch-header-actions,
.batch-tools-row,
.batch-tools-buttons {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  min-width: 0;
}

.batch-header-actions,
.batch-tools {
  padding: 12px;
  background: var(--bg-primary, #f8f9fa);
  color: var(--text-primary, #333);
  border: 1px solid var(--border-light, #e9ecef);
  border-radius: 8px;
}

.batch-tools {
  margin-bottom: 20px;
  font-size: 14px;
}

.batch-tools-row > span {
  overflow-wrap: anywhere;
}

.config-transfer-row {
  scroll-margin-top: 80px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-light, #e9ecef);
}

.batch-tools-label {
  font-weight: 600;
}

.batch-tools-hint {
  color: var(--text-secondary, #6c757d);
}

.schedule-countdown {
  color: #1677ff;
}

.batch-header-actions > *,
.batch-tools-buttons > * {
  flex: 0 0 auto;
}

.config-upload {
  width: auto;
}

.token-item {
  display: flex;
  align-items: center;
}

.log-card {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.custom-card-header {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-header-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: flex-end;
  flex-wrap: nowrap;
}

/* Cron Parser Styles */
.cron-parser {
  margin-top: 12px;
  padding: 12px;
  background-color: var(--bg-tertiary);
  border-radius: 8px;
}

.cron-validation {
  margin-bottom: 12px;
  padding: 8px;
  border-radius: 4px;
}

.cron-validation.success {
  background-color: rgba(24, 160, 88, 0.12);
}

.cron-validation.error {
  background-color: rgba(235, 87, 87, 0.12);
}

.cron-next-runs h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.cron-next-runs ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.cron-next-runs li {
  padding: 6px 0;
  font-size: 13px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}

.cron-next-runs li:last-child {
  border-bottom: none;
}

.log-card :deep(.n-card__content) {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.log-header-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-container {
  flex: 1;
  overflow-y: auto;
  background: #f5f5f5;
  padding: 10px;
  border-radius: 4px;
  margin-top: 10px;
  font-family: monospace;
  min-height: 200px;
}

.log-item {
  margin-bottom: 4px;
  font-size: 12px;
}

.log-item.error {
  color: #d03050;
}

.log-item.success {
  color: #18a058;
}

.log-item.warning {
  color: #f0a020;
}

.log-item.info {
  color: #333;
}

.time {
  color: #999;
  margin-right: 8px;
}

.token-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-right: 8px;
}

/* Settings Modal Styles */
.settings-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.setting-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.setting-label {
  font-size: 14px;
  color: #666;
}

.setting-switches {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.switch-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #eee;
}

.switch-row:last-child {
  border-bottom: none;
}

.switch-label {
  font-size: 14px;
  color: #666;
}

.weird-tower-count-input {
  width: 86px;
  flex-shrink: 0;
}

.weird-tower-count-unit {
  display: inline-flex;
  align-items: center;
  height: 28px;
  color: #666;
  font-size: 14px;
}

/* Responsive Design */
@media (max-width: 1200px) {
  .right-column {
    width: 380px;
  }
}

@media (max-width: 992px) {
  .batch-daily-tasks {
    height: auto;
    overflow: visible;
  }

  .main-layout {
    flex-direction: column;
    height: auto;
    overflow: visible;
  }

  .left-column {
    overflow-y: visible;
    padding-right: 0;
  }

  .right-column {
    width: 100%;
    height: auto;
    flex-shrink: 0;
  }

  .log-container {
    height: 300px;
    min-height: 300px;
  }
}

@media (max-width: 768px) {
  .batch-daily-tasks {
    padding: 12px;
    height: 100vh;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .main-layout {
    height: auto;
    overflow: visible;
    flex-direction: column;
  }

  .left-column {
    overflow: visible;
    padding-right: 0;
    flex: none;
    height: auto;
  }

  .right-column {
    height: auto;
    width: 100%;
    flex: none;
  }

  .page-header {
    flex-direction: column;
    gap: 12px;
    align-items: stretch;
  }

  .page-header .actions {
    display: flex;
    gap: 8px;
  }

  .log-card {
    height: auto !important;
  }

  .log-card :deep(.n-card__content) {
    flex: none !important;
    overflow: visible !important;
    display: block !important;
  }

  .log-container {
    height: 300px;
    min-height: 300px;
    flex: none !important;
  }

  .log-header-controls {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  /* 批量功法残卷赠送样式 */
  .recipient-info:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
  }

  /* 头像悬停效果 */
  .avatar-container:hover {
    transform: scale(1.05);
    box-shadow: 0 6px 16px rgba(102, 126, 234, 0.3);
  }

  /* 加载动画 */
  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }

    100% {
      transform: rotate(360deg);
    }
  }

  /* Token分组管理样式 */
  .group-selection-section {
    padding: 12px;
    background-color: #f5f7fa;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
  }

  .group-tag {
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.3s ease;
    user-select: none;
    text-align: center;
    font-weight: 500;
  }

  .group-tag:hover {
    transform: translateY(-2px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .group-tag-selected {
    color: white;
    font-weight: 600;
  }

  /* 响应式设计 */
  @media (max-width: 600px) {
    .recipient-info {
      flex-direction: column;
      align-items: center;
      text-align: center;
    }

    .avatar-container {
      margin-bottom: 12px;
    }
  }
}
</style>


