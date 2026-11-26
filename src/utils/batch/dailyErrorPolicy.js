// BATCH_DAILY_WARNING_V1: only enabled by the batch daily entry point.
const WARNING_CODES = new Set([
  200020, 200160, 400000, 400190, 700020, 1000020,
  1400010, 2300190, 3300050, 3300060, 3500020,
]);

// These are batch-daily outcomes, not a global interpretation of server codes.
// Keep 200020 compatibility limited to the two reward endpoints requested by
// the maintainer; it means normal termination here, not verified reward credit.
function normalDailyOutcome(code, cmd, params) {
  if (code === 200020 && ["task_claimdailyreward", "task_claimweekreward"].includes(cmd)) {
    return { status: "completed", message: "正常结束（按日常领奖兼容规则处理，本步骤不重发）" };
  }
  const normalClaims = {
    system_signinreward: { 400190: "当前没有可领取的签到奖励" },
    legion_signin: { 2300190: "今天已经签到" },
    discount_claimreward: { 1000020: "今天已经领取每日礼包" },
    card_claimreward: { 1000020: "今天已经领取该礼包" },
    genie_buysweep: { 3300050: "免费扫荡券已达领取上限" },
    task_claimdailypoint: { 700020: "该任务奖励已经领取" },
    activity_recyclewarorderrewardclaim: { 3500020: "当前没有可领取的通行证奖励" },
  };
  let message = normalClaims[cmd]?.[code];
  if (code === 1400010 && cmd === "card_claimreward" && params?.cardId === 4003) {
    message = "未购买永久卡，无需领取";
  }
  if (code === 3300060 && cmd === "genie_sweep" && [1, 2, 3, 4].includes(params?.genieId) && params?.sweepCnt == null) {
    message = "当前未满足该灯神免费扫荡条件";
  }
  if (cmd === "gacha_drawreward" && params?.num === 1 && params?.isGroup === false) {
    if (code === 400000) message = "当前免费扭蛋不可领取";
    if (code === 1000020) message = "今天已经领取免费扭蛋奖励";
  }
  return message ? { status: "skipped", message: `正常跳过：${message}` } : null;
}

export function classifyBatchDailyError(error) {
  const originalMessage = String(error?.message || error || "未知错误");
  const rawCode = error?.code;
  let code = null;
  if (typeof rawCode === "number" && Number.isSafeInteger(rawCode)) {
    code = rawCode;
  } else if (typeof rawCode === "string" && /^\d+$/.test(rawCode.trim())) {
    const parsed = Number(rawCode.trim());
    if (Number.isSafeInteger(parsed)) code = parsed;
  }
  if (code === null) {
    const match = originalMessage.match(/^服务器错误\s*[:：]\s*(\d+)\s*[-－—]/);
    if (match && Number.isSafeInteger(Number(match[1]))) code = Number(match[1]);
  }
  const cmd = String(error?.requestCmd || "").toLowerCase();
  const normal = !error?.haltDaily && !error?.stopped && !error?.notExecuted
    ? normalDailyOutcome(code, cmd, error?.requestParams)
    : null;
  if (normal) return { code, level: "normal", originalMessage, ...normal };
  const ignored = (code === 12000116 && cmd === "collection_claimfreereward")
    || (code === 2600040 && cmd === "dungeon_selecthero");
  const level = ignored ? "ignore" : WARNING_CODES.has(code) ? "warning" : "error";
  const description = originalMessage.replace(/^服务器错误\s*[:：]\s*\d+\s*[-－—]\s*/, "");
  return {
    code,
    level,
    originalMessage,
    message: level === "warning" && code === 200020
      ? `${description}（执行结果未确认）`
      : description,
  };
}

