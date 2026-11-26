/** 配置迁移和刷新共用来源识别；不访问认证接口，不打印凭据。 */
const legacy = method => method == null || method === '' || method === 'import';
const text = value => typeof value === 'string' ? value.trim() : '';
const binMethod = method => method === 'bin' || method === 'wxQrcode';
const validUrl = value => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};
export function createTokenBinAccess(db) {
  async function perform(name, ...args) {
    const deadline = Date.now() + 5000;
    while (!db.isReady.value) {
      if (db.error.value || Date.now() >= deadline) throw new Error('账号原始数据存储不可用，请刷新页面后重试');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    db.error.value = null;
    const value = await db[name](...args);
    if (db.error.value || (name !== 'getArrayBuffer' && value !== true)) throw new Error('账号原始数据读写失败');
    return value;
  }
  return { read: key => perform('getArrayBuffer', key), write: (key,data) => perform('storeArrayBuffer',key,data),
    remove: key => perform('deleteArrayBuffer',key) };
}
export async function resolveTokenRefreshSource(token, readBin, tokens = [token]) {
  const method = token.importMethod;
  const url = text(token.sourceUrl);
  if (method === 'url' || (legacy(method) && url)) {
    return validUrl(url) ? { method: 'url', sourceUrl: url }
      : { method: null, reason: '缺少有效来源 URL，请补充原来源地址' };
  }
  if (binMethod(method) || legacy(method)) {
    let data = await readBin(token.id), oldKey = null;
    // 兼容旧版本按名称保存的BIN，但不在重名或名称撞其他账号ID时借用。
    if (!data && token.name && token.name !== token.id
      && tokens.filter(t => t.name === token.name).length === 1
      && !tokens.some(t => t.id === token.name)) {
      data = await readBin(token.name);
      if (data) oldKey = token.name;
    }
    if (data instanceof ArrayBuffer && data.byteLength > 0) {
      return { method: method === 'wxQrcode' ? 'wxQrcode' : 'bin', data, oldKey };
    }
    return { method: null, reason: '缺少原始 BIN，请从原设备导出含BIN配置或重新导入BIN' };
  }
  return { method: null, reason: '此导入方式不支持自动刷新' };
}
const MAX_BIN = 1024 * 1024;
export function encodeConfigBin(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 1 || data.byteLength > MAX_BIN) throw new Error('配置中的BIN大小异常');
  const bytes = new Uint8Array(data); let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
export function decodeConfigBin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_BIN / 3) * 4
    || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw new Error('配置中的BIN编码无效，未导入');
  }
  let s;
  try { s = atob(value); } catch { throw new Error('配置中的BIN编码无效，未导入'); }
  if (!s.length || s.length > MAX_BIN || btoa(s) !== value) throw new Error('配置中的BIN编码无效，未导入');
  return Uint8Array.from(s, c => c.charCodeAt(0)).buffer;
}
export async function exportTokenRecords(tokens, binAccess, includeBin = true, allTokens = tokens) {
  const records = []; let missing = 0, included = 0;
  for (const t of tokens) {
    const record = {};
    for (const key of ['id','name','token','server','wsUrl','remark','importMethod','sourceUrl','upgradedAt','updatedAt']) record[key] = t[key];
    record.upgradedToPermanent = true;
    // 不勾选BIN时也保留原来源元数据，不强制读取数据库。
    const source = includeBin ? await resolveTokenRefreshSource(t, binAccess.read, allTokens) : null;
    if (source?.method) record.importMethod = source.method;
    if (source?.sourceUrl) record.sourceUrl = source.sourceUrl;
    if (includeBin && source?.data) { record.binBase64 = encodeConfigBin(source.data); included++; }
    if (includeBin && !source?.method && (binMethod(t.importMethod) || legacy(t.importMethod))) missing++;
    records.push(record);
  }
  return { records, included, missing };
}

/** 先完整校验，再补齐缺失BIN；已有账号保留ID、当前Token和其他设置。 */
export async function importTokenRecords(incoming, current, binAccess, { retainEmbeddedBin = false, commit } = {}) {
  if (!Array.isArray(incoming)) throw new Error('账号配置格式无效');
  const planned = current.map(t => ({ ...t })), idMap = new Map(), seen = new Set(), incomingIds = new Set();
  const writes = []; let added = 0, repaired = 0, missing = 0;
  const bytesEqual = (a, b) => {
    const right = new Uint8Array(b);
    return a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === right[i]);
  };
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object' || !text(raw.token) || !text(raw.id)) throw new Error('账号缺少ID或Token，未导入');
    if (incomingIds.has(raw.id)) throw new Error('配置包含重复账号ID，未导入');
    incomingIds.add(raw.id);
    const byId = planned.find(t => t.id === raw.id), byToken = planned.find(t => t.token === raw.token);
    if (byId && byToken && byId.id !== byToken.id) throw new Error('账号ID与Token对应关系冲突，未导入');
    const existing = byId || byToken;
    const id = existing?.id || raw.id;
    idMap.set(raw.id, id);
    if (seen.has(id)) throw new Error('配置中多个账号指向同一记录，未导入');
    seen.add(id);
    const embedded = raw.binBase64 === undefined ? null : decodeConfigBin(raw.binBase64);
    const urlOnly = (existing?.importMethod === 'url' && validUrl(existing.sourceUrl))
      || ((!existing || legacy(existing.importMethod)) && (raw.importMethod === 'url' || legacy(raw.importMethod))
        && validUrl(existing?.sourceUrl || raw.sourceUrl));
    const old = urlOnly && !retainEmbeddedBin ? null : await binAccess.read(id);
    // 不用旧备份覆盖当前已保存的认证来源。
    if (retainEmbeddedBin && old && embedded && !bytesEqual(old, embedded)) throw new Error('本地存储与导入的 BIN 冲突');
    let data = old || embedded;
    if (!urlOnly && !data && raw.name && incoming.filter(t => t?.name === raw.name).length === 1 && planned.filter(t => t.name === raw.name && t.id !== id).length === 0
      && !planned.some(t => t.id === raw.name && t.id !== id)) data = await binAccess.read(raw.name);
    let method = existing?.importMethod, sourceUrl = existing?.sourceUrl || null;
    const hasCurrentSource = (method === 'url' && validUrl(sourceUrl)) || (binMethod(method) && old);
    if (!hasCurrentSource) {
      const candidateUrl = text(existing?.sourceUrl) || text(raw.sourceUrl);
      if ((raw.importMethod === 'url' || legacy(raw.importMethod) || (existing && legacy(method))) && candidateUrl) {
        if (!validUrl(candidateUrl)) throw new Error('配置中的来源URL无效，未导入');
        method = 'url'; sourceUrl = candidateUrl;
      } else if (data) { method = raw.importMethod === 'wxQrcode' || method === 'wxQrcode' ? 'wxQrcode' : 'bin'; }
      else { method = binMethod(raw.importMethod) || raw.importMethod === 'manual' ? raw.importMethod : 'import'; }
    }
    if (!old && data && (binMethod(method) || retainEmbeddedBin)) writes.push({ id, data });
    if (!data && (binMethod(method) || legacy(method))) missing++;
    if (existing) {
      if (existing.importMethod !== method || existing.sourceUrl !== sourceUrl || (!old && data && binMethod(method))) repaired++;
      if (retainEmbeddedBin && !text(existing.token)) existing.token = raw.token;
      Object.assign(existing, { importMethod: method, sourceUrl });
    } else {
      const timestamp = new Date().toISOString();
      planned.push({ id, name: text(raw.name), token: raw.token, server: raw.server || '', wsUrl: raw.wsUrl || null,
        remark: raw.remark || '', importMethod: method, sourceUrl, upgradedToPermanent: true,
        upgradedAt: raw.upgradedAt || null, updatedAt: raw.updatedAt || timestamp, createdAt: timestamp, lastUsed: timestamp });
      added++;
    }
  }
  const attempted = [];
  let binsVerified = false;
  try {
    for (const entry of writes) {
      // 只补缺失项；异步期间若已有数据变化则停止，不覆盖。
      if (await binAccess.read(entry.id)) throw new Error('导入期间账号原始数据发生变化，请重试');
      attempted.push(entry.id);
      await binAccess.write(entry.id, entry.data);
      const saved = await binAccess.read(entry.id);
      if (!saved || !bytesEqual(saved, entry.data)) throw new Error('原始BIN保存后核验失败');
    }
    binsVerified = true;
    const result = { tokens: planned, idMap, added, repaired, missing, restoredBins: writes.length };
    return commit ? await commit(result) : result;
  } catch (error) {
    let restored = true;
    for (const id of attempted.reverse()) { try { await binAccess.remove(id); } catch { restored = false; } }
    if (!restored) throw new Error(binsVerified ? '配置提交失败且新增BIN清理未完成，请刷新后检查'
      : '原始BIN导入失败且清理未完成，账号配置未修改，请刷新后检查');
    if (binsVerified) throw error;
    throw new Error('原始BIN导入失败，本次新增BIN已撤回，账号配置未修改');
  }
}
export const remapTokenIds = (ids, idMap) => Array.isArray(ids) ? [...new Set(ids.map(id => idMap.get(id) || id))] : [];
