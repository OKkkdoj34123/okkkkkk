import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, marked } from "./helpers/studyHarness.js";
import { bottleReceipt } from '../src/utils/batch/bottleEvidence.js';
import { createBottleTaskContext, runBottleAction } from '../src/utils/batch/bottleWorkflow.js';
import { buildBatchDailyPushReport, enqueuePushPlusNotification } from '../src/utils/pushPlusNotifier.js';
// Numeric reward sample from 2026-10-23 log, no account identifiers or credentials.
const sample = (wire = {}, reward = [
 {type:7,itemId:0,value:24976000,ext:0}, {type:2,itemId:0,value:1225,ext:0},
 {type:3,itemId:3005,value:31,ext:0}, {type:3,itemId:1006,value:310,ext:0},
 {type:3,itemId:1003,value:190,ext:0}, {type:3,itemId:3006,value:3,ext:0},
]) => ({reward, __bottleDiagnostic:{requestCmd:'bottlehelper_claim',responseCmd:'syncrewardresp',code:0,requestSeq:53,resp:53,matchMode:'resp',...wire}});
const role = count => ({role:{dailyTask:{complete:{14:-1}},bottleHelpers:{helperStopTime:1792719047,bottleHelper:{0:{obtainCnt:count,endTime:1792698529}}}}});
const report = accounts => buildBatchDailyPushReport({taskName:'Regression',runId:'test-run',startedAt:1,finishedAt:2,selectedTaskCount:4,accounts});
test('observed syncrewardresp is accepted only with exact salt request correlation',()=>{
 assert.equal(bottleReceipt(sample()).confirmed,true);
 for(const wire of [{resp:52},{requestCmd:'other'},{matchMode:'cmd-fallback'},{code:2000150},{responseCmd:'randomresp'},{requestSeq:null}])assert.equal(bottleReceipt(sample(wire)).confirmed,false);
});
test('observed type 2/7 zero-item resources count; unknown zero-item types do not',()=>{
 for(const type of [2,7])assert.equal(bottleReceipt(sample({},[{type,itemId:0,value:10}])).confirmed,true);
 for(const r of [{type:99,itemId:0,value:10},{type:2,itemId:0,value:0},{type:7,value:10},{itemId:1,value:-1}])assert.equal(bottleReceipt(sample({},[r])).confirmed,false);
});
test('identical reward items are summed and large samples are explicitly labelled',()=>{
 const r=bottleReceipt(sample({},Array.from({length:21},()=>({type:3,itemId:3005,value:2}))));
 assert.match(r.compact,/前20条/);assert.match(r.compact,/物品3005×40/);
});
test('real salt receipt with zero counters still completes and same-chain reuse never writes again',async()=>{
 const calls=[];const opts={context:createBottleTaskContext(),tokenId:'fixture',kind:'claim',delay:async()=>{},send:async cmd=>{calls.push(cmd);return cmd==='bottlehelper_claim'?sample():role(0);}};
 const a=await runBottleAction(opts),b=await runBottleAction(opts);
 assert.equal(a.status,'completed');assert.equal(b.status,'skipped');assert.equal(b.reused,true);
 assert.match(a.detail,/syncrewardresp/);assert.ok(a.detail.length<500);assert.ok(b.detail.length<120);
 assert.equal(calls.filter(c=>c==='bottlehelper_claim').length,1);
});
test('2000150 evidence still includes before/after counters and never reclaims',async()=>{
 const calls=[];const r=await runBottleAction({context:createBottleTaskContext(),tokenId:'pending',kind:'claim',delay:async()=>{},send:async cmd=>{calls.push(cmd);if(cmd==='bottlehelper_claim')throw Object.assign(new Error('服务器错误: 2000150'),{code:2000150,requestCmd:cmd});return role(0);}});
 assert.equal(r.verificationRequired,true);assert.match(r.detail,/领取前.*obtainCnt.*领取后/);assert.equal(calls.filter(c=>c==='bottlehelper_claim').length,1);
});
test('long failure is summarized in one bounded overview with escaped HTML',()=>{
 const message='汉😀<&>\n'.repeat(9000)+'FAILURE_END';const r=report([{name:'<Account>',status:'failed',exceptions:[message]}]);
 assert.equal(r.parts,undefined);assert.ok(Buffer.byteLength(r.content)<=9000);assert.match(r.content,/&lt;Account&gt;/);assert.match(r.content,/完整步骤/);
 assert.doesNotMatch(r.content,/FAILURE_END/);
});
test('overview keeps failure and pending reason but excludes numeric receipt detail',()=>{
 const detail='盐罐结果待核验：2000150；seq=5';const r=report([{name:'A',status:'partial',exceptions:['真实失败800040'],verificationDetails:[`日常任务（${detail}）`],observations:[`日常任务｜${detail}`,'日常任务：含待核验','日常任务｜免费招募：请求正常返回']}]);
 assert.doesNotMatch(r.content,/seq=5|日常正常：免费招募/);assert.match(r.content,/800040/);assert.match(r.content,/2000150/);
});
test('15 normal observed salt accounts produce only an overview',async()=>{
 const r=await runBottleAction({context:createBottleTaskContext(),tokenId:'volume',kind:'claim',delay:async()=>{},send:async cmd=>cmd==='bottlehelper_claim'?sample():role(0)});
 const p=report(Array.from({length:15},(_,i)=>({name:`Account${i}`,status:'completed',completedCount:4,totalCount:4,observations:[`一键领取罐子｜${r.detail}`,'日常任务｜子项：完成47，跳过1，普通警告0，待核验0，异常0，未执行0','日常任务｜免费招募：请求正常返回']})));
 assert.equal(p.parts,undefined);assert.match(p.content,/确认完成 15/);assert.doesNotMatch(p.content,/syncrewardresp|物品3005/);
});
test('PushPlus rejection retains code and bytes without leaking configured token',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({code:400,msg:'服务端验证错误'})});
 try{const r=await enqueuePushPlusNotification({title:'test',content:'<div>诊断</div>',settings:{enabled:true,token:'PRIVATE_TOKEN'}});
 assert.equal(r.status,'failed');assert.match(r.error,/code=400/);assert.match(r.error,/字节/);assert.doesNotMatch(r.error,/PRIVATE_TOKEN/);
 }finally{globalThis.fetch=original;}
});
test("study first reward rejection stops remaining claims and retains bounded diagnostics", async () => {
  const h = harness({ initial: { ...marked(10, 0), token: "PRIVATE" }, claimFailure: 1 });
  const r = await h.run();
  assert.equal(r.status, "failed"); assert.match(r.detail, /奖励1.*3100060/);
  assert.match(r.detail, /未发送9/); assert.doesNotMatch(r.detail, /PRIVATE/);
  assert.equal(h.of("study_claimreward").length, 1);
});
test("study terminal result is published only after final read settles", async () => {
  let unblock, signal;
  const entered = new Promise(r => { signal = r; });
  const gate = new Promise(r => { unblock = r; });
  const h = harness({ initial: marked(10, 9), read: async body => { signal(); await gate; return body; } });
  const pending = h.run();
  await entered;
  try { assert.equal(h.store.gameData.studyStatuses.A.status, "claiming_rewards"); }
  finally { unblock(); }
  assert.equal((await pending).status, "completed");
});
