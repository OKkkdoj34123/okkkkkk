import { roadPointList } from '../legionWar.js';

// Field names and odd-column hex layout verified against legionWar.js and
// gterryd/xyzw-web-helper server/lib/legionWar/{saltFieldRunner,hexUtils}.js.
export const MIN_MARCH_MS = 120000;
export const MAX_ATTEMPTS = 3;
export const TEAM = Object.freeze({ '0': 107 });
export const LABELS = { pending: '待布阵', preparing: '布阵中', marching: '行军中',
  targeting: '选址中', submitting: '提交行军中',
  ready: '待攻击', fighting: '战斗中', completed: '已完成', failed: '失败',
  unknown: '待核验（禁止重攻）', stopped: '已停止' };
export function pick(obj, name, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return undefined;
  if (obj[name] !== undefined) return obj[name];
  for (const key of ['rawData', '_rawData', 'decodedBody', 'body', 'data', '_raw']) {
    const value = pick(obj[key], name, depth + 1);
    if (value !== undefined) return value;
  }
}
export function mergeBattlefield(snapshot, delta) {
  if (!delta || typeof delta !== 'object') return;
  // Keep only map identity fields, never credentials or whole protocol payloads.
  for (const field of ['id', 'confId', 'legionWarMap', 'mapName', 'type', 'subType', 'state']) {
    if (Object.prototype.hasOwnProperty.call(delta, field)) snapshot[field] = delta[field];
  }
  for (const field of ['roles', 'buildingData', 'marches']) {
    if (!delta[field] || typeof delta[field] !== 'object') continue;
    for (const [key, value] of Object.entries(delta[field])) {
      if (value === null && field === 'buildingData') snapshot[field][key] = null;
      else if (value === null) delete snapshot[field][key];
      else snapshot[field][key] = { ...snapshot[field][key], ...value };
    }
  }
  // Optional stronghold evidence only. Do not retain names/member lists or
  // require this field for navigation: live packets may omit it in deltas.
  for (const field of ['legions', 'legionInfo']) {
    if (delta[field] === null) { snapshot[field] = {}; continue; }
    if (!delta[field] || typeof delta[field] !== 'object') continue;
    snapshot[field] ||= {};
    for (const [key, value] of Object.entries(delta[field])) {
      if (value === null) { delete snapshot[field][key]; continue; }
      if (typeof value !== 'object' || Array.isArray(value)) continue;
      const fields = Object.fromEntries(['id', 'strongholdId']
        .filter(name => Object.prototype.hasOwnProperty.call(value, name)).map(name => [name, value[name]]));
      snapshot[field][key] = { ...snapshot[field][key], ...fields };
    }
  }
}
// SALT_NAVIGATION_V4: map-13 roads propose routes; the server accepts the march.
// Buildings still need live ownership. Roads are transit only, never attack targets.
export const NAVIGATION_VERSION = 4;
const baseMap = Object.fromEntries(roadPointList.map(tile => [tile.id, tile]));
const integer = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+$/.test(value))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
};
export function normalizePosition(p) {
  const x = integer(p?.x), y = integer(p?.y);
  return x == null || y == null ? null : { x, y };
}
export const positionValid = p => normalizePosition(p) !== null;
export function samePosition(a, b) {
  const first = normalizePosition(a), second = normalizePosition(b);
  return first && second ? first.x === second.x && first.y === second.y : false;
}
export const arrived = (role, target) => role?.state === 'idle' && samePosition(role.position, target);
export function neighbors(position) {
  const p = normalizePosition(position);
  if (!p) return [];
  const { x, y } = p, shift = x % 2 === 0 ? -1 : 1;
  return [[-1, 0], [-1, shift], [0, -1], [0, 1], [1, 0], [1, shift]]
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }));
}
const idOf = p => `${p.x}_${p.y}`;
const canonicalId = value => {
  if (typeof value !== 'string' || !/^-?\d+_-?\d+$/.test(value)) return null;
  const [x, y] = value.split('_').map(integer);
  return x == null || y == null ? null : `${x}_${y}`;
};
export function navigationMap(role, buildings, metadata = {}) {
  const position = normalizePosition(role?.position);
  if (!position) throw new Error('角色坐标未确认');
  if (!buildings || typeof buildings !== 'object' || !Object.keys(buildings).length) {
    throw new Error('战场动态地图为空，不能仅凭静态地图发送行军');
  }
  const live = {};
  for (const [key, value] of Object.entries(buildings)) {
    const keyId = canonicalId(key), valueId = canonicalId(value?.id);
    if (keyId && valueId && keyId !== valueId) throw new Error('地图坐标键与地块 ID 冲突');
    const id = keyId || valueId;
    if (id && (value === null || (typeof value === 'object' && !Array.isArray(value)))) live[id] = value;
  }
  if (!Object.keys(live).length) throw new Error('动态地图未识别到有效坐标 ID');
  // A known current coordinate anchors the shipped topology. Unknown map layouts
  // can still use explicit live tiles, but never borrow unrelated static roads.
  const useStatic = Boolean(baseMap[idOf(position)]);
  const useStaticRoads = useStatic && integer(metadata.legionWarMap) === 13
    && (!metadata.mapName || metadata.mapName === 'legionWarMap');
  const ids = new Set([...Object.keys(live), ...(useStatic ? Object.keys(baseMap) : [])]);
  const map = {};
  for (const id of ids) {
    const present = Object.prototype.hasOwnProperty.call(live, id);
    const dynamic = live[id], base = useStatic ? baseMap[id] : null;
    if (present && dynamic === null) continue; // explicit deletion must not be resurrected
    const dynamicType = integer(dynamic?.type);
    const type = dynamicType != null && dynamicType > 0 ? dynamicType : null;
    const owner = integer(dynamic?.belongsLegionId);
    map[id] = { id, type, belongsLegionId: owner, liveConfirmed: present,
      staticType: base?.type ?? null, source: present ? 'live' : 'static-only',
      transitRoad: type === 9 || (!present && useStaticRoads && base?.type === 9) };
  }
  return map;
}
export function targetLegal(building, legionId) {
  const owner = integer(building?.belongsLegionId), legion = integer(legionId);
  return Boolean(building?.liveConfirmed === true && [1, 2, 3, 5].includes(integer(building.type))
    && owner != null && legion != null && legion > 0 && owner !== legion);
}
export function originEvidence(role, buildings, metadata = {}) {
  const position = normalizePosition(role?.position), id = position && idOf(position), legionId = integer(role?.legionID);
  const live = Object.fromEntries(Object.entries(buildings || {}).map(([key, tile]) => [canonicalId(key) || canonicalId(tile?.id), tile]));
  const tile = live[id];
  const ownStrongholds = Object.entries(live).filter(([, t]) => integer(t?.type) === 4
    && integer(t?.belongsLegionId) === legionId).map(([key]) => key);
  const reported = [];
  for (const field of ['legions', 'legionInfo']) {
    for (const [key, legion] of Object.entries(metadata[field] || {})) {
      if (integer(key) !== legionId && integer(legion?.id) !== legionId) continue;
      if (!Object.prototype.hasOwnProperty.call(legion || {}, 'strongholdId')) continue;
      const strongholdId = canonicalId(legion.strongholdId);
      reported.push({ field, strongholdId, valueValid: strongholdId !== null,
        matchesCurrentPosition: strongholdId !== null && strongholdId === id,
        matchesOwnedBase: strongholdId !== null && ownStrongholds.includes(strongholdId) });
    }
  }
  return { source: 'role.position', positionId: id, legionId,
    currentType: integer(tile?.type), currentOwner: integer(tile?.belongsLegionId),
    atOwnStronghold: ownStrongholds.includes(id), ownStrongholds, reported,
    strongholdEvidence: reported.length ? 'reported-see-comparison' : 'not-provided',
    note: '当前角色坐标是寻路起点；大本营信息用于交叉核对，不因可选字段缺失或已离营而阻断' };
}
export function navigationPlan(role, buildings, excluded = [], metadata = {}) {
  const start = normalizePosition(role?.position);
  if (!start || !(integer(role?.legionID) > 0)) throw new Error('角色坐标或军团 ID 未确认');
  const map = navigationMap(role, buildings, metadata), queue = [{ ...start, path: [idOf(start)] }];
  const seen = new Set([idOf(start)]), denied = new Set(excluded);
  const candidates = [], inspected = [];
  for (let i = 0; i < queue.length; i++) {
    for (const next of neighbors(queue[i])) {
      const id = idOf(next), tile = map[id];
      if (seen.has(id)) continue;
      seen.add(id);
      const path = [...queue[i].path, id], distance = path.length - 1;
      const friendly = tile?.liveConfirmed && [1, 2, 3, 5].includes(tile.type)
        && tile.belongsLegionId === Number(role.legionID);
      const traversable = Boolean(tile?.transitRoad || friendly);
      const legal = !denied.has(id) && targetLegal(tile, role.legionID);
      const reasons = [];
      if (!tile) reasons.push('absent-or-deleted');
      else if (tile.transitRoad) reasons.push(tile.liveConfirmed ? 'live-road-transit' : 'static-road-transit');
      else {
        if (!tile.liveConfirmed) reasons.push('building-not-in-dynamic-map');
        if (![1, 2, 3, 5].includes(tile.type)) reasons.push('type-missing-or-not-allowed');
        if (tile.belongsLegionId == null) reasons.push('owner-missing-or-invalid');
        if (friendly) reasons.push('friendly');
      }
      if (denied.has(id)) reasons.push('previously-excluded');
      inspected.push({ id, from: queue[i].path.at(-1), distance, tile, reasons, legal, traversable });
      if (legal) candidates.push({ ...next, id, buildingId: id, distance, path,
        type: tile.type, source: tile.source, belongsLegionId: tile.belongsLegionId,
        routeSource: path.some(cell => map[cell]?.source === 'static-only') ? 'static-roads' : 'live',
        reachability: 'pending-server' });
      // Never traverse a neutral/enemy building to invent a more distant target.
      if (traversable) queue.push({ ...next, path });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance
    || Number(b.belongsLegionId === -1) - Number(a.belongsLegionId === -1)
    || a.x - b.x || a.y - b.y);
  return { navigationVersion: NAVIGATION_VERSION, start, legionID: role.legionID,
    origin: originEvidence(role, buildings, metadata),
    mapId: metadata.legionWarMap ?? null, staticRoadsEnabled: Object.values(map).some(t => t.source === 'static-only' && t.transitRoad),
    candidates, inspected, dynamicCount: Object.keys(buildings).length, mergedCount: Object.keys(map).length,
    note: '道路只用于推导候选路径；候选为实时非己方据点；可达性由行军响应确认' };
}
export function nearestTarget(role, buildings, excluded = [], metadata = {}) {
  const plan = navigationPlan(role, buildings, excluded, metadata);
  if (plan.candidates.length) return plan.candidates[0];
  const start = plan.start, map = navigationMap(role, buildings, metadata);
  const adjacent = neighbors(start).map(p => {
    const id = idOf(p), tile = map[id];
    return tile ? `${id}(${tile.source},type=${tile.type ?? '?'},归属=${tile.belongsLegionId ?? '?'})` : `${id}(无地块)`;
  }).join('、');
  const error = new Error(`未找到动态地图确认且归属明确的候选据点；本轮未提交新行军/攻击；位置=${idOf(start)}，动态=${plan.dynamicCount}，合并=${plan.mergedCount}，静态道路=${plan.staticRoadsEnabled ? '已启用' : '未启用'}；邻格：${adjacent}`);
  error.code = 'SALT_NO_TARGET';
  throw error;
}
export function canRecoverLegacyTargetFailure(record, role) {
  const legacy = record && (record.navigationVersion ?? 1) < 2 && !(record.targetingRecoveryVersion >= 2);
  const blockedRoads = record?.navigationVersion === 3
    && /^未找到动态地图确认且归属明确的可达目标；本轮未提交新行军\/攻击/.test(record.error || '');
  // Only the known pre-march v1/v3 failures can recover once. Never erase a sent intent.
  if (!record || (!legacy && !blockedRoads) || record.targetingRecoveryVersion >= NAVIGATION_VERSION
    || record.state !== 'failed' || record.attempts !== MAX_ATTEMPTS
    || record.teamReady !== true || record.teamApplied !== true
    || role?.state !== 'idle' || !positionValid(role.position)) return false;
  // Do not reset any account that may have sent a march/attack, including an
  // explicitly rejected attack whose intent has since been cleared.
  if (record.target != null || record.marchIntentAt != null || record.marchStartedAt != null || record.marchAccepted
    || record.attackIntentAt != null || record.attackAcceptedAt != null || record.beforeAttack != null
    || record.finishedAt != null || record.proof != null || record.afterAttack != null
    || record.excluded?.length || record.marchRejections?.length) return false;
  return blockedRoads || record.error === '没有找到可达的非己方地块；未发送行军/攻击'
    || /(?:请求超时|timeout).*legion_getbattlefield/i.test(record.error || '');
}
// Six neighbors only, raw scalar fields at a shallow depth so debug sanitizing
// preserves the evidence without logging the full battlefield or other players.
export function navigationEvidence(role, buildings = {}, metadata = {}, excluded = []) {
  const position = normalizePosition(role?.position);
  const map = position && Object.keys(buildings).length ? navigationMap(role, buildings, metadata) : {};
  const scalar = value => value === undefined ? '[缺失]' : value === null ? '[null]'
    : ['string', 'number', 'boolean'].includes(typeof value) ? value : `[${typeof value}]`;
  const live = {};
  for (const [key, value] of Object.entries(buildings)) {
    const id = canonicalId(key) || canonicalId(value?.id);
    if (id) live[id] = value;
  }
  return {
    navigationVersion: NAVIGATION_VERSION,
    confId: scalar(metadata.confId), legionWarMap: scalar(metadata.legionWarMap),
    mapName: scalar(metadata.mapName), battlefieldType: scalar(metadata.type),
    dynamicCount: Object.keys(live).length, mergedCount: Object.keys(map).length,
    neighbors: neighbors(position).map(p => {
      const id = idOf(p), raw = live[id], tile = map[id];
      return { id, present: Object.prototype.hasOwnProperty.call(live, id), deleted: raw === null,
        rawId: scalar(raw?.id), rawType: scalar(raw?.type), rawOwner: scalar(raw?.belongsLegionId),
        rawKeys: raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 12).join(',') : '',
        source: tile?.source ?? 'absent', staticType: tile?.staticType ?? null,
        traversableRoad: Boolean(tile?.transitRoad),
        legal: targetLegal(tile, role?.legionID), excluded: excluded.includes(id) };
    }),
  };
}
export function counters(role) {
  const result = {};
  for (const field of ['aB', 'd', 'killCnt']) {
    if (typeof role?.[field] === 'number' && Number.isFinite(role[field]) && role[field] >= 0) result[field] = role[field];
  }
  return result;
}
// A command acknowledgement, elapsed time, changed building owner, or idle alone
// is NOT completion evidence. Require this role's counter advancement + terminal state.
// Settlement timing of aB/d must still be verified on a real test account.
export function settlementEvidence(record, role) {
  if (!record.attackIntentAt || !record.beforeAttack || !role) return null;
  const before = record.beforeAttack, after = counters(role);
  if (role.state === 'over' && after.d > before.d) return '个人死亡次数增加且角色已死亡';
  if (role.state === 'idle' && after.aB > before.aB) return '个人刨地次数增加且角色已空闲';
  return null;
}
export function createRecordStore(storage) {
  const key = 'xyzw_salt_once_v1';
  const read = () => {
    if (!storage) throw new Error('本地记录存储不可用，禁止执行');
    const data = JSON.parse(storage.getItem(key) || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('盐场记录损坏，禁止执行');
    return data;
  };
  return {
    get(battlefieldId, roleCodeId) {
      const record = read()[JSON.stringify([String(battlefieldId), String(roleCodeId)])];
      if (record && (!Number.isInteger(record.attempts) || record.attempts < 1 || record.attempts > MAX_ATTEMPTS
        || !Array.isArray(record.excluded) || !LABELS[record.state]
        || String(record.battlefieldId) !== String(battlefieldId) || String(record.roleCodeId) !== String(roleCodeId))) {
        throw new Error('盐场账号记录格式异常，禁止执行');
      }
      return record;
    },
    save(record) {
      const data = read();
      data[JSON.stringify([String(record.battlefieldId), String(record.roleCodeId)])] = { ...record };
      storage.setItem(key, JSON.stringify(data)); // Must succeed before any mutating command.
    },
  };
}
