import { BATCH_IDS, WEEKLY_RULES } from "./weeklyPlan.js";

export const CONFIG_KEY = "auto-weekly-schedule:v1";
export const RECORD_PREFIX = "auto-weekly-execution:v1:";
export function normalizeConfig(value = {}) {
  const config = value && typeof value === "object" ? value : {};
  const grace = Number(config.graceMinutes ?? 5);
  return { enabled: config.enabled === true, timezone: "Asia/Shanghai", scheduleVersion: 1, manualCycleOverride: ["blackMarket", "recruit", "box"].includes(config.manualCycleOverride) ? config.manualCycleOverride : "auto", graceMinutes: Number.isFinite(grace) && grace > 0 ? Math.min(60, Math.max(1, grace)) : 5, batches: Object.fromEntries(BATCH_IDS.map((id) => [id, {
    groupId: typeof config.batches?.[id]?.groupId === "string" ? config.batches[id].groupId : null,
    enabled: config.batches?.[id]?.enabled !== false,
    taskEnabled: Object.fromEntries(WEEKLY_RULES.map((rule) => [rule.id, config.batches?.[id]?.taskEnabled?.[rule.id] !== false])),
  }])) };
}
export function createScheduleStorage(storage) {
  // Invalid or unavailable persistence must prevent scheduling, never erase dedupe history.
  const read = (key) => {
    const raw = storage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  };
  const list = (prefix = "") => {
    const results = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(RECORD_PREFIX + prefix))
        results.push(read(key));
    }
    return results.filter(Boolean);
  };
  return {
    loadConfig: () => normalizeConfig(read(CONFIG_KEY)),
    saveConfig: (value) => {
      const next = typeof value === "function" ? value(normalizeConfig(read(CONFIG_KEY))) : value;
      const config = normalizeConfig(next);
      storage.setItem(CONFIG_KEY, JSON.stringify(config));
      return config;
    },
    get: (key) => read(RECORD_PREFIX + key),
    put: (key, value) => {
      storage.setItem(RECORD_PREFIX + key, JSON.stringify({ ...value, executionKey: key }));
    },
    compactHistory: (dateKey) => {
      const older = list().filter((record) => record.dateKey < dateKey);
      // A queue may span midnight. Keep overlap evidence until that day's rule has drained.
      const inFlight = (record) => ["queued", "running"].includes(record.status);
      const ruleKey = (record) => `${record.dateKey}:${record.scheduleId}`;
      const activeRules = new Set(older.filter((record) => record.scheduleId && inFlight(record)).map(ruleKey));
      for (const record of older) {
        if (inFlight(record) || activeRules.has(ruleKey(record)) || !(record.entries || record.startedTokenIds))
          continue;
        const { entries, startedTokenIds: _startedTokenIds, ...summary } = record;
        storage.setItem(RECORD_PREFIX + record.executionKey, JSON.stringify({ ...summary, detailCount: entries?.length ?? 0 }));
      }
    },
    list,
  };
}

