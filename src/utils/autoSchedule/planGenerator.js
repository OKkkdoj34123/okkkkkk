import { DAY_MS, gameTimestamp, getActivityCycle, getGameDateKey, getGameWeekday } from "./activityCycle.js";
import { BATCH_IDS, CHAINS, getPlanDisabledReason, WEEKLY_RULES } from "./weeklyPlan.js";

export function generateDayPlan(dateKey, config = {}) {
  const day = getGameWeekday(gameTimestamp(dateKey));
  const items = [];
  for (const rule of WEEKLY_RULES) {
    if (rule.days && !rule.days.includes(day))
      continue;
    (rule.batches || BATCH_IDS).forEach((batchId, index) => {
      const scheduledAt = gameTimestamp(dateKey, rule.times[index]);
      // Friday noon changes cycle: evaluate every slot at its own time.
      const cycle = getActivityCycle(scheduledAt, config.manualCycleOverride);
      if (rule.cycle && rule.cycle !== cycle.type)
        return;
      const tower = rule.chain === "weird" || (rule.chain === "tower" && cycle.type === "blackMarket");
      const taskChain = CHAINS[rule.chain] || [tower ? "climbWeirdTower" : "climbTower"];
      const executionKey = `autoWeekly:${dateKey.replaceAll("-", "")}:${rule.id}:${batchId}`;
      const disabledReason = getPlanDisabledReason(config, rule.id, batchId);
      items.push({ id: executionKey, executionKey, enabled: !disabledReason, disabledReason, dateKey, scheduleId: rule.id, batchId, scheduledAt, reservedMinutes: rule.duration, taskChain: [...taskChain], priority: rule.priority, source: "autoWeekly", type: "task", status: "waiting", label: rule.chain === "tower" ? (tower ? "怪异塔" : "普通塔") : rule.label });
    });
  }
  const afternoonRules = ["afternoonWeirdIntegrated", "fridayWeirdTower", "fridayAfternoonWeirdIntegrated"];
  const midnight = gameTimestamp(dateKey);
  const afternoon = Math.max(930, ...items
    .filter((item) => item.enabled && afternoonRules.includes(item.scheduleId))
    .map((item) => (item.scheduledAt - midnight) / 60000 + item.reservedMinutes));
  for (const [scheduleId, start, end] of [["afternoonReserve", afternoon, 1110], ["nightReserve", 1260, 1440]]) {
    if (start >= end) continue;
    items.push({ id: `${dateKey}:${scheduleId}`, dateKey, scheduleId, type: "reserved", label: "备用窗口", batchId: "—", scheduledAt: gameTimestamp(dateKey, start), reservedMinutes: end - start, taskChain: [], priority: 0, source: "autoWeekly" });
  }
  return items.sort((a, b) => a.scheduledAt - b.scheduledAt || b.priority - a.priority);
}
export function generateWeekPlan(time = Date.now(), config = {}) {
  const monday = gameTimestamp(getGameDateKey(time)) - ((getGameWeekday(time) + 6) % 7) * DAY_MS;
  return Array.from({ length: 7 }, (_, index) => {
    const dateKey = getGameDateKey(monday + index * DAY_MS);
    return { dateKey, items: generateDayPlan(dateKey, config) };
  });
}
