// 2026-11-13 期。后续轮换需要核对活动、券和奖励档位的 ID。
import { gameDateKey } from '../campReadOnly.js';
import { getGameNow } from '../autoSchedule/activityCycle.js';
import { pickArenaTargetId } from './connectionManager.js';
import { prayerWindow, settlePrayerSign } from "./phoenixSign.js";

const PASS = 2611131;
const SIGN = 2611135;
const TICKET = 5295;
const START = Date.parse('2026-11-13T00:00:00+08:00');
const END = Date.parse('2026-11-20T00:00:00+08:00');
const DAILY = [[261113101, 1], [261113102, 1], [261113103, 1], [261113104, 5], [261113105, 10]];
const SALT_MISSION = 261113141;
// 本期已核实的低档。高档的已领取标记不提供解锁阈值。
const MILESTONES = [[5, 68], [10, 69], [15, 70], [20, 71]];
const MAX_DRAW_REQUESTS = 100;
const nat = v => Number.isSafeInteger(v) && v >= 0;
const map = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function requireState(condition, message) {
  if (!condition) throw new Error(message);
}
export function drawSize(today, tickets, finalDay = false) {
  requireState(nat(today) && nat(tickets), '每日进度或券数无效');
  if (tickets === 0)
    return 0;
  if (finalDay)
    return tickets >= 10 ? 10 : 1;
  if (today >= 10)
    return 0;
  return today === 0 && tickets >= 10 ? 10 : 1;
}
function warFrom(data, day) {
  const war = data?.activity?.warOrderActivityInfo?.[PASS];
  requireState(map(war?.complete) && map(war.taskClaimed) && nat(war.dailyTime) &&
    gameDateKey(war.dailyTime * 1000) === day, '战令每日进度或所属日期未确认');
  const today = war.complete[261113105];
  requireState(nat(today) && nat(war.complete[261113142]), '抽奖进度字段缺失');
  return war;
}
function totalFrom(info, war) {
  requireState(map(info), '抽奖查询缺少状态');
  const total = info.lotteryNum === undefined && war.complete[261113142] === 0 ? 0 : info.lotteryNum;
  requireState(nat(total) && total >= war.complete[261113105], '累计抽数与每日进度不符');
  return total;
}
function readTickets(role) {
  requireState(map(role?.items), '角色背包未确认');
  const count = role.items[TICKET] === undefined ? 0 : role.items[TICKET]?.quantity;
  requireState(nat(count), '活动券数量无效');
  return count;
}

function passProgress(before, after) {
  if (!map(before) || !map(after))
    return false;
  return Object.keys(before).every((id) => nat(after[id] ?? 0) && (after[id] ?? 0) >= before[id])
    && Object.entries(after).some(([id, n]) => nat(n) && n > (before[id] ?? 0));
}

// 商品限购不在兑换回执中。这里只按已知的材料成本计算库存能支持的数量。
function secondShopSummary(role, activity) {
  const items = role?.items;
  const record = activity?.commonActivityInfo?.[2611133]?.record;
  if (!map(items) || !map(record))
    return "第二类商店记录待核对";
  const balance = Object.hasOwn(items, 5297) ? items[5297]?.quantity : 0;
  const bought = Object.hasOwn(record, 261113303) ? record[261113303] : 0;
  if (!nat(balance) || !nat(bought))
    return "第二类商店库存或已购记录待核对";
  const pill = bought === 0 && balance >= 3 ? 1 : 0;
  const cookies = Math.floor((balance - pill * 3) / 5);
  return `材料5297余${balance}，复活丹本期已换${bought}份；按库存可再换复活丹${pill}份、饼干${cookies}组，限购待核对`;
}

export async function runPhoenixPrayer({ send, storage, now = Date.now, stopped = () => false, log = () => {}, onStatus = () => {}, expectedRole }) {
  const start = now(), day = gameDateKey(start);
  let closeAt = END;
  if (start < START || start >= END) {
    onStatus("skipped");
    return "本期未开放，跳过";
  }
  const check = () => {
    requireState(!stopped(), '用户已停止');
    requireState(now() < closeAt && gameDateKey(now()) === day, "已跨活动日或活动已结束，请重新执行");
  };
  const call = (cmd, body = {}) => { check(); return send(cmd, body); };
  const role = (await call('role_getroleinfo')).role;
  requireState(nat(role?.roleId) && role.roleId > 0, '角色身份未确认');
  const roleId = role.roleId;
  if (expectedRole) requireState(String(roleId) === String(expectedRole), '实服角色与所选账号不匹配');
  const key = 'xyzw_phoenix_2611131:' + roleId + ':' + day;
  const pendingKey = key + ':draw';
  const passKey = key + ':pass';
  const rewardKey = `${key}:reward`;
  const arenaKey = key + ':arena';
  const catalog = (await call('activity_get')).activity;
  requireState(map(catalog?.warOrderActivityInfo) && map(catalog.commonActivityInfo), '活动目录缺失');
  if (!Object.hasOwn(catalog.warOrderActivityInfo, PASS)) {
    onStatus("skipped");
    return "未开放本期玄鸟战令，跳过";
  }
  let sign = catalog.commonActivityInfo[SIGN];
  requireState(map(sign?.record), '点卯记录缺失');
  const getWar = async () => warFrom(await call('activity_warorderget', {actId: PASS}), day);
  let war = await getWar();
  const window = prayerWindow(catalog.activity, SIGN, war.dailyTime, now());
  if (window)
    closeAt = Math.min(closeAt, window.endTime);
  const getLottery = async () => {
    const info = (await call('activity_getlotteryinfo')).lotteryInfo;
    const total = totalFrom(info, war);
    const claimed = info.cumulativeClaimedMap ?? {};
    requireState(map(claimed), '累计领奖状态无效');
    return {total, claimed};
  };
  let lottery = await getLottery();
  let today = war.complete[261113105];
  const initial = today;
  let tasks = 0, milestones = 0, passRewards = 0;
  let lastRole = role;
  const getTickets = async () => {
    const fresh = (await call('role_getroleinfo')).role;
    requireState(fresh?.roleId === roleId, '回读角色不符');
    lastRole = fresh;
    return readTickets(fresh);
  };
  function reconcileDraw() {
    const raw = storage.getItem(pendingKey);
    if (raw === null) return;
    const p = JSON.parse(raw);
    requireState(nat(p.today) && nat(p.total) && [1,10].includes(p.size) &&
      today >= p.today + p.size && lottery.total >= p.total + p.size,
      '上一次抽奖结果待核验，已停止消费');
    storage.removeItem(pendingKey);
  }
  function reconcileReward() {
    const saved = storage.getItem(rewardKey);
    if (saved === null)
      return;
    const pending = JSON.parse(saved);
    const confirmed = (pending.kind === "task" && war.taskClaimed[pending.id] === true)
      || (pending.kind === "milestone" && lottery.claimed[pending.id] === true)
      || (pending.kind === "pass" && typeof pending.revision === "string" && passProgress(pending.before, war.rewardClaimed));
    requireState(confirmed, "上次领奖结果待核验，已停止重复请求");
    if (pending.kind === "pass")
      storage.setItem(passKey, pending.revision);
    storage.removeItem(rewardKey);
  }
  async function claimReward(marker, cmd, body, verified) {
    check();
    const saved = JSON.stringify(marker);
    storage.setItem(rewardKey, saved);
    requireState(storage.getItem(rewardKey) === saved, "领奖未决记录保存失败");
    let data;
    try {
      data = await call(cmd, body);
      requireState(verified(data), "领奖回执缺少对应状态");
    } catch (error) {
      if ((Number.isInteger(error.code) && error.code > 0 && error.requestCmd === cmd)
        || (cmd === "activity_warordertaskclaim" && error.code === 700010)
        || (cmd === "activity_warorderrewardclaim" && error.code === 3500020)) {
        storage.removeItem(rewardKey);
        throw error;
      }
      await getTickets();
      if (marker.kind === "milestone")
        lottery = await getLottery();
      else war = await getWar();
      reconcileReward();
      return null;
    }
    if (marker.kind === "pass")
      storage.setItem(passKey, marker.revision);
    storage.removeItem(rewardKey);
    return data;
  }
  reconcileDraw();
  reconcileReward();
  requireState(nat(war.complete[261113102]), '竞技场任务进度缺失，未执行祈愿');
  if (war.complete[261113102] >= 1) {
    storage.removeItem(arenaKey);
  } else {
    requireState(storage.getItem(arenaKey) === null, '上次竞技场结果待核验，未重复挑战；请核对游戏内进度');
    const hour = getGameNow(now()).hour;
    requireState(hour >= 6 && hour < 22, '竞技场未达标，当前不在北京时间06:00–22:00开放范围');
    log('竞技场未完成，仅挑战1次，使用当前阵容');
    const battleVersion = (await call('fight_startlevel')).battleData?.version;
    requireState(Number.isSafeInteger(battleVersion) && battleVersion > 0, '当前账号战斗版本未确认，未发起竞技场挑战');
    await call('arena_startarea');
    const targets = await call('arena_getareatarget');
    const targetId = pickArenaTargetId(targets);
    requireState(Number.isSafeInteger(targetId) && targetId > 0 && targetId !== roleId, '竞技场对手未确认，未发起挑战');
    // Re-read before spending a challenge, including changes made on another device.
    war = await getWar();
    if (war.complete[261113102] < 1) {
      requireState(nat(war.complete[261113102]), '竞技场任务进度缺失');
      check();
      const marker = JSON.stringify({targetId, at: now()});
      storage.setItem(arenaKey, marker);
      requireState(storage.getItem(arenaKey) === marker, '竞技场防重复记录保存失败');
      try { await call('fight_startareaarena', {targetId, battleVersion}); }
      catch (error) {
        if (Number.isInteger(error.code) && error.code > 0 && error.requestCmd === 'fight_startareaarena') storage.removeItem(arenaKey);
        throw error;
      }
      war = await getWar();
    }
    requireState(nat(war.complete[261113102]) && war.complete[261113102] >= 1,
      '竞技场挑战后进度尚未确认，停止祈愿且不重复挑战');
    storage.removeItem(arenaKey);
    log('竞技场任务已回读确认，继续凤仪祈愿');
    await getTickets();
    today = war.complete[261113105];
    lottery = await getLottery();
    sign = (await call('activity_get')).activity?.commonActivityInfo?.[SIGN];
    requireState(map(sign?.record), '竞技场后点卯记录缺失');
  }
  const { finalDay, patched } = await settlePrayerSign({
    record: sign.record,
    day,
    storage,
    log,
    beforeWrite: check,
    pendingKey: `${key}:sign`,
    windowLastDay: window?.finalDay,
    observedSeventhReset: war.dailyTime * 1000 === END - 86400000,
    sendSign: async (patchDay) => (await call("activity_claimsignreward", { activityId: SIGN, patchDay })).activity?.commonActivityInfo?.[SIGN]?.record,
    readSign: async () => {
      await getTickets(); // 单独核验当前连接的角色身份
      const response = await call("activity_get");
      warFrom(response, day);
      return response.activity.commonActivityInfo?.[SIGN]?.record;
    },
  });
  let saltClaims = 0;
  const refusedTasks = new Set();
  async function collect() {
    for (const [threshold, id] of MILESTONES) {
      if (lottery.total < threshold || lottery.claimed[id] === true) continue;
      await claimReward({ kind: "milestone", id }, "activity_claimlotterycumulative", { id }, (data) => data?.lotteryInfo?.cumulativeClaimedMap?.[id] === true);
      lottery.claimed[id] = true;
      milestones++;
    }
    // 141 只领服务器确认完成的周期任务。无需参加盐场。
    const period = Object.keys(war.complete).map(Number)
      .filter(id => id >= 261113142 && id <= 261113159)
      .map(id => [id, (id - 261113141) * 10]);
    for (const [id, target] of [...DAILY, [SALT_MISSION, 1], ...period]) {
      if (!nat(war.complete[id]) || war.complete[id] < target || war.taskClaimed[id] === true || refusedTasks.has(id))
        continue;
      requireState(war.taskClaimed[id] === undefined || war.taskClaimed[id] === false, `任务已领字段异常：${id}`);
      storage.setItem(passKey, 'pending');
      try {
        await claimReward({ kind: "task", id }, "activity_warordertaskclaim", { actId: PASS, missionId: id }, (data) => data?.activity?.warOrderActivityInfo?.[PASS]?.taskClaimed?.[id] === true);
      } catch (error) {
        if (error.code === 700010) {
          refusedTasks.add(id);
          log(`任务 ${id} 尚未达标`);
          continue;
        }
        throw error;
      }
      war.taskClaimed[id] = true;
      tasks++;
      if (id === SALT_MISSION)
        saltClaims++;
    }
    // 以已领任务集合记账，手动先领任务、刷新及中途退出均可继续领战令。
    const revision = JSON.stringify(Object.keys(war.taskClaimed).filter(k => war.taskClaimed[k] === true).sort());
    if (revision === '[]' || storage.getItem(passKey) === revision) return;
    try {
      const marker = { kind: "pass", revision, before: war.rewardClaimed };
      await claimReward(marker, "activity_warorderrewardclaim", { actId: PASS }, (response) =>
        (Array.isArray(response?.reward) && response.reward.length > 0)
        || passProgress(marker.before, response?.activity?.warOrderActivityInfo?.[PASS]?.rewardClaimed));
    } catch (error) {
      // 同一测试号领完后再次查询该领奖命令，实服返回 3500020。
      if (error.code !== 3500020) throw error;
      storage.setItem(passKey, revision);
      return;
    }
    passRewards++;
  }
  let tickets = await getTickets();
  let drawRequests = 0;
  while (true) {
    // 其他设备可能已经完成部分次数，消费前重新读取当日进度。
    if (drawSize(today, tickets, finalDay)) {
      war = await getWar();
      today = war.complete[261113105];
      lottery = await getLottery();
      tickets = await getTickets();
    }
    const size = drawSize(today, tickets, finalDay);
    if (size) {
      check();
      if (finalDay)
        requireState(war.complete[261113142] === lottery.total, "战令与抽奖累计数不一致，已停止清券");
      requireState(drawRequests < MAX_DRAW_REQUESTS, `本轮已到抽奖请求上限，剩券 ${tickets}，请核对后继续`);
      drawRequests++;
      const marker = JSON.stringify({ today, total: lottery.total, size });
      storage.setItem(pendingKey, marker);
      requireState(storage.getItem(pendingKey) === marker, "抽奖未决记录保存失败");
      let reply;
      try { reply = await call('activity_lottery', {times: size}); }
      catch (error) {
        if (Number.isInteger(error.code) && error.code > 0 && error.requestCmd === "activity_lottery") {
          storage.removeItem(pendingKey);
          throw error;
        }
        if (!finalDay)
          throw error;
        // 回包丢失，仅凭双计数回读核对本次抽奖，不重发。
      }
      if (!finalDay || reply !== undefined)
        requireState(reply?.lotteryInfo?.lotteryNum === lottery.total + size, "抽奖回执待核验");
      if (finalDay)
        await getTickets(); // 跨连接回读时先确认账号
      war = await getWar();
      today = war.complete[261113105];
      lottery = await getLottery();
      reconcileDraw();
      log(finalDay ? `末日累计已抽 ${lottery.total} 次` : `本日已抽 ${today}/10 次`);
    }
    await collect();
    tickets = await getTickets();
    if (!drawSize(today, tickets, finalDay))
      break;
  }
  const pending = [];
  if (lottery.total > 20)
    pending.push("累计奖励目录缺失，20抽以上请在活动页核对");
  if (finalDay) {
    let shop = "第二类商店记录待核对";
    try {
      const current = await call("activity_get");
      warFrom(current, day);
      shop = secondShopSummary(lastRole, current.activity);
    } catch {
      check();
    }
    pending.push("第一类兑换材料及限购待核对", shop);
  }
  if (pending.length)
    onStatus("warning", pending);
  const progress = finalDay
    ? `末日已核对7天点卯，补签 ${patched.length} 天，本日 ${initial} → ${today} 次`
    : `本日 ${initial} → ${today}/10 次`;
  const rewards = `任务 ${tasks} 项（本次盐场领奖 ${saltClaims} 次），抽奖达标 ${milestones} 档，战令领奖 ${passRewards} 次`;
  const shortage = !finalDay && today < 10 ? "（券不足）" : "";
  return [`${progress}，剩券 ${tickets}`, rewards + shortage, ...pending].join("；");
}
