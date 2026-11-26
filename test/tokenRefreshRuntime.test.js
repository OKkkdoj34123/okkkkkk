import test from 'node:test';
import { resolveTokenRefreshSource } from '../src/utils/tokenRefreshSource.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createTasksToken } from '../src/utils/batch/tasksToken.js';
import { generateDayPlan } from '../src/utils/autoSchedule/planGenerator.js';
import { resolvePlanTokens } from '../src/utils/autoSchedule/batchResolver.js';
import { getDueState, canRetry } from '../src/utils/autoSchedule/scheduleGuard.js';
import { gameTimestamp } from '../src/utils/autoSchedule/activityCycle.js';
import { createAutoScheduler } from '../src/utils/autoSchedule/scheduler.js';
import { createScheduleStorage } from '../src/utils/autoSchedule/scheduleStorage.js';
const source=readFileSync(new URL('../src/stores/tokenStore.ts',import.meta.url),'utf8');
const section=source.slice(source.indexOf('// Token刷新尝试记录'),source.indexOf('// 游戏消息处理'));
const code=ts.transpileModule(section,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function refreshHarness(method='url',overrides={}) {
 const data={value:[{id:'a',name:'A',importMethod:method,sourceUrl:'https://fixture.invalid',token:'old'}]},logs=[],keys=[];let auth=0,reconnects=0,limited=0;
 const injected={ref:v=>({value:v}),gameTokens:data,wsLogger:Object.fromEntries(['info','warn','error'].map(k=>[k,(...v)=>logs.push(v)])),
  router:{currentRoute:{value:{path:'/tokens'}}},wsConnections:{value:{}},selectToken:()=>reconnects++,nextTick:async()=>{},localStorage:{getItem:()=>JSON.stringify(data.value)},
  updateToken:(id,patch)=>{const t=data.value.find(t=>t.id===id);if(!t)return false;Object.assign(t,patch);return true;},scheduleAuthUserRequest:async fn=>{limited++;return fn();},
  fetch:async()=>({ok:true,status:200,json:async()=>({token:'new'})}),getArrayBuffer:async key=>{keys.push(key);return new ArrayBuffer(2);},
  transformToken:async()=>{auth++;return 'new';},storeArrayBuffer:async()=>true,deleteArrayBuffer:async()=>{},AbortSignal,globalThis:{},navigator:{},...overrides};
 injected.resolveTokenRefreshSource=resolveTokenRefreshSource;
 injected.tokenBinAccess={read:key=>injected.getArrayBuffer(key)};
 const methods=new Function(...Object.keys(injected),code+';return {attemptTokenRefresh,refreshTokenForSchedule};')(...Object.values(injected));
 return {...methods,data,logs,keys,injected,get auth(){return auth;},get reconnects(){return reconnects;},get limited(){return limited;}};
}
test('exactly one Monday Beijing 00:10 refresh plan and no other days',()=>{
 const plans=generateDayPlan('2026-10-19').filter(p=>p.scheduleId==='tokenRefresh');assert.equal(plans.length,1);const p=plans[0];assert.equal(p.batchId,'TOKENS');assert.equal(p.scheduledAt,gameTimestamp('2026-10-19',10));
 assert.equal(getDueState(p,null,gameTimestamp('2026-10-19',9)),null);assert.equal(getDueState(p,null,p.scheduledAt),'queued');assert.equal(getDueState(p,null,gameTimestamp('2026-10-19',16)),'missed');
 for(const date of ['2026-10-18','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24'])assert.equal(generateDayPlan(date).filter(p=>p.scheduleId==='tokenRefresh').length,0);
});
test('weekly refresh uses only enabled bound groups, filters deleted IDs and deduplicates overlap', () => {
 const plan = { scheduleId: 'tokenRefresh', batchId: 'TOKENS' };
 const cfg = { batches: { A: { groupId: 'ga' }, B: { groupId: 'gb' }, C: { groupId: 'gc', enabled: false } } };
 const groups = [{ id: 'ga', tokenIds: ['a', 'a', 'deleted'] }, { id: 'gb', tokenIds: ['a', 'b'] }, { id: 'gc', tokenIds: ['c'] }, { id: 'unused', tokenIds: ['outside'] }];
 const tokens = ['a', 'b', 'c', 'outside', 'ungrouped'].map(id => ({ id }));
 assert.deepEqual(resolvePlanTokens(plan, cfg, groups, tokens), { status: 'ready', reason: '', tokenIds: ['a', 'b'] });
 // Ordinary game tasks retain the overlap guard.
 assert.equal(resolvePlanTokens({ scheduleId: 'daily', batchId: 'A' }, cfg, groups, tokens).status, 'skipped');
 cfg.batches.C.enabled = true;
 assert.deepEqual(resolvePlanTokens(plan, cfg, groups, tokens).tokenIds, ['a', 'b', 'c']);
});
test('empty, unbound, missing or disabled weekly groups never fall back to local accounts', () => {
 const plan = { scheduleId: 'tokenRefresh', batchId: 'TOKENS' };
 for (const cfg of [{}, { batches: { A: { groupId: 'missing' } } }, { batches: { A: { groupId: 'g', enabled: false } } }, { batches: { A: { groupId: 'empty' } } }]) {
  const r = resolvePlanTokens(plan, cfg, [{ id: 'g', tokenIds: ['a'] }, { id: 'empty', tokenIds: ['deleted'] }], [{ id: 'a' }]);
  assert.equal(r.status, 'skipped'); assert.deepEqual(r.tokenIds, []); assert.match(r.reason, /已启用分组中没有可用账号/);
 }
});
for(const method of ['url','bin','wxQrcode'])test(method+' refresh persists credentials without reconnecting',async()=>{
 const h=refreshHarness(method);const result=await h.refreshTokenForSchedule('a');assert.equal(result.status,'completed');assert.equal(h.data.value[0].token,'new');assert.equal(h.reconnects,0);assert.equal(method==='url'?h.limited:h.auth,1);assert.doesNotMatch(JSON.stringify(h.logs),/https:\/\/fixture|old|new/);
});
test('legacy refresh retains boolean contract, reconnect option, and cooldown',async()=>{
 const h=refreshHarness();assert.equal(await h.attemptTokenRefresh('a',true),true);assert.equal(h.reconnects,1);assert.equal(await h.attemptTokenRefresh('a'),false);assert.equal(h.limited,1);
});
test('missing original credentials and unsupported methods skip with reasons',async()=>{
 for(const [method,overrides]of [['manual',{}],['bin',{getArrayBuffer:async()=>null}],['url',{}]]){
  const h=refreshHarness(method,overrides);if(method==='url')h.data.value[0].sourceUrl='';const r=await h.refreshTokenForSchedule('a');assert.equal(r.status,'skipped');assert.ok(r.reason);
 }
});
test('old BIN name fallback migrates successfully',async()=>{
 const keys=[],saved=[],deleted=[];const h=refreshHarness('bin',{getArrayBuffer:async k=>{keys.push(k);return k==='A'?new ArrayBuffer(2):null;},storeArrayBuffer:async k=>{saved.push(k);return true;},deleteArrayBuffer:async k=>deleted.push(k)});
 assert.equal((await h.refreshTokenForSchedule('a')).status,'completed');assert.deepEqual(keys,['a','A']);assert.deepEqual(saved,['a']);assert.deepEqual(deleted,['A']);
});
test('HTTP failures retain status and auth exceptions never log credentials',async()=>{
 const a=refreshHarness('url',{fetch:async()=>({ok:false,status:503})});assert.match((await a.refreshTokenForSchedule('a')).reason,/503/);
 const b=refreshHarness('bin',{transformToken:async()=>{throw {message:'BIN_SECRET',response:{status:401},config:{data:'BIN_SECRET'}};}});const r=await b.refreshTokenForSchedule('a');assert.equal(r.status,'failed');assert.match(r.reason,/401/);assert.doesNotMatch(JSON.stringify([r,b.logs]),/BIN_SECRET/);
});
test('concurrent same-account refresh authenticates only once',async()=>{
 let release;const gate=new Promise(r=>{release=r;});let count=0;
 const h=refreshHarness('bin',{transformToken:async()=>{count++;await gate;return 'new';}});const first=h.refreshTokenForSchedule('a');const second=await h.refreshTokenForSchedule('a');assert.equal(second.status,'warning');release();assert.equal((await first).status,'completed');assert.equal(count,1);
});
test('local persistence failure is warning rather than false success',async()=>{
 const h=refreshHarness('url',{localStorage:{getItem:()=> '[]'}});assert.equal((await h.refreshTokenForSchedule('a')).status,'warning');
});
test('task refresh is serial and deduplicated and continues after individual failure',async()=>{
 let active=0,peak=0;const called=[];const deps={selectedTokens:{value:['a','b','a','c']},tokenStatus:{value:{}},shouldStop:{value:false},isRunning:{value:false},addLog(){},tokenStore:{refreshTokenForSchedule:async id=>{active++;peak=Math.max(peak,active);called.push(id);await Promise.resolve();active--;if(id==='b')throw new Error('failure');return{status:'completed',reason:'done'};}}};
 const result=await createTasksToken(deps).batchRefreshTokens();assert.deepEqual(called,['a','b','c']);assert.equal(peak,1);assert.deepEqual(result.map(r=>r.status),['completed','failed','completed']);assert.equal(deps.isRunning.value,false);
});
function memory(){const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),key:i=>[...m.keys()][i],get length(){return m.size;}};}
function locks(){const held=new Set();return{async request(name,opts,fn){if(held.has(name))return fn(null);held.add(name);try{return await fn({name});}finally{held.delete(name);}}};}
const flush=()=>new Promise(r=>setImmediate(r));
test('two tabs and reload execute Monday refresh once; manual retry cannot duplicate it',async()=>{
 const storage=createScheduleStorage(memory());storage.saveConfig({enabled:true,batches:{A:{groupId:'g'}}});const lock=locks();let calls=0;const jobs=[];
 const make=()=>createAutoScheduler({storage,locks:lock,now:()=>gameTimestamp('2026-10-19',10),getGroups:()=>[{id:'g',tokenIds:['a']}],getTokens:()=>[{id:'a'},{id:'outside'}],enqueue:(p,k,run)=>{const job=run();jobs.push(job);return job;},execute:async task=>{assert.deepEqual(task.selectedTokens,['a']);calls++;return{status:'completed'};}});
 const a=make(),b=make();a.poll();b.poll();await Promise.all(jobs);assert.equal(calls,1);const r=storage.list()[0];assert.equal(canRetry({...r,status:'failed'},[]),false);a.dispose();b.dispose();await flush();const c=make();c.poll();await Promise.all(jobs);assert.equal(calls,1);c.dispose();
});
test('interrupted refresh record becomes unverified and is never replayed',async()=>{
 const storage=createScheduleStorage(memory());storage.saveConfig({enabled:true});const p=generateDayPlan('2026-10-19').find(p=>p.scheduleId==='tokenRefresh');storage.put(p.executionKey,{...p,status:'running'});let calls=0;
 const r=createAutoScheduler({storage,locks:locks(),now:()=>p.scheduledAt,getGroups:()=>[],getTokens:()=>[{id:'a'}],enqueue:(p,k,run)=>run(),execute:async()=>{calls++;return{status:'completed'};}});r.poll();await flush();assert.equal(calls,0);assert.equal(storage.get(p.executionKey).status,'warning');r.dispose();
});

test('queued weekly refresh resolves group membership and batch enablement at execution time', async () => {
 const storage = createScheduleStorage(memory());
 storage.saveConfig({ enabled: true, batches: { A: { groupId: 'old' }, B: { groupId: 'disabled-later' } } });
 let groups = [{ id: 'old', tokenIds: ['a'] }, { id: 'disabled-later', tokenIds: ['b'] }];
 const queued = [], calls = [];
 const scheduler = createAutoScheduler({ storage, locks: locks(), now: () => gameTimestamp('2026-10-19', 10),
  getGroups: () => groups, getTokens: () => ['a', 'b', 'c', 'outside'].map(id => ({ id })),
  enqueue: (plan, key, run) => new Promise(resolve => queued.push(async () => { await run(); resolve(); })),
  execute: async task => { calls.push(task); return { status: 'completed' }; },
 });
 scheduler.poll(); await flush(); assert.equal(queued.length, 1);
 storage.saveConfig({ enabled: true, batches: { A: { groupId: 'new' }, B: { groupId: 'disabled-later', enabled: false } } });
 groups = [{ id: 'new', tokenIds: ['c', 'deleted'] }, { id: 'disabled-later', tokenIds: ['b'] }];
 await queued[0]();
 assert.deepEqual(calls.map(task => task.selectedTokens), [['c']]);
 assert.deepEqual(calls[0].selectedTasks, ['batchRefreshTokens']);
 assert.equal(storage.list()[0].tokenCount, 1);
 scheduler.dispose(); await flush();
});
test('weekly refresh skips empty groups and a switch disabled while queued', async () => {
 for (const disable of [false, true]) {
  const storage = createScheduleStorage(memory());
  storage.saveConfig({ enabled: true, batches: disable ? { A: { groupId: 'g' } } : {} });
  const queued = []; let calls = 0;
  const scheduler = createAutoScheduler({ storage, locks: locks(), now: () => gameTimestamp('2026-10-19', 10),
   getGroups: () => [{ id: 'g', tokenIds: ['a'] }], getTokens: () => [{ id: 'a' }],
   enqueue: (plan, key, run) => new Promise(resolve => queued.push(async () => { await run(); resolve(); })),
   execute: async () => { calls++; return { status: 'completed' }; },
  });
  scheduler.poll(); await flush(); assert.equal(queued.length, 1);
  if (disable) storage.saveConfig({ ...storage.loadConfig(), enabled: false });
  await queued[0](); assert.equal(calls, 0);
  assert.equal(storage.list()[0].status, 'skipped');
  assert.match(storage.list()[0].reason, disable ? /已关闭/ : /已启用分组中没有可用账号/);
  scheduler.dispose(); await flush();
 }
});

const viewSource = readFileSync(new URL('../src/views/BatchDailyTasks.vue', import.meta.url), 'utf8');
function manualRefreshHarness(refresh) {
 const refs = { selectedTokens: { value: ['selected'] }, tokenStatus: { value: {} }, shouldStop: { value: true },
  isRunning: { value: false }, autoExecutionActive: { value: false }, scheduledExecutionActive: { value: false } };
 const called = [];
 const { batchRefreshTokens } = createTasksToken({ ...refs, addLog() {}, tokenStore: { refreshTokenForSchedule: async id => {
  called.push(id); return refresh ? refresh(id, refs) : { status: 'completed', reason: 'done' };
 } } });
 const handler = viewSource.slice(viewSource.indexOf('const handleRefreshTokens ='), viewSource.indexOf('const tasksHangUp ='));
 const injected = { ...refs, batchRefreshTokens };
 const run = new Function(...Object.keys(injected), handler + '; return handleRefreshTokens;')(...Object.values(injected));
 return { refs, called, run };
}
test('daily refresh runs selected accounts only and clears the previous manual stop', async () => {
 const h = manualRefreshHarness();
 h.refs.selectedTokens.value = ['selected', 'another', 'selected'];
 const results = await h.run();
 assert.deepEqual(h.called, ['selected', 'another']);
 assert.deepEqual(results.map(r => r.status), ['completed', 'completed']);
 assert.equal(h.refs.shouldStop.value, false); assert.equal(h.refs.isRunning.value, false);
});
test('daily refresh respects stop during a run and a new manual run can start afterwards', async () => {
 const h = manualRefreshHarness(async (id, refs) => { refs.shouldStop.value = true; return { status: 'completed', reason: 'done' }; });
 h.refs.selectedTokens.value = ['first', 'second'];
 const results = await h.run();
 assert.deepEqual(h.called, ['first']); assert.deepEqual(results.map(r => r.status), ['completed', 'stopped']);
 h.refs.selectedTokens.value = ['second']; await h.run(); assert.deepEqual(h.called, ['first', 'second']);
});
test('daily refresh does not interrupt active manual, weekly or scheduled tasks', async () => {
 for (const flag of ['isRunning', 'autoExecutionActive', 'scheduledExecutionActive']) {
  const h = manualRefreshHarness(); h.refs[flag].value = true; await h.run();
  assert.deepEqual(h.called, []); assert.equal(h.refs.shouldStop.value, true);
 }
 const h = manualRefreshHarness(); h.refs.selectedTokens.value = []; await h.run(); assert.deepEqual(h.called, []);
});
test('rapid daily refresh clicks cannot overlap and selection changes do not extend an in-flight batch', async () => {
 let finish; const gate = new Promise(resolve => { finish = resolve; });
 const h = manualRefreshHarness(async () => { await gate; return { status: 'completed', reason: 'done' }; });
 const first = h.run(); assert.equal(h.refs.isRunning.value, true);
 h.refs.selectedTokens.value = ['unselected-before']; await h.run();
 finish(); await first;
 assert.deepEqual(h.called, ['selected']); assert.equal(h.refs.isRunning.value, false);
});

test('legacy configuration imports recover URL/BIN refresh without losing account ID', async () => {
 for (const type of ['url', 'bin', 'missing']) {
  const h=refreshHarness('import', type==='missing'?{getArrayBuffer:async()=>null}:{});
  if(type!=='url')h.data.value[0].sourceUrl=null;
  const r=await h.refreshTokenForSchedule('a');
  assert.equal(r.status,type==='missing'?'skipped':'completed');
  assert.equal(h.data.value[0].id,'a');
  if(type!=='missing')assert.equal(h.data.value[0].importMethod,type);
  else {assert.match(r.reason,/缺少原始 BIN/);assert.equal(h.auth,0);}
 }
});

test('周一统一刷新验证 A/B/C 全部八种开关组合、原键、去重和全关零入队', async () => {
  const ids = ['A', 'B', 'C'];
  const groups = ids.map(id => ({ id, tokenIds: [id, 'shared', 'deleted'] }));
  for (let mask = 0; mask < 8; mask++) {
    const selected = ids.filter((_, i) => mask & (1 << i));
    const batches = Object.fromEntries(ids.map(id => [id, { groupId: id, taskEnabled: { tokenRefresh: selected.includes(id) } }]));
    const storage = createScheduleStorage(memory());
    storage.saveConfig({ enabled: true, batches });
    const [plan, ...extra] = generateDayPlan('2026-10-19', { batches }).filter(p => p.scheduleId === 'tokenRefresh');
    assert.deepEqual(extra, []); assert.equal(plan.executionKey, 'autoWeekly:20261019:tokenRefresh:TOKENS');
    assert.equal(plan.enabled, selected.length > 0);
    const queued = [], calls = []; let now = plan.scheduledAt;
    const runtime = createAutoScheduler({ storage, locks: locks(), now: () => now,
      getGroups: () => groups, getTokens: () => [...ids, 'shared'].map(id => ({ id })),
      enqueue: (p, key, run) => { queued.push(key); return run(); },
      execute: async task => { calls.push(task.selectedTokens); return { status: 'completed' }; },
    });
    runtime.poll(); await flush(); now += 360000; runtime.tick(); await flush();
    const expected = [...new Set(selected.flatMap(id => [id, 'shared']))];
    assert.deepEqual(calls, mask ? [expected] : []); assert.deepEqual(queued, mask ? [plan.executionKey] : []);
    assert.equal(storage.get(plan.executionKey)?.status ?? null, mask ? 'completed' : null);
    runtime.dispose(); await flush();
  }
});

test('排队后的统一刷新重新读取各批单项开关，全部关闭则静默跳过', async () => {
  for (const any of [true, false]) {
    const storage = createScheduleStorage(memory()), calls = [], logs = [];
    const groups = ['A', 'B', 'C'].map(id => ({ id, tokenIds: [id] }));
    storage.saveConfig({ enabled: true, batches: Object.fromEntries(groups.map(({ id }) => [id, { groupId: id }])) });
    let runQueued;
    const runtime = createAutoScheduler({ storage, locks: locks(), now: () => gameTimestamp('2026-10-19', 10),
      getGroups: () => groups, getTokens: () => groups, log: (...args) => logs.push(args),
      enqueue: (p, key, run) => new Promise(resolve => { runQueued = async () => { await run(); resolve(); }; }),
      execute: async task => { calls.push(task.selectedTokens); return { status: 'completed' }; },
    });
    runtime.poll(); await flush();
    const config = storage.loadConfig();
    for (const { id } of groups) config.batches[id].taskEnabled.tokenRefresh = any && id !== 'A';
    storage.saveConfig(config); await runQueued();
    assert.deepEqual(calls, any ? [['B', 'C']] : []);
    const result = storage.get('autoWeekly:20261019:tokenRefresh:TOKENS');
    assert.equal(result.status, any ? 'completed' : 'skipped');
    if (!any) { assert.equal(result.disabledBeforeStart, true); assert.deepEqual(logs, []); }
    runtime.dispose(); await flush();
  }
});
