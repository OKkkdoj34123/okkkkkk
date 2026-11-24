import {
  CAMP_DAILY_ATTACK_LIMIT,
  CAMP_PET_ATTEMPT_LIMIT,
  CAMP_WINS_TARGET,
  decideNextStep,
  hasEnoughWins,
  sortTargetsByPower,
} from "./campChallengePlanner.js";

/**
 * 营地挑战类任务
 * 包含: batchCampChallenge, batchCampChallengePet, batchCampClaimTasks,
 *       batchCampChallengeSmart（挑最弱对手凑胜场）
 */

/**
 * 创建营地挑战类任务执行器
 * @param {object} deps - 依赖项
 * @returns {object} 任务函数集合
 */
export function createTasksCampChallenge(deps) {
  const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    tokenStore,
    addLog,
    message,
    currentRunningTokenId,
    loadSettings,
  } = deps;

  /**
   * 一键营地挑战
   */
  const batchCampChallenge = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);
      let ownsSlot = false;
      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始营地挑战: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId, 2, (owned) => {
          ownsSlot = owned;
        });
        if (shouldStop.value) return;

        // 1. 获取我方阵容配置（参考 QuenchAnalysisCard.refreshHeroes）
        const [presetTeamResult, roleInfoResult] = await Promise.all([
          tokenStore.sendMessageWithPromise(
            tokenId,
            "presetteam_getinfo",
            {},
            5000,
          ),
          tokenStore.sendMessageWithPromise(
            tokenId,
            "role_getroleinfo",
            {},
            15000,
          ),
        ]);

        const lordWeaponId = roleInfoResult?.role?.lordWeaponId || 0;

        // 解析阵容数据，优先使用竞技场阵容
        const tokenSettings = loadSettings ? loadSettings(tokenId) : {};
        const formationId = String(tokenSettings?.arenaFormation || 1);
        const root =
          presetTeamResult?.presetTeamInfo?.presetTeamInfo ||
          presetTeamResult?.presetTeamInfo ||
          {};
        const teamInfoData =
          root[formationId]?.teamInfo || root["1"]?.teamInfo || {};

        const battleTeam = {};
        for (const [pos, hero] of Object.entries(teamInfoData)) {
          const hid = hero?.heroId ?? hero?.id;
          if (hid) {
            battleTeam[pos] = Number(hid);
          }
        }

        if (Object.keys(battleTeam).length === 0) {
          throw new Error(`无法获取阵容${formationId}数据`);
        }

        const teamSetParams = {
          lordWeaponId,
          petUId: "",
          battleTeam,
        };

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 使用阵容${formationId}: ${Object.values(battleTeam).join(", ")}`,
          type: "info",
        });

        // 2. 获取营地信息和挑战目标
        const res = await tokenStore.sendMessageWithPromise(
          tokenId,
          "club_getinfo",
          {},
          8000,
        );

        // 检查今日挑战次数
        const now = new Date();
        const todayKey =
          String(now.getFullYear() % 100).padStart(2, "0") +
          String(now.getMonth() + 1).padStart(2, "0") +
          String(now.getDate()).padStart(2, "0");
        const siege = res?.siege || {};
        const attackMap = siege.attackMap || {};
        const todayAttack = attackMap[todayKey] || {};
        const attackCnt = todayAttack.attackCnt || 0;
        const maxAttacks = 10;

        if (attackCnt >= maxAttacks) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 今日挑战次数已达上限(${attackCnt}/${maxAttacks})`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 今日已挑战 ${attackCnt}/${maxAttacks} 次`,
          type: "info",
        });

        const oppoMap = res?.club?.oppoMap || {};
        const opponents = Object.entries(oppoMap).sort(
          ([a], [b]) => Number(a) - Number(b),
        );

        if (opponents.length === 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 没有可挑战的目标`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        // 3. 收集所有可挑战的防守者，随机顺序挑战（最多3次）
        const remainingAttacks = Math.min(maxAttacks - attackCnt, 3);
        let attackCount = 0;

        // 收集所有未击败的防守者到一个池子
        const availableTargets = [];
        for (const [oppoKey, opponent] of opponents) {
          const defenders = opponent.defenders || {};
          for (const [nodeId, defender] of Object.entries(defenders)) {
            if (!defender.defeated) {
              availableTargets.push({
                oppoKey,
                opponentName: opponent.name,
                nodeId,
                defender,
              });
            }
          }
        }

        if (availableTargets.length === 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 所有目标均已击败或无可挑战目标`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        // 随机打乱顺序
        for (let i = availableTargets.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [availableTargets[i], availableTargets[j]] = [
            availableTargets[j],
            availableTargets[i],
          ];
        }

        for (const target of availableTargets) {
          if (shouldStop.value || attackCount >= remainingAttacks) break;

          const { opponentName, nodeId, defender } = target;

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 挑战目标(${attackCount + 1}/${remainingAttacks}): ${opponentName} - ${defender.name} (节点${nodeId})`,
            type: "info",
          });

          try {
            // 获取目标阵容
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "club_gettargetteam",
              { targetId: defender.roleId },
              5000,
            );

            // 发起挑战
            const attackRes = await tokenStore.sendMessageWithPromise(
              tokenId,
              "club_attack",
              {
                nodeId: Number(nodeId),
                targetId: defender.roleId,
                challengeCnt: defender.challengeCnt || 0,
                failCnt: defender.failCnt || 0,
                useItem: false,
                teamSetParams,
              },
              8000,
            );

            // 判断战斗结果
            const battleResult =
              attackRes?.battleData?.result?.accept?.ext?.curHP;
            const isWin = battleResult === 0;
            const rewardCount = attackRes?.reward?.length || 0;

            attackCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${isWin ? "胜利" : "失败"}: ${opponentName} - ${defender.name}${rewardCount > 0 ? ` (获得${rewardCount}个奖励)` : ""}`,
              type: isWin ? "success" : "error",
            });

            if (isWin) {
              defender.defeated = true;
            }
          } catch (err) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 挑战 ${defender.name} 失败: ${err.message || "未知错误"}`,
              type: "error",
            });
          }
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 营地挑战完成，共挑战 ${attackCount} 次`,
          type: "info",
        });

        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 营地挑战失败: ${error.message || "未知错误"}`,
          type: "error",
        });
      } finally {
        // 只释放本次自己占用的槽位，避免误关其他账号共用的连接
        if (ownsSlot) {
          tokenStore.closeWebSocketConnection(tokenId);
          releaseConnectionSlot();
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 连接已关闭`,
            type: "info",
          });
        }
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量营地挑战结束");

    // 领取任务奖励
    await batchCampClaimTasks();
  };

  /**
   * 一键营地挑战宠物
   */
  const batchCampChallengePet = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const maxRounds = 3;
    for (let round = 1; round <= maxRounds; round++) {
      if (shouldStop.value) break;

      const taskPromises = selectedTokens.value.map(async (tokenId) => {
        if (shouldStop.value) return;
        tokenStatus.value[tokenId] = "running";
        const token = tokens.value.find((t) => t.id === tokenId);
        let ownsSlot = false;
        try {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== 营地挑战宠物 ${token.name} (第${round}/${maxRounds}轮) ===`,
            type: "info",
          });
          await ensureConnection(tokenId, 2, (owned) => {
            ownsSlot = owned;
          });
          if (shouldStop.value) return;

          // 获取我方阵容配置
          const [presetTeamResult, roleInfoResult] = await Promise.all([
            tokenStore.sendMessageWithPromise(
              tokenId,
              "presetteam_getinfo",
              {},
              5000,
            ),
            tokenStore.sendMessageWithPromise(
              tokenId,
              "role_getroleinfo",
              {},
              15000,
            ),
          ]);

          const lordWeaponId = roleInfoResult?.role?.lordWeaponId || 0;

          // 解析阵容数据，优先使用竞技场阵容
          const tokenSettings = loadSettings ? loadSettings(tokenId) : {};
          const formationId = String(tokenSettings?.arenaFormation || 1);
          const root =
            presetTeamResult?.presetTeamInfo?.presetTeamInfo ||
            presetTeamResult?.presetTeamInfo ||
            {};
          const teamInfoData =
            root[formationId]?.teamInfo || root["1"]?.teamInfo || {};

          const battleTeam = {};
          for (const [pos, hero] of Object.entries(teamInfoData)) {
            const hid = hero?.heroId ?? hero?.id;
            if (hid) {
              battleTeam[pos] = Number(hid);
            }
          }

          if (Object.keys(battleTeam).length === 0) {
            throw new Error(`无法获取阵容${formationId}数据`);
          }

          const teamSetParams = {
            lordWeaponId,
            petUId: "",
            battleTeam,
          };

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 使用阵容${formationId}: ${Object.values(battleTeam).join(", ")}`,
            type: "info",
          });

          // 挑战宠物
          const attackRes = await tokenStore.sendMessageWithPromise(
            tokenId,
            "club_attackmonster",
            {
              useItem: false,
              teamSetParams,
            },
            8000,
          );

          const battleResult =
            attackRes?.battleData?.result?.accept?.ext?.curHP;
          const isWin = battleResult === 0;
          const rewardCount = attackRes?.reward?.length || 0;

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 挑战宠物${isWin ? "胜利" : "失败"}${rewardCount > 0 ? ` (获得${rewardCount}个奖励)` : ""}`,
            type: isWin ? "success" : "error",
          });

          tokenStatus.value[tokenId] = "completed";
        } catch (error) {
          console.error(error);
          tokenStatus.value[tokenId] = "failed";
          addLog({
            time: new Date().toLocaleTimeString(),
          message: `${token.name} 营地挑战宠物失败: ${error.message || "未知错误"}`,
          type: "error",
        });
      } finally {
        // 只释放本次自己占用的槽位；3 轮循环里某一轮可能复用已连接账号
        if (ownsSlot) {
          tokenStore.closeWebSocketConnection(tokenId);
          releaseConnectionSlot();
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 连接已关闭`,
            type: "info",
          });
        }
      }
    });

      await Promise.all(taskPromises);
    }

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量营地挑战宠物结束");

    // 领取任务奖励
    await batchCampClaimTasks();
  };

  /**
   * 智能挑战：按战力升序挑最弱对手，赢够 3 场即停；
   * 10 次机会用完仍不足则改打宠物补足（宠物不占次数）。
   */
  const batchCampChallengeSmart = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const getTodayKey = () => {
      const now = new Date();
      return (
        String(now.getFullYear() % 100).padStart(2, "0") +
        String(now.getMonth() + 1).padStart(2, "0") +
        String(now.getDate()).padStart(2, "0")
      );
    };

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);
      let ownsSlot = false;
      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 智能挑战开始: ${token.name}（目标赢 ${CAMP_WINS_TARGET} 场）===`,
          type: "info",
        });
        await ensureConnection(tokenId, 2, (owned) => {
          ownsSlot = owned;
        });
        if (shouldStop.value) return;

        // 1. 解析我方阵容（与手动挑战一致，使用竞技场阵容）
        const [presetTeamResult, roleInfoResult] = await Promise.all([
          tokenStore.sendMessageWithPromise(tokenId, "presetteam_getinfo", {}, 5000),
          tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 15000),
        ]);
        const lordWeaponId = roleInfoResult?.role?.lordWeaponId || 0;
        const tokenSettings = loadSettings ? loadSettings(tokenId) : {};
        const formationId = String(tokenSettings?.arenaFormation || 1);
        const root =
          presetTeamResult?.presetTeamInfo?.presetTeamInfo ||
          presetTeamResult?.presetTeamInfo ||
          {};
        const teamInfoData =
          root[formationId]?.teamInfo || root["1"]?.teamInfo || {};
        const battleTeam = {};
        for (const [pos, hero] of Object.entries(teamInfoData)) {
          const hid = hero?.heroId ?? hero?.id;
          if (hid) battleTeam[pos] = Number(hid);
        }
        if (Object.keys(battleTeam).length === 0) {
          throw new Error(`无法获取阵容${formationId}数据`);
        }
        const teamSetParams = { lordWeaponId, petUId: "", battleTeam };

        // 2. 读取今日战况：已挑战次数与已胜场
        const infoRes = await tokenStore.sendMessageWithPromise(
          tokenId,
          "club_getinfo",
          {},
          12000,
        );
        const siege = infoRes?.siege || {};
        const attackMap = siege.attackMap || {};
        const todayStat = attackMap[getTodayKey()] || {};
        let winCount = Number(todayStat.aSuccessCnt || 0);
        let attackCount = Number(todayStat.attackCnt || 0);

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 今日已挑战 ${attackCount} 次、胜 ${winCount} 场`,
          type: "info",
        });

        // 3. 收集未击败对手，逐个查询战力后按升序排列（最弱优先）
        const oppoMap = infoRes?.club?.oppoMap || {};
        const candidates = [];
        for (const [oppoKey, opponent] of Object.entries(oppoMap)) {
          const defenders = opponent?.defenders || {};
          for (const [nodeId, defender] of Object.entries(defenders)) {
            if (defender?.defeated) continue;
            candidates.push({
              oppoKey,
              opponentName: opponent.name,
              nodeId,
              targetId: defender.roleId,
              defender,
            });
          }
        }

        const powerById = {};
        for (const candidate of candidates) {
          if (!candidate.targetId) continue;
          try {
            const teamRes = await tokenStore.sendMessageWithPromise(
              tokenId,
              "club_gettargetteam",
              { targetId: candidate.targetId },
              5000,
            );
            const role = teamRes?.roleBattleTeam?.role || teamRes?.teamInfo;
            powerById[String(candidate.targetId)] = Number(role?.power || 0);
          } catch {
            powerById[String(candidate.targetId)] = 0;
          }
        }
        const ordered = sortTargetsByPower(candidates, powerById).slice(
          0,
          CAMP_DAILY_ATTACK_LIMIT,
        );

        // 4. 先按战力从低到高挑战自然人，赢够即停
        for (const target of ordered) {
          if (shouldStop.value) break;
          const decision = decideNextStep({ winCount, attackCount });
          if (decision.done) break;
          if (decision.usePets) break;

          const { opponentName, nodeId, defender, targetId } = target;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 智能挑战 ${opponentName} - ${defender.name}（战力 ${powerById[String(targetId)] || 0}，第 ${attackCount + 1} 次）`,
            type: "info",
          });
          try {
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "club_gettargetteam",
              { targetId },
              5000,
            );
            const attackRes = await tokenStore.sendMessageWithPromise(
              tokenId,
              "club_attack",
              {
                nodeId: Number(nodeId),
                targetId,
                challengeCnt: defender.challengeCnt || 0,
                failCnt: defender.failCnt || 0,
                useItem: false,
                teamSetParams,
              },
              8000,
            );
            const curHP = attackRes?.battleData?.result?.accept?.ext?.curHP;
            const isWin = curHP === 0;
            attackCount++;
            if (isWin) winCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 挑战${isWin ? "胜利" : "失败"}（累计 ${winCount}/${CAMP_WINS_TARGET} 胜，${attackCount} 次机会）`,
              type: isWin ? "success" : "warning",
            });
          } catch (err) {
            attackCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 挑战异常: ${err.message || "未知错误"}`,
              type: "error",
            });
          }
        }

        // 5. 次数用完仍不足 3 胜 → 打宠物补足（宠物不占次数）
        let petAttempts = 0;
        while (
          !shouldStop.value &&
          !hasEnoughWins(winCount) &&
          petAttempts < CAMP_PET_ATTEMPT_LIMIT
        ) {
          petAttempts++;
          try {
            const attackRes = await tokenStore.sendMessageWithPromise(
              tokenId,
              "club_attackmonster",
              { useItem: false, teamSetParams },
              8000,
            );
            const curHP = attackRes?.battleData?.result?.accept?.ext?.curHP;
            const isWin = curHP === 0;
            if (isWin) winCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 打宠物第 ${petAttempts} 次${isWin ? "胜利" : "失败"}（累计 ${winCount}/${CAMP_WINS_TARGET} 胜）`,
              type: isWin ? "success" : "warning",
            });
          } catch (err) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 打宠物异常: ${err.message || "未知错误"}`,
              type: "error",
            });
          }
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 智能挑战结束：${winCount} 胜，自然人挑战 ${attackCount} 次，打宠物 ${petAttempts} 次${hasEnoughWins(winCount) ? "（已达标）" : "（未达标，战力不足）"}`,
          type: hasEnoughWins(winCount) ? "success" : "warning",
        });
        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 智能挑战失败: ${error.message || "未知错误"}`,
          type: "error",
        });
      } finally {
        if (ownsSlot) {
          tokenStore.closeWebSocketConnection(tokenId);
          releaseConnectionSlot();
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 连接已关闭`,
            type: "info",
          });
        }
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量智能挑战结束");

    // 领取任务奖励
    await batchCampClaimTasks();
  };

  /**
   * 领取营地挑战任务奖励
   * 通过 role_getroleinfo 获取 siege.taskProgress 和 siege.taskClaimedMap
   * taskProgress: 1/2/3 是3个区域(值为1可领取), 4是挑战3次(值>=3可领取)
   * taskClaimedMap 中已有的 key 表示已领取
   */
  const batchCampClaimTasks = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);
      let ownsSlot = false;
      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始领取营地任务奖励: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId, 2, (owned) => {
          ownsSlot = owned;
        });
        if (shouldStop.value) return;

        await tokenStore.sendMessageWithPromise(
          tokenId,
          "club_getinfo",
          {},
          15000,
        );

        let claimedCount = 0;
        for (const confId of [1, 2, 3, 4]) {
          if (shouldStop.value) break;
          try {
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "club_taskclaim",
              { confId },
              5000,
            );
            claimedCount++;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 成功领取任务 ${confId} 奖励`,
              type: "success",
            });
          } catch (err) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 领取任务 ${confId} 失败: ${err.message || "未知错误"}`,
              type: "error",
            });
          }
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 营地任务奖励领取完成，共领取 ${claimedCount} 个`,
          type: "info",
        });

        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 领取营地任务奖励失败: ${error.message || "未知错误"}`,
          type: "error",
        });
      } finally {
        // 只释放本次自己占用的槽位，避免误关其他账号共用的连接
        if (ownsSlot) {
          tokenStore.closeWebSocketConnection(tokenId);
          releaseConnectionSlot();
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 连接已关闭`,
            type: "info",
          });
        }
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量领取营地任务奖励结束");
  };

  return {
    batchCampChallenge,
    batchCampChallengePet,
    batchCampChallengeSmart,
    batchCampClaimTasks,
  };
}
