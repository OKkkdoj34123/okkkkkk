/** 普通俱乐部申请：手动提交允许更新旧的已响应记录，定时任务保留防重保护。 */
const RECORD_KEY = 'xyzw_legion_apply_records_v1';
const busyStores = new WeakSet();
const membershipKeys = ['legionId', 'legionID', 'clubId', 'clubID', 'guildId', 'guildID'];
const owns = (object, key) => object != null && Object.prototype.hasOwnProperty.call(object, key);
const isIdValue = value => (typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value));
function describeMembershipValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return `number:${String(value)}`;
  if (typeof value === 'string') {
    if (value === '') return 'string:空字符串';
    if (!value.trim()) return `string:空白(length=${value.length})`;
    if (/^-?\d{1,20}$/.test(value)) return `string:${value}`;
    return `string:非标准整数(length=${value.length})`;
  }
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (Array.isArray(value)) return `array(length=${value.length})`;
  return typeof value;
}
function membershipSummary(object, keys = membershipKeys) {
  const fields = keys.filter(key => owns(object, key));
  return fields.length ? fields.map(key => `${key}=${describeMembershipValue(object[key])}`).join(', ') : 'ID 字段均缺失';
}
const wait = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
const reason = error => String(error?.message || error || '未知错误');
export function normalizeLegionId(value) {
  if (!/^[1-9]\d*$/.test(String(value ?? '').trim())) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
function bodyOf(response) {
  let body = response;
  for (let depth = 0; depth < 5; depth++) {
    if (body?.code != null && Number(body.code) !== 0) {
      const error = new Error(`服务器错误：${body.code}`);
      error.code = Number(body.code);
      throw error;
    }
    if (!body || typeof body !== 'object') return body;
    if (['role', 'roleInfo', 'info', 'legionInfo', 'legionData', ...membershipKeys].some(key => owns(body, key))) return body;
    const next = body._rawData ?? body.rawData ?? body.decodedBody ?? body.body ?? body.data;
    if (next == null || next === body) return body;
    body = next;
  }
  throw new Error('响应封装层级异常');
}
export function readRoleLegionId(response) {
  const body = bodyOf(response);
  const role = body?.role ?? body?.roleInfo?.role ?? body?.roleInfo ?? body;
  const values = membershipKeys
    .filter(key => owns(role, key))
    .map(key => role[key]);
  const ids = values.map(value => isIdValue(value) ? Number(value) : NaN);
  const allValid = values.length > 0 && values.every(isIdValue)
    && ids.every(id => Number.isSafeInteger(id) && id >= 0);
  if (allValid && new Set(ids).size === 1) return ids[0];
  const summary = membershipSummary(role);
  // 有正数入会证据的冲突/异常不能被另一次“未入会”响应覆盖。
  const hasPositiveEvidence = values.some(value =>
    (typeof value === 'number' && value > 0)
    || (typeof value === 'string' && Number(value) > 0));
  if (hasPositiveEvidence) {
    throw new Error(`角色所属俱乐部字段冲突或异常（${summary}），已取消申请`);
  }
  // 缺失、负值、空字符串或不支持的类型仅表示未知，不能直接当作 0。
  const error = new Error(`角色所属俱乐部字段未确认（${summary}）`);
  error.membershipNeedsLookup = true;
  error.membershipSummary = summary;
  throw error;
}
// 仅解析当前账号 legion_getinfo 的响应，不能把目标俱乐部预览当作入会状态。
export function readLegionInfoId(response) {
  const body = bodyOf(response);
  const nodes = [body?.info, body?.legionInfo?.info, body?.legionInfo];
  const values = nodes.filter(node => node && typeof node === 'object')
    .flatMap(node => ['id', ...membershipKeys].filter(key => owns(node, key)).map(key => node[key]));
  if (!values.length || values.some(value => !isIdValue(value))) {
    throw new Error('当前俱乐部 ID 未确认');
  }
  const ids = values.map(Number);
  if (ids.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(ids).size !== 1) {
    throw new Error('当前俱乐部 ID 存在异常或冲突');
  }
  return ids[0];
}
function legionInfoShape(response) {
  // 只输出固定字段的类型与缺失情况，不输出完整角色信息或账号凭据。
  let body;
  try { body = bodyOf(response); } catch (_) { return '响应不可解析'; }
  return [['info', body?.info], ['legionInfo.info', body?.legionInfo?.info], ['legionInfo', body?.legionInfo]]
    .map(([name, node]) => {
      if (node == null) return `${name}=${node === null ? 'null' : '缺失'}`;
      return `${name}: ${membershipSummary(node, ['id', ...membershipKeys])}`;
    }).join('，');
}
export function normalizeLegionPreview(response, requestedId) {
  const body = bodyOf(response);
  const raw = body?.legionData ?? body?.info ?? body?.legionInfo;
  const id = normalizeLegionId(raw?.id ?? raw?.legionId ?? requestedId);
  const name = String(raw?.name ?? raw?.legionName ?? '').trim();
  if (!raw || !id || id !== requestedId || !name) throw new Error('未取得匹配的俱乐部信息，已取消申请');
  return { id, name, level: Number(raw.level ?? raw.lv ?? 0),
    memberCount: Number(raw.memberCount ?? raw.memNum ?? raw.memberNum ?? raw.num ?? Object.keys(raw.members || {}).length) };
}
export function createTasksLegionApply(deps) {
  const { selectedTokens, tokens, tokenStatus, isRunning, shouldStop, tokenStore,
    ensureConnection, releaseConnectionSlot, addLog, delayConfig = {} } = deps;
  const storage = () => deps.applicationStorage ?? globalThis.localStorage;
  const readRecords = () => {
    const store = storage();
    if (!store) throw new Error('申请记录存储不可用，已取消申请');
    const records = JSON.parse(store.getItem(RECORD_KEY) || '{}');
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('本地申请记录格式异常，已取消申请');
    return records;
  };
  const keyOf = (tokenId, targetId) => JSON.stringify([String(tokenId), targetId]);
  const record = (tokenId, targetId, state) => {
    const records = readRecords(), key = keyOf(tokenId, targetId);
    if (state === null) delete records[key];
    else records[key] = { state, time: Date.now() };
    storage().setItem(RECORD_KEY, JSON.stringify(records));
  };
  const log = (tokenId, text, type = 'info') => addLog({ time: new Date().toLocaleTimeString(), type,
    message: `[俱乐部申请][${tokens.value.find(t => t.id === tokenId)?.name || tokenId}] ${text}` });
  const send = (id, command, params = {}) => tokenStore.sendMessageWithPromise(id, command, params, 8000);
  const checkStop = () => {
    if (shouldStop.value) { const error = new Error('任务已停止'); error.stopped = true; throw error; }
  };
  async function currentLegionId(tokenId, afterWrite = false) {
    if (!afterWrite) checkStop();
    let roleSummary = '';
    try { return readRoleLegionId(await send(tokenId, 'role_getroleinfo')); }
    catch (error) {
      // 请求失败或有正数入会证据的字段冲突仍停止，只对未知状态独立核验。
      if (!error?.membershipNeedsLookup) throw error;
      roleSummary = error.membershipSummary;
    }
    if (!afterWrite) checkStop();
    let response;
    try {
      response = await send(tokenId, 'legion_getinfo');
      const id = readLegionInfoId(response);
      return id;
    } catch (error) {
      // 2300070 在项目协议错误码表中明确表示“未加入俱乐部”。
      const code = Number(error?.code);
      if (code === 2300070 && (!error?.requestCmd || error.requestCmd === 'legion_getinfo')) {
        return 0;
      }
      const detail = Number.isSafeInteger(code) && code !== 0
        ? `错误码 ${code}`
        : response !== undefined ? legionInfoShape(response)
          : /timeout|超时/i.test(reason(error)) ? '请求超时' : '请求失败';
      throw new Error(`角色所属俱乐部字段未确认（${roleSummary}）；legion_getinfo 未确认所属状态（${detail}）${afterWrite ? '；请在游戏内核对' : '，已取消申请'}`);
    }
  }
  async function connected(tokenId, action) {
    if (!tokens.value.some(t => t.id === tokenId)) throw new Error('账号不存在');
    const borrowed = tokenStore.getWebSocketStatus(tokenId) === 'connected';
    let acquired = false;
    try {
      await ensureConnection(tokenId);
      acquired = !borrowed;
      return await action();
    } finally {
      // ensureConnection 自己处理连接超时释放；失败时不能再释放别人的槽位。
      if (acquired) {
        try { await tokenStore.closeWebSocketConnection(tokenId); }
        catch (error) { log(tokenId, `关闭连接异常：${reason(error)}`, 'warning'); }
        finally { releaseConnectionSlot(tokenId); }
      }
    }
  }
  async function queryLegionById(tokenId, value, options = {}) {
    const id = normalizeLegionId(value);
    if (!id) throw new Error('请输入有效的正整数俱乐部 ID');
    if (busyStores.has(tokenStore) || isRunning.value) throw new Error('请等待正在执行的任务结束');
    busyStores.add(tokenStore);
    isRunning.value = true;
    try {
      return await connected(tokenId, async () => {
        if (options.isCurrent && !options.isCurrent()) throw new Error('查询已取消');
        const preview = normalizeLegionPreview(await send(tokenId, 'legion_getinfobyid', { legionId: id }), id);
        if (options.isCurrent && !options.isCurrent()) throw new Error('查询已取消');
        return preview;
      });
    } finally { busyStores.delete(tokenStore); isRunning.value = false; }
  }
  async function batchApplyLegion(value, options = {}) {
    const ids = [...new Set(selectedTokens.value)];
    const targetId = normalizeLegionId(value);
    const allowResubmit = options.allowResubmit === true;
    const manual = options.manual === true;
    const failAll = text => ids.map(tokenId => {
      tokenStatus.value[tokenId] = 'failed'; log(tokenId, text, 'error');
      return { tokenId, status: 'failed', exceptions: [text], warnings: [] };
    });
    if (!targetId) return failAll('未配置有效的目标俱乐部 ID');
    if (busyStores.has(tokenStore)) return failAll('另一个俱乐部查询或申请任务正在执行');
    busyStores.add(tokenStore);
    const ownsRunning = !isRunning.value;
    if (ownsRunning) shouldStop.value = false;
    isRunning.value = true;
    const results = [];
    try {
      for (const tokenId of ids) {
        const result = { tokenId, status: 'running', exceptions: [], warnings: [] };
        tokenStatus.value[tokenId] = 'waiting';
        try {
          checkStop();
          await connected(tokenId, async () => {
            checkStop(); tokenStatus.value[tokenId] = 'running';
            const currentId = await currentLegionId(tokenId);
            checkStop();
            if (currentId > 0) {
              // 已入会的对应旧申请不再有效，避免退会后仍被同一条记录拦截。
              try {
                if (readRecords()[keyOf(tokenId, currentId)]) record(tokenId, currentId, null);
              } catch (_) { log(tokenId, '旧申请记录清理失败，可检查浏览器存储后重试', 'warning'); }
              result.status = 'skipped';
              log(tokenId, currentId === targetId ? `已在目标俱乐部 ${targetId}，跳过` : `已在其他俱乐部 ${currentId}，跳过`);
              return;
            }
            const saved = readRecords()[keyOf(tokenId, targetId)];
            if (saved && !allowResubmit && !(manual && saved.state === 'pending')) {
              if (saved.state === 'pending') {
                result.status = 'skipped'; log(tokenId, `目标 ${targetId} 已有提交记录，定时任务未重复发送；需要重发时请使用手动申请`);
              } else {
                result.status = 'failed'; result.exceptions.push(`目标 ${targetId} 的前次申请结果未确认；请在游戏内核对后手动允许重新提交`);
              }
              return;
            }
            const target = normalizeLegionPreview(await send(tokenId, 'legion_getinfobyid', { legionId: targetId }), targetId);
            checkStop();
            if (JSON.stringify(readRecords()[keyOf(tokenId, targetId)] ?? null) !== JSON.stringify(saved ?? null)) {
              result.status = 'failed';
              result.exceptions.push('查询期间本地申请记录发生变化，已停止重复提交，请核对游戏状态');
              return;
            }
            // 发送前持久化，避免超时、刷新或退出页面后自动重复写入。
            record(tokenId, targetId, 'unconfirmed');
            let writeError = null;
            try { bodyOf(await send(tokenId, 'legion_applyjoin', { legionId: targetId })); }
            catch (error) { writeError = error; }
            let afterId = null, readError = null;
            // 即使用户已停止，也读回这一个在途写请求的结果；不继续发送申请。
            try { afterId = await currentLegionId(tokenId, true); }
            catch (error) { readError = error; }
            if (afterId === targetId) {
              record(tokenId, targetId, null); result.status = 'completed';
              log(tokenId, `已确认加入 ${target.name} (${targetId})`, 'success'); return;
            }
            if (writeError) {
              result.status = 'failed';
              result.exceptions.push(`申请结果未确认：${reason(writeError)}；未自动重试，请核对游戏申请记录`);
              return;
            }
            if (readError || afterId !== 0) {
              result.status = 'partial';
              result.exceptions.push(`申请请求已获响应，但入会状态未确认：${readError ? reason(readError) : `当前俱乐部为 ${afterId}`}`);
              return;
            }
            record(tokenId, targetId, 'pending'); result.status = 'completed';
            result.warnings.push(`申请已提交至 ${target.name} (${targetId})；尚未加入，请在游戏内核对申请记录及审核结果`);
            log(tokenId, result.warnings[0], 'success');
          });
        } catch (error) {
          result.status = error.stopped ? 'stopped' : 'failed'; result.exceptions.push(reason(error));
        }
        if (result.status === 'running') { result.status = 'failed'; result.exceptions.push('任务未确认结果'); }
        tokenStatus.value[tokenId] = result.status;
        if (result.exceptions.length) log(tokenId, result.exceptions.join('；'), 'error');
        results.push(result);
        if (!shouldStop.value) await wait(delayConfig.task);
      }
      return results;
    } finally { busyStores.delete(tokenStore); if (ownsRunning) isRunning.value = false; }
  }
  return { queryLegionById, batchApplyLegion };
}

