/**
 * 营地智能挑战决策规则（纯函数，便于单元测试）
 *
 * 规则：按战力从低到高挑最弱对手，赢够 3 场即停；
 * 每天 10 次挑战机会用完后若仍不足 3 胜，改打宠物补足（宠物不占次数）。
 */

/** 目标胜场 */
export const CAMP_WINS_TARGET = 3;
/** 每日挑战自然人的机会上限 */
export const CAMP_DAILY_ATTACK_LIMIT = 10;
/** 打宠物的最大尝试次数，防止战力不足时死循环 */
export const CAMP_PET_ATTEMPT_LIMIT = 30;

/** 是否已经赢够目标场数 */
export const hasEnoughWins = (winCount) =>
  Number(winCount) >= CAMP_WINS_TARGET;

/** 是否还有挑战自然人的次数 */
export const hasAttacksLeft = (attackCount) =>
  Number(attackCount) < CAMP_DAILY_ATTACK_LIMIT;

/**
 * 按战力升序排列可挑战目标（最弱在前）。
 * 战力来源优先级：传入的 powerById > 目标自带 power > 0。
 * @param {Array<object>} targets 目标数组，含 roleId 字段
 * @param {object} powerById roleId -> 战力 映射
 * @returns {Array<object>} 新数组，不改原数组
 */
export const sortTargetsByPower = (targets, powerById = {}) => {
  if (!Array.isArray(targets)) return [];
  const powerOf = (target) => {
    const key = String(target?.roleId ?? target?.id ?? "");
    const fromMap = Number(powerById[key]);
    if (Number.isFinite(fromMap)) return fromMap;
    const own = Number(target?.power);
    return Number.isFinite(own) ? own : 0;
  };
  return [...targets].sort((a, b) => powerOf(a) - powerOf(b));
};

/**
 * 判断本轮智能挑战是否应结束。
 * @param {object} state { winCount, attackCount, petAttempts }
 * @returns {{done:boolean, usePets:boolean, reason:string}}
 */
export const decideNextStep = ({ winCount = 0, attackCount = 0 } = {}) => {
  if (hasEnoughWins(winCount))
    return { done: true, usePets: false, reason: "已赢够目标场数" };
  if (!hasAttacksLeft(attackCount))
    return { done: false, usePets: true, reason: "挑战次数已用完，改打宠物补足" };
  return { done: false, usePets: false, reason: "继续挑战最弱对手" };
};

/** 连续多少次"次数已用完"错误后判定当日次数耗尽（放宽避免偶发误判） */
export const CAMP_NO_CHANCE_THRESHOLD = 5;

/** 服务器"次数已用完/出了点小问题"错误码 */
export const isNoChanceError = (error) => {
  const message = String(error?.message || error || "");
  return message.includes("200020") || message.includes("出了点小问题");
};

/**
 * 连续出现次数耗尽错误时，提前结束自然人挑战转打宠物。
 * @returns {boolean}
 */
export const shouldStopNaturalAttacks = (consecutiveNoChance = 0) =>
  Number(consecutiveNoChance) >= CAMP_NO_CHANCE_THRESHOLD;
