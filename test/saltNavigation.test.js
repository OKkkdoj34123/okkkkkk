import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { roadPointList } from '../src/utils/legionWar.js';
import { navigationMap, nearestTarget, targetLegal, neighbors, mergeBattlefield,
  arrived, canRecoverLegacyTargetFailure, createRecordStore } from '../src/utils/saltField/model.js';
import { SaltOnceRunner, runSaltBatch } from '../src/utils/saltField/runner.js';
const home = { position: { x: 7, y: 4 }, legionID: 77, state: 'idle', aB: 0, d: 0 };
const sparse = { '7_4': { type: 4, belongsLegionId: 77 } };
const oldFailure = () => ({ tokenId: 'test', battlefieldId: 'bf', roleCodeId: 'role',
  state: 'failed', attempts: 3, excluded: [], teamReady: true, teamApplied: true, teamSelected: true, teamIntentAt: 1,
  error: '没有找到可达的非己方地块；未发送行军/攻击' });

test('sparse home-only map cannot authorize a static road', () => {
  assert.throws(() => nearestTarget(home, sparse), e => e.code === 'SALT_NO_TARGET');
  const tile = navigationMap(home, sparse)['8_5'];
  assert.equal(tile.source, 'static-only');
  assert.equal(tile.belongsLegionId, null); assert.equal(targetLegal(tile, 77), false);
});
test('all shipped homes reject unconfirmed static neighbors', () => {
  const homes = roadPointList.filter(t => t.type === 4); assert.equal(homes.length, 20);
  for (const tile of homes) {
    const [x, y] = tile.id.split('_').map(Number);
    assert.throws(() => nearestTarget({ ...home, position: { x, y } }, { [tile.id]: { type: 4, belongsLegionId: 77 } }),
      e => e.code === 'SALT_NO_TARGET', tile.id);
  }
});
test('missing or zero dynamic type cannot borrow unverified map geometry', () => {
  for (const type of [undefined, null, 0]) {
    assert.throws(() => nearestTarget(home, { ...sparse, '8_5': { type, belongsLegionId: 88 } }),
      e => e.code === 'SALT_NO_TARGET');
  }
});
test('live roads are transit only and lead to a live building', () => {
  const buildings = { ...sparse, '8_5': { type: 9, belongsLegionId: 77 }, '9_5': { type: 1, belongsLegionId: -1 } };
  const map = navigationMap(home, buildings);
  assert.equal(targetLegal(map['8_5'], 77), false);
  const target = nearestTarget(home, buildings);
  assert.equal(target.buildingId, '9_5'); assert.equal(target.distance, 2);
});
test('explicit deleted road is not resurrected from static geometry', () => {
  const snapshot = { roles: {}, buildingData: { ...sparse, '8_5': { type: 1, belongsLegionId: -1 } }, marches: {} };
  mergeBattlefield(snapshot, { buildingData: { '8_5': null } });
  assert.equal(snapshot.buildingData['8_5'], null);
  assert.equal(navigationMap(home, snapshot.buildingData)['8_5'], undefined);
  assert.throws(() => nearestTarget(home, snapshot.buildingData), /未找到动态地图确认/);
});
test('missing ownership on static strongholds is not assumed neutral', () => {
  const point = roadPointList.find(t => t.type === 1);
  assert.equal(targetLegal(navigationMap(home, sparse)[point.id], 77), false);
  assert.equal(targetLegal(navigationMap(home, { ...sparse, [point.id]: { type: point.type, belongsLegionId: 88 } })[point.id], 77), true);
});
test('unsupported dynamic type and explicit unknown ownership block a road', () => {
  assert.equal(targetLegal(navigationMap(home, { ...sparse, '8_5': { type: 6, belongsLegionId: -1 } })['8_5'], 77), false);
  assert.equal(targetLegal(navigationMap(home, { ...sparse, '8_5': { belongsLegionId: null } })['8_5'], 77), false);
});
test('new map layout can use live tiles but cannot borrow unrelated static roads', () => {
  const map = navigationMap({ ...home, position: { x: 100, y: 100 } }, { '99_100': { type: 1, belongsLegionId: -1 } });
  assert.equal(Object.keys(map).length, 1);
  assert.equal(nearestTarget({ ...home, position: { x: 100, y: 100 } }, map).buildingId, '99_100');
});
test('numeric string coordinates remain numbers on outgoing targets and arrival comparison', () => {
  const target = nearestTarget({ ...home, position: { x: '7', y: '4' } }, { ...sparse, '8_5': { type: 1, belongsLegionId: -1 } });
  assert.equal(target.x, 8); assert.equal(target.y, 5);
  assert.ok(arrived({ state: 'idle', position: { x: '8', y: '5' } }, target));
});
test('no dynamic map or invalid IDs cannot trigger purely speculative movement', () => {
  assert.throws(() => nearestTarget(home, {}), /动态地图为空/);
  assert.throws(() => nearestTarget(home, { bad: {} }), /有效坐标/);
  assert.throws(() => nearestTarget(home, { '7_4': { id: '8_5' } }), /冲突/);
});
test('a road is never selected instead of an adjacent building', () => {
  const role = { ...home, position: { x: 100, y: 100 } };
  assert.equal(nearestTarget(role, { '99_100': { type: 1, belongsLegionId: 88 }, '99_99': { type: 9, belongsLegionId: -1 } }).buildingId, '99_100');
});
test('no-target error carries bounded position/map/neighbor diagnostics', () => {
  assert.throws(() => nearestTarget(home, { ...sparse, '8_5': null }), error => error.code === 'SALT_NO_TARGET'
    && /位置=7_4/.test(error.message) && /动态=2/.test(error.message) && /邻格/.test(error.message));
});
test('legacy pre-march failure is eligible only after fresh idle state; timeout is separately recoverable', () => {
  assert.ok(canRecoverLegacyTargetFailure(oldFailure(), home));
  assert.ok(canRecoverLegacyTargetFailure({ ...oldFailure(), error: '请求超时: legion_getbattlefield (10000ms)' }, home));
  assert.equal(canRecoverLegacyTargetFailure(oldFailure(), { ...home, state: 'march' }), false);
  assert.equal(canRecoverLegacyTargetFailure({ ...oldFailure(), teamApplied: false }, home), false);
  assert.equal(canRecoverLegacyTargetFailure({ ...oldFailure(), error: '其他错误' }, home), false);
});
test('any movement/attack evidence or completed/unknown state permanently forbids automatic budget reset', () => {
  for (const change of [{ target: { x: 8, y: 5 } }, { marchIntentAt: 1 }, { marchStartedAt: 1 },
    { marchAccepted: true }, { attackIntentAt: 1 }, { attackAcceptedAt: 1 }, { beforeAttack: { aB: 0 } },
    { excluded: ['8_5'] }, { state: 'unknown' }, { state: 'completed' }, { navigationVersion: 2 }, { targetingRecoveryVersion: 2 }]) {
    assert.equal(canRecoverLegacyTargetFailure({ ...oldFailure(), ...change }, home), false, JSON.stringify(change));
  }
});
function scenario(record, rejectMarch = false) {
  const data = new Map(), storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const records = createRecordStore(storage); if (record) records.save(record);
  const signal = new AbortController().signal, calls = [], role = structuredClone(home);
  let now = 100, marchedAt, target;
  const connect = async () => ({
    battlefieldId: 'bf', roleCodeId: 'role', snapshot: { buildingData: { ...sparse, '8_5': { type: 1, belongsLegionId: -1 } } }, get role() { return role; }, close() {},
    async refresh() {
      if (marchedAt && now >= marchedAt + 120000) Object.assign(role, { position: target, state: 'idle' });
      return role;
    },
    async send(cmd, params) {
      calls.push(cmd);
      if (cmd === 'war_startmarch') {
        if (rejectMarch) throw Object.assign(new Error('服务器拒绝目标'), { serverRejected: true });
        marchedAt = now; target = params.target; role.state = 'march';
      }
      if (cmd === 'war_startattackbuilding') { assert.ok(now >= marchedAt + 120000); role.aB++; }
      return {};
    },
  });
  const make = () => new SaltOnceRunner({ tokenId: 'test', records, connect, signal, now: () => now,
    sleep: async ms => { now += Math.max(0, ms); } });
  return { make, calls, records, signal };
}
test('recovered account marches and attacks without redeploying; attack recheck requires dynamic confirmation', async () => {
  const h = scenario(oldFailure()), r = h.make(); await runSaltBatch([r], h.signal);
  assert.deepEqual(h.calls, ['war_startmarch', 'war_startattackbuilding']);
  assert.equal(r.record.state, 'completed'); assert.equal(r.record.legacyFailure.attempts, 3);
  assert.equal(r.record.attempts, 1); assert.equal(r.record.targetingRecoveryVersion, 4);
  await runSaltBatch([h.make()], h.signal); assert.equal(h.calls.length, 2);
});
test('repaired workflow still stops after three attempts and does not reset again on another click', async () => {
  const h = scenario(oldFailure(), true), r = h.make(); await runSaltBatch([r], h.signal);
  assert.equal(r.record.attempts, 3); assert.equal(r.record.state, 'failed');
  const count = h.calls.length; await runSaltBatch([h.make()], h.signal); assert.equal(h.calls.length, count);
  assert.equal(h.calls.includes('war_startattackbuilding'), false);
});

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/logger.js')) return { url: 'data:text/javascript,' + encodeURIComponent('const log=new Proxy({}, {get:()=>()=>{}}); export {log as wsLogger, log as gameLogger};'), shortCircuit: true };
  return next(specifier, context);
} });
const { openSaltSession } = await import('../src/utils/saltField/session.js'); hooks.deregister();
test('role-only refresh retains known tile ownership and later null deletion blocks static fallback', async () => {
  let step = 0;
  class OfflineClient {
    setMessageListener(fn) { this.listener = fn; }
    init() { this.onConnect(); }
    disconnect() {}
    async sendWithPromise(cmd) {
      if (cmd === 'war_enterbattlefield') return { roleCodeId: 'role', battlefield: { roles: { role: home }, buildingData: { ...sparse, '8_5': { type: 9, belongsLegionId: 77 } } } };
      const bf = { roles: { role: { ...home } } };
      if (++step === 2) bf.buildingData = { '8_5': null };
      return { battlefield: bf };
    }
  }
  const session = await openSaltSession({ token: 'offline', info: { sid: 1, battlefieldId: 'bf' }, signal: new AbortController().signal, Client: OfflineClient });
  assert.equal(session.snapshot.buildingData['8_5'].belongsLegionId, 77);
  assert.equal(targetLegal(navigationMap(session.role, session.snapshot.buildingData)['8_5'], 77), false);
  await session.refresh(); await session.refresh();
  assert.equal(session.snapshot.buildingData['8_5'], null);
  assert.equal(navigationMap(session.role, session.snapshot.buildingData)['8_5'], undefined);
  session.close();
});
