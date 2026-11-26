export const STATUS_LABELS = { waiting: "等待", queued: "排队", running: "执行中", completed: "完成", partial: "部分完成", skipped: "跳过", missed: "错过", failed: "失败", warning: "待核验/警告", stopped: "已停止", unavailable: "不可用" };
export function getDueState(plan, record, now, graceMinutes = 5) {
  if (plan.type === "reserved" || plan.enabled === false || record || now < plan.scheduledAt)
    return null;
  // BATCH_RUNTIME_FIX_20261015: legacy zero/invalid values use five minutes.
  const grace = Number(graceMinutes);
  const windowMinutes = Number.isFinite(grace) && grace > 0 ? Math.min(60, Math.max(1, grace)) : 5;
  return now - plan.scheduledAt > windowMinutes * 60000 ? "missed" : "queued";
}
export function summarizeEntries(entries) {
  if (!entries.length)
    return { status: "skipped", entries };
  const known = new Set(["completed", "warning", "skipped", "partial", "failed", "stopped", "unavailable"]);
  entries = entries.map(e => known.has(e.status) ? e : { ...e, status: "warning", details: [...(e.details || []), "结果待核验：执行器未提供合法终态"] });
  const statuses = entries.map((entry) => entry.status);
  const bad = statuses.filter((status) => !["completed", "warning", "skipped"].includes(status));
  const status = bad.length
    ? (bad.length < statuses.length || statuses.includes("partial") ? "partial" : "failed")
    : statuses.every((s) => s === "skipped") ? "skipped" : statuses.includes("warning") ? "warning" : "completed";
  return { status: statuses.every(s => s === "stopped") ? "stopped" : statuses.every(s => s === "unavailable") ? "unavailable" : status, entries };
}
export function canRetry(record, records) {
  if (record?.executionKey?.includes(":tokenRefresh:")) return false;
  if (!record || record.disabledBeforeStart || !["failed", "partial", "skipped", "missed"].includes(record.status))
    return false;
  const root = record.parentExecutionKey || record.executionKey;
  return !records.some((item) => (item.executionKey === root || item.parentExecutionKey === root)
    && (item.disabledBeforeStart || ["queued", "running"].includes(item.status)));
}

