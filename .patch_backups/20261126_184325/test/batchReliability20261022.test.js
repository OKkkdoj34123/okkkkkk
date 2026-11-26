import { getActivityCycle } from "../src/utils/autoSchedule/activityCycle.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hang from '../src/utils/batch/hangUpWorkflow.js';
import * as resultTools from '../src/utils/batch/taskResult.js';
import * as connection from '../src/utils/batch/dailyConnectionPolicy.js';
import * as unlocks from '../src/utils/gameFeatureUnlocks.js';
import * as dream from '../src/utils/dreamStatePolicy.js';
import { createBottleTaskContext, runBottleAction } from '../src/utils/batch/bottleWorkflow.js';
import { classifyBatchDailyError } from '../src/utils/batch/dailyErrorPolicy.js';
import { summarizeEntries } from '../src/utils/autoSchedule/scheduleGuard.js';
import { buildBatchDailyPushReport } from '../src/utils/pushPlusNotifier.js';

const read = path => readFileSync(new URL('../src/'+path, import.meta.url), 'utf8');
const strip = source => source.replace(/^import\s[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '')
  .replace(/export (function|class|const)/g, '$1');
const fastHang = Object.fromEntries(Object.entries(hang).map(([name, fn]) =>
  [name, name.startsWith('run') ? options => fn({ ...options, delay: async () => {} }) : fn]));
function harness(extra = {}) {
  const calls = [], waits = [];
  return { calls, waits, options: { context: hang.createHangUpTaskContext(), tokenId: 'A',
    send: async (cmd, params) => { calls.push({cmd,params}); return {}; },
    delay: async ms => { waits.push(ms); }, ...extra } };
}

test('daily share plus repeated add-time and legacy entries send four shares and one legacy claim', async () => {
  const h = harness();
  await hang.runHangUpShare(h.options);
  const first = await hang.runHangUpAddTime(h.options);
  const reused = await hang.runHangUpAddTime(h.options);
  await hang.runHangUpLegacy(h.options);
  const legacy = await hang.runHangUpLegacy(h.options);
  assert.equal(h.calls.filter(c=>c.cmd==='system_mysharecallback').length,4);
  assert.equal(h.calls.filter(c=>c.cmd==='legacy_claimhangup').length,1);
  assert.equal(first.confirmed,4); assert.equal(first.newlyConfirmed,3);
  assert.equal(reused.status,'skipped'); assert.equal(reused.newlyConfirmed,0);
  assert.equal(legacy.status,'skipped');
  assert.ok(h.waits.reduce((a,b)=>a+b,0)>=10000);
});
test('concurrent entries share pending writes per account', async () => {
  const h = harness(); await Promise.all([hang.runHangUpAddTime(h.options),hang.runHangUpAddTime(h.options)]);
  assert.equal(h.calls.length,4);
});
test('new chain and other accounts are never suppressed by an earlier chain', async () => {
  const h=harness();
  await hang.runHangUpLegacy(h.options);
  await hang.runHangUpLegacy({...h.options,tokenId:'B'});
  await hang.runHangUpLegacy({...h.options,context:hang.createHangUpTaskContext()});
  assert.equal(h.calls.length,3);
});
test('400340 stops the remaining shares; later entry inherits failure without sending again', async () => {
  let count=0;
  const h=harness({send:async()=>{count++;throw Object.assign(new Error('服务器错误: 400340 - 未知错误'),{code:400340});}});
  for(let i=0;i<2;i++) {
    const r=await hang.runHangUpAddTime(h.options);
    assert.equal(r.status,'failed'); assert.equal(r.verificationRequired,false); assert.match(r.detail,/后续 3 次未发送/);
  }
  assert.equal(count,1);
});
test('partial add-time preserves exact successful count and failure on reuse', async () => {
  let count=0;
  const h=harness({send:async()=>{if(++count===2)throw new Error('rejected');return{};}});
  const first=await hang.runHangUpAddTime(h.options), later=await hang.runHangUpAddTime(h.options);
  assert.equal(first.status,'partial'); assert.equal(first.confirmed,1);
  assert.equal(later.status,'partial'); assert.equal(later.confirmed,1); assert.equal(later.newlyConfirmed,0);
  assert.equal(count,2);
});
test('legacy 800040 stays failed and is not retried by a second entry', async () => {
  let count=0;const h=harness({send:async()=>{count++;throw Object.assign(new Error('服务器错误: 800040 - 未知错误'),{code:800040});}});
  for(let i=0;i<2;i++)assert.equal((await hang.runHangUpLegacy(h.options)).status,'failed');
  assert.equal(count,1);
});
test('ambiguous share timeout halts subsequent writes and remains unverified', async () => {
  let count=0;const h=harness({send:async()=>{count++;throw new Error('WebSocket未连接');}});
  const r=await hang.runHangUpAddTime(h.options);
  assert.equal(r.status,'warning');assert.equal(r.haltDaily,true);assert.equal(r.verificationRequired,true);assert.equal(count,1);
});
test('stopping during the initial pause prevents sending the write', async () => {
  let stop=false;const h=harness({stopped:()=>stop,delay:async()=>{stop=true;}});
  await assert.rejects(hang.runHangUpAddTime(h.options),e=>e.stopped);
  assert.equal(h.calls.length,0);
});

const factoryDeps={...fastHang,...resultTools,...connection,...unlocks,setTimeout:cb=>{cb();return 0;}};
const makeHang=new Function(...Object.keys(factoryDeps),strip(read('utils/batch/tasksHangUp.js'))+';return createTasksHangUp;')(...Object.values(factoryDeps));
function batchHarness({reject,level=9000,context=createBottleTaskContext()}={}) {
  const calls=[],results=[];
  const deps={selectedTokens:{value:['A']},tokens:{value:[{id:'A',name:'A'}]},
    tokenStatus:{value:{},recordResult:(...args)=>results.push(args)},isRunning:{value:false},shouldStop:{value:false},
    currentRunningTokenId:{value:null},connectionQueue:{active:0},batchSettings:{maxActive:2},
    ensureConnection:async()=>{},releaseConnectionSlot(){},addLog(){},message:{success(){}},bottleTaskContext:context,
    tokenStore:{gameData:{},getWebSocketStatus:()=> 'connected',closeWebSocketConnection(){},
      sendGetRoleInfo:async()=>({role:{levelId:level}}),sendMessageWithPromise:async(id,cmd)=>{
        calls.push(cmd);if(reject?.(cmd))throw reject(cmd);return{};
      }}};
  return {calls,results,deps,run:()=>makeHang(deps).claimHangUpRewards()};
}
test('hangup report separates one actual reward claim, four shares, and a legacy failure', async () => {
  const h=batchHarness({reject:cmd=>cmd==='legacy_claimhangup'?new Error('800040'):null});
  const [r]=await h.run();
  assert.equal(r.status,'partial');assert.match(r.details[0],/挂机领奖：本入口已确认 1 次/);
  assert.match(r.details[0],/加钟：本轮已确认 4\/4 次/);assert.match(r.details[0],/800040/);
  assert.doesNotMatch(r.details[0],/已确认 5 次操作/);
});
test('hangup connection loss after reward sends no legacy claim and releases connection', async () => {
  const h=batchHarness({reject:cmd=>cmd==='system_mysharecallback'?new Error('timeout'):null});
  let released=0;h.deps.releaseConnectionSlot=()=>released++;
  const [r]=await h.run();assert.equal(r.status,'warning');assert.equal(r.verificationRequired,true);
  assert.deepEqual(h.calls,['system_claimhangupreward','system_mysharecallback']);assert.equal(released,1);
});

const NOW=Date.parse('2026-10-22T12:00:00+08:00');
const runnerDeps={getActivityCycle,...fastHang,...unlocks,...connection,createBottleTaskContext,
  runBottleAction:opts=>runBottleAction({...opts,delay:async()=>{}}),
  dailyDreamPreflight:r=>dream.dailyDreamPreflight(r,NOW),getDreamRound:()=>dream.getDreamRound(NOW),
  useTokenStore:()=>{},extractDreamBattleTeam:()=>({0:107}),setTimeout:cb=>{cb();return 0;}};
const Runner=new Function(...Object.keys(runnerDeps),strip(read('utils/dailyTaskRunner.js'))+';return DailyTaskRunner;')(...Object.values(runnerDeps));
for(const order of ['daily-first','hangup-first']) test(order+' shares real daily/outer workflows while preserving actual reward collection', async () => {
  const context=createBottleTaskContext({dailyGoal:true}),calls=[];
  const state={role:{levelId:9000,roleId:1,bottleHelpers:{helperStopTime:1},dailyTask:{complete:Object.fromEntries(Array.from({length:25},(_,i)=>[i,-1]))},dungeon:{beginTime:NOW/1000,battleTeam:{0:{heroId:107,hp:0}}}}};
  state.role.dailyTask.complete[2]=0;state.role.dailyTask.complete[5]=0;
  let claims=0;
  const store={gameData:{},gameTokens:[{id:'A',name:'A'}],getWebSocketStatus:()=> 'connected',closeWebSocketConnection(){},
    sendGetRoleInfo:async()=>state,sendMessageWithPromise:async(id,cmd)=>{
      calls.push(cmd);
      if(cmd==='system_claimhangupreward'&&++claims>=5)state.role.dailyTask.complete[5]=-1;
      if(cmd==='role_getroleinfo')return state;
      if(cmd==='presetteam_getinfo')return{presetTeamInfo:{useTeamId:1}};
      return{};
    }};
  const runner=new Runner(store,{commandDelay:0,taskDelay:0},{classifyError:classifyBatchDailyError,bottleTaskContext:context});
  const batch=batchHarness({context});batch.deps.tokenStore=store;
  const daily=()=>runner.run('A',{}, {bossFormation:1,arenaFormation:1,bossTimes:0,claimBottle:true,claimHangUp:true,freeGachaEnable:false});
  if(order==='hangup-first')await batch.run();
  const r=await daily();assert.equal(r.aborted,false);assert.equal(r.failedCount,0);
  if(order==='daily-first')await batch.run();
  assert.equal(calls.filter(c=>c==='system_mysharecallback').length,4);
  assert.equal(calls.filter(c=>c==='legacy_claimhangup').length,1);
  assert.ok(claims>=5);assert.equal(state.role.dailyTask.complete[5],-1);
});

function collector() {
  const vue=read('views/BatchDailyTasks.vue'),begin=vue.indexOf('const SCHEDULED_TERMINAL_STATUSES');
  const injected={...resultTools,tokens:{value:[{id:'A',name:'A'}]},tokenStatus:{value:{}},availableTasks:[],summarizeEntries,buildBatchDailyPushReport:v=>v};
  return new Function(...Object.keys(injected),vue.slice(begin,vue.indexOf('const createScopedScheduledTaskFunctions',begin))+';return createScheduledReportCollector;')(...Object.values(injected))({name:'t',selectedTokens:['A'],selectedTasks:['task']},NOW);
}
test('structured pending metadata survives collector without magic words',()=>{
  const c=collector();c.createStatusRef('task').recordResult('A','warning',['opaque'],[],{verificationRequired:true,verificationDetails:['CHECK_42']});
  const a=c.finish().accounts[0];assert.equal(a.verificationRequired,true);assert.match(a.verificationDetails[0],/CHECK_42/);assert.equal(a.completedCount,0);
  assert.equal(c.snapshot().entries[0].verificationRequired,true);
});
test('legacy unconfirmed wording is visible; routine warnings remain hidden',()=>{
  const c=collector();c.applyTaskResult('task',[{tokenId:'A',status:'warning',warnings:['领取执行结果未确认']}]);
  assert.equal(c.finish().accounts[0].verificationRequired,true);
  const v=resultTools.getVerificationMetadata({status:'warning',warnings:['routine warning']});assert.equal(v.verificationRequired,false);
});
test('dream report counts ten completed and five unverified instead of fifteen ended',()=>{
  const accounts=Array.from({length:15},(_,i)=>({name:'A'+i,status:i<10?'completed':'warning',completedCount:i<10?2:1,totalCount:2,
    verificationRequired:i>=10,verificationDetails:i<10?[]:['查询结果待核验'],warnings:['ROUTINE_HIDDEN']}));
  const text=JSON.stringify(buildBatchDailyPushReport({taskName:'dream',startedAt:NOW,finishedAt:NOW+1000,selectedTaskCount:2,accounts}));
  assert.match(text,/确认完成 10/);assert.match(text,/待核验 5/);assert.doesNotMatch(text,/已结束 15|ROUTINE_HIDDEN/);
});
test('partial failure with pending detail stays partial and retains the pending evidence',()=>{
  const text=JSON.stringify(buildBatchDailyPushReport({taskName:'mixed',startedAt:NOW,finishedAt:NOW+1000,selectedTaskCount:2,
    accounts:[{name:'A',status:'partial',verificationRequired:true,verificationDetails:['结果待核验：断线'],exceptions:['800040']}]}));
  assert.match(text,/部分异常 1/);assert.match(text,/待核验 0/);assert.match(text,/断线/);assert.match(text,/800040/);
});
