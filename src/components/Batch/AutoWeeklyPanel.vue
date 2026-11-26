<template>
  <n-card class="auto-weekly-panel" size="small" title="自动周计划">
    <div class="auto-toolbar">
      <n-switch :value="config.enabled" @update:value="change({ enabled: $event })"></n-switch>
      <span>{{ config.enabled ? "已开启" : "已关闭" }}</span>
      <span>{{ runtimeState.leader ? "本页负责调度" : config.enabled ? "等待调度权 / 其他标签页调度" : "" }}</span>
      <n-button size="small" @click="showWeek = !showWeek">{{ showWeek ? "收起本周计划" : "查看本周计划" }}</n-button>
    </div>
    <p>北京时间 {{ formatGameTime(now) }} · {{ weekdays[getGameWeekday(now)] }}</p>
    <p>当前活动：{{ activity.label }} · 下一活动：{{ activity.nextLabel }} · 切换时间：{{ formatGameTime(activity.endAt) }}</p>
    <p v-if="activity.overridden">已使用手动活动覆盖；切换时间为原周期推算，覆盖值不会自动切换。</p>
    <div class="auto-settings">
      <label v-for="id in BATCH_IDS" :key="id">
        批次 {{ id }}（{{ batches.batches[id].tokenIds.length }} 个账号）
        <n-select clearable placeholder="选择 Token 分组" :options="groupOptions" :value="config.batches[id].groupId" @update:value="setBatch(id, { groupId: $event })"></n-select>
        <n-checkbox :checked="config.batches[id].enabled" @update:checked="setBatch(id, { enabled: $event })">启用此批次</n-checkbox>
      </label>
      <label>补执行窗口（分钟，默认5）<n-input-number :max="60" :min="1" :value="config.graceMinutes" @update:value="change({ graceMinutes: $event })"></n-input-number></label>
      <label>活动识别<n-select :options="cycleOptions" :value="config.manualCycleOverride" @update:value="change({ manualCycleOverride: $event })"></n-select></label>
    </div>
    <details class="auto-task-config">
      <summary>批次任务配置</summary>
      <div class="auto-table-wrap">
        <table>
          <thead><tr><th scope="col">计划任务</th><th v-for="id in BATCH_IDS" :key="id" scope="col">{{ id }} 批次</th></tr></thead>
          <tbody>
            <tr v-for="rule in WEEKLY_RULES" :key="rule.id">
              <th scope="row">
                {{ rule.label }}
                <small v-if="rule.id === 'tokenRefresh'">开关选择参与批次。每周一北京时间 00:10 合并账号、去重后统一刷新一次。</small>
              </th>
              <td v-for="id in BATCH_IDS" :key="id">
                <NSwitch
                  size="small"
                  :aria-label="`${id} 批次 · ${rule.label}`"
                  :value="config.batches[id].taskEnabled[rule.id]"
                  @update:value="setTask(id, rule.id, $event)"
                ></NSwitch>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
    <n-alert v-if="!batches.valid" class="auto-alert" type="info">分组间共有 {{ batches.duplicates.length }} 个重复账号。同一游戏任务的参与批次存在重叠时会跳过执行。Token 刷新合并去重。</n-alert>
    <n-alert v-if="error" class="auto-alert" type="error">{{ error }}</n-alert>
    <details class="auto-note">
      <summary>使用说明</summary>
      <p>需保持批量日常页面运行、设备唤醒；关闭浏览器或休眠后无法执行。关闭周计划开关只停止新增调度，当前任务继续结束。启用后，每周一北京时间00:10刷新批次和 Token 刷新开关均已开启的分组（当前合并去重后{{ refreshCount }}个账号），执行时读取最新分组；未绑定、已禁用分组及未分组账号不参与。每周只有一个刷新计划；缺少原始BIN或来源URL的账号跳过，中断记录待核验，不自动重跑。临时刷新可在“日常”中勾选账号后点击“刷新Token”。超出补执行窗口的任务不会自动补跑。日常和梦境购买沿用账号现有设置。盐场由自行设置的定时任务执行，自动周计划不再安排。</p>
    </details>
    <details open>
      <summary>今日计划</summary>
      <div class="auto-table-wrap">
        <table>
          <thead><tr><th>计划时间</th><th>批次 / 任务</th><th>状态</th><th>实际开始 / 结束</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="item in today" :key="item.id">
              <td>{{ time(item.scheduledAt) }}<span v-if="item.type === 'reserved'">–{{ item.reservedMinutes + (item.scheduledAt - gameTimestamp(item.dateKey)) / 60000 === 1440 ? '24:00' : time(item.scheduledAt + item.reservedMinutes * 60000) }}</span></td>
              <td>{{ item.batchId }} · {{ item.label }}<small v-if="item.type === 'task'">预留 {{ item.reservedMinutes }} 分钟</small></td>
              <td>{{ item.type === 'reserved' ? '备用窗口（不执行）' : record(item) ? STATUS_LABELS[record(item).status] : item.enabled ? STATUS_LABELS.waiting : '已关闭' }}<small v-if="item.disabledReason">{{ item.disabledReason }}</small><small v-if="record(item)?.parentExecutionKey">手动重试</small><small v-if="record(item)?.reason !== item.disabledReason">{{ record(item)?.reason }}</small></td>
              <td>{{ formatGameTime(record(item)?.startedAt) }}<br>{{ formatGameTime(record(item)?.endedAt) }}</td>
              <td>
                <n-button v-if="retryable(item)" size="tiny" :disabled="!config.enabled || !runtimeState.leader" @click="retry(item)">手动重试</n-button>
                <details v-if="history(item).length"><summary>记录</summary><div v-for="entry in history(item)" :key="entry.executionKey"><strong>{{ STATUS_LABELS[entry.status] }} · {{ formatGameTime(entry.startedAt || entry.queuedAt || entry.updatedAt) }}</strong><p>{{ entry.reason }}</p><p v-for="(step, index) in entry.entries || []" :key="index">{{ step.tokenId }} / {{ step.taskName }}：{{ step.status }} {{ step.details?.join('；') }}</p></div></details>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
    <div v-if="showWeek" class="auto-week">
      <details v-for="day in week" :key="day.dateKey">
        <summary>{{ day.dateKey }} · {{ weekdays[getGameWeekday(gameTimestamp(day.dateKey))] }}</summary>
        <p v-for="item in day.items" :key="item.id">{{ time(item.scheduledAt) }} · {{ item.batchId }} · {{ item.label }} · {{ item.reservedMinutes }} 分钟<span v-if="item.disabledReason"> · {{ item.disabledReason }}</span></p>
      </details>
    </div>
  </n-card>
</template>

<script setup>
import { computed, ref } from "vue";

import { formatGameTime, gameTimestamp, getGameWeekday } from "@/utils/autoSchedule/activityCycle.js";
import { canRetry, STATUS_LABELS } from "@/utils/autoSchedule/scheduleGuard.js";
import { BATCH_IDS, isBatchTaskEnabled, WEEKLY_RULES } from "@/utils/autoSchedule/weeklyPlan.js";

const props = defineProps({ config: Object, now: Number, activity: Object, batches: Object, groups: Array, today: Array, week: Array, records: Array, runtimeState: Object, error: String });
const emit = defineEmits(["save", "retry"]);
const showWeek = ref(false);
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const cycleOptions = [{ label: "自动识别（默认）", value: "auto" }, { label: "手动：黑市周", value: "blackMarket" }, { label: "手动：招募周", value: "recruit" }, { label: "手动：宝箱周", value: "box" }];
const groupOptions = computed(() => props.groups.map((group) => ({ label: group.name, value: group.id })));
const refreshCount = computed(() => new Set(BATCH_IDS
  .filter((id) => isBatchTaskEnabled(props.config, id, "tokenRefresh"))
  .flatMap((id) => props.batches.batches[id].tokenIds)).size);

const change = (patch) => emit("save", (config) => Object.assign(config, patch));
const setBatch = (id, patch) => emit("save", (config) => {
  Object.assign(config.batches[id], patch);
  return config;
});
const setTask = (id, ruleId, enabled) => emit("save", (config) => {
  config.batches[id].taskEnabled[ruleId] = enabled;
  return config;
});
const time = (value) => formatGameTime(value).slice(11, 16);
const history = (item) => item.executionKey ? props.records.filter((r) => r.executionKey === item.executionKey || r.parentExecutionKey === item.executionKey).sort((a, b) => (b.queuedAt || b.updatedAt) - (a.queuedAt || a.updatedAt)) : [];
const record = (item) => history(item)[0];
const retryable = (item) => item.type === "task" && item.enabled && canRetry(record(item), props.records);
const retry = (item) => {
  // eslint-disable-next-line no-alert -- explicit confirmation for a potentially repeated purchase
  if (window.confirm(`重新执行 ${item.batchId} ${item.label} 的完整任务链？请先核对游戏实际结果，重试可能重复领取或购买；原记录会保留。`))
    emit("retry", item);
};
</script>

<style scoped>
.auto-weekly-panel { margin-bottom: 16px; }
.auto-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.auto-settings { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.auto-settings label { display: grid; gap: 6px; }
.auto-alert, .auto-task-config { margin-top: 12px; }
.auto-task-config th small { font-weight: normal; }
.auto-note { color: #697586; font-size: 12px; }
.auto-note summary { cursor: pointer; }
.auto-note p { margin: 6px 0 0; }
.auto-table-wrap { overflow: auto; max-height: 500px; margin-top: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { border-bottom: 1px solid #cbd5e1; padding: 8px; text-align: left; vertical-align: top; min-width: 85px; }
small { display: block; max-width: 240px; }
.auto-week { margin-top: 12px; }
summary { cursor: pointer; }
</style>

