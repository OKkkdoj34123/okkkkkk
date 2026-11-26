import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_MARCH_MS, arrived, createRecordStore, mergeBattlefield, nearestTarget, neighbors, settlementEvidence } from '../src/utils/saltField/model.js';
import { SaltOnceRunner, runSaltBatch, wait } from '../src/utils/saltField/runner.js';
function memory() { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) }; }
function harness(options = {}) {
  let time = 1000, active = 0, peak = 0;
  const events = [], controller = new AbortController(), records = createRecordStore(memory());
  const roles = {}, sent = {}, marches = {};
  const sleep = async (ms, signal) => { if (signal.aborted) throw new Error('stopped'); time += Math.max(0, ms); };
  function make(id) {
    roles[id] ||= { state: 'watching', position: { x: 2, y: 2 }, legionID: 7, aB: 0, d: 0 };
    sent[id] ||= [];
    const connect = async () => {
      events.push(`connect:${id}`); active++; peak = Math.max(peak, active);
      let closed = false;
      const close = () => { if (!closed) { active--; closed = true; events.push(`close:${id}`); } };
      const refresh = async () => {
        events.push(`refresh:${id}`);
        if (marches[id] && time >= marches[id].at + MIN_MARCH_MS && !options.neverArrive) Object.assign(roles[id], { state: 'idle', position: { ...marches[id].target } });
        return roles[id];
      };
      return { close, refresh, battlefieldId: 'bf1', roleCodeId: id,
        get role() { return roles[id]; },
        snapshot: { roles: {}, marches: {}, buildingData: {
          '1_2': { type: 1, belongsLegionId: -1 }, '1_1': { type: 1, belongsLegionId: -1 }, '2_1': { type: 1, belongsLegionId: -1 },
        } },
        async send(cmd, params) {
          sent[id].push(cmd); events.push(`${cmd}:${id}`);
          if (cmd === 'war_teamsetbattleteam') assert.deepEqual(params.battleTeam, { '0': 107 });
          if (cmd === 'war_setbattleteam') roles[id].state = 'idle';
          if (cmd === 'war_startmarch') {
            marches[id] = { at: time, target: params.target }; roles[id].state = 'march';
            if (options.marchTimeout) throw new Error('请求超时');
          }
          if (cmd === 'war_startattackbuilding') {
            assert.ok(time >= marches[id].at + MIN_MARCH_MS, 'must wait per-account 120 seconds');
            assert.ok(arrived(roles[id], marches[id].target), 'must actually arrive');
            if (options.rejectAttack) throw Object.assign(new Error('服务器明确拒绝'), { serverRejected: true });
            if (!options.noSettlement) {
              if (options.lose) { roles[id].d++; roles[id].state = 'over'; delete marches[id]; }
              else roles[id].aB++;
            }
            if (options.attackTimeout) throw new Error('请求超时');
          }
          return {};
        },
      };
    };
    return new SaltOnceRunner({ tokenId: id, records, connect, signal: controller.signal, now: () => time, sleep });
  }
  return { make, controller, records, events, roles, sent, marches, get peak() { return peak; }, get active() { return active; }, get time() { return time; } };
}
test('hex parity and nearest ordinary tile, excluding friendly/home/core', () => {
  assert.ok(neighbors({ x: 2, y: 2 }).some(p => p.x === 1 && p.y === 1));
  assert.ok(neighbors({ x: 3, y: 2 }).some(p => p.x === 2 && p.y === 3));
  assert.equal(nearestTarget({ position: { x: 2, y: 2 }, legionID: 7 }, { '1_2': { type: 4, belongsLegionId: 8 }, '1_1': { type: 9, belongsLegionId: 7 }, '2_1': { type: 1, belongsLegionId: -1 } }).buildingId, '2_1');
});
test('snapshot deltas merge and delete null entries', () => {
  const s = { roles: { a: { aB: 2, state: 'march' }, b: { d: 1 } }, buildingData: {}, marches: { m: {} } };
  mergeBattlefield(s, { roles: { a: { state: 'idle' }, b: null }, marches: { m: null } });
  assert.deepEqual(s.roles, { a: { aB: 2, state: 'idle' } }); assert.deepEqual(s.marches, {});
});
test('all accounts march and disconnect before any attack, only one active connection', async () => {
  const h = harness(), runners = ['A', 'B', 'C'].map(id => h.make(id));
  await runSaltBatch(runners, h.controller.signal);
  assert.equal(h.peak, 1); assert.equal(h.active, 0);
  assert.ok(h.events.indexOf('close:C') < h.events.indexOf('war_startattackbuilding:A'));
  for (const r of runners) assert.equal(r.record.state, 'completed');
});
test('120 seconds is not arrival', async () => {
  const h = harness({ neverArrive: true }), r = h.make('A'); await runSaltBatch([r], h.controller.signal);
  assert.equal(h.sent.A.filter(c => c === 'war_startattackbuilding').length, 0);
  assert.equal(r.record.attempts, 3); assert.equal(r.record.state, 'failed');
});
test('ack without settlement is unknown, including after restart', async () => {
  const h = harness({ noSettlement: true }), r = h.make('A'); await runSaltBatch([r], h.controller.signal);
  assert.equal(r.record.state, 'unknown'); const resumed = h.make('A'); await runSaltBatch([resumed], h.controller.signal);
  assert.equal(h.sent.A.filter(c => c === 'war_startattackbuilding').length, 1); assert.equal(resumed.record.state, 'unknown');
});
test('lost attack reply with settlement succeeds without reattack', async () => {
  const h = harness({ attackTimeout: true }), r = h.make('A'); await runSaltBatch([r], h.controller.signal);
  assert.equal(r.record.state, 'completed'); assert.equal(h.sent.A.filter(c => c === 'war_startattackbuilding').length, 1);
});
test('defeat counts as completion', async () => {
  const h = harness({ lose: true }), r = h.make('A'); await runSaltBatch([r], h.controller.signal); assert.equal(r.record.state, 'completed');
});
test('three total attempts for explicit rejection, persistent limit', async () => {
  const h = harness({ rejectAttack: true }), r = h.make('A'); await runSaltBatch([r], h.controller.signal);
  assert.equal(h.sent.A.filter(c => c === 'war_startattackbuilding').length, 3);
  assert.equal(r.record.attempts, 3); assert.equal(r.record.state, 'failed');
  await runSaltBatch([h.make('A')], h.controller.signal); assert.equal(h.sent.A.filter(c => c === 'war_startattackbuilding').length, 3);
});
test('march timeout reconciles without remarch', async () => {
  const h = harness({ marchTimeout: true }), r = h.make('A'); await runSaltBatch([r], h.controller.signal);
  assert.equal(r.record.state, 'completed'); assert.equal(h.sent.A.filter(c => c === 'war_startmarch').length, 1);
});
test('completed battlefield skips writes after restart', async () => {
  const h = harness(), r = h.make('A'); await runSaltBatch([r], h.controller.signal); const count = h.sent.A.length;
  await runSaltBatch([h.make('A')], h.controller.signal); assert.equal(h.sent.A.length, count);
});
test('battlefield change on reconnect blocks attack', async () => {
  const h = harness(), r = h.make('A'); await r.phase('prepare');
  const old = r.connect; r.connect = async (...args) => ({ ...await old(...args), battlefieldId: 'bf2' });
  await r.phase('attack'); assert.equal(r.record.state, 'failed');
  assert.equal(h.sent.A.filter(c => c === 'war_startattackbuilding').length, 0); assert.equal(h.active, 0);
});
test('resume after march does not redeploy', async () => {
  const h = harness(), r = h.make('A'); await r.phase('prepare'); const resumed = h.make('A'); await runSaltBatch([resumed], h.controller.signal);
  assert.equal(resumed.record.state, 'completed'); assert.equal(h.sent.A.filter(c => c === 'war_setbattleteam').length, 1);
});
test('idle alone or missing counters is not settlement', () => {
  const r = { attackIntentAt: 1, beforeAttack: { aB: 1, d: 0 } };
  assert.equal(settlementEvidence(r, { state: 'idle', aB: 1, d: 0 }), null);
  assert.equal(settlementEvidence(r, { state: 'march', aB: 2, d: 0 }), null);
  assert.equal(settlementEvidence(r, { state: 'idle' }), null);
});
test('storage failure prevents mutation', async () => {
  const h = harness(), r = h.make('A'); r.records = createRecordStore({ getItem: () => '{}', setItem: () => { throw new Error('quota'); } });
  await assert.rejects(r.phase('prepare'), /quota/); assert.equal(h.sent.A.length, 0); assert.equal(h.active, 0);
});
test('abort cancels waiting immediately', async () => {
  const c = new AbortController(), p = wait(120000, c.signal); c.abort(); await assert.rejects(p, /停止/);
});
test('duplicate imports of one role reread persisted completion before attacking', async () => {
  const h = harness(), first = h.make('A'), alias = h.make('A'); alias.tokenId = 'Alias';
  await runSaltBatch([first, alias], h.controller.signal);
  assert.equal(h.sent.A.filter(c => c === 'war_startattackbuilding').length, 1);
  assert.equal(alias.record.state, 'completed');
});
test('missing settlement baseline prevents attack', async () => {
  const h = harness(), r = h.make('A'); delete h.roles.A.aB;
  await runSaltBatch([r], h.controller.signal);
  assert.equal(h.sent.A.filter(c => c === 'war_startattackbuilding').length, 0);
});
