// FORMATION_DISPATCH_V1
// 手动批量阵容槽1下发：配置归一化与校验。
// 不注册到定时任务/自动周计划。

export const FORMATION_DISPATCH_TEAM_ID = 1;
export const FORMATION_DISPATCH_MAX_LEVEL = 5500;

export const createDefaultFormationDispatchConfig = () => ({
  teamId: FORMATION_DISPATCH_TEAM_ID,
  syncLevel: false,
  slots: Array.from({ length: 5 }, (_, position) => ({
    position,
    heroId: null,
    level: null,
  })),
});

const toIntegerOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.trunc(numeric);
};

export const normalizeFormationDispatchConfig = (raw = {}) => {
  const defaults = createDefaultFormationDispatchConfig();
  const rawSlots = Array.isArray(raw?.slots) ? raw.slots : [];

  const slots = defaults.slots.map((fallback) => {
    const found =
      rawSlots.find((item) => Number(item?.position) === fallback.position) ||
      rawSlots[fallback.position] ||
      {};
    const heroId = toIntegerOrNull(found?.heroId);
    const level = toIntegerOrNull(found?.level);

    return {
      position: fallback.position,
      heroId: heroId && heroId > 0 ? heroId : null,
      level:
        level && level >= 1 && level <= FORMATION_DISPATCH_MAX_LEVEL
          ? level
          : null,
    };
  });

  return {
    teamId: FORMATION_DISPATCH_TEAM_ID,
    syncLevel: raw?.syncLevel === true,
    slots,
  };
};

export const validateFormationDispatchConfig = (raw = {}) => {
  const config = normalizeFormationDispatchConfig(raw);
  const errors = [];
  const missingPositions = config.slots
    .filter((slot) => !slot.heroId)
    .map((slot) => slot.position + 1);

  if (missingPositions.length) {
    errors.push(`位置 ${missingPositions.join("、")} 尚未选择英雄`);
  }

  const selectedIds = config.slots.map((slot) => slot.heroId).filter(Boolean);
  if (new Set(selectedIds).size !== selectedIds.length) {
    errors.push("同一英雄不能重复出现在多个位置");
  }

  for (const slot of config.slots) {
    if (
      slot.level !== null &&
      (!Number.isInteger(slot.level) ||
        slot.level < 1 ||
        slot.level > FORMATION_DISPATCH_MAX_LEVEL)
    ) {
      errors.push(
        `位置 ${slot.position + 1} 的等级必须为1-${FORMATION_DISPATCH_MAX_LEVEL}整数`,
      );
    }
  }

  return { valid: errors.length === 0, errors, config };
};
