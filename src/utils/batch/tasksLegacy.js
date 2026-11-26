import { runHangUpLegacy, createHangUpTaskContext } from "./hangUpWorkflow.js";
import { recordTaskResult, taskErrorResult } from "./taskResult.js";
/**
 * 功法类任务
 * 包含: batchLegacyClaim, batchLegacyGiftSendEnhanced
 */

/**
 * 创建功法类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksLegacy(deps) {
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
    recipientIdInput,
    recipientInfo,
    securityPassword,
    giftQuantity,
    delayConfig,
  } = deps;

  /**
   * 批量领取功法残卷
   */
  const batchLegacyClaim = async () => {
    const ids = [...new Set(selectedTokens.value)];
    if (!ids.length) return [];
    const context = deps.bottleTaskContext || createHangUpTaskContext();
    isRunning.value = true;
    shouldStop.value = false;
    ids.forEach(id => { tokenStatus.value[id] = "waiting"; });
    try {
      return await Promise.all(ids.map(async tokenId => {
        const token = tokens.value.find(item => item.id === tokenId);
        let result, connectionAttempted = false;
        try {
          if (shouldStop.value) throw Object.assign(new Error("手动停止"), { stopped: true });
          if (!token) result = { status: "unavailable", detail: "账号已移除" };
          else {
            tokenStatus.value[tokenId] = "running";
            result = await runHangUpLegacy({ context, tokenId,
              stopped: () => shouldStop.value,
              isDisconnected: () => ["disconnected", "closed", "error"].includes(tokenStore.getWebSocketStatus?.(tokenId)),
              spacingMs: delayConfig?.command ?? batchSettings.commandDelay,
              // A cached outcome requires no connection and never sends another claim.
              send: async (cmd, params, timeout) => {
                connectionAttempted = true;
                await ensureConnection(tokenId);
                if (shouldStop.value) throw Object.assign(new Error("手动停止"), { stopped: true });
                return tokenStore.sendMessageWithPromise(tokenId, cmd, params, timeout);
              },
            });
          }
        } catch (error) {
          result = taskErrorResult(error);
        } finally {
          try {
            if (connectionAttempted) {
              const close = tokenStore.closeWebSocketConnectionAsync || tokenStore.closeWebSocketConnection;
              await close.call(tokenStore, tokenId);
            }
          } catch (error) {
            result ||= { status: "warning", detail: "结果待核验" };
            if (["completed", "skipped"].includes(result.status)) result.status = "partial";
            result.detail += `；关闭连接失败：${error?.message || "未知原因"}`;
          } finally { releaseConnectionSlot(tokenId); }
        }
        const labels = { completed: "完成", skipped: "跳过", warning: "待核验", partial: "部分异常", failed: "失败", stopped: "已停止", unavailable: "不可用" };
        const recorded = recordTaskResult(tokenStatus, tokenId, result.status, [result.detail], [], result);
        addLog({ time: new Date().toLocaleTimeString(),
          message: `[残卷][${token?.name || tokenId}] ${labels[result.status] || result.status}；${result.detail}`,
          type: ["failed", "partial", "unavailable"].includes(result.status) ? "error" : ["warning", "stopped"].includes(result.status) ? "warning" : "info" });
        return recorded;
      }));
    } finally {
      isRunning.value = false;
      currentRunningTokenId.value = null;
    }
  };

  /**
   * 增强版批量赠送功法残卷（含完善的验证和错误处理）
   */
  const batchLegacyGiftSendEnhanced = async (isScheduledTask = false) => {
    if (selectedTokens.value.length === 0) {
      message.warning("请先选择要操作的角色");
      return;
    }

    const recipientId = isScheduledTask
      ? batchSettings.receiverId
      : recipientIdInput.value;
    const password = isScheduledTask
      ? batchSettings.password
      : securityPassword.value;

    const giftConfig = {
      recipientId: Number(recipientId),
      itemId: 37007,
      quantity: Math.min(giftQuantity.value, 9999) || 0,
      serverName: recipientInfo.value?.serverName || "",
      name: recipientInfo.value?.name || "",
    };

    if (!isScheduledTask) {
      if (!giftConfig.recipientId || giftConfig.recipientId <= 0) {
        message.error("请输入有效的接收者ID");
        return;
      }

      if (giftConfig.quantity <= 0 || giftConfig.quantity > 9999) {
        message.error("赠送数量必须在1-9999之间");
        return;
      }
    }

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    let totalSuccess = 0;
    let totalFailed = 0;

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);
      let consecutiveErrors = 0;
      const maxRetries = 2;

      while (consecutiveErrors <= maxRetries && !shouldStop.value) {
        try {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== 开始赠送功法残卷: ${token.name} (尝试 ${consecutiveErrors + 1}/${maxRetries + 1}) ===`,
            type: "info",
          });

          await ensureConnection(tokenId);

          const roleInfo = await tokenStore.sendGetRoleInfo(tokenId);
          const legacyFragmentCount =
            Math.min(
              roleInfo?.role?.items?.[giftConfig.itemId]?.quantity,
              9999,
            ) || 0;
          if (isScheduledTask) {
            if (legacyFragmentCount === 0) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 功法残卷不足，当前拥有: 0 ===`,
                type: "error",
              });
              tokenStatus.value[tokenId] = "failed";
              totalFailed++;
              break;
            }
            const rankroleinfo = await tokenStore.sendMessageWithPromise(
              tokenId,
              "rank_getroleinfo",
              {
                bottleType: 0,
                includeBottleTeam: false,
                isSearch: false,
                roleId: giftConfig.recipientId,
              },
              5000,
            );
            giftConfig.serverName = rankroleinfo?.roleInfo?.serverName || "";
            giftConfig.name = rankroleinfo?.roleInfo?.name || "";
            if (!rankroleinfo?.roleInfo?.roleId) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `=== ${token.name} 赠送功法残卷失败: 接收者${giftConfig.recipientId}不存在`,
                type: "error",
              });
              tokenStatus.value[tokenId] = "failed";
              totalFailed++;
              break;
            }
            giftConfig.quantity = legacyFragmentCount;
          }

          if (legacyFragmentCount < giftConfig.quantity) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${token.name} 功法残卷不足，当前拥有: ${legacyFragmentCount}，需要: ${giftConfig.quantity} ===`,
              type: "error",
            });
            tokenStatus.value[tokenId] = "failed";
            totalFailed++;
            break;
          }

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== 开始解除安全密码验证 ===`,
            type: "info",
          });

          const commitPasswordResp = await tokenStore.sendMessageWithPromise(
            tokenId,
            "role_commitpassword",
            {
              password: password,
              passwordType: 1,
            },
            5000,
          );

          if (!commitPasswordResp) {
            throw new Error("安全密码验证请求无响应");
          }
          if (!commitPasswordResp.role?.statistics?.["que:wh:tm"]) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} === 密码解除失败,请检查密码是否配置正确 ===`,
              type: "error",
            });
            tokenStatus.value[tokenId] = "failed";
            totalFailed++;
            break;
          }
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== 安全密码验证成功 ===`,
            type: "success",
          });

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} === 开始赠送功法残卷${giftConfig.quantity}个,目标:[${giftConfig.serverName}] ID:${giftConfig.recipientId} ${giftConfig.name} ===`,
            type: "info",
          });

          const legacySendGiftResp = await tokenStore.sendMessageWithPromise(
            tokenId,
            "legacy_sendgift",
            {
              itemCnt: giftConfig.quantity,
              legacyUIds: [],
              targetId: giftConfig.recipientId,
            },
            5000,
          );

          if (!legacySendGiftResp) {
            throw new Error("赠送请求无响应");
          }

          await tokenStore.sendMessage(tokenId, "role_getroleinfo");

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `=== ${token.name} 成功赠送功法残卷${giftConfig.quantity}个给[${giftConfig.serverName}] ID:${giftConfig.recipientId} ${giftConfig.name} ===`,
            type: "success",
          });

          tokenStatus.value[tokenId] = "completed";
          totalSuccess++;
          break;
        } catch (error) {
          consecutiveErrors++;
          console.error(`赠送失败: ${error.message}`);

          let errorMsg = error.message || "未知错误";
          let errorType = "error";

          if (errorMsg.includes("200160")) {
            errorMsg = "模块未开启";
          } else if (errorMsg.includes("timeout")) {
            errorMsg = "请求超时";
            errorType = "warning";
          } else if (errorMsg.includes("网络")) {
            errorMsg = "网络错误";
            errorType = "warning";
          }

          if (consecutiveErrors <= maxRetries && !shouldStop.value) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${token.name} 赠送功法残卷失败: ${errorMsg}，将在3秒后重试 ===`,
              type: "warning",
            });
            await new Promise((r) => setTimeout(r, delayConfig.long));
          } else {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `=== ${token.name} 赠送功法残卷失败: ${errorMsg}，已达最大重试次数 ===`,
              type: "error",
            });
            tokenStatus.value[tokenId] = "failed";
            totalFailed++;
            break;
          }
        } finally {
          tokenStore.closeWebSocketConnection(tokenId);
          releaseConnectionSlot(tokenId);
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
            type: "info",
          });
        }
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;

    addLog({
      time: new Date().toLocaleTimeString(),
      message: `=== 批量赠送功法残卷完成: 成功 ${totalSuccess} 个，失败 ${totalFailed} 个 ===`,
      type: "success",
    });

    message.success(
      `批量赠送功法残卷结束，成功 ${totalSuccess} 个，失败 ${totalFailed} 个`,
    );
  };

  return {
    batchLegacyClaim,
    batchLegacyGiftSendEnhanced,
  };
}

