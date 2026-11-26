import { getActivityCycle } from "../src/utils/autoSchedule/activityCycle.js";
import * as hangUpWorkflow from "../src/utils/batch/hangUpWorkflow.js";
import { getVerificationMetadata } from "../src/utils/batch/taskResult.js";
import { createBottleTaskContext, runBottleAction } from "../src/utils/batch/bottleWorkflow.js";
import { dailyConnectionFailure, markDailyConnectionError } from "../src/utils/batch/dailyConnectionPolicy.js";
import { dailyDreamPreflight, getDreamRound } from "../src/utils/dreamStatePolicy.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConnectionSlots } from '../src/utils/batch/connectionSlots.js';
import { classifyBatchDailyError } from '../src/utils/batch/dailyErrorPolicy.js';
import { normalizeConfig } from '../src/utils/autoSchedule/scheduleStorage.js';
import { getDueState, summarizeEntries } from '../src/utils/autoSchedule/scheduleGuard.js';
import * as unlocks from '../src/utils/gameFeatureUnlocks.js';
const fastHangUp = Object.fromEntries(Object.entries(hangUpWorkflow).map(([name, fn]) =>
 [name, name.startsWith('run') ? options => fn({ ...options, delay: async () => {} }) : fn]));
const vue = readFileSync(new URL('../src/views/BatchDailyTasks.vue', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('default and legacy zero window become five minutes; custom nonzero preserved', () => {
  for (const graceMinutes of [undefined, 0, -1, 'bad', null]) assert.equal(normalizeConfig({ graceMinutes }).graceMinutes, 5);
  assert.equal(normalizeConfig({ graceMinutes: 10 }).graceMinutes, 10);
  const plan = { type: 'task', scheduledAt: 1000 };
  assert.equal(getDueState(plan, null, 1001, 0), 'queued');
  assert.equal(getDueState(plan, null, 301000, 0), 'queued');
  assert.equal(getDueState(plan, null, 301001, 0), 'missed');
  assert.equal(getDueState(plan, { status: 'missed' }, 1001, 0), null);
});
test('ignored codes are scoped to requested daily commands, other errors survive', () => {
  for (const [code, requestCmd] of [[12000116,'collection_claimfreereward'],[2600040,'dungeon_selecthero']]) {
    assert.equal(classifyBatchDailyError({ code, requestCmd }).level, 'ignore');
    assert.equal(classifyBatchDailyError({ message: `服务器错误: ${code} - 测试`, requestCmd }).level, 'ignore');
    assert.equal(classifyBatchDailyError({ code, requestCmd: 'other_command' }).level, 'error');
  }
  assert.equal(classifyBatchDailyError({ code: 400080, requestCmd: 'dungeon_selecthero' }).level, 'error');
});
function connectionHarness(status = () => 'disconnected') {
  const deps = { createConnectionSlots, shouldStop: { value: false }, tokens: { value: [{ id: 'C', token: 'offline' }] },
    batchSettings: { maxActive: 3, connectionTimeout: 1, reconnectDelay: 0 }, addLog: () => {},
    tokenStore: { getWebSocketStatus: status, createWebSocketConnection() {}, closeWebSocketConnection() {}, sendMessageWithPromise: async () => ({}), setBattleVersion() {} } };
  const source = vue.slice(vue.indexOf('const connectionQueue = createConnectionSlots();'), vue.indexOf('const createTaskDeps ='));
  return { deps, ...new Function(...Object.keys(deps), source+';return {connectionQueue,ensureConnection,releaseConnectionSlot};')(...Object.values(deps)) };
}
test('connection failure plus caller finally releases only its own slot once', async () => {
  const h = connectionHarness(); h.connectionQueue.reserve('A'); h.connectionQueue.reserve('B');
  try { await assert.rejects(h.ensureConnection('C', 0), /连接失败/); }
  finally { h.releaseConnectionSlot('C'); }
  assert.equal(h.connectionQueue.active, 2); assert.equal(h.connectionQueue.has('A'), true);
});
test('borrowed connected socket does not release another account slot', async () => {
  const h = connectionHarness(() => 'connected'); h.connectionQueue.reserve('A');
  await h.ensureConnection('C'); h.releaseConnectionSlot('C'); assert.equal(h.connectionQueue.active, 1);
});
test('stop while waiting for a slot cancels without opening a socket', async () => {
  const h = connectionHarness(); h.deps.batchSettings.maxActive = 1; h.connectionQueue.reserve('A');
  let opens = 0; h.deps.tokenStore.createWebSocketConnection = () => opens++;
  const promise = h.ensureConnection('C'); h.deps.shouldStop.value = true;
  await assert.rejects(promise, e => e.stopped); h.releaseConnectionSlot('C');
  assert.equal(opens, 0); assert.equal(h.connectionQueue.active, 1);
});
test('same-account concurrent connection attempts share one pending promise', async () => {
  let connected = false, opens = 0;
  const h = connectionHarness(() => connected ? 'connected' : 'disconnected');
  h.deps.tokenStore.createWebSocketConnection = () => { opens++; connected = true; };
  const p = h.ensureConnection('C'); assert.equal(h.ensureConnection('C'), p); await p;
  assert.equal(opens, 1); h.releaseConnectionSlot('C'); assert.equal(h.connectionQueue.active, 0);
});
function executorHarness(callbacks, initialStopped = false) {
  const start = vue.indexOf('const SCHEDULED_TERMINAL_STATUSES');
  const collector = vue.slice(start, vue.indexOf('const createScopedScheduledTaskFunctions', start));
  const es = vue.indexOf('const executeScheduledTask =');
  const executor = vue.slice(es, vue.indexOf('// 注: boxTypeOptions', es));
  let result;
  const deps = { getVerificationMetadata, createBottleTaskContext, tokens: { value: [{ id: '1' }] }, tokenStatus: { value: {} }, availableTasks: [], summarizeEntries,
    buildBatchDailyPushReport: v => v, acquireTaskPreemption: async () => null, verifyTaskDependencies: async () => true,
    selectedTokens: { value: [] }, shouldStop: { value: initialStopped }, isRunning: { value: false }, scheduledExecutionActive: { value: false },
    tokenStore: { closeWebSocketConnectionAsync: async () => {} }, releasePreemptionLease: async () => {}, addLog: () => {},
    isAutoTaskOpen: () => true, ismengjingActivityOpen: { value: true },
    isCarActivityOpen: { value: true }, isarenaActivityOpen: { value: true }, isWeirdTowerActivityOpen: { value: true },
    resolveScheduledTaskFunction: (name, opts) => async () => { await callbacks[name](deps); opts.tokenStatusRef.value['1'] = 'completed'; },
    enqueuePushPlusNotification: async () => ({ status: 'disabled' }) };
  const run = new Function(...Object.keys(deps), collector+'\n'+executor+'\nreturn executeScheduledTask;')(...Object.values(deps));
  return { deps, get result() { return result; }, run: () => run({ name: 'offline', selectedTokens: ['1'], selectedTasks: Object.keys(callbacks) }, { scheduled: true, onResult: r => { result = r; } }) };
}
test('old scheduled chain resets previous stop; current stop skips remaining tasks; next run resumes', async () => {
  const seen = []; let stopThisRun = true;
  const h = executorHarness({ first: async d => { seen.push('first'); if (stopThisRun) d.shouldStop.value = true; }, second: async () => seen.push('second') }, true);
  await h.run(); assert.deepEqual(seen, ['first']); assert.equal(h.result.entries[1].status, 'stopped');
  assert.equal(h.deps.scheduledExecutionActive.value, false);
  stopThisRun = false; await h.run(); assert.deepEqual(seen, ['first','first','second']);
});
test('legacy scheduled chain waits for manual batch and holds UI ownership across task gaps', async () => {
  let release; const gate = new Promise(r => { release = r; }); const seen = [];
  const h = executorHarness({ first: async () => { seen.push('first'); await gate; }, second: async () => seen.push('second') });
  h.deps.isRunning.value = true; const p = h.run(); await flush(); assert.deepEqual(seen, []);
  h.deps.isRunning.value = false; await new Promise(r => setTimeout(r, 220));
  assert.equal(h.deps.scheduledExecutionActive.value, true); assert.deepEqual(seen, ['first']);
  release(); await p; assert.deepEqual(seen, ['first','second']); assert.equal(h.deps.scheduledExecutionActive.value, false);
});
function dailyHarness(stopOnCommand, rejectRewards = false) {
  const source = readFileSync(new URL('../src/utils/dailyTaskRunner.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\s*/gm, '').replace('export class DailyTaskRunner', 'class DailyTaskRunner');
  class Thursday extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-15T12:00:00+08:00'])); } getDay() { return 4; } }
  const injected = { getActivityCycle, ...fastHangUp, createBottleTaskContext, runBottleAction: opts => runBottleAction({ ...opts, delay: async () => {} }), dailyConnectionFailure, markDailyConnectionError, ...unlocks, dailyDreamPreflight: r => dailyDreamPreflight(r, new Thursday().getTime()), getDreamRound: () => getDreamRound(new Thursday().getTime()), useTokenStore: () => {}, extractDreamBattleTeam: () => ({ 0: 107 }), Date: Thursday };
  const Runner = new Function(...Object.keys(injected), source+';return DailyTaskRunner;')(...Object.values(injected));
  let stopped = false; const commands = [], logs = [];
  const tokenStore = { gameTokens: [{ id: 'A' }], sendGetRoleInfo: async () => ({ role: { levelId: 1000, dailyTask: { complete: Object.fromEntries(Array.from({length:20},(_,i)=>[i,-1])) } } }),
    sendMessageWithPromise: async (id, cmd) => {
      commands.push(cmd); if (cmd === stopOnCommand) stopped = true;
      if (cmd === 'activity_get') return { activity: { activity: [] } };
      if (cmd === 'role_getroleinfo') return { role: { dungeon: { beginTime: 0, battleTeam: {} } } };
      if (cmd === 'presetteam_getinfo') return { presetTeamInfo: { useTeamId: 1 } };
      if (rejectRewards && ['collection_claimfreereward','dungeon_selecthero'].includes(cmd)) throw new Error(`服务器错误: ${cmd === 'dungeon_selecthero' ? 2600040 : 12000116} - 测试`);
      return {};
    } };
  const runner = new Runner(tokenStore, { commandDelay: 0, taskDelay: 0 }, { classifyError: classifyBatchDailyError });
  return { commands, logs, run: () => runner.run('A', { shouldStop: () => stopped, onLog: l => logs.push(l) }, { freeGachaEnable: false }) };
}
test('three requested daily errors are skipped, not failed, and remaining rewards continue', async () => {
  const h = dailyHarness(null, true); const result = await h.run();
  assert.equal(result.taskResults.filter(t => t.status === "skipped" && !["领取宝箱周免费福利", "领取金砖商店免费福利", "领取江湖黑市免费福利", "领取招募周免费福利"].includes(t.name)).length, 3);
  for (const task of result.taskResults.filter(t => /免费福利/.test(t.name))) assert.equal(task.status, "skipped"); assert.equal(result.failedCount, 0); assert.equal(result.warningCount, 0);
  assert.ok(h.commands.includes('task_claimdailyreward')); assert.equal(h.logs.some(l => l.type === 'error'), false);
});
test('daily runner stops at next command boundary and only reads/restores team for cleanup', async () => {
  const h = dailyHarness('bottlehelper_stop'); const result = await h.run();
  assert.equal(result.stopped, true); assert.equal(h.commands.includes('bottlehelper_start'), false);
  assert.equal(h.commands.includes('task_claimdailyreward'), false);
  assert.equal(h.commands.at(-1), 'presetteam_getinfo');
});
test('task-level reset cannot clear a stop requested during a scheduled chain', () => {
  const start = vue.indexOf('  shouldStop: {', vue.indexOf('const createTaskDeps'));
  const end = vue.indexOf('\n  ensureConnection,', start);
  const object = vue.slice(start, end).trim().replace(/^shouldStop:\s*/, '').replace(/,$/, '');
  const stopped = { value: true }, active = { value: true };
  const proxy = new Function('shouldStop', 'scheduledExecutionActive', 'return '+object)(stopped, active);
  proxy.value = false; assert.equal(stopped.value, true);
  active.value = false; proxy.value = false; assert.equal(stopped.value, false);
});
for (const rejectedCommand of ['role_getroleinfo','fight_startlevel']) test('initialization diagnostics identify account and command: '+rejectedCommand, async()=>{
  const h=connectionHarness(()=>'connected'),calls=[],logs=[];
  h.deps.tokens.value[0].name='Account C';
  // The extracted function captured addLog, so create a second scope for this log assertion.
  const deps={...h.deps,addLog:log=>logs.push(log)};
  deps.tokenStore.sendMessageWithPromise=async(id,cmd)=>{calls.push(cmd);if(cmd===rejectedCommand)throw new Error('服务器错误: 200350');return{};};
  const source=vue.slice(vue.indexOf('const connectionQueue = createConnectionSlots();'),vue.indexOf('const createTaskDeps ='));
  const ensure=new Function(...Object.keys(deps),source+';return ensureConnection;')(...Object.values(deps));
  assert.equal(await ensure('C'),true);
  assert.deepEqual(calls,rejectedCommand==='role_getroleinfo'?['role_getroleinfo']:['role_getroleinfo','fight_startlevel']);
  assert.equal(logs.length,1);assert.match(logs[0].message,/\[连接\]\[Account C\]/);
  assert.ok(logs[0].message.includes('命令='+rejectedCommand));assert.match(logs[0].message,/阶段=连接初始化/);
});
