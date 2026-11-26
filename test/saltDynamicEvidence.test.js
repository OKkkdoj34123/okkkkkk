import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { navigationMap, navigationPlan, navigationEvidence, nearestTarget, targetLegal, createRecordStore, mergeBattlefield, canRecoverLegacyTargetFailure, originEvidence } from '../src/utils/saltField/model.js';
import { sanitizeSaltDebugValue } from '../src/utils/saltField/debug.js';
import { SaltOnceRunner, runSaltBatch } from '../src/utils/saltField/runner.js';

const role = { state: 'idle', position: { x: 13, y: 23 }, legionID: 77, aB: 0, d: 0 };
const home = { '13_23': { type: 4, belongsLegionId: 77 } };
test('October 24 static-road candidates do not authorize writes without dynamic evidence', () => {
  const map = navigationMap(role, home);
  for (const id of ['12_23', '14_24']) {
    assert.equal(map[id].source, 'static-only');
    assert.equal(map[id].belongsLegionId, null);
    assert.equal(targetLegal(map[id], 77), false);
  }
  assert.throws(() => nearestTarget(role, home), e => e.code === 'SALT_NO_TARGET');
});
test('live road with missing/null/invalid ownership is never assumed neutral', () => {
  for (const owner of [undefined, null, '', {}, 'NaN']) {
    const buildings = { ...home, '12_23': { type: 9, belongsLegionId: owner } };
    assert.throws(() => nearestTarget(role, buildings), e => e.code === 'SALT_NO_TARGET');
  }
  assert.throws(() => nearestTarget(role, { ...home, '12_23': { type: 9, belongsLegionId: -1 } }), e => e.code === 'SALT_NO_TARGET');
});
test('unknown static bridge cannot expose a distant live target', () => {
  assert.throws(() => nearestTarget(role, { ...home, '11_23': { type: 9, belongsLegionId: -1 } }),
    e => e.code === 'SALT_NO_TARGET');
});
test('map identity and six raw neighbor fields survive debug depth limits', () => {
  const snapshot = { roles: {}, buildingData: {}, marches: {} };
  mergeBattlefield(snapshot, { confId: 57, legionWarMap: 13, mapName: 'legionWarMap', type: 15,
    buildingData: { ...home, '12_23': { id: '12_23', type: 9 }, '14_24': null } });
  mergeBattlefield(snapshot, { roles: { self: role } });
  const evidence = sanitizeSaltDebugValue({ event: 'navigation.evidence',
    ...navigationEvidence(role, snapshot.buildingData, snapshot, ['12_23']) });
  assert.equal(evidence.legionWarMap, 13); assert.equal(evidence.confId, 57);
  assert.equal(evidence.neighbors.length, 6);
  const live = evidence.neighbors.find(t => t.id === '12_23');
  assert.equal(live.rawOwner, '[缺失]'); assert.equal(live.rawType, 9);
  assert.equal(live.present, true); assert.equal(live.excluded, true);
  assert.equal(evidence.neighbors.find(t => t.id === '14_24').deleted, true);
});

function scenario({ buildings = home, failure, initial } = {}) {
  const data = new Map(), records = createRecordStore({ getItem: k => data.get(k) || null, setItem: (k, v) => data.set(k, v) });
  if (initial) records.save(initial);
  let time = 1;
  const sent = [], updates = [], signal = new AbortController().signal;
  const session = { battlefieldId: 'bf', roleCodeId: 'self', role,
    snapshot: { buildingData: buildings }, refresh: async () => role, close() {},
    send: async (cmd, params) => { sent.push({ cmd, params }); if (cmd === 'war_startmarch' && failure) throw failure; } };
  const make = () => new SaltOnceRunner({ tokenId: 'offline', signal, records, connect: async () => session,
    now: () => time, sleep: async ms => { time += Math.max(0, ms); }, onUpdate: r => updates.push(r) });
  return { make, sent, signal, updates };
}
test('sparse map performs no march or attack and reports only this round without new submissions', async () => {
  const h = scenario(), r = h.make(); await runSaltBatch([r], h.signal);
  assert.equal(h.sent.some(e => ['war_startmarch', 'war_startattackbuilding'].includes(e.cmd)), false);
  assert.equal(r.record.state, 'failed'); assert.equal(r.record.target, null);
  assert.match(r.record.error, /本轮未提交新行军/);
  assert.equal(r.record.navigationDiagnostic.neighbors.length, 6);
});
test('explicit rejection clears active target while retaining exact request history across restart', async () => {
  const h = scenario({ buildings: { ...home, '12_23': { type: 1, belongsLegionId: -1 } },
    failure: Object.assign(new Error('服务器拒绝'), { serverRejected: true, code: 200020,
      serverResponse: { resp: 7, seq: 22, code: 200020 } }) });
  const r = h.make(); await runSaltBatch([r], h.signal);
  assert.equal(h.sent.filter(e => e.cmd === 'war_startmarch').length, 1);
  assert.equal(r.record.target, null); assert.equal(r.record.marchIntentAt, null);
  assert.equal(r.record.marchAccepted, false);
  assert.equal(r.record.marchRejections[0].target.buildingId, '12_23');
  assert.equal(r.record.marchRejections[0].response.resp, 7);
  assert.match(r.record.error, /此前已拒绝：12_23\(错误码200020\)/);
  assert.equal(h.updates.some(u => u.state === 'marching'), false);
  const count = h.sent.length; await runSaltBatch([h.make()], h.signal); assert.equal(h.sent.length, count);
});
test('ambiguous march failure retains intent and cannot send a second march', async () => {
  const h = scenario({ buildings: { ...home, '12_23': { type: 1, belongsLegionId: -1 } }, failure: new Error('timeout') });
  const r = h.make(); await runSaltBatch([r], h.signal);
  assert.equal(h.sent.filter(e => e.cmd === 'war_startmarch').length, 1);
  assert.ok(r.record.marchIntentAt); assert.equal(r.record.target.buildingId, '12_23');
  assert.equal(r.record.marchRejections, undefined);
});
test('version 2 exhausted rejection records are not automatically rearmed by version 3', async () => {
  const h = scenario({ initial: { tokenId: 'offline', battlefieldId: 'bf', roleCodeId: 'self',
    navigationVersion: 2, state: 'failed', attempts: 3, excluded: ['12_23', '14_24'],
    teamReady: true, teamApplied: true, target: { x: 14, y: 24, buildingId: '14_24' },
    error: '没有找到可达的非己方地块；未发送行军/攻击' } });
  const r = h.make(); await runSaltBatch([r], h.signal);
  assert.equal(h.sent.length, 0); assert.equal(r.record.attempts, 3);
});

// Real map projection from the uploaded 2026-11-14 snapshot. The responses in
// the runner scenarios below are synthetic, not evidence of a successful live march.
const actual = JSON.parse(readFileSync(new URL('./fixtures/salt-navigation-20261114.json', import.meta.url)));
test('November 14 map finds three live buildings through missing dynamic roads, not road targets', () => {
  const { role, buildingData, metadata } = actual;
  assert.equal(Object.keys(buildingData).length, 99);
  assert.throws(() => nearestTarget(role, buildingData), e => e.code === 'SALT_NO_TARGET');
  const plan = navigationPlan(role, buildingData, [], metadata);
  assert.deepEqual(plan.candidates.map(c => [c.buildingId, c.path]), [
    ['26_20', ['26_22', '25_21', '25_20', '26_20']],
    ['26_25', ['26_22', '26_23', '26_24', '26_25']],
    ['28_24', ['26_22', '26_23', '27_23', '28_24']],
  ]);
  assert.ok(plan.candidates.every(c => c.type === 1 && c.reachability === 'pending-server'));
  assert.ok(plan.inspected.find(t => t.id === '25_21').traversable);
  assert.equal(nearestTarget(role, buildingData, ['26_20'], metadata).buildingId, '26_25');
  assert.throws(() => nearestTarget(role, buildingData, [], { ...metadata, legionWarMap: 99 }), e => e.code === 'SALT_NO_TARGET');
  const deleted = { ...buildingData, '25_21': null, '26_23': null };
  assert.throws(() => nearestTarget(role, deleted, [], metadata), e => e.code === 'SALT_NO_TARGET');
  const missingOwner = structuredClone(buildingData); delete missingOwner['26_20'].belongsLegionId;
  assert.equal(nearestTarget(role, missingOwner, [], metadata).buildingId, '26_25');
});

const roadFailure = () => ({ tokenId: 'offline', battlefieldId: 'fixture', roleCodeId: 'self',
  state: 'failed', attempts: 3, navigationVersion: 3, excluded: [], target: null,
  teamSelected: true, teamApplied: true, teamReady: true, teamIntentAt: 1,
  error: '未找到动态地图确认且归属明确的可达目标；本轮未提交新行军/攻击；位置=26_22' });
function roadScenario({ reject = 0, ambiguous = false, captured = false } = {}) {
  const data = new Map(), records = createRecordStore({ getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) });
  records.save(roadFailure());
  const role = structuredClone(actual.role), buildings = structuredClone(actual.buildingData), calls = [], trace = [];
  let time = 1000, march, rejections = 0, capturedOnce = false;
  const signal = new AbortController().signal;
  const make = () => new SaltOnceRunner({ tokenId: 'offline', records, signal,
    now: () => time, sleep: async ms => { time += Math.max(0, ms); },
    diagnostic: { record: (event, detail) => trace.push({ event, ...structuredClone(detail) }) },
    connect: async () => ({ battlefieldId: 'fixture', roleCodeId: 'self', get role() { return role; },
      snapshot: { ...actual.metadata, buildingData: buildings }, close() {},
      async refresh() {
        if (march && time >= march.at + 120000) {
          Object.assign(role, { state: 'idle', position: march.target });
          if (captured && !capturedOnce) { buildings[`${march.target.x}_${march.target.y}`].belongsLegionId = 7; capturedOnce = true; }
        }
        return role;
      },
      async send(cmd, params) {
        calls.push({ cmd, params });
        if (cmd === 'war_startmarch') {
          if (ambiguous) throw new Error('synthetic timeout with no confirmed state');
          if (rejections++ < reject) throw Object.assign(new Error('synthetic rejection'), { code: 12345, serverRejected: true });
          march = { target: params.target, at: time }; role.state = 'march';
        }
        if (cmd === 'war_startattackbuilding') role.aB++;
        return {};
      },
    }) });
  return { make, calls, trace, signal, records };
}
test('old pre-march failure recovers once, two explicit rejections select the third building, one attack completes', async () => {
  const h = roadScenario({ reject: 2 }), r = h.make(); await runSaltBatch([r], h.signal);
  assert.deepEqual(h.calls.filter(c => c.cmd === 'war_startmarch').map(c => c.params.target), [{x:26,y:20},{x:26,y:25},{x:28,y:24}]);
  assert.deepEqual(h.calls.filter(c => c.cmd === 'war_startattackbuilding').map(c => c.params.buildingId), ['28_24']);
  assert.equal(h.calls.some(c => /setbattleteam|invite|speedup/.test(c.cmd)), false);
  assert.equal(r.record.state, 'completed'); assert.equal(r.record.targetingRecoveryVersion, 4);
  assert.equal(r.record.marchRejections.length, 2); assert.equal(r.record.legacyFailure.navigationVersion, 3);
  for (const event of ['navigation.candidates', 'march.accepted', 'march.arrival.check', 'attack.intent.saved', 'attack.accepted', 'attack.settlement.check'])
    assert.ok(h.trace.some(e => e.event === event), event);
  assert.equal(h.trace.find(e => e.event === 'navigation.candidates').candidates.length, 3);
  const count = h.calls.length; await runSaltBatch([h.make()], h.signal); assert.equal(h.calls.length, count);
  for (const change of [{ marchIntentAt: 1 }, { marchRejections: [{}] }, { attackIntentAt: 1 },
    { navigationVersion: 4 }, { state: 'unknown' }, { state: 'completed' }, { targetingRecoveryVersion: 4 }])
    assert.equal(canRecoverLegacyTargetFailure({ ...roadFailure(), ...change }, actual.role), false);
});
test('unknown march result preserves intent and never switches candidate on restart', async () => {
  const h = roadScenario({ ambiguous: true }), r = h.make(); await runSaltBatch([r], h.signal);
  assert.equal(r.record.state, 'unknown'); assert.ok(r.record.marchIntentAt);
  assert.equal(h.calls.length, 1); assert.equal(r.record.target.buildingId, '26_20');
  await runSaltBatch([h.make()], h.signal); assert.equal(h.calls.length, 1);
});
test('a candidate captured by own legion before arrival is not attacked; the next target is reselected', async () => {
  const h = roadScenario({ captured: true }), r = h.make(); await runSaltBatch([r], h.signal);
  assert.equal(r.record.state, 'completed');
  const attacks = h.calls.filter(c => c.cmd === 'war_startattackbuilding');
  assert.equal(attacks.length, 1); assert.notEqual(attacks[0].params.buildingId, '26_20');
  assert.ok(h.trace.some(e => e.event === 'attack.target.recheck' && !e.legal));
});

test('origin evidence covers all 20 homes and optional stronghold fields never block movement from the current tile', () => {
  const { role, buildingData, metadata } = actual;
  const homes = Object.values(buildingData).filter(t => t.type === 4);
  assert.equal(homes.length, 20);
  for (const home of homes) {
    const [x, y] = home.id.split('_').map(Number);
    const current = { ...role, position: { x, y }, legionID: home.belongsLegionId };
    const plan = navigationPlan(current, buildingData, [], metadata);
    assert.equal(plan.origin.atOwnStronghold, true, home.id);
    assert.ok(plan.candidates.length > 0, home.id);
    assert.ok(plan.candidates.every(c => c.path[0] === home.id), home.id);
  }
  const snapshot = { ...metadata, roles: {}, buildingData: structuredClone(buildingData), marches: {} };
  mergeBattlefield(snapshot, { legions: { 7: { id: 7, strongholdId: '26_22', name: 'PRIVATE', members: ['PRIVATE'] } } });
  mergeBattlefield(snapshot, { legions: { 7: { point: 1 } } });
  assert.deepEqual(snapshot.legions[7], { id: 7, strongholdId: '26_22' });
  let evidence = originEvidence(role, buildingData, snapshot);
  assert.equal(evidence.reported[0].matchesCurrentPosition, true);
  assert.equal(evidence.reported[0].matchesOwnedBase, true);
  const away = { ...role, position: { x: 26, y: 20 } };
  const plan = navigationPlan(away, buildingData, [], snapshot);
  assert.equal(plan.origin.atOwnStronghold, false);
  assert.equal(plan.origin.reported[0].matchesCurrentPosition, false);
  assert.ok(plan.candidates.length > 0);
  mergeBattlefield(snapshot, { legions: { 7: { strongholdId: null } } });
  evidence = originEvidence(role, buildingData, snapshot);
  assert.equal(evidence.reported[0].valueValid, false);
  assert.equal(nearestTarget(role, buildingData, [], snapshot).buildingId, '26_20');
});

test('15-account batch balances identical candidates 5/5/5, isolates battlefields/legions and counts duplicate roles once', async () => {
  const values = new Map(), records = createRecordStore({ getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) });
  let now = 1000;
  const roles = new Map(), calls = [], signal = new AbortController().signal;
  function make(id, { battlefieldId = 'fixture', legionId = 7, alias = false } = {}) {
    const key = `${battlefieldId}:${id}`;
    if (!roles.has(key)) roles.set(key, { role: { ...structuredClone(actual.role), legionID: legionId }, march: null });
    const state = roles.get(key);
    return new SaltOnceRunner({ tokenId: alias ? `${id}-alias` : id, records, signal, now: () => now,
      sleep: async ms => { now += Math.max(0, ms); },
      connect: async () => ({ battlefieldId, roleCodeId: id, get role() { return state.role; },
        snapshot: { ...actual.metadata, buildingData: actual.buildingData }, close() {},
        async refresh() {
          if (state.march && now >= state.march.at + 120000) Object.assign(state.role, { state: 'idle', position: state.march.target });
          return state.role;
        },
        async send(cmd, params) {
          calls.push({ id, battlefieldId, legionId, cmd, params });
          if (cmd === 'war_startmarch') { state.march = { at: now, target: params.target }; state.role.state = 'march'; }
          if (cmd === 'war_startattackbuilding') state.role.aB++;
          return {};
        },
      }) });
  }
  const runners = Array.from({ length: 15 }, (_, i) => make(String(i)));
  runners.splice(1, 0, make('0', { alias: true }));
  // After 14 unique accounts counts are 5/5/4. Other scopes must still choose the first target.
  runners.splice(15, 0, make('other-field', { battlefieldId: 'other' }), make('other-legion', { legionId: 8 }));
  await runSaltBatch(runners, signal);
  const mainMarches = calls.filter(c => c.cmd === 'war_startmarch' && c.battlefieldId === 'fixture' && c.legionId === 7);
  const counts = {};
  for (const call of mainMarches) { const p = call.params.target, key = `${p.x}_${p.y}`; counts[key] = (counts[key] || 0) + 1; }
  assert.deepEqual(counts, { '26_20': 5, '26_25': 5, '28_24': 5 });
  assert.equal(calls.filter(c => c.cmd === 'war_startattackbuilding' && c.battlefieldId === 'fixture' && c.legionId === 7).length, 15);
  for (const id of ['other-field', 'other-legion']) assert.deepEqual(calls.find(c => c.id === id && c.cmd === 'war_startmarch').params.target, { x: 26, y: 20 });
  assert.ok(runners.every(r => r.record.state === 'completed'));
  const count = calls.length; await runSaltBatch(runners, signal); assert.equal(calls.length, count);
});

test('soft assignment releases explicit rejection, retains unknown intent, and does not prefer a farther target', async () => {
  const assignments = new Map(), h = roadScenario({ reject: 2 }), r = h.make(); r.targetAssignments = assignments;
  await r.phase('prepare');
  assert.equal(assignments.size, 1); assert.equal([...assignments.values()][0].buildingId, '28_24');
  const unknown = roadScenario({ ambiguous: true }), u = unknown.make(); u.targetAssignments = new Map();
  await u.phase('prepare'); assert.equal(u.targetAssignments.size, 1);
  assert.equal([...u.targetAssignments.values()][0].buildingId, '26_20');
  const session = { battlefieldId: 'fixture', roleCodeId: 'another', role: actual.role };
  const candidates = navigationPlan(actual.role, actual.buildingData, [], actual.metadata).candidates;
  assert.equal(u.rankCandidates(candidates, session)[0].buildingId, '26_25');
  const farther = candidates.map(c => c.buildingId === '26_20' ? c : { ...c, distance: 4 });
  assert.equal(u.rankCandidates(farther, session)[0].buildingId, '26_20');
});
