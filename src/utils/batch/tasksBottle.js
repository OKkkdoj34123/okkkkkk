import { recordTaskResult, taskErrorResult } from "./taskResult.js";
import { createBottleTaskContext, runBottleAction } from "./bottleWorkflow.js";

/** Shared execution scope prevents duplicate actions across daily and standalone steps. */
export function createTasksBottle(deps) {
  const { selectedTokens, tokens, tokenStatus, isRunning, shouldStop, ensureConnection,
    releaseConnectionSlot, tokenStore, addLog, currentRunningTokenId } = deps;
  const report = (id, status, detail, result = {}) => {
    recordTaskResult(tokenStatus, id, status, [detail], status === "warning" ? [detail] : [], result);
    const name = tokens.value.find(t => t.id === id)?.name || id;
    addLog({ time: new Date().toLocaleTimeString(), message: `[盐罐][${name}] ${result.consoleDetail || detail}`,
      type: status === "failed" ? "error" : status === "warning" ? "warning" : "info" });
  };
  const run = async kind => {
    const ids = [...new Set(selectedTokens.value)];
    if (!ids.length) return;
    const context = deps.bottleTaskContext || createBottleTaskContext();
    isRunning.value = true;
    shouldStop.value = false;
    ids.forEach(id => { tokenStatus.value[id] = "waiting"; });
    try {
      await Promise.all(ids.map(async tokenId => {
        if (shouldStop.value) return report(tokenId, "stopped", "手动停止");
        if (!tokens.value.some(t => t.id === tokenId)) return report(tokenId, "unavailable", "账号已移除");
        tokenStatus.value[tokenId] = "running";
        let connected = false;
        try {
          const result = await runBottleAction({ context, tokenId, kind,
            stopped: () => shouldStop.value,
            connect: async () => { await ensureConnection(tokenId); connected = true; },
            send: (cmd, params, timeout) => tokenStore.sendMessageWithPromise(tokenId, cmd, params, timeout),
          });
          report(tokenId, result.status, result.detail, result);
        } catch (error) {
          const result = taskErrorResult(error);
          report(tokenId, result.status, result.detail);
        } finally {
          if (connected) {
            try { tokenStore.closeWebSocketConnection(tokenId); }
            finally { releaseConnectionSlot(tokenId); }
          }
        }
      }));
    } finally {
      isRunning.value = false;
      currentRunningTokenId.value = null;
    }
  };
  return { resetBottles: () => run("reset"), batchlingguanzi: () => run("claim") };
}
