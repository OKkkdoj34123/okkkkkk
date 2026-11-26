export const TERMINAL_STATUSES = new Set(["completed", "skipped", "warning", "partial", "failed", "stopped", "unavailable"]);
export function getVerificationMetadata(value = {}) {
  const lines = input => (Array.isArray(input) ? input : input == null ? [] : [input]).map(String).filter(Boolean);
  const candidates = [...lines(value.details ?? value.detail), ...lines(value.warnings)];
  const explicit = [...new Set(lines(value.verificationDetails))];
  // Compatibility for old executors; new callers can supply explicit metadata.
  const inferred = candidates.filter(text => /待核验|未确认|无法确认|结果未知|后续.*未执行|连接.*中断|请求中断|未收到.*(?:终态|响应)/.test(text));
  const required = typeof value.verificationRequired === "boolean" ? value.verificationRequired
    : explicit.length > 0 || ["warning", "partial", "failed"].includes(value.status) && inferred.length > 0;
  return { verificationRequired: required, verificationDetails: required
    ? [...new Set(explicit.length ? explicit : inferred.length ? inferred : ["结果待核验：执行器标记需要核验"])] : [] };
}
export function recordTaskResult(ref, tokenId, status, details = [], warnings = [], metadata = {}) {
  const verification = getVerificationMetadata({ status, details, warnings, ...metadata });
  if (typeof ref.recordResult === "function") ref.recordResult(tokenId, status, details, warnings, verification);
  else ref.value[tokenId] = status;
  return { tokenId, status, details: Array.isArray(details) ? details : [details], warnings, ...verification };
}
export function taskErrorResult(error, progress = false) {
  if (error?.stopped) return { status: "stopped", detail: "手动停止" };
  const detail = String(error?.message || "请求失败，未提供详细原因");
  if (/超时|timeout/i.test(detail)) return { status: "warning", detail: `结果待核验：${detail}；未自动重试` };
  return { status: progress ? "partial" : "failed", detail };
}
// helperStopTime only proves helper timing, not reward availability. Never guess numeric codes.
export function isNoClaimableBottle(error, requestCmd) {
  if (requestCmd !== "bottlehelper_claim" || error?.requestCmd && error.requestCmd !== requestCmd) return false;
  const text = String(error?.message || "").replace(/^服务器错误\s*[:：]\s*\d+\s*[-－—]\s*/, "").trim();
  return /^(?:当前)?(?:没有|无)(?:可领取的?盐罐|可领取盐罐|可领取的?罐子)[。！!]?$/u.test(text);
}
