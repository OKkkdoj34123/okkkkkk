export function createTasksToken(deps) {
  const { selectedTokens, tokenStatus, tokenStore, shouldStop, isRunning, addLog } = deps;
  return { batchRefreshTokens: async () => {
    const results = []; isRunning.value = true;
    try {
      for (const tokenId of new Set(selectedTokens.value)) {
        let r;
        if (shouldStop.value) r = { status: "stopped", reason: "用户主动停止，未刷新" };
        else {
          tokenStatus.value[tokenId] = "running";
          try { r = await tokenStore.refreshTokenForSchedule(tokenId); }
          catch (_) { r = { status: "failed", reason: "刷新接口异常，未确认凭据更新" }; }
        }
        if (!["completed", "skipped", "warning", "failed", "stopped", "unavailable"].includes(r?.status)) r = { status: "warning", reason: "刷新结果待核验" };
        tokenStatus.value[tokenId] = r.status;
        results.push({ tokenId, status: r.status, details: [r.reason], warnings: r.status === "warning" ? [r.reason] : [] });
        addLog({ time: new Date().toLocaleTimeString(), message: `[Token刷新][${tokenId}] ${r.reason}`, type: r.status === "failed" ? "error" : r.status === "completed" ? "success" : "warning" });
      }
      return results;
    } finally { isRunning.value = false; }
  } };
}
