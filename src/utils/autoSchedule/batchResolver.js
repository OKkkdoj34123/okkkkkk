import { BATCH_IDS, isBatchTaskEnabled } from "./weeklyPlan.js";

export function resolveBatches(config, groups, tokens, ruleId) {
  const validIds = new Set(tokens.map((token) => token.id));
  const batches = {};
  const owners = new Map();
  const duplicates = new Set();
  for (const batchId of BATCH_IDS) {
    const binding = config.batches?.[batchId];
    const group = groups.find((item) => item.id === binding?.groupId);
    const enabled = isBatchTaskEnabled(config, batchId, ruleId);
    const ids = enabled ? [...new Set(group?.tokenIds || [])].filter((id) => validIds.has(id)) : [];
    batches[batchId] = { tokenIds: ids, groupName: group?.name || "未绑定", enabled };
    ids.forEach((id) => {
      if (owners.has(id))
        duplicates.add(id);
      owners.set(id, batchId);
    });
  }
  return { batches, valid: duplicates.size === 0, duplicates: [...duplicates], allTokenIds: [...new Set(BATCH_IDS.flatMap((id) => batches[id].tokenIds))] };
}
export function resolvePlanTokens(plan, config, groups, tokens) {
  const result = resolveBatches(config, groups, tokens, plan.scheduleId);
  if (plan.scheduleId === "tokenRefresh" && plan.batchId === "TOKENS") {
    // Keep the existing execution key; refresh only the live union of enabled batches.
    // Overlapping groups refresh an account once, while game tasks still reject overlap.
    const tokenIds = result.allTokenIds;
    return { status: tokenIds.length ? "ready" : "skipped", reason: tokenIds.length ? "" : "自动周计划已启用分组中没有可用账号", tokenIds };
  }
  if (!result.valid)
    return { status: "skipped", reason: "自动计划批次存在重复账号", tokenIds: [] };
  const tokenIds = plan.batchId === "ALL" ? result.allTokenIds : result.batches[plan.batchId]?.tokenIds || [];
  return { status: tokenIds.length ? "ready" : "skipped", reason: tokenIds.length ? "" : "当前批次为空或已禁用", tokenIds };
}
