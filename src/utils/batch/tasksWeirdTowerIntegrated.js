// WEIRD_TOWER_INTEGRATED_RECOVERY_V5 -- scoped reads, bounded recovery, final reconciliation.
// Debug logs contain only task state, never tokens, credentials or role payloads.
export const WEIRD_TOWER_OPTIONS = Object.freeze({
  debug: false, // Detailed diagnostics can be enabled with weird_tower_debug_verbose=1.
  maxDurationMs: 300000,
  maxWrites: 1200,
  maxRequests: 5000,
  requestTimeoutMs: 6000,
  actionDelayMs: 500,
  progressEvery: 10,
  requestGapMs: 150,
  readRetryDelayMs: 3000,
  maxReadAttempts: 4,
  maxReadRecoveries: 6,
  towerSyncEvery: 10,
  towerQueryGapMs: 2000,
  accountCooldownMs: 30000,
});

const busyStores = new WeakSet();
const queryControls = new WeakMap();
const benignClaims = new Set([700010, 700020, 3500020, 1000020, 12000116]);
const fatalCodes = new Set([200020, 200160, 200760]);
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = v => v === null || v === undefined || v === '' ? NaN : Number(v);
const flag = v => v === true || (Number.isFinite(number(v)) && number(v) !== 0);
const tidy = v => {
  if (Array.isArray(v)) return v.map(tidy);
  if (obj(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, tidy(v[k])]));
  return typeof v === 'bigint' ? String(v) : v;
};
const stable = v => JSON.stringify(tidy(v));
const safeReason = e => String(e?.message || e || '未知错误')
  .replace(/(?:https?|wss?):\/\/\S+/gi, '[地址已隐藏]')
  .replace(/[A-Za-z0-9+/_=-]{64,}/g, '[长字段已隐藏]').slice(0, 220);
const codeOf = e => {
  const explicit = Number(e?.code ?? e?.errorCode);
  if (Number.isFinite(explicit) && explicit !== 0) return explicit;
  return Number(String(e?.message || '').match(/(?:服务器错误\s*[:：]?|code\s*[=:])\s*(\d+)/i)?.[1]) || 0;
};
const stopError = (text, stopped = false) => Object.assign(new Error(text), { stopped });
function bodyOf(r) {
  const code = Number(r?.code ?? 0);
  if (code) throw Object.assign(new Error(`服务器错误: ${code}`), { code });
  return r?.mergeBox || r?.evoTower ? r : obj(r?.data) ? r.data : obj(r?.body) ? r.body : r;
}
function rewardView(box) {
  // A whitelist of reward-related fields, excluding clocks and complete role data.
  return Object.fromEntries(Object.entries(box).filter(([k]) =>
    /claim|reward|progress|task/i.test(k) && !/time|token|secret|password/i.test(k)));
}
export function parseWeirdTowerState(boxResponse, towerResponse) {
  const box = bodyOf(boxResponse)?.mergeBox, tower = bodyOf(towerResponse)?.evoTower;
  if (!obj(box) || !obj(tower) || !obj(box.gridMap)) throw new Error('状态结构不完整：需要 mergeBox.gridMap 和 evoTower');
  const keys = number(tower.lotteryLeftCnt), cost = number(box.costTotalCnt);
  if (![keys, cost].every(v => Number.isSafeInteger(v) && v >= 0)) throw new Error('钥匙或累计使用次数字段缺失/无效，不能按零处理');
  const cells = [];
  for (const [x, row] of Object.entries(box.gridMap)) {
    if (!obj(row) && !Array.isArray(row)) throw new Error('棋盘行结构异常');
    for (const [y, cell] of Object.entries(row)) {
      if (!obj(cell)) throw new Error('棋盘格结构异常');
      const cx = number(x), cy = number(y), conf = number(cell.gridConfId), id = number(cell.gridItemId);
      if (![cx, cy, conf, id].every(Number.isSafeInteger)) throw new Error('棋盘位置或物品字段缺失/无效');
      // Missing lock field follows the existing implementation; unknown values fail closed.
      const locked = cell.isLock === undefined ? false :
        cell.isLock === false || number(cell.isLock) === 0 ? false : true;
      cells.push({ x: cx, y: cy, conf, id, locked });
    }
  }
  if (!cells.length) throw new Error('棋盘为空，活动状态无法确认');
  cells.sort((a, b) => a.x - b.x || a.y - b.y);
  const free = number(box.freeEnergy);
  const rewards = rewardView(box);
  const daily = tower.taskClaimMap || {};
  return { keys, cost, free: Number.isSafeInteger(free) && free >= 0 ? free : null,
    cells, grid: stable(cells), rewards, daily, box,
    towerTasks: { taskMap: tower.taskMap ?? null, taskClaimMap: daily,
      towerId: tower.towerId ?? null, rewardTowerId: tower.rewardTowerId ?? null, energy: tower.energy ?? null },
    signature: stable({ keys, cost, free: Number.isFinite(free) ? free : null, cells, rewards, daily }) };
}
export function findWeirdTowerPair(state, blocked = new Set()) {
  const groups = new Map();
  for (const cell of state.cells) {
    if (cell.conf !== 0 || cell.id <= 0 || cell.locked) continue;
    const group = groups.get(cell.id) || [];
    group.push(cell); groups.set(cell.id, group);
  }
  // Ordinary low-level items first, then other IDs; do not let a special item starve them.
  for (const [id, group] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (group.length >= 2 && !blocked.has(`${state.grid}:${id}`)) return [group[0], group[1]];
  }
  return null;
}
export const weirdTowerOpenPosition = cost => cost < 2 ? { gridX: 4, gridY: 5 } :
  cost < 102 ? { gridX: 7, gridY: 3 } : { gridX: 6, gridY: 3 };
const summary = s => ({ keys: s.keys, cost: s.cost, free: s.free,
  listedCells: s.cells.length,
  lockedCells: s.cells.filter(c => c.locked).length,
  movableItems: s.cells.filter(c => c.conf === 0 && c.id > 0 && !c.locked).length,
  listedEmptyCells: s.cells.filter(c => c.conf === 0 && c.id === 0 && !c.locked).length,
  pairCandidate: !!findWeirdTowerPair(s) });
const todayKey = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(2, 10).replace(/-/g, '');

const savedDebugEnabled = () => {
  try { return globalThis.localStorage?.getItem('weird_tower_debug_verbose') === '1'; }
  catch { return false; }
};

export function createWeirdTowerIntegrated(deps, overrides = {}) {
  const options = { ...WEIRD_TOWER_OPTIONS, ...overrides };
  const { selectedTokens, tokens, tokenStatus, isRunning, shouldStop, tokenStore,
    addLog, message, connectionQueue, batchSettings, releaseConnectionSlot } = deps;
  if (!queryControls.has(tokenStore)) queryControls.set(tokenStore, { lastTowerAt: -Infinity, nextAccountAt: 0 });
  const queryControl = queryControls.get(tokenStore);
  const log = (id, text, type = 'info', detail) => {
    const name = tokens.value.find(t => t.id === id)?.name || id;
    addLog({ time: new Date().toLocaleTimeString(), type,
      message: `[怪异塔综合][v5][${name}] ${text}${detail === undefined ? '' : ' ' + stable(detail)}` });
  };

  async function runAccount(id, result) {
    const started = Date.now(), deadline = started + options.maxDurationMs;
    let writes = 0, requests = 0, state, noProgress = 0;
    let lastRequest = null, lastSentAt = 0;
    let towerCache = null, towerSyncCost = 0, towerSyncAct = null;
    let readRecoveries = 0, towerQueries = 0, boardQueries = 0;
    const stats = { used: 0, merged: 0, claimed: 0, freeClaims: 0 };
    const unresolved = new Map(), blockedPairs = new Set();
    const claimAttempts = new Map();
    const debug = (text, detail) => { if (options.debug) log(id, '[调试] ' + text, 'info', detail); };
    const reportStats = (confirmed = true) => {
      const remaining = state
        ? `；${confirmed ? '剩余' : state.keysSource === 'derived' ? '按已确认消耗推算剩余' : '最近确认剩余'}钥匙${state.keys}把，免费道具${state.free ?? '未知'}` : '';
      return `${confirmed ? '使用' : '已确认使用'}钥匙${stats.used}把，合成${stats.merged}次，领取奖励${stats.claimed}次（含免费道具${stats.freeClaims}次）${remaining}；耗时${Math.round((Date.now() - started) / 1000)}秒；塔查询${towerQueries}次，查询重试${readRecoveries}次`;
    };
    const check = () => {
      if (shouldStop.value) throw stopError('用户已停止', true);
      if (Date.now() >= deadline) throw stopError('达到单账号时长保护上限，待继续');
      if (requests >= options.maxRequests) throw stopError('达到请求次数保护上限，待继续');
    };
    const wait = async ms => {
      const end = Date.now() + ms;
      while (Date.now() < end) { check(); await new Promise(r => setTimeout(r, Math.min(100, end - Date.now()))); }
      check();
    };
    const send = async (cmd, args = {}, write = false) => {
      check();
      if (write && writes >= options.maxWrites) throw stopError('达到操作次数保护上限，待继续');
      const now = Date.now();
      const gap = Math.max(options.requestGapMs - (now - lastSentAt),
        cmd === 'evotower_getinfo' ? options.towerQueryGapMs - (now - queryControl.lastTowerAt) : 0);
      if (gap > 0) await wait(gap);
      requests++; if (write) writes++;
      lastSentAt = Date.now(); lastRequest = { cmd, write };
      if (cmd === 'evotower_getinfo') { queryControl.lastTowerAt = lastSentAt; towerQueries++; }
      if (cmd === 'mergebox_getinfo') boardQueries++;
      try {
        return bodyOf(await tokenStore.sendMessageWithPromise(id, cmd, args,
          Math.max(1, Math.min(options.requestTimeoutMs, deadline - Date.now()))));
      } catch (e) {
        debug('请求返回异常', { cmd, write, code: codeOf(e), reason: safeReason(e) });
        throw e;
      }
    };
    const readEndpoint = async (cmd, args = {}) => {
      // Retry only this failed read. No mutation is replayed, and 400340 is not reclassified as success.
      for (let attempt = 0; attempt < options.maxReadAttempts; attempt++) {
        try {
          const response = await send(cmd, args);
          if (attempt > 0) {
            log(id, `状态查询已恢复（${cmd}），继续核对本轮结果`);
          }
          return response;
        }
        catch (e) {
          check();
          const code = codeOf(e);
          if (fatalCodes.has(code) || (code && code !== 200400 && code !== 400340)) throw e;
          if (attempt + 1 >= options.maxReadAttempts || readRecoveries >= options.maxReadRecoveries) {
            queryControl.nextAccountAt = Math.max(queryControl.nextAccountAt, Date.now() + options.accountCooldownMs);
            throw Object.assign(new Error(`${cmd}连续读取失败，已停止本账号；${safeReason(e)}`), { code });
          }
          const delay = options.readRetryDelayMs * (2 * attempt + 1);
          readRecoveries++;
          log(id, `状态查询异常（${cmd}，${code ? '错误码' + code : '超时或连接异常'}），等待${delay / 1000}秒后有限重读（${attempt + 1}/${options.maxReadAttempts - 1}）`, 'warning');
          await wait(delay);
        }
      }
      throw stopError('读取重试参数无效，未继续操作');
    };
    const read = async (afterCommand = '') => {
      let boxResponse = await readEndpoint('mergebox_getinfo', { actType: 1 });
      const box = boxResponse?.mergeBox;
      const cost = number(box?.costTotalCnt);
      const act = stable({ actId: box?.actId ?? null, actType: box?.actType ?? null });
      const consumed = cost - towerSyncCost;
      const cachedKeys = number(towerCache?.evoTower?.lotteryLeftCnt);
      // Only confirmed cumulative consumption can reduce a cached key balance.
      // Claims, initial reads, final reads, activity changes and inconsistent balances always sync.
      const ordinaryAction = afterCommand === 'mergebox_openbox' || afterCommand === 'mergebox_mergeitem';
      const reuseTower = ordinaryAction && towerCache && act === towerSyncAct
        && Number.isSafeInteger(consumed) && consumed >= 0 && consumed < options.towerSyncEvery
        && Number.isSafeInteger(cachedKeys) && cachedKeys >= consumed;
      let towerResponse;
      if (reuseTower) {
        towerResponse = { evoTower: { ...towerCache.evoTower, lotteryLeftCnt: cachedKeys - consumed } };
      } else {
        const recoveryBefore = readRecoveries;
        towerResponse = await readEndpoint('evotower_getinfo');
        // If inventory recovery took time, obtain a new board once after recovery, not on every retry.
        if (readRecoveries !== recoveryBefore) boxResponse = await readEndpoint('mergebox_getinfo', { actType: 1 });
      }
      let parsed;
      try { parsed = parseWeirdTowerState(boxResponse, towerResponse); }
      catch (e) {
        debug('状态解析待核验', { reason: safeReason(e), boxFields: Object.keys(boxResponse?.mergeBox || {}),
          towerFields: Object.keys(towerResponse?.evoTower || {}) });
        throw e;
      }
      if (!reuseTower) {
        towerCache = { evoTower: { ...towerResponse.evoTower } };
        towerSyncCost = parsed.cost;
        towerSyncAct = stable({ actId: parsed.box.actId ?? null, actType: parsed.box.actType ?? null });
      }
      parsed.keysSource = reuseTower ? 'derived' : 'server';
      return parsed;
    };
    const changedFor = (cmd, before, after) => {
      if (cmd === 'mergebox_openbox') return after.cost > before.cost || (after.keys < before.keys && after.grid !== before.grid);
      if (cmd === 'mergebox_mergeitem') return after.grid !== before.grid;
      if (cmd === 'evotower_claimtask') return stable(after.daily) !== stable(before.daily) || after.keys > before.keys;
      if (cmd === 'mergebox_claimfreeenergy') return (after.free !== null && before.free !== null && after.free < before.free) || after.keys > before.keys;
      return stable(after.rewards) !== stable(before.rewards) || after.keys > before.keys;
    };
    const act = async (cmd, args, label, claim = false) => {
      let rateAttempts = 0;
      while (true) {
        const before = state;
        let error = null;
        try { await send(cmd, args, true); } catch (e) { error = e; }
        check();
        if (error?.stopped) throw error;
        await wait(options.actionDelayMs);
        state = await read(cmd);
        const code = codeOf(error), changed = changedFor(cmd, before, state);
        if (changed) {
          if (!claim) noProgress = 0;
          debug(label + (error ? '：请求异常但读回确认状态推进' : '：读回确认'), {
            cmd, args, code, before: summary(before), after: summary(state) });
          if (cmd === 'mergebox_openbox') stats.used += Math.max(1, state.cost - before.cost);
          else if (cmd === 'mergebox_mergeitem') stats.merged++;
          else {
            stats.claimed++;
            if (cmd === 'mergebox_claimfreeenergy') stats.freeClaims++;
          }
          return { changed: true, code };
        }
        debug(label + '：未观察到状态推进', { cmd, args, code, reason: error ? safeReason(error) : '响应成功，读回未变化', state: summary(state) });
        if (fatalCodes.has(code)) throw stopError(`${label}失败：${safeReason(error)}`);
        if (code === 200400 && rateAttempts++ < 2) { await wait(2000 * rateAttempts); continue; }
        if (code === 200400) throw stopError('连续限流，结束当前账号以免反复请求');
        if (error && !code) throw stopError(`${label}结果无法确认：${safeReason(error)}；未重复提交`);
        if (claim && benignClaims.has(code)) return { changed: false, code, benign: true };
        // Observed at cost=0 and immediately after successful cumulative claims.
        // Scope this to the cumulative-reward endpoint, not a global error-code mapping.
        if (claim && cmd === 'mergebox_claimcostprogress' && code === 11800010) {
          debug('本次无累计奖励可领取（依据实测，仅适用于此接口）', { code, cost: state.cost, costClaimCnt: state.box.costClaimCnt });
          return { changed: false, code, benign: true };
        }
        // A denied optional reward does not mean opening/merging cannot progress.
        // Keep the code unresolved; do not invent the meaning of 12200040.
        if (claim) {
          debug(`${label}未确认，保留记录并继续其他步骤`, { code });
          return { changed: false, code, reason: error ? safeReason(error) : '响应成功但结果未确认' };
        }
        if (!claim && code === 12300040 && cmd === 'mergebox_openbox') return { changed: false, code, full: true };
        noProgress++;
        if (noProgress >= 3) throw stopError('连续3次非预期无进展，保护退出');
        return { changed: false, code, reason: error ? safeReason(error) : '响应成功但结果未确认' };
      }
    };
    let acquired = false, ownedConnection = false;
    try {
      log(id, '开始综合处理');
      check();
      const cooldown = queryControl.nextAccountAt - Date.now();
      if (cooldown > 0) {
        log(id, `上次查询连续失败，等待${Math.ceil(cooldown / 1000)}秒后再处理当前账号`, 'warning');
        await wait(cooldown);
      }
      // Cancellable queue acquisition; do not leave an un-cancelled ensureConnection promise behind.
      let status = tokenStore.getWebSocketStatus(id);
      if (status === 'connecting' || status === 'reconnecting') {
        const end = Date.now() + 30000;
        while (['connecting', 'reconnecting'].includes(tokenStore.getWebSocketStatus(id)) && Date.now() < end) await wait(200);
        if (tokenStore.getWebSocketStatus(id) !== 'connected') throw stopError('已有连接尚未就绪，跳过以免干扰其连接');
      }
      if (tokenStore.getWebSocketStatus(id) !== 'connected') {
        while (connectionQueue.active >= Math.max(1, Number(batchSettings.maxActive) || 1)) await wait(200);
        check(); if (connectionQueue.reserve) { if (!connectionQueue.reserve(id)) throw stopError("账号连接名额已被占用"); } else connectionQueue.active++; acquired = true; ownedConnection = true;
        const token = tokens.value.find(t => t.id === id);
        if (!token) throw stopError('账号已不存在');
        debug('正在连接');
        tokenStore.createWebSocketConnection(id, token.token, token.wsUrl);
        const end = Math.min(deadline, Date.now() + Math.min(60000, Math.max(5000, Number(batchSettings.connectionTimeout) || 20000)));
        while (tokenStore.getWebSocketStatus(id) !== 'connected' && Date.now() < end) await wait(200);
        if (tokenStore.getWebSocketStatus(id) !== 'connected') throw stopError('连接超时');
      }
      check(); tokenStatus.value[id] = 'running';
      await send('role_getroleinfo');
      state = await read();
      debug('初始状态', { version: 'v5', ...summary(state) });
      debug('初始结构', { mergeFields: Object.keys(state.box).sort(), rewards: state.rewards, daily: state.daily, towerTasks: state.towerTasks,
        grid: state.cells, limits: { durationSec: options.maxDurationMs / 1000, writes: options.maxWrites },
        openPositionRule: '沿用旧版 cost<2 / cost<102 / 其他；手动两两合成，不依赖固定解锁ID',
        gridNote: 'gridMap可能只列出已有格子；未列出空格不能据此判满，满格以12300040响应为准' });

      const claimOnce = async (cmd, args, label) => {
        // Reprobe only when the relevant eligibility/claim state changes.
        // Cache benign denials and unconfirmed responses as well as failures.
        const eligibility = cmd === 'evotower_claimtask'
          ? { day: todayKey(), towerTasks: state.towerTasks }
          : cmd === 'mergebox_claimcostprogress'
            ? { cost: state.cost, costClaimCnt: state.box.costClaimCnt ?? null }
            : { rewards: state.rewards };
        const key = stable({ cmd, args, eligibility });
        if (claimAttempts.has(key)) return claimAttempts.get(key);
        const response = await act(cmd, args, label, true);
        if (!response.changed) claimAttempts.set(key, response);
        return response;
      };

      const dailyClaims = async () => {
        for (const taskId of [1, 2, 3]) {
          check();
          const claimed = state.daily[todayKey()]?.[taskId];
          const key = `daily:${taskId}`;
          if (flag(claimed)) { unresolved.delete(key); continue; }
          const r = await claimOnce('evotower_claimtask', { taskId }, `领取每日钥匙任务${taskId}`);
          if (r.changed || r.benign) unresolved.delete(key);
          else unresolved.set(key, `每日任务${taskId}领取未确认(${r.code || r.reason})`);
        }
      };
      const rewards = async (checkCost = true) => {
        // Drain cumulative rewards until the server reports no available reward.
        const seen = new Set();
        while (checkCost) {
          check();
          if (seen.has(state.signature)) { unresolved.set('cost', '累计奖励状态重复'); break; }
          seen.add(state.signature);
          const r = await claimOnce('mergebox_claimcostprogress', { actType: 1 }, '领取使用进度奖励');
          if (r.changed) { unresolved.delete('cost'); continue; }
          if (r.benign) unresolved.delete('cost');
          else unresolved.set('cost', `使用进度奖励未确认(${r.code || r.reason})`);
          break;
        }
        const attempted = new Set();
        while (true) {
          const tasks = state.box.taskMap || {}, claimed = state.box.taskClaimMap || {};
          const entry = Object.keys(tasks).find(k => /^\d+$/.test(k) && Number.isFinite(number(tasks[k])) && number(tasks[k]) !== 0 && !flag(claimed[k]) && !attempted.has(k));
          if (!entry) break;
          attempted.add(entry);
          const r = await claimOnce('mergebox_claimmergeprogress', { actType: 1, taskId: Number(entry) }, `领取合成奖励${entry}`);
          if (r.changed || r.benign) unresolved.delete(`merge:${entry}`);
          else unresolved.set(`merge:${entry}`, `合成奖励${entry}未确认(${r.code || r.reason})`);
        }
      };
      await dailyClaims();
      let rewardCost = -1, rewardGrid = null, finalDailyDone = false, settled = false;
      let mustMerge = !!findWeirdTowerPair(state), fullBlocked = false, mergePhaseCount = 0;
      if (mustMerge) debug('检测到已有组合，先连续合成再使用钥匙');
      while (true) {
        check();
        if (rewardCost < 0 || (!mustMerge && (state.cost - rewardCost >= options.progressEvery || state.keys === 0))) {
          if (rewardCost !== state.cost || rewardGrid !== state.grid) {
            await rewards(); rewardCost = state.cost; rewardGrid = state.grid;
          }
        }
        if (state.keys > 0 && !mustMerge && !fullBlocked) {
          const pos = weirdTowerOpenPosition(state.cost);
          const r = await act('mergebox_openbox', { actType: 1, pos }, '使用钥匙');
          if (r.changed) { settled = false; continue; }
          if (r.full) { mustMerge = true; fullBlocked = true; mergePhaseCount = 0; debug('格子已满，开始连续合成，清理后再使用钥匙'); }
          else throw stopError(`使用钥匙未确认(${r.code || r.reason})，停止重复消耗`);
        }
        const pair = findWeirdTowerPair(state, blockedPairs);
        if (pair) {
          const [source, target] = pair, blockedKey = `${state.grid}:${source.id}`;
          const r = await act('mergebox_mergeitem', { actType: 1,
            sourcePos: { gridX: source.x, gridY: source.y }, targetPos: { gridX: target.x, gridY: target.y } }, '合成物品');
          if (r.changed) {
            unresolved.delete(`pair:${source.id}`);
            mustMerge = true; fullBlocked = false; settled = false; mergePhaseCount++;
            // Stay in the merge phase until no legal candidate remains.
            // Merge rewards are checked periodically; opening-progress rewards do not change during merging.
            if (mergePhaseCount % options.progressEvery === 0) {
              await rewards(false);
              debug('连续合成进度', { phaseMerges: mergePhaseCount, ...summary(state) });
            }
            continue;
          }
          blockedPairs.add(blockedKey);
          unresolved.set(`pair:${source.id}`, `物品${source.id}合成未确认(${r.code || r.reason})`);
          continue;
        }
        if (mustMerge) {
          mustMerge = false;
          await rewards(); rewardCost = state.cost; rewardGrid = state.grid;
          debug('本轮连续合成结束', { phaseMerges: mergePhaseCount, ...summary(state) });
          mergePhaseCount = 0;
          if (!fullBlocked && state.keys > 0) continue;
        }
        if (fullBlocked && state.keys > 0) unresolved.set('board', `棋盘受阻且无可执行合成，剩余钥匙${state.keys}`);
        if (!finalDailyDone) {
          finalDailyDone = true;
          const before = state.signature;
          await dailyClaims(); await rewards(); rewardCost = state.cost; rewardGrid = state.grid;
          if (before !== state.signature) { settled = false; continue; }
        }
        if (state.free === null) unresolved.set('free', 'freeEnergy 字段缺失，免费道具状态无法确认');
        else if (state.free > 0) {
          const r = await act('mergebox_claimfreeenergy', { actType: 1 }, '领取免费道具', true);
          if (r.changed) { unresolved.delete('free'); settled = false; continue; }
          if (!r.benign) unresolved.set('free', `免费道具领取未确认(${r.code || r.reason})`);
          else unresolved.set('free', '免费道具仍显示可领取，但服务器拒绝，需核对');
        }
        // One final fresh read and reward pass; a stable state is required to finish.
        if (!settled) {
          const before = state.signature;
          state = await read(); await rewards(); rewardCost = state.cost; rewardGrid = state.grid;
          settled = before === state.signature;
          if (!settled) continue;
        }
        if (state.keys > 0) unresolved.set('keys', `剩余钥匙${state.keys}未使用`);
        if (findWeirdTowerPair(state)) unresolved.set('pair', '仍有相同物品组合，是否达到最高等级需核对日志');
        if (unresolved.size) throw stopError([...unresolved.values()].join('；'));
        if (state.keysSource !== 'server') { state = await read(); settled = false; continue; }
        result.status = 'completed';
        log(id, `完成：${reportStats()}`, 'success');
        debug('完成核对', { ...stats, final: summary(state) });
        return;
      }
    } catch (e) {
      result.status = e.stopped ? 'stopped' : 'partial';
      result.exceptions.push(safeReason(e));
      const code = codeOf(e);
      const context = code && lastRequest ? `（命令${lastRequest.cmd}，错误码${code}）` : '';
      log(id, `${e.stopped ? '已停止' : '未完成'}：${safeReason(e)}${context}；${reportStats(false)}`, e.stopped ? 'warning' : 'error');
      debug('退出统计', { ...stats, writes, requests, towerQueries, boardQueries, readRecoveries, lastRequest,
        elapsedSec: Math.round((Date.now() - started) / 1000), state: state ? summary(state) : null });
      if (state) debug('退出核对', { rewards: state.rewards, daily: state.daily, towerTasks: state.towerTasks, grid: state.cells });
    } finally {
      if (ownedConnection) {
        try { await tokenStore.closeWebSocketConnection(id); }
        catch (e) { result.warnings.push('关闭连接异常'); log(id, '关闭连接异常', 'warning'); }
      }
      if (acquired) releaseConnectionSlot(id);
    }
  }

  async function batchWeirdTowerIntegrated() {
    const ids = [...new Set(selectedTokens.value)];
    if (!ids.length) return [];
    if (busyStores.has(tokenStore)) {
      return ids.map(tokenId => {
        tokenStatus.value[tokenId] = 'failed'; log(tokenId, '已有综合任务运行，本次未启动', 'error');
        return { tokenId, status: 'failed', exceptions: ['已有综合任务运行'], warnings: [] };
      });
    }
    busyStores.add(tokenStore);
    if (overrides.debug === undefined) options.debug = WEIRD_TOWER_OPTIONS.debug || savedDebugEnabled();
    const ownsRunning = !isRunning.value;
    if (ownsRunning) shouldStop.value = false;
    isRunning.value = true;
    const results = [];
    try {
      for (const id of ids) tokenStatus.value[id] = 'waiting';
      // Process accounts sequentially to bound connection use.
      for (const id of ids) {
        const result = { tokenId: id, status: 'running', exceptions: [], warnings: [] };
        if (shouldStop.value) { result.status = 'stopped'; result.exceptions.push('用户已停止，未启动'); }
        else await runAccount(id, result);
        tokenStatus.value[id] = result.status;
        results.push(result);
      }
      const completed = results.filter(r => r.status === 'completed').length;
      if (completed === results.length) message?.success?.(`怪异塔综合处理完成：${completed}个账号`);
      else message?.warning?.(`怪异塔综合处理结束：完成${completed}，待核对/停止${results.length - completed}`);
      return results;
    } finally { busyStores.delete(tokenStore); if (ownsRunning) isRunning.value = false; }
  }
  return { batchWeirdTowerIntegrated };
}

