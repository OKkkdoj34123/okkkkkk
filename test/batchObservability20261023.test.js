import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBottleTaskContext, runBottleAction } from '../src/utils/batch/bottleWorkflow.js';
import { createTasksBottle } from '../src/utils/batch/tasksBottle.js';
import * as evidence from '../src/utils/batch/bottleEvidence.js';
import * as resultTools from '../src/utils/batch/taskResult.js';
import { summarizeEntries } from '../src/utils/autoSchedule/scheduleGuard.js';
import { buildBatchDailyPushReport } from '../src/utils/pushPlusNotifier.js';
const read = p => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const serverError = code => Object.assign(new Error(`服务器错误: ${code} - 测试错误`), { code, requestCmd: 'bottlehelper_claim' });
const role = (daily = -1) => ({role:{dailyTask:{complete:{14:daily}},bottleHelpers:{helperStopTime:1792714207,bottleHelper:{1:{count:0,ready:false}}}}});
const receipt = (wire = {}, rewards = [{itemId:1001,value:5}]) => ({reward:rewards,__bottleDiagnostic:{requestCmd:'bottlehelper_claim',responseCmd:'bottlehelper_claimresp',code:0,requestSeq:10,resp:10,matchMode:'resp',...wire}});
let nextId=0;
function harness({ response = receipt(), error, dailyGoal=false, before=role(), after=role(), readError, delay } = {}) {
  const calls=[],waits=[];let reads=0;
  const opts={tokenId:`obs-${++nextId}`,context:createBottleTaskContext({dailyGoal}),kind:'claim',
    delay:async ms=>{waits.push(ms);await delay?.(ms);},
    send:async cmd=>{calls.push(cmd);if(cmd==='role_getroleinfo') {reads++;if(readError?.(reads))throw readError(reads);return reads===1?before:after;}
      if(error)throw error;return response;}};
  return {calls,waits,opts,run:()=>runBottleAction(opts)};
}
test('correlated numeric reward receipt is reported with before/after evidence, one write',async()=>{
 const h=harness();const r=await h.run();assert.equal(r.status,'completed');assert.equal(r.verificationRequired,false);
 assert.match(r.detail,/物品1001×5/);assert.match(r.detail,/seq=10，resp=10/);assert.match(r.detail,/领取前后：日常14=-1→-1/);
 assert.deepEqual(h.calls,['role_getroleinfo','bottlehelper_claim','role_getroleinfo']);assert.equal(h.waits.reduce((a,b)=>a+b,0),1200);
});
for (const response of [{}, {reward:[]}, receipt({},[{itemId:1,value:0}]),receipt({},[{value:5}]), receipt({},[{itemId:1,value:-1}])]) {
 test('empty/unknown/nonpositive reward body remains pending: '+JSON.stringify(response),async()=>{
  const h=harness({response});const r=await h.run();assert.equal(r.status,'warning');assert.equal(r.verificationRequired,true);
  assert.match(r.detail,/已响应，奖励到账待核验/);assert.equal(h.calls.filter(c=>c==='bottlehelper_claim').length,1);
 });
}
for (const wire of [{matchMode:'cmd-fallback'}, {responseCmd:'otherresp'}, {resp:11}, {code:2000150}]) {
 test('unconfirmed correlation never proves reward credit: '+JSON.stringify(wire),async()=>{
  const r=await harness({response:receipt(wire)}).run();assert.equal(r.status,'warning');assert.equal(r.verificationRequired,true);
 });
}
test('2000150 remains visible after daily goal completion and is not resent',async()=>{
 const h=harness({dailyGoal:true,before:role(0),after:role(-1),error:serverError(2000150)});
 const a=await h.run(),b=await h.run();assert.equal(a.status,'warning');assert.equal(b.status,'warning');
 assert.match(b.consoleDetail,/复用前序结果/);assert.match(b.detail,/2000150/);assert.equal(h.calls.filter(c=>c==='bottlehelper_claim').length,1);
});
test('simultaneous claim entries share receipt and pending results without replay',async()=>{
 for(const response of [receipt(),{}]){const h=harness({response});const r=await Promise.all([h.run(),h.run()]);
 assert.equal(h.calls.filter(c=>c==='bottlehelper_claim').length,1);assert.equal(r[1].status,response.reward?'skipped':'warning');}
});
test('fresh scopes show last attempt but never suppress next legitimate standalone claim',async()=>{
 const h=harness({response:{}});await h.run();h.opts.context=createBottleTaskContext();const r=await h.run();
 assert.equal(h.calls.filter(c=>c==='bottlehelper_claim').length,2);assert.match(r.detail,/距本次\d+秒，待核验/);
});
test('snapshot taken before a mutable role object changes is preserved',async()=>{
 const state=role();const h=harness({before:state,after:state});const send=h.opts.send;
 h.opts.send=async cmd=>{const result=await send(cmd);if(cmd==='bottlehelper_claim')state.role.bottleHelpers.bottleHelper[1].count=7;return result;};
 const r=await h.run();assert.match(r.detail,/bottleHelper.1.count:0→7/);
});
test('200350 readback failure stays in report, no retry or second write',async()=>{
 const h=harness({error:serverError(2000150),readError:n=>n===2?serverError(200350):null});const r=await h.run();
 assert.match(r.detail,/2000150/);assert.match(r.detail,/读回失败.*200350/);assert.equal(h.calls.length,3);
});
test('query 200400 is retried twice with spacing, claim stays once',async()=>{
 const h=harness({readError:n=>[2,3].includes(n)?serverError(200400):null});const r=await h.run();
 assert.equal(r.status,'completed');assert.match(r.detail,/查询重试2次/);assert.equal(h.calls.filter(c=>c==='bottlehelper_claim').length,1);
 assert.equal(h.waits.reduce((a,b)=>a+b,0),5700);
});
test('exhausted post-claim rate limit preserves receipt and read failure without replay',async()=>{
 const h=harness({readError:n=>n>=2?serverError(200400):null});const r=await h.run();
 assert.equal(r.status,'completed');assert.match(r.detail,/读回失败.*200400/);assert.equal(h.calls.length,5);
});
test('exhausted preflight rate limit sends zero claims',async()=>{
 const h=harness({readError:()=>serverError(200400)});await assert.rejects(h.run(),e=>e.code===200400);
 assert.equal(h.calls.length,3);assert.equal(h.calls.includes('bottlehelper_claim'),false);
});
test('stop during readback spacing prevents all further commands',async()=>{
 const h=harness({delay:()=>{h.opts.stopped=()=>true;}});let stopped=false;
 h.opts.stopped=()=>stopped;h.opts.delay=async()=>{stopped=true;};
 await assert.rejects(h.run(),e=>e.stopped);assert.deepEqual(h.calls,['role_getroleinfo','bottlehelper_claim']);
});
test('sensitive arbitrary bodies are excluded from evidence and persisted history',()=>{
 const obj={role:{token:'TOPSECRET',bottleHelpers:{helperStopTime:12,token:999,password:888,callbackURL:'https://secret',bottleHelper:{1:{count:7,session:111}}}}};
 const text=evidence.bottleSnapshotText(evidence.bottleSnapshot(obj));assert.match(text,/count.*7/);assert.doesNotMatch(text,/TOPSECRET|999|888|111|https|token|session/);
 const reply=receipt();reply.secret='TOPSECRET';reply.reward[0].token='TOPSECRET';assert.doesNotMatch(evidence.bottleReceipt(reply).summary,/TOPSECRET|secret/);
 const data=new Map();const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)}});
 try{evidence.rememberBottleAttempt('AUTH_SECRET', 'pending',2000150,1000);
  const stored=[...data.values()].join('');assert.doesNotMatch(stored,/AUTH_SECRET/);assert.match(stored,/2000150/);
  assert.match(evidence.previousBottleAttempt('AUTH_SECRET',2000),/距本次1秒/);
  assert.match(evidence.previousBottleAttempt('OTHER',2000),/无近期记录/);
  assert.match(evidence.previousBottleAttempt('AUTH_SECRET',9*86400000),/无近期记录/);
 }finally{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete globalThis.localStorage;}
});
test('storage failure does not change claim behavior',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('disabled');}});
 try{assert.equal((await harness().run()).status,'completed');}finally{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete globalThis.localStorage;}
});
test('actual websocket resolver attaches minimal salt receipt metadata, keeps dream behavior',()=>{
 const src=read('utils/xyzwWebSocket.js').replace(/^import\s[\s\S]*?from\s*["'][^"']+["'];\s*/gm,'').replace(/export (class|const|function)/g,'$1').replace(/export default XyzwWebSocketClient;/,'');
 const Client=new Function('$CacheManager','bonProtocol','g_utils','wsLogger','gameLogger',src+';return XyzwWebSocketClient;')({}, {}, {}, {}, {});
 let result;const client={promises:{7:{originalCmd:'bottlehelper_claim',resolve:r=>result=r,reject:e=>{throw e;}}}};
 Client.prototype._handlePromiseResponse.call(client,{cmd:'bottlehelper_claimresp',resp:7,code:0,rawData:{reward:[{itemId:1,value:2}],secret:'DO_NOT_STORE'}});
 assert.equal(evidence.bottleReceipt(result).confirmed,true);assert.equal(Object.keys(result).includes('__bottleDiagnostic'),false);
 assert.doesNotMatch(JSON.stringify(result.__bottleDiagnostic),/DO_NOT_STORE/);assert.deepEqual(client.promises,{});
});
function collector() {
 const vue=read('views/BatchDailyTasks.vue'),begin=vue.indexOf('const SCHEDULED_TERMINAL_STATUSES');
 const injected={...resultTools,tokens:{value:[{id:'A',name:'Account A'}]},tokenStatus:{value:{}},
 availableTasks:[{value:'salt',label:'一键领取罐子'},{value:'tower',label:'一键爬塔'},{value:'daily',label:'日常任务'}],summarizeEntries,buildBatchDailyPushReport:v=>v};
 const create=new Function(...Object.keys(injected),vue.slice(begin,vue.indexOf('const createScopedScheduledTaskFunctions',begin))+';return createScheduledReportCollector;')(...Object.values(injected));
 return create({name:'test',selectedTokens:['A'],selectedTasks:['salt','tower','daily']},Date.now());
}
test('actual collector preserves success recovery evidence, task order, pending counts and daily records',()=>{
 const c=collector();c.createStatusRef('salt').recordResult('A','warning',['盐罐结果待核验：2000150'],[],{verificationRequired:true});
 c.createStatusRef('tower').recordResult('A','completed',['已确认40场；查询重试6次；战斗恢复2/3']);
 c.applyTaskResult('daily',[{tokenId:'A',status:'completed',observations:['加钟新增0复用4','免费招募：本轮未生成']}]);
 const logs=[];const data=c.finish({onLog:l=>logs.push(l)});assert.deepEqual(data.taskOrder,['一键领取罐子','一键爬塔','日常任务']);assert.ok(data.runId);
 const a=data.accounts[0];assert.equal(a.unverifiedWarningCount,1);assert.equal(a.verificationCount,1);
 const text=logs.map(l=>l.message).join('\n');for(const s of ['查询重试6次','战斗恢复2/3','加钟新增0复用4','免费招募：本轮未生成','2000150'])assert.ok(text.includes(s),s);
 const push=buildBatchDailyPushReport(data);assert.equal(push.parts,undefined);assert.match(push.content,/运行编号|2000150/);assert.doesNotMatch(push.content,/查询重试6次|免费招募：本轮未生成/);
});
test('actual salt executor delivers full receipt diagnostics to console and overview to push',async()=>{
 const c=collector(),h=harness();const logs=[];
 const runner=createTasksBottle({selectedTokens:{value:['A']},tokens:{value:[{id:'A',name:'Account A'}]},tokenStatus:c.createStatusRef('salt'),
 isRunning:{value:false},shouldStop:{value:false},ensureConnection:async()=>{},releaseConnectionSlot(){},
 tokenStore:{sendMessageWithPromise:(id,cmd)=>h.opts.send(cmd),closeWebSocketConnection(){}},addLog:l=>logs.push(l),currentRunningTokenId:{value:null}});
 // Real executor uses a real 1.2s readback pause, exercising the unmodified runtime path.
 await runner.batchlingguanzi();const data=c.finish();const text=JSON.stringify(buildBatchDailyPushReport(data));
 assert.doesNotMatch(text,/物品1001×5|领取前/);assert.match(logs[0].message,/物品1001×5/);assert.match(logs[0].message,/领取前.*领取后/);assert.match(logs[0].message,/seq=10/);
});
test('overview omits successful detail payload and keeps brief escaped failures without pagination',()=>{
 const observations=Array.from({length:40},(_,i)=>`EVIDENCE_${i}:`+'完整记录<&>\n'.repeat(150)+`END_${i}`);
 const r=buildBatchDailyPushReport({taskName:'many',runId:'id',taskOrder:['盐罐'],startedAt:1,finishedAt:2,selectedTaskCount:1,
  accounts:[{name:'A',status:'completed',observations},{name:'<B>',status:'failed',exceptions:['REAL_FAILURE'],warnings:['HIDDEN_ROUTINE']}]});
 assert.equal(r.parts,undefined);assert.ok(Buffer.byteLength(r.content)<=9000);
 assert.doesNotMatch(r.content,/<B>|HIDDEN_ROUTINE|EVIDENCE_/);assert.match(r.content,/&lt;B&gt;/);assert.match(r.content,/REAL_FAILURE/);
});
