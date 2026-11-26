// BOX_POINTS_RELEASE_V1: confirmed per-run points, never claimable balance.
export const BOXES = [
  { id: 2001, name: '木质', points: 1, reserve: 200 },
  { id: 2002, name: '青铜', points: 10, reserve: 0 },
  { id: 2003, name: '黄金', points: 20, reserve: 0 },
  { id: 2004, name: '铂金', points: 50, reserve: 0 },
];
export function normalizeBoxRules(input) {
  const rows = BOXES.map((b, i) => {
    const row = Array.isArray(input) ? input.find(r => Number(r?.id) === b.id) : null;
    const rank = Number(row?.priority);
    return { ...b, enabled: row?.enabled !== false, priority: Number.isInteger(rank) && rank >= 1 && rank <= 4 ? rank : i + 1 };
  });
  rows.sort((a, b) => a.priority - b.priority || a.id - b.id);
  rows.forEach((r, i) => { r.priority = i + 1; });
  return rows;
}
export function readBoxInventory(response) {
  const role = response?.role || response?.data?.role;
  if (!role || !role.items || typeof role.items !== 'object') throw new Error('角色库存字段缺失，停止，不能按零库存继续');
  const inventory = {};
  for (const b of BOXES) {
    const n = role.items[b.id]?.quantity ?? 0;
    if (!Number.isSafeInteger(Number(n)) || Number(n) < 0) throw new Error(`宝箱${b.id}库存异常`);
    inventory[b.id] = Number(n);
  }
  return inventory;
}
export function nextBoxBatch(inventory, rules, remaining) {
  for (const b of rules) {
    if (!b.enabled) continue;
    const available = Math.max(0, inventory[b.id] - b.reserve);
    // Retain the known ten-box request size; never silently use disabled boxes.
    if (available >= 10) return { ...b, number: 10 };
  }
  return null;
}
export async function runBoxPoints({ target, rules, request, stopped = () => false, log = () => {}, pause = async () => {}, maxRounds = 2000, maxMs = 30 * 60 * 1000 }) {
  target = Number(target);
  if (!Number.isSafeInteger(target) || target < 1 || target > 1000000) throw new Error('目标积分必须为1至1000000的整数');
  rules = normalizeBoxRules(rules);
  if (!rules.some(r => r.enabled)) throw new Error('至少开启一种宝箱');
  const start = Date.now();
  const stats = { points: 0, target, rounds: 0, claims: 0, opened: Object.fromEntries(BOXES.map(b => [b.id, 0])), status: 'incomplete', reason: '' };
  const finish = (status, reason) => { Object.assign(stats, { status, reason }); log('结束', stats); return stats; };
  const guard = () => {
    if (stopped()) return '用户停止';
    if (Date.now() - start >= maxMs) return '达到运行时间上限';
    return '';
  };
  const query = async () => {
    const response = await request('role_getroleinfo', {});
    const role = response?.role || response?.data?.role;
    const fields = {};
    for (const key of ['boxPoint', 'boxPoints', 'box_point', 'box_points', 'boxPointReward']) {
      if (typeof role?.[key] === 'number' || typeof role?.[key] === 'string' && /^\d+$/.test(role[key])) fields[key] = role[key];
    }
    log('服务端积分字段（仅诊断，不作累计值）', fields);
    return readBoxInventory(response);
  };
  log('配置', { target, rules, maxRounds, maxMs, unit: '每次10个；木质保留200；本次新增积分' });
  let inventory;
  try {
    if (guard()) return finish('stopped', guard());
    inventory = await query(); log('初始库存', inventory);
    // One initial claim allows existing rewards to replenish an otherwise empty inventory.
    let initialClaimTried = false;
    while (stats.points < target) {
      if (guard()) return finish(stopped() ? 'stopped' : 'incomplete', guard());
      if (stats.rounds >= maxRounds) return finish('incomplete', '达到开箱轮次上限');
      const batch = nextBoxBatch(inventory, rules, target - stats.points);
      if (!batch) {
        if (!initialClaimTried) {
          initialClaimTried = true;
          log('无可用箱，尝试领取已有奖励', inventory);
          await request('item_batchclaimboxpointreward', {}); stats.claims++;
          if (guard()) return finish('stopped', guard());
          await pause(); inventory = await query(); log('已有奖励领取后库存', inventory);
          continue;
        }
        return finish('incomplete', '启用宝箱不足10个或已到保留量，无法继续');
      }
      initialClaimTried = true;
      const before = inventory[batch.id]; stats.rounds++;
      log('开箱请求', { round: stats.rounds, id: batch.id, name: batch.name, number: batch.number, before, points: stats.points });
      let openError = null;
      try { await request('item_openbox', { itemId: batch.id, number: batch.number }); }
      catch (error) { openError = error; log('开箱响应异常，先核验，不重发', { code: error?.code, message: error?.message }); }
      // Read even after cancellation to account for an already sent request; no more mutations.
      inventory = await query();
      const used = before - inventory[batch.id];
      log('开箱库存核验', { id: batch.id, before, after: inventory[batch.id], used, expected: batch.number });
      if (used !== batch.number) return finish('uncertain', '库存变化与请求不一致，停止；请核对游戏，不自动重试');
      stats.points += used * batch.points; stats.opened[batch.id] += used;
      log('累计进度', { points: stats.points, target, inventory });
      if (openError) return finish('uncertain', '开箱响应异常但库存已扣减，已记入进度；停止，请核对游戏');
      if (guard()) return finish(stopped() ? 'stopped' : 'incomplete', guard());
      await pause();
      if (guard()) return finish(stopped() ? 'stopped' : 'incomplete', guard());
      log('领取积分奖励', { round: stats.rounds });
      await request('item_batchclaimboxpointreward', {}); stats.claims++;
      if (guard()) return finish(stopped() ? 'stopped' : 'incomplete', guard());
      await pause(); inventory = await query(); log('领取后库存', inventory);
    }
    return finish('completed', '目标已达到，最后一轮积分奖励已领取');
  } catch (error) {
    if (error?.boxStopped) return finish('stopped', '用户停止（含节流/退避等待）');
    log('请求失败', { code: error?.code, message: error?.message, points: stats.points, inventory });
    return finish('failed', `请求失败：${error?.message || String(error)}；未自动重试`);
  }
}

// Request pacing: all commands share a completion-to-next-start interval.
// Only explicit rate-limited read requests may be retried. Never replay mutations.
export function createPacedBoxRequest({ send, stopped = () => false, log = () => {},
  intervalMs = 1500, now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxMs = 30 * 60 * 1000 }) {
  let lastFinished = null;
  const started = now();
  const check = () => {
    if (stopped()) { const error = new Error('用户停止'); error.boxStopped = true; throw error; }
    if (now() - started >= maxMs) throw new Error('达到运行时间上限');
  };
  const wait = async ms => {
    const end = now() + Math.max(0, ms);
    while (now() < end) { check(); await sleep(Math.min(100, end - now())); }
    check();
  };
  return async (cmd, params) => {
    for (let attempt = 0; ; attempt++) {
      check();
      if (lastFinished !== null) await wait(intervalMs - (now() - lastFinished));
      check();
      log('请求节流', { cmd, attempt: attempt + 1, intervalMs, elapsedMs: now() - started });
      try { return await send(cmd, params); }
      catch (error) {
        const code = Number(error?.code ?? String(error?.message || '').match(/^服务器错误\s*[:：]\s*(\d+)/)?.[1]);
        if (cmd !== 'role_getroleinfo' || code !== 200400 || attempt >= 3) throw error;
        // Update immediately: the cooldown is additional to the normal pacing.
        lastFinished = now();
        const cooldownMs = [5000, 10000, 20000][attempt];
        log('查询限流退避', { cmd, code, retry: attempt + 1, maxRetries: 3, cooldownMs });
        await wait(cooldownMs);
      } finally { lastFinished = now(); }
    }
  };
}
