import { getActivityCycle } from "../src/utils/autoSchedule/activityCycle.js";
import * as hangUpWorkflow from "../src/utils/batch/hangUpWorkflow.js";
import { getVerificationMetadata } from "../src/utils/batch/taskResult.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBottleTaskContext, runBottleAction, inspectBottleState, bottleStateSummary } from '../src/utils/batch/bottleWorkflow.js';
import { dailyConnectionFailure, markDailyConnectionError } from '../src/utils/batch/dailyConnectionPolicy.js';
import { createTasksBottle } from '../src/utils/batch/tasksBottle.js';
import { classifyBatchDailyError } from '../src/utils/batch/dailyErrorPolicy.js';
import { buildBatchDailyPushReport } from '../src/utils/pushPlusNotifier.js';
import { summarizeEntries } from '../src/utils/autoSchedule/scheduleGuard.js';
import { dailyDreamPreflight, getDreamRound } from '../src/utils/dreamStatePolicy.js';
import * as unlocks from '../src/utils/gameFeatureUnlocks.js';
const fastHangUp = Object.fromEntries(Object.entries(hangUpWorkflow).map(([name, fn]) =>
 [name, name.startsWith('run') ? options => fn({ ...options, delay: async () => {} }) : fn]));
const NOW=Date.parse('2026-10-19T11:22:00+08:00');
const role=(complete=-1)=>({role:{levelId:6805,roleId:1,dailyTask:{complete:{...Object.fromEntries(Array.from({length:20},(_,i)=>[i,-1])),14:complete}},statistics:{},statisticsTime:{},bottleHelpers:{helperStopTime:NOW/1000+100},dungeon:{beginTime:NOW/1000-86400,battleTeam:{0:{heroId:107,hp:0}}}}});
const fastAction=opts=>runBottleAction({...opts,delay:async()=>{}});
function actionHarness({dailyGoal=true,state=role(),reject,after=state}={}){
 const context=createBottleTaskContext({dailyGoal}),calls=[];let reads=0,connects=0;
 const send=async(cmd)=>{calls.push(cmd);if(cmd==='role_getroleinfo')return ++reads===1?state:after;if(cmd==='bottlehelper_claim'&&reject)throw reject;return{};};
 return {context,calls,send,get connects(){return connects;},run:kind=>fastAction({context,tokenId:'A',kind,send,connect:async()=>{connects++;}})};
}
test('daily-complete salt claim skips, without interpreting helper expiry as reward status',async()=>{
 for(const stop of [0,NOW/1000+10000]){const state=role();state.role.bottleHelpers.helperStopTime=stop;const h=actionHarness({state});assert.equal((await h.run('claim')).status,'skipped');assert.deepEqual(h.calls,['role_getroleinfo']);}
});
test('standalone reward claim remains allowed after daily task completion',async()=>{
 const h=actionHarness({dailyGoal:false});assert.equal((await h.run('claim')).status,'warning');assert.equal(h.calls.filter(c=>c==='bottlehelper_claim').length,1);
});
test('missing role/helper state is unverified and sends no claim',async()=>{
 for(const state of [{},{role:{dailyTask:{complete:{14:0}}}}]){const h=actionHarness({state});assert.equal((await h.run('claim')).status,'warning');assert.equal(h.calls.includes('bottlehelper_claim'),false);}
});
test('known incomplete daily marker alone is not a reward-ready flag',()=>{
 assert.equal(inspectBottleState({role:{dailyTask:{complete:{14:0}}}},true).status,'warning');
 assert.equal(inspectBottleState(role(0),true).status,'request');
});
test('same account concurrent duplicate claim shares one request and one connection',async()=>{
 const h=actionHarness({state:role(0)});const result=await Promise.all([h.run('claim'),h.run('claim')]);assert.deepEqual(result.map(r=>r.status),['warning','warning']);assert.equal(h.connects,1);assert.equal(h.calls.filter(c=>c==='bottlehelper_claim').length,1);
});
test('same-chain reset is performed once; new scope permits next scheduled run',async()=>{
 const h=actionHarness();assert.equal((await h.run('reset')).status,'completed');assert.equal((await h.run('reset')).status,'skipped');assert.deepEqual(h.calls,['bottlehelper_stop','bottlehelper_start']);
 await fastAction({context:createBottleTaskContext(),tokenId:'A',kind:'reset',send:h.send});assert.equal(h.calls.length,4);
});
test('accounts never share a claim result',async()=>{
 const h=actionHarness({state:role(0)});await h.run('claim');await fastAction({context:h.context,tokenId:'B',kind:'claim',send:h.send});assert.equal(h.calls.filter(c=>c==='bottlehelper_claim').length,2);
});
test('2000150 with incomplete or unknown readback is warning with bounded diagnostic fields',async()=>{
 for(const after of [role(0),{}]){const h=actionHarness({state:role(0),after,reject:Object.assign(new Error('服务器错误: 2000150 - 未知错误'),{code:2000150,config:{token:'SECRET'}})});const r=await h.run('claim');assert.equal(r.status,'warning');assert.match(r.detail,/2000150.*未确认/);assert.doesNotMatch(r.detail,/SECRET/);assert.equal(h.calls.filter(c=>c==='bottlehelper_claim').length,1);assert.equal((await h.run('claim')).status,'warning');}
 assert.doesNotMatch(bottleStateSummary({role:{token:'SECRET',bottleHelpers:{token:'SECRET'},dailyTask:{complete:{14:0}}}}),/SECRET/);
});
test('2000150 stays unverified even if the daily goal becomes complete',async()=>{
 const error=Object.assign(new Error('server rejected'),{code:2000150});const h=actionHarness({state:role(0),after:role(),reject:error});assert.equal((await h.run('claim')).status,'warning');
 const standalone=actionHarness({dailyGoal:false,state:role(0),after:role(),reject:error});assert.equal((await standalone.run('claim')).status,'warning');
});
test('numeric 2000150 is never globally classified as ignored',()=>{
 for(const cmd of ['bottlehelper_claim','fight_startdungeon','other'])assert.equal(classifyBatchDailyError({code:2000150,requestCmd:cmd}).level,'error');
});
test('other business codes and command mismatches remain errors',async()=>{
 for(const [code,cmd]of [[3500020,'bottlehelper_claim'],[400340,'bottlehelper_claim'],[2000150,'other']]){
 const error=Object.assign(new Error('real server rejection'),{code,requestCmd:cmd});const h=actionHarness({state:role(0),reject:error});await assert.rejects(h.run('claim'),e=>e===error);await assert.rejects(h.run('claim'),e=>e===error);assert.equal(h.calls.filter(c=>c==='bottlehelper_claim').length,1);}
});
test('stop between salt stop/start prevents restart and surfaces stopped',async()=>{
 let stopped=false;const calls=[];await assert.rejects(fastAction({context:createBottleTaskContext(),tokenId:'a',kind:'reset',stopped:()=>stopped,send:async c=>{calls.push(c);stopped=true;}}),e=>e.stopped);assert.deepEqual(calls,['bottlehelper_stop']);
});
test('failed restart is not retried by another button in the same chain',async()=>{
 const context=createBottleTaskContext(),calls=[];const opts={context,tokenId:'a',kind:'reset',send:async c=>{calls.push(c);if(c==='bottlehelper_start')throw new Error('timeout');}};
 await assert.rejects(fastAction(opts),/停止计时已确认/);await assert.rejects(fastAction(opts),/停止计时已确认/);assert.equal(calls.length,2);
});
const read=p=>readFileSync(new URL('../src/'+p,import.meta.url),'utf8');
const strip=s=>s.replace(/^import\s[\s\S]*?from\s*["'][^"']+["'];\s*/gm,'').replace('export class DailyTaskRunner','class DailyTaskRunner');
const deps={ getActivityCycle,...fastHangUp,...unlocks,createBottleTaskContext,runBottleAction:fastAction,dailyConnectionFailure,markDailyConnectionError,useTokenStore:()=>{},extractDreamBattleTeam:()=>({0:107}),dailyDreamPreflight:r=>dailyDreamPreflight(r,NOW),getDreamRound:()=>getDreamRound(NOW),setTimeout:cb=>{cb();return 0;}};
const Runner=new Function(...Object.keys(deps),strip(read('utils/dailyTaskRunner.js'))+';return DailyTaskRunner;')(...Object.values(deps));
function dailyHarness({context,complete=-1,failCommand,failError,disconnect=false,presetFailure=false}={}){
 const calls=[],logs=[],state=role(complete);let connected=true;
 const tokenStore={gameTokens:[{id:'A',name:'A'}],getWebSocketStatus:()=>connected?'connected':'disconnected',sendGetRoleInfo:async()=>state,sendMessageWithPromise:async(id,cmd)=>{
 calls.push(cmd);if(cmd===failCommand||presetFailure&&cmd==='presetteam_getinfo'){if(disconnect)connected=false;throw failError||new Error('timeout');}
 if(cmd === 'activity_get') return { activity: { activity: [] } };
if(cmd==='role_getroleinfo')return state;if(cmd==='presetteam_getinfo')return{presetTeamInfo:{useTeamId:1}};if(cmd==='bottlehelper_claim')state.role.dailyTask.complete[14]=-1;return{};
 }};
 const runner=new Runner(tokenStore,{commandDelay:0,taskDelay:0},{classifyError:classifyBatchDailyError,bottleTaskContext:context});
 const settings={bossFormation:1,arenaFormation:1,bossTimes:2,claimBottle:true,freeGachaEnable:false,claimHangUp:false,arenaEnable:false,payRecruit:false,claimEmail:false,blackMarketPurchase:false};
 return{runner,tokenStore,calls,logs,state,run:()=>runner.run('A',{onLog:l=>logs.push(l)},settings)};
}
for(const order of ['daily-first','bottle-first'])test(order+' shares actual runner and standalone bottle results',async()=>{
 const context=createBottleTaskContext({dailyGoal:true}),h=dailyHarness({context,complete:0});const opts={context,tokenId:'A',send:(cmd,p,t)=>h.tokenStore.sendMessageWithPromise('A',cmd,p,t)};
 if(order==='bottle-first'){await fastAction({...opts,kind:'claim'});await fastAction({...opts,kind:'reset'});}
 const r=await h.run();assert.equal(r.failedCount,0);
 await fastAction({...opts,kind:'claim'});await fastAction({...opts,kind:'reset'});
 for(const c of ['bottlehelper_claim','bottlehelper_stop','bottlehelper_start'])assert.equal(h.calls.filter(x=>x===c).length,1,c);
});
for (const rejected of [false, true]) test(`claim before daily reset keeps one request and evidence (rejected=${rejected})`, async () => {
 const context = createBottleTaskContext({dailyGoal:true});
 const h = dailyHarness({context,complete:0,
  failCommand:rejected?'bottlehelper_claim':undefined,
  failError:Object.assign(new Error('服务器错误: 2000150 - 未知错误'),{code:2000150})});
 const opts = {context,tokenId:'A',send:async(cmd,p,t)=>{
  const result = await h.tokenStore.sendMessageWithPromise('A',cmd,p,t);
  // Artificial correlated reward, not a live game response.
  return cmd==='bottlehelper_claim'?{reward:[{type:2,itemId:0,value:10}],
   __bottleDiagnostic:{requestCmd:cmd,responseCmd:'syncrewardresp',code:0,requestSeq:1,resp:1,matchMode:'resp'}}:result;
 }};
 const first = await fastAction({...opts,kind:'claim'});
 assert.equal(first.status,rejected?'warning':'completed');
 assert.equal(first.verificationRequired,rejected);
 assert.equal(h.calls.includes('bottlehelper_stop'),false);
 const daily = await h.run();
 assert.equal(daily.failedCount,0);
 const reset = await fastAction({...opts,kind:'reset'});
 assert.equal(reset.reused,true);
 const reused = await fastAction({...opts,kind:'claim'});
 assert.equal(reused.reused,true);
 assert.equal(reused.status,rejected?'warning':'skipped');
 assert.equal(reused.verificationRequired,rejected);
 if(rejected) assert.match(reused.detail,/2000150/);
 assert.deepEqual(h.calls.filter(cmd=>cmd.startsWith('bottlehelper_')),
  ['bottlehelper_claim','bottlehelper_stop','bottlehelper_start']);
});
test('Q587 current completed/dead state skips claim and dream selection',async()=>{
 const context=createBottleTaskContext({dailyGoal:true}),h=dailyHarness({context});const r=await h.run();const extra=await fastAction({context,tokenId:'A',kind:'claim',send:(c,p,t)=>h.tokenStore.sendMessageWithPromise('A',c,p,t)});
 assert.equal(extra.status,'skipped');assert.equal(h.calls.includes('bottlehelper_claim'),false);assert.equal(h.calls.includes('dungeon_selecthero'),false);assert.equal(r.failedCount,0);
});
for(const error of ['请求超时: fight_startboss (12000ms)','WebSocket未连接 [a]'])test('daily halts after '+error,async()=>{
 const h=dailyHarness({failCommand:'fight_startboss',failError:new Error(error)});const r=await h.run();assert.equal(r.aborted,true);assert.ok(r.unexecutedCount>10);assert.equal(h.calls.at(-1),'fight_startboss');assert.equal(h.calls.filter(c=>c==='fight_startboss').length,1);assert.equal(r.failedCount,0);assert.equal(r.warningCount,1);assert.match(r.abortReason,/未重发/);
});
test('disconnected transport aborts even if the thrown error has no standard wording',async()=>{
 const h=dailyHarness({failCommand:'fight_startboss',failError:new Error('connection vanished'),disconnect:true});const r=await h.run();assert.equal(r.aborted,true);assert.equal(h.calls.at(-1),'fight_startboss');
});
test('formation timeout never falls back to a forced switch',async()=>{
 const h=dailyHarness({presetFailure:true});await assert.rejects(h.run(),e=>e.haltDaily);assert.deepEqual(h.calls,['presetteam_getinfo']);
});
test('an already-claimed signin is normal and does not abort unrelated daily steps',async()=>{
 const h=dailyHarness({failCommand:'system_signinreward',failError:Object.assign(new Error('服务器错误: 400190 - 已领取'),{code:400190})});const r=await h.run();assert.equal(r.aborted,false);assert.ok(h.calls.includes('legion_signin'));assert.equal(r.warningCount,0);assert.equal(r.taskResults.find(t=>t.name==='福利签到').status,'skipped');
});
test('manual stop is not misclassified as a connection failure',()=>{
 assert.equal(dailyConnectionFailure({stopped:true,message:'timeout'},{getWebSocketStatus:()=> 'disconnected'},'a'),false);
});
test('new report includes version and task counts, while ordinary warning text remains hidden',()=>{
 const p=buildBatchDailyPushReport({taskName:'t',startedAt:NOW,finishedAt:NOW+47000,selectedTaskCount:4,accounts:[{name:'A',status:'partial',completedCount:2,totalCount:4,taskCounts:{completed:2,warning:1,failed:1},warnings:['ROUTINE_HIDDEN'],exceptions:['real failure']}]});
 const text=JSON.stringify(p);for(const value of ['20261023.4','完成2','跳过0','警告1','异常1','real failure'])assert.ok(text.includes(value));assert.equal(text.includes('ROUTINE_HIDDEN'),false);
});
// Exercise the actual Vue execution boundary: contexts must be shared within a run,
// recreated for the next run, and work for both automatic and custom task orders.
const vue=read('views/BatchDailyTasks.vue');
test('actual Vue scheduler forwards one fresh salt scope through all selected tasks',async()=>{
 const start=vue.indexOf('const SCHEDULED_TERMINAL_STATUSES'), collector=vue.slice(start,vue.indexOf('const createScopedScheduledTaskFunctions',start));
 const at=vue.indexOf('const executeScheduledTask ='),executor=vue.slice(at,vue.indexOf('// 注: boxTypeOptions',at));
 const contexts=[],states=[];
 const injected={getVerificationMetadata,createBottleTaskContext,tokens:{value:[{id:'A'}]},tokenStatus:{value:{}},availableTasks:[],summarizeEntries,buildBatchDailyPushReport:v=>v,acquireTaskPreemption:async()=>null,verifyTaskDependencies:async()=>true,selectedTokens:{value:[]},shouldStop:{value:false},isRunning:{value:false},scheduledExecutionActive:{value:false},tokenStore:{closeWebSocketConnectionAsync:async()=>{}},releasePreemptionLease:async()=>{},addLog(){},isAutoTaskOpen:()=>true,ismengjingActivityOpen:{value:true},isCarActivityOpen:{value:true},isarenaActivityOpen:{value:true},isWeirdTowerActivityOpen:{value:true},enqueuePushPlusNotification:async()=>({status:'disabled'}),resolveScheduledTaskFunction:(name,opts)=>async()=>{contexts.push(opts.bottleTaskContext);opts.tokenStatusRef.value.A='completed';}};
 const run=new Function(...Object.keys(injected),collector+executor+';return executeScheduledTask;')(...Object.values(injected));
 for(const autoWeekly of [true,false])await run({name:'t',selectedTokens:['A'],selectedTasks:['startBatch','resetBottles','batchlingguanzi']},{scheduled:true,autoWeekly,onResult:r=>states.push(r)});
 assert.equal(contexts.length,6);assert.equal(contexts[0],contexts[1]);assert.equal(contexts[1],contexts[2]);assert.notEqual(contexts[0],contexts[3]);assert.equal(contexts[0].dailyGoal,true);assert.ok(states.every(r=>r.status==='completed'));
});
test('actual Vue startBatch never retries an ambiguous runner timeout',async()=>{
 const start=vue.indexOf('const startBatch ='),end=vue.indexOf('const stopBatch =',start),code=vue.slice(start,end);let runs=0,connects=0;
 class TimeoutRunner {async run(){runs++;throw Object.assign(new Error('请求超时: role_getroleinfo'),{haltDaily:true});}}
 const injected={getVerificationMetadata,createBottleTaskContext,dailyConnectionFailure,classifyBatchDailyError,DailyTaskRunner:TimeoutRunner,selectedTokens:{value:['A']},tokens:{value:[{id:'A',name:'A'}]},tokenStatus:{value:{}},isRunning:{value:false},scheduledExecutionActive:{value:true},shouldStop:{value:false},ensureConnection:async()=>{connects++;},batchSettings:{maxActive:3},tokenStore:{getWebSocketStatus:()=> 'connected',closeWebSocketConnectionAsync:async()=>{}},releaseConnectionSlot(){},connectionQueue:{active:0},addLog(){},currentRunningTokenId:{value:null},message:{success(){},warning(){}},setTimeout:cb=>{cb();return 0;}};
 const run=new Function(...Object.keys(injected),code+';return startBatch;')(...Object.values(injected));const result=await run();assert.equal(runs,1);assert.equal(connects,1);assert.equal(result[0].status,'warning');assert.match(result[0].warnings[0],/未重跑整轮/);assert.equal(result[0].warningCount,1);assert.equal(result[0].verificationCount,1);assert.equal(result[0].unexecutedCount,null);assert.match(result[0].observations.join('\n'),/普通警告0，待核验1/);assert.match(result[0].observations.join('\n'),/未执行未知/);
});
test('a disconnected account does not stop other accounts in a shared daily scope',async()=>{
 const context=createBottleTaskContext({dailyGoal:true});
 const bad=dailyHarness({context,failCommand:'fight_startboss',failError:new Error('timeout')});
 // Separate account key in a separate Runner, as in a real batch.
 const good=dailyHarness({context});
 const goodResult=good.runner.run('B',{onLog:l=>good.logs.push(l)},{bossFormation:1,bossTimes:0,claimBottle:true,freeGachaEnable:false});
 const [a,b]=await Promise.all([bad.run(),goodResult]);assert.equal(a.aborted,true);assert.equal(b.aborted,false);assert.ok(good.calls.includes('task_claimdailyreward'));
});
test('salt command-scoped no-reward text does not mask a role-read failure',async()=>{
 const calls=[];await assert.rejects(fastAction({context:createBottleTaskContext(),tokenId:'A',kind:'claim',send:async cmd=>{calls.push(cmd);throw new Error('无可领取盐罐');}}),/无可领取/);assert.deepEqual(calls,['role_getroleinfo']);
});
