import { formatGameTime, getGameDateKey } from "./activityCycle.js";
import { resolvePlanTokens } from "./batchResolver.js";
import { generateDayPlan } from "./planGenerator.js";
import { canRetry, getDueState } from "./scheduleGuard.js";
import { BATCH_IDS, getPlanDisabledReason, isRetiredSaltPlan, RETIRED_SALT_REASON } from "./weeklyPlan.js";

export const SCHEDULER_LOCK = "xyzw-auto-weekly-scheduler-v1";

// The lock is held for leadership AND the lifetime of every queued/running job.
// A storage lease cannot fence an already-sending suspended tab: fail closed without Web Locks.
export function createAutoScheduler({ storage, locks, enqueue, execute, getGroups, getTokens, waitForIdle = async () => {}, now = Date.now, onChange = () => {}, log = () => {}, uuid = () => globalThis.crypto.randomUUID() }) {
  let leader = false;
  let acquiring = false;
  let disposed = false;
  let draining = false;
  let release = null;
  let error = "";
  let compactedDate = "";
  const pending = new Set();
  const state = () => ({ leader, error, pending: pending.size });
  const notify = () => onChange(state());
  const fail = (cause) => {
    const next = cause?.message || String(cause);
    if (error !== next)
      log(`[自动计划] 暂停调度：${next}`, "error");
    error = next;
    notify();
  };
  const write = (key, data) => {
    storage.put(key, { ...storage.get(key), ...data, updatedAt: now() });
    notify();
  };
  const stopLeadership = () => {
    if (leader)
      draining = true;
    const finish = release;
    release = null;
    finish?.();
  };
  const recover = () => {
    const config = storage.loadConfig();
    for (const record of storage.list()) {
      if (["queued", "running"].includes(record.status)) {
        if (isRetiredSaltPlan(record)) {
          write(record.executionKey, { status: "skipped", retiredPreviousStatus: record.status, endedAt: now(), reason: `${RETIRED_SALT_REASON}；旧记录保留，历史执行结果仍需核验` });
          continue;
        }
        const reason = record.status === "queued" && getPlanDisabledReason(config, record.scheduleId, record.batchId);
        if (reason) {
          write(record.executionKey, { status: "skipped", disabledBeforeStart: true, endedAt: now(), reason });
          continue;
        }
        write(record.executionKey, { status: "warning", recoveredAt: now(), reason: "页面中断，执行结果待核验；不会自动重跑" });
      }
    }
  };
  async function run(plan, key) {
    try {
      await waitForIdle();
      if (isRetiredSaltPlan(plan)) {
        write(key, { status: "skipped", endedAt: now(), reason: RETIRED_SALT_REASON });
        return;
      }
      const config = storage.loadConfig();
      if (disposed || draining || error || !config.enabled) {
        write(key, { status: "skipped", disabledBeforeStart: !config.enabled, endedAt: now(), reason: "自动周计划已关闭" });
        return;
      }
      const disabledReason = getPlanDisabledReason(config, plan.scheduleId, plan.batchId);
      if (disabledReason) {
        write(key, { status: "skipped", disabledBeforeStart: true, endedAt: now(), reason: disabledReason });
        return;
      }
      // Never read a token snapshot captured at enqueue time.
      const resolved = resolvePlanTokens(plan, config, getGroups(), getTokens());
      if (resolved.status !== "ready") {
        write(key, { status: "skipped", endedAt: now(), reason: resolved.reason });
        log(`[自动计划][${plan.batchId}] ${plan.label}跳过：${resolved.reason}`, "warning");
        return;
      }
      // Rebinding or disabling an earlier batch must not give its accounts a second run.
      const ordinary = BATCH_IDS.includes(plan.batchId);
      if (ordinary) {
        const prefix = plan.executionKey.slice(0, plan.executionKey.lastIndexOf(":") + 1);
        const selected = new Set(resolved.tokenIds);
        const overlap = storage.list(prefix).some((record) => {
          if (record.batchId === plan.batchId || record.startedAt == null)
            return false;
          const priorIds = record.startedTokenIds ?? record.entries?.map((entry) => entry.tokenId) ?? [];
          return priorIds.some((id) => selected.has(id));
        });
        if (overlap) {
          write(key, { status: "skipped", endedAt: now(), reason: "该任务的其他批次已开始处理重复账号" });
          return;
        }
      }
      const startedAt = now();
      write(key, { status: "running", startedAt, tokenCount: resolved.tokenIds.length, ...(ordinary && { startedTokenIds: resolved.tokenIds }) });
      const delay = Math.floor((startedAt - plan.scheduledAt) / 60000);
      log(`[自动计划][${plan.batchId}] ${plan.label}开始${delay > 0 ? `，原计划${formatGameTime(plan.scheduledAt).slice(11, 16)}，延迟${delay}分` : ""}`, "info");
      const result = await execute({ id: key, name: `[自动计划][${plan.batchId}] ${plan.label}`, source: "autoWeekly", selectedTokens: resolved.tokenIds, selectedTasks: [...plan.taskChain], manualCycleOverride: config.manualCycleOverride }, key);
      const status = ["completed", "partial", "failed", "skipped", "warning", "stopped", "unavailable"].includes(result?.status) ? result.status : "warning";
      write(key, { status, endedAt: now(), entries: result?.entries || [], reason: result ? "" : "执行器未返回结果，待核验" });
      log(`[自动计划][${plan.batchId}] ${plan.label}${({ completed: "完成", partial: "部分完成", failed: "失败", skipped: "跳过", warning: "待核验/警告", stopped: "已停止", unavailable: "不可用" })[status]}，耗时${Math.ceil((now() - startedAt) / 60000)}分`, status === "failed" ? "error" : status === "partial" ? "warning" : "info");
    } catch (cause) {
      try {
        write(key, { status: "failed", endedAt: now(), reason: cause?.message || String(cause) });
      } catch (storageError) {
        fail(storageError);
      }
      log(`[自动计划][${plan.batchId}] ${plan.label}失败：${cause?.message || cause}`, "error");
    }
  }
  function queue(plan, key = plan.executionKey, parentExecutionKey) {
    if (isRetiredSaltPlan(plan))
      return false;
    if (storage.get(key))
      return false;
    write(key, { status: "queued", queuedAt: now(), scheduledAt: plan.scheduledAt, dateKey: plan.dateKey, scheduleId: plan.scheduleId, batchId: plan.batchId, label: plan.label, parentExecutionKey, taskChain: [...plan.taskChain] });
    let promise;
    try {
      promise = Promise.resolve(enqueue(plan, key, () => run(plan, key)));
    } catch (cause) {
      write(key, { status: "failed", reason: cause.message, endedAt: now() });
      throw cause;
    }
    pending.add(promise);
    notify();
    promise.catch(fail).finally(() => {
      pending.delete(promise);
      notify();
    });
    return true;
  }
  function tick() {
    if (!leader || draining || disposed || error)
      return;
    try {
      const config = storage.loadConfig();
      if (!config.enabled) {
        stopLeadership();
        return;
      }
      const time = now();
      const dateKey = getGameDateKey(time);
      if (compactedDate !== dateKey) {
        storage.compactHistory?.(dateKey);
        compactedDate = dateKey;
      }
      const plan = generateDayPlan(dateKey, config);
      for (const item of plan) {
        const due = getDueState(item, storage.get(item.executionKey), time, config.graceMinutes);
        if (due === "missed") {
          write(item.executionKey, { status: "missed", dateKey: item.dateKey, scheduledAt: item.scheduledAt, batchId: item.batchId, label: item.label, reason: "超过补执行窗口，不自动补跑" });
        } else if (due === "queued") {
          queue(item);
        }
      }
    } catch (cause) {
      fail(cause);
      stopLeadership();
    }
  }
  function poll() {
    if (disposed)
      return;
    try {
      if (!storage.loadConfig().enabled) {
        stopLeadership();
        return;
      }
      if (!locks?.request) {
        fail(new Error("浏览器不支持 Web Locks，请使用 HTTPS 下的 Chrome/Edge；自动计划未启动"));
        return;
      }
      if (leader) {
        tick();
        return;
      }
      if (acquiring || error)
        return;
      acquiring = true;
      locks.request(SCHEDULER_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock || disposed || !storage.loadConfig().enabled)
          return;
        recover();
        leader = true;
        draining = false;
        notify();
        const lifetime = new Promise((resolve) => {
          release = resolve;
        });
        tick();
        await lifetime;
        // Drain closures (disabled jobs skip) without interrupting an in-flight request.
        await Promise.allSettled([...pending]);
        leader = false;
        notify();
      }).catch(fail).finally(() => {
        acquiring = false;
      });
    } catch (cause) {
      fail(cause);
      stopLeadership();
    }
  }
  function retry(plan) {
    if (isRetiredSaltPlan(plan))
      throw new Error(RETIRED_SALT_REASON);
    const config = storage.loadConfig();
    if (!leader || draining || disposed || error || !config.enabled)
      throw new Error("请在持有调度权且已开启自动计划的标签页重试");
    if (plan.type !== "task" || plan.dateKey !== getGameDateKey(now()))
      throw new Error("仅支持重试今日游戏任务");
    const disabledReason = getPlanDisabledReason(config, plan.scheduleId, plan.batchId);
    if (disabledReason)
      throw new Error(disabledReason);
    const records = storage.list();
    const root = plan.executionKey;
    const latest = records.filter((r) => r.executionKey === root || r.parentExecutionKey === root).sort((a, b) => (b.queuedAt || b.updatedAt) - (a.queuedAt || a.updatedAt))[0];
    if (!canRetry(latest, records))
      throw new Error("任务正在排队、执行或已完成，不可重复重试");
    return queue(plan, `${root}:retry:${uuid()}`, root);
  }
  return { poll, tick, retry, state, get hasPending() {
    return pending.size > 0;
  }, dispose: () => {
    disposed = true;
    stopLeadership();
  }, clearError: () => {
    error = "";
    notify();
  } };
}
