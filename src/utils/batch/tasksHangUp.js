import { runHangUpAddTime, runHangUpLegacy, createHangUpTaskContext } from "./hangUpWorkflow.js";
import { runStudy } from "../../stores/events/study.ts";
import { dailyConnectionFailure } from "./dailyConnectionPolicy.js";
import { recordTaskResult, taskErrorResult } from "./taskResult.js";
import {
  LEGACY_HANGUP_UNLOCK_AFTER_LEVEL,
  getMainStageLevel,
} from "@/utils/gameFeatureUnlocks";

/**
 * 挂机、答题、签到类任务
 * 包含: claimHangUpRewards, batchAddHangUpTime, batchStudy, batchclubsign
 */

/**
 * 创建挂机、答题、签到类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksHangUp(deps) {
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
  } = deps;

  const report = (id, status, detail, warnings = []) => {
    recordTaskResult(tokenStatus, id, status, [detail], warnings);
    addLog({ time: new Date().toLocaleTimeString(), message: detail,
      type: ["failed", "partial"].includes(status) ? "error" : ["warning", "stopped"].includes(status) ? "warning" : "info" });
  };

  /**
   * 领取挂机奖励
   */
  const runHangUpBatch = async (includeRewards) => {
    const ids = [...new Set(selectedTokens.value)];
    if (!ids.length) return [];
    const context = deps.bottleTaskContext || createHangUpTaskContext();
    const outcomes = new Map();
    const finish = (id, status, detail, verificationDetails = []) => {
      const result = recordTaskResult(tokenStatus, id, status, [detail], [], {
        verificationRequired: verificationDetails.length > 0, verificationDetails,
      });
      outcomes.set(id, result);
      const name = tokens.value.find(token => token.id === id)?.name || id;
      addLog({ time: new Date().toLocaleTimeString(), message: `[挂机][${name}] ${detail}`,
        type: ["failed", "partial"].includes(status) ? "error" : ["warning", "stopped"].includes(status) ? "warning" : "info" });
    };
    isRunning.value = true;
    shouldStop.value = false;
    ids.forEach(id => { tokenStatus.value[id] = "waiting"; });
    try {
      await Promise.all(ids.map(async tokenId => {
        if (shouldStop.value) return finish(tokenId, "stopped", "手动停止");
        if (!tokens.value.some(t => t.id === tokenId)) return finish(tokenId, "unavailable", "账号已移除");
        tokenStatus.value[tokenId] = "running";
        const steps = [];
        const options = { context, tokenId, stopped: () => shouldStop.value,
          isDisconnected: () => ["disconnected", "closed", "error"].includes(tokenStore.getWebSocketStatus?.(tokenId)),
          send: (cmd, params, timeout) => tokenStore.sendMessageWithPromise(tokenId, cmd, params, timeout),
          spacingMs: deps.delayConfig?.command ?? batchSettings.commandDelay,
        };
        const add = result => { steps.push(result); return result; };
        const conclude = () => {
          const details = steps.map(step => step.detail);
          const pending = steps.filter(step => step.verificationRequired).flatMap(step => step.verificationDetails?.length ? step.verificationDetails : [step.detail]);
          const errors = steps.some(step => ["failed", "partial"].includes(step.status));
          const confirmed = steps.some(step => step.status === "completed" || step.confirmed > 0);
          const status = shouldStop.value ? "stopped" : errors ? (confirmed ? "partial" : "failed")
            : pending.length || steps.some(step => step.status === "warning") ? "warning"
            : steps.every(step => step.status === "skipped") ? "skipped" : "completed";
          finish(tokenId, status, `${shouldStop.value ? "手动停止；" : ""}${details.join("；")}`, pending);
        };
        try {
          await ensureConnection(tokenId);
          if (shouldStop.value) throw Object.assign(new Error("手动停止"), { stopped: true });
          if (includeRewards) {
            try {
              await options.send("system_claimhangupreward", {}, 5000);
              add({ status: "completed", confirmed: 1, detail: "挂机领奖：本入口已确认 1 次（不含加钟）" });
            } catch (error) {
              if (error?.stopped || shouldStop.value) throw error;
              const halt = dailyConnectionFailure(error, tokenStore, tokenId);
              const result = taskErrorResult(error);
              add({ ...result, status: halt ? "warning" : result.status,
                detail: `挂机领奖：${halt ? "结果待核验；连接或请求中断；" : ""}${result.detail}`,
                verificationRequired: halt || result.status === "warning" });
              if (halt) { steps.push({ status: "warning", verificationRequired: true, detail: "结果待核验：后续加钟及功法残卷未执行，未重发领奖" }); conclude(); return; }
            }
          }
          const clock = add(await runHangUpAddTime(options));
          if (clock.haltDaily) {
            if (includeRewards) add({ status: "warning", verificationRequired: true, detail: "结果待核验：连接中断，后续功法残卷未执行" });
            conclude(); return;
          }
          if (includeRewards && !shouldStop.value) {
            try {
              const level = getMainStageLevel(await tokenStore.sendGetRoleInfo(tokenId));
              if (level === null) add({ status: "warning", verificationRequired: true, detail: "功法残卷待核验：缺少主线关卡，未发送领取请求" });
              else if (level > LEGACY_HANGUP_UNLOCK_AFTER_LEVEL) add(await runHangUpLegacy(options));
              else add({ status: "skipped", detail: `功法残卷：主线 ${level} 未超过 ${LEGACY_HANGUP_UNLOCK_AFTER_LEVEL}，正常跳过` });
            } catch (error) {
              if (error?.stopped || shouldStop.value) throw error;
              add({ status: "warning", verificationRequired: true, detail: `功法残卷待核验：状态查询失败（${error?.message || "未知原因"}），未发送领取` });
            }
          }
          conclude();
        } catch (error) {
          const result = taskErrorResult(error, steps.some(step => step.confirmed > 0));
          const pending = dailyConnectionFailure(error, tokenStore, tokenId) || result.status === "warning";
          const detail = `${steps.map(step => step.detail).join("；")}${steps.length ? "；" : ""}${pending ? "结果待核验：" : ""}${result.detail}`;
          finish(tokenId, shouldStop.value || error?.stopped ? "stopped" : pending ? "warning" : result.status, detail, pending ? [detail] : []);
        } finally {
          try {
            const close = tokenStore.closeWebSocketConnectionAsync || tokenStore.closeWebSocketConnection;
            await close.call(tokenStore, tokenId);
          } finally { releaseConnectionSlot(tokenId); }
        }
      }));
    } finally {
      isRunning.value = false;
      currentRunningTokenId.value = null;
    }
    return ids.map(id => outcomes.get(id));
  };
  const claimHangUpRewards = () => runHangUpBatch(true);

  /**
   * 一键加钟
   */
  const batchAddHangUpTime = () => runHangUpBatch(false);

  /**
   * 一键答题
   */
  const batchStudy = async () => {
    const ids = [...new Set(selectedTokens.value)];
    if (!ids.length) return;
    isRunning.value = true;
    shouldStop.value = false;
    ids.forEach(id => { tokenStatus.value[id] = "waiting"; });
    try {
      await Promise.all(ids.map(async tokenId => {
        if (shouldStop.value) return report(tokenId, "stopped", "手动停止");
        const token = tokens.value.find(item => item.id === tokenId);
        if (!token) return report(tokenId, "unavailable", "账号已移除");
        tokenStatus.value[tokenId] = "running";
        const label = `[一键答题][${token.name || "当前账号"}]`;
        try {
          const result = await runStudy(tokenStore, tokenId, {
            open: () => ensureConnection(tokenId),
            close: async () => {
              try { await tokenStore.closeWebSocketConnection(tokenId); }
              finally { releaseConnectionSlot(tokenId); }
            },
            stopped: () => shouldStop.value,
            log: detail => addLog({ time: new Date().toLocaleTimeString(), message: `${label} ${detail}`, type: "info" }),
          });
          report(tokenId, result.status, `${label} ${result.detail}`, result.warnings);
        } catch (error) {
          const result = taskErrorResult(error);
          report(tokenId, result.status, `${label} ${result.detail}`);
        }
      }));
    } finally {
      isRunning.value = false;
      currentRunningTokenId.value = null;
    }
  };

  /**
   * 一键俱乐部签到
   */
  const batchclubsign = async () => {
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
      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始一键俱乐部签到: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);
        if (shouldStop.value) return;
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "legion_signin",
          {},
          5000,
        );
        await new Promise((r) => setTimeout(r, 500));
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 俱乐部签到已完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 俱乐部签到失败: ${error.message || "未知错误"}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot(tokenId);
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量俱乐部签到结束");
  };

  /**
   * 月赛助威
   * @param {number} legionId - 俱乐部ID
   * @param {number} guessCoin - 竞猜币数量
   */
  const batchWarGuessCheer = async (legionId, guessCoin) => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择账号");
      return;
    }
    if (!legionId) {
      message.warning("请选择要助威的俱乐部");
      return;
    }
    
    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);
      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始助威: ${token.name} ===`,
          type: "info",
        });
        await ensureConnection(tokenId);
        
        // 尝试领取拍手器
        try {
          const rewardRes = await tokenStore.sendMessageWithPromise(
            tokenId,
            "warguess_getguesscoinreward",
            {},
            3000 // 短超时，因为这不是关键步骤
          );
          if (rewardRes && rewardRes.reward) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${token.name} 领取拍手器成功 ===`,
              type: "success",
            });
          }
        } catch (e) {
          // 忽略领取失败
          // console.warn("领取拍手器失败", e);
        }

        // 获取助威数据以判断次数
        const rankRes = await tokenStore.sendMessageWithPromise(
          tokenId,
          "warguess_getrank",
          { bfId: '' },
          5000,
        );

        let totalGuessNum = 0;
        if (rankRes && rankRes.list) {
          let list = [];
          if (Array.isArray(rankRes.list)) {
            list = rankRes.list;
          } else {
            list = Object.values(rankRes.list);
          }
          totalGuessNum = list.reduce((sum, item) => sum + (item.guessNum || 0), 0);
        }

        if (totalGuessNum === 20) {
             addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 助威次数已满 (${totalGuessNum}/20)，跳过 ===`,
                type: "warning",
              });
             tokenStatus.value[tokenId] = "completed";
             return;
        }

        let coinToUse = Number(guessCoin);
        const remaining = 20 - totalGuessNum;
        
        if (coinToUse > remaining) {
            addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 剩余助威次数不足，调整为 ${remaining} 次 (原计划: ${coinToUse}) ===`,
                type: "info",
            });
            coinToUse = remaining;
        }

        if (coinToUse <= 0) {
             tokenStatus.value[tokenId] = "completed";
             return;
        }

        const result = await tokenStore.sendMessageWithPromise(
          tokenId,
          "warguess_startguess",
          { guessCoin: coinToUse, legionId: legionId },
          5000,
        );

        if (result && result.guessLegion) {
             addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 助威成功 (当前次数: ${result.guessLegion.guessNum}/20) ===`,
                type: "success",
              });
             tokenStatus.value[tokenId] = "completed";
        } else {
             addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 助威失败 ===`,
                type: "error",
              });
             tokenStatus.value[tokenId] = "failed";
        }
      } catch (error) {
        console.error(error);
        
        // Handle specific error: 400000 - Item does not exist (feature locked)
        if (error.code === 400000 || (error.message && error.message.includes("400000"))) {
          tokenStatus.value[tokenId] = "completed"; // Mark as completed (skipped)
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== ${token.name} 助威失败: 未解锁该功能===`,
            type: "warning",
          });
        } else {
          tokenStatus.value[tokenId] = "failed";
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 助威失败: ${error.message || "未知错误"}`,
            type: "error",
          });
        }
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot(tokenId);
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量助威结束");
  };

  return {
    claimHangUpRewards,
    batchAddHangUpTime,
    batchStudy,
    batchclubsign,
    batchWarGuessCheer,
  };
}

