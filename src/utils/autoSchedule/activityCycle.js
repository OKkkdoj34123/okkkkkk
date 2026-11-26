export const GAME_TIMEZONE = "Asia/Shanghai";
export const DAY_MS = 86400000;
const OFFSET = 8 * 3600000;
const BASE = Date.parse("2025-12-12T12:00:00+08:00");
const TYPES = ["blackMarket", "recruit", "box"];
export const CYCLE_LABELS = { blackMarket: "黑市周", recruit: "招募周", box: "宝箱周" };

// Return calendar fields, never a shifted Date that could be interpreted in host time.
export function getGameNow(time = Date.now()) {
  const instant = new Date(time).getTime();
  if (!Number.isFinite(instant))
    throw new Error("无效的北京时间");
  const date = new Date(instant + OFFSET);
  return { instant, dateKey: date.toISOString().slice(0, 10), weekday: date.getUTCDay(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}
export const getGameDateKey = (time) => getGameNow(time).dateKey;
export const getGameWeekday = (time) => getGameNow(time).weekday;
export const getGameMinutesOfDay = (time) => {
  const d = getGameNow(time);
  return d.hour * 60 + d.minute;
};
export function gameTimestamp(dateKey, minutes = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey))
    throw new Error("无效日期");
  const midnight = Date.parse(`${dateKey}T00:00:00+08:00`);
  if (getGameDateKey(midnight) !== dateKey)
    throw new Error("无效日期");
  return midnight + minutes * 60000;
}
export const formatGameTime = (time) => time == null ? "—" : new Date(Number(time) + OFFSET).toISOString().slice(0, 19).replace("T", " ");

export function getActivityCycle(time = Date.now(), override = "auto") {
  const instant = new Date(time).getTime();
  const week = Math.floor((instant - BASE) / (7 * DAY_MS));
  const index = ((week % 3) + 3) % 3;
  const automatic = instant < BASE ? null : TYPES[index];
  const type = TYPES.includes(override) ? override : automatic;
  const nextType = type ? TYPES[(TYPES.indexOf(type) + 1) % 3] : "blackMarket";
  return { type, label: CYCLE_LABELS[type] || "活动未开始", nextType, nextLabel: CYCLE_LABELS[nextType], startAt: instant < BASE ? null : BASE + week * 7 * DAY_MS, endAt: instant < BASE ? BASE : BASE + (week + 1) * 7 * DAY_MS, overridden: TYPES.includes(override) };
}

export function isAutoTaskOpen(taskName, time = Date.now(), override = "auto") {
  const { weekday, hour } = getGameNow(time);
  if (["batchmengjing", "batchBuyDreamItems"].includes(taskName))
    return [0, 1, 3, 4].includes(weekday);
  if (taskName === "batchCampChallengePet")
    return [2, 3, 4].includes(weekday);
  if (taskName === "batchSaltOnce")
    return weekday === 6;
  if (taskName === "climbWeirdTower")
    return getActivityCycle(time, override).type === "blackMarket" && (weekday !== 5 || hour >= 12);
  return true;
}
