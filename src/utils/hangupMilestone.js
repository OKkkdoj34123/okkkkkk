/**
 * 逢关升级挂机的里程碑判定（纯函数，便于测试）
 *
 * 每通过 UPGRADE_STEP 关触发一次挂机升级。为避免关卡同步跳变导致
 * 精确命中某个关卡号被跳过，改用「已跨过的里程碑」比较：
 * 只要里程碑推进就补一次升级，同一区间不重复。
 */

/** 每多少关触发一次升级挂机 */
export const UPGRADE_STEP = 50;

/**
 * 计算某个关卡对应的已通过里程碑数。
 * 默认步长下：1-50→0, 51-100→1, 101-150→2, 151-200→3 ...
 * @param {number} level 关卡号（即将挑战的关卡）
 * @param {number} [step] 步长，默认 UPGRADE_STEP
 * @returns {number} 已通过的里程碑数
 */
export const getUpgradeMilestone = (level, step = UPGRADE_STEP) => {
  const value = Number(level);
  const size = Number(step) > 0 ? Number(step) : UPGRADE_STEP;
  if (!Number.isFinite(value) || value <= size) return 0;
  return Math.floor((value - 1) / size);
};

/**
 * 判断是否需要触发升级挂机。
 * @param {number} level 当前关卡
 * @param {number|null|undefined} lastMilestone 上次已升级的里程碑
 * @param {number} [step] 步长，默认 UPGRADE_STEP
 * @returns {{upgrade:boolean, milestone:number, crossedLevel:number}}
 */
export const checkUpgradeMilestone = (level, lastMilestone, step = UPGRADE_STEP) => {
  const size = Number(step) > 0 ? Number(step) : UPGRADE_STEP;
  const milestone = getUpgradeMilestone(level, size);
  const previous =
    lastMilestone === null || lastMilestone === undefined
      ? 0
      : Number(lastMilestone) || 0;

  if (milestone > previous) {
    return { upgrade: true, milestone, crossedLevel: milestone * size };
  }
  return { upgrade: false, milestone, crossedLevel: 0 };
};
