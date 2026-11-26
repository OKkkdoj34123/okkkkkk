export const BATCH_IDS = ["A", "B", "C"];
export const CHAINS = {
  tokenRefresh: ["batchRefreshTokens"],
  light: ["claimHangUpRewards", "batchlingguanzi", "batchStudy"],
  daily: ["batchlingguanzi", "startBatch", "claimHangUpRewards", "resetBottles"],
  dream: ["batchmengjing", "batchBuyDreamItems"],
  camp: ["batchCampChallengePet"],
  weirdIntegrated: ["batchWeirdTowerIntegrated"],
};
// Times are minutes after Beijing midnight; reserved duration is never a timeout.
export const WEEKLY_RULES = [
  { id: "tokenRefresh", days: [1], batches: ["TOKENS"], times: [10], chain: "tokenRefresh", label: "周计划分组 Token 刷新", duration: 20, priority: 100 },
  { id: "nightLight", days: [0, 1, 2, 3, 4, 6], times: [30, 90, 150], chain: "light", label: "夜间基础", duration: 20, priority: 60 },
  { id: "nightTower", days: [0, 1, 2, 3, 4, 6], times: [50, 110, 170], chain: "tower", label: "塔任务", duration: 40, priority: 70 },
  { id: "fridayDaily", days: [5], times: [30, 90, 150], chain: "daily", label: "周五凌晨日常", duration: 60, priority: 80 },
  { id: "dream", days: [0, 1, 3, 4], times: [210, 270, 330], chain: "dream", label: "梦境及购买", duration: 60, priority: 90 },
  { id: "morningDaily", days: [0, 1, 2, 3, 4, 6], times: [390, 450, 510], chain: "daily", label: "早间日常", duration: 60, priority: 80 },
  { id: "fridayLight", days: [5], times: [450, 480, 510], chain: "light", label: "周五早间基础", duration: 30, priority: 60 },
  { id: "camp", days: [2, 3, 4], times: [570, 600, 630], chain: "camp", label: "营地空投保底", duration: 30, priority: 90 },
  { id: "noonDaily", times: [750, 810, 870], chain: "daily", label: "中午日常", duration: 60, priority: 80 },
  { id: "fridayWeirdTower", days: [5], times: [930, 960, 990], cycle: "blackMarket", chain: "weird", label: "周五怪异塔", duration: 30, priority: 70 },
  { id: "afternoonWeirdIntegrated", days: [0, 1, 2, 3, 4, 6], times: [930, 960, 990], cycle: "blackMarket", chain: "weirdIntegrated", label: "常规日怪异塔综合处理", duration: 30, priority: 70 },
  { id: "fridayAfternoonWeirdIntegrated", days: [5], times: [1020, 1050, 1080], cycle: "blackMarket", chain: "weirdIntegrated", label: "周五怪异塔综合处理", duration: 30, priority: 70 },
  { id: "eveningDaily", times: [1110, 1140, 1170], chain: "daily", label: "晚间日常", duration: 30, priority: 80 },
];

export function isBatchTaskEnabled(config, batchId, ruleId) {
  const batch = config.batches?.[batchId];
  return batch?.enabled !== false && batch?.taskEnabled?.[ruleId] !== false;
}

export function getPlanDisabledReason(config, ruleId, batchId) {
  if (ruleId === "tokenRefresh" && batchId === "TOKENS")
    return BATCH_IDS.some((id) => isBatchTaskEnabled(config, id, ruleId)) ? "" : "三个批次均已关闭 Token 刷新";
  if (config.batches?.[batchId]?.enabled === false)
    return `${batchId} 批次已关闭`;
  return isBatchTaskEnabled(config, batchId, ruleId) ? "" : `${batchId} 批次的本项任务已关闭`;
}

// Salt participation is managed by the user's own scheduled task.
// Match old records too: missed records may only contain executionKey.
export function isRetiredSaltPlan(plan) {
  return plan?.scheduleId === "salt"
    || plan?.taskChain?.includes("batchSaltOnce") === true
    || /^autoWeekly:\d{8}:salt:/.test(plan?.executionKey || "");
}

export const RETIRED_SALT_REASON = "自动周计划已取消盐场任务，请使用自行设置的盐场定时任务";
