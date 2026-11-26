/** 营地空投保底：北京时间周二至周四，用主线当前队伍补足三次。 */
import { gameDateKey, gameDay, inMatchDay, safeError } from '../campReadOnly.js';

const busyStores = new WeakSet();
const owns = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const count = value => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== ''
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function campProgress(response, now = Date.now()) {
  if (!object(response?.club) || !object(response?.siege)) throw new Error('营地信息缺少 club/siege，已停止');
  const { club, siege } = response;
  const date = gameDateKey(now), day = gameDay(now);
  if (!inMatchDay(now, club.phase, day)) throw new Error('营地赛期不是当前周，已停止');
  if (!object(siege.attackMap) || !object(siege.taskProgress)) {
    throw new Error('营地次数或任务字段未确认，已停止');
  }
  const today = siege.attackMap[date];
  const attackCnt = today === undefined ? 0 : count(today?.attackCnt);
  const taskCount = owns(siege.taskProgress, '4') ? count(siege.taskProgress[4]) : 0;
  if (attackCnt === null || taskCount === null) throw new Error('营地挑战次数格式异常，已停止');
  return { club, siege, date, day, phase: String(club.phase), attackCnt, taskCount,
    total: Math.max(attackCnt, taskCount, owns(siege.taskClaimedMap || {}, '4') ? 3 : 0) };
}

// 读取账号当前主线上阵队伍，不读取竞技场或预设阵容，不切换账号阵容。
export function campMainlineTeam(response) {
  const body = response?._rawData ?? response?.data ?? response;
  const role = body?.role;
  const team = role?.battleTeam;
  if (!object(team) && !Array.isArray(team)) throw new Error('未取得主线当前队伍，已停止本账号');
  const battleTeam = {}, heroes = new Set();
  for (const [slot, hero] of Object.entries(team)) {
    if (!/^\d+$/.test(slot)) continue;
    const id = hero == null ? 0 : count(object(hero) ? hero.heroId ?? hero.id : hero);
    if (id === 0) continue;
    if (!/^[0-4]$/.test(slot) || !id || heroes.has(id)) throw new Error('主线队伍数据异常，已停止本账号');
    battleTeam[slot] = id; heroes.add(id);
  }
  if (!heroes.size) throw new Error('主线队伍为空，请在游戏内正常上阵武将');
  const lordWeaponId = count(role.lordWeaponId ?? 0);
  const petUId = role.pet?.petUId ?? role.petUId ?? '';
  if (lordWeaponId === null || !['string', 'number'].includes(typeof petUId)) throw new Error('主线装备数据异常');
  return { battleTeam, lordWeaponId, petUId: String(petUId) };
}
export const isCampAirdropDay = (time = Date.now()) => [2, 3, 4].includes(gameDay(time));

export function createTasksCampChallenge(deps) {
  const { selectedTokens, tokens, tokenStatus, isRunning, shouldStop, tokenStore,
    ensureConnection, releaseConnectionSlot, addLog, currentRunningTokenId } = deps;
  const now = deps.campNow || Date.now;
  const sleep = deps.campSleep || pause;
  const spacing = Math.max(250, Number(deps.delayConfig?.command) || 250);
  const battleDelay = Math.max(500, Number(deps.delayConfig?.battle) || 1000);
  const aliases = new Map();
  let runId = 0;
  // 正常运行每个账号只输出结果；详细信息仅在手动启用调试时送往控制台。
  const log = (id, event, detail = {}, type = 'info') => {
    if (!aliases.has(id)) aliases.set(id, `账号${aliases.size + 1}`);
    const alias = aliases.get(id);
    const name = safeError(tokens.value.find(token => token.id === id)?.name || alias);
    let verbose = false;
    try { verbose = globalThis.localStorage?.getItem('camp_debug_verbose') === 'true'; } catch (_) { /* 正常日志不依赖存储 */ }
    if (verbose) console.debug(`[营地调试][v6][${alias}][批次${runId}] ${event} ${JSON.stringify(detail)}`);
    if (['当前进度', '使用主线当前队伍', '挑战已核验'].includes(event)) return;
    let summary = event;
    if (event === '空投保底完成') summary = `空投保底完成，本次挑战 ${detail.attacks} 次`;
    else if (event === '今日已完成，跳过挑战') summary = '今日已完成，跳过';
    else if (event === '账号结束') {
      const status = { stopped: '已停止', partial: '部分完成', failed: '失败' }[detail.status] || '结束';
      summary = `${status}，本次已确认 ${detail.attacks || 0} 次：${safeError(detail.reason)}`;
    } else if (detail.reason || detail.error) summary += `：${safeError(detail.reason || detail.error)}`;
    const text = `[营地保底][${name}] ${summary}`;
    addLog({ time: new Date().toLocaleTimeString(), message: text, type });
    (type === 'error' || type === 'warning' ? console.warn : console.info)(text);
  };
  const checkStop = () => {
    if (shouldStop.value) { const error = new Error('任务已停止'); error.stopped = true; throw error; }
  };
  const send = async (id, cmd, params = {}, afterWrite = false, expectedDate = null) => {
    await sleep(spacing);
    if (!afterWrite) checkStop();
    if (expectedDate && (gameDateKey(now()) !== expectedDate || !isCampAirdropDay(now()))) {
      const error = new Error('已跨北京时间零点，尚未发送本次操作'); error.beforeSend = true; throw error;
    }
    const response = await tokenStore.sendMessageWithPromise(id, cmd, params, 15000);
    if (response?.code != null && Number(response.code) !== 0) throw new Error(`服务器错误码 ${response.code}`);
    return response;
  };
  const read = async (id, afterWrite = false) => {
    const response = await send(id, 'club_getinfo', {}, afterWrite);
    try { return campProgress(response, now()); }
    catch (error) {
      log(id, '进度解析异常', { fields: object(response) ? Object.keys(response).slice(0, 14) : [],
        phase: response?.club?.phase, date: gameDateKey(now()),
        siegeFields: object(response?.siege) ? Object.keys(response.siege).slice(0, 24) : [],
        todayAttack: response?.siege?.attackMap?.[gameDateKey(now())]?.attackCnt,
        challengeTask: response?.siege?.taskProgress?.[4], reason: safeError(error) }, 'warning');
      throw error;
    }
  };
  const samePeriod = (a, b) => a.date === b.date && a.phase === b.phase;
  async function mutate(id, state, params, result) {
    checkStop();
    if (gameDateKey(now()) !== state.date) throw new Error('已跨北京时间零点，请重新运行任务');
    const cmd = 'club_attackmonster';
    let response, writeError;
    try { response = await send(id, cmd, params, false, state.date); }
    catch (error) {
      if (error.stopped || error.beforeSend) throw error;
      writeError = error;
    }
    // 即使用户按了停止，也只补做只读核验，不再发送下一次挑战。
    let latest, verified = false, readError;
    for (let attempt = 0; attempt < 2 && !verified; attempt++) {
      try {
        await sleep(battleDelay);
        latest = await read(id, true);
        verified = samePeriod(state, latest) && latest.total > state.total;
      } catch (error) { readError = error; }
    }
    if (!verified) {
      log(id, '本次挑战未核验', { cmd, responseFields: object(response) ? Object.keys(response).slice(0, 14) : [],
        before: state.total, after: latest?.total, error: safeError(writeError || readError || '回读进度未增加') }, 'warning');
      throw new Error(`${cmd} 结果未确认，本轮停止该账号；再次执行时会重新读取服务端次数`);
    }
    result.attacks++;
    const hp = response?.battleData?.result?.accept?.ext?.curHP;
    log(id, '挑战已核验', { cmd,
      before: state.total, after: latest.total, attackCnt: latest.attackCnt, taskCount: latest.taskCount,
      outcome: typeof hp === 'number' && Number.isFinite(hp) && hp >= 0 ? (hp === 0 ? '胜利' : '未击败') : '未返回胜负',
      recoveredAfterError: !!writeError }, 'success');
    if (writeError) {
      throw new Error('请求异常后已核验该操作成功，本账号本轮停止；再次运行会先检查最新进度');
    }
    return latest;
  }
  async function perform(id, result) {
    let state = await read(id);
    log(id, '当前进度', { date: state.date, phase: state.phase, attackCnt: state.attackCnt,
      taskCount: state.taskCount, goal: 3 });
    // 每次执行以服务端今日进度为准，不再使用旧版本的浏览器待确认记录。
    if (state.total >= 3) {
      checkStop();
      log(id, '今日已完成，跳过挑战', { total: state.total, attacks: 0 });
      return;
    }
    if (state.total < 3) {
      const role = await send(id, 'role_getroleinfo');
      const teamSetParams = campMainlineTeam(role);
      log(id, '使用主线当前队伍', { source: 'role.battleTeam', heroIds: Object.values(teamSetParams.battleTeam) });
      for (let attempt = 0; attempt < 3; attempt++) {
        checkStop();
        const latest = await read(id);
        if (!samePeriod(state, latest)) throw new Error('日期或赛期变化，请重新运行任务');
        state = latest;
        if (state.total >= 3) break;
        state = await mutate(id, state, { useItem: false, teamSetParams }, result);
      }
      if (state.total < 3) throw new Error('本轮进度未达到三次，已停止继续挑战');
    }
    checkStop();
    log(id, '空投保底完成', { total: state.total, attacks: result.attacks });
  }
  async function run(options = {}) {
    const ids = [...new Set(selectedTokens.value)];
    if (!ids.length) return [];
    const failAll = text => ids.map(tokenId => {
      tokenStatus.value[tokenId] = 'failed'; log(tokenId, text, {}, 'error');
      return { tokenId, status: 'failed', exceptions: [text] };
    });
    if (busyStores.has(tokenStore) || (options.manual && isRunning.value)) return failAll('请等待当前任务结束');
    busyStores.add(tokenStore);
    const ownsRunning = !isRunning.value;
    if (options.manual) shouldStop.value = false;
    isRunning.value = true; runId++;
    const results = [];
    try {
      for (const tokenId of ids) {
        const result = { tokenId, status: 'running', exceptions: [], attacks: 0 };
        let acquired = false;
        try {
          checkStop();
          if (!isCampAirdropDay(now())) {
            result.status = 'skipped';
            log(tokenId, '非周二至周四，跳过');
            continue;
          }
          if (!tokens.value.some(t => t.id === tokenId)) throw new Error('账号已移除');
          tokenStatus.value[tokenId] = 'running';
          if (currentRunningTokenId) currentRunningTokenId.value = tokenId;
          if (tokenStore.getWebSocketStatus(tokenId) !== 'connected') {
            await ensureConnection(tokenId); acquired = true;
          }
          checkStop();
          await perform(tokenId, result);
          result.status = 'completed';
        } catch (error) {
          result.status = error.stopped ? 'stopped' : result.attacks ? 'partial' : 'failed';
          result.exceptions.push(safeError(error));
          log(tokenId, '账号结束', { status: result.status, attacks: result.attacks, reason: safeError(error) }, 'warning');
        } finally {
          if (acquired) {
            try {
              const close = tokenStore.closeWebSocketConnectionAsync || tokenStore.closeWebSocketConnection;
              await close.call(tokenStore, tokenId);
            } catch (error) { log(tokenId, '连接关闭异常', { reason: safeError(error) }, 'warning'); }
            finally { releaseConnectionSlot(tokenId); }
          }
          tokenStatus.value[tokenId] = result.status;
          results.push(result);
        }
      }
    } finally {
      busyStores.delete(tokenStore);
      if (ownsRunning) isRunning.value = false;
      if (currentRunningTokenId) currentRunningTokenId.value = null;
    }
    return results;
  }
  // 兼容浏览器中已保存的旧定时任务：明确跳过，不发送任何游戏请求。
  const retired = label => [...new Set(selectedTokens.value)].map(tokenId => {
    const reason = `${label}已停用，请在定时任务中改选“营地空投保底（周二至周四）”`;
    tokenStatus.value[tokenId] = 'skipped';
    log(tokenId, '跳过旧营地任务', { reason });
    return { tokenId, status: 'skipped', exceptions: [], warnings: [reason] };
  });
  return {
    batchCampChallenge: () => retired('营地人员挑战'),
    batchCampChallengePet: options => run(options),
    batchCampClaimTasks: () => retired('营地领奖'),
  };
}

