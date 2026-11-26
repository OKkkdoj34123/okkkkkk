// CAMP_STAGE1_V2: 计数为零且处于当前比赛日时，兼容服务端省略空战报数组。
export const CAMP_READ_COMMANDS = new Set([
  'legion_getinfo', 'club_getinfo', 'club_gettargetteam', 'role_gettargetteam',
  'club_getattackrecord', 'club_getdefenserecord', 'club_getgrouprank',
]);
const TZ = 8 * 60 * 60 * 1000;
export const gameNow = (time = Date.now()) => new Date(time + TZ);
export const gameDay = (time = Date.now()) => gameNow(time).getUTCDay();
export const gameDateKey = (time = Date.now()) => gameNow(time).toISOString().slice(2, 10).replaceAll('-', '');
export function matchDayRange(phase, day) {
  const p = String(phase ?? '');
  if (!/^\d{6}$/.test(p) || !Number.isInteger(day) || day < 0 || day > 6) return null;
  const y = 2000 + Number(p.slice(0, 2)), m = Number(p.slice(2, 4)), d = Number(p.slice(4, 6));
  const base = new Date(Date.UTC(y, m - 1, d));
  if (base.getUTCFullYear() !== y || base.getUTCMonth() !== m - 1 || base.getUTCDate() !== d) return null;
  const startMs = +base + (day ? day - 1 : 6) * 86400000 - TZ;
  return { startMs, endMs: startMs + 86400000 };
}
export function recordTime(ts) {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? (n > 1e10 ? n : n * 1000) : null;
}
export function inMatchDay(ts, phase, day) {
  const range = matchDayRange(phase, day), ms = recordTime(ts);
  return !!range && ms !== null && ms >= range.startMs && ms < range.endMs;
}
export const winFlag = (v) => v === true || v === 1 ? true : v === false || v === 0 ? false : null;
export const entityKey = (m) => `${m.id ?? m.roleId}_${!!m.mirror}_${m.slot ?? m.nodeId ?? ''}`;
export const recordKey = (r, m) => String(r.recordName || `${r.created}_${r.roleId}_${r.nodeId ?? m.slot ?? ''}_${!!m.mirror}_${r.isWin}`);
export const recordCount = (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && v !== null && v !== '' && v !== undefined ? Number(v) : null;
export function normalizeCampDefenseResponse(data, { member, phase, day, now = Date.now() }) {
  if (Array.isArray(data?.records)) return { records: data.records, inferredEmpty: false, reason: 'records-array' };
  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).filter(k => k !== '_originalCmd') : null;
  const emptyBody = keys !== null && keys.length === 0;
  const challengeCnt = recordCount(member?.challengeCnt), failCnt = recordCount(member?.failCnt);
  const currentMatchDay = inMatchDay(now, phase, day);
  if (emptyBody && currentMatchDay && challengeCnt === 0 && failCnt === 0) {
    return { records: [], inferredEmpty: true, reason: 'empty-body-zero-counter', challengeCnt, failCnt };
  }
  return { records: null, inferredEmpty: false, reason: emptyBody ? 'empty-body-unconfirmed' : 'unexpected-records-shape', challengeCnt, failCnt, currentMatchDay, fields: keys?.slice(0, 12) || [] };
}
export function safeError(error) {
  return String(error?.message ?? error ?? '未知错误')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/(?:token|password|cookie|session|authorization|secret|ticket|credential|sessId|connId)\s*[=:]\s*[^\s,;]+/gi, '[已隐藏凭据]')
    .replace(/[A-Za-z0-9_+\/-]{60,}={0,2}/g, '[长字段已隐藏]').slice(0, 240);
}
export const isCampCancelled = (e) => e?.name === 'CampQueryCancelled';
function cancelled() { const e = new Error('营地查询已停止或账号已切换'); e.name = 'CampQueryCancelled'; return e; }
const fields = (v) => v && typeof v === 'object' ? Object.keys(v).filter(k => !/token|password|cookie|session|secret|ticket|wire|diagnostic/i.test(k)).slice(0, 18) : [];
export function summarizeCampResponse(cmd, data) {
  const result = { fields: fields(data), type: Array.isArray(data) ? 'array' : typeof data };
  if (cmd === 'club_getinfo') {
    const c = data?.club || {}, own = Object.values(c.members || {});
    result.phase = c.phase; result.ownCount = own.length;
    result.ownMirrorCount = own.filter(m => !!m.mirror).length;
    result.memberKeySample = Object.keys(c.members || {}).slice(0, 3);
    result.opponents = Object.entries(c.oppoMap || {}).map(([day, v]) => ({ day, count: Object.keys(v.defenders || {}).length, mirrorCount: Object.values(v.defenders || {}).filter(m => !!m.mirror).length }));
    result.siegeFields = fields(data?.siege);
  }
  if (cmd === 'club_gettargetteam' || cmd === 'role_gettargetteam') {
    const t = data?.roleBattleTeam?.battleTeam || data?.teamInfo?.team;
    result.teamSlots = fields(t); result.hasRoleBattleTeam = !!data?.roleBattleTeam; result.hasTeamInfo = !!data?.teamInfo;
    result.slotSamples = Object.entries(t || {}).slice(0, 5).map(([slot, v]) => ({ slot, type: typeof v, fields: fields(v), heroId: v?.heroId ?? v?.id }));
  }
  if (cmd.includes('record')) {
    result.records = Array.isArray(data?.records) ? data.records.length : null;
    result.recordFields = fields(data?.records?.[0]);
    result.samples = (Array.isArray(data?.records) ? data.records : []).slice(0, 3).map(r => ({ created: r.created, isWin: r.isWin, nodeId: r.nodeId, hasRecordName: !!r.recordName }));
  }
  return result;
}
export function createCampReader(store, onProgress = () => {}) {
  let generation = 0, activeToken = null, disposed = false, queue = Promise.resolve(), lastSent = 0;
  let stats = { requested: 0, success: 0, failed: 0 }, requestIndex = 0;
  const lines = [], samples = new Set(), aliases = new Map();
  let alias = '未选账号';
  const log = (event, detail = {}, level = 'info') => {
    const line = `[营地调试][v3][${alias}][批次${generation}] ${new Date().toISOString()} ${event} ${JSON.stringify(detail)}`;
    lines.push(line); if (lines.length > 800) lines.shift();
    let verbose = false;
    try { verbose = globalThis.localStorage?.getItem('camp_debug_verbose') === 'true'; } catch (_) { /* 仍保留内存日志 */ }
    if (verbose || level === 'warn' || event === '查询完成') {
      (level === 'warn' ? console.warn : console.info)(line);
    }
  };
  const current = (g, token = activeToken) => !disposed && g === generation && token === activeToken && store.selectedToken?.id === activeToken;
  const assert = (g, token = activeToken) => { if (!current(g, token)) throw cancelled(); };
  const begin = (token, reason) => {
    generation++; activeToken = token; samples.clear(); stats = { requested: 0, success: 0, failed: 0 };
    if (!aliases.has(token)) aliases.set(token, `账号${aliases.size + 1}`);
    alias = aliases.get(token); log('开始查询', { reason, timezone: 'Asia/Shanghai', connected: store.getWebSocketStatus(token), readOnly: true });
    onProgress({ ...stats }); return generation;
  };
  const stop = (reason = '用户停止') => { log('停止查询', { reason, ...stats }); generation++; activeToken = null; onProgress({ ...stats }); };
  const send = (token, cmd, params = {}, timeout = 8000, g = generation) => {
    if (!CAMP_READ_COMMANDS.has(cmd)) return Promise.reject(new Error(`战况页面禁止非只读命令: ${cmd}`));
    const task = async () => {
      assert(g, token);
      const delay = Math.max(0, 250 - (Date.now() - lastSent));
      if (delay) await new Promise(r => setTimeout(r, delay));
      assert(g, token); lastSent = Date.now(); stats.requested++;
      const seq = ++requestIndex, started = Date.now();
      try {
        const response = await store.sendMessageWithPromise(token, cmd, params, timeout);
        assert(g, token); stats.success++;
        const sampleKey = cmd.includes('record') ? `${cmd}:${Array.isArray(response?.records) ? 'array' : 'omitted'}` : cmd;
        if (!samples.has(sampleKey)) {
          samples.add(sampleKey); log('响应样本', { request: seq, cmd, durationMs: Date.now() - started, ...summarizeCampResponse(cmd, response) });
        }
        if (stats.requested % 20 === 0) log('查询进度', { ...stats });
        return response;
      } catch (e) {
        if (!current(g, token) || isCampCancelled(e)) throw cancelled();
        stats.failed++;
        log('请求失败', { request: seq, cmd, targetId: params.targetId, mirror: params.targetIsMirror, durationMs: Date.now() - started, code: e?.code ?? e?.serverCode, reason: safeError(e) }, 'warn');
        throw e;
      } finally { if (current(g, token)) onProgress({ ...stats }); }
    };
    const result = queue.then(task, task); queue = result.catch(() => {}); return result;
  };
  return { begin, current, assert, send, log, stop, snapshot: () => ({ ...stats }), exportLog: () => lines.join('\n'), dispose: () => { stop('离开营地页面'); disposed = true; } };
}

// 返回“可查明细”统计，绝不把拉取失败、记录截断、未知胜负当作未出战。
export function aggregateCampRecords({ phase, day, ownMembers, opponent, ownResponses, opponentResponses }) {
  const range = matchDayRange(phase, day), weekStart = matchDayRange(phase, 1)?.startMs;
  const attackStats = new Map(), defenseRecords = new Map(), weeklyDefense = new Map();
  const meta = { phaseValid: !!range, opponentRequested: opponentResponses.length, opponentLoaded: 0, ownRequested: ownResponses.length, ownLoaded: 0, duplicates: 0, unknownTime: 0, unknownWin: 0, recordAttacks: 0, historical: day !== gameDay() };
  let ourTotalAttacks = 0, ourTotalLosses = 0, counterValid = true;
  for (const m of Object.values(opponent?.defenders || {})) {
    const cnt = recordCount(m.challengeCnt), fail = recordCount(m.failCnt);
    if (cnt === null || fail === null || fail > cnt) { counterValid = false; continue; }
    ourTotalAttacks += cnt; ourTotalLosses += fail;
  }
  const oppSeen = new Set(), ownSeen = new Set();
  meta.opponentEmptyConfirmed = 0; meta.ownEmptyConfirmed = 0;
  for (const { member, records, inferredEmpty } of opponentResponses) {
    if (!Array.isArray(records)) continue;
    meta.opponentLoaded++;
    if (inferredEmpty) meta.opponentEmptyConfirmed++;
    for (const r of records) {
      const t = recordTime(r.created); if (t === null) { meta.unknownTime++; continue; }
      if (!range || t < range.startMs || t >= range.endMs) continue;
      const key = recordKey(r, member); if (oppSeen.has(key)) { meta.duplicates++; continue; } oppSeen.add(key);
      const defenseWon = winFlag(r.isWin); if (defenseWon === null) { meta.unknownWin++; continue; }
      const id = Number(r.roleId); if (!Number.isSafeInteger(id) || id <= 0) { meta.unknownWin++; continue; }
      const entry = attackStats.get(id) || { roleId: id, name: r.name, attackCnt: 0, winCnt: 0, lossCnt: 0, attacks: [] };
      entry.attackCnt++; meta.recordAttacks++;
      if (!defenseWon) entry.winCnt++; else entry.lossCnt++;
      entry.attacks.push({ attackType: 1, winFlag: !defenseWon, timestamp: r.created, difficulty: r.difficulty, nodeId: r.nodeId,
        targetRoleInfo: { roleId: member.roleId, name: member.name, legionName: opponent.name, headImg: member.headImg, power: member.power } });
      attackStats.set(id, entry);
    }
  }
  let oppTotalAttacks = 0, oppTotalWins = 0, oppTotalLosses = 0;
  for (const { member, records, inferredEmpty } of ownResponses) {
    if (!Array.isArray(records)) continue;
    meta.ownLoaded++; const list = [], localSeen = new Set();
    if (inferredEmpty) meta.ownEmptyConfirmed++;
    const week = { challengeCnt: 0, defWins: 0, defLosses: 0, defWinRate: '—', defWinRateNum: -1, available: !!range && !inferredEmpty };
    for (const r of records) {
      const key = recordKey(r, member); if (localSeen.has(key)) { meta.duplicates++; continue; } localSeen.add(key);
      const t = recordTime(r.created); if (t === null) { meta.unknownTime++; continue; }
      const won = winFlag(r.isWin); if (won === null) { meta.unknownWin++; continue; }
      if (weekStart !== undefined && t >= weekStart && t < weekStart + 7 * 86400000) { week.challengeCnt++; if (won) week.defWins++; else week.defLosses++; }
      if (!range || t < range.startMs || t >= range.endMs) continue;
      if (!ownSeen.has(key)) { ownSeen.add(key); oppTotalAttacks++; if (!won) oppTotalWins++; else oppTotalLosses++; }
      list.push({ attackType: 0, winFlag: won, timestamp: r.created, difficulty: r.difficulty, nodeId: r.nodeId,
        targetRoleInfo: { roleId: r.roleId, name: r.name, legionName: r.legionName || opponent.name, headImg: r.headImg, power: r.power } });
    }
    list.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    if (week.challengeCnt) { week.defWinRateNum = week.defWins / week.challengeCnt * 100; week.defWinRate = `${week.defWinRateNum.toFixed(1)}%`; }
    defenseRecords.set(entityKey(member), list); weeklyDefense.set(entityKey(member), week);
  }
  attackStats.forEach(e => e.attacks.sort((a, b) => Number(b.timestamp) - Number(a.timestamp)));
  const totalOpp = Object.keys(opponent?.defenders || {}).length;
  meta.counterValid = counterValid; meta.counterAttacks = ourTotalAttacks;
  meta.attackComplete = !!range && totalOpp > 0 && meta.opponentLoaded === totalOpp && meta.recordAttacks === ourTotalAttacks && counterValid && !meta.unknownTime && !meta.unknownWin;
  meta.defenseComplete = !!range && ownMembers.length > 0 && meta.ownLoaded === ownMembers.length && !meta.unknownTime && !meta.unknownWin;
  const rate = (w, n) => n ? (w / n * 100).toFixed(1) : '0.0';
  const ourWins = Math.max(0, ourTotalAttacks - ourTotalLosses);
  const ourClub = { totalAttacks: ourTotalAttacks, wins: ourWins, losses: ourTotalLosses, winRate: counterValid ? rate(ourWins, ourTotalAttacks) : '—', defTotal: oppTotalAttacks, defWins: oppTotalLosses, defLosses: oppTotalWins, defWinRate: rate(oppTotalLosses, oppTotalAttacks) };
  const oppClub = { totalAttacks: oppTotalAttacks, wins: oppTotalWins, losses: oppTotalLosses, winRate: rate(oppTotalWins, oppTotalAttacks), defTotal: ourTotalAttacks, defWins: ourTotalLosses, defLosses: ourWins, defWinRate: counterValid ? rate(ourTotalLosses, ourTotalAttacks) : '—' };
  return { attackStats, defenseRecords, weeklyDefense, meta, ourClub, oppClub };
}
