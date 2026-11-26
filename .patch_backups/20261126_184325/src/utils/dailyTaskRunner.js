import { getActivityCycle } from "./autoSchedule/activityCycle.js";
import { runDailyBlackMarket, MARKET_LIST_STAGE } from "./batch/dailyBlackMarket.js";
import { runHangUpShare, runHangUpAddTime, runHangUpLegacy } from "./batch/hangUpWorkflow.js";
import { createBottleTaskContext, runBottleAction } from "./batch/bottleWorkflow.js";
import { dailyConnectionFailure, markDailyConnectionError } from "./batch/dailyConnectionPolicy.js";
import { dailyDreamPreflight, getDreamRound } from "./dreamStatePolicy.js";
import { useTokenStore } from "@/stores/tokenStore";
import { extractDreamBattleTeam } from "@/utils/dreamTeam";
import {
  DREAM_UNLOCK_LEVEL,
  GENIE_UNLOCK_LEVEL,
  LEGACY_HANGUP_UNLOCK_AFTER_LEVEL,
  getMainStageLevel,
  meetsMainStageRequirement,
} from "@/utils/gameFeatureUnlocks";

// 辅助函数
const pickArenaTargetId = (targets) => {
  if (!targets) return null;

  // Handle if targets is an array directly
  if (Array.isArray(targets)) {
    const candidate = targets[0];
    return candidate?.roleId || candidate?.id || candidate?.targetId;
  }

  const candidate =
    targets?.rankList?.[0] ||
    targets?.roleList?.[0] ||
    targets?.targets?.[0] ||
    targets?.targetList?.[0] ||
    targets?.list?.[0];

  if (candidate) {
    if (candidate.roleId) return candidate.roleId;
    if (candidate.id) return candidate.id;
    if (candidate.targetId) return candidate.targetId;
  }

  return targets?.roleId || targets?.id || targets?.targetId;
};

const isTodayAvailable = (statisticsTime) => {
  if (!statisticsTime) return true;

  // 如果有时间戳，检查是否为今天
  const today = new Date().toDateString();
  //系统返回得时间戳是秒，要转换成毫秒
  const recordDate = new Date(statisticsTime * 1000).toDateString();

  return today !== recordDate;
};

const getTodayBossId = () => {
  const DAY_BOSS_MAP = [9904, 9905, 9901, 9902, 9903, 9904, 9905]; // 周日~周六
  const dayOfWeek = new Date().getDay();
  return DAY_BOSS_MAP[dayOfWeek];
};

// Free gacha runs on Tuesday / Thursday / Saturday in the game's UTC+8 day.
const isFreeGachaActivityDay = (now = Date.now()) =>
  [2, 4, 6].includes(new Date(now + 8 * 60 * 60 * 1000).getUTCDay());

export class DailyTaskRunner {
  constructor(tokenStore, delaySettings = null, options = {}) {
    this.tokenStore = tokenStore;
    this.productionLogs = options.productionLogs === true;
    this.verboseLogs = options.verboseLogs === true;
    try { this.verboseLogs ||= globalThis.localStorage?.getItem("batch_daily_debug_verbose") === "1"; } catch { /* optional diagnostics */ }
    this.sharedBottleTaskContext = options.bottleTaskContext;
    this.delaySettings = delaySettings || {
      commandDelay: 500,
      taskDelay: 500
    };
    // BATCH_DAILY_WARNING_V1: single-account callers keep their existing policy.
    this.errorClassifier = typeof options.classifyError === "function"
      ? options.classifyError
      : null;
  }

  classifyTaskError(error) {
    return this.errorClassifier
      ? this.errorClassifier(error)
      : {
          level: "error",
          code: error?.code ?? null,
          message: String(error?.message || error || "未知错误"),
        };
  }

  log(message, type = "info", important = false) {
    if (this.productionLogs && !this.verboseLogs && !important && type !== "error" &&
        !(type === "warning" && /待核验|未确认|无法确认|结果未知|未执行|中断|未收到|恢复.*失败/.test(message))) return;
    if (this.productionLogs) message = `[日常][${this.logAccount || "未知账号"}] ${String(message).replace(/^\[[^\]]+\]\s*/, "")}`;
    if (this.callbacks?.onLog) {
      this.callbacks.onLog({
        time: new Date().toLocaleTimeString(),
        message,
        type,
      });
    }
  }

  checkCancelled() {
    if (!this.restoringAfterStop && this.callbacks?.shouldStop?.()) {
      throw Object.assign(new Error("用户已停止，未发送后续日常请求"), { stopped: true });
    }
  }

  async executeGameCommand(
    tokenId,
    cmd,
    params = {},
    description = "",
    timeout = 8000,
  ) {
    try {
      this.checkCancelled();
      if (description) this.log(`执行: ${description}`);
      const result = await this.tokenStore.sendMessageWithPromise(
        tokenId,
        cmd,
        params,
        timeout,
      );
      await new Promise((resolve) => setTimeout(resolve, this.delaySettings.commandDelay));
      if (description) this.log(`${description} - 成功`, "success");
      return result;
    } catch (error) {
      markDailyConnectionError(error, this.tokenStore, tokenId);
      // Keep command context even when the transport supplies only message/code.
      if (error && typeof error === "object") {
        error.requestCmd = cmd;
        error.requestParams = params;
      }
      if (["task_claimdailyreward", "task_claimweekreward"].includes(cmd) && !error?.stopped &&
          this.classifyTaskError(error).level !== "normal") {
        this.log(`奖励领取诊断：阶段=${description || "任务奖励领取"}；命令=${cmd}；请求参数={}；${error?.message || "无错误说明"}；本步骤未自动重发`, "warning", true);
      }
      // The batch task loop owns failure/warning logs and results.
      if (description && !this.errorClassifier) {
        const token = this.tokenStore.gameTokens.find((t) => t.id === tokenId);
        const tokenName = token?.name || tokenId;
        this.log(`[${tokenName}] ${description} - 失败: ${error.message}`, "error");
      }
      throw error;
    }
  }

  // Verified free goods only; use each server activity window and claim record.
  async claimBoxWeekBenefit(tokenId, roleData, activityId = 7) {
    const benefits = {
      7: { name: "宝箱周福利", prefix: "box-week-benefit", buyType: 1,
        rewards: [[3, 1022, 100], [3, 2002, 10]], description: "白玉×100、青铜宝箱×10" },
      6: { name: "招募周福利", prefix: "recruit-week-benefit", buyType: 1,
        rewards: [[3, 1001, 5]], description: "招募令×5" },
      5: { name: "金砖商店免费福利", prefix: "diamond-store-benefit", buyType: 1,
        rewards: [[2, 2, 200]], description: "金砖×200" },
      9: { name: "江湖黑市免费福利", prefix: "jianghu-free-benefit", buyType: 3,
        rewards: [[2, 2, 500]], description: "金砖×500" },
    };
    const benefit = benefits[activityId];
    if (!benefit) throw new Error("未核验的免费活动编号");
    const result = (taskStatus, detail) => ({ taskStatus, detail,
      ...(taskStatus === "warning" ? { verificationRequired: true, verificationDetails: [detail] } : {}) });
    const warn = detail => result("warning", detail);
    const roleId = roleData?.roleId;
    const unwrap = response => {
      if (response?.code != null && response.code !== 0) throw new Error(`服务器返回 ${response.code}`);
      return response?.body ?? response?.data ?? response;
    };
    const timeValue = value => value instanceof Date ? value.getTime()
      : typeof value === "string" ? Date.parse(value) : value;
    const rewardsMatch = rewards => Array.isArray(rewards) && rewards.length === benefit.rewards.length
      && benefit.rewards.every(([type, itemId, value]) => rewards.some(r => r.type === type
        && r.itemId === itemId && r.value === value && (r.ext == null || r.ext === 0)));
    const inspect = response => {
      const activity = unwrap(response)?.activity;
      if (!Array.isArray(activity?.activity)) throw new Error("活动目录缺失");
      const matches = activity.activity.filter(a => a.id === activityId);
      if (!matches.length) return null;
      if (matches.length !== 1) throw new Error("活动目录重复");
      const active = matches[0], start = timeValue(active.openTime), end = timeValue(active.endTime);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw new Error("活动时间无效");
      if (Date.now() < start || Date.now() >= end) return null;
      const good = active.data?.goodsList?.[0];
      if (active.type !== 4 || active.data?.buyType !== benefit.buyType || !good || good.price !== 0
        || good.limit !== 1 || !rewardsMatch(good.rewardList)) throw new Error("免费商品价格、限领或奖励发生变化");
      const complete = activity.myStoreInfo?.[activityId]?.complete;
      if (!complete || typeof complete !== "object" || Array.isArray(complete)) throw new Error("领取记录缺失");
      const used = Object.hasOwn(complete, "0") ? complete["0"] : 0;
      if (!Number.isSafeInteger(used) || used < 0 || used > 1) throw new Error("领取次数无效");
      return { start, end, used };
    };
    const run = async () => {
      let current;
      try { current = inspect(await this.executeGameCommand(tokenId, "activity_get", {}, "")); }
      catch (error) {
        if (error?.stopped || dailyConnectionFailure(error, this.tokenStore, tokenId)) throw error;
        return warn(`${benefit.name}未执行：${error.message}`);
      }
      if (!current) return result("skipped", `${benefit.name}活动未开放，跳过`);
      if (!Number.isSafeInteger(roleId) || roleId <= 0) return warn(`角色身份缺失，未领取${benefit.name}`);
      const key = `${benefit.prefix}:pending:${roleId}:${current.start}`;
      let storage;
      try { storage = globalThis.localStorage; }
      catch { return warn(`无法读取防重复记录，未领取${benefit.name}`); }
      if (current.used >= 1) {
        try { storage?.removeItem(key); } catch { /* the server has confirmed the claim */ }
        return result("skipped", `${benefit.name}已领取，跳过`);
      }
      try {
        if (!storage) throw new Error("storage unavailable");
        if (storage.getItem(key)) return warn(`上次${benefit.name}结果待核验，本次未重发；请核对游戏内领取状态`);
        this.checkCancelled();
        // Persist before sending; failed/late replies never trigger another claim.
        const marker = JSON.stringify({ at: Date.now(), activityId, goodsIndex: 0 });
        storage.setItem(key, marker);
        if (storage.getItem(key) !== marker) throw new Error("storage write failed");
      } catch (error) {
        if (error?.stopped) throw error;
        return warn(`无法保存防重复记录，未领取${benefit.name}`);
      }
      let reply;
      try {
        reply = await this.executeGameCommand(tokenId, "activity_buystoregoods", { activityId, goodsIndex: 0, buyNum: 1 }, "");
        // Once sent, complete the readback even if the user has pressed stop.
        const after = inspect(await this.tokenStore.sendMessageWithPromise(tokenId, "activity_get", {}, 8000));
        if (!after || after.start !== current.start || after.used !== 1 || !rewardsMatch(unwrap(reply)?.reward)) {
          return warn(`${benefit.name}回包或领取记录未核实；已保留防重记录，不自动重发`);
        }
        try { storage.removeItem(key); } catch { /* next run can resolve from the server record */ }
        this.log(`${benefit.name}已核验：${benefit.description}`, "success", true);
        return result("completed", `已领取并回读确认：${benefit.description}`);
      } catch (error) {
        // Closing clears any queued timed-out request. Keep the marker across reloads.
        try {
          const close = this.tokenStore.closeWebSocketConnectionAsync || this.tokenStore.closeWebSocketConnection;
          if (close) await close.call(this.tokenStore, tokenId);
        } catch { /* pending marker still blocks replay */ }
        error.haltDaily = true;
        error.requestCmd ||= reply ? "activity_get" : "activity_buystoregoods";
        throw error;
      }
    };
    const lockName = `${benefit.prefix}:${roleId || tokenId}`;
    if (globalThis.navigator?.locks?.request) {
      return globalThis.navigator.locks.request(lockName, { ifAvailable: true }, lock =>
        lock ? run() : result("skipped", `其他标签页正在核验${benefit.name}，跳过`));
    }
    // Older browsers: in-process exclusion plus persistent uncertain-result protection.
    const running = DailyTaskRunner.boxBenefitRuns ||= new Set();
    if (running.has(lockName)) return result("skipped", `该账号正在核验${benefit.name}，跳过`);
    running.add(lockName);
    try { return await run(); } finally { running.delete(lockName); }
  }

  async switchToFormationIfNeeded(tokenId, targetFormation, formationName) {
    try {
      // 尝试从本地缓存获取当前阵容信息
      // 注意：这里直接读取 store 中的 gameData 可能不是最新的，如果是批量跑，建议每次都获取最新的
      // 或者我们假设 tokenStore.gameData 会随着 sendMessage 更新（如果 store 有处理逻辑）
      // 安全起见，这里先从服务器获取

      this.log(`检查${formationName}配置...`);
      const teamInfo = await this.executeGameCommand(
        tokenId,
        "presetteam_getinfo",
        {},
        "获取阵容信息",
      );

      if (!teamInfo || !teamInfo.presetTeamInfo) {
        this.log(`阵容信息异常: ${JSON.stringify(teamInfo)}`, "warning");
      }

      const currentFormation = teamInfo?.presetTeamInfo?.useTeamId;
      this.log(`当前阵容: ${currentFormation}`);

      if (currentFormation === targetFormation) {
        this.log(
          `当前已是${formationName}${targetFormation}，无需切换`,
          "success",
        );
        return false;
      }

      this.log(
        `当前阵容: ${currentFormation}, 目标阵容: ${targetFormation}，开始切换...`,
      );
      await this.executeGameCommand(
        tokenId,
        "presetteam_saveteam",
        { teamId: targetFormation },
        `切换到${formationName}${targetFormation}`,
      );

      this.log(`成功切换到${formationName}${targetFormation}`, "success");
      return true;
    } catch (error) {
      if (error?.haltDaily || error?.stopped || this.classifyTaskError(error).level === "warning") throw error;
      this.log(`阵容检查失败，尝试强制切换: ${error.message}`, "warning");
      try {
        await this.executeGameCommand(
          tokenId,
          "presetteam_saveteam",
          { teamId: targetFormation },
          `强制切换到${formationName}${targetFormation}`,
        );
        return true;
      } catch (fallbackError) {
        if (this.classifyTaskError(fallbackError).level === "warning") throw fallbackError;
        this.log(`强制切换也失败: ${fallbackError.message}`, "error");
        throw fallbackError;
      }
    }
  }

  loadSettings(roleId) {
    try {
      const raw = localStorage.getItem(`daily-settings:${roleId}`);
      const defaultSettings = {
        arenaFormation: 1,
        bossFormation: 1,
        bossTimes: 2,
        claimBottle: true,
        payRecruit: true,
        openBox: true,
        arenaEnable: true,
        claimHangUp: true,
        claimEmail: true,
        blackMarketPurchase: true,
        freeGachaEnable: true,
      };
      return raw ? { ...defaultSettings, ...JSON.parse(raw) } : defaultSettings;
    } catch (error) {
      console.error("Failed to load settings:", error);
      return null;
    }
  }

  async run(tokenId, callbacks = {}, customSettings = null) {
    this.callbacks = callbacks;
    this.logAccount = this.tokenStore.gameTokens?.find(token => token.id === tokenId)?.name || tokenId;
    this.bottleTaskContext = this.sharedBottleTaskContext || createBottleTaskContext({ dailyGoal: true });
    this.checkCancelled();
    const settings = customSettings || this.loadSettings(tokenId); // 优先使用传入的设置

    // 获取角色信息以确认 roleId 和 任务状态
    this.log("正在获取角色信息...");
    let roleInfoResp;
    try {
      roleInfoResp = await this.tokenStore.sendGetRoleInfo(tokenId);
      this.log("角色信息获取成功", "success");
    } catch (error) {
      markDailyConnectionError(error, this.tokenStore, tokenId);
      if (!this.errorClassifier) {
        this.log(`获取角色信息失败: ${error.message}`, "error");
      }
      // Without role data, the batch entry point ends this account's run.
      throw error;
    }

    this.checkCancelled();
    const roleData = roleInfoResp?.role;
    if (!roleData) {
      throw new Error("角色数据不存在");
    }

    // 重新加载设置，使用正确的 roleId (虽然通常 tokenId 就是 roleId 或者一一对应，但为了保险)
    // 在这个项目中，tokenId 似乎就是 roleId 或者用于标识
    // DailyTaskStatus.vue 中: const role = getCurrentRole() -> roleId: tokenStore.selectedToken.id
    // 所以 tokenId 就是 key

    this.log("开始执行每日任务补差");

    // 读取并保存当前阵容信息
    let originalFormation = null;
    let dreamBattleTeam = null;
    const preparationWarnings = [];
    try {
      this.log("读取当前阵容信息...");
      const teamInfo = await this.executeGameCommand(
        tokenId,
        "presetteam_getinfo",
        {},
        "获取当前阵容信息",
      );
      originalFormation = teamInfo?.presetTeamInfo?.useTeamId;
      dreamBattleTeam = extractDreamBattleTeam(teamInfo);
      this.log(`当前阵容: ${originalFormation}`);
    } catch (error) {
      if (error?.haltDaily || error?.stopped) throw error;
      const classified = this.classifyTaskError(error);
      if (classified.level === "warning") {
        preparationWarnings.push({
          name: "读取当前阵容",
          status: "warning",
          code: classified.code,
          warning: classified.message,
          requestCmd: error?.requestCmd,
        });
        const token = this.tokenStore.gameTokens.find((t) => t.id === tokenId);
        this.log(`[${token?.name || tokenId}] 读取当前阵容 - 警告[${classified.code}]: ${classified.message}`, "warning");
      } else {
        this.log(`读取当前阵容失败: ${error.message}`, "warning");
      }
    }

    const completedTasks = roleData.dailyTask?.complete ?? {};
    const isTaskCompleted = (taskId) => completedTasks[taskId] === -1;
    const statistics = roleData.statistics ?? {};
    const statisticsTime = roleData.statisticsTime ?? {};
    const mainStageLevel = getMainStageLevel(roleData);
    const dreamUnlocked = meetsMainStageRequirement(
      roleData,
      DREAM_UNLOCK_LEVEL,
    );
    const genieUnlocked = meetsMainStageRequirement(
      roleData,
      GENIE_UNLOCK_LEVEL,
    );

    const taskList = [];

    // Shared with the outer hangup step; scope is exactly this scheduled chain.
    const hangUpAction = async (action) => {
      const outcome = await action({ context: this.bottleTaskContext, tokenId,
        stopped: () => Boolean(this.callbacks?.shouldStop?.()),
        isDisconnected: () => ["disconnected", "closed", "error"].includes(this.tokenStore.getWebSocketStatus?.(tokenId)),
        send: (cmd, params, timeout) => this.executeGameCommand(tokenId, cmd, params, "", timeout),
        spacingMs: this.delaySettings.commandDelay,
      });
      if (["failed", "partial", "stopped"].includes(outcome.status) || outcome.haltDaily) {
        throw Object.assign(new Error(outcome.detail), { code: outcome.code,
          requestCmd: outcome.requestCmd, haltDaily: outcome.haltDaily, stopped: outcome.status === "stopped" });
      }
      return { taskStatus: outcome.status, detail: outcome.detail,
        verificationRequired: outcome.verificationRequired, verificationDetails: outcome.verificationDetails };
    };

    // 1. 基础任务
    if (!isTaskCompleted(2)) {
      taskList.push({
        name: "分享一次游戏",
        execute: () => hangUpAction(runHangUpShare),
      });
    }

    if (!isTaskCompleted(3)) {
      taskList.push({
        name: "赠送好友金币",
        execute: () =>
          this.executeGameCommand(tokenId, "friend_batch", {}, "赠送好友金币"),
      });
    }

    if (!isTaskCompleted(4)) {
      taskList.push({
        name: "免费招募",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "hero_recruit",
            { recruitType: 3, recruitNumber: 1 },
            "免费招募",
          ),
      });

      if (settings.payRecruit) {
        taskList.push({
          name: "付费招募",
          execute: () =>
            this.executeGameCommand(
              tokenId,
              "hero_recruit",
              { recruitType: 1, recruitNumber: 1 },
              "付费招募",
            ),
        });
      }
    }

    if (!isTaskCompleted(6) && isTodayAvailable(statisticsTime["buy:gold"])) {
      for (let i = 0; i < 3; i++) {
        taskList.push({
          name: `免费点金 ${i + 1}/3`,
          execute: () =>
            this.executeGameCommand(
              tokenId,
              "system_buygold",
              { buyNum: 1 },
              `免费点金 ${i + 1}`,
            ),
        });
      }
    }

    if (!isTaskCompleted(5) && settings.claimHangUp) {
      taskList.push({
        name: "领取挂机奖励",
        execute: async () => {
          // DAILY_HANGUP_FIVE_V1: 加钟不计入领取次数。
          // complete[5] 只按现有协议约定识别 -1；不猜测其它值的次数含义。
          for (let attempt = 1; attempt <= 5; attempt++) {
            this.checkCancelled();
            if (attempt > 1) {
              this.log("等待 5.1 秒后继续领取挂机奖励...");
              // 从上一次响应之后等待，不受 commandDelay/taskDelay 调小影响。
              await new Promise((resolve) => setTimeout(resolve, 5100));
            }
            await this.executeGameCommand(
              tokenId,
              "system_claimhangupreward",
              {},
              `领取挂机奖励（本次第 ${attempt}/5 次）`,
            );

            // 直接读取当前账号的服务端数据，避免使用多账号共享的缓存。
            const latestRoleInfo = await this.tokenStore.sendGetRoleInfo(tokenId);
            if (!latestRoleInfo?.role) {
              throw new Error("领取挂机奖励后刷新角色信息失败，已停止后续领取");
            }
            if (latestRoleInfo.role.dailyTask?.complete?.[5] === -1) {
              this.log(`挂机日常已完成，本次成功领取 ${attempt} 次`, "success");
              return;
            }
          }
          this.log("本次已成功领取 5 次挂机奖励", "success");
        },
      });
      taskList.push({ name: "挂机加钟", execute: () => hangUpAction(runHangUpAddTime) });
    }

    // LEGACY_HANGUP_CLAIM_RELEASE_V1
    // 定时“日常任务”使用 run() 开始时已读取的主线关卡。
    // 严格要求 levelId > 8001；关卡未知或 <= 8001 时不生成领取任务。
    if (
      mainStageLevel !== null &&
      mainStageLevel > LEGACY_HANGUP_UNLOCK_AFTER_LEVEL
    ) {
      taskList.push({
        name: "领取功法残卷",
        execute: () => hangUpAction(runHangUpLegacy),
      });
    }

    if (!isTaskCompleted(7) && settings.openBox) {
      taskList.push({
        name: "开启木质宝箱",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "item_openbox",
            { itemId: 2001, number: 10 },
            "开启木质宝箱10个",
          ),
      });
    }

    const bottleAction = async kind => {
      const result = await runBottleAction({ context: this.bottleTaskContext, tokenId, kind,
        stopped: () => Boolean(this.callbacks?.shouldStop?.()),
        send: (cmd, params, timeout) => this.executeGameCommand(tokenId, cmd, params, "", timeout),
      });
      return { taskStatus: result.status, detail: result.detail, consoleDetail: result.consoleDetail,
        verificationRequired: result.verificationRequired };
    };
    taskList.push({ name: "重置盐罐计时", execute: () => bottleAction("reset") });
    if (!isTaskCompleted(14) && settings.claimBottle) {
      taskList.push({ name: "领取盐罐奖励", execute: () => bottleAction("claim") });
    }

    // 2. 竞技场
    if (!isTaskCompleted(13) && settings.arenaEnable) {
      taskList.push({
        name: "竞技场战斗",
        execute: async () => {
          this.log("开始竞技场战斗流程");
          const hour = new Date().getHours();
          if (hour < 6) {
            this.log("当前时间未到6点，跳过竞技场战斗", "warning");
            return;
          }
          if (hour > 22) {
            this.log("当前时间已过22点，跳过竞技场战斗", "warning");
            return;
          }

          await this.switchToFormationIfNeeded(
            tokenId,
            settings.arenaFormation,
            "竞技场阵容",
          );
          await this.executeGameCommand(
            tokenId,
            "arena_startarea",
            {},
            "开始竞技场",
          );

          for (let i = 1; i <= 3; i++) {
            this.log(`竞技场战斗 ${i}/3`);
            let targets;
            try {
              targets = await this.executeGameCommand(
                tokenId,
                "arena_getareatarget",
                {},
                `获取竞技场目标${i}`,
              );
            } catch (err) {
              // Let the batch loop classify this; do not report a successful battle.
              if (this.errorClassifier) throw err;
              this.log(
                `竞技场战斗${i} - 获取对手失败: ${err.message}`,
                "error",
              );
              break;
            }

            const targetId = pickArenaTargetId(targets);
            if (targetId) {
              await this.executeGameCommand(
                tokenId,
                "fight_startareaarena",
                { targetId },
                `竞技场战斗${i}`,
                10000,
              );
            } else {
              this.log(
                `竞技场战斗${i} - 未找到目标: ${JSON.stringify(targets)}`,
                "warning",
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        },
      });
    }

    // 3. BOSS
    if (settings.bossTimes > 0) {
      let alreadyLegionBoss = statistics["legion:boss"] ?? 0;
      if (isTodayAvailable(statisticsTime["legion:boss"])) {
        alreadyLegionBoss = 0;
      }
      const remainingLegionBoss = Math.max(
        settings.bossTimes - alreadyLegionBoss,
        0,
      );

      if (remainingLegionBoss > 0) {
        taskList.push({
          name: "军团BOSS阵容检查",
          provides: "legionBossFormation",
          execute: () =>
            this.switchToFormationIfNeeded(
              tokenId,
              settings.bossFormation,
              "BOSS阵容",
            ),
        });
        for (let i = 0; i < remainingLegionBoss; i++) {
          taskList.push({
            name: `军团BOSS ${i + 1}/${remainingLegionBoss}`,
            requires: "legionBossFormation",
            execute: () =>
              this.executeGameCommand(
                tokenId,
                "fight_startlegionboss",
                {},
                `军团BOSS ${i + 1}`,
                12000,
              ),
          });
        }
      }
    }

    const todayBossId = getTodayBossId();
    taskList.push({
      name: "每日BOSS阵容检查",
      provides: "dailyBossFormation",
      execute: () =>
        this.switchToFormationIfNeeded(
          tokenId,
          settings.bossFormation,
          "BOSS阵容",
        ),
    });
    for (let i = 0; i < 3; i++) {
      taskList.push({
        name: `每日BOSS ${i + 1}/3`,
        requires: "dailyBossFormation",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "fight_startboss",
            { bossId: todayBossId },
            `每日BOSS ${i + 1}`,
            12000,
          ),
      });
    }

    // 4. 固定奖励
    const fixedRewards = [
      { name: "福利签到", cmd: "system_signinreward" },
      { name: "俱乐部", cmd: "legion_signin" },
      { name: "领取每日礼包", cmd: "discount_claimreward" },
      { name: "领取每日免费奖励", cmd: "collection_claimfreereward" },
      { name: "领取免费礼包", cmd: "card_claimreward" },
      {
        name: "领取永久卡礼包",
        cmd: "card_claimreward",
        params: { cardId: 4003 },
      },
    ];

    if (settings.claimEmail) {
      fixedRewards.push({
        name: "领取邮件奖励",
        cmd: "mail_claimallattachment",
      });
    }

    fixedRewards.forEach((reward) => {
      taskList.push({
        name: reward.name,
        execute: () =>
          this.executeGameCommand(
            tokenId,
            reward.cmd,
            reward.params || {},
            reward.name,
          ),
      });
    });

    taskList.push({
      name: "开始领取珍宝阁礼包",
      execute: () =>
        this.executeGameCommand(
          tokenId,
          "collection_goodslist",
          {},
          "开始领取珍宝阁礼包",
        ),
    });
    taskList.push({
      name: "领取珍宝阁免费礼包",
      execute: () =>
        this.executeGameCommand(
          tokenId,
          "collection_claimfreereward",
          {},
          "领取珍宝阁免费礼包",
        ),
    });

    if (
      settings.freeGachaEnable !== false
      && isTodayAvailable(statisticsTime["gacha:free"])
    ) {
      taskList.push({
        name: "免费扭蛋",
        execute: () => {
          if (this.errorClassifier && !isFreeGachaActivityDay()) {
            return { taskStatus: "skipped", detail: "正常跳过：免费扭蛋仅在北京时间周二、周四、周六开放" };
          }
          return this.executeGameCommand(
            tokenId,
            "gacha_drawreward",
            { num: 1, isGroup: false },
            "免费扭蛋",
          );
        },
      });
    }

    // 5. 按现有北京时间周活动识别结果，只生成本周福利任务。
    const benefitWeek = getActivityCycle(Date.now()).type;
    if (benefitWeek === "box") {
      taskList.push({ name: "领取宝箱周免费福利",
        execute: () => this.claimBoxWeekBenefit(tokenId, roleData, 7) });
    } else if (benefitWeek === "blackMarket") {
      taskList.push({ name: "领取金砖商店免费福利",
        execute: () => this.claimBoxWeekBenefit(tokenId, roleData, 5) });
      taskList.push({ name: "领取江湖黑市免费福利",
        execute: () => this.claimBoxWeekBenefit(tokenId, roleData, 9) });
    } else if (benefitWeek === "recruit") {
      taskList.push({ name: "领取招募周免费福利",
        execute: () => this.claimBoxWeekBenefit(tokenId, roleData, 6) });
    }

    if (isTodayAvailable(statistics["artifact:normal:lottery:time"])) {
      for (let i = 0; i < 3; i++) {
        taskList.push({
          name: `免费钓鱼 ${i + 1}/3`,
          execute: () =>
            this.executeGameCommand(
              tokenId,
              "artifact_lottery",
              { lotteryNumber: 1, newFree: true, type: 1 },
              `免费钓鱼 ${i + 1}`,
            ),
        });
      }
    }

    if (genieUnlocked) {
      const kingdoms = ["魏国", "蜀国", "吴国", "群雄"];
      for (let gid = 1; gid <= 4; gid++) {
        if (isTodayAvailable(statisticsTime[`genie:daily:free:${gid}`])) {
          taskList.push({
            name: `${kingdoms[gid - 1]}灯神免费扫荡`,
            execute: () =>
              this.executeGameCommand(
                tokenId,
                "genie_sweep",
                { genieId: gid },
                `${kingdoms[gid - 1]}灯神免费扫荡`,
              ),
          });
        }
      }

      for (let i = 0; i < 3; i++) {
        taskList.push({
          name: `领取免费扫荡卷 ${i + 1}/3`,
          execute: () =>
            this.executeGameCommand(
              tokenId,
              "genie_buysweep",
              {},
              `领取免费扫荡卷 ${i + 1}`,
            ),
        });
      }
    } else {
      this.log(
        `主线 ${mainStageLevel} 关，灯神挑战需达到 ${GENIE_UNLOCK_LEVEL} 关，已跳过灯神相关日常`,
        "warning",
      );
    }

    // 6. 黑市
    // 任务12只代表买过一件，低关卡需要继续检查货架和刷新次数。
    if (settings.blackMarketPurchase && (!isTaskCompleted(12) || !(mainStageLevel >= MARKET_LIST_STAGE))) {
      taskList.push({
        name: "每日黑市采购",
        execute: () => runDailyBlackMarket({
          tokenId, initialRole: roleData, daily: true,
          send: (cmd, params) => this.executeGameCommand(tokenId, cmd, params, ""),
          stopped: () => Boolean(this.callbacks?.shouldStop?.()),
        }),
      });
    }

    // 咸王梦境
    const mengyandayOfWeek = getDreamRound().day;
    const isDreamOpenDay = [0, 1, 3, 4].includes(mengyandayOfWeek);
    if (isDreamOpenDay && dreamUnlocked) {
      taskList.push({
        name: "咸王梦境",
        execute: async () => {
          const inspect = async () => dailyDreamPreflight(await this.executeGameCommand(tokenId, "role_getroleinfo", {}, ""));
          const before = await inspect();
          if (before.status !== "select") return { taskStatus: before.status, detail: before.reason };
          if (!dreamBattleTeam) {
            const presetTeamInfo = await this.executeGameCommand(
              tokenId,
              "presetteam_getinfo",
              {},
              "重新读取梦境阵容",
            );
            dreamBattleTeam = extractDreamBattleTeam(presetTeamInfo);
          }
          if (!dreamBattleTeam) {
            throw new Error("未能读取当前预设阵容，已停止发送梦境请求");
          }

          try {
            await this.executeGameCommand(tokenId, "dungeon_selecthero", { battleTeam: dreamBattleTeam }, "");
            const after = await inspect();
            return after.status === "skipped" && getDreamRound().open ? { taskStatus: "completed", detail: "已读回确认本轮上阵状态" }
              : { taskStatus: "warning", detail: `结果待核验：选将后未确认本轮阵容；${after.reason}` };
          } catch (error) {
            const code = Number(error?.code) || Number(String(error?.message || "").match(/^服务器错误\s*[:：]\s*(\d+)/)?.[1]);
            if (error?.requestCmd === "dungeon_selecthero" && code === 400080) {
              let after; try { after = await inspect(); } catch (_) { /* preserve selection error */ }
              if (after?.status === "skipped" && getDreamRound().open) return { taskStatus: "skipped", detail: `选将400080后读回确认：${after.reason}` };
            }
            throw error;
          }
        },
      });
    } else if (isDreamOpenDay && !dreamUnlocked) {
      this.log(
        `主线 ${mainStageLevel} 关，咸王梦境需达到 ${DREAM_UNLOCK_LEVEL} 关，已跳过`,
        "warning",
      );
    }

    // 深海灯神
    if (
      genieUnlocked &&
      mengyandayOfWeek === 1 &&
      isTodayAvailable(statisticsTime[`genie:daily:free:5`])
    ) {
      taskList.push({
        name: "深海灯神",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "genie_sweep",
            { genieId: 5, sweepCnt: 1 },
            "深海灯神",
          ),
      });
    }

    // 阵容还原
    if (originalFormation) {
      taskList.push({
        name: "阵容还原",
        execute: () =>
          this.switchToFormationIfNeeded(
            tokenId,
            originalFormation,
            "初始阵容",
          ),
      });
    }

    // 7. 任务奖励
    for (let taskId = 1; taskId <= 10; taskId++) {
      taskList.push({
        name: `领取任务奖励${taskId}`,
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "task_claimdailypoint",
            { taskId },
            `领取任务奖励${taskId}`,
            5000,
          ),
      });
    }

    taskList.push(
      {
        name: "领取日常任务奖励",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "task_claimdailyreward",
            {},
            "领取日常任务奖励",
          ),
      },
      {
        name: "领取周常任务奖励",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "task_claimweekreward",
            {},
            "领取周常任务奖励",
          ),
      },
      {
        name: "领取通行证奖励",
        execute: () =>
          this.executeGameCommand(
            tokenId,
            "activity_recyclewarorderrewardclaim",
            { actId: 1 },
            "领取通行证奖励",
          ),
      },
    );

    // 执行。前置阵容读取警告也保留为一个已处理项。
    const totalTasks = taskList.length + preparationWarnings.length;
    const taskResults = [...preparationWarnings];
    const prerequisiteWarnings = new Map();
    this.log(`共有 ${taskList.length} 个任务待执行`);

    let stopped = false;
    let abortReason = "", unexecutedCount = 0;
    for (let i = 0; i < taskList.length; i++) {
      const task = taskList[i];
      if (this.callbacks?.shouldStop?.()) { stopped = true; unexecutedCount = taskList.length - i; break; }
      try {
        const prerequisite = this.errorClassifier && prerequisiteWarnings.get(task.requires);
        if (prerequisite) {
          throw Object.assign(new Error("前置阵容检查出现警告，本次战斗未执行"), {
            code: prerequisite.code,
            requestCmd: prerequisite.requestCmd,
            notExecuted: true,
          });
        }
        const outcome = await task.execute();
        const status = ["completed", "skipped", "warning"].includes(outcome?.taskStatus) ? outcome.taskStatus : "completed";
        taskResults.push({ name: task.name, status, ...(status === "warning" ? { warning: outcome.detail } : {}), detail: outcome?.detail,
          ...(typeof outcome?.verificationRequired === "boolean" ? { verificationRequired: outcome.verificationRequired, verificationDetails: outcome.verificationDetails } : {}) });
        if (outcome?.detail) this.log(`${task.name} - ${outcome.consoleDetail || outcome.detail}`, status === "warning" ? "warning" : "info", outcome.verificationRequired === true || /复用/.test(outcome.detail));
        if (!this.errorClassifier) {
          const progress = Math.floor(((i + 1) / totalTasks) * 100);
          if (this.callbacks?.onProgress) this.callbacks.onProgress(progress);
          await new Promise((resolve) => setTimeout(resolve, this.delaySettings.taskDelay));
        }
      } catch (error) {
        if (error?.stopped) { stopped = true; unexecutedCount = taskList.length - i; break; }
        if (dailyConnectionFailure(error, this.tokenStore, tokenId)) {
          unexecutedCount = taskList.length - i - 1;
          abortReason = `结果待核验：${task.name}（${error?.requestCmd || "命令未返回"}）${error?.message || "连接异常"}；停止本轮日常，后续${unexecutedCount}项未执行，未重发超时命令或整轮日常；若已切换阵容，请在游戏内核对`;
          taskResults.push({ name: task.name, status: "warning", warning: abortReason, requestCmd: error?.requestCmd });
          this.log(abortReason, "warning");
          break;
        }
        const classified = this.classifyTaskError(error);
        if (classified.level === "normal") {
          taskResults.push({ name: task.name, status: classified.status, code: classified.code,
            detail: classified.message, requestCmd: error?.requestCmd,
            originalMessage: classified.originalMessage, normalResponse: true,
            verificationRequired: false });
          this.log(`${task.name} - ${classified.message} [${classified.code}]`, "info");
          continue;
        }
        if (classified.level === "ignore") {
          taskResults.push({ name: task.name, status: "skipped", code: classified.code });
          this.log(`${task.name} - 已跳过[${classified.code}]`, "info");
          continue;
        }
        if (classified.level === "warning") {
          if (task.provides) {
            prerequisiteWarnings.set(task.provides, {
              code: classified.code,
              requestCmd: error?.requestCmd,
            });
          }
          taskResults.push({
            name: task.name,
            status: "warning",
            code: classified.code,
            warning: classified.message,
            requestCmd: error?.requestCmd,
            executed: error?.notExecuted !== true,
          });
          const token = this.tokenStore.gameTokens.find((t) => t.id === tokenId);
          this.log(`[${token?.name || tokenId}] ${task.name} - 警告[${classified.code}]: ${classified.message}`, "warning");
        } else {
          const errorMessage = error?.message || String(error);
          taskResults.push({
            name: task.name,
            status: "failed",
            error: errorMessage,
            code: classified.code,
            requestCmd: error?.requestCmd,
          });
          this.log(`任务执行失败: ${task.name} - ${errorMessage}`, "error");
        }
      } finally {
        if (this.errorClassifier) {
          const progress = Math.floor((taskResults.length / totalTasks) * 100);
          if (this.callbacks?.onProgress) this.callbacks.onProgress(progress);
          // Warning/failure paths must not bypass the configured pacing.
          await new Promise((resolve) => setTimeout(resolve, this.delaySettings.taskDelay));
        }
      }
    }

    // Stopping cancels business requests; restoring the original team is cleanup.
    if (stopped && originalFormation) {
      this.restoringAfterStop = true;
      try { await this.switchToFormationIfNeeded(tokenId, originalFormation, "停止后恢复原阵容"); }
      catch (error) { taskResults.push({ name: "停止后恢复原阵容", status: "failed", error: error?.message || String(error) }); }
      finally { this.restoringAfterStop = false; }
    }
    if (!stopped && this.callbacks?.onProgress) this.callbacks.onProgress(100);
    const completedResults = taskResults.filter((task) => task.status === "completed");
    const warningTasks = taskResults.filter((task) => task.status === "warning");
    const failedTasks = taskResults.filter((task) => task.status === "failed");
    const verificationCount = warningTasks.filter(task => typeof task.verificationRequired === "boolean"
      ? task.verificationRequired : /待核验|未确认|无法确认|结果未知|未执行|中断|未收到/.test(task.warning || task.detail || "")).length;
    if (this.errorClassifier && !this.productionLogs) {
      this.log(
        `日常处理结束：成功${completedResults.length}项，警告${warningTasks.length}项，失败${failedTasks.length}项`,
        warningTasks.length || failedTasks.length ? "warning" : "success",
      );
    } else if (!this.productionLogs) {
      this.log("所有任务执行完成", "success");
    }
    return {
      totalTasks,
      aborted: Boolean(abortReason),
      abortReason,
      unexecutedCount,
      stopped,
      verificationCount,
      skippedCount: taskResults.filter((task) => task.status === "skipped").length,
      completedCount: completedResults.length,
      warningCount: warningTasks.length,
      failedCount: failedTasks.length,
      warningTasks,
      failedTasks,
      taskResults,
      observations: (() => {
        const watched = ["分享一次游戏", "挂机加钟", "领取功法残卷", "重置盐罐计时", "领取盐罐奖励", "免费招募", "领取日常任务奖励", "领取周常任务奖励"];
        const labels = { completed: "请求正常返回", skipped: "跳过", warning: "警告", failed: "失败" };
        return watched.map(name => {
          const entry = taskResults.find(item => item.name === name);
          if (!entry) return `${name}：${taskList.some(item => item.name === name) ? "未执行（提前停止）" : "本轮未生成"}`;
          return `${name}：${entry.normalResponse ? "正常处理" : labels[entry.status] || entry.status}${entry.code == null ? "" : ` [${entry.code}]`}${entry.detail ? `；${entry.detail}` : ""}`;
        });
      })(),
    };
  }
}

