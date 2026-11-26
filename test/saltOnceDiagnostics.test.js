// SALT_ONCE_DIAGNOSTICS_V3
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSaltDebugValue } from '../src/utils/saltField/debug.js';
import { createRecordStore } from '../src/utils/saltField/model.js';
import { SaltOnceRunner } from '../src/utils/saltField/runner.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('salt diagnostics redact credentials and bound large values', () => {
  const safe = sanitizeSaltDebugValue({
    token: 'should-not-appear',
    tokenId: 'should-not-appear-either',
    sid: 'private-session',
    code: 3000560,
    body: { message: 'server rejected', bytes: Array.from({ length: 80 }, (_, i) => i) },
  });
  assert.equal(safe.token, '[已脱敏]');
  assert.equal(safe.tokenId, '[已脱敏]');
  assert.equal(safe.sid, '[已脱敏]');
  assert.equal(safe.code, 3000560);
  assert.match(safe.body.bytes, /数字数组 80 项/);
});

async function runPrepareWithPriorTeamSelection(teamSelected) {
  const records = createRecordStore(memoryStorage());
  records.save({
    tokenId: 'local-test', battlefieldId: 'bf-test', roleCodeId: 'role-test',
    state: 'failed', attempts: 1, excluded: [], createdAt: 1,
    teamIntentAt: null, teamSelected, teamApplied: false, teamReady: false,
    error: 'offline test setup',
  });

  let now = 1000;
  const events = [];
  const role = { state: 'watching', position: { x: 100, y: 100 }, legionID: 7, aB: 0, d: 0 };
  const buildingData = {
    '100_100': { id: '100_100', type: 4, belongsLegionId: 7 },
    '99_100': { id: '99_100', type: 1, belongsLegionId: -1 },
  };
  const connect = async () => ({
    battlefieldId: 'bf-test', roleCodeId: 'role-test',
    get role() { return role; },
    snapshot: { roles: { 'role-test': role }, buildingData, marches: {} },
    async refresh() { return role; },
    async send(cmd, params) {
      events.push(`send:${cmd}`);
      if (cmd === 'war_setbattleteam') role.state = 'idle';
      if (cmd === 'war_startmarch') {
        assert.deepEqual(params.target, { x: 99, y: 100 });
        role.state = 'march';
      }
      return {};
    },
    close() {},
  });
  const runner = new SaltOnceRunner({
    tokenId: 'local-test', records, connect, signal: new AbortController().signal,
    now: () => now,
    sleep: async ms => { events.push(`sleep:${ms}`); now += Math.max(0, ms); },
  });
  await runner.phase('prepare');
  return { events, record: runner.record };
}

test('fresh team setup waits 800ms between the two team commands', async () => {
  const { events, record } = await runPrepareWithPriorTeamSelection(false);
  assert.deepEqual(events.slice(0, 3), [
    'send:war_teamsetbattleteam', 'sleep:800', 'send:war_setbattleteam',
  ]);
  assert.ok(events.includes('send:war_startmarch'));
  assert.equal(record.teamSelected, true);
  assert.equal(record.teamApplied, true);
  assert.equal(record.teamReady, true);
});

test('retry after confirmed first team command does not resend that command', async () => {
  const { events, record } = await runPrepareWithPriorTeamSelection(true);
  assert.deepEqual(events.slice(0, 2), ['send:war_setbattleteam', 'send:war_startmarch']);
  assert.equal(events.some(event => event === 'send:war_teamsetbattleteam'), false);
  assert.equal(record.teamApplied, true);
  assert.equal(record.teamReady, true);
});
