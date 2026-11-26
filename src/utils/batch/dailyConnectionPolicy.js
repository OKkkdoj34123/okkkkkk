// A business-command timeout is ambiguous: never replay it or the whole daily run.
export function dailyConnectionFailure(error, tokenStore, tokenId) {
  if (error?.stopped) return false;
  if (error?.haltDaily) return true;
  const message = String(error?.message || "");
  if (/超时|timeout|WebSocket\s*(?:未连接|连接已关闭|客户端不存在)|socket\s*(?:is\s*)?(?:closed|not connected)/i.test(message)) return true;
  if (typeof tokenStore?.getWebSocketStatus === "function") {
    return ["disconnected", "closed", "error"].includes(tokenStore.getWebSocketStatus(tokenId));
  }
  return false;
}
export function markDailyConnectionError(error, tokenStore, tokenId) {
  if (dailyConnectionFailure(error, tokenStore, tokenId) && error && typeof error === "object") error.haltDaily = true;
  return error;
}
