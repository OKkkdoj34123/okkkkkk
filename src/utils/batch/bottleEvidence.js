// Only numeric reward/assistant fields and protocol headers leave this module.
// No full role, inventory, token, request body or arbitrary server text is stored.
const object = value => value && typeof value === "object" && !Array.isArray(value);
const number = value => (typeof value === "number" || typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value))
  && Number.isFinite(Number(value)) ? Number(value) : null;
const bodyOf = value => value?._rawData ?? value?.data ?? value;
const safeKey = key => /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key)
  && !/token|password|cookie|session|auth|secret|ticket|credential|url|name|account/i.test(key);
const command = value => typeof value === "string" && /^[a-z_]{1,60}$/i.test(value) ? value : "缺失";
export function bottleWireSummary(value) {
  const wire = value?.__bottleDiagnostic ?? value?.__dreamDiagnostic ?? value ?? {};
  const numeric = key => number(wire[key]) ?? "缺失";
  const mode = ["resp", "cmd-fallback", "timeout"].includes(wire.matchMode) ? wire.matchMode : "缺失";
  return `请求=${command(wire.requestCmd)}，响应=${command(wire.responseCmd)}，code=${numeric("code")}，seq=${numeric("requestSeq")}，resp=${numeric("resp")}，匹配=${mode}`;
}
export function bottleSnapshot(response) {
  const role = bodyOf(response)?.role;
  const helper = role?.bottleHelpers;
  const values = {};
  let omitted = false;
  const visit = (value, path, depth) => {
    if (Object.keys(values).length >= 32 || depth > 3) { omitted = true; return; }
    const n = number(value);
    if (n !== null) { values[path] = n; return; }
    if (typeof value === "boolean") { values[path] = value; return; }
    if (object(value) || Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length > 32) omitted = true;
      for (const [key, child] of entries.slice(0, 32)) {
        if (safeKey(key) || /^\d{1,5}$/.test(key)) visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  if (object(helper)) visit(helper, "", 0);
  return { daily: number(role?.dailyTask?.complete?.[14]), present: object(helper) === true, values, omitted };
}
export function bottleSnapshotText(snapshot) {
  return `日常14=${snapshot.daily ?? "缺失"}，助手数值=${snapshot.present ? JSON.stringify(snapshot.values) : "缺失"}${snapshot.omitted ? "（仅前32项/3层）" : ""}`;
}
export function bottleChangeText(before, after) {
  if (!after.present) return "助手状态读回缺失";
  const changes = Object.keys({ ...before.values, ...after.values }).filter(k => before.values[k] !== after.values[k]);
  return changes.length ? changes.map(k => `${k}:${before.values[k] ?? "缺失"}→${after.values[k] ?? "缺失"}`).join("，") : "所记录助手数值未变化";
}
export function bottleReceipt(response) {
  const body = bodyOf(response);
  const wire = response?.__bottleDiagnostic ?? body?.__bottleDiagnostic;
  const correlated = wire?.requestCmd === "bottlehelper_claim" && ["bottlehelper_claimresp", "syncrewardresp"].includes(wire?.responseCmd?.toLowerCase())
    && wire?.matchMode === "resp" && number(wire.requestSeq) !== null && number(wire.resp) === number(wire.requestSeq)
    && (wire.code === 0 || wire.code === undefined);
  const fields = object(body) ? Object.keys(body).filter(safeKey).slice(0, 20).join("/") || "空" : "非对象";
  const rewards = [];
  const totals = new Map();
  let rewardCount = 0;
  let sampled = false;
  const rewardNumbers = {};
  const visitReward = (value, path, depth) => {
    if (depth > 3 || Object.keys(rewardNumbers).length >= 24) return;
    const n = number(value);
    if (n !== null) { rewardNumbers[path] = n; return; }
    if (object(value) || Array.isArray(value)) {
      for (const [key, child] of Object.entries(value).slice(0, 24)) {
        if (safeKey(key) || /^\d{1,5}$/.test(key)) visitReward(child, `${path}.${key}`, depth + 1);
      }
    }
  };
  for (const key of ["reward", "rewards"]) {
    if (body?.[key] != null) visitReward(body[key], key, 0);
    if (!Array.isArray(body?.[key])) continue;
    if (body[key].length > 20) sampled = true;
    for (const item of body[key].slice(0, 20)) {
      if (!object(item)) continue;
      const id = number(item.itemId ?? item.id);
      const amount = number(item.value ?? item.count ?? item.num ?? item.number);
      const type = number(item.type);
      // Observed server currency rewards use itemId=0 and type 2 or 7.
      // Do not invent currency names or accept arbitrary zero-id reward types.
      const label = id !== null && id > 0 ? `物品${id}` : id === 0 && [2, 7].includes(type) ? `资源类型${type}` : null;
      if (label && amount !== null && amount > 0) {
        rewardCount++;
        totals.set(label, (totals.get(label) || 0) + amount);
      }
    }
  }
  for (const [label, amount] of totals) rewards.push(`${label}×${amount}`);
  const confirmed = Boolean(correlated && rewards.length);
  const compact = `奖励${sampled ? "（每数组前20条）" : ""}=${rewards.slice(0, 8).join("、") || "未识别"}${rewards.length > 8 ? `等${rewards.length}类` : ""}；${bottleWireSummary(response)}`;
  return { confirmed, compact, rewardCount,
    summary: `回包字段=${fields}；奖励条目=${rewards.length ? rewards.join("、") : "未识别到正数物品条目（不等于没有奖励）"}；奖励数值摘要=${JSON.stringify(rewardNumbers)}（最多24项/3层，仅观察）；${bottleWireSummary(response)}` };
}

// Last attempt is evidence only. It never blocks or automatically repeats a claim.
const HISTORY_KEY = "xyzw_bottle_observation_v1";
const memory = new Map();
const ttl = 7 * 86400000;
const historyId = value => {
  let hash = 2166136261;
  for (const c of String(value)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return `a${(hash >>> 0).toString(16)}`;
};
const store = () => { try { return globalThis.localStorage; } catch { return null; } };
const load = () => { try { const data = JSON.parse(store()?.getItem(HISTORY_KEY) || "{}"); return object(data) ? data : {}; } catch { return {}; } };
const valid = (entry, now) => object(entry) && number(entry.at) !== null && entry.at <= now && now - entry.at <= ttl
  && ["receipt", "pending", "error"].includes(entry.outcome);
export function previousBottleAttempt(tokenId, now = Date.now()) {
  const key = historyId(tokenId), saved = load()[key], cached = memory.get(key);
  const entry = [saved, cached].filter(e => valid(e, now)).sort((a, b) => b.at - a.at)[0];
  if (!entry) return "上次尝试：本浏览器无近期记录";
  const label = { receipt: "回包含奖励", pending: "待核验", error: "请求报错" }[entry.outcome];
  return `上次尝试：${new Date(entry.at).toLocaleString()}，距本次${Math.floor((now - entry.at) / 1000)}秒，${label}${number(entry.code) !== null ? `，code=${Number(entry.code)}` : ""}`;
}
export function rememberBottleAttempt(tokenId, outcome, code, now = Date.now()) {
  const key = historyId(tokenId);
  const entry = { at: now, outcome, code: number(code) };
  if (!valid(entry, now)) return;
  memory.set(key, entry);
  for (const [id, item] of memory) if (!valid(item, now)) memory.delete(id);
  while (memory.size > 500) memory.delete(memory.keys().next().value);
  try {
    const data = load(); data[key] = entry;
    const latest = Object.entries(data).filter(([id, value]) => /^a[0-9a-f]{1,8}$/.test(id) && valid(value, now))
      .sort((a, b) => b[1].at - a[1].at).slice(0, 500)
      .map(([id, value]) => [id, { at: Number(value.at), outcome: value.outcome, code: number(value.code) }]);
    store()?.setItem(HISTORY_KEY, JSON.stringify(Object.fromEntries(latest)));
  } catch { /* Storage failure must not change game actions or their result. */ }
}
