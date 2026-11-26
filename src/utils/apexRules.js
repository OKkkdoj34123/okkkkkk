/**
 * 逐鹿盐山第一赛季赛程识别规则。
 * 配置快照来自上游固定提交；只使用第一赛季 stage 4~10（淘汰赛竞猜阶段）。
 * 不校准服务器时钟：Date.now() 使用运行设备系统时钟；配置日期按北京时间 UTC+8 解释。
 */

import {
  APEX_SEASON,
  APEX_TAOTAI_STAGES,
  apexScheduleMap,
  apexStageNames,
} from "./apexStageMap.js";

export const ApexScheduleStatus = Object.freeze({
  None: 0,
  Unlocked: 1,
  Locked: 2,
  Fighting: 3,
  Completed: 4,
});

const HOUR_MS = 60 * 60 * 1000;
const DATE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;

/** 将配置表的北京时间当日零点转换为绝对时间戳，不依赖浏览器显示时区。 */
export function getBeijingDateZeroTime(dateText) {
  const match = DATE_RE.exec(String(dateText || "").trim());
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMidnight = Date.UTC(year, month - 1, day);
  if (
    !Number.isFinite(utcMidnight) ||
    new Date(utcMidnight).getUTCMonth() !== month - 1 ||
    new Date(utcMidnight).getUTCDate() !== day
  ) return Number.NaN;
  return utcMidnight - 8 * HOUR_MS;
}

export function getApexScheduleConf(scheduleId) {
  const id = Number(scheduleId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const conf = apexScheduleMap[String(id)];
  if (!conf || Number(conf.season) !== APEX_SEASON) return null;
  const stage = Number(conf.stage);
  return {
    ...conf,
    id,
    stage,
    stageName:
      apexStageNames[String(stage)]?.simpleName ||
      apexStageNames[String(stage)]?.name ||
      `stage-${stage}`,
  };
}

export function getRoundSchedules(round, season = APEX_SEASON) {
  if (Number(season) !== APEX_SEASON) return [];
  return Object.entries(apexScheduleMap)
    .map(([id, conf]) => ({ ...conf, id: Number(id) }))
    .filter(
      (conf) =>
        Number(conf.season) === APEX_SEASON &&
        Number(conf.round) === Number(round),
    )
    .sort((a, b) => a.id - b.id);
}

/**
 * 状态规则沿用上游 getScheduleStatus：
 * 同一天存在前一场时，后一场必须等前一场 endTime 后才解锁；
 * Unlocked / Locked 可竞猜，Fighting / Completed 不可竞猜。
 */
export function getScheduleStatus(scheduleId, nowMs = Date.now()) {
  const conf = getApexScheduleConf(scheduleId);
  if (!conf || !Number.isFinite(nowMs)) return ApexScheduleStatus.None;

  const dayZero = getBeijingDateZeroTime(conf.date);
  if (!Number.isFinite(dayZero)) return ApexScheduleStatus.None;

  const list = getRoundSchedules(conf.round, conf.season);
  const index = list.findIndex((item) => item.id === conf.id);
  if (index < 0) return ApexScheduleStatus.None;

  const previous = index > 0 ? list[index - 1] : null;
  const gate =
    previous && previous.date === conf.date
      ? dayZero + Number(previous.endTime) * 1000
      : Number.NEGATIVE_INFINITY;

  const lockAt = dayZero + Number(conf.lockTime) * 1000;
  const fightAt = dayZero + Number(conf.fightTime) * 1000;
  const endAt = dayZero + Number(conf.endTime) * 1000;
  if (
    !Number.isFinite(lockAt) ||
    !Number.isFinite(fightAt) ||
    !Number.isFinite(endAt) ||
    lockAt > fightAt ||
    fightAt > endAt
  ) return ApexScheduleStatus.None;

  if (nowMs < gate || nowMs < dayZero) return ApexScheduleStatus.None;
  if (nowMs < lockAt) return ApexScheduleStatus.Unlocked;
  if (nowMs < fightAt) return ApexScheduleStatus.Locked;
  if (nowMs < endAt) return ApexScheduleStatus.Fighting;
  return ApexScheduleStatus.Completed;
}

/** 返回某一期真正参与竞猜的淘汰赛 scheduleId，不包含海选/预选/正式赛。 */
export function getApexScheduleIdsForRound(round) {
  return getRoundSchedules(round, APEX_SEASON)
    .filter((conf) => APEX_TAOTAI_STAGES.includes(Number(conf.stage)))
    .map((conf) => conf.id);
}

/** 当前赛程所属期数的前一期，仅返回前一期 stage 4~10 的赛程ID。 */
export function getPreviousRoundScheduleIds(scheduleId) {
  const conf = getApexScheduleConf(scheduleId);
  if (!conf || Number(conf.round) <= 1) return [];
  return getApexScheduleIdsForRound(Number(conf.round) - 1);
}

/**
 * 返回当前期及之前historyRoundCount期的可领取奖励赛程ID。
 * historyRoundCount=1：当前期+上一期（最终范围）；historyRoundCount=5：当前期+前五期（测试范围）。
 * 按当前期优先排列，避免较早历史期的错误阻断当前/上一期领奖。
 */
export function getApexClaimScheduleIds(scheduleId, historyRoundCount = 1) {
  const conf = getApexScheduleConf(scheduleId);
  const count = Number(historyRoundCount);
  if (!conf || !Number.isInteger(count) || count < 0 || count > 12) return [];
  const currentRound = Number(conf.round);
  const oldestRound = Math.max(1, currentRound - count);
  const ids = [];
  for (let round = currentRound; round >= oldestRound; round -= 1) {
    ids.push(...getApexScheduleIdsForRound(round));
  }
  return ids;
}

/**
 * 自动发现唯一开放赛程。
 * 零个候选或多个候选均 fail closed，不使用最大ID、不猜测下一期。
 */
export function getAutoApexSchedule(nowMs = Date.now()) {
  if (!Number.isFinite(nowMs)) {
    return { ok: false, reason: "运行设备时间无效，无法识别赛程" };
  }

  const candidates = Object.keys(apexScheduleMap)
    .map((id) => getApexScheduleConf(id))
    .filter(
      (conf) =>
        conf &&
        APEX_TAOTAI_STAGES.includes(conf.stage) &&
        [ApexScheduleStatus.Unlocked, ApexScheduleStatus.Locked].includes(
          getScheduleStatus(conf.id, nowMs),
        ),
    )
    .map((conf) => ({
      ...conf,
      status: getScheduleStatus(conf.id, nowMs),
    }));

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "当前时间没有处于 Unlocked / Locked 状态的第一赛季淘汰赛赛程",
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `当前时间检测到多个开放赛程（${candidates.map((item) => item.id).join(",")}），为避免误投停止`,
    };
  }
  return { ok: true, schedule: candidates[0], status: candidates[0].status };
}
