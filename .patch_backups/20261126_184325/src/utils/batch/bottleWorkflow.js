import { isNoClaimableBottle } from "./taskResult.js";
import { bottleSnapshot, bottleSnapshotText, bottleChangeText, bottleReceipt, bottleWireSummary,
  previousBottleAttempt, rememberBottleAttempt } from "./bottleEvidence.js";

// Scope: one click / one scheduled chain, never persisted across runs or accounts.
export const createBottleTaskContext = ({ dailyGoal = false } = {}) => ({ dailyGoal, actions: new Map() });
const isObject = value => value && typeof value === "object" && !Array.isArray(value);
const roleOf = response => (response?._rawData ?? response?.data ?? response)?.role;
const numeric = value => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) ? Number(value) : null;
export const bottleStateSummary = response => {
  const role = roleOf(response), helper = role?.bottleHelpers;
  const task = numeric(role?.dailyTask?.complete?.[14]);
  const stop = numeric(helper?.helperStopTime);
  // Only whitelisted non-credential fields; helper timer is NOT reward maturity.
  return `日常14=${task ?? "缺失"}，助手截止时间=${stop ?? "缺失"}，助手字段=${isObject(helper) ? Object.keys(helper).filter(k => /^[a-zA-Z0-9_]{1,32}$/.test(k)).sort().slice(0, 12).join("/") || "空" : "缺失"}`;
};
export const inspectBottleState = (response, dailyGoal = false) => {
  const role = roleOf(response);
  if (!isObject(role)) return { status: "warning", detail: "盐罐结果待核验：未返回角色状态，未发送领取" };
  if (dailyGoal && numeric(role.dailyTask?.complete?.[14]) === -1) {
    return { status: "skipped", detail: "今日盐罐日常任务已完成，本次日常链不再重复领取" };
  }
  if (!isObject(role.bottleHelpers)) return { status: "warning", detail: "盐罐结果待核验：缺少助手状态，未发送领取" };
  // Existing protocol has no verified reward-ready flag. Permit one explicit claim,
  // never infer availability from helperStopTime or invent a numeric error meaning.
  return { status: "request", detail: "已读取助手状态，本轮最多领取一次" };
};
const stoppedError = () => Object.assign(new Error("用户已停止，未发送后续盐罐请求"), { stopped: true });
const errorCode = error => Number(error?.code) || Number(String(error?.message || "").match(/^服务器错误\s*[:：]\s*(\d+)/)?.[1]);

export async function runBottleAction({ context, tokenId, kind, send, connect = async () => {}, stopped = () => false, delay = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (stopped()) throw stoppedError();
  const key = JSON.stringify([String(tokenId), kind]);
  const prior = context.actions.get(key);
  if (prior) {
    const outcome = await prior;
    if (stopped()) throw stoppedError();
    if (outcome.error) throw outcome.error;
    const result = outcome.result;
    return { ...result, status: ["completed", "skipped"].includes(result.status) ? "skipped" : result.status,
      consoleDetail: `本轮${kind === "claim" ? "盐罐领取" : "盐罐重置"}复用前序结果（${result.status}），未重复发送`,
      detail: `本轮${kind === "claim" ? "盐罐领取" : "盐罐重置"}复用前序结果（${result.status}），未重复发送；${result.detail.split("；")[0]}`, reused: true };
  }
  const check = () => { if (stopped()) throw stoppedError(); };
  let claimRequests = 0;
  const request = async (cmd, params = {}, phase = "盐罐操作") => {
    check();
    if (cmd === "bottlehelper_claim") claimRequests++;
    try { return await send(cmd, params, 5000); }
    catch (error) {
      if (error && typeof error === "object" && !error.stopped) {
        error.requestCmd ||= cmd;
        error.bottleStage = phase;
        // Claim classification requires the original exact server message.
        if (cmd !== "bottlehelper_claim") error.message = `${error.message || "未知错误"}；阶段=${phase}；命令=${cmd}；本轮领取请求${claimRequests}次`;
      }
      throw error;
    }
  };
  const pause = async ms => {
    for (let left = ms; left > 0; left -= 100) { check(); await delay(Math.min(left, 100)); }
    check();
  };
  let queryRetries = 0;
  const readRole = async phase => {
    for (let attempt = 0; ; attempt++) {
      try { return await request("role_getroleinfo", {}, phase); }
      catch (error) {
        if (error?.stopped || error?.haltDaily || errorCode(error) !== 200400 || attempt >= 2) throw error;
        queryRetries++;
        await pause([1500, 3000][attempt]);
      }
    }
  };
  // Install the promise before invoking any asynchronous operation.
  const pending = Promise.resolve().then(async () => {
    check(); await connect(); check();
    if (kind === "reset") {
      await request("bottlehelper_stop", {}, "停止盐罐计时");
      await delay(500);
      try { await request("bottlehelper_start", {}, "重新开始盐罐计时"); }
      catch (error) {
        if (error && typeof error === "object" && !error.stopped) error.message = `盐罐停止计时已确认，重新开始未完成：${error.message || "未知原因"}`;
        throw error;
      }
      return { status: "completed", detail: "盐罐计时重置已确认（本轮仅执行一次）" };
    }
    if (kind !== "claim") throw new Error("不支持的盐罐操作");
    const before = await readRole("领取前状态查询");
    const beforeSnapshot = bottleSnapshot(before);
    const preflight = inspectBottleState(before, context.dailyGoal);
    if (preflight.status !== "request") return { ...preflight, detail: `${preflight.detail}；${bottleStateSummary(before)}` };
    const previous = previousBottleAttempt(tokenId);
    let response, rejected;
    try { response = await request("bottlehelper_claim", {}, "发送盐罐领取"); }
    catch (error) { rejected = error; }
    const code = rejected ? errorCode(rejected) : 0;
    const receipt = bottleReceipt(response);
    rememberBottleAttempt(tokenId, rejected ? "error" : receipt.confirmed ? "receipt" : "pending", code);
    if (rejected && (rejected.stopped || rejected.haltDaily)) {
      rejected.message += `；阶段=发送盐罐领取；命令=bottlehelper_claim；本轮领取请求${claimRequests}次；本轮盐罐领取仅发送一次；${previous}；${bottleWireSummary(rejected)}`;
      throw rejected;
    }
    if (rejected && isNoClaimableBottle(rejected, "bottlehelper_claim")) {
      return { status: "skipped", detail: `服务端明确提示无可领取盐罐；${previous}` };
    }
    if (rejected && (code !== 2000150 || rejected.requestCmd && rejected.requestCmd !== "bottlehelper_claim")) {
      rejected.message += `；阶段=发送盐罐领取；命令=bottlehelper_claim；本轮领取请求${claimRequests}次；本轮盐罐领取仅发送一次；领取前[${bottleSnapshotText(beforeSnapshot)}]；${previous}；${bottleWireSummary(rejected)}`;
      throw rejected;
    }
    let after, readFailure = "";
    // Give the role query its own spacing; never resend the claim after any outcome.
    try { await pause(1200); after = await readRole("领取后状态核验"); }
    catch (readError) {
      if (readError?.stopped || readError?.haltDaily) {
        readError.message += `；此前盐罐领取${rejected ? `返回${code}` : "已响应"}，未重新领取；${rejected ? bottleWireSummary(rejected) : receipt.summary}；${previous}`;
        throw readError;
      }
      readFailure = `；读回失败：${readError?.message || "无详细原因"}`;
    }
    const afterSnapshot = bottleSnapshot(after);
    // Push only fields needed to compare attempts; never repeat two full role snapshots.
    const brief = snapshot => {
      const entries = Object.entries(snapshot.values).filter(([key]) => /(?:^helperStopTime$|\.(?:obtainCnt|endTime)$)/.test(key));
      return `日常14=${snapshot.daily ?? "缺失"},${entries.map(([key, value]) => `${key.replace("bottleHelper.", "罐")}:${value}`).join(",") || "助手关键字段缺失"}`;
    };
    const change = bottleChangeText(beforeSnapshot, afterSnapshot);
    const evidence = `本轮领取请求1次，查询重试${queryRetries}次；${rejected ? bottleWireSummary(rejected) : receipt.compact}；${rejected || !receipt.confirmed ? `${previous}；领取前[${brief(beforeSnapshot)}]；领取后[${brief(afterSnapshot)}]` : `领取前后：日常14=${beforeSnapshot.daily ?? "缺失"}→${afterSnapshot.daily ?? "缺失"}`}；${change}${readFailure}`;
    const consoleEvidence = `本轮领取请求1次，查询重试${queryRetries}次；${previous}；${rejected ? bottleWireSummary(rejected) : receipt.summary}；领取前[${bottleSnapshotText(beforeSnapshot)}]；领取后[${bottleSnapshotText(afterSnapshot)}]；${change}${readFailure}`;
    if (rejected) {
      // The daily goal is not evidence of a reward. Keep every unknown 2000150 visible.
      return { status: "warning", verificationRequired: true,
        consoleDetail: `盐罐领取返回2000150，可领取条件未确认，未自动重试；${consoleEvidence}`,
        detail: `盐罐领取结果待核验：服务器错误2000150，可领取条件未确认，未自动重试；${evidence}` };
    }
    if (receipt.confirmed) {
      return { status: "completed", verificationRequired: false,
        consoleDetail: `盐罐领取回包含奖励；${consoleEvidence}`,
        detail: `盐罐领取回包含奖励（不以助手计时判断可领）；${evidence}` };
    }
    return { status: "warning", verificationRequired: true,
      consoleDetail: `盐罐领取已响应，奖励到账待核验；未自动重试；${consoleEvidence}`,
      detail: `盐罐领取已响应，奖励到账待核验：尚无匹配请求的明确奖励条目；${evidence}；${receipt.summary.split("；").filter(v => v.startsWith("回包字段=") || v.startsWith("奖励数值摘要=")).join("；")}` };
  }).then(result => ({ result }), error => ({ error }));
  context.actions.set(key, pending);
  const outcome = await pending;
  if (outcome.error) throw outcome.error;
  return outcome.result;
}
