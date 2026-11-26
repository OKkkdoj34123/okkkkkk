import { getActivityCycle } from "../src/utils/autoSchedule/activityCycle.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hang from '../src/utils/batch/hangUpWorkflow.js';
import * as results from '../src/utils/batch/taskResult.js';
import * as connection from '../src/utils/batch/dailyConnectionPolicy.js';
import * as unlocks from '../src/utils/gameFeatureUnlocks.js';
import * as dream from '../src/utils/dreamStatePolicy.js';
import { createBottleTaskContext, runBottleAction } from '../src/utils/batch/bottleWorkflow.js';
import { classifyBatchDailyError } from '../src/utils/batch/dailyErrorPolicy.js';
import { buildBatchDailyPushReport } from '../src/utils/pushPlusNotifier.js';

const read = p => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const strip = s => s.replace(/^import\s[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '').replace(/export (class|function|const)/g, '$1');
const fastHang = Object.fromEntries(Object.entries(hang).map(([key,fn]) => [key,key.startsWith('run') ? opts => fn({...opts,delay:async()=>{}}) : fn]));
const NOW = Date.parse('2026-10-22T12:00:00+08:00');
const injected = {getActivityCycle,...fastHang,...results,...connection,...unlocks,createBottleTaskContext,
  runBottleAction:opts=>runBottleAction({...opts,delay:async()=>{}}),useTokenStore:()=>{},extractDreamBattleTeam:()=>({0:107}),
  dailyDreamPreflight:r=>dream.dailyDreamPreflight(r,NOW),getDreamRound:()=>dream.getDreamRound(NOW),
  setTimeout:cb=>{cb();return 0;},createWeirdTowerIntegrated:()=>({}),getTowerActId:()=>1,normalizeWeirdTowerMaxClimb:x=>x};
const factory = (file,name,overrides={}) => { const scope={...injected,...overrides};return new Function(...Object.keys(scope),strip(read(file))+';return '+name+';')(...Object.values(scope)); };
const Legacy=factory('utils/batch/tasksLegacy.js','createTasksLegacy');
const Hang=factory('utils/batch/tasksHangUp.js','createTasksHangUp');
const Runner=factory('utils/dailyTaskRunner.js','DailyTaskRunner');
const settings={bossFormation:1,arenaFormation:1,bossTimes:0,claimBottle:true,claimHangUp:true,freeGachaEnable:false};
const serverError=code=>Object.assign(new Error(`服务器错误: ${code} - ${code===12400000?'挂机奖励领取过于频繁':'测试错误'}`),{code});
function harness({reject,context=createBottleTaskContext({dailyGoal:true})}={}) {
  const calls=[],logs=[],records=[];
  let connects=0,releases=0;
  const state={role:{levelId:9000,roleId:1,bottleHelpers:{helperStopTime:1},dailyTask:{complete:Object.fromEntries(Array.from({length:25},(_,i)=>[i,-1]))},dungeon:{beginTime:NOW/1000,battleTeam:{0:{heroId:107,hp:0}}}}};
  const store={gameData:{},gameTokens:[{id:'A',name:'Account A'}],getWebSocketStatus:()=> 'connected',closeWebSocketConnection(){},
    sendGetRoleInfo:async()=>state,sendMessageWithPromise:async(id,cmd)=>{
      calls.push(cmd);const error=reject?.(cmd);if(error)throw error;
      if(cmd === 'activity_get') return { activity: { activity: [] } };
      if(cmd==='role_getroleinfo')return state;
      if(cmd==='presetteam_getinfo')return{presetTeamInfo:{useTeamId:1}};
      return {};
    }};
  const deps={selectedTokens:{value:['A']},tokens:{value:store.gameTokens},tokenStore:store,
    tokenStatus:{value:{},recordResult:(id,status,details,warnings,meta)=>records.push({id,status,details,warnings,...meta})},
    isRunning:{value:false},shouldStop:{value:false},currentRunningTokenId:{value:null},
    ensureConnection:async()=>{connects++;},releaseConnectionSlot:()=>{releases++;},connectionQueue:{active:0},batchSettings:{maxActive:3},
    bottleTaskContext:context,addLog:l=>logs.push(l),message:{success(){},warning(){}}};
  const daily=(productionLogs=false,verboseLogs=false)=>new Runner(store,{commandDelay:0,taskDelay:0},{classifyError:classifyBatchDailyError,bottleTaskContext:context,productionLogs,verboseLogs})
    .run('A',{onLog:l=>logs.push(l)},settings);
  return {calls,logs,records,deps,state,daily,legacy:()=>Legacy(deps).batchLegacyClaim(),hangup:()=>Hang(deps).claimHangUpRewards(),get connects(){return connects;},get releases(){return releases;}};
}
for(const order of [['legacy','daily','hangup'],['legacy','hangup','daily'],['daily','legacy','hangup'],['daily','hangup','legacy'],['hangup','legacy','daily'],['hangup','daily','legacy']]) {
  test('three real legacy entries share one write: '+order.join(' -> '),async()=>{
    const h=harness();for(const method of order)await h[method]();
    assert.equal(h.calls.filter(c=>c==='legacy_claimhangup').length,1);
    assert.equal(h.records.some(r=>['failed','partial'].includes(r.status)),false);
    assert.ok(h.logs.some(l=>l.message.includes('复用本轮前序结果')));
  });
}
for(const code of [800040,12400000])test('legacy '+code+' remains visible in actual executor and push; no duplicate writes',async()=>{
  const h=harness({reject:cmd=>cmd==='legacy_claimhangup'?serverError(code):null});
  await h.hangup();const [r]=await h.legacy();
  assert.equal(h.calls.filter(c=>c==='legacy_claimhangup').length,1);
  assert.equal(r.status,'failed');assert.match(r.details[0],new RegExp(String(code)));
  const text=JSON.stringify(buildBatchDailyPushReport({taskName:'t',startedAt:NOW,finishedAt:NOW+1000,selectedTaskCount:1,
    accounts:[{name:'A',status:r.status,exceptions:r.details,verificationDetails:r.verificationDetails}]}));
  assert.match(text,new RegExp(String(code)));assert.doesNotMatch(text,/未提供详细原因/);
});
test('cached legacy timeout stays pending, no reconnect, no replay',async()=>{
  const h=harness({reject:c=>c==='legacy_claimhangup'?new Error('请求超时'):null});
  const [a]=await h.legacy();const connections=h.connects;const [b]=await h.legacy();
  assert.equal(a.verificationRequired,true);assert.equal(b.verificationRequired,true);
  assert.equal(b.status,'warning');assert.equal(h.connects,connections);assert.equal(h.calls.length,1);
});
test('legacy success requires no reward payload indexing and next manual invocation is fresh',async()=>{
  const h=harness();delete h.deps.bottleTaskContext;
  for(let i=0;i<2;i++){const [r]=await h.legacy();assert.equal(r.status,'completed');}
  assert.equal(h.calls.length,2);assert.equal(h.releases,2);
});
test('simultaneous independent legacy entry factories share pending result',async()=>{
  const h=harness();const pairs=await Promise.all([h.legacy(),h.legacy()]);
  assert.equal(h.calls.length,1);assert.deepEqual(pairs.map(x=>x[0].status),['completed','skipped']);
});
test('legacy connection failure clears running state and reports uncertainty',async()=>{
  const h=harness();h.deps.ensureConnection=async()=>{throw new Error('连接失败，超时');};
  const [r]=await h.legacy();assert.equal(r.verificationRequired,true);assert.equal(h.deps.isRunning.value,false);assert.equal(h.releases,1);
});
test('formal daily logging preserves requests/results while suppressing routine noise',async()=>{
  const reject=cmd=>['task_claimdailyreward','task_claimweekreward'].includes(cmd)?serverError(200020):cmd==='task_claimdailypoint'?serverError(700020):null;
  const ordinary=harness({reject}),formal=harness({reject});
  const a=await ordinary.daily(false),b=await formal.daily(true);
  assert.deepEqual(formal.calls,ordinary.calls);assert.deepEqual(b,a);
  assert.equal(b.verificationCount,0);assert.equal(b.warningCount,0);assert.equal(b.failedCount,0);
  for(const cmd of ['task_claimdailyreward','task_claimweekreward']) {assert.equal(formal.calls.filter(c=>c===cmd).length,1);assert.ok(b.taskResults.some(r=>r.requestCmd===cmd&&r.status==='completed'&&r.code===200020&&r.normalResponse));}
  const text=formal.logs.map(l=>l.message).join('\n');
  assert.doesNotMatch(text,/奖励领取诊断|执行结果未确认|200020/);
  assert.doesNotMatch(text,/700020|执行:|角色信息获取成功|日常处理结束/);
  assert.ok(formal.logs.every(l=>l.message.startsWith('[日常][Account A]')));
});
test('formal daily logs keep real failures with account labels',async()=>{
  const h=harness({reject:cmd=>cmd==='task_claimdailyreward'?serverError(400030):null});
  const r=await h.daily(true);assert.equal(r.failedCount,1);assert.ok(h.logs.some(l=>l.type==='error'&&/400030/.test(l.message)));
});
test('actual Vue wrapper emits one formal summary with skipped and pending counts',async()=>{
  const vue=read('views/BatchDailyTasks.vue'),start=vue.indexOf('const startBatch ='),end=vue.indexOf('const stopBatch =',start);
  const logs=[];let runnerOptions;
  class FakeRunner {constructor(store,delays,options){runnerOptions=options;}async run(){return{completedCount:7,skippedCount:5,warningCount:22,verificationCount:2,failedCount:0,failedTasks:[],warningTasks:[{name:'日常奖励',code:200020,warning:'执行结果未确认'}]};}}
  const scope={...injected,classifyBatchDailyError,DailyTaskRunner:FakeRunner,selectedTokens:{value:['A']},tokens:{value:[{id:'A',name:'A'}]},
    tokenStatus:{value:{}},isRunning:{value:false},scheduledExecutionActive:{value:true},shouldStop:{value:false},ensureConnection:async()=>{},
    batchSettings:{maxActive:3},tokenStore:{closeWebSocketConnectionAsync:async()=>{}},releaseConnectionSlot(){},connectionQueue:{active:0},
    addLog:l=>logs.push(l),currentRunningTokenId:{value:null},message:{success(){},warning(){}}};
  const run=new Function(...Object.keys(scope),vue.slice(start,end)+';return startBatch;')(...Object.values(scope));
  await run();assert.equal(runnerOptions.productionLogs,true);assert.equal(runnerOptions.verboseLogs,true);
  assert.equal(logs.filter(l=>l.message.includes('[日常][A] 结束')).length,1);
  assert.ok(logs.some(l=>/完成7 跳过5 普通警告20 待核验2 异常0/.test(l.message)));
});
test('push distinguishes mixed pending accounts without hiding real details or repeating identical text',()=>{
  const text=JSON.stringify(buildBatchDailyPushReport({taskName:'t',startedAt:NOW,finishedAt:NOW+1000,selectedTaskCount:2,
    accounts:[{name:'A',status:'partial',verificationRequired:true,exceptions:['ONLY_ONCE_12400000'],verificationDetails:['ONLY_ONCE_12400000'],warnings:['HIDDEN_ROUTINE']}]}));
  assert.match(text,/20261023.4/);assert.match(text,/部分异常 1/);assert.match(text,/含待核验账号 1/);assert.match(text,/部分异常（含待核验）/);
  assert.equal(text.split('ONLY_ONCE_12400000').length-1,1);assert.doesNotMatch(text,/HIDDEN_ROUTINE/);
});

function towerHarness({postReadErrors=0,code=200400,initialError=false,fightError=false,stopOnRecovery=false}={}) {
  const h=harness();let battles=0,reads=0,postReads=0,inRecovery=false;
  const Tower=factory('utils/batch/tasksTower.js','createTasksTower',{setTimeout:cb=>{if(stopOnRecovery&&inRecovery)h.deps.shouldStop.value=true;cb();return 0;}});
  h.deps.currentSettings={towerFormation:1};
  h.deps.tokenStore.sendMessageWithPromise=async(id,cmd)=>{
    h.calls.push(cmd);
    if(initialError&&cmd==='tower_getinfo')throw serverError(200400);
    if(cmd==='fight_starttower'){battles++;if(fightError)throw serverError(200400);return{isWin:true};}
    if(cmd==='presetteam_getinfo')return{presetTeamInfo:{useTeamId:1}};
    return{};
  };
  h.deps.tokenStore.sendGetRoleInfo=async()=>{
    reads++;
    if(battles&&!fightError&&++postReads<=postReadErrors){inRecovery=true;throw serverError(code);}
    return{role:{tower:{id:battles&&!fightError?101:100,energy:battles&&!fightError?0:1}}};
  };
  return{...h,run:()=>Tower(h.deps).climbTower(),get battles(){return battles;},get reads(){return reads;}};
}
test('tower postbattle 200400 recovers reads without replaying a successful fight',async()=>{
  const h=towerHarness({postReadErrors:2});await h.run();assert.equal(h.battles,1);assert.equal(h.reads,4);
  assert.equal(h.records.at(-1).status,'completed');assert.match(h.records.at(-1).details[0],/查询重试 2 次/);
});
test('tower exhausted postbattle read budget preserves progress and command in push',async()=>{
  const h=towerHarness({postReadErrors:100});await h.run();const r=h.records.at(-1);
  assert.equal(h.battles,1);assert.equal(h.reads,5);assert.equal(r.status,'partial');
  assert.match(r.details[0],/200400.*命令 role_getroleinfo.*已确认 1 场.*查询重试 3 次/);
});
test('tower non-200400 reads are never retried',async()=>{
  const h=towerHarness({postReadErrors:100,code:800040});await h.run();assert.equal(h.reads,2);assert.equal(h.battles,1);assert.match(h.records.at(-1).details[0],/800040/);
});
test('tower initial query exhaustion sends no battle',async()=>{
  const h=towerHarness({initialError:true});await h.run();assert.equal(h.battles,0);assert.equal(h.calls.length,4);assert.match(h.records.at(-1).details[0],/命令 tower_getinfo/);
});
test('tower stop during read recovery prevents another query or fight',async()=>{
  const h=towerHarness({postReadErrors:100,stopOnRecovery:true});await h.run();assert.equal(h.battles,1);assert.equal(h.reads,2);assert.equal(h.records.at(-1).status,'stopped');
});
test('tower battle rejection retains the existing three-recovery budget',async()=>{
  const h=towerHarness({fightError:true});await h.run();assert.equal(h.battles,4);assert.match(h.records.at(-1).details[0],/命令 fight_starttower.*查询重试 0 次.*战斗恢复 3\/3/);
});

test('detailed batch daily logging changes visibility without changing commands or results',async()=>{
 const compact=harness(),detailed=harness();
 const a=await compact.daily(true,false),b=await detailed.daily(true,true);
 assert.deepEqual(detailed.calls,compact.calls);assert.deepEqual(b,a);
 assert.ok(detailed.logs.length>compact.logs.length);
 assert.ok(detailed.logs.some(l=>/角色信息获取成功/.test(l.message)));
 assert.ok(detailed.logs.every(l=>l.message.startsWith('[日常][Account A]')));
});
