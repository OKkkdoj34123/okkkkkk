/**
 * 逐鹿盐山竞猜任务 V3
 * - 默认按第一赛季配置表识别唯一开放的淘汰赛 scheduleId
 * - 手动ID开关开启时，手动ID优先；无效时绝不回退自动识别
 * - 只处理当前竞猜期的前一期（round - 1）可领取奖励
 * - 任一方已竞猜即跳过整场；多数方依据 cheerCnt
 * - 分页索引按服务器实际返回的对阵组数推进
 * - Apex 请求全局串行并采用简化 AIMD 冷却；写请求不盲目自动重发
 * - 竞猜/领奖均通过 apex_getroleinfo 回读确认
 */

import {
  ApexScheduleStatus,
  getApexScheduleConf,
  getAutoApexSchedule,
  getApexClaimScheduleIds,
  getScheduleStatus,
} from "../apexRules.js";

const DEFAULT_DELAY_MS = 500;
const MAX_GUESS_PAGES = 64;
const APEX_CLAIM_HISTORY_ROUNDS = 1; // PATCH_APEX_CLAIM_HISTORY_ROUNDS
const APEX_MIN_CMD_GAP_MS = 200;
const APEX_GAP_MARGIN_MS = 200;
const APEX_GAP_CEIL_MS = 15000;
const APEX_GAP_FLOOR_MS = { read: 300, write: 1200 };
const APEX_GAP_DEFAULT_MS = { read: 600, write: 3000 };
const APEX_GAP_GROW = 1.5;
const APEX_GAP_SHRINK = 200;
const APEX_OK_BEFORE_SHRINK = 3;

// 所有账号共用同一 Apex 请求队列，避免多账号同时产生请求突发。
const apexCooldownMs = { ...APEX_GAP_DEFAULT_MS };
const apexNextAllowedAt = { read: 0, write: 0 };
const apexSuccessStreak = { read: 0, write: 0 };
let apexLastSentAt = 0;
let apexCommandChain = Promise.resolve();

export function normalizeApexScheduleId(value) {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * guessClaimMap 语义由 2026-11-03 三个真实 BIN 验证：
 * - teamId: false：正确竞猜，奖励尚未领取
 * - teamId: true：奖励已领取
 * - _teamId: false：失败竞猜，不存在可领取奖励
 *
 * allowedScheduleIds 不传时保留通用查询能力；执行器始终传入前一期ID集合。
 */
export function getApexPendingClaims(guessClaimMap = {}, allowedScheduleIds = null) {
  if (!guessClaimMap || typeof guessClaimMap !== "object") return [];
  const allowedOrder = allowedScheduleIds === null || allowedScheduleIds === undefined
    ? null
    : new Map(
      [...allowedScheduleIds]
        .map(normalizeApexScheduleId)
        .filter(Boolean)
        .map((id, index) => [String(id), index]),
    );
  const allowed = allowedOrder ? new Set(allowedOrder.keys()) : null;
  const claims = [];
  for (const [scheduleKey, teamMap] of Object.entries(guessClaimMap)) {
    const scheduleId = normalizeApexScheduleId(scheduleKey);
    if (!scheduleId || (allowed && !allowed.has(String(scheduleId)))) continue;
    if (!teamMap || typeof teamMap !== "object" || Array.isArray(teamMap)) continue;
    for (const [teamId, claimed] of Object.entries(teamMap)) {
      if (!teamId || teamId.startsWith("_") || claimed !== false) continue;
      claims.push({ scheduleId, teamId });
    }
  }
  return claims.sort((a, b) => {
    if (allowedOrder) {
      const diff = allowedOrder.get(String(a.scheduleId)) - allowedOrder.get(String(b.scheduleId));
      if (diff) return diff;
    }
    return a.scheduleId - b.scheduleId || a.teamId.localeCompare(b.teamId);
  });
}

/** cheerCnt 是竞猜列表中的支持计数；voteCnt 属于对阵图，不能互相替代。 */
export function chooseApexMajority(team0, team1) {
  if (!team0?.teamId || !team1?.teamId || team0.teamId === team1.teamId) return null;
  if (
    team0.cheerCnt === null ||
    team0.cheerCnt === undefined ||
    team1.cheerCnt === null ||
    team1.cheerCnt === undefined
  ) return null;
  const count0 = Number(team0.cheerCnt);
  const count1 = Number(team1.cheerCnt);
  if (
    !Number.isFinite(count0) ||
    !Number.isFinite(count1) ||
    count0 < 0 ||
    count1 < 0
  ) return null;
  const total = count0 + count1;
  if (total <= 0 || count0 === count1) return null;
  const team = count0 > count1 ? team0 : team1;
  const count = count0 > count1 ? count0 : count1;
  return { team, count, total, share: (count / total) * 100 };
}

export function isApexGroupAlreadyGuessed(group, guessedTeamIds) {
  if (!Array.isArray(group) || !(guessedTeamIds instanceof Set)) return false;
  return group.some(
    (team) => team?.teamId && guessedTeamIds.has(String(team.teamId)),
  );
}

function readGuessedTeamIds(apexInfo, scheduleId) {
  const list = apexInfo?.guessMap?.[String(scheduleId)];
  return new Set(Array.isArray(list) ? list.map(String) : []);
}

function readClaimState(apexInfo, scheduleId, teamId) {
  return apexInfo?.guessClaimMap?.[String(scheduleId)]?.[teamId];
}

function isApexRateLimited(error) {
  const text = error && error.message ? error.message : String(error);
  return /200400|操作太快/.test(text);
}

function commandKind(cmd) {
  return cmd === "apex_guess" || cmd === "apex_guessclaim" ? "write" : "read";
}

/**
 * 简化迁移上游 AIMD 策略：
 * - 查询初始间隔 600ms，竞猜/领奖初始间隔 3000ms
 * - 所有 Apex 命令全局串行，命令间最小间隔 200ms
 * - 200400 时对应动作间隔乘 1.5，连续成功3次后回降200ms
 * - 不自动重发写请求；由调用方回读 guessMap / guessClaimMap 后判断
 */
function sendApexCommand(tokenStore, tokenId, cmd, params, timeout, wait, shouldStop) {
  const kind = commandKind(cmd);
  const cancelledError = () => {
    const error = new Error("用户已停止，取消尚未发送的Apex写请求");
    error.apexCancelled = true;
    return error;
  };
  const run = async () => {
    if (kind === "write" && shouldStop?.()) throw cancelledError();
    const now = Date.now();
    const waitMs = Math.max(
      0,
      apexNextAllowedAt[kind] - now,
      apexLastSentAt + APEX_MIN_CMD_GAP_MS - now,
    );
    if (waitMs > 0) await wait(waitMs);
    if (kind === "write" && shouldStop?.()) throw cancelledError();

    try {
      const result = await tokenStore.sendMessageWithPromise(
        tokenId,
        cmd,
        params,
        timeout,
      );
      apexSuccessStreak[kind] += 1;
      if (apexSuccessStreak[kind] >= APEX_OK_BEFORE_SHRINK) {
        apexCooldownMs[kind] = Math.max(
          APEX_GAP_FLOOR_MS[kind],
          apexCooldownMs[kind] - APEX_GAP_SHRINK,
        );
        apexSuccessStreak[kind] = 0;
      }
      apexNextAllowedAt[kind] =
        Date.now() + apexCooldownMs[kind] + APEX_GAP_MARGIN_MS;
      apexLastSentAt = Date.now();
      return result;
    } catch (error) {
      apexSuccessStreak[kind] = 0;
      if (isApexRateLimited(error)) {
        apexCooldownMs[kind] = Math.min(
          APEX_GAP_CEIL_MS,
          Math.max(
            APEX_GAP_FLOOR_MS[kind],
            Math.round(apexCooldownMs[kind] * APEX_GAP_GROW),
          ),
        );
      }
      apexNextAllowedAt[kind] =
        Date.now() + apexCooldownMs[kind] + APEX_GAP_MARGIN_MS;
      apexLastSentAt = Date.now();
      throw error;
    }
  };

  const pending = apexCommandChain.then(run, run);
  apexCommandChain = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

/**
 * options:
 * - { useManualScheduleId: false, manualScheduleId: number|null }：默认自动识别
 * - { useManualScheduleId: true, manualScheduleId: number }：手动ID优先
 * - 兼容旧调用 batchApexGuess(153)：按手动ID处理
 */
export function resolveApexScheduleSelection(options = {}, nowMs = Date.now()) {
  if (typeof options === "number" || typeof options === "string") {
    const scheduleId = normalizeApexScheduleId(options);
    if (!scheduleId) {
      return {
        scheduleId: null,
        source: "manual",
        conf: null,
        error: "传入的手动赛程ID不是有效正整数",
      };
    }
    return {
      scheduleId,
      source: "manual",
      conf: getApexScheduleConf(scheduleId),
      error: null,
    };
  }

  if (options?.useManualScheduleId === true) {
    const scheduleId = normalizeApexScheduleId(options.manualScheduleId);
    if (!scheduleId) {
      return {
        scheduleId: null,
        source: "manual",
        conf: null,
        error: "手动ID开关已开启，但没有填写有效赛程ID；不会回退自动识别",
      };
    }
    return {
      scheduleId,
      source: "manual",
      conf: getApexScheduleConf(scheduleId),
      error: null,
    };
  }

  const auto = getAutoApexSchedule(nowMs);
  if (!auto.ok) {
    return {
      scheduleId: null,
      source: "config",
      conf: null,
      error: auto.reason,
    };
  }
  return {
    scheduleId: auto.schedule.id,
    source: "config",
    conf: auto.schedule,
    status: auto.status,
    error: null,
  };
}

export function createTasksApex(deps) {
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

  const wait = typeof deps.wait === "function"
    ? deps.wait
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const log = (text, type = "info") => addLog({
    time: new Date().toLocaleTimeString(),
    message: text,
    type,
  });

  const send = (tokenId, cmd, params = {}, timeout = 8000) =>
    sendApexCommand(
      tokenStore,
      tokenId,
      cmd,
      params,
      timeout,
      wait,
      () => shouldStop.value,
    );

  const fetchApexInfo = async (tokenId) => {
    const response = await send(tokenId, "apex_getroleinfo", {});
    if (
      !response ||
      !response.apexRoleInfo ||
      typeof response.apexRoleInfo !== "object"
    ) {
      throw new Error("apex_getroleinfo 未返回有效 apexRoleInfo");
    }
    return response.apexRoleInfo;
  };

  const batchApexGuess = async (options = {}) => {
    const selectedIds = [...new Set(selectedTokens.value || [])];
    if (!selectedIds.length) return [];

    const injectedNowMs =
      options && typeof options === "object" && Number.isFinite(options.nowMs)
        ? options.nowMs
        : null;
    const nowProvider = injectedNowMs === null
      ? () => Date.now()
      : () => injectedNowMs;
    const selection = resolveApexScheduleSelection(options, nowProvider());
    const accountResults = [];

    isRunning.value = true;
    shouldStop.value = false;
    selectedIds.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    try {
      if (!selection.scheduleId) {
        const detail = `无法识别唯一可竞猜赛程：${selection.error || "赛程ID无效"}；本轮未发送领奖或竞猜请求`;
        selectedIds.forEach((id) => {
          tokenStatus.value[id] = "failed";
          accountResults.push({ tokenId: id, status: "failed", details: [detail], warnings: [detail] });
        });
        log(detail, "warning");
        message?.warning?.("未识别到唯一有效赛程，已停止新竞猜");
        return accountResults;
      }

      const scheduleId = selection.scheduleId;
      const claimScheduleIds = selection.conf
        ? getApexClaimScheduleIds(scheduleId, APEX_CLAIM_HISTORY_ROUNDS)
        : [];
      const currentRound = selection.conf ? Number(selection.conf.round) : null;
      const claimRoundCount = selection.conf
        ? Math.min(APEX_CLAIM_HISTORY_ROUNDS + 1, currentRound)
        : 0;
      const claimRoundNumbers = Array.from(
        { length: claimRoundCount },
        (_, index) => currentRound - index,
      );
      const scheduleName = selection.conf?.stageName || "手动指定赛程";
      const selectionLabel = selection.source === "manual"
        ? `手动ID ${scheduleId}`
        : `配置表自动识别 ID ${scheduleId}`;

      log(
        `本轮采用${selectionLabel}${selection.conf ? `（第${selection.conf.round}期·${scheduleName}）` : "（ID不在第一赛季配置快照中）"}`,
      );
      if (claimScheduleIds.length) {
        log(
          `领奖范围：最近${claimRoundNumbers.length}期（${claimRoundNumbers.map((round) => `第${round}期`).join("、")}），仅检查赛程ID：${claimScheduleIds.join(",")}`,
        );
      } else {
        log("当前赛程无法从第一赛季配置表确定领奖范围；跳过领奖，不扫描历史记录", "warning");
      }

      const taskPromises = selectedIds.map(async (tokenId) => {
        if (shouldStop.value) {
          tokenStatus.value[tokenId] = "stopped";
          accountResults.push({ tokenId, status: "stopped", details: ["用户主动停止，未执行"] });
          return;
        }

        tokenStatus.value[tokenId] = "running";
        const token = (tokens.value || []).find((item) => item.id === tokenId);
        const tokenName = token?.name || String(tokenId);

        let claimSuccess = 0;
        let claimUnconfirmed = 0;
        let guessSuccess = 0;
        let guessSkipped = 0;
        let guessFailed = 0;
        let guessUnconfirmed = 0;
        let tokenHadFailure = false;
        let tokenHadWarning = false;
        let accountReason = "";

        try {
          await ensureConnection(tokenId);
          log(`=== 开始逐鹿盐山处理: ${tokenName} ===`);

          let apexInfo = await fetchApexInfo(tokenId);
          const accountSeason = Number(apexInfo.resetTime?.season);
          if (
            selection.conf &&
            Number.isFinite(accountSeason) &&
            accountSeason > 0 &&
            accountSeason !== Number(selection.conf.season)
          ) {
            accountReason = `${tokenName} 账号赛季为${accountSeason}，与赛程配置赛季${selection.conf.season}不一致；停止竞猜和领奖`;
            tokenStatus.value[tokenId] = "failed";
            log(accountReason, "warning");
            return;
          }
          const initialPendingClaims = getApexPendingClaims(
            apexInfo.guessClaimMap,
            claimScheduleIds,
          );

          // 按配置范围领取当前期及指定历史期；首次遇到未确认时停止后续领奖请求。
          for (const claim of initialPendingClaims) {
            if (shouldStop.value) break;
            if (
              readClaimState(apexInfo, claim.scheduleId, claim.teamId) !== false
            ) continue;

            let claimError = null;
            try {
              await send(tokenId, "apex_guessclaim", {
                scheduleId: claim.scheduleId,
                teamId: claim.teamId,
              });
            } catch (error) {
              claimError = error;
            }

            await wait(250);
            try {
              apexInfo = await fetchApexInfo(tokenId);
            } catch (readError) {
              claimUnconfirmed += 1;
              tokenHadFailure = true;
              log(
                `${tokenName} 领奖结果待核验 ${claim.scheduleId}/${claim.teamId}：回读失败；不自动重发，也不继续竞猜（${readError.message}）`,
                "warning",
              );
              break;
            }

            if (claimError?.apexCancelled && shouldStop.value) {
              log(`${tokenName} 用户已停止，排队中的领奖请求未发送`, "warning");
              break;
            }

            const confirmed =
              readClaimState(apexInfo, claim.scheduleId, claim.teamId) === true;
            if (confirmed) {
              claimSuccess += 1;
              const claimRound = getApexScheduleConf(claim.scheduleId)?.round;
              log(
                `${tokenName} 已确认领取第${claimRound ?? "未知"}期奖励 ${claim.scheduleId}/${claim.teamId}${claimError ? "（请求异常后由回读确认）" : ""} ✓`,
                "success",
              );
              await wait(DEFAULT_DELAY_MS);
              continue;
            }

            claimUnconfirmed += 1;
            tokenHadWarning = true;
            const errorText = claimError?.message || "服务器状态仍未变为 true";
            const errorCodeMatch = errorText.match(/(?:^|[^0-9])(200020|20020)(?:$|[^0-9])/);
            if (errorCodeMatch) {
              log(
                `${tokenName} 领奖未确认 ${claim.scheduleId}/${claim.teamId}：服务器错误 ${errorCodeMatch[1]}；停止本账号后续领奖请求，不重试`,
                "warning",
              );
            } else {
              log(
                `${tokenName} 领奖未确认 ${claim.scheduleId}/${claim.teamId}：${errorText}；停止本账号后续领奖请求，不重试`,
                "warning",
              );
            }
            break;
          }

          if (shouldStop.value) {
            tokenStatus.value[tokenId] = "stopped";
            accountReason = `${tokenName} 已停止；领奖确认 ${claimSuccess}、待核验 ${claimUnconfirmed}`;
            log(accountReason, "warning");
            return;
          }
          if (tokenHadFailure) {
            tokenStatus.value[tokenId] = "failed";
            accountReason = "领奖状态无法可靠回读；为避免使用旧状态，本轮不提交新竞猜";
            log(`${tokenName} ${accountReason}`, "warning");
            return;
          }

          const pendingAfterClaims = getApexPendingClaims(
            apexInfo.guessClaimMap,
            claimScheduleIds,
          ).length;
          if (pendingAfterClaims > 0) {
            tokenHadWarning = true;
          }

          // 阶段二：完整读取当前 scheduleId 的分页对阵。
          const allGroups = [];
          const pageFingerprints = new Set();
          let idx = 0;
          let pageCount = 0;
          let reachedEnd = false;
          let paginationError = "";

          while (pageCount < MAX_GUESS_PAGES) {
            if (shouldStop.value) break;
            const response = await send(tokenId, "apex_getguesslist", {
              scheduleId,
              idx,
            });
            if (!Array.isArray(response?.apexGuessList)) {
              paginationError = "服务器未返回有效 apexGuessList 数组";
              break;
            }

            const groups = response.apexGuessList;
            if (groups.length === 0) {
              if (response?.last === false) {
                paginationError = "服务器返回空页但 last=false，分页完整性无法确认";
              } else {
                reachedEnd = true;
              }
              break;
            }

            const fingerprint = JSON.stringify(
              groups.map((group) =>
                Array.isArray(group)
                  ? group.slice(0, 2).map((team) => String(team?.teamId ?? ""))
                  : [],
              ),
            );
            if (pageFingerprints.has(fingerprint)) {
              paginationError = `分页索引 ${idx} 返回重复页面，停止竞猜`;
              break;
            }
            pageFingerprints.add(fingerprint);
            allGroups.push(...groups);
            pageCount += 1;

            if (response?.last === true) {
              reachedEnd = true;
              break;
            }

            // idx 是对阵列表偏移量，不是活动期数；按实际返回组数推进。
            idx += groups.length;
            await wait(250);
          }

          if (shouldStop.value) {
            tokenStatus.value[tokenId] = "stopped";
            log(`${tokenName} 已停止；本轮未继续提交竞猜`, "warning");
            return;
          }
          if (!reachedEnd) {
            tokenHadFailure = true;
            tokenStatus.value[tokenId] = "failed";
            accountReason = `赛程 ${scheduleId} 分页未完整：${paginationError || `超过 ${MAX_GUESS_PAGES} 页仍未结束`}；未提交任何新竞猜`;
            log(`${tokenName} ${accountReason}`, "warning");
            return;
          }
          if (!allGroups.length) {
            tokenHadWarning = true;
            tokenStatus.value[tokenId] = "completed";
            accountReason = `赛程 ${scheduleId} 没有返回对阵；未提交竞猜`;
            log(`${tokenName} ${accountReason}`, "warning");
            return;
          }

          log(
            `${tokenName} 赛程 ${scheduleId} 已完整读取 ${allGroups.length} 组对阵（${pageCount}页）`,
          );

          let guessedTeamIds = readGuessedTeamIds(apexInfo, scheduleId);

          // 阶段三：任一方已竞猜即跳过整场；只比较 cheerCnt。
          for (const group of allGroups) {
            if (shouldStop.value) break;

            // 自动识别模式下，每次新提交前重新检查本地时钟对应的配置状态。
            // 手动覆盖模式由用户负责确认活动时段，不做自动状态拦截。
            if (selection.source === "config") {
              const currentStatus = getScheduleStatus(
                scheduleId,
                nowProvider(),
              );
              if (
                currentStatus !== ApexScheduleStatus.Unlocked &&
                currentStatus !== ApexScheduleStatus.Locked
              ) {
                tokenHadFailure = true;
                accountReason = `赛程 ${scheduleId} 已不处于可竞猜状态（status=${currentStatus}）；停止后续提交`;
                log(`${tokenName} ${accountReason}`, "warning");
                break;
              }
            }

            if (
              !Array.isArray(group) ||
              group.length < 2 ||
              !group[0] ||
              !group[1]
            ) {
              guessSkipped += 1;
              tokenHadWarning = true;
              log(`${tokenName} 赛程 ${scheduleId} 存在不完整对阵，跳过`, "warning");
              continue;
            }

            const [team0, team1] = group;
            if (
              isApexGroupAlreadyGuessed([team0, team1], guessedTeamIds)
            ) {
              guessSkipped += 1;
              continue;
            }

            const decision = chooseApexMajority(team0, team1);
            if (!decision) {
              guessSkipped += 1;
              tokenHadWarning = true;
              log(
                `${tokenName} ${team0.name || team0.teamId} / ${team1.name || team1.teamId} 的 cheerCnt 缺失、异常或相同，跳过竞猜`,
                "warning",
              );
              continue;
            }

            let guessError = null;
            let guessResponse = null;
            try {
              // 游戏协议 apex_guess 只提交 teamId；scheduleId 由当前开放赛程上下文决定。
              guessResponse = await send(tokenId, "apex_guess", {
                teamId: decision.team.teamId,
              });
            } catch (error) {
              guessError = error;
            }

            await wait(250);
            try {
              apexInfo = await fetchApexInfo(tokenId);
            } catch (readError) {
              guessUnconfirmed += 1;
              tokenHadFailure = true;
              log(
                `${tokenName} 竞猜 ${decision.team.name || decision.team.teamId} 结果待核验：回读失败，不自动重发且停止后续竞猜（${readError.message}）`,
                "warning",
              );
              break;
            }

            if (guessError?.apexCancelled && shouldStop.value) {
              log(`${tokenName} 用户已停止，排队中的竞猜请求未发送`, "warning");
              break;
            }

            guessedTeamIds = readGuessedTeamIds(apexInfo, scheduleId);
            if (guessedTeamIds.has(String(decision.team.teamId))) {
              guessSuccess += 1;
              const percent = `${decision.share.toFixed(2)}%`;
              const serverCount = Number.isFinite(
                Number(guessResponse?.newGuessCnt),
              )
                ? `，服务器计数 ${guessResponse.newGuessCnt}`
                : "";
              log(
                `${tokenName} 已确认竞猜 ${decision.team.name || decision.team.teamId}，支持占比 ${percent}（cheerCnt ${decision.count}/${decision.total}${serverCount}）✓`,
                "success",
              );
            } else if (
              isApexGroupAlreadyGuessed([team0, team1], guessedTeamIds)
            ) {
              guessSkipped += 1;
              tokenHadWarning = true;
              log(
                `${tokenName} ${team0.name || team0.teamId} / ${team1.name || team1.teamId} 已由其他请求完成竞猜，跳过`,
                "warning",
              );
            } else {
              if (guessError) {
                guessFailed += 1;
                log(
                  `${tokenName} 竞猜 ${decision.team.name || decision.team.teamId} 失败且回读未确认：${guessError.message}；不自动重发，停止后续竞猜`,
                  "error",
                );
              } else {
                guessUnconfirmed += 1;
                log(
                  `${tokenName} 竞猜 ${decision.team.name || decision.team.teamId} 请求已返回，但 guessMap 未确认；不自动重发，停止后续竞猜`,
                  "warning",
                );
              }
              tokenHadFailure = true;
              break;
            }

            await wait(DEFAULT_DELAY_MS);
          }

          if (shouldStop.value) {
            tokenStatus.value[tokenId] = "stopped";
            accountReason = "用户主动停止；本轮不再提交后续竞猜";
            log(`${tokenName} ${accountReason}`, "warning");
            return;
          }

          const finalPendingClaims = getApexPendingClaims(
            apexInfo.guessClaimMap,
            claimScheduleIds,
          ).length;
          tokenStatus.value[tokenId] = tokenHadFailure ? "failed" : "completed";
          log(
            `=== ${tokenName} 逐鹿盐山结束：前一期领奖确认 ${claimSuccess}、待核验 ${claimUnconfirmed}、剩余可领 ${finalPendingClaims}；竞猜确认 ${guessSuccess}、跳过 ${guessSkipped}、失败 ${guessFailed}、待核验 ${guessUnconfirmed} ===`,
            tokenHadFailure || tokenHadWarning || claimUnconfirmed || guessFailed || guessUnconfirmed
              ? "warning"
              : "success",
          );
        } catch (error) {
          accountReason = error?.message || String(error);
          tokenStatus.value[tokenId] = "failed";
          log(`${tokenName} 逐鹿盐山处理失败：${accountReason}`, "error");
        } finally {
          const currentStatus = tokenStatus.value[tokenId] || "failed";
          const finalStatus = currentStatus === "completed" && tokenHadWarning ? "warning" : currentStatus;
          tokenStatus.value[tokenId] = finalStatus;
          const summary = `赛程 ${scheduleId}：领奖确认 ${claimSuccess}、待核验 ${claimUnconfirmed}；竞猜确认 ${guessSuccess}、跳过 ${guessSkipped}、失败 ${guessFailed}、待核验 ${guessUnconfirmed}`;
          const detail = accountReason || summary;
          accountResults.push({ tokenId, status: finalStatus, details: [detail],
            warnings: finalStatus === "warning" ? [detail] : [],
            verificationRequired: claimUnconfirmed > 0 || guessUnconfirmed > 0,
            verificationDetails: claimUnconfirmed > 0 || guessUnconfirmed > 0 ? [summary] : [] });
          try {
            tokenStore.closeWebSocketConnection(tokenId);
          } finally {
            releaseConnectionSlot(tokenId);
          }
          log(
            `${tokenName} 连接已关闭（队列: ${connectionQueue?.active ?? 0}/${batchSettings?.maxActive ?? 0}）`,
          );
        }
      });

      await Promise.all(taskPromises);
    } finally {
      isRunning.value = false;
      currentRunningTokenId.value = null;
    }

    message?.success?.("批量逐鹿盐山竞猜/补领奖结束");
    return accountResults;
  };

  return { batchApexGuess };
}
