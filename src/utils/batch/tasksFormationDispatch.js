// FORMATION_DISPATCH_RELEASE_V1
// 手动批量阵容槽1下发。
// 正式版：保留已验证的 hero_exchange 当前位置更换；等级同步采用慢速发送，
// 200400“操作太快”自动退避一次；安全策略只升不降，目标等级低于当前等级时直接跳过，
// 不再调用 hero_rebirth，避免由本功能主动重置精铁装备与鱼灵。
// 不猜测 presetteam_setteam 请求体，不接入定时任务/自动周计划。

import {
  normalizeFormationDispatchConfig,
  validateFormationDispatchConfig,
} from "./formationDispatchConfig.js";

const LEVEL_ORDER_THRESHOLDS = [
  { level: 100, order: 1 },
  { level: 200, order: 2 },
  { level: 300, order: 3 },
  { level: 500, order: 4 },
  { level: 700, order: 5 },
  { level: 900, order: 6 },
  { level: 1100, order: 7 },
  { level: 1300, order: 8 },
  { level: 1500, order: 9 },
  { level: 1800, order: 10 },
  { level: 2100, order: 11 },
  { level: 2400, order: 12 },
  { level: 2800, order: 13 },
  { level: 3200, order: 14 },
  { level: 3600, order: 15 },
  { level: 4000, order: 16 },
  { level: 4500, order: 17 },
  { level: 5000, order: 18 },
  { level: 5500, order: 19 },
];

const UPGRADE_OPTIONS = [50, 10, 5, 1];

const getNextOrderLevel = (currentLevel) => {
  for (const threshold of LEVEL_ORDER_THRESHOLDS) {
    if (currentLevel < threshold.level) return threshold.level;
  }
  return null;
};

const getOrder = (level) => {
  let order = 0;
  for (const threshold of LEVEL_ORDER_THRESHOLDS) {
    if (level >= threshold.level) order = threshold.order;
    else break;
  }
  return order;
};

const parseHeroId = (value) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number" || typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(value?.heroId ?? value?.id ?? value?.heroID ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const getTeamHeroes = (teamInfo) => {
  if (!teamInfo || typeof teamInfo !== "object") return [];

  if (Array.isArray(teamInfo)) {
    return teamInfo
      .map((hero, index) => ({
        position:
          hero && typeof hero === "object" && hero?.battleTeamSlot !== undefined
            ? Number(hero.battleTeamSlot)
            : index,
        heroId: parseHeroId(hero),
      }))
      .filter(
        (hero) =>
          Number.isInteger(hero.position) &&
          hero.position >= 0 &&
          hero.position <= 4 &&
          hero.heroId > 0,
      )
      .sort((a, b) => a.position - b.position);
  }

  const entries = Object.entries(teamInfo);
  const numericKeys = entries
    .map(([key]) => Number(key))
    .filter((key) => Number.isInteger(key));
  const oneBasedKeys =
    numericKeys.length > 0 &&
    !numericKeys.includes(0) &&
    numericKeys.every((key) => key >= 1 && key <= 5);

  return entries
    .map(([key, hero]) => {
      const rawPosition =
        hero && typeof hero === "object" && hero?.battleTeamSlot !== undefined
          ? Number(hero.battleTeamSlot)
          : oneBasedKeys
            ? Number(key) - 1
            : Number(key);

      return {
        position: rawPosition,
        heroId: parseHeroId(hero),
      };
    })
    .filter(
      (hero) =>
        Number.isInteger(hero.position) &&
        hero.position >= 0 &&
        hero.position <= 4 &&
        hero.heroId > 0,
    )
    .sort((a, b) => a.position - b.position);
};

const parsePresetState = (presetResult, teamId = 1) => {
  const wrapper = presetResult?.presetTeamInfo ?? presetResult ?? {};
  const teamDict = wrapper?.presetTeamInfo ?? wrapper ?? {};
  const useTeamId =
    Number(
      wrapper?.useTeamId ??
        teamDict?.useTeamId ??
        presetResult?.useTeamId ??
        teamId,
    ) || teamId;

  const teamNode =
    teamDict?.[teamId] ??
    teamDict?.[String(teamId)] ??
    wrapper?.[teamId] ??
    wrapper?.[String(teamId)] ??
    {};

  const teamIds = Object.keys(teamDict || {})
    .filter((key) => /^\d+$/.test(String(key)))
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);

  return {
    useTeamId,
    teamInfo: teamNode?.teamInfo || {},
    teamIds,
    raw: presetResult,
  };
};

const getRoleBattleHeroes = (role) => {
  const candidates = [
    role?.battleTeam,
    role?.battleTeamInfo,
    role?.teamInfo,
    role?.battle?.team,
  ];

  for (const candidate of candidates) {
    const heroes = getTeamHeroes(candidate);
    if (heroes.length) return heroes;
  }
  return [];
};

const compareFormation = (current, targetSlots) => {
  const map = new Map(current.map((hero) => [hero.position, hero.heroId]));
  const mismatches = targetSlots
    .filter((target) => Number(map.get(target.position)) !== Number(target.heroId))
    .map(
      (target) =>
        `位置${target.position + 1}:期望${target.heroId}/实际${
          map.get(target.position) || "空"
        }`,
    );

  return {
    ok: mismatches.length === 0 && current.length === 5,
    mismatches,
  };
};

export function createTasksFormationDispatch(deps) {
  const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    connectionQueue,
    batchSettings,
    tokenStore,
    addLog,
    message,
    currentRunningTokenId,
    delayConfig,
  } = deps;

  const actionDelay = () =>
    Math.max(
      300,
      Number(delayConfig?.action ?? batchSettings?.commandDelay ?? 500) || 500,
    );
  const delay = (ms = actionDelay()) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const send = (tokenId, cmd, body = {}, timeout = 10000) =>
    tokenStore.sendMessageWithPromise(tokenId, cmd, body, timeout);

  // 正式版：等级同步单独降速，不拖慢已经验证稳定的阵容更换。
  // 遇到服务器200400时只对当前等级命令退避并重试1次，不从头重跑整个账号。
  const LEVEL_UPGRADE_DELAY = 1200;
  const LEVEL_ORDER_DELAY = 1500;
  const LEVEL_RATE_LIMIT_BACKOFF = 3000;

  const isRateLimitError = (error) => {
    const code = Number(error?.code ?? error?.errorCode ?? error?.errCode ?? 0);
    const text = String(error?.message || error || "");
    return code === 200400 || text.includes("200400") || text.includes("操作太快");
  };

  const sendLevelCommand = async (
    tokenId,
    cmd,
    body,
    postDelay = LEVEL_UPGRADE_DELAY,
  ) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertNotStopped();
      try {
        const result = await send(tokenId, cmd, body);
        await delay(postDelay);
        return result;
      } catch (error) {
        if (!isRateLimitError(error) || attempt >= 1) throw error;
        await delay(LEVEL_RATE_LIMIT_BACKOFF);
      }
    }
    return null;
  };

  const assertNotStopped = () => {
    if (shouldStop.value) throw new Error("任务已停止");
  };

  const fetchRole = async (tokenId) => {
    const result = await send(tokenId, "role_getroleinfo", {});
    await delay();
    return result?.role || result || {};
  };

  const fetchPresetRaw = async (tokenId, teamId = 1) => {
    const result = await send(tokenId, "presetteam_getinfo", {});
    await delay();
    return parsePresetState(result, teamId);
  };

  const switchTeam = async (tokenId, teamId, verify = true) => {
    await send(tokenId, "presetteam_saveteam", { teamId });
    await delay();

    if (!verify) return null;

    const state = await fetchPresetRaw(tokenId, teamId);
    if (Number(state.useTeamId) !== Number(teamId)) {
      throw new Error(
        `阵容槽切换校验失败：目标${teamId}，当前${state.useTeamId}`,
      );
    }
    return state;
  };

  // 项目现有“阵容助手”的刷新逻辑会切到另一个槽再切回，避免 presetteam_getinfo 偶发读到旧快照。
  const forceRefreshTeam = async (tokenId, teamId = 1) => {
    const before = await fetchPresetRaw(tokenId, teamId);
    const otherTeamId = before.teamIds.find((id) => Number(id) !== Number(teamId));

    if (otherTeamId) {
      await switchTeam(tokenId, otherTeamId, false);
      await switchTeam(tokenId, teamId, false);
    } else if (Number(before.useTeamId) !== Number(teamId)) {
      await switchTeam(tokenId, teamId, false);
    }

    const preset = await fetchPresetRaw(tokenId, teamId);
    const role = await fetchRole(tokenId);
    return { preset, role };
  };

  const verifyFormation = async (
    tokenId,
    targetSlots,
    { forceRefresh = false } = {},
  ) => {
    let role;
    let preset;

    if (forceRefresh) {
      const refreshed = await forceRefreshTeam(tokenId, 1);
      role = refreshed.role;
      preset = refreshed.preset;
    } else {
      role = await fetchRole(tokenId);
      preset = await fetchPresetRaw(tokenId, 1);
    }

    const roleHeroes = getRoleBattleHeroes(role);
    const presetHeroes = getTeamHeroes(preset.teamInfo);
    const roleCheck = compareFormation(roleHeroes, targetSlots);
    const presetCheck = compareFormation(presetHeroes, targetSlots);

    if (roleCheck.ok) {
      return {
        ok: true,
        source: "role.battleTeam",
        current: roleHeroes,
        mismatches: [],
      };
    }

    if (presetCheck.ok) {
      return {
        ok: true,
        source: "presetteam_getinfo",
        current: presetHeroes,
        mismatches: [],
      };
    }

    const current =
      roleHeroes.length >= presetHeroes.length ? roleHeroes : presetHeroes;
    const check = compareFormation(current, targetSlots);
    return {
      ok: false,
      source:
        roleHeroes.length >= presetHeroes.length
          ? "role.battleTeam"
          : "presetteam_getinfo",
      current,
      mismatches: check.mismatches,
      roleMismatches: roleCheck.mismatches,
      presetMismatches: presetCheck.mismatches,
    };
  };

  const exchangeAtPosition = async (
    tokenId,
    currentMap,
    position,
    targetHeroId,
  ) => {
    const currentHeroId = Number(currentMap.get(position) || 0);
    const targetId = Number(targetHeroId);

    if (currentHeroId === targetId) return false;

    if (!currentHeroId) {
      const oldTargetPosition = [...currentMap.entries()].find(
        ([, heroId]) => Number(heroId) === targetId,
      )?.[0];

      if (oldTargetPosition !== undefined) {
        await send(tokenId, "hero_gobackbattle", { slot: oldTargetPosition });
        await delay();
        currentMap.delete(oldTargetPosition);
      }

      await send(tokenId, "hero_gointobattle", {
        heroId: targetId,
        slot: position,
      });
      await delay();
      currentMap.set(position, targetId);
      return true;
    }

    // 核心修复：当前位置已有武将时，使用现有阵容助手验证过的 hero_exchange。
    // 目标武将会与当前位置武将交换养成/附着状态，而不是把整套队伍全部下阵后重新上阵。
    const oldTargetPosition = [...currentMap.entries()].find(
      ([, heroId]) => Number(heroId) === targetId,
    )?.[0];

    await send(tokenId, "hero_exchange", {
      heroId: currentHeroId,
      targetHeroId: targetId,
    });
    await delay();

    currentMap.set(position, targetId);
    if (
      oldTargetPosition !== undefined &&
      Number(oldTargetPosition) !== Number(position)
    ) {
      currentMap.set(oldTargetPosition, currentHeroId);
    }

    return true;
  };

  const replaceFormationByExchange = async (tokenId, targetSlots) => {
    let preset = await fetchPresetRaw(tokenId, 1);
    let current = getTeamHeroes(preset.teamInfo);

    // presetteam 偶发旧快照时，优先参考当前激活阵容的 role.battleTeam。
    const role = await fetchRole(tokenId);
    const roleCurrent = getRoleBattleHeroes(role);
    if (roleCurrent.length > current.length) current = roleCurrent;

    const currentMap = new Map(
      current.map((hero) => [Number(hero.position), Number(hero.heroId)]),
    );

    let exchanges = 0;
    for (const target of [...targetSlots].sort(
      (a, b) => a.position - b.position,
    )) {
      assertNotStopped();
      const changed = await exchangeAtPosition(
        tokenId,
        currentMap,
        Number(target.position),
        Number(target.heroId),
      );
      if (changed) exchanges += 1;
    }

    // 第一次先普通核验；不通过时按阵容助手同样的“切走再切回”方式刷新一次。
    let checked = await verifyFormation(tokenId, targetSlots);
    if (!checked.ok) {
      checked = await verifyFormation(tokenId, targetSlots, {
        forceRefresh: true,
      });
    }

    // 只允许一次基于真实回读状态的修复轮，避免错误状态下无限改阵。
    if (!checked.ok && checked.current.length) {
      const repairMap = new Map(
        checked.current.map((hero) => [
          Number(hero.position),
          Number(hero.heroId),
        ]),
      );

      let repaired = false;
      for (const target of [...targetSlots].sort(
        (a, b) => a.position - b.position,
      )) {
        assertNotStopped();
        if (
          Number(repairMap.get(Number(target.position))) ===
          Number(target.heroId)
        ) {
          continue;
        }

        const changed = await exchangeAtPosition(
          tokenId,
          repairMap,
          Number(target.position),
          Number(target.heroId),
        );
        if (changed) {
          repaired = true;
          exchanges += 1;
        }
      }

      if (repaired) {
        checked = await verifyFormation(tokenId, targetSlots, {
          forceRefresh: true,
        });
      }
    }

    if (!checked.ok) {
      const mismatchText =
        checked.mismatches?.join("；") || "无法取得完整的5人阵容状态";
      throw new Error(
        `阵容槽1替换后校验失败(${checked.source})：${mismatchText}`,
      );
    }

    return { exchanges, verifySource: checked.source };
  };

  const fetchHeroState = async (tokenId, heroId) => {
    const role = await fetchRole(tokenId);
    const hero = role?.heroes?.[String(heroId)] || role?.heroes?.[heroId];
    if (!hero) throw new Error(`未找到武将 ${heroId} 的状态`);
    return hero;
  };

  const ensureOrderAtCurrentLevel = async (
    tokenId,
    heroId,
    currentLevel,
    currentOrder,
  ) => {
    const expectedOrder = getOrder(currentLevel);
    let order = Number(currentOrder || 0);
    let guard = 0;

    while (order < expectedOrder && guard < 24) {
      assertNotStopped();
      await sendLevelCommand(
        tokenId,
        "hero_heroupgradeorder",
        { heroId },
        LEVEL_ORDER_DELAY,
      );
      const latest = await fetchHeroState(tokenId, heroId);
      order = Number(latest?.order ?? order + 1);
      guard += 1;
    }

    if (order < expectedOrder) {
      throw new Error(`武将 ${heroId} 进阶未达到等级${currentLevel}所需阶数`);
    }
    return order;
  };

  const applyHeroLevel = async (tokenId, target) => {
    const heroId = Number(target.heroId);
    const targetLevel = Number(target.level);
    if (!Number.isInteger(targetLevel) || targetLevel <= 0) {
      return { changed: false, skippedDowngrade: false };
    }

    const hero = await fetchHeroState(tokenId, heroId);
    let currentLevel = Number(hero?.level || 1);
    let currentOrder = Number(hero?.order || 0);

    if (currentLevel === targetLevel) {
      return {
        changed: false,
        skippedDowngrade: false,
        heroId,
        currentLevel,
        targetLevel,
      };
    }

    // 正式版安全策略只升不降。降级需要hero_rebirth，会重置/卸下部分养成状态，
    // 因此这里直接跳过，不发送任何重生、下阵或重新上阵命令。
    if (currentLevel > targetLevel) {
      return {
        changed: false,
        skippedDowngrade: true,
        heroId,
        currentLevel,
        targetLevel,
      };
    }

    currentOrder = await ensureOrderAtCurrentLevel(
      tokenId,
      heroId,
      currentLevel,
      currentOrder,
    );

    while (currentLevel < targetLevel) {
      assertNotStopped();
      const nextOrderLevel = getNextOrderLevel(currentLevel);
      const maxAllowed = nextOrderLevel
        ? nextOrderLevel - currentLevel
        : targetLevel - currentLevel;
      const remaining = targetLevel - currentLevel;
      const stepLimit = Math.min(maxAllowed, remaining);

      let upgradeNum = 1;
      for (const option of UPGRADE_OPTIONS) {
        if (option <= stepLimit) {
          upgradeNum = option;
          break;
        }
      }

      await sendLevelCommand(
        tokenId,
        "hero_heroupgradelevel",
        { heroId, upgradeNum },
        LEVEL_UPGRADE_DELAY,
      );
      currentLevel += upgradeNum;

      if (nextOrderLevel && currentLevel >= nextOrderLevel) {
        await sendLevelCommand(
          tokenId,
          "hero_heroupgradeorder",
          { heroId },
          LEVEL_ORDER_DELAY,
        );
        const latest = await fetchHeroState(tokenId, heroId);
        currentOrder = Number(latest?.order ?? currentOrder + 1);
      }
    }

    const verified = await fetchHeroState(tokenId, heroId);
    const actualLevel = Number(verified?.level || 1);
    if (actualLevel !== targetLevel) {
      throw new Error(
        `武将 ${heroId} 等级校验失败：目标${targetLevel}，实际${actualLevel}`,
      );
    }

    return {
      changed: true,
      skippedDowngrade: false,
      heroId,
      currentLevel: actualLevel,
      targetLevel,
    };
  };

  const batchFormationDispatch = async (configOverride = null) => {
    if (!selectedTokens.value.length) {
      message.warning("请先选择账号");
      return;
    }

    const validation = validateFormationDispatchConfig(
      configOverride || batchSettings?.formationDispatchConfig || {},
    );
    if (!validation.valid) {
      message.error(validation.errors.join("；"));
      return;
    }

    const config = normalizeFormationDispatchConfig(validation.config);
    const targetSlots = config.slots;
    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      const token =
        tokens.value.find((item) => item.id === tokenId) || {
          id: tokenId,
          name: String(tokenId),
        };

      let originalTeamId = null;
      let switchedToTeam1 = false;
      let operationError = null;
      let restoreError = null;
      let changedLevels = 0;
      const skippedDowngrades = [];
      let exchanges = 0;
      let verifySource = "";
      tokenStatus.value[tokenId] = "running";

      try {
        assertNotStopped();
        await ensureConnection(tokenId);

        // 完整预检先做完；缺武将时不修改阵容。
        const role = await fetchRole(tokenId);
        const heroes = role?.heroes || {};
        const missing = targetSlots.filter(
          (slot) => !heroes?.[String(slot.heroId)] && !heroes?.[slot.heroId],
        );
        if (missing.length) {
          throw new Error(
            `缺少武将：${missing.map((slot) => slot.heroId).join("、")}`,
          );
        }

        const preset = await fetchPresetRaw(tokenId, 1);
        originalTeamId = Number(preset.useTeamId || 1);

        if (originalTeamId !== 1) {
          await switchTeam(tokenId, 1);
          switchedToTeam1 = true;
        }

        // V2核心：按当前位置 hero_exchange，更接近阵容助手的“更换武将”语义。
        const formationResult = await replaceFormationByExchange(
          tokenId,
          targetSlots,
        );
        exchanges = formationResult.exchanges;
        verifySource = formationResult.verifySource;

        // 等级同步和阵容替换分阶段执行。只有用户开启开关时才触发升级/重生。
        if (config.syncLevel) {
          for (const target of targetSlots) {
            if (target.level === null) continue;
            assertNotStopped();

            const levelResult = await applyHeroLevel(tokenId, target);
            if (levelResult?.changed) changedLevels += 1;

            if (levelResult?.skippedDowngrade) {
              skippedDowngrades.push(levelResult);
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `[等级同步][${token.name}] 武将ID ${levelResult.heroId} 跳过降级：当前${levelResult.currentLevel} > 目标${levelResult.targetLevel}；安全策略只升不降，未执行重生`,
                type: "warning",
              });
            }
          }

          // 正式版等级同步只会向上升级，不再执行重生/下阵；完成后核验阵容未被破坏。
          let afterLevel = await verifyFormation(tokenId, targetSlots);
          if (!afterLevel.ok) {
            afterLevel = await verifyFormation(tokenId, targetSlots, {
              forceRefresh: true,
            });
          }
          if (!afterLevel.ok) {
            throw new Error(
              `等级同步后阵容校验失败：${
                afterLevel.mismatches?.join("；") || "无法取得完整的5人阵容状态"
              }`,
            );
          }
          verifySource = afterLevel.source;
        }
      } catch (error) {
        operationError = error;
      } finally {
        if (switchedToTeam1 && originalTeamId && originalTeamId !== 1) {
          try {
            await switchTeam(tokenId, originalTeamId);
          } catch (error) {
            restoreError = error;
          }
        }

        if (operationError || restoreError) {
          tokenStatus.value[tokenId] = "failed";
          const parts = [];
          if (operationError) {
            parts.push(operationError.message || String(operationError));
          }
          if (restoreError) {
            parts.push(
              `恢复原阵容槽${originalTeamId}失败：${
                restoreError.message || restoreError
              }`,
            );
          }
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `[阵容下发][${token.name}] 失败：${parts.join("；")}`,
            type: "error",
          });
        } else {
          tokenStatus.value[tokenId] = "completed";
          addLog({
            time: new Date().toLocaleTimeString(),
            message: config.syncLevel
              ? `[阵容下发][${token.name}] 完成：槽1按原位置更换${exchanges}处；向上调整等级${changedLevels}名；跳过降级${skippedDowngrades.length}名；校验=${verifySource}；已恢复原阵容槽${originalTeamId}`
              : `[阵容下发][${token.name}] 完成：槽1按原位置更换${exchanges}处；未执行等级同步；校验=${verifySource}；已恢复原阵容槽${originalTeamId}`,
            type: "success",
          });
        }

        try {
          tokenStore.closeWebSocketConnection(tokenId);
        } catch (_) {}
        try {
          releaseConnectionSlot(tokenId);
        } catch (_) {}
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);
    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
  };

  return { batchFormationDispatch };
}

