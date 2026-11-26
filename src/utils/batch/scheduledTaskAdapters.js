// BATCH_SCHEDULE_TASK_ALIGNMENT_20261115_R2
import { batchPhoenixPrayer } from "./tasksPhoenixPrayer.js";
import { createTasksBonfire } from "./tasksBonfire.js";
import { createTasksJianghuMarket } from "./tasksJianghuMarket.js";
import { createMarketLedger, normalizeMarketList } from "./jianghuMarket.js";
import { createTasksApex } from "./tasksApex.js";

const withTaskLock = async (locks, lockName, label, action, onBusy) => {
  if (!locks?.request) {
    throw new Error(`浏览器不支持跨标签互斥，${label}未执行`);
  }
  return locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (!lock) return onBusy ? onBusy() : [];
    return action();
  });
};

const skippedRows = (deps, label) => [...new Set(deps.selectedTokens?.value || [])].map((tokenId) => ({
  tokenId,
  status: "skipped",
  details: [`其他标签页正在执行${label}，本页跳过`],
}));

const readSavedMarketList = (storage, normalize) => {
  let raw;
  try {
    raw = storage.getItem("xyzw_jianghu_list_v1");
  } catch {
    throw new Error("无法读取江湖黑市购买清单，未执行购买");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw || "[]");
  } catch {
    throw new Error("江湖黑市购买清单格式损坏，请重新保存");
  }

  const list = normalize(parsed);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("江湖黑市购买清单为空，请先配置并保存清单");
  }
  return list;
};

/**
 * Create task adapters for executeScheduledTask.
 * The outer scheduled executor already owns the task-preemption lease, so
 * inner manual-only lease checks are neutralized here. Existing business
 * executors, Web Locks, stop flags, and per-account result rows are reused.
 */
export function createScheduledTaskAdapters({
  deps,
  storage = globalThis.localStorage,
  locks = globalThis.navigator?.locks,
  openReadOnly,
  closeReadOnly,
  rows = { value: [] },
  factories = {},
} = {}) {
  if (!deps || typeof deps !== "object") throw new Error("定时任务依赖不可用");
  if (!storage?.getItem || !storage?.setItem || !storage?.removeItem) {
    throw new Error("本地存储不可用，定时任务适配器未创建");
  }
  if (typeof openReadOnly !== "function" || typeof closeReadOnly !== "function") {
    throw new Error("只读连接适配器不可用，定时任务适配器未创建");
  }

  const createBonfire = factories.createTasksBonfire || createTasksBonfire;
  const runPhoenix = factories.batchPhoenixPrayer || batchPhoenixPrayer;
  const createMarket = factories.createTasksJianghuMarket || createTasksJianghuMarket;
  const createApex = factories.createTasksApex || createTasksApex;
  const createLedger = factories.createMarketLedger || createMarketLedger;
  const normalizeList = factories.normalizeMarketList || normalizeMarketList;

  const sharedDeps = {
    ...deps,
    storage,
    locks,
    isBusy: () => false,
    openReadOnly,
    closeReadOnly,
    acquireLease: async () => null,
    releaseLease: async () => {},
  };

  const bonfire = createBonfire(sharedDeps);
  const market = createMarket({ ...sharedDeps, rows, ledger: createLedger(storage) });
  const apex = createApex(deps);

  return {
    batchBonfireSignup: () => withTaskLock(
      locks,
      "xyzw-bonfire-signup-v1",
      "篝火报名",
      () => bonfire.batchBonfireSignup(),
      () => skippedRows(deps, "篝火报名"),
    ),

    batchPhoenixPrayer: () => {
      if (!locks?.request) throw new Error("浏览器不支持跨标签互斥，凤仪祈愿未执行");
      return runPhoenix(sharedDeps);
    },

    batchJianghuMarket: () => {
      const list = readSavedMarketList(storage, normalizeList);
      return withTaskLock(
        locks,
        "xyzw-jianghu-market-v1",
        "江湖黑市",
        () => market.batchJianghuMarket(list),
        () => skippedRows(deps, "江湖黑市"),
      );
    },

    batchApexGuess: async () => {
      // Scheduled Apex always uses the first-season automatic schedule table;
      // a manual ID left in the UI modal is deliberately not inherited.
      const results = await withTaskLock(
        locks,
        "xyzw-apex-guess-v1",
        "逐鹿盐山竞猜",
        () => apex.batchApexGuess({ useManualScheduleId: false }),
        () => skippedRows(deps, "逐鹿盐山竞猜"),
      );
      if (!Array.isArray(results)) return results;
      return results.map((row) => {
        const detail = Array.isArray(row?.details) ? row.details.join("；") : String(row?.details || "");
        // No open fixture at the scheduled time is a normal skip. Multiple
        // candidates, invalid clocks, and season mismatches remain failures.
        if (row?.status === "failed" && detail.includes("当前时间没有处于 Unlocked / Locked 状态")) {
          if (row.tokenId !== undefined && deps.tokenStatus?.value) deps.tokenStatus.value[row.tokenId] = "skipped";
          return { ...row, status: "skipped", warnings: [] };
        }
        return row;
      });
    },
  };
}
