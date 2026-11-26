import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as policy from '../src/utils/dreamStatePolicy.js';
import * as unlocks from '../src/utils/gameFeatureUnlocks.js';
import { recordTaskResult } from '../src/utils/batch/taskResult.js';
import { classifyBatchDailyError } from '../src/utils/batch/dailyErrorPolicy.js';
const NOW = Date.parse('2026-10-18T12:00:00+08:00');
class Clock extends Date { static now() { return NOW; } }
const role = (id = 1, hp = 100) => ({ role: { levelId: 9000, roleId: 1, heroes: { 107: { power: 100 } }, dungeon: { id, maxId: id, beginTime: NOW / 1000, battleTeam: { 0: { heroId: 107, hp } } } } });
const source = readFileSync(new URL('../src/utils/batch/tasksDungeon.js', import.meta.url), 'utf8').replace(/^import\s[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '').replace('export function createTasksDungeon', 'function createTasksDungeon');
const injected = { ...policy, ...unlocks, recordTaskResult, HERO_DICT: {}, Date: Clock, setTimeout: cb => { cb(); return 0; } };
const flow = new Function(...Object.keys(injected), source+';return dreamFinalFlow;')(...Object.values(injected));
async function run({ read = n => role(), fight = () => ({ isWin: false }), stopped = () => false } = {}) {
  let fights = 0, reads = 0; const logs = [];
  const tokenStore = { sendMessageWithPromise: async (id, cmd) => {
    if (cmd === 'role_getroleinfo') { reads++; return read(fights, reads); }
    if (cmd === 'fight_startlevel') return { battleData: { version: 1 } };
    if (cmd === 'fight_startdungeon') { fights++; return fight(fights); }
    throw new Error('unexpected '+cmd);
  } };
  const result = await flow({ tokenStore, tokenId: 'a', stopped, log: (...v) => logs.push(v), stage() {}, attempted() {} });
  return { result, fights, reads, logs };
}
test('unchanged stage gets one initial fight plus exactly five retries', async () => {
  const h = await run(); assert.equal(h.fights, 6); assert.equal(h.result.status, 'warning');
  assert.deepEqual(h.logs.filter(v => v[0] === '单关卡重试').map(v => v[1].retry), [1,2,3,4,5]);
});
test('advancing a stage resets its retry budget', async () => {
  const h = await run({ read: n => role(n >= 6 ? 2 : 1, n >= 12 ? 0 : 100) });
  assert.equal(h.fights, 12); assert.equal(h.result.status, 'completed');
});
test('loss with confirmed zero HP finishes after one battle', async () => {
  const h = await run({ read: n => role(1, n ? 0 : 100) }); assert.equal(h.fights, 1); assert.equal(h.result.status, 'completed');
});
for (const [label, fight] of [['missing response', () => ({})], ['timeout', () => { throw new Error('request timeout'); }]]) {
  test(label+' retries only with verified unchanged alive state', async () => {
    const h = await run({ fight }); assert.equal(h.fights, 6); assert.equal(h.result.status, 'warning');
  });
}
for (const field of ['hp', 'id', 'maxId']) {
  test('missing '+field+' after battle stops without another request', async () => {
    const h = await run({ read: n => { const r = role(); if (n) { if (field === 'hp') delete r.role.dungeon.battleTeam[0].hp; else delete r.role.dungeon[field]; } return r; } });
    assert.equal(h.fights, 1); assert.equal(h.result.status, 'warning');
  });
}
test('winning response still requires fresh state', async () => {
  const h = await run({ fight: () => ({ isWin: true }), read: n => n ? { role: {} } : role() });
  assert.equal(h.fights, 1); assert.equal(h.result.status, 'warning');
});
test('role read failure does not blindly resend a battle', async () => {
  const h = await run({ read: n => { if (n) throw new Error('read timeout'); return role(); } });
  assert.equal(h.fights, 1); assert.match(h.result.reason, /读取失败/);
});
test('200400 on post-fight reads retries only reads and recovers without another fight', async () => {
  let rejected=0;
  const h=await run({read:n=>{if(n&&rejected++<2)throw Object.assign(new Error('rate'),{code:200400});return role(1,n?0:100);}});
  assert.equal(h.fights,1);assert.equal(h.reads,4);assert.equal(h.result.status,'completed');
  assert.deepEqual(h.logs.filter(v=>v[0]==='状态查询冷却').map(v=>v[1].seconds),[5,10]);
});
test('exhausted 200400 read retries stop after four reads without replaying a fight', async () => {
  const h=await run({read:n=>{if(n)throw Object.assign(new Error('rate'),{code:200400});return role();}});
  assert.equal(h.fights,1);assert.equal(h.reads,5);assert.equal(h.result.status,'warning');
  assert.deepEqual(h.logs.filter(v=>v[0]==='状态查询冷却').map(v=>v[1].seconds),[5,10,20]);
});
test('stopping during read recovery prevents the next query and fight', async () => {
  let stop=false;
  const h=await run({stopped:()=>stop,read:n=>{if(n){stop=true;throw Object.assign(new Error('rate'),{code:200400});}return role();}});
  assert.equal(h.fights,1);assert.equal(h.reads,2);assert.equal(h.result.status,'stopped');
});
test('200400 on a fight is not automatically retried as a read', async () => {
  let count=0;
  await assert.rejects(run({fight:()=>{count++;throw Object.assign(new Error('rate'),{code:200400});}}),e=>e.code===200400);
  assert.equal(count,1);
});
test('400340 recovery uses its own budget', async () => {
  const h = await run({ fight: n => { if (n === 1) throw Object.assign(new Error('rate'), { code: 400340 }); return { isWin: false }; } });
  assert.equal(h.fights, 7); assert.equal(h.result.rateRecoveries, 1);
});
test('400340 recovery is limited to two; real errors propagate', async () => {
  await assert.rejects(run({ fight: () => { throw Object.assign(new Error('rate'), { code: 400340 }); } }), e => e.code === 400340 && e.dreamProgress.rateRecoveries === 2);
  await assert.rejects(run({ fight: () => { throw Object.assign(new Error('real'), { code: 400080 }); } }), e => e.code === 400080);
  assert.equal(classifyBatchDailyError({ code: 400080, requestCmd: 'dungeon_selecthero' }).level, 'error');
});
test('unknown response may advance only on read-back evidence', async () => {
  const h = await run({ fight: () => ({}), read: n => role(1+n, n >= 3 ? 0 : 100) });
  assert.equal(h.fights, 3); assert.equal(h.result.status, 'completed');
});
test('stop before running makes no requests', async () => {
  const h = await run({ stopped: () => true }); assert.equal(h.fights, 0); assert.equal(h.reads, 0); assert.equal(h.result.status, 'stopped');
});
test('daily preflight distinguishes current alive/dead, old round, and unknown HP', () => {
  assert.equal(policy.dailyDreamPreflight(role(), NOW).status, 'skipped');
  assert.equal(policy.dailyDreamPreflight(role(1, 0), NOW).status, 'skipped');
  const old = role(1,0); old.role.dungeon.beginTime -= 7*86400;
  assert.equal(policy.dailyDreamPreflight(old, NOW).status, 'select');
  const unknown = role(); delete unknown.role.dungeon.battleTeam[0].hp;
  assert.equal(policy.dailyDreamPreflight(unknown, NOW).status, 'warning');
  assert.equal(policy.dailyDreamPreflight({}, Date.parse('2026-10-20T12:00:00+08:00')).status, 'skipped');
});
test('daily selecthero 400080 is skipped only after confirmed current-round team', async () => {
  const text = readFileSync(new URL('../src/utils/dailyTaskRunner.js', import.meta.url), 'utf8');
  const block = text.slice(text.indexOf('// 咸王梦境'), text.indexOf('// 深海灯神'));
  const execute = new Function('tasks','mainStageLevel','DREAM_UNLOCK_LEVEL','dailyDreamPreflight','getDreamRound','extractDreamBattleTeam', 'const taskList = tasks, dreamUnlocked = true, tokenId = \'a\'; let dreamBattleTeam = null;'+block+';return tasks[0].execute;');
  const get = ctx => execute.call(ctx,[],9000,1,r => policy.dailyDreamPreflight(r,NOW),() => policy.getDreamRound(NOW),() => ({0:107}));
  for (const confirmed of [true,false]) {
    let reads=0, selects=0;
    const ctx = { executeGameCommand: async (id, cmd) => {
      if (cmd === 'role_getroleinfo') return ++reads === 1 ? {role:{dungeon:{beginTime:0,battleTeam:{}}}} : confirmed ? role() : {};
      if (cmd === 'presetteam_getinfo') return {presetTeamInfo:{useTeamId:1}};
      if (cmd === 'dungeon_selecthero') { selects++; throw Object.assign(new Error('服务器错误: 400080 - real'),{code:400080,requestCmd:cmd}); }
      return {};
    }, log() {} };
    if (confirmed) assert.equal((await get(ctx)()).taskStatus,'skipped');
    else await assert.rejects(get(ctx)(),e=>e.code===400080);
    assert.equal(selects,1);
  }
});
