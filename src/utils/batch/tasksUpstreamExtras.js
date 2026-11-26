import { normalizeBlackMarketPurchaseList, toStorePurchaseItemList, compareBlackMarketPurchaseLists } from './blackMarketConfig.js';

export const normalizeRedeemCodes = (text) => [...new Set(String(text || '').split(/[\s,，;；]+/).map(x => x.trim()).filter(Boolean))];
const locks = new Map();
const runs = new WeakMap();
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
const unwrap = value => value?.body ?? value?.data ?? value;
const errorText = error => String(error?.message || error || '未知错误');

// 两种新任务在同一账号上顺序运行，防止各自关闭对方的连接。
async function withAccountLock(id, callback) {
  const previous = locks.get(id) || Promise.resolve();
  let unlock;
  const gate = new Promise(resolve => { unlock = resolve; });
  const tail = previous.then(() => gate);
  locks.set(id, tail);
  await previous;
  try { return await callback(); }
  finally { unlock(); if (locks.get(id) === tail) locks.delete(id); }
}

export function createTasksUpstreamExtras(deps) {
  const { selectedTokens, tokens, tokenStatus, isRunning, shouldStop, tokenStore,
    batchSettings, ensureConnection, releaseConnectionSlot, addLog, delayConfig = {} } = deps;
  const log = (id, text, type = 'info') => addLog({
    time: new Date().toLocaleTimeString(),
    message: `${tokens.value.find(t => t.id === id)?.name || id} ${text}`, type,
  });
  const send = (id, command, params = {}) => tokenStore.sendMessageWithPromise(id, command, params, 8000);
  const stopped = () => { if (shouldStop.value) throw new Error('任务已停止'); };

  async function run(label, validationError, execute) {
    const ids = [...new Set(selectedTokens.value)];
    const results = [];
    let state = runs.get(isRunning);
    if (!state) {
      state = { count: 0, ownsRunning: !isRunning.value };
      runs.set(isRunning, state);
      if (state.ownsRunning) shouldStop.value = false;
    }
    state.count++;
    isRunning.value = true;
    try {
      for (const id of ids) {
        const result = { tokenId: id, status: 'running', exceptions: [], warnings: [] };
        await withAccountLock(id, async () => {
          let ownsConnection = false;
          try {
            stopped();
            if (validationError) throw new Error(validationError);
            tokenStatus.value[id] = 'running';
            const wasConnected = tokenStore.getWebSocketStatus(id) === 'connected';
            await ensureConnection(id);
            ownsConnection = !wasConnected;
            stopped();
            await execute(id, result);
            if (result.status === 'running') result.status = 'completed';
          } catch (error) {
            result.status = shouldStop.value ? 'stopped' : 'failed';
            result.exceptions.push(errorText(error));
          } finally {
            if (ownsConnection) {
              try { await tokenStore.closeWebSocketConnection(id); }
              catch (error) { result.warnings.push(`关闭连接失败：${errorText(error)}`); }
              finally { releaseConnectionSlot(id); }
            }
          }
          tokenStatus.value[id] = result.status;
          log(id, `${label}：${result.status}${result.exceptions.length ? '；' + result.exceptions.join('；') : ''}`,
            ['failed', 'partial', 'stopped'].includes(result.status) ? 'warning' : 'success');
        });
        results.push(result);
        if (!shouldStop.value) await sleep(delayConfig.task);
      }
      return results;
    } finally {
      if (--state.count === 0) {
        if (state.ownsRunning) isRunning.value = false;
        runs.delete(isRunning);
      }
    }
  }

  function batchRedeemCodes() {
    // 开始时固定配置，执行过程中修改弹窗不会改变当前任务。
    const codes = normalizeRedeemCodes(batchSettings.cdkCodes);
    const platformType = String(batchSettings.cdkPlatformType || 'h5').trim() || 'h5';
    return run('兑换码', codes.length ? '' : '请先保存兑换码配置', async (id, result) => {
      const response = unwrap(await send(id, 'role_getroleinfo'));
      let role = response?.role || response;
      if (!role || typeof role !== 'object') throw new Error('无法读取角色兑换记录');
      let successes = 0, skipped = 0;
      for (const code of codes) {
        if (shouldStop.value) { result.status = 'stopped'; result.exceptions.push('任务已停止，剩余兑换码未执行'); break; }
        if (role.statistics?.[`cdk:${code}_0`]) { skipped++; log(id, `兑换码 ${code} 已使用，跳过`); continue; }
        try {
          // 写请求不自动重试；超时可能已生效，下次执行重新读取兑换记录。
          const reply = unwrap(await send(id, 'system_claimcdkreward', { key: code, platformType }));
          if (reply?.role) role = reply.role;
          successes++;
          log(id, `兑换码 ${code} 兑换成功`, 'success');
        } catch (error) {
          result.exceptions.push(`${code}：${errorText(error)}（超时请先核对游戏内兑换记录）`);
        }
        await sleep(delayConfig.command);
      }
      if (result.status !== 'stopped') {
        result.status = result.exceptions.length ? (successes || skipped ? 'partial' : 'failed')
          : successes ? 'completed' : 'skipped';
      }
      log(id, `成功 ${successes}，已兑换跳过 ${skipped}，异常 ${result.exceptions.length}`);
    });
  }

  function store_syncpurchaseconfig() {
    const desired = normalizeBlackMarketPurchaseList(batchSettings.blackMarketPurchaseList);
    const readConfig = async id => {
      const response = unwrap(await send(id, 'store_getpurchase'));
      // 缺失字段时拒绝猜测，避免覆盖服务器采购次数或已有清单。
      if (!response || !Array.isArray(response.purchaseItemList) ||
          response.purchaseCnt == null || !Number.isInteger(Number(response.purchaseCnt)) || Number(response.purchaseCnt) < 0) {
        throw new Error('黑市配置响应不完整，已取消写入');
      }
      return { purchaseCnt: Number(response.purchaseCnt), purchaseItemList: response.purchaseItemList };
    };
    return run('同步黑市清单', desired.length ? '' : '请先保存至少一项黑市采购配置', async (id, result) => {
      const current = await readConfig(id);
      stopped();
      if (compareBlackMarketPurchaseLists(current.purchaseItemList, desired)) {
        result.status = 'skipped'; log(id, '黑市清单已一致，无需写入'); return;
      }
      await send(id, 'store_setpurchase', {
        purchaseCnt: current.purchaseCnt,
        purchaseItemList: toStorePurchaseItemList(desired),
      });
      await sleep(delayConfig.command);
      // 已发送的写请求必须读回确认；停止仅阻止后续账号的写入。
      const verified = await readConfig(id);
      if (verified.purchaseCnt !== current.purchaseCnt || !compareBlackMarketPurchaseLists(verified.purchaseItemList, desired)) {
        throw new Error('服务器读回结果与预期不一致，请在游戏内核对黑市配置');
      }
      log(id, `已同步 ${desired.length} 项，保留采购次数 ${current.purchaseCnt}；未执行采购`, 'success');
    });
  }
  return { batchRedeemCodes, store_syncpurchaseconfig };
}

