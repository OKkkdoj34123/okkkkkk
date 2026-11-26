import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse, compileScript, compileTemplate} from 'vue/compiler-sfc';
import {buildBatchDailyPushReport, BATCH_OVERVIEW_SAFE_BYTES} from '../src/utils/pushPlusNotifier.js';
import {createBottleTaskContext, runBottleAction} from '../src/utils/batch/bottleWorkflow.js';
const report = accounts => buildBatchDailyPushReport({taskName:'日常任务测试',startedAt:1,finishedAt:271001,runId:'fixture-run',selectedTaskCount:4,taskOrder:['日常任务','领取挂机','重置罐子','一键领取罐子'],accounts});
const pending = i => ({name:`Q${581+Math.floor(i/3)}-${i%3+1}-${i%3}-${723950000+i}`,status:'warning',verificationRequired:true,
 completedCount:3,totalCount:4,taskCounts:{completed:1,skipped:2,warning:1},verificationDetails:[
 '日常任务（领取日常任务奖励 [200020]：出了点小问题，请尝试重启游戏解决～（执行结果未确认））',
 '日常任务（领取周常任务奖励 [200020]：出了点小问题，请尝试重启游戏解决～（执行结果未确认））']});
test('observed 15-account run fits one green four-column table including final disconnect',()=>{
 const accounts=Array.from({length:15},(_,i)=>pending(i));
 for(const i of [5,10])Object.assign(accounts[i],{status:'partial',completedCount:2,taskCounts:{completed:1,skipped:1,warning:1,failed:1},exceptions:['一键领取罐子（服务器错误: 200350 - 未知错误；阶段=领取前状态查询；命令=role_getroleinfo；本轮领取请求0次）']});
 accounts[14].verificationDetails=['日常任务（结果待核验：日常连接或请求中断（WebSocket未连接），未重跑整轮日常）'];
 const r=report(accounts);assert.equal(r.parts,undefined);assert.ok(Buffer.byteLength(r.content)<=BATCH_OVERVIEW_SAFE_BYTES);
 assert.equal((r.content.match(/<td /g)||[]).length,30);assert.equal((r.content.match(/<tr>/g)||[]).length,15);
 for(const a of accounts)assert.ok(r.content.includes(a.name),a.name);
 assert.match(r.content,/background:#4caf50/);assert.match(r.content,/账号明细（15\/15账号）/);
 assert.match(r.content,/待核验 13/);assert.match(r.content,/部分异常 2/);assert.match(r.content,/含待核验账号 15/);
 assert.match(r.content,/200350/);assert.match(r.content,/200020/);assert.match(r.content,/日常连接或请求中断/);assert.doesNotMatch(r.content,/另有 \d+ 个账号未展开/);
});
test('20 pending accounts compress detail before dropping any account',()=>{
 const accounts=Array.from({length:20},(_,i)=>pending(i));const r=report(accounts);
 assert.match(r.content,/账号明细（20\/20账号）/);assert.ok(Buffer.byteLength(r.content)<=BATCH_OVERVIEW_SAFE_BYTES);
 for(const a of accounts)assert.ok(r.content.includes(a.name));
});
test('all terminal statuses are visible, routine details stay in console',()=>{
 const statuses=['completed','skipped','warning','failed','partial','stopped','blocked','unavailable'];
 const r=report(statuses.map(status=>({name:'ACCOUNT_'+status,status,completedCount:0,totalCount:4,warnings:['HIDDEN_ROUTINE'],observations:['HIDDEN_SNAPSHOT']})));
 for(const status of statuses)assert.match(r.content,new RegExp('ACCOUNT_'+status));
 assert.doesNotMatch(r.content,/HIDDEN_ROUTINE|HIDDEN_SNAPSHOT/);
});
test('large UTF-8 batch has complete table tags, visible omission and preserved codes',()=>{
 const accounts=Array.from({length:3000},(_,i)=>({...pending(i),name:`账号😀${i}`,verificationDetails:['日常任务（'+ '警告😀'.repeat(1000)+' [200020]；诊断尾部'] }));
 const r=report(accounts),shown=Number(r.content.match(/账号明细（(\d+)\/3000账号）/)[1]);
 assert.ok(shown>12);assert.ok(shown<3000);assert.match(r.content,new RegExp(`另有 ${3000-shown} 个账号未展开`));
 assert.equal((r.content.match(/<tr>/g)||[]).length,shown);assert.match(r.content,/<\/tbody><\/table>/);
 assert.ok(Buffer.byteLength(r.content)<=BATCH_OVERVIEW_SAFE_BYTES);assert.match(r.content,/200020/);
});
const state={role:{bottleHelpers:{helperStopTime:1},dailyTask:{complete:{14:0}}}};
for(const phase of ['before','claim','after'])test('salt failure phase '+phase+' exposes exact command and never reclaims',async()=>{
 const calls=[];let reads=0;const context=createBottleTaskContext();
 const options={context,tokenId:'fixture-'+phase,kind:'claim',delay:async()=>{},send:async cmd=>{
  calls.push(cmd);if(cmd==='role_getroleinfo')reads++;
  if(phase==='before'&&reads===1 || phase==='claim'&&cmd==='bottlehelper_claim' || phase==='after'&&reads===2)throw Object.assign(new Error('服务器错误: 200350'),{code:200350});
  return cmd==='bottlehelper_claim'?{}:state;
 }};
 if(phase==='after'){
  const result=await runBottleAction(options);assert.equal(result.status,'warning');assert.match(result.consoleDetail,/领取后状态核验/);assert.match(result.consoleDetail,/命令=role_getroleinfo/);
 }else if(phase==='before'){
  for(let i=0;i<2;i++){
   const result=await runBottleAction(options);
   assert.equal(result.status,'skipped');assert.equal(result.verificationRequired,false);assert.match(result.detail,/已按规则忽略.*200350/);
  }
 }else{
  for(let i=0;i<2;i++)await assert.rejects(runBottleAction(options),e=>{
   assert.equal(e.code,200350);assert.match(e.message,/阶段=发送盐罐领取/);
   assert.match(e.message,/本轮领取请求1次/);return true;
  });
 }
 assert.equal(calls.filter(c=>c==='bottlehelper_claim').length,phase==='before'?0:1);
});
test('read-only 200400 retries retain the previous two-retry budget',async()=>{
 let reads=0,claims=0;
 const result=await runBottleAction({context:createBottleTaskContext(),tokenId:'readretry',kind:'claim',delay:async()=>{},send:async cmd=>{
  if(cmd==='bottlehelper_claim'){claims++;return{};}
  if(++reads<=2)throw Object.assign(new Error('服务器错误: 200400'),{code:200400});return state;
 }});
 assert.equal(reads,4);assert.equal(claims,1);assert.match(result.consoleDetail,/查询重试2次/);
});
test('batch Vue script and template compile',()=>{
 const filename='BatchDailyTasks.vue';const source=readFileSync(new URL('../src/views/'+filename,import.meta.url),'utf8');
 const {descriptor,errors}=parse(source,{filename});assert.deepEqual(errors,[]);
 const script=compileScript(descriptor,{id:'batch-table'});
 const template=compileTemplate({source:descriptor.template.content,filename,id:'batch-table',compilerOptions:{bindingMetadata:script.bindings}});
 assert.deepEqual(template.errors,[]);
});
