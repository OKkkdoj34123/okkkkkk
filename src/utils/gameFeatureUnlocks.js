export const DREAM_UNLOCK_LEVEL = 1000;
export const GENIE_UNLOCK_LEVEL = 3000;
// 功法挂机残卷：仅主线 levelId 严格大于 8001 时自动领取。
// 用“AFTER”明确表达这是 > 8001，而不是 >= 8001。
export const LEGACY_HANGUP_UNLOCK_AFTER_LEVEL = 8001;

/**
 * Read the main-stage level from either a role object or a role-info response.
 * Do not fall back to role.level because that is the player level, not the
 * main-stage progress used by feature unlock rules.
 *
 * @param {object|null|undefined} source
 * @returns {number|null}
 */
export function getMainStageLevel(source) {
  const role = source?.role || source?.data?.role || source;
  const rawLevel = role?.levelId;
  if (rawLevel === null || rawLevel === undefined || rawLevel === "") {
    return null;
  }

  const level = Number(rawLevel);
  return Number.isFinite(level) && level >= 0 ? Math.trunc(level) : null;
}

/** Unknown progress keeps the previous behavior and allows the request. */
export function meetsMainStageRequirement(source, requiredLevel) {
  const level = getMainStageLevel(source);
  return level === null || level >= requiredLevel;
}
