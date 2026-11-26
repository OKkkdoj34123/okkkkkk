import { taskErrorResult, getVerificationMetadata } from "./taskResult.js";
import { dailyConnectionFailure } from "./dailyConnectionPolicy.js";

// One scheduled chain / manual invocation only. No persistent daily cache.
export const createHangUpTaskContext = () => ({ hangUpActions: new Map() });
const stopError = () => Object.assign(new Error("用户已停止，未发送后续挂机操作"), { stopped: true });
const pause = async (ms, stopped, delay) => {
  for (let left = ms; left > 0; left -= 100) {
    if (stopped()) throw stopError();
    await delay(Math.min(100, left));
  }
  if (stopped()) throw stopError();
};

async function once({ context, tokenId, key, label, cmd, params = {}, send,
  stopped = () => false, isDisconnected = () => false,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)), spacingMs = 1000 }) {
  if (stopped()) throw stopError();
  const actions = context.hangUpActions ||= new Map();
  const actionKey = JSON.stringify([String(tokenId), key]);
  const prior = actions.get(actionKey);
  if (prior) {
    const result = await prior;
    if (stopped()) throw stopError();
    return { ...result, reused: true };
  }
  const pending = Promise.resolve().then(async () => {
    if (stopped()) throw stopError();
    // Also protect claim -> first share and state query -> legacy claim gaps.
    await pause(Math.max(1000, Number(spacingMs) || 0), stopped, delay);
    let outcome;
    try {
      await send(cmd, params, 5000);
      outcome = { status: "completed", confirmed: 1, detail: `${label}已确认`, verificationRequired: false };
    } catch (error) {
      if (error?.stopped || stopped()) throw stopError();
      const haltDaily = dailyConnectionFailure(error) || isDisconnected();
      const result = taskErrorResult(error);
      outcome = { ...result, status: haltDaily ? "warning" : result.status,
        detail: `${label}：${haltDaily ? "结果待核验；连接或请求中断；" : ""}${result.detail}`,
        confirmed: 0, haltDaily, code: error?.code, requestCmd: cmd,
        verificationRequired: haltDaily || result.status === "warning" };
    }
    // Pace both success and rejection. Never retry a write here.
    await pause(Math.max(1000, Number(spacingMs) || 0), stopped, delay);
    return { ...outcome, ...getVerificationMetadata(outcome), reused: false };
  });
  actions.set(actionKey, pending);
  return pending;
}

export async function runHangUpShare(options) {
  const result = await once({ ...options, key: "share:0", label: "分享/加钟第1次",
    cmd: "system_mysharecallback", params: { isSkipShareCard: true, type: 2 } });
  return { ...result, status: result.reused && result.status === "completed" ? "skipped" : result.status,
    detail: result.reused ? `复用本轮分享/加钟结果：${result.detail}` : result.detail };
}

const isIgnoredAddTime400340 = result =>
  !result?.haltDaily &&
  result?.requestCmd === "system_mysharecallback" &&
  (Number(result?.code) === 400340 || /(?:^|[：:\s])服务器错误\s*[:：]\s*400340(?:\D|$)/.test(String(result?.detail || "")));

export async function runHangUpAddTime(options) {
  let confirmed = 0, newlyConfirmed = 0, reused = 0;
  for (let i = 0; i < 4; i++) {
    const result = await once({ ...options, key: `share:${i}`, label: `加钟 ${i + 1}/4`,
      cmd: "system_mysharecallback", params: { isSkipShareCard: true, type: 2 } });
    if (result.reused) reused++;
    if (result.confirmed) {
      confirmed++;
      if (!result.reused) newlyConfirmed++;
    } else if (isIgnoredAddTime400340(result)) {
      const detail = `加钟：本轮已确认 ${confirmed}/4 次（本入口新增 ${newlyConfirmed} 次）；已按规则忽略 400340（${result.detail}）；后续 ${3 - i} 次未发送`;
      return { ...result, status: newlyConfirmed ? "completed" : "skipped",
        confirmed, newlyConfirmed, reused: reused > 0, detail,
        verificationRequired: false, verificationDetails: [] };
    } else {
      const detail = `加钟：本轮已确认 ${confirmed}/4 次（本入口新增 ${newlyConfirmed} 次）；${result.detail}；后续 ${3 - i} 次未发送`;
      return { ...result, status: result.status === "warning" ? "warning" : confirmed ? "partial" : "failed",
        confirmed, newlyConfirmed, reused: reused > 0, detail,
        verificationDetails: result.verificationRequired ? [detail] : [] };
    }
  }
  return { status: newlyConfirmed ? "completed" : "skipped", confirmed, newlyConfirmed,
    reused: reused > 0, verificationRequired: false,
    detail: `加钟：本轮已确认 4/4 次（本入口新增 ${newlyConfirmed} 次，复用 ${reused} 次）` };
}

export async function runHangUpLegacy(options) {
  const result = await once({ ...options, key: "legacy", label: "功法残卷", cmd: "legacy_claimhangup" });
  return { ...result, status: result.reused && result.status === "completed" ? "skipped" : result.status,
    detail: result.reused ? `功法残卷：复用本轮前序结果（${result.detail}）` : result.detail };
}
