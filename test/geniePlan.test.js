import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeGeniePlan } from '../src/utils/batch/genieChallengePlan.js';
import { runGeniePlanAccount, createGenieLedger } from '../src/utils/batch/tasksGenieChallenge.js';

// Artificial quota/transport scenarios using a redacted real role shape.
const now = Date.parse('2026-10-28T10:00:00Z');
function harness({ used = 0, old = false, missing = false, resetTo = 0, wins = true, fail, counts } = {}) {
  const role = structuredClone(JSON.parse(readFileSync(new URL('./fixtures/genie-live-role-redacted.json', import.meta.url)))[0].role);
  role.statistics = missing ? {} : { 'genie:battle': used };
  role.statisticsTime = missing ? {} : { 'genie:battle': now / 1000 - (old ? 86400 : 0) };
  role.genie = {};
  const map = new Map(), calls = [], events = [], ledger = createGenieLedger({ getItem: k => map.get(k), setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k) });
  let stopped = false, first = true;
  const options = { id: 'artificial-plan', config: counts ? { attemptsByNation: counts } : {}, now: () => now, ledger,
    stopped: () => stopped, onBattle: b => events.push(b), send: async (cmd, body) => {
      calls.push({ cmd, body });
      if (cmd === 'role_getroleinfo') return { role: structuredClone(role) };
      assert.equal(cmd, 'fight_startgenie');
      if (first && (old || missing)) role.statistics['genie:battle'] = resetTo;
      first = false; role.statisticsTime['genie:battle'] = now / 1000;
      if (fail === 'quota') { role.statistics['genie:battle'] = 10; return { code: 999123 }; } // Synthetic error code, no production mapping.
      role.statistics['genie:battle']++;
      if (fail) throw Error(fail);
      const stage = role.genie[body.genieId] === undefined ? 1 : role.genie[body.genieId] + 2;
      if (wins) role.genie[body.genieId] = stage - 1;
      return { isWin: wins, battleData: { options: { genieLevelId: body.genieId * 1000 + stage }, result: { isWin: wins } } };
    } };
  return { role, calls, events, ledger, options, stop: () => { stopped = true; }, fights: () => calls.filter(c => c.cmd === 'fight_startgenie') };
}

test('default allocation is Wei2 Shu2 Wu2 Qun4; probe enabled unless explicitly disabled', () => {
  assert.deepEqual(normalizeGeniePlan().attemptsByNation, { 1:2, 2:2, 3:2, 4:4 });
  assert.equal(normalizeGeniePlan().allowInitialProbe, true);
  assert.equal(normalizeGeniePlan({ allowInitialProbe: false }).allowInitialProbe, false);
  for (const counts of [{1:0,2:0,3:0,4:0},{1:3,2:3,3:3,4:3},{1:1.5,2:0,3:0,4:0},{1:null,2:0,3:0,4:1},{1:1,2:0,3:0,4:0,5:1},{}])
    assert.throws(() => normalizeGeniePlan({ attemptsByNation: counts }));
});
test('one Start runs all four nations in order within shared ten; no growth commands', async () => {
  const h = harness(), original = structuredClone(h.role);
  const r = await runGeniePlanAccount(h.options);
  assert.equal(r.status, 'completed'); assert.equal(r.attempted, 10); assert.equal(r.used, 10);
  assert.deepEqual(h.fights().map(c => c.body.genieId), [1,1,2,2,3,3,4,4,4,4]);
  assert.deepEqual(r.nations.map(n => n.attempted), [2,2,2,4]);
  assert.deepEqual(h.events.map(e => e.totalAttempted), [1,2,3,4,5,6,7,8,9,10]);
  assert.deepEqual(h.role.battleTeam, original.battleTeam); assert.deepEqual(h.role.heroes, original.heroes);
  assert.equal(h.fights()[0].body.battleTeam[0], 101); assert.equal(h.fights()[2].body.battleTeam[0], 103);
});
test('one and five total, disabled countries and shared quota9 cap are honored', async () => {
  for (const counts of [{1:0,2:0,3:0,4:1},{1:0,2:2,3:0,4:3}]) {
    const h = harness({counts}), r = await runGeniePlanAccount(h.options);
    assert.equal(r.attempted, Object.values(counts).reduce((a,b)=>a+b,0));
    assert.ok(h.fights().every(c => counts[c.body.genieId] > 0));
  }
  const h = harness({used:9}), r = await runGeniePlanAccount(h.options);
  assert.equal(r.attempted, 1); assert.equal(h.fights()[0].body.genieId, 1); assert.equal(r.used,10);
  const full=harness({used:10}); assert.equal((await runGeniePlanAccount(full.options)).status,'quota');assert.equal(full.fights().length,0);
});
test('old and absent quota start by default; fresh response establishes quota without assuming zero', async () => {
  for(const missing of [true,false]) {
    const h=harness({old:!missing,missing,used:10,resetTo:6}),r=await runGeniePlanAccount(h.options);
    assert.equal(r.status,'completed');assert.equal(r.attempted,4);assert.equal(r.used,10);
    assert.deepEqual(h.events.map(b=>b.used),[7,8,9,10]);assert.equal(h.ledger.get(h.options.id),null);
  }
});
test('explicit probe disable still stops before sending on historical quota',async()=>{
  const h=harness({old:true});h.options.config.allowInitialProbe=false;
  assert.equal((await runGeniePlanAccount(h.options)).status,'unverified');assert.equal(h.fights().length,0);
});
test('server refusal only becomes quota skip after fresh role confirms ten; no next country',async()=>{
  const h=harness({missing:true,fail:'quota'}),r=await runGeniePlanAccount(h.options);
  assert.equal(r.status,'quota');assert.equal(h.fights().length,1);assert.equal(r.used,10);assert.equal(h.ledger.get(h.options.id),null);
});
test('losses continue same stage and next nation by default; stopOnLoss stops whole account',async()=>{
  const h=harness({wins:false}),r=await runGeniePlanAccount(h.options);
  assert.equal(r.losses,10);assert.ok(h.events.every(b=>b.stage===1));
  const stop=harness({wins:false});stop.options.config.stopOnLoss=true;
  assert.equal((await runGeniePlanAccount(stop.options)).attempted,1);assert.equal(stop.fights().length,1);
});
test('timeout or lost response stops plan and subsequent Start cannot replay',async()=>{
  for(const fail of ['timeout','disconnected','lost response']) {
    const h=harness({fail});assert.equal((await runGeniePlanAccount(h.options)).status,'unverified');
    assert.equal(h.fights().length,1);assert.ok(h.ledger.get(h.options.id));
    await runGeniePlanAccount(h.options);assert.equal(h.fights().length,1);
  }
});
test('stop after first settled fight does not enter another nation',async()=>{
  const h=harness({counts:{1:1,2:1,3:1,4:1}});h.options.onBattle=()=>h.stop();
  assert.equal((await runGeniePlanAccount(h.options)).status,'stopped');assert.equal(h.fights().length,1);
});
test('missing hero in a later selected nation prevents spending any attempts',async()=>{
  const h=harness();delete h.role.heroes[107];
  const r=await runGeniePlanAccount(h.options);assert.equal(r.status,'conditions');assert.match(r.message,/吕布/);assert.equal(h.fights().length,0);
});
test('future clock and unverifiable pet still cannot submit',async()=>{
  for(const mutate of [r=>r.statisticsTime['genie:battle']=now/1000+3600,r=>Object.values(r.petData.pets)[0].hp=null]) {
    const h=harness();mutate(h.role);assert.equal((await runGeniePlanAccount(h.options)).status,'unverified');assert.equal(h.fights().length,0);
  }
});
test('day rollover and quota rollback between nations stop without another submission',async()=>{
  for(const rollover of [true,false]) {
    const h=harness({counts:{1:1,2:1,3:0,4:0}});
    // Closure is stable in production; emulate a clock advancing instead of replacing it.
    let time=now;h.options.now=()=>time;
    h.options.onBattle=()=>{if(rollover)time+=86400000;else h.role.statistics['genie:battle']=0;};
    const r=await runGeniePlanAccount(h.options);assert.equal(r.status,'unverified');assert.equal(h.fights().length,1);
  }
});

test('actual Oct28 captures: old-day first fight, Wei loss to Shu win, Wu loss and Qun win',async()=>{
  const capture=JSON.parse(readFileSync(new URL('./fixtures/genie-four-nation-live-redacted.json',import.meta.url)));
  for(const [index,account] of capture.accounts.entries()) {
    const h=harness(),events=[];let read=0,fight=0;
    const last=account.reads.at(-1).role.statisticsTime['genie:battle']*1000;
    const r=await runGeniePlanAccount({...h.options,config:{attemptsByNation:account.attemptsByNation},now:()=>last+1000,
      onBattle:b=>events.push(b),send:async(cmd)=>{
        if(cmd==='role_getroleinfo')return structuredClone(account.reads[read++]);
        assert.equal(cmd,'fight_startgenie');return structuredClone(account.battles[fight++]);
      }});
    assert.equal(r.status,'completed');assert.equal(fight,index===0?2:1);
    assert.deepEqual([r.wins,r.losses],[[1,1],[0,1],[1,0]][index]);
    assert.equal(r.used,index===0?2:1);assert.equal(h.ledger.get(h.options.id),null);
    assert.deepEqual(events.map(e=>e.stage),[[2,1],[3],[1]][index]);
  }
});

// Artificial end-to-end plan with the real production technology controller.
import { createTechnologyLedger, research, swapTechnology } from '../src/utils/batch/genieTechnology.js';
function withTechnology(h) {
 const map=new Map();h.options.technologyLedger=createTechnologyLedger({getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)});
 h.role.legionResearch={101:60,102:50};h.role.diamond=500;h.options.config.useTechnology=true;
 const original=h.options.send;h.techCalls=[];
 h.options.send=async(cmd,body)=>{if(cmd==='legion_exchangeresearch'){h.techCalls.push(body);h.role.legionResearch=swapTechnology(research(h.role.legionResearch),body.type,body.targetType);h.role.diamond-=20;return {};}
 if(cmd==='fight_startgenie'){const prefix={1:2,2:1,3:3,4:1}[body.genieId];assert.equal(h.role.legionResearch[prefix*100+1],60);}
 return original(cmd,body);};return h;
}
test('integrated four country plan uses correct technology at every battle and returns warrior',async()=>{const h=withTechnology(harness());const r=await runGeniePlanAccount(h.options);assert.equal(r.status,'completed');assert.equal(r.attempted,10);assert.equal(h.role.legionResearch[101],60);assert.equal(h.techCalls.length,4);});
test('quota exhausted and preview never spend technology resources',async()=>{for(const previewOnly of [false,true]){const h=withTechnology(harness({used:previewOnly?0:10}));h.options.previewOnly=previewOnly;await runGeniePlanAccount(h.options);assert.equal(h.techCalls.length,0);}});
test('integrated stop after first battle restores warrior without entering second nation',async()=>{const h=withTechnology(harness());h.options.onBattle=()=>h.stop();const r=await runGeniePlanAccount(h.options);assert.equal(r.status,'stopped');assert.equal(r.attempted,1);assert.equal(h.role.legionResearch[101],60);assert.equal(h.techCalls.length,2);});
test('pending recovery runs even when technology toggle is off and sends no fights',async()=>{const h=withTechnology(harness());h.role.legionResearch=swapTechnology(research(h.role.legionResearch),1,4);h.options.technologyLedger.set(h.options.id,{version:1,pending:false,current:research(h.role.legionResearch)});h.options.config.useTechnology=false;const r=await runGeniePlanAccount(h.options);assert.equal(r.status,'reconciled');assert.equal(h.fights().length,0);assert.equal(h.role.legionResearch[101],60);});

test('integrated toy calculation follows tech switch and uses chosen owned ID in battle',async()=>{
 const h=withTechnology(harness({counts:{1:1,2:0,3:0,4:0}}));h.role.lordWeapon={1:{weaponId:1},2:{weaponId:2}};
 const original=h.options.send;const queries=[];
 h.options.send=async(cmd,b)=>{
  if(cmd==='hero_calcpowerbyteam'){assert.equal(h.role.legionResearch[201],60);queries.push(b.lordWeaponId);return {power:b.lordWeaponId===2?900:100};}
  if(cmd==='fight_startgenie')assert.equal(b.lordWeaponId,2);
  return original(cmd,b);
 };
 const r=await runGeniePlanAccount(h.options);assert.equal(r.status,'completed');assert.equal(r.attempted,1);assert.deepEqual(queries,[0,1,2]);assert.equal(h.role.legionResearch[101],60);
});
test('toy query failure sends no battle and restores technology',async()=>{
 const h=withTechnology(harness());h.role.lordWeapon={1:{weaponId:1}};const original=h.options.send;
 h.options.send=async(cmd,b)=>{if(cmd==='hero_calcpowerbyteam')throw Error('timeout');return original(cmd,b);};
 const r=await runGeniePlanAccount(h.options);assert.equal(r.status,'unverified');assert.equal(h.fights().length,0);assert.equal(h.role.legionResearch[101],60);
});
