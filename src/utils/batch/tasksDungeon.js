import { getDreamRound, decideDreamAfterBattle, DREAM_STAGE_MAX_RETRIES } from "../dreamStatePolicy.js";
import { recordTaskResult } from "./taskResult.js";
// [PROJECT_DREAM_RELEASE_20261011]
// DREAM_PURCHASE_TEMPLATES_V1
import { isDungeonOpen, merchantConfig, goldItemsConfig, resolveDreamPurchasePlan, dreamPurchaseItemLabel } from "@/utils/dreamConstants";
import { HERO_DICT } from "@/utils/HeroList.js";
import {
  DREAM_UNLOCK_LEVEL,
  getMainStageLevel,
  meetsMainStageRequirement,
} from "@/utils/gameFeatureUnlocks";


// DREAM_DIAGNOSTICS_V1
// 只输出与梦境相关的子树；不记录整个角色响应或登录凭据。
const dreamDiagnosticSnapshot = (value, depth = 0, seen = new WeakSet(), budget = { remaining: 600 }) => {
  if (--budget.remaining < 0) return "<总量截断>";
  if (value === undefined) return "<未提供>";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return /^\d{1,9}$/.test(value) ? Number(value) : "<文本已省略>";
  if (typeof value !== "object") return `<${typeof value}>`;
  if (depth >= 6) return "<深度截断>";
  if (seen.has(value)) return "<循环引用>";
  seen.add(value);
  const entries = Object.entries(value);
  const out = {};
  for (const [key, item] of entries.slice(0, 60)) {
    if (/token|password|passwd|cookie|authorization|session|sessid|connid|secret|url|nickname|avatar|roleid|openid|ticket/i.test(key)) continue;
    out[key] = dreamDiagnosticSnapshot(item, depth + 1, seen, budget);
  }
  if (entries.length > 60) out.__truncated = entries.length - 60;
  return out;
};

const dreamDiagnosticRole = (response) => {
  const body = response?._rawData ?? response?.data ?? response;
  const role = body?.role ?? body;
  return {
    levelId: role?.levelId,
    battleTeam: dreamDiagnosticSnapshot(role?.battleTeam),
    ownedHeroIds: Object.entries(role?.heroes ?? {}).slice(0, 200).map(([key, hero]) => {
      const raw = hero?.heroId ?? hero?.id ?? key;
      const id = Number(raw);
      return Number.isFinite(id) ? id : "<非数字ID>";
    }),
    dungeon: dreamDiagnosticSnapshot(role?.dungeon),
  };
};

const dreamDiagnosticError = (error) => {
  const fields = ["code", "hint", "requestCmd", "responseCmd", "requestSeq", "resp", "matchMode", "request", "serverTime", "ack", "responseBodyKeys", "serverError", "headerError"];
  const result = { message: error?.message || String(error) };
  for (const key of fields) {
    if (error?.[key] !== undefined) result[key] = error[key];
  }
  return result;
};

const dreamDiagnosticResult = (response) => {
  const body = response?._rawData ?? response?.data ?? response;
  return {
    wire: response?.__dreamDiagnostic,
    bodyKeys: body && typeof body === "object" ? Object.keys(body).slice(0, 60) : [],
    code: body?.code,
    battleTeam: dreamDiagnosticSnapshot(body?.battleTeam),
    dungeon: dreamDiagnosticSnapshot(body?.dungeon ?? body?.role?.dungeon),
    rewardCount: Array.isArray(body?.reward) ? body.reward.length : undefined,
  };
};


// DREAM_STATE_FIX_V2
const dreamStateTeam = (raw, label) => {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new Error(`${label}不是队伍对象，已停止选阵容`);
  const team = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 };
  const ids = new Set();
  for (const [slot, hero] of Object.entries(raw)) {
    if (!/^\d+$/.test(slot)) continue;
    const position = Number(slot);
    if (!Number.isInteger(position) || position < 0 || position > 4) {
      throw new Error(`${label}包含不支持的位置${slot}，已停止选阵容`);
    }
    const value = hero == null ? 0 : typeof hero === "object" ? hero.heroId : hero;
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 0) throw new Error(`${label}位置${slot}的heroId无效`);
    if (id > 0 && ids.has(id)) throw new Error(`${label}出现重复heroId=${id}，已停止选阵容`);
    if (id > 0) ids.add(id);
    team[String(position)] = id;
  }
  return ids.size > 0 ? team : null;
};

const dreamStatePlan = (response) => {
  const body = response?._rawData ?? response?.data ?? response;
  const role = body?.role ?? body;
  if (!role || typeof role !== "object") throw new Error("角色响应无效，已停止选阵容");
  const serverTeam = dreamStateTeam(role.dungeon?.battleTeam, "服务端梦境阵容");
  const beginTime = Number(role.dungeon?.beginTime);
  const timestampMs = beginTime * 1000;
  const validBegin = Number.isFinite(timestampMs) && timestampMs > 0 && timestampMs <= 8640000000000000;
  const stateTime = {
    beginTime: role.dungeon?.beginTime,
    beginTimeUTC: validBegin ? new Date(timestampMs).toISOString() : undefined,
    ageHours: validBegin ? Math.round((Date.now() - timestampMs) / 3600000 * 10) / 10 : undefined,
    roundStatus: "未根据时间推断轮次",
  };
  if (serverTeam) return { action: "preserve-existing", serverTeam, ...stateTime };
  const currentTeam = dreamStateTeam(role.battleTeam, "当前上阵阵容");
  if (!currentTeam) throw new Error("当前上阵阵容为空或未提供，已停止选阵容；不会回退到预设队伍");
  // 当前上阵队伍来自角色响应；若同时提供武将列表，再核对拥有关系。
  if (role.heroes && typeof role.heroes === "object") {
    const ownedIds = new Set(Object.entries(role.heroes).map(([key, hero]) => Number(hero?.heroId ?? hero?.id ?? key)).filter(Number.isSafeInteger));
    const missing = Object.values(currentTeam).filter((id) => id > 0 && !ownedIds.has(id));
    if (missing.length) throw new Error(`当前上阵武将不在角色武将列表中：${missing.join(",")}`);
  }
  return { action: "select-current", currentTeam, source: "role_getroleinfo.role.battleTeam", ...stateTime };
};




// DREAM_PRODUCTION_V5
const DREAM_PRODUCTION_OPTIONS = Object.freeze({ progressEvery: 20 });
const dreamProductionDebug = () => {
  try { return globalThis.localStorage?.getItem("dream_debug_verbose") === "true"; }
  catch (_) { return false; }
};
const dreamProductionHeroName = (id) => HERO_DICT[Number(id)]?.name ?? `武将${id}`;
const dreamProductionHp = (raw) => {
  if (typeof raw !== "number" && !(typeof raw === "string" && raw.trim() !== "")) return null;
  const hp = Number(raw);
  return Number.isFinite(hp) && hp >= 0 ? hp : null;
};
const dreamProductionActorHp = (response, heroId) => {
  const team = dreamFinalRole(response)?.dungeon?.battleTeam;
  if (!team || typeof team !== "object") return null;
  const actor = Object.values(team).find((hero) => Number(hero?.heroId ?? hero) === heroId);
  return actor && typeof actor === "object" ? dreamProductionHp(actor.hp) : null;
};
const dreamProductionDeltaHp = (before, result, heroId) => {
  const oldDungeon = dreamFinalRole(before)?.dungeon;
  const delta = result?.role?.dungeon ?? result?.dungeon;
  if (!delta || !delta.battleTeam || typeof delta.battleTeam !== "object") return null;
  if (delta.beginTime !== undefined && dreamV4TimeMs(delta.beginTime) !== dreamV4TimeMs(oldDungeon?.beginTime)) return null;
  for (const [slot, changed] of Object.entries(delta.battleTeam)) {
    if (!changed || typeof changed !== "object") continue;
    const oldHero = oldDungeon?.battleTeam?.[slot];
    const id = changed.heroId ?? (typeof oldHero === "object" ? oldHero?.heroId : oldHero);
    if (Number(id) === heroId) return dreamProductionHp(changed.hp);
  }
  return null;
};
const dreamProductionLog = (addLog, accountName, runId) => {
  const debug = dreamProductionDebug();
  return (label, value, type = "info") => {
    try {
      if (debug) {
        addLog({ time: new Date().toLocaleTimeString(), message: `[梦境调试][${accountName}][${runId}] ${label}: ${JSON.stringify(value)}`, type });
        return;
      }
      let text;
      if (label === "连续战斗武将") {
        text = `使用${dreamProductionHeroName(value.heroId)}（战力${value.power ?? "未确认；唯一候选"}），开始连续战斗，间隔${value.intervalMs / 1000}秒`;
      } else if (label === "战斗结果") {
        if (!value.isWin || value.battles % DREAM_PRODUCTION_OPTIONS.progressEvery !== 0) return;
        text = `已战斗${value.battles}次：胜${value.wins}次，败${value.losses}次`;
      } else if (label === "结束统计") {
        const reason = String(value.reason ?? "").replace(/；末次胜负未返回$/, "");
        text = `结束：战斗${value.battles}次，胜${value.wins}次，败${value.losses}次${value.unconfirmed ? `，胜负未返回${value.unconfirmed}次` : ""}；${reason}`;
        // 已确认的阵亡/战败属于正常结束，未确认的胜负仍如实保留。
        if (value.status === "completed") type = "success";
        else if (value.status === "skipped") type = "warning";
      } else if (label === "异常停止") {
        text = `异常停止 [${value.stage}${value.code !== undefined ? `，code=${value.code}` : ""}]：${value.message}`;
        if (value.progress) text += `（已确认胜${value.progress.wins}次，败${value.progress.losses}次${value.progress.unconfirmed ? `，胜负未返回${value.progress.unconfirmed}次` : ""}）`;
        if (value.stateSummary) text += `；${value.stateSummary}`;
      } else if (label === "本轮单将阵容") {
        return; // 正常模式由“开始连续战斗”统一报告，调试模式保留原始详情。
      } else if (label === "单将确认成功") {
        return; // 阵容核验失败仍输出异常摘要。
      } else if (label === "保留锁定阵容") {
        return; // 后续开始日志已包含实际使用武将。
      } else if (label === "单关卡重试") {
        text = `关卡${value.id}未推进，血量${value.hp}，准备重试${value.retry}/${value.max}（首次请求之外）`;
      } else if (label === "限频冷却") {
        text = `收到400340（按项目限频处理），冷却${value.seconds}秒后核对状态（${value.attempt}/${value.max}）`;
      } else if (label === "限频后恢复") {
        text = `已确认关卡和血量未变化，恢复战斗，间隔提高为${value.intervalMs / 1000}秒`;
      } else if (label === "状态查询冷却") {
        text = `状态查询收到200400，等待${value.seconds}秒后仅重试查询（${value.attempt}/${value.max}），不重发战斗`;
      } else if (label === "胜负未返回但已推进") {
        text = `第${value.attempt}次胜负未返回，已读回确认关卡${value.from ?? "未返回"}→${value.to ?? "未返回"}且武将存活，继续；本次计为胜负未返回`;
      } else if (label === "使用读回队伍") {
        text = "选阵容响应异常，已读回确认本轮队伍，继续战斗";
      } else if (label === "结束后状态读取失败") {
        text = `结束后状态读取失败：${value.message}`;
      } else if (label === "连接释放") {
        return; // 正常模式不重复报告连接释放，调试模式仍可查看。
      } else {
        return;
      }
      addLog({ time: new Date().toLocaleTimeString(), message: `[梦境][${accountName}] ${text}`, type });
    } catch (_) { /* 日志失败不影响任务结果 */ }
  };
};

// DREAM_ROUND_FIX_V4
// DREAM_FINAL_V3
const DREAM_FINAL_LIMITS = Object.freeze({ maxBattles: 200, intervalMs: 3000, maxStageRetries: DREAM_STAGE_MAX_RETRIES });
const dreamFinalActiveTokens = new Set();
const dreamFinalBody = (response) => response?._rawData ?? response?.data ?? response;
const dreamFinalRole = (response) => {
  const body = dreamFinalBody(response);
  return body?.role ?? body;
};
const dreamV4TimeMs = (raw) => {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  const ms = value >= 1e12 ? value : value * 1000;
  return Number.isFinite(ms) && ms >= Date.UTC(2010, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
};
const dreamV4Clock = (response) => {
  const localNow = Date.now();
  const serverNow = dreamV4TimeMs(response?.__dreamDiagnostic?.serverTime);
  return { nowMs: serverNow ?? localNow, offsetMs: serverNow === null ? 0 : serverNow - localNow,
    source: serverNow === null ? "客户端时间；未收到有效服务端时间" : "role_getroleinfo响应时间" };
};
// 依据项目既有开放日：北京时间周三/四、周日/一。不是错误码释义。
const dreamV4Round = getDreamRound;
const dreamV4RoundStatus = (response, round, nowMs) => {
  const beginMs = dreamV4TimeMs(dreamFinalRole(response)?.dungeon?.beginTime);
  if (beginMs === null) return "unknown";
  if (beginMs > nowMs + 5 * 60 * 1000) return "future";
  if (beginMs < round.startMs) return "previous";
  if (beginMs >= round.endMs) return "future";
  return "current";
};
const dreamFinalState = (response) => {
  const role = dreamFinalRole(response);
  const dungeon = role?.dungeon;
  return {
    levelId: role?.levelId, beginTime: dungeon?.beginTime,
    id: dungeon?.id, maxId: dungeon?.maxId, activeHeroId: dungeon?.activeHeroId,
    currMonsterId: dungeon?.currMonsterId, currMerchantId: dungeon?.currMerchantId,
    serverTeam: dreamStateTeam(dungeon?.battleTeam, "服务端梦境阵容"),
    heroes: Object.entries(dungeon?.battleTeam ?? {}).filter(([, hero]) => Number(hero?.heroId ?? hero) > 0).map(([slot, hero]) => ({
      slot: Number(slot), heroId: Number(hero?.heroId ?? hero), hp: hero?.hp, initHp: hero?.initHp,
    })),
  };
};
const dreamFinalPause = async (ms, stopped) => {
  for (let remaining = ms; remaining > 0 && !stopped(); remaining -= 100) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
  }
};
const dreamV4Version = (response) => {
  const body = dreamFinalBody(response);
  // 路径来自仓库与参考 VM 1018；不硬编码版本。
  const paths = [
    ["battleData.version", body?.battleData?.version],
    ["battleData.battleVersion", body?.battleData?.battleVersion],
    ["battleData.result.battleVersion", body?.battleData?.result?.battleVersion],
    ["battleVersion", body?.battleVersion], ["version", body?.version],
  ];
  for (const [path, raw] of paths) {
    if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) continue;
    const version = Number(raw);
    if (Number.isSafeInteger(version) && version > 0) return { version, path };
  }
  throw new Error("本账号fight_startlevel未返回有效battleVersion；未发送梦境战斗请求");
};
const dreamV4CheckCode = (response, label) => {
  const body = dreamFinalBody(response);
  if (body?.code !== undefined && Number(body.code) !== 0) {
    throw Object.assign(new Error(`${label}响应错误码=${body.code}`),
      { code: body.code, hint: body.hint, request: response?.__dreamDiagnostic?.request });
  }
};
// DREAM_LOGS_V8
// DREAM_SAFE_V7
// DREAM_SAFE_V6
const DREAM_V6_RECOVERY = Object.freeze({ limitedIntervalMs: 5000, cooldownMs: 15000,
  maxRateRecoveries: 2, confirmDelaysMs: Object.freeze([1500, 3000]), maxUnknownContinuations: 3 });
const dreamV6Number = (raw) => {
  if (typeof raw !== "number" && !(typeof raw === "string" && raw.trim() !== "")) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const dreamV6ActorHp = (response, heroId, before) =>
  dreamProductionActorHp(response, heroId) ?? dreamProductionDeltaHp(before, dreamFinalBody(response), heroId);
const dreamV6MergeRole = (before, response) => {
  const old = dreamFinalRole(before);
  const body = dreamFinalBody(response);
  const delta = body?.role ?? (body?.dungeon ? body : null);
  if (!delta || typeof delta !== "object") return before;
  const oldDungeon = old?.dungeon;
  const nextDungeon = delta.dungeon;
  if (nextDungeon?.beginTime !== undefined && dreamV4TimeMs(nextDungeon.beginTime) !== dreamV4TimeMs(oldDungeon?.beginTime)) {
    return { role: { ...old, ...delta, dungeon: nextDungeon } };
  }
  const dungeon = { ...oldDungeon, ...nextDungeon };
  if (nextDungeon?.battleTeam && typeof nextDungeon.battleTeam === "object") {
    const team = { ...oldDungeon?.battleTeam };
    for (const [slot, value] of Object.entries(nextDungeon.battleTeam)) {
      const previous = team[slot];
      const newId = typeof value === "object" && value !== null ? value.heroId : value;
      const oldId = typeof previous === "object" && previous !== null ? previous.heroId : previous;
      const merge = value && typeof value === "object" && previous && typeof previous === "object"
        && (newId === undefined || Number(newId) === Number(oldId));
      team[slot] = merge ? { ...previous, ...value } : value;
    }
    dungeon.battleTeam = team;
  }
  return { role: { ...old, ...delta, heroes: { ...old?.heroes, ...delta.heroes }, dungeon } };
};
const dreamV6State = (response, heroId, before) => {
  const dungeon = dreamFinalRole(response)?.dungeon;
  return { id: dreamV6Number(dungeon?.id), maxId: dreamV6Number(dungeon?.maxId),
    hp: dreamV6ActorHp(response, heroId, before), beginTime: dungeon?.beginTime };
};
const dreamV6Advanced = (before, after) =>
  (before.id !== null && after.id !== null && after.id > before.id)
  || (before.maxId !== null && after.maxId !== null && after.maxId > before.maxId);
const dreamV6Unchanged = (before, after) => before.id !== null && after.id === before.id
  && before.hp !== null && after.hp === before.hp && after.hp > 0
  && ((before.maxId === null && after.maxId === null) || (before.maxId !== null && after.maxId === before.maxId));
const dreamV6Summary = (before, after, heroId, response, roundStatus) => {
  const wire = response?.__dreamDiagnostic;
  const body = dreamFinalBody(response);
  const v = (raw) => raw === undefined || raw === null ? "未返回" : raw;
  return `武将${heroId}，关卡${v(before.id)}→${v(after.id)}，最高通关${v(before.maxId)}→${v(after.maxId)}，血量${v(before.hp)}→${v(after.hp)}，轮次${roundStatus}，响应${v(wire?.responseCmd)}，字段${body && typeof body === "object" ? Object.keys(body).slice(0, 8).join("/") : "未返回"}`;
};
const dreamV6Powers = (roleInfo, versionResponse, profileResponse) => {
  const role = dreamFinalRole(roleInfo);
  const battle = dreamFinalBody(versionResponse)?.battleData;
  const profile = dreamFinalBody(profileResponse)?.roleInfo;
  const powers = new Map();
  // V7：当前角色 > 当前战斗 > 补充资料。首个正值优先，零值不能覆盖。
  // 不从旧梦境阵容读取战力，避免跨轮次污染。
  const add = (heroes, keyedById, source) => {
    if (!heroes || typeof heroes !== "object") return;
    for (const [key, hero] of Object.entries(heroes)) {
      if (!hero || typeof hero !== "object") continue;
      const id = Number(hero.heroId ?? hero.id ?? (keyedById ? key : NaN));
      const power = dreamV6Number(hero.power);
      if (Number.isSafeInteger(id) && id > 0 && power !== null && power > 0 && !powers.has(id)) {
        powers.set(id, power);
        powers.sources.set(id, source);
      }
    }
  };
  powers.sources = new Map();
  add(role?.heroes, true, "role.heroes");
  add(role?.battleTeam, false, "role.battleTeam");
  add(battle?.leftTeam?.team, false, "fight.leftTeam");
  add(profile?.heroes, true, "rank.heroes");
  return powers;
};
const dreamV6Choose = (roleInfo, team, powers) => {
  const heroes = Object.entries(team ?? {}).filter(([, id]) => id > 0)
    .map(([slot, id]) => ({ heroId: id, slot: Number(slot), power: powers.get(id) ?? null, source: powers.sources?.get(id) ?? "唯一候选；战力未确认" }));
  if (!heroes.length) throw new Error("没有可选择的梦境武将");
  const missing = heroes.filter((hero) => hero.power === null);
  if (heroes.length > 1 && missing.length) {
    throw new Error(`服务端未返回候选武将${missing.map((hero) => hero.heroId).join("/")}的power，无法核对最高战力；未用等级或血量代替`);
  }
  const active = Number(dreamFinalRole(roleInfo)?.dungeon?.activeHeroId);
  heroes.sort((a, b) => (b.power ?? 0) - (a.power ?? 0)
    || Number(b.heroId === active) - Number(a.heroId === active) || a.slot - b.slot || a.heroId - b.heroId);
  return heroes[0];
};
const dreamFinalFlow = async ({ tokenStore, tokenId, stopped, log, stage, attempted }) => {
  const progress = { attempts: 0, battles: 0, wins: 0, losses: 0, unconfirmed: 0, rateRecoveries: 0 };
  const finish = (status, reason, extra = {}) => ({ status, reason, ...progress, ...extra });
  const readRole = async (label) => {
    stage(label);
    // Retry only the read on a positively identified 200400; never replay a fight.
    const backoffs = [5000, 10000, 20000];
    for (let retry = 0; ; retry++) {
      if (stopped()) throw Object.assign(new Error("手动停止，未发送状态查询"), { stopped: true });
      try {
        const result = await tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 15000);
        dreamV4CheckCode(result, "读取角色");
        return result;
      } catch (error) {
        if (error?.stopped || stopped()) throw Object.assign(new Error("手动停止"), { stopped: true });
        const code = Number(error?.code) || Number(String(error?.message || "").match(/(?:服务器错误\s*[:：]\s*|错误码=)(\d+)/)?.[1]);
        if (code !== 200400 || retry >= backoffs.length) throw error;
        log("状态查询冷却", { attempt: retry + 1, max: backoffs.length, seconds: backoffs[retry] / 1000 }, "warning");
        await dreamFinalPause(backoffs[retry], stopped);
      }
    }
  };
  const paused = async (ms) => { await dreamFinalPause(ms, stopped); return stopped(); };
  try {
    if (stopped()) return finish("stopped", "手动停止");
    let roleInfo = await readRole("role_getroleinfo");
    if (stopped()) return finish("stopped", "手动停止");
    const clock = dreamV4Clock(roleInfo);
    const round = dreamV4Round(clock.nowMs);
    log("开始", { version: "dream-state-v9", maxBattles: DREAM_FINAL_LIMITS.maxBattles,
      intervalMs: DREAM_FINAL_LIMITS.intervalMs });
    log("梦境状态", dreamFinalState(roleInfo));
    if (!round.open) return finish("skipped", "按北京时间开放日规则，当前不在梦境开放日");
    const level = getMainStageLevel(dreamFinalRole(roleInfo));
    if (level === null) return finish("warning", "结果待核验：主线关卡缺失，未执行梦境");
    if (level < DREAM_UNLOCK_LEVEL) return finish("skipped", `主线关卡未确认达到${DREAM_UNLOCK_LEVEL}关`);
    stage("dream_state_plan");
    const role = dreamFinalRole(roleInfo);
    const existingTeam = dreamStateTeam(role?.dungeon?.battleTeam, "服务端梦境阵容");
    const roundStatus = dreamV4RoundStatus(roleInfo, round, clock.nowMs);
    if (existingTeam && ["unknown", "future"].includes(roundStatus)) {
      return finish("warning", `结果待核验：已有梦境队伍的beginTime无法确认本轮（${roundStatus}）；已停止`);
    }
    const needsSelection = !existingTeam || roundStatus === "previous";
    const plan = needsSelection ? dreamStatePlan({ role: { ...role, dungeon: { ...role.dungeon, battleTeam: {} } } }) : null;
    const candidates = needsSelection ? plan.currentTeam : existingTeam;
    stage("fight_startlevel（读取本账号战斗版本和战力）");
    const versionResponse = await tokenStore.sendMessageWithPromise(tokenId, "fight_startlevel", {}, 10000);
    dreamV4CheckCode(versionResponse, "读取战斗版本");
    const { version: battleVersion, path: versionPath } = dreamV4Version(versionResponse);
    log("本账号战斗版本", { battleVersion, source: versionPath, wire: versionResponse?.__dreamDiagnostic });
    if (stopped()) return finish("stopped", "手动停止");
    let powers = dreamV6Powers(roleInfo, versionResponse);
    const ids = Object.values(candidates).filter((id) => id > 0);
    if (ids.length > 1 && ids.some((id) => !powers.has(id))) {
      // rank_getroleinfo及参数结构沿用项目的角色战力查询入口，只查询当前账号。
      const roleId = Number(role.roleId);
      if (!Number.isSafeInteger(roleId) || roleId <= 0) throw new Error("未返回完整武将power及当前角色roleId，无法查询最高战力；已停止");
      stage("读取本账号武将战力");
      const profileResponse = await tokenStore.sendMessageWithPromise(tokenId, "rank_getroleinfo",
        { roleId, bottleType: 0, includeBottleTeam: false, isSearch: false }, 10000);
      dreamV4CheckCode(profileResponse, "读取武将战力");
      const profile = dreamFinalBody(profileResponse)?.roleInfo;
      if (!profile || typeof profile !== "object") throw new Error("本账号战力查询未返回roleInfo，已停止");
      if (profile.roleId !== undefined && Number(profile.roleId) !== roleId) throw new Error("战力查询返回了其他角色，已停止");
      powers = dreamV6Powers(roleInfo, versionResponse, profileResponse);
    }
    const actor = dreamV6Choose(roleInfo, candidates, powers);
    const heroId = actor.heroId;
    if (needsSelection) {
      if (stopped()) return finish("stopped", "手动停止");
      const submittedTeam = { [String(actor.slot)]: heroId };
      // 只发送有效武将，保留原槽位；不提交空槽位heroId=0。
      log("本轮单将阵容", { heroId, power: actor.power, slot: actor.slot, source: actor.source });
      stage("dungeon_selecthero");
      attempted("selection");
      log("选阵容参数", { cmd: "dungeon_selecthero", body: { battleTeam: submittedTeam } });
      let selectionError;
      let selectionSummary = `提交=${JSON.stringify(submittedTeam)}，选将前beginTime=${role?.dungeon?.beginTime ?? "未返回"}`;
      try {
        const result = await tokenStore.sendMessageWithPromise(tokenId, "dungeon_selecthero", { battleTeam: submittedTeam }, 15000);
        dreamV4CheckCode(result, "选阵容");
        log("选阵容响应", dreamDiagnosticResult(result));
      } catch (error) { selectionError = error; selectionError.requestCmd = "dungeon_selecthero"; log("选阵容错误", dreamDiagnosticError(error), "warning"); }
      if (stopped()) return finish("stopped", "手动停止");
      try {
        const verified = await readRole("确认单将阵容");
        const verifyClock = dreamV4Clock(verified);
        const verifyRound = dreamV4Round(verifyClock.nowMs);
        const verifiedTeam = dreamStateTeam(dreamFinalRole(verified)?.dungeon?.battleTeam, "服务端梦境阵容");
        selectionSummary += `，读回beginTime=${dreamFinalRole(verified)?.dungeon?.beginTime ?? "未返回"}，轮次=${dreamV4RoundStatus(verified, round, verifyClock.nowMs)}，读回队伍=${JSON.stringify(verifiedTeam)}`;
        if (!verifyRound.open || verifyRound.startMs !== round.startMs
          || dreamV4RoundStatus(verified, round, verifyClock.nowMs) !== "current") throw new Error("选阵容后未确认本轮队伍；未发送梦境战斗");
        const selected = Object.values(verifiedTeam ?? {}).filter((id) => id > 0);
        if (selected.length !== 1 || selected[0] !== heroId) throw new Error("读回的本轮队伍不是提交的单将阵容；未重发选阵容或战斗");
        roleInfo = verified;
      } catch (verifyError) {
        const error = selectionError ?? verifyError;
        error.dreamStateSummary = `${selectionSummary}；核验=${verifyError.message}`;
        if (selectionError) stage("dungeon_selecthero（后续读回未确认）");
        throw error;
      }
      log("单将确认成功", { heroId, summary: selectionSummary });
      if (selectionError) log("使用读回队伍", { reason: "选队响应异常，但已读回确认提交的本轮单将阵容" }, "warning");
    } else if (ids.length > 1) {
      log("保留锁定阵容", { heroId, power: actor.power, count: ids.length });
    }
    if (stopped()) return finish("stopped", "手动停止", { heroId });
    if (dreamV6ActorHp(roleInfo, heroId, roleInfo) === 0) {
      return finish("skipped", `${dreamProductionHeroName(heroId)}为本轮最高战力武将，但血量已耗尽`, { heroId });
    }
    let intervalMs = DREAM_FINAL_LIMITS.intervalMs;
    const stageRequests = new Map();
    let stateFresh = true;
    log("连续战斗武将", { heroId, power: actor.power, intervalMs, strategy: "按服务端power择高；固定一名武将，阵亡停止" });
    while (progress.attempts - progress.rateRecoveries < DREAM_FINAL_LIMITS.maxBattles) {
      // 每轮等待在上一次响应/状态核对结束之后执行，包含第一次战斗。
      if (await paused(intervalMs)) return finish("stopped", "手动停止", { heroId });
      const currentRound = dreamV4Round(Date.now() + clock.offsetMs);
      if (!currentRound.open || currentRound.startMs !== round.startMs) {
        return finish(progress.battles ? "completed" : "skipped", "本轮时间已结束，已停止", { heroId });
      }
      if (!stateFresh) {
        // 上一胜局未带回关卡id时，不能拿旧id推断本次未返回胜负的请求已执行。
        const fresh = await readRole("刷新下一战前状态");
        const freshClock = dreamV4Clock(fresh);
        const freshRound = dreamV4Round(freshClock.nowMs);
        if (!freshRound.open || freshRound.startMs !== round.startMs
          || dreamV4RoundStatus(fresh, round, freshClock.nowMs) !== "current") {
          return finish("warning", "结果待核验：刷新状态后轮次已变化或未确认，已停止", { heroId });
        }
        if (dreamV6ActorHp(fresh, heroId, roleInfo) === 0) {
          return finish("completed", `${dreamProductionHeroName(heroId)}血量已耗尽，停止连续战斗`, { heroId });
        }
        roleInfo = dreamV6MergeRole(roleInfo, fresh);
        stateFresh = true;
        if (await paused(intervalMs)) return finish("stopped", "手动停止", { heroId });
        const resumedRound = dreamV4Round(Date.now() + clock.offsetMs);
        if (!resumedRound.open || resumedRound.startMs !== round.startMs) {
          return finish(progress.battles ? "completed" : "skipped", "本轮时间已结束，已停止", { heroId });
        }
      }
      const before = roleInfo;
      const beforeState = dreamV6State(before, heroId, before);
      if (beforeState.hp === 0) return finish("completed", "上阵武将血量归零，正常结束", { heroId });
      if ([beforeState.id, beforeState.maxId, beforeState.hp].some(v => v === null)) return finish("warning", "结果待核验：战前关卡或血量不完整，未发送战斗", { heroId });
      const stageKey = `${beforeState.beginTime}:${beforeState.id}`;
      const requestsAtStage = (stageRequests.get(stageKey) || 0) + 1;
      if (requestsAtStage > 1 + DREAM_STAGE_MAX_RETRIES) return finish("warning", "同关卡重试已达5次，已停止；结果待核验", { heroId });
      stageRequests.set(stageKey, requestsAtStage);
      stage("fight_startdungeon");
      attempted("battle");
      progress.attempts++;
      const body = { heroId, battleVersion };
      log("战斗提交参数", { attempt: progress.attempts, cmd: "fight_startdungeon", body });
      let response;
      try {
        response = await tokenStore.sendMessageWithPromise(tokenId, "fight_startdungeon", body, 15000);
        dreamV4CheckCode(response, "战斗");
      } catch (error) {
        log("战斗请求详情", dreamDiagnosticError(error), "warning");
        const code = Number(error?.code);
        if (code === 2600080 || code === 2600050) {
          return finish(progress.battles ? "completed" : "skipped", `服务端停止码${code}，未推断为通关`, { heroId, stopCode: code });
        }
        if (code !== 400340) {
          if (!/超时|timeout/i.test(error?.message || "")) throw error;
          response = null; // only read-back evidence can authorize a retry
        } else {
        if (progress.rateRecoveries >= DREAM_V6_RECOVERY.maxRateRecoveries) throw error;
        stageRequests.set(stageKey, requestsAtStage - 1); // independent rate-recovery budget
        progress.rateRecoveries++;
        intervalMs = DREAM_V6_RECOVERY.limitedIntervalMs;
        log("限频冷却", { code, seconds: DREAM_V6_RECOVERY.cooldownMs / 1000,
          attempt: progress.rateRecoveries, max: DREAM_V6_RECOVERY.maxRateRecoveries }, "warning");
        if (await paused(DREAM_V6_RECOVERY.cooldownMs)) return finish("stopped", "手动停止", { heroId });
        const after = await readRole("400340冷却后核对状态");
        const afterClock = dreamV4Clock(after);
        const afterStatus = dreamV4RoundStatus(after, round, afterClock.nowMs);
        const afterState = dreamV6State(after, heroId, before);
        log("限频后的梦境状态", { before: beforeState, after: afterState, roundStatus: afterStatus });
        if (afterStatus === "current" && afterState.hp === 0) {
          return finish(progress.battles ? "completed" : "skipped", `${dreamProductionHeroName(heroId)}血量已耗尽，停止战斗`, { heroId });
        }
        if (afterStatus !== "current" || !dreamV6Unchanged(beforeState, afterState)) {
          error.dreamStateSummary = dreamV6Summary(beforeState, afterState, heroId, after, afterStatus);
          stage("fight_startdungeon（400340后状态未确认未变化）");
          throw error;
        }
        roleInfo = dreamV6MergeRole(before, after);
        log("限频后恢复", { intervalMs, heroId });
        continue;
        }
      }
      const result = dreamFinalBody(response);
      const knownResult = [true, false, 1, 0].includes(result?.isWin);
      if (knownResult) {
        const won = result.isWin === true || result.isWin === 1;
        progress.battles++; if (won) progress.wins++; else progress.losses++;
        log("战斗结果", { heroId, ...progress, isWin: won }, won ? "success" : "warning");
      } else progress.unconfirmed++;
      let after, afterState, afterStatus;
      for (const waitMs of knownResult ? [1500] : DREAM_V6_RECOVERY.confirmDelaysMs) {
        if (await paused(waitMs)) return finish("stopped", "手动停止", { heroId });
        try { after = await readRole("战后核对关卡与血量"); }
        catch (error) {
          if (error?.stopped || stopped()) return finish("stopped", "手动停止，未重发战斗", { heroId });
          return finish("warning", `结果待核验：战后状态读取失败（${formatTaskError(error)}），未重发战斗`, { heroId });
        }
        const afterClock = dreamV4Clock(after), afterRound = dreamV4Round(afterClock.nowMs);
        if (!afterRound.open || afterRound.startMs !== round.startMs) return finish("completed", "本轮时间已结束，停止战斗", { heroId });
        afterStatus = dreamV4RoundStatus(after, round, afterClock.nowMs);
        afterState = dreamV6State(after, heroId, after); // never fill missing HP from stale data
        if (afterStatus !== "current" || afterState.hp === 0 || dreamV6Advanced(beforeState, afterState)) break;
      }
      const decision = decideDreamAfterBattle(beforeState, afterState, afterStatus, requestsAtStage);
      if (["warning", "completed"].includes(decision.action)) return finish(decision.action, decision.reason, { heroId });
      roleInfo = after; stateFresh = true;
      if (decision.action === "advance") {
        stageRequests.clear();
        if (!knownResult) log("胜负未返回但已推进", { attempt: progress.attempts, from: beforeState.id, to: afterState.id }, "warning");
      } else log("单关卡重试", { id: afterState.id, retry: decision.retry, max: DREAM_STAGE_MAX_RETRIES, hp: afterState.hp }, "warning");

    }
    return finish("warning", `达到本次${DREAM_FINAL_LIMITS.maxBattles}次战斗上限，未判断通关；结果待核验`, { heroId });
  } catch (error) {
    if (error && typeof error === "object") error.dreamProgress = { ...progress };
    throw error;
  }
};

const formatTaskError = (error) => {
  if (error?.message) return error.message;
  if (typeof error === "string") return error;

  const details = [];
  if (error?.code !== undefined) details.push(`code=${error.code}`);
  if (error?.hint) details.push(`hint=${error.hint}`);
  if (details.length > 0) return details.join(", ");

  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : "未知错误";
  } catch {
    return String(error || "未知错误");
  }
};

/**
 * 梦境类任务
 * 包含: batchmengjing, batchBuyDreamItems
 */

/**
 * 创建梦境类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksDungeon(deps) {
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

  /**
   * 一键梦境
   */



  const batchmengjing = async () => {
    if (selectedTokens.value.length === 0) return;
    const tokenIds = [...new Set(selectedTokens.value)];
    const outcomes = new Map();
    const report = (id, status, reason) => outcomes.set(id, recordTaskResult(tokenStatus, id, status, [reason], status === "warning" ? [reason] : []));
    if (tokenIds.some((id) => dreamFinalActiveTokens.has(id))) {
      addLog({ time: new Date().toLocaleTimeString(), message: "[梦境] 所选账号已有梦境任务执行中，本次不重复启动", type: "warning" });
      return tokenIds.map(id => recordTaskResult(tokenStatus, id, "skipped", ["所选账号已有梦境任务执行中，本次不重复启动"]));
    }
    isRunning.value = true;
    shouldStop.value = false;
    tokenIds.forEach((id) => {
      if (!dreamFinalActiveTokens.has(id)) tokenStatus.value[id] = "waiting";
    });
    const tasks = tokenIds.map(async (tokenId) => {
      const token = tokens.value.find((item) => item.id === tokenId);
      if (dreamFinalActiveTokens.has(tokenId)) {
        addLog({ time: new Date().toLocaleTimeString(), message: `${token?.name ?? tokenId} 已有梦境任务执行中，本次不重复启动`, type: "warning" });
        return;
      }
      if (shouldStop.value) { report(tokenId, "stopped", "用户主动停止"); return; }
      if (!token) { report(tokenId, "unavailable", "账号不存在"); return; }
      dreamFinalActiveTokens.add(tokenId);
      const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const accountName = token?.name ?? String(tokenId);
      let currentStage = "ensureConnection";
      let connectionReady = false;
      let slotHeld = false;
      let selectionAttempted = false;
      let battleAttempted = false;
      const log = dreamProductionLog(addLog, accountName, runId);
      tokenStatus.value[tokenId] = "running";
      try {
        addLog({ time: new Date().toLocaleTimeString(), message: `=== 开始咸王梦境: ${accountName} ===`, type: "info" });
        const wasConnected = tokenStore.getWebSocketStatus?.(tokenId) === "connected";
        await ensureConnection(tokenId);
        connectionReady = true;
        slotHeld = !wasConnected;
        const outcome = await dreamFinalFlow({
          tokenStore, tokenId, stopped: () => shouldStop.value, log,
          stage: (value) => { currentStage = value; },
          attempted: (kind) => { if (kind === "selection") selectionAttempted = true; else battleAttempted = true; },
        });
        report(tokenId, outcome.status, outcome.reason);
        log("结束统计", outcome, outcome.status === "completed" ? "success" : "warning");
      } catch (error) {
        report(tokenId, shouldStop.value ? "stopped" : "failed", `${currentStage}：${formatTaskError(error)}`);
        log("异常停止", { stage: currentStage, ...dreamDiagnosticError(error), progress: error?.dreamProgress, stateSummary: error?.dreamStateSummary }, "error");

      } finally {
        try {
          if (connectionReady && (selectionAttempted || battleAttempted) && !shouldStop.value) {
            try {
              const after = await tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 8000);
              log("结束后的梦境状态", dreamFinalState(after));
            } catch (error) { log("结束后状态读取失败", dreamDiagnosticError(error), "warning"); }
          }
        } finally {
          try {
            if (connectionReady) tokenStore.closeWebSocketConnection(tokenId);
          } finally {
            if (slotHeld) releaseConnectionSlot(tokenId);
            dreamFinalActiveTokens.delete(tokenId);
            log("连接释放", { status: tokenStatus.value[tokenId], active: connectionQueue.active, selectionAttempted, battleAttempted });
          }
        }
      }
    });
    try { await Promise.all(tasks); }
    finally {
      isRunning.value = dreamFinalActiveTokens.size > 0;
      currentRunningTokenId.value = null;
    }
    const summary = tokenIds.reduce((result, id) => {
      const status = tokenStatus.value[id] ?? "unknown";
      result[status] = (result[status] ?? 0) + 1;
      return result;
    }, {});
    addLog({ time: new Date().toLocaleTimeString(), message: `[梦境] 批量结束：执行结束${summary.completed ?? 0}个，跳过${summary.skipped ?? 0}个，停止${summary.stopped ?? 0}个，待核验${summary.warning ?? 0}个，异常${summary.failed ?? 0}个`, type: summary.failed ? "warning" : "info" });
    if (summary.failed || summary.skipped || summary.warning || summary.stopped) message.warning?.("批量梦境结束，部分账号失败或停止，请查看结束统计");
    else message.success("批量梦境执行结束，请查看每个账号的停止原因");
    return tokenIds.map(id => outcomes.get(id) || recordTaskResult(tokenStatus, id, "skipped", ["已有梦境任务执行中"]));
  };

  /**
   * 一键购买梦境商品
   */

  const batchBuyDreamItems = async () => {
    if (selectedTokens.value.length === 0) return;
    const tokenIds = [...new Set(selectedTokens.value)];
    if (tokenIds.some((id) => dreamFinalActiveTokens.has(id))) {
      message.warning?.("所选账号已有梦境任务执行中，请等任务结束后再购买");
      return;
    }
    // 批次开始固定设置；每个账号读回角色后独立识别主公等级。
    const purchaseSettings = {
      dreamPurchaseManualEnabled: batchSettings.dreamPurchaseManualEnabled === true,
      dreamPurchaseBlackMarketEnabled: batchSettings.dreamPurchaseBlackMarketEnabled === true,
      dreamPurchaseList: Array.isArray(batchSettings.dreamPurchaseList) ? [...batchSettings.dreamPurchaseList] : [],
    };
    if (purchaseSettings.dreamPurchaseManualEnabled && !purchaseSettings.dreamPurchaseList.length) {
      message.warning("单独购买已开启但未勾选商品，不会回退到其他模板");
      return;
    }
    isRunning.value = true;
    shouldStop.value = false;
    tokenIds.forEach((id) => { tokenStatus.value[id] = "waiting"; });
    const tasks = tokenIds.map(async (tokenId) => {
      const token = tokens.value.find((item) => item.id === tokenId);
      const accountName = token?.name ?? String(tokenId);
      if (shouldStop.value) { tokenStatus.value[tokenId] = "skipped"; return; }
      dreamFinalActiveTokens.add(tokenId);
      let connectionReady = false;
      let slotHeld = false;
      let successCount = 0;
      let failCount = 0;
      let purchasePlanName = "";
      const log = (text, type = "info") => addLog({ time: new Date().toLocaleTimeString(), message: `[梦境购买][${accountName}] ${text}`, type });
      try {
        if (dreamProductionDebug()) log("开始购买配置清单中的商品");
        const wasConnected = tokenStore.getWebSocketStatus?.(tokenId) === "connected";
        await ensureConnection(tokenId);
        connectionReady = true;
        slotHeld = !wasConnected;
        if (shouldStop.value) { tokenStatus.value[tokenId] = "skipped"; return; }
        const response = await tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 15000);
        dreamV4CheckCode(response, "读取梦境商店");
        const role = dreamFinalRole(response);
        const level = getMainStageLevel(role);
        if (level === null || level < DREAM_UNLOCK_LEVEL) {
          tokenStatus.value[tokenId] = "skipped";
          log(level === null ? "未能读取主线关卡，已跳过购买" : `主线${level}关，梦境购买需达到${DREAM_UNLOCK_LEVEL}关，已跳过`, "warning");
          return;
        }
        const clock = dreamV4Clock(response);
        const round = dreamV4Round(clock.nowMs);
        if (!round.open) {
          tokenStatus.value[tokenId] = "skipped";
          log("当前不在北京时间梦境开放日，已跳过", "warning");
          return;
        }
        const purchaseRoundStatus = dreamV4RoundStatus(response, round, clock.nowMs);
        const purchaseTeam = dreamStateTeam(role?.dungeon?.battleTeam, "本轮梦境阵容");
        if (purchaseRoundStatus !== "current" || !purchaseTeam) {
          tokenStatus.value[tokenId] = "skipped";
          log(`本轮梦境尚未初始化或状态未确认，已跳过购买${dreamProductionDebug() ? `；轮次=${purchaseRoundStatus}，beginTime=${role?.dungeon?.beginTime ?? "未返回"}，队伍=${JSON.stringify(purchaseTeam)}` : "；请先完成本轮选将"}`, "warning");
          return;
        }
        if (dreamProductionDebug()) log(`本轮商店核验通过；beginTime=${role.dungeon.beginTime}`);
        const plan = resolveDreamPurchasePlan(purchaseSettings, role);
        if (plan.reason) {
          tokenStatus.value[tokenId] = "skipped";
          log(plan.reason, "warning");
          return;
        }
        const purchaseList = plan.items;
        purchasePlanName = plan.name;
        if (dreamProductionDebug()) log(`使用“${plan.name}”${plan.level === null ? "" : `，主公${plan.level}级`}`);
        const merchants = role?.dungeon?.merchant;
        if (!merchants || typeof merchants !== "object") throw new Error("无法获取梦境商店数据");
        const operations = [];
        for (const item of purchaseList) {
          const items = merchants[item.merchantId];
          if (items === undefined || items === null) continue;
          if (!Array.isArray(items)) throw new Error(`商人${item.merchantId}商品列表格式无效`);
          items.forEach((index, pos) => {
            if (Number(index) === item.index) operations.push({ ...item, pos });
          });
        }
        operations.sort((a, b) => a.merchantId - b.merchantId || b.pos - a.pos);
        if (operations.length === 0) {
          tokenStatus.value[tokenId] = "skipped";
          log(`已跳过（${purchasePlanName}）：商品未出现或已买完`);
          return;
        }
        for (const op of operations) {
          if (shouldStop.value) break;
          const currentRound = dreamV4Round(Date.now() + clock.offsetMs);
          if (!currentRound.open || currentRound.startMs !== round.startMs) {
            tokenStatus.value[tokenId] = "skipped";
            log(`购买停止（${purchasePlanName}）：成功${successCount}件，失败${failCount}件；本轮时间已结束`, "warning");
            return;
          }
          const name = `${merchantConfig[op.merchantId].name}－${dreamPurchaseItemLabel(op.merchantId, op.index)}`;
          try {
            const result = await tokenStore.sendMessageWithPromise(tokenId, "dungeon_buymerchant",
              { id: op.merchantId, index: op.index, pos: op.pos }, 15000);
            dreamV4CheckCode(result, "购买商品");
            const body = dreamFinalBody(result);
            if (!body || (result?.__dreamDiagnostic?.code !== 0 && body?.code !== 0 && body?.reward === undefined)) {
              throw new Error("未收到可确认的购买结果；未重试");
            }
            successCount++;
          } catch (error) {
            failCount++;
            log(`${name}购买失败${error?.code !== undefined ? ` [code=${error.code}]` : ""}：${formatTaskError(error)}`, "error");
            // 失败后不继续使用旧pos，也不自动重试可能已经扣费的请求。
            try {
              const fresh = await tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 15000);
              dreamV4CheckCode(fresh, "购买失败后核验");
              const freshClock = dreamV4Clock(fresh);
              const freshRole = dreamFinalRole(fresh);
              if (dreamProductionDebug()) log(`购买失败后停止该账号后续商品；cmd=dungeon_buymerchant，商品=${op.merchantId}-${op.index}，pos=${op.pos}，轮次=${dreamV4RoundStatus(fresh, round, freshClock.nowMs)}，beginTime=${freshRole?.dungeon?.beginTime ?? "未返回"}，该商人列表=${JSON.stringify(freshRole?.dungeon?.merchant?.[op.merchantId] ?? null)}`, "warning");
              else log(`已停止后续购买，未重试；读回轮次=${dreamV4RoundStatus(fresh, round, freshClock.nowMs)}`, "warning");
            } catch (readError) {
              log(`购买失败后状态读取失败：${formatTaskError(readError)}；已停止后续商品，未重试`, "warning");
            }
            break;
          }
          await dreamFinalPause(500, () => shouldStop.value);
        }
        tokenStatus.value[tokenId] = shouldStop.value ? "skipped" : failCount ? "failed" : "completed";
        log(`${shouldStop.value ? "手动停止" : failCount ? "购买停止" : "购买完成"}（${purchasePlanName}）：成功${successCount}件，失败${failCount}件`, failCount ? "error" : shouldStop.value ? "warning" : "success");
      } catch (error) {
        tokenStatus.value[tokenId] = "failed";
        log(`购买停止：${formatTaskError(error)}`, "error");
      } finally {
        try { if (connectionReady) tokenStore.closeWebSocketConnection(tokenId); }
        finally {
          if (slotHeld) releaseConnectionSlot(tokenId);
          dreamFinalActiveTokens.delete(tokenId);
          if (dreamProductionDebug()) log(`连接已关闭（当前连接数：${connectionQueue.active}）`);
        }
      }
    });
    try { await Promise.all(tasks); }
    finally { isRunning.value = dreamFinalActiveTokens.size > 0; currentRunningTokenId.value = null; }
    const summary = tokenIds.reduce((out, id) => {
      const status = tokenStatus.value[id] ?? "unknown";
      out[status] = (out[status] ?? 0) + 1;
      return out;
    }, {});
    if (summary.failed || summary.skipped) message.warning?.("批量梦境购买结束，请查看各账号结果");
    else message.success("批量梦境购买完成");
  };

  return {
    batchmengjing,
    batchBuyDreamItems,
  };
}

