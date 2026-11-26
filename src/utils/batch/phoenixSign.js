import { gameDateKey } from "../campReadOnly.js";

function checkRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("点卯日期记录缺失");
  for (const [slot, timestamp] of Object.entries(record)) {
    if (!/^[1-7]$/.test(slot) || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= 10_000_000_000)
      throw new Error("点卯记录的日期键或时间戳无效");
  }
  return record;
}

// 只接受签到活动本身的目录行。并行开放的其他商店不能提供凤仪的结束时间。
export function prayerWindow(catalog, activityId, dailyTime, now) {
  if (!Array.isArray(catalog))
    return undefined;
  const rows = catalog.filter((row) => row?.id === activityId);
  if (!rows.length)
    return undefined;
  const asMillis = (value) => value instanceof Date
    ? value.getTime()
    : typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? Date.parse(value) : value;
  const openTime = asMillis(rows[0].openTime);
  const endTime = asMillis(rows[0].endTime);
  if (rows.length !== 1 || !Number.isSafeInteger(openTime) || !Number.isSafeInteger(endTime)
    || openTime <= 0 || endTime <= openTime || now < openTime || now >= endTime
    || dailyTime * 1000 >= endTime || (dailyTime + 86400) * 1000 <= openTime) {
    throw new Error("签到活动窗口不一致，请核对");
  }
  return { finalDay: gameDateKey(endTime - 1) === gameDateKey(dailyTime * 1000), endTime };
}

// patchDay=0 领取服务器当天。补签的时间戳也会落在当天，不能当作第七格的凭据。
export async function settlePrayerSign({ record, day, windowLastDay, observedSeventhReset, sendSign, readSign, beforeWrite, storage, pendingKey, log }) {
  record = checkRecord(record);
  const isToday = (stamp) => stamp > 0 && gameDateKey(stamp * 1000) === day;
  const hasSlot = (rows, slot) => slot === 0
    ? Object.values(rows).some(isToday)
    : slot === 7 ? isToday(rows[7]) : rows[slot] > 0;

  function reconcile() {
    const saved = storage.getItem(pendingKey);
    if (saved === null)
      return;
    if (!/^[0-7]$/.test(saved) || !hasSlot(record, Number(saved)))
      throw new Error("上次点卯结果待核验，已停止重复请求");
    storage.removeItem(pendingKey);
  }

  async function claim(target, patchDay) {
    if (hasSlot(record, target))
      return false;
    beforeWrite();
    const marker = String(target);
    storage.setItem(pendingKey, marker);
    if (storage.getItem(pendingKey) !== marker)
      throw new Error("点卯未决记录保存失败");
    try {
      const updated = checkRecord(await sendSign(patchDay));
      if (!hasSlot(updated, target))
        throw new Error("点卯回执缺少预期日期");
      record = updated;
    } catch (error) {
      // 只读复核一次。服务器可能已执行，不能因超时或部分回包重发补签。
      record = checkRecord(await readSign());
      if (!hasSlot(record, target)) {
        if (Number.isInteger(error.code) && error.code > 0 && error.requestCmd === "activity_claimsignreward")
          storage.removeItem(pendingKey);
        throw new Error(`点卯结果待核验（patchDay=${patchDay}）：${error.message}`);
      }
    }
    reconcile();
    return true;
  }

  reconcile();
  if (record[7] > 0 && (!isToday(record[7]) || windowLastDay === false))
    throw new Error("第七格与当前服务器日期或活动窗口冲突，已停止");
  const checkSeventh = windowLastDay === true || (windowLastDay === undefined && observedSeventhReset);
  if (!hasSlot(record, 7) && !checkSeventh) {
    if (await claim(0, 0))
      log("已确认当日点卯");
    if (!hasSlot(record, 7))
      return { finalDay: false, patched: [] };
  }
  // 没有活动目录时，正常点卯可以直接给出今天的格号。已知的末日战令重置时刻
  // 只用来区分“今天补过旧格”与“已点今天”，自身不能授权补签或清券。
  if (!checkSeventh)
    throw new Error("点卯回执与签到活动窗口冲突，已停止");

  // 本期首日、末日的服务器日重置与签到键均有实包。末日须再取得本角色当天的第七格。
  record = checkRecord(await readSign());
  if (record[7] > 0 && !isToday(record[7]))
    throw new Error("第七格不属于当前服务器日，已停止");
  await claim(7, 0);
  const patched = [];
  for (let slot = 1; slot < 7; slot++) {
    if (hasSlot(record, slot))
      continue;
    record = checkRecord(await readSign());
    if (!hasSlot(record, 7))
      throw new Error("第七格回读不一致，已停止补签");
    if (await claim(slot, slot)) {
      patched.push(slot);
      log(`已确认补签第 ${slot} 天`);
    }
  }
  record = checkRecord(await readSign());
  if (!Array.from({ length: 7 }, (_, i) => i + 1).every((slot) => hasSlot(record, slot)))
    throw new Error("七天点卯尚未全部回读确认，已停止清券");
  return { finalDay: true, patched };
}
