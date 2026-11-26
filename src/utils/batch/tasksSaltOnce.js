import { createRecordStore, LABELS, pick, NAVIGATION_VERSION } from '../saltField/model.js';
import { openSaltSession } from '../saltField/session.js';
import { SaltOnceRunner, runSaltBatch, wait } from '../saltField/runner.js';
import { saltDebug } from '../saltField/debug.js';
import { startSaltDiagnostic, SALT_DIAGNOSTIC_VERSION } from '../saltField/diagnostics.js';

// SALT_ONCE_DIAGNOSTICS_V3

export function createTasksSaltOnce(deps) {
  const { selectedTokens, tokens, tokenStore, tokenStatus, isRunning, shouldStop,
    connectionQueue, batchSettings, releaseConnectionSlot, addLog } = deps;
  let controller = null;
  let diagnostic = null;
  let accountDiagnostics = new Map();
  let sessionNumber = 0;
  const saltOnceRows = deps.saltOnceRows;
  const log = (id, text, type = 'info') => addLog({ time: new Date().toLocaleTimeString(), type,
    message: `[盐场一次][${tokens.value.find(t => t.id === id)?.name || id}] ${text}` });
  const stopSaltOnce = () => controller?.abort();
  const isSaltOnceRunning = () => controller !== null;
  async function connect(tokenId, signal) {
    let ownedMain = false, slot = false, session = null;
    const trace = accountDiagnostics.get(tokenId)?.scope({ sessionId: ++sessionNumber });
    trace?.record('account.connect.start', {});
    const cleanup = () => {
      session?.close();
      if (ownedMain) { tokenStore.closeWebSocketConnection(tokenId); ownedMain = false; }
      if (slot) { releaseConnectionSlot(tokenId); slot = false; }
    };
    try {
      while (connectionQueue.active >= Math.max(1, Number(batchSettings.maxActive) || 1)) await wait(250, signal);
      if (signal.aborted) throw new Error('任务已停止');
      if (connectionQueue.reserve) { if (!connectionQueue.reserve(tokenId)) throw new Error("账号连接名额已被占用"); } else connectionQueue.active++; slot = true;
      let account = tokens.value.find(t => t.id === tokenId);
      if (!account) throw new Error('账号已删除');
      if (tokenStore.getWebSocketStatus(tokenId) !== 'connected') {
        ownedMain = true;
        tokenStore.createWebSocketConnection(tokenId, account.token, account.wsUrl);
        const end = Date.now() + (Number(batchSettings.connectionTimeout) || 10000);
        while (tokenStore.getWebSocketStatus(tokenId) !== 'connected') {
          if (Date.now() >= end) throw new Error('主连接超时');
          await wait(200, signal);
        }
      }
      if (signal.aborted) throw new Error('任务已停止');
      const response = await tokenStore.sendMessageWithPromise(tokenId, 'legion_getbattlefield', {}, 10000);
      const info = pick(response, 'info');
      trace?.record('main.entry.response', { battlefieldId: info?.battlefieldId, hasSid: info?.sid != null });
      saltDebug('main.entry.response', {
        hasResponse: Boolean(response), hasInfo: Boolean(info),
        battlefieldId: info?.battlefieldId ?? null, hasSid: info?.sid != null,
      });
      if (info?.sid == null || !info?.battlefieldId) throw new Error('未取得盐场入口（请核对活动时间和报名状态）');
      account = tokens.value.find(t => t.id === tokenId);
      if (!account?.token) throw new Error('账号凭据不可用');
      // Release the main connection created by this task; leave borrowed connections intact.
      if (ownedMain) { tokenStore.closeWebSocketConnection(tokenId); ownedMain = false; }
      session = await openSaltSession({ token: account.token, info, signal, diagnostic: trace });
      const active = session;
      return { send: active.send, refresh: active.refresh, roleCodeId: active.roleCodeId,
        battlefieldId: active.battlefieldId,
        get role() { return active.role; }, get snapshot() { return active.snapshot; },
        close: cleanup };
    } catch (error) {
      trace?.record('account.connect.failed', { message: error?.message, code: error?.code });
      saltDebug('account.connect.failed', {
        message: error?.message || String(error),
        code: error?.code ?? null,
        serverRejected: Boolean(error?.serverRejected),
        serverResponse: error?.serverResponse ?? null,
      });
      cleanup();
      throw error;
    }
  }
  // SALT_SCHEDULE_V1: one controller for manual and scheduled runs.
  async function batchSaltOnce(options = {}) {
    const ids = [...new Set(selectedTokens.value)];
    saltDebug('batch.start', {
      selectedCount: ids.length,
      maxActive: Math.max(1, Number(batchSettings.maxActive) || 1),
    });
    const statusRef = options?.tokenStatusRef || tokenStatus;
    const failedToStart = reason => {
      log('批次', reason, 'warning');
      return ids.map(tokenId => ({ tokenId, status: 'failed', exceptions: [reason] }));
    };
    if (!ids.length) return [];
    if (controller || isRunning.value) return failedToStart('已有批量任务正在运行，盐场任务未启动');
    if (!globalThis.navigator?.locks) {
      const reason = '浏览器不支持跨标签页锁，请使用 HTTPS 下的新版 Chrome/Edge';
      deps.message?.error(reason);
      return failedToStart(reason);
    }
    // The scheduled wrapper uses this same instance so stop/unmount/health checks
    // always see the active controller. Only its reporting sink is scoped.
    try {
      return await navigator.locks.request('xyzw-salt-once-batch-v1', { ifAvailable: true }, async lock => {
        if (!lock) return failedToStart('另一个标签页正在执行盐场任务，本次未启动');
        if (controller || isRunning.value) return failedToStart('已有批量任务正在运行，盐场任务未启动');
        controller = new AbortController();
        const activeController = controller;
        const signal = activeController.signal;
        const accounts = ids.map((id, index) => ({ accountRef: index + 1,
          accountName: tokens.value.find(t => t.id === id)?.name || `账号${index + 1}` }));
        diagnostic = startSaltDiagnostic(accounts, {
          maxActive: batchSettings.maxActive, connectionTimeout: batchSettings.connectionTimeout,
          execution: 'sequential-prepare-then-attack', minMarchMs: 120000, maxAttempts: 3,
          navigationVersion: NAVIGATION_VERSION, navigationPolicy: 'static-roads-live-buildings-server-confirmed',
          allocationPolicy: 'same-distance-same-owner-fewer-batch-assignments',
        });
        accountDiagnostics = new Map(ids.map((id, index) => [id, diagnostic.scope(accounts[index])]));
        sessionNumber = 0;
        let timer = null;
        let batchError = '';
        shouldStop.value = false; isRunning.value = true;
        log('批次', `运行版本 ${SALT_DIAGNOSTIC_VERSION}；静态道路推导候选据点，同距离优先本批分配较少的目标；单吕布、不组队、不加速`);
        try {
          saltOnceRows.value = ids.map(tokenId => ({ tokenId, state: 'pending', attempts: 0 }));
          const records = createRecordStore(globalThis.localStorage), lastMessages = new Map();
          const update = record => {
            const index = saltOnceRows.value.findIndex(row => row.tokenId === record.tokenId);
            if (index >= 0) saltOnceRows.value[index] = { ...record };
            statusRef.value[record.tokenId] = record.state === 'completed' ? 'completed'
              : ['failed', 'unknown'].includes(record.state) ? 'failed' : record.state === 'stopped' ? 'stopped' : 'running';
            if (record.state === 'pending' && record.targetingRecoveryVersion === NAVIGATION_VERSION
              && !lastMessages.has(`recovered:${record.tokenId}`)) {
              log(record.tokenId, '已恢复旧版出发前失败记录：服务端已确认空闲，尚未提交行军/攻击；保留原失败历史');
              lastMessages.set(`recovered:${record.tokenId}`, true);
            }
            if (record.state === 'targeting' && record.candidateQueue?.length) {
              const candidateText = record.candidateQueue.map(c => `${c.buildingId}（${c.distance}格，${c.belongsLegionId === -1 ? '中立' : '非己方'}，本批其他账号已安排${c.assignedCount ?? 0}个）`).join(' → ');
              if (lastMessages.get(`candidates:${record.tokenId}`) !== candidateText) {
                log(record.tokenId, `候选据点：${candidateText}；可达性待行军响应确认`);
                lastMessages.set(`candidates:${record.tokenId}`, candidateText);
              }
            }
            const detail = `${LABELS[record.state]}；尝试 ${record.attempts}/3${record.target ? `；目标 ${record.target.buildingId}（${record.target.distance}格）${record.target.path ? `；候选路径 ${record.target.path.join(' → ')}` : ''}` : ''}${record.state === 'marching' && record.marchAccepted ? '；行军已确认，等待实际到达' : ''}${record.marchRejections?.length ? `；此前行军已拒绝 ${record.marchRejections.length} 次（${record.marchRejections.map(item => `${item.target.buildingId}/${item.code ?? '?'}`).join('、')}）` : ''}${record.error ? `；${record.error}` : ''}${record.proof ? `；${record.proof}` : ''}${record.observedRole ? `；角色 ${record.observedRole.state}，aB=${record.beforeAttack?.aB}→${record.observedRole.aB}，d=${record.beforeAttack?.d}→${record.observedRole.d}` : ''}`;
            if (lastMessages.get(record.tokenId) !== detail) {
              log(record.tokenId, detail, record.state === 'completed' ? 'success' : record.error ? 'warning' : 'info');
              lastMessages.set(record.tokenId, detail);
            }
          };
          timer = setInterval(() => { if (shouldStop.value) activeController.abort(); }, 100);
          const runners = ids.map(tokenId => new SaltOnceRunner({ tokenId, records, connect, signal, onUpdate: update, diagnostic: accountDiagnostics.get(tokenId) }));
          await runSaltBatch(runners, signal);
        } catch (error) {
          batchError = error?.message || String(error);
          log('批次', batchError, 'error');
        } finally {
          clearInterval(timer);
          try {
            for (const row of saltOnceRows.value) {
              if (!['completed', 'failed', 'unknown', 'stopped'].includes(row.state)) {
                row.state = signal.aborted ? 'stopped' : 'failed';
                row.error = row.error || batchError || (signal.aborted ? '任务已停止' : '任务未返回终态');
              }
              statusRef.value[row.tokenId] = row.state === 'unknown' ? 'failed' : row.state;
            }
            const done = saltOnceRows.value.filter(row => row.state === 'completed').length;
            saltDebug('batch.finished', {
              selectedCount: ids.length,
              completed: done,
              failedOrUnknown: saltOnceRows.value.filter(row => ['failed', 'unknown'].includes(row.state)).length,
              stopped: saltOnceRows.value.filter(row => row.state === 'stopped').length,
              aborted: signal.aborted,
            });
            diagnostic.finish(saltOnceRows.value.map((row, index) => ({ ...row, ...accounts[index] })));
            log('批次', `结束：已确认完成 ${done}/${ids.length}；其余账号请查看状态和日志`);
          } finally {
            activeController.abort(); controller = null; isRunning.value = false;
          }
        }
        // Preserve the exact failure reason in scheduled / PushPlus reports.
        return saltOnceRows.value.map(row => ({
          tokenId: row.tokenId,
          status: row.state === 'unknown' ? 'failed' : row.state,
          exceptions: row.state === 'completed' ? [] : [
            row.state === 'unknown'
              ? `待核验（禁止重攻）：${row.error || '未取得个人战斗结算证据'}`
              : row.error || (row.state === 'stopped' ? '任务已停止' : '盐场任务失败'),
          ],
        }));
      });
    } catch (error) {
      return failedToStart(`盐场启动或执行异常：${error?.message || String(error)}`);
    }
  }
  return { batchSaltOnce, stopSaltOnce, isSaltOnceRunning };
}

