import { harness, marked } from "./helpers/studyHarness.js";
import * as hangUpWorkflow from "../src/utils/batch/hangUpWorkflow.js";
import { getVerificationMetadata } from "../src/utils/batch/taskResult.js";
import { createBottleTaskContext, runBottleAction } from "../src/utils/batch/bottleWorkflow.js";
import { dailyConnectionFailure, markDailyConnectionError } from "../src/utils/batch/dailyConnectionPolicy.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as results from '../src/utils/batch/taskResult.js';
import * as unlocks from '../src/utils/gameFeatureUnlocks.js';
import { summarizeEntries } from '../src/utils/autoSchedule/scheduleGuard.js';
import { buildBatchDailyPushReport } from '../src/utils/pushPlusNotifier.js';
const fastHangUp = Object.fromEntries(Object.entries(hangUpWorkflow).map(([name, fn]) =>
 [name, name.startsWith('run') ? options => fn({ ...options, delay: async () => {} }) : fn]));
const read = p => readFileSync(new URL('../src/'+p, import.meta.url), 'utf8');
const strip = s => s.replace(/^import\s[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '').replace(/export (function|const)/g,'$1');
function collector() {
 const vue=read('views/BatchDailyTasks.vue'), begin=vue.indexOf('const SCHEDULED_TERMINAL_STATUSES');
 const injected={getVerificationMetadata,tokens:{value:[{id:'a',name:'A'}]},tokenStatus:{value:{}},availableTasks:[],summarizeEntries,buildBatchDailyPushReport:v=>v};
 return new Function(...Object.keys(injected),vue.slice(begin,vue.indexOf('const createScopedScheduledTaskFunctions',begin))+';return createScheduledReportCollector;')(...Object.values(injected))({name:'test',selectedTokens:['a'],selectedTasks:['task']},0);
}
test('collector gives an accurate reason for a previously failed task with no details',()=>{
 const c=collector();c.createStatusRef('task').value.a='failed';c.finalizeTask('task');
 const e=c.snapshot().entries[0];assert.equal(e.status,'failed');assert.match(e.details[0],/执行器未提供详细原因/);assert.doesNotMatch(e.details[0],/未进入执行/);
});
for(const status of ['waiting','running']) test(status+' normal return is unverified, not failure',()=>{
 const c=collector();c.createStatusRef('task').value.a=status;c.finalizeTask('task');assert.equal(c.snapshot().status,'warning');assert.match(c.finish().accounts[0].verificationDetails[0],/待核验/);
});
for(const status of results.TERMINAL_STATUSES) test('collector preserves terminal '+status+' and details',()=>{
 const c=collector();c.createStatusRef('task').recordResult('a',status,['original']);c.finalizeTask('task',null,'later error');
 assert.equal(c.snapshot().entries[0].status,status);assert.deepEqual(c.snapshot().entries[0].details,['original']);assert.equal(c.finish().accounts[0].status,status);
});
test('collector stores thrown reason and structured result details',()=>{
 const c=collector();c.finalizeTask('task',null,'actual server error');c.finalizeTask('task');assert.deepEqual(c.snapshot().entries[0].details,['actual server error']);
 c.applyTaskResult('task',[{tokenId:'a',status:'partial',details:['specific']}]);assert.deepEqual(c.snapshot().entries[0].details,['specific']);
});
function taskFactory(name, file) {
 const injected={...fastHangUp,getVerificationMetadata,createBottleTaskContext,runBottleAction,dailyConnectionFailure,...results,...unlocks,createWeirdTowerIntegrated:()=>({}),getTowerActId:()=>1,normalizeWeirdTowerMaxClimb:v=>v,setTimeout:cb=>{cb();return 0;}};
 return new Function(...Object.keys(injected),strip(read('utils/batch/'+file))+';return '+name+';')(...Object.values(injected));
}
function deps(overrides={}) {
 const records=[];const tokenStatus={value:{},recordResult(id,status,details,warnings){this.value[id]=status;records.push({id,status,details,warnings});}};
 const d={selectedTokens:{value:['a']},tokens:{value:[{id:'a',name:'A'}]},tokenStatus,isRunning:{value:false},shouldStop:{value:false},ensureConnection:async()=>{},releaseConnectionSlot(){},connectionQueue:{active:0},batchSettings:{maxActive:3},currentRunningTokenId:{value:null},currentSettings:{towerFormation:2},addLog(){},message:{success(){},warning(){}},tokenStore:{gameData:{},sendMessageWithPromise:async()=>({}),sendGetRoleInfo:async()=>({role:{levelId:9000}}),closeWebSocketConnection(){}}};
 Object.assign(d,overrides);return {d,records};
}
const bottle=taskFactory('createTasksBottle','tasksBottle.js'),hangup=taskFactory('createTasksHangUp','tasksHangUp.js'),tower=taskFactory('createTasksTower','tasksTower.js');
test('salt claim skips only exact no-claimable message, not generic codes',async()=>{
 for(const [message,status] of [['无可领取盐罐','skipped'],['服务器错误: 3500020 - other','failed'],['服务器错误: 400340 - other','failed'],['timeout','warning']]) {
  const h=deps();h.d.tokenStore.sendMessageWithPromise=async(id,cmd)=>{if(cmd==='role_getroleinfo')return{role:{bottleHelpers:{helperStopTime:100}}};throw new Error(message);};await bottle(h.d).batchlingguanzi();assert.equal(h.records.at(-1).status,status);assert.ok(h.records.at(-1).details[0]);
 }
 assert.equal(results.isNoClaimableBottle({message:'无可领取盐罐',requestCmd:'other'},'bottlehelper_claim'),false);
});
test('stop while connecting does not send a salt claim',async()=>{
 const h=deps();let sends=0;h.d.ensureConnection=async()=>{h.d.shouldStop.value=true;};h.d.tokenStore.sendMessageWithPromise=async()=>{sends++;};await bottle(h.d).batchlingguanzi();assert.equal(sends,0);assert.equal(h.records[0].status,'stopped');
});
test('hangup add-time failure is partial with real details and legacy still runs',async()=>{
 const h=deps();const commands=[];h.d.tokenStore.sendMessageWithPromise=async(id,cmd)=>{commands.push(cmd);if(cmd==='system_mysharecallback')throw new Error('clock failed');return {};};
 await hangup(h.d).claimHangUpRewards();assert.equal(h.records[0].status,'partial');assert.match(h.records[0].details[0],/clock failed/);assert.ok(commands.includes('legacy_claimhangup'));
});
test('hangup legacy unlock skip is verified, missing level warns',async()=>{
 for(const [role,status] of [[{levelId:8001},'completed'],[{},'warning']]) {const h=deps();h.d.tokenStore.sendGetRoleInfo=async()=>({role});await hangup(h.d).claimHangUpRewards();assert.equal(h.records[0].status,status);}
});
test('tower zero energy skips and missing state warns',async()=>{
 for(const [role,status] of [[{tower:{id:10,energy:0}},'skipped'],[{},'warning']]) {const h=deps();let battles=0;h.d.tokenStore.sendGetRoleInfo=async()=>({role});h.d.tokenStore.sendMessageWithPromise=async(id,cmd)=>{if(cmd==='fight_starttower')battles++;return {};};await tower(h.d).climbTower();assert.equal(battles,0);assert.equal(h.records[0].status,status);}
});
test('tower unknown battle stops after one request and restores original team',async()=>{
 const h=deps();let battles=0;const teams=[];h.d.tokenStore.sendGetRoleInfo=async()=>({role:{tower:{id:10,energy:10}}});
 h.d.tokenStore.sendMessageWithPromise=async(id,cmd,p)=>{if(cmd==='presetteam_getinfo')return {presetTeamInfo:{useTeamId:1}};if(cmd==='presetteam_saveteam')teams.push(p.teamId);if(cmd==='fight_starttower')battles++;return {};};
 await tower(h.d).climbTower();assert.equal(battles,1);assert.deepEqual(teams,[2,1]);assert.equal(h.records[0].status,'warning');
});
test('PushPlus includes unverified details while suppressing routine warnings',()=>{
 const report=buildBatchDailyPushReport({taskName:'t',startedAt:0,finishedAt:1,selectedTaskCount:1,accounts:[{name:'A',status:'warning',warnings:['routine-warning-secret'],verificationDetails:['结果待核验：缺少血量'],exceptions:[],completedCount:0,totalCount:1}]});
 const text=JSON.stringify(report);assert.match(text,/缺少血量/);assert.doesNotMatch(text,/routine-warning-secret/);
});

test("study empty start result cannot confirm completion", async () => {
  const h = harness();
  h.questions.length = 0;
  assert.equal((await h.run()).status, "warning"); assert.equal(h.of("study_answer").length, 0);
});
test("study states are isolated per account and reward failures never become success", async () => {
  const a = harness({ initial: marked(10, 9), claimFailure: 10 });
  const b = harness({ store: a.store, id: "B", initial: marked(10, 9) });
  const results = await Promise.all([a.run(), b.run()]);
  assert.deepEqual(results.map(r => r.status), ["failed", "completed"]);
  assert.match(a.store.gameData.studyStatuses.A.detail, /3100060/);
  assert.equal(b.of("study_claimreward").length, 1);
});
test("study reward timeout is unverified and never retried", async () => {
  const h = harness({ initial: marked(10, 0), claimFailure: 1, timeout: true });
  const r = await h.run();
  assert.equal(r.status, "warning"); assert.match(r.detail, /待核验/);
  assert.equal(h.of("study_claimreward").length, 1);
  assert.equal(h.of("role_getroleinfo").length, 1);
});
