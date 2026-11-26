import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GENIE_TEAMS, normalizeGenieConfig, challengeTeam, parseMainTeam, activePresetTeam,
  strongestPosition, selectHighestHpPet, readDailyQuota, readBattle, progressFrom, buildPreview,
} from '../src/utils/batch/genieChallengePolicy.js';
import { runGenieAccount, createGenieLedger, createTasksGenieChallenge, withGenieLock } from '../src/utils/batch/tasksGenieChallenge.js';
import { HERO_DICT } from '../src/utils/HeroList.js';

const now = Date.parse('2026-10-26T15:03:00Z');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/genie-captures.json', import.meta.url)));
// Synthetic policy fixtures, NOT observed pet protocol fields.
const hp = (p, key) => ({ petUId: key, maxHp: p.syntheticHp, source: 'synthetic-test-only' });
function role(used = 0) {
  return { levelId: 5000, statistics: { 'genie:battle': used }, statisticsTime: { 'genie:battle': now / 1000 },
    battleTeam: [107, 120, 108, 116, 112], heroes: Object.fromEntries(Object.values(GENIE_TEAMS).flatMap(n => n.heroes).map(id => [id, { power: id === 108 ? 900 : 100 }])),
    petData: { pets: { 'synthetic-a': { petId: 101, syntheticHp: 10 }, 'synthetic-b': { petId: 102, syntheticHp: 20 } } }, genie: {} };
}
const memory = () => { const m = new Map(); return { getItem: k => m.get(k), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) }; };
function harness({ used = 0, count = 5, wins = [true, true, false, false, false], failure, readHealth = hp } = {}) {
  const r = role(used), calls = [], ledger = createGenieLedger(memory()); let fought = 0, cleared = 0, stop = false;
  const options = { id: 'account-one', config: { genieId: 2, attempts: count }, ledger, now: () => now, readHealth,
    stopped: () => stop, send: async (cmd, body) => {
      calls.push({ cmd, body });
      if (cmd === 'role_getroleinfo') return { role: structuredClone(r) };
      assert.equal(cmd, 'fight_startgenie'); fought++; r.statistics['genie:battle']++;
      if (failure) throw failure;
      const stage = cleared + 1, isWin = wins[(fought - 1) % wins.length];
      if (isWin) { cleared++; r.genie['2'] = cleared - 1; }
      return { isWin, battleData: { options: { genieLevelId: 2000 + stage }, result: { isWin } }, role: { genie: isWin ? { 2: cleared - 1 } : {} } };
    } };
  return { options, calls, ledger, r, stop: () => { stop = true; } };
}

test('four nations and unique heroes; carry swap covers every position', () => {
  assert.deepEqual(Object.keys(GENIE_TEAMS), ['1', '2', '3', '4']);
  assert.deepEqual(Object.values(GENIE_TEAMS).map(n => n.carry), [101, 103, 106, 107]);
  for (const [id, n] of Object.entries(GENIE_TEAMS)) for (let position = 0; position < 5; position++) {
    const team = challengeTeam(id, position, role().heroes);
    assert.equal(team[position], n.carry); assert.equal(new Set(Object.values(team)).size, 5);
    assert.ok(Object.values(team).every(hero => HERO_DICT[hero].type === n.name));
    assert.deepEqual(Object.values(team).sort(), [...n.heroes].sort());
  }
  assert.throws(() => normalizeGenieConfig({ genieId: 5, attempts: 1 }));
});
test('strongest position is account-specific, stable ties pick lowest position', () => {
  const a = role(), b = role(); b.heroes[107].power = 1000;
  assert.equal(strongestPosition(parseMainTeam(a.battleTeam), a.heroes).position, 2);
  assert.equal(strongestPosition(parseMainTeam(b.battleTeam), b.heroes).position, 0);
  b.heroes[108].power = 1000; assert.equal(strongestPosition(parseMainTeam(b.battleTeam), b.heroes).position, 0);
});
test('reject incomplete, duplicate, malformed power and missing heroes', () => {
  for (const t of [null, [107], [107,107,108,116,112], { 1: 107, 2: 120, 3: 108, 4: 116 }]) assert.throws(() => parseMainTeam(t));
  for (const p of [null, undefined, '', false, NaN, Infinity, -1, 0, {}]) {
    const r = role(); r.heroes[108].power = p; assert.throws(() => strongestPosition(parseMainTeam(r.battleTeam), r.heroes));
  }
  const r = role(); delete r.heroes[103]; assert.throws(() => challengeTeam(2, 1, r.heroes), /关羽/);
});
test('preset fallback requires explicit active slot, never assumes slot one', () => {
  const presetTeamInfo = { 1: { teamInfo: role().battleTeam }, 3: { teamInfo: [101,102,113,117,109] } };
  assert.throws(() => activePresetTeam({ presetTeamInfo }));
  assert.equal(activePresetTeam({ presetTeamInfo, useTeamId: 3 })[0].heroId, 101);
  assert.deepEqual(parseMainTeam({ 1:107, 2:120, 3:108, 4:116, 5:112 }).map(v => v.position), [0,1,2,3,4]);
});
test('highest HP requires evidence for EVERY pet; production adapter stays blocked', () => {
  const pets = role().petData.pets;
  assert.equal(selectHighestHpPet(pets, hp).petUId, 'synthetic-b');
  assert.equal(selectHighestHpPet(pets, hp).compared, 2);
  assert.throws(() => selectHighestHpPet(pets), /无法比较/);
  assert.throws(() => selectHighestHpPet({}), /没有可用宠物/);
  pets['synthetic-a'].syntheticHp = null;
  assert.throws(() => selectHighestHpPet(pets, hp));
  assert.throws(() => selectHighestHpPet({ 101: { petId: 101, syntheticHp: 100 } }, hp), /petId/);
});
test('daily shared quota rejects missing/stale/invalid dates; all countries see same count', () => {
  for (let id = 1; id <= 4; id++) assert.equal(buildPreview(role(9), { genieId: id, attempts: 10 }, parseMainTeam(role().battleTeam), now, hp).limit, 1);
  const r = role(); delete r.statisticsTime; assert.throws(() => readDailyQuota(r, now));
  r.statisticsTime = { 'genie:battle': now / 1000 - 86400 }; assert.throws(() => readDailyQuota(r, now), /非当日/);
  assert.equal(readDailyQuota(role(10), now).remaining, 0);
});
test('attempt boundaries 1,5,10; invalid numbers never silently clamp', async () => {
  for (const n of [1,5,10]) { const h = harness({ count:n }); const r = await runGenieAccount(h.options); assert.equal(r.status, 'completed'); assert.equal(r.attempted, n); }
  for (const n of [0,11,1.5,null,undefined,'']) assert.throws(() => normalizeGenieConfig({ genieId:1, attempts:n }));
});
test('nine already used sends exactly once; ten skips without pet or team queries', async () => {
  const h = harness({ used:9, count:10 }); const r = await runGenieAccount(h.options); assert.equal(r.attempted, 1); assert.equal(r.used, 10);
  const full = harness({ used:10 }); delete full.r.petData; const q = await runGenieAccount(full.options);
  assert.equal(q.status, 'quota'); assert.deepEqual(full.calls.map(v=>v.cmd), ['role_getroleinfo']);
});
test('historical captures retain defeat code=0, shared counts and empty delta progress', () => {
  assert.deepEqual(fixtures[0].battles.map(v=>readBattle(v.response,v.request.genieId).isWin), [false,true,true,true]);
  assert.deepEqual(fixtures[0].battles.map(v=>v.response.data.role.statistics['genie:battle']), [7,8,9,10]);
  assert.deepEqual(fixtures[1].battles.map(v=>readBattle(v.response,2).stage), [1,2,3,3,3]);
  assert.deepEqual(fixtures[1].battles.map(v=>v.response.data.role.statistics['genie:battle']), [6,7,8,9,10]);
  assert.equal(progressFrom({genie:{}},2,2),2);
  for(const f of fixtures) for(const b of f.battles) assert.equal(readDailyQuota(b.response.data.role,now).used,b.response.data.role.statistics['genie:battle']);
});
test('wins advance, losses consume count and continue same stage by default', async () => {
  const h=harness({used:5}), events=[];h.options.onBattle=b=>events.push(b);
  const r=await runGenieAccount(h.options);
  assert.deepEqual([r.wins,r.losses,r.cleared,r.used],[2,3,2,10]);
  assert.deepEqual(events.map(e=>e.stage),[1,2,3,3,3]); assert.equal(h.ledger.get('account-one'),null);
});
test('code zero is not a win; missing/conflicting/wrong-nation responses fail closed', () => {
  for(const r of [{code:0},{isWin:true,battleData:{result:{isWin:false}}},{isWin:true,battleData:{options:{genieLevelId:5001}}}]) assert.throws(()=>readBattle(r,2));
});
test('timeout/disconnect/lost response NEVER resend, reconcile once, block subsequent run', async () => {
  for(const message of ['timeout','disconnected','missing response']) {
    const h=harness({failure:new Error(message)}); let closed=0;h.options.onUncertain=async()=>closed++;
    const r=await runGenieAccount(h.options);assert.equal(r.status,'unverified');assert.equal(r.attempted,1);assert.equal(r.used,1);assert.equal(closed,1);
    assert.equal(h.calls.filter(c=>c.cmd==='fight_startgenie').length,1);
    assert.equal((await runGenieAccount(h.options)).status,'unverified');assert.equal(h.calls.filter(c=>c.cmd==='fight_startgenie').length,1);
  }
});
test('lost postbattle read keeps durable marker; stop waits for issued battle settlement', async () => {
  const h=harness();h.options.onBattle=()=>h.stop();const r=await runGenieAccount(h.options);
  assert.equal(r.status,'stopped');assert.equal(r.attempted,1);assert.equal(h.ledger.get('account-one'),null);
  const j=harness();const orig=j.options.send;j.options.send=async(...args)=>{if(j.calls.some(c=>c.cmd==='fight_startgenie'))throw new Error('lost read');return orig(...args);};
  const uncertain=await runGenieAccount(j.options);assert.equal(uncertain.status,'unverified');assert.ok(j.ledger.get('account-one'));
});
test('preview cannot fight, production health gate cannot be bypassed; storage failure zero writes', async () => {
  const h=harness();h.options.previewOnly=true;assert.equal((await runGenieAccount(h.options)).status,'ready');assert.equal(h.calls.filter(c=>c.cmd==='fight_startgenie').length,0);
  const g=harness();delete g.options.readHealth;assert.equal((await runGenieAccount(g.options)).status,'unverified');assert.equal(g.calls.filter(c=>c.cmd==='fight_startgenie').length,0);
  const j=harness();j.options.ledger={get:()=>null,set:()=>{throw new Error('disk full');}};assert.equal((await runGenieAccount(j.options)).attempted,0);
});
test('optional stop-on-loss consumes only one defeat',async()=>{const h=harness({wins:[false]});h.options.config.stopOnLoss=true;const r=await runGenieAccount(h.options);assert.equal(r.attempted,1);assert.equal(r.losses,1);});
test('batch duplicate click, existing task mutex, queued stop and cleanup',async()=>{
  let resolveOpen, opens=0, closes=0;
  const d={selectedTokens:{value:['a','b']},tokens:{value:[]},shouldStop:{value:false},isRunning:{value:false},rows:{value:[]},tokenStatus:{value:{}},batchSettings:{},ledger:createGenieLedger(memory()),
    isBusy:()=>d.isRunning.value, acquireLease:async()=>null,releaseLease:async()=>{},message:{error(){}},addLog(){},
    openReadOnly:()=>{opens++;return new Promise(r=>resolveOpen=r);},closeReadOnly:async()=>{closes++;},tokenStore:{sendMessageWithPromise:async()=>({role:role(10)})}};
  const tasks=createTasksGenieChallenge(d), config={genieId:1,attempts:1};
  const p=tasks.previewGenieChallenge(config);await new Promise(r=>setImmediate(r));
  assert.deepEqual(await tasks.batchGenieChallenge(config),[]);tasks.stopGenieChallenge();resolveOpen();const rows=await p;
  assert.equal(opens,1);assert.ok(closes>=1);assert.equal(rows[1].status,'stopped');assert.equal(d.isRunning.value,false);
  d.isRunning.value=true;assert.deepEqual(await tasks.previewGenieChallenge(config),[]);
});
test('manual UI entry, sweep and schedule lists remain independent',()=>{
  const view=readFileSync(new URL('../src/views/BatchDailyTasks.vue',import.meta.url),'utf8');
  const constants=readFileSync(new URL('../src/utils/batch/constants.js',import.meta.url),'utf8');
  const wire=readFileSync(new URL('../src/utils/xyzwWebSocket.js',import.meta.url),'utf8');
  assert.ok(view.includes('普通灯神挑战'));assert.ok(view.includes('@click="batchGenieSweep"'));
  assert.ok(!constants.includes('batchGenieChallenge'));assert.ok(wire.includes('.register("fight_startgenie")'));assert.ok(wire.includes('fight_startgenieresp: "fight_startgenie"'));
  const open=view.slice(view.indexOf('const openGenieReadOnly'),view.indexOf('const { batchGenieChallenge'));
  assert.ok(!open.includes('fight_startlevel'));assert.ok(!open.includes('ensureConnection('));
});

test('three real read-only role captures: hp/uId selected separately, missing quota sends ZERO battles', async () => {
  const live = JSON.parse(readFileSync(new URL('./fixtures/genie-live-role-redacted.json', import.meta.url)));
  const expected = [[303,53000000],[403,65599994],[404,68133327]];
  for (let i=0;i<live.length;i++) {
    const pet=selectHighestHpPet(live[i].role.petData.pets);
    assert.deepEqual([pet.petId,pet.maxHp],expected[i]);
    let battles=0;
    const r=await runGenieAccount({id:live[i].accountAlias,config:{genieId:4,attempts:1},ledger:createGenieLedger(memory()),now:()=>now,
      send:async cmd=>{if(cmd==='fight_startgenie')battles++;return {role:live[i].role};}});
    assert.equal(r.status,'unverified');assert.equal(battles,0);assert.equal(r.preview.strongest.position,0);
    assert.ok(r.message.includes('次数'));assert.equal(r.preview.pet.maxHp,expected[i][1]);
  }
  const enhanced=structuredClone(live[0].role.petData.pets);enhanced['0'].talentHp=1;
  assert.ok(selectHighestHpPet(enhanced).source.includes('服务器hp排序'));
  enhanced['0'].talentHp=0;enhanced['0'].quenches={3:1};assert.ok(selectHighestHpPet(enhanced).source.includes('服务器hp排序'));
});

test('cross-tab lock unavailable or held cannot execute; available lock releases',async()=>{
  let calls=0;
  await assert.rejects(withGenieLock(null,()=>calls++));
  await assert.rejects(withGenieLock({request:async(name,options,fn)=>{assert.equal(options.ifAvailable,true);return fn(null);}},()=>calls++));
  assert.equal(calls,0);
  await withGenieLock({request:async(name,options,fn)=>fn({name})},()=>calls++);assert.equal(calls,1);
});

test('carry occupies strongest slot; others keep base order without exchanging growth', () => {
  for (const [id,n] of Object.entries(GENIE_TEAMS)) for(let slot=0;slot<5;slot++) {
    const values=Object.values(challengeTeam(id,slot,role().heroes));
    assert.deepEqual(values.filter(h=>h!==n.carry),n.heroes.filter(h=>h!==n.carry));
  }
});

test('explicit sparse-counter opt-in performs one probe then verified remaining attempts', async () => {
  const h=harness({count:5}); delete h.r.statistics['genie:battle'];delete h.r.statisticsTime['genie:battle'];
  h.options.config.allowInitialProbe=true;
  const original=h.options.send;
  h.options.send=async(cmd,body)=>{
    if(cmd==='fight_startgenie' && !Object.hasOwn(h.r.statistics,'genie:battle')){
      h.r.statistics['genie:battle']=0;h.r.statisticsTime['genie:battle']=now/1000;
    }
    return original(cmd,body);
  };
  const result=await runGenieAccount(h.options);
  assert.equal(result.status,'completed');assert.equal(result.attempted,5);assert.equal(result.used,5);
});

test('probe is opt-in, preview stays read-only, invalid/future/partial counters never qualify', async () => {
  const h=harness();delete h.r.statistics['genie:battle'];delete h.r.statisticsTime['genie:battle'];
  assert.equal((await runGenieAccount(h.options)).status,'unverified');
  h.options.config.allowInitialProbe=true;h.options.previewOnly=true;
  const result=await runGenieAccount(h.options);assert.equal(result.status,'ready');assert.equal(result.preview.used,null);assert.equal(result.preview.remaining,null);
  assert.equal(h.calls.filter(c=>c.cmd==='fight_startgenie').length,0);
  for(const mutate of [r=>delete r.statisticsTime, r=>r.statistics['genie:battle']=null, r=>r.statistics['genie:battle']=0,
    r=>{r.statistics['genie:battle']=3;r.statisticsTime['genie:battle']=now/1000+3600;}]) {
    const r=structuredClone(h.r);mutate(r);assert.throws(()=>readDailyQuota(r,now,true));
  }
});

test('unexpected probe count and missing post-probe count stop after exactly one request', async () => {
  for(const actual of [undefined,0,11]) {
    const h=harness();delete h.r.statistics['genie:battle'];delete h.r.statisticsTime['genie:battle'];h.options.config.allowInitialProbe=true;
    const original=h.options.send;h.options.send=async(cmd,body)=>{
      if(cmd==='fight_startgenie'){h.r.statistics['genie:battle']=0;h.r.statisticsTime['genie:battle']=now/1000;}
      const r=await original(cmd,body);
      if(cmd==='fight_startgenie'){if(actual===undefined)delete h.r.statistics['genie:battle'];else h.r.statistics['genie:battle']=actual;}
      return r;
    };
    const result=await runGenieAccount(h.options);assert.equal(result.status,'unverified');assert.equal(result.attempted,1);assert.ok(h.ledger.get('account-one'));
  }
});

test('real sparse defeat requires complete battle, unchanged progress and one shared attempt', async () => {
  const {settleGenieBattle}=await import('../src/utils/batch/genieChallengePolicy.js');
  const captures=JSON.parse(readFileSync(new URL('./fixtures/genie-live-battles-redacted.json',import.meta.url)));
  for(const sample of captures.slice(0,2)) {
    const at=sample.after.statisticsTime['genie:battle']*1000+1000;
    const before=readDailyQuota(sample.before,at),after=readDailyQuota(sample.after,at);
    const parsed=readBattle(sample.response,sample.genieId);
    const team=Object.fromEntries(sample.response.battleData.result.sponsor.teamInfo.map(h=>[h.index,h.heroId]));
    const settle=(b=before,a=after,r=sample.after,t=team)=>settleGenieBattle(parsed,sample.before,r,b,a,sample.genieId,t);
    assert.equal(settle().isWin,sample.genieId===1);
    assert.throws(()=>settle(before,{...after,used:after.used+1}));
    if(sample.genieId===2){
      assert.equal(parsed.isWin,null);assert.equal(settle().cleared,1);
      assert.throws(()=>settle(before,after,{...sample.after,genie:{2:1}}));
      assert.throws(()=>settle(before,after,{...sample.after,genie:null}));
      assert.throws(()=>settle(before,after,sample.after,{...team,0:107}));
      const truncated=structuredClone(sample.response);delete truncated.battleData.result.totalFrame;assert.throws(()=>readBattle(truncated,2));
    }
  }
  assert.equal(readBattle(captures[2].response,3).isWin,null);
});

test('one read-only reconnect recovers postbattle read; never resubmits battle',async()=>{
  const h=harness({count:1}),orig=h.options.send;let failed=false,reopened=0;
  h.options.onUncertain=async()=>reopened++;
  h.options.send=async(...args)=>{if(args[0]==='role_getroleinfo' && h.calls.some(c=>c.cmd==='fight_startgenie') && !failed){failed=true;throw Error('timeout');}return orig(...args);};
  const result=await runGenieAccount(h.options);assert.equal(result.status,'completed');assert.equal(reopened,1);assert.equal(result.attempted,1);
});

test('persisted confirmed battle can reconcile on next preview without new submission',async()=>{
  const h=harness({count:1}),orig=h.options.send;
  h.options.send=async(...args)=>{if(args[0]==='role_getroleinfo' && h.calls.some(c=>c.cmd==='fight_startgenie'))throw Error('timeout');return orig(...args);};
  assert.equal((await runGenieAccount(h.options)).status,'unverified');assert.ok(h.ledger.get('account-one').battle);
  h.options.send=orig;h.options.previewOnly=true;
  const result=await runGenieAccount(h.options);assert.equal(result.status,'reconciled');assert.equal(h.ledger.get('account-one'),null);
  assert.equal(h.calls.filter(c=>c.cmd==='fight_startgenie').length,1);
});

test('phase-aware diagnostics omit authentication URLs and retain safe error codes',async()=>{
  const {genieError}=await import('../src/utils/batch/tasksGenieChallenge.js');
  const e=genieError(Error('WebSocket closed wss://example.com?token=very-secret'),'战后读取角色');
  assert.match(e.message,/战后读取角色.*连接已断开/);assert.ok(!e.message.includes('secret'));
  assert.match(genieError(Error('服务器错误: 400340 - arbitrary secret'),'读取角色').message,/400340/);
});

test('stop while pacing before enqueue consumes zero attempts and clears unsent marker',async()=>{
  const h=harness(),orig=h.options.send;
  h.options.send=async(cmd,body)=>{if(cmd==='fight_startgenie')throw Object.assign(Error('用户主动停止'),{status:'stopped'});return orig(cmd,body);};
  const r=await runGenieAccount(h.options);assert.equal(r.status,'stopped');assert.equal(r.attempted,0);assert.equal(h.ledger.get('account-one'),null);
});

// Synthetic cross-day regressions: no claim that daily server reset was observed.
test('past-day statistics explicitly opt into probe, retaining historical count instead of zero', () => {
  for (const used of [0,9,10]) for (const milliseconds of [false,true]) {
    const r=role(used);r.statisticsTime['genie:battle']=milliseconds?now-86400000:(now-86400000)/1000;
    assert.throws(()=>readDailyQuota(r,now),/历史记录.*统计北京时间.*当前北京时间.*允许受限首战/);
    const q=readDailyQuota(r,now,true);
    assert.equal(q.used,null);assert.equal(q.remaining,null);assert.equal(q.probe,true);assert.equal(q.historicalUsed,used);
    assert.equal(q.statisticsDay,'2026-10-25');
  }
});
test('past-day ten allows preview then first reset-to-one response and all five requested attempts',async()=>{
  const h=harness({used:10,count:5});h.r.statisticsTime['genie:battle']=now/1000-86400;h.options.config.allowInitialProbe=true;
  const preview=await runGenieAccount({...h.options,previewOnly:true});
  assert.equal(preview.status,'ready');assert.match(preview.message,/历史统计.*已用10次.*今日次数未知/);
  assert.equal(h.calls.filter(c=>c.cmd==='fight_startgenie').length,0);
  const original=h.options.send;let first=true;
  h.options.send=async(cmd,body)=>{
    if(cmd==='fight_startgenie'&&first){first=false;h.r.statistics['genie:battle']=0;h.r.statisticsTime['genie:battle']=now/1000;}
    return original(cmd,body);
  };
  const r=await runGenieAccount(h.options);assert.equal(r.status,'completed');assert.equal(r.attempted,5);assert.equal(r.used,5);
});
test('old dates require current timestamp; current count10 stops without further submission',async()=>{
  for(const updateTime of [true,false]) {
    const h=harness({used:9,count:5});h.r.statisticsTime['genie:battle']=now/1000-86400;h.options.config.allowInitialProbe=true;
    const original=h.options.send;h.options.send=async(cmd,body)=>{
      if(cmd==='fight_startgenie'&&updateTime)h.r.statisticsTime['genie:battle']=now/1000;
      return original(cmd,body);
    };
    const r=await runGenieAccount(h.options);assert.equal(r.status,updateTime?'completed':'unverified');assert.equal(r.attempted,1);
    assert.equal(!!h.ledger.get('account-one'),!updateTime);
    assert.equal((await runGenieAccount(h.options)).status,updateTime?'quota':'unverified');assert.equal(h.calls.filter(c=>c.cmd==='fight_startgenie').length,1);
  }
});
test('future and invalid timestamps remain blocked with date diagnostics even with opt-in',async()=>{
  for(const t of [(now+61000)/1000,now+3600000,1e30]) {
    const h=harness();h.r.statisticsTime['genie:battle']=t;h.options.config.allowInitialProbe=true;
    const r=await runGenieAccount(h.options);assert.equal(r.status,'unverified');assert.equal(r.attempted,0);
    assert.match(r.message,t===1e30?/有效日期范围/:/统计时间在未来.*统计北京时间.*当前北京时间/);
  }
});
test('Beijing day boundary is independent of host timezone and supports second/millisecond units',()=>{
  const midnight=Date.parse('2026-10-26T16:00:00Z');const r=role(10);
  r.statisticsTime['genie:battle']=(midnight-1000)/1000;
  assert.equal(readDailyQuota(r,midnight,true).probe,true);
  r.statisticsTime['genie:battle']=midnight;
  assert.equal(readDailyQuota(r,midnight,true).remaining,0);
  r.statisticsTime['genie:battle']=midnight/1000;
  assert.equal(readDailyQuota(r,midnight,true).remaining,0);
});
test('same-day exhausted quota stays a normal skip even when historical probe option is enabled',async()=>{
  const h=harness({used:10});h.options.config.allowInitialProbe=true;
  assert.equal((await runGenieAccount(h.options)).status,'quota');assert.equal(h.calls.filter(c=>c.cmd==='fight_startgenie').length,0);
});
test('past-day timeout never retries battle and current-day pending record blocks another probe',async()=>{
  const h=harness({failure:Error('timeout')});h.r.statisticsTime['genie:battle']=now/1000-86400;h.options.config.allowInitialProbe=true;
  assert.equal((await runGenieAccount(h.options)).attempted,1);
  assert.equal((await runGenieAccount(h.options)).status,'unverified');assert.equal(h.calls.filter(c=>c.cmd==='fight_startgenie').length,1);
});
test('date changing after an old-date probe leaves unresolved record and sends no next attempt',async()=>{
  const h=harness({used:10,count:5});h.r.statisticsTime['genie:battle']=now/1000-86400;h.options.config.allowInitialProbe=true;
  const original=h.options.send;h.options.send=async(cmd,body)=>{
    if(cmd==='fight_startgenie'){h.r.statistics['genie:battle']=0;h.r.statisticsTime['genie:battle']=(now+86400000)/1000;}
    return original(cmd,body);
  };
  // Runner captures the injected clock function; switch its returned value.
  let clock=now;h.options.now=()=>clock;
  const send=h.options.send;h.options.send=async(...args)=>{const r=await send(...args);if(args[0]==='fight_startgenie')clock+=86400000;return r;};
  const r=await runGenieAccount(h.options);assert.equal(r.status,'unverified');assert.equal(r.attempted,1);
});
