import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildBatchDailyPushReport,BATCH_OVERVIEW_SAFE_BYTES,enqueuePushPlusNotification} from '../src/utils/pushPlusNotifier.js';
import {createBottleTaskContext,runBottleAction} from '../src/utils/batch/bottleWorkflow.js';
import * as resultTools from '../src/utils/batch/taskResult.js';
import {summarizeEntries} from '../src/utils/autoSchedule/scheduleGuard.js';
const report=accounts=>buildBatchDailyPushReport({taskName:'日常',runId:'RUN-1',startedAt:1,finishedAt:2,selectedTaskCount:4,accounts});
test('thousands of failures produce one bounded overview with exact omitted count',()=>{
 const accounts=Array.from({length:2000},(_,i)=>({name:'账号'+i,status:'failed',exceptions:['错误<&>😀'.repeat(300)+'；服务器错误: 400340'],observations:['PRIVATE_DETAIL'.repeat(1000)]}));
 const r=report(accounts);assert.equal(r.parts,undefined);assert.ok(Buffer.byteLength(r.content)<=BATCH_OVERVIEW_SAFE_BYTES);
 assert.match(r.content,/失败 2000/);const shown=Number(r.content.match(/账号明细（(\d+)\/2000账号）/)[1]);
 assert.ok(shown>0 && shown<2000);assert.match(r.content,new RegExp(`另有 ${2000-shown} 个`));assert.match(r.content,/400340/);assert.doesNotMatch(r.content,/PRIVATE_DETAIL/);
});
test('late failed accounts precede earlier pending accounts in limited overview',()=>{
 const accounts=Array.from({length:20},(_,i)=>({name:'PENDING'+i,status:'warning',verificationRequired:true,verificationDetails:['结果待核验']}));
 accounts.push({name:'LATE_FAIL',status:'failed',exceptions:['服务器错误: 800040']});
 const r=report(accounts);assert.match(r.content,/LATE_FAIL/);assert.match(r.content,/待核验 20/);assert.match(r.content,/失败 1/);
});
test('success and ordinary warnings are counted without detail dumps',()=>{
 const r=report([{name:'OK',status:'completed',observations:['SECRET_OBSERVATION']},{name:'WARN',status:'warning',warnings:['ROUTINE_HIDDEN']}]);
 assert.match(r.content,/确认完成 1/);assert.match(r.content,/普通警告 1/);assert.doesNotMatch(r.content,/SECRET_OBSERVATION|ROUTINE_HIDDEN|异常\/待核验摘要/);
});
test('compact notification escapes user-controlled header and names',()=>{
 const r=buildBatchDailyPushReport({taskName:'<script>',runId:'<id>',executionClient:'<client>',taskOrder:['<task>'],startedAt:1,finishedAt:2,accounts:[{name:'<A>',status:'failed',exceptions:['<error>']}]});
 assert.doesNotMatch(r.content,/<script>|<A>|<error>|<task>/);assert.match(r.content,/&lt;A&gt;/);
});
test('console gets full salt receipt and snapshots while result semantics and write count stay fixed',async()=>{
 for(const rejected of [false,true]){
  const calls=[];const result=await runBottleAction({context:createBottleTaskContext(),tokenId:'log-'+rejected,kind:'claim',delay:async()=>{},send:async cmd=>{
   calls.push(cmd);if(cmd==='bottlehelper_claim'){if(rejected)throw Object.assign(new Error('服务器错误: 2000150'),{code:2000150,requestCmd:cmd});return {reward:[{itemId:3005,value:2}],__bottleDiagnostic:{requestCmd:cmd,responseCmd:'syncrewardresp',code:0,requestSeq:2,resp:2,matchMode:'resp'}};}
   return {role:{dailyTask:{complete:{14:-1}},bottleHelpers:{helperStopTime:123,bottleHelper:{0:{obtainCnt:0}},token:'HIDDEN'}}};
  }});
  assert.equal(result.status,rejected?'warning':'completed');assert.match(result.consoleDetail,/领取前.*领取后/);assert.match(result.consoleDetail,/helperStopTime/);assert.doesNotMatch(result.consoleDetail,/HIDDEN|见PushPlus/);
  if(!rejected)assert.match(result.consoleDetail,/奖励数值摘要=.*reward/);
  assert.equal(calls.filter(c=>c==='bottlehelper_claim').length,1);
 }
});
function collector(){
 const vue=readFileSync(new URL('../src/views/BatchDailyTasks.vue',import.meta.url),'utf8');const start=vue.indexOf('const SCHEDULED_TERMINAL_STATUSES');
 const scope={...resultTools,tokens:{value:[{id:'A',name:'Account'}]},tokenStatus:{value:{}},availableTasks:[{value:'task',label:'日常任务'}],summarizeEntries,buildBatchDailyPushReport};
 return new Function(...Object.keys(scope),vue.slice(start,vue.indexOf('const createScopedScheduledTaskFunctions',start))+';return createScheduledReportCollector;')(...Object.values(scope))({name:'fixture',selectedTokens:['A'],selectedTasks:['task']},1);
}
test('collector writes full exception, routine warning and observation to console before truncating push',()=>{
 const c=collector(),logs=[];const long='FAIL_START '+ '汉😀'.repeat(6000)+' FAIL_END';
 c.applyTaskResult('task',[{tokenId:'A',status:'partial',exceptions:[long],warnings:['ROUTINE_DETAIL'],observations:['OBSERVATION_END'],verificationRequired:true,verificationDetails:['PENDING_END']}]);
 const r=c.finish({onLog:l=>logs.push(l)});const text=logs.map(l=>l.message).join('\n');
 for(const s of [long,'ROUTINE_DETAIL','OBSERVATION_END','PENDING_END','20261023.4'])assert.ok(text.includes(s),s.slice(0,50));
 assert.doesNotMatch(r.content,/FAIL_END|ROUTINE_DETAIL|OBSERVATION_END/);assert.equal(r.parts,undefined);
});
test('actual scheduler requests console reporting regardless of notification settings',()=>{
 const vue=readFileSync(new URL('../src/views/BatchDailyTasks.vue',import.meta.url),'utf8');
 assert.match(vue,/reportCollector\.finish\(\{ onLog: addLog \}\)/);assert.match(vue,/productionLogs: true, verboseLogs: true/);
});
test('overview enqueue issues exactly one HTTP request',async()=>{
 let calls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{calls++;return{ok:true,json:async()=>({code:200})};};
 try{const r=report(Array.from({length:100},()=>({name:'A',status:'failed',exceptions:['failure'.repeat(2000)]})));
 const result=await enqueuePushPlusNotification({...r,settings:{enabled:true,token:'TEST_ONLY'}});assert.equal(result.status,'accepted');assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});
