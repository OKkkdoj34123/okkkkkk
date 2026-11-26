import { getActivityCycle } from "../src/utils/autoSchedule/activityCycle.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyBatchDailyError } from '../src/utils/batch/dailyErrorPolicy.js';
import * as hang from '../src/utils/batch/hangUpWorkflow.js';
import * as bottle from '../src/utils/batch/bottleWorkflow.js';
import * as connection from '../src/utils/batch/dailyConnectionPolicy.js';
import * as unlocks from '../src/utils/gameFeatureUnlocks.js';
import * as dream from '../src/utils/dreamStatePolicy.js';
import { getVerificationMetadata } from '../src/utils/batch/taskResult.js';
import { summarizeEntries } from '../src/utils/autoSchedule/scheduleGuard.js';
import { buildBatchDailyPushReport } from '../src/utils/pushPlusNotifier.js';

// Synthetic protocol fixtures, based on the reported command/code scenarios.
// They verify classification and execution boundaries, not live reward credit.
const cases = [
  ['task_claimdailyreward', 200020, {}, 'completed'],
  ['task_claimweekreward', 200020, {}, 'completed'],
  ['system_signinreward', 400190, {}, 'skipped'],
  ['legion_signin', 2300190, {}, 'skipped'],
  ['discount_claimreward', 1000020, {}, 'skipped'],
  ['card_claimreward', 1000020, {}, 'skipped'],
  ['card_claimreward', 1000020, { cardId: 4003 }, 'skipped'],
  ['card_claimreward', 1400010, { cardId: 4003 }, 'skipped'],
  ['genie_sweep', 3300060, { genieId: 1 }, 'skipped'],
  ['genie_buysweep', 3300050, {}, 'skipped'],
  ['task_claimdailypoint', 700020, { taskId: 1 }, 'skipped'],
  ['activity_recyclewarorderrewardclaim', 3500020, { actId: 1 }, 'skipped'],
  ['gacha_drawreward', 400000, { num: 1, isGroup: false }, 'skipped'],
  ['gacha_drawreward', 1000020, { num: 1, isGroup: false }, 'skipped'],
];
const rejection = (code, extra = {}) => Object.assign(new Error(`服务器错误: ${code} - fixture server response`), { code, ...extra });
for (const [cmd, code, params, status] of cases) {
  test(`normal daily response ${cmd} / ${code} / ${JSON.stringify(params)}`, () => {
    for (const value of [code, String(code)]) {
      const r = classifyBatchDailyError(rejection(value, { requestCmd: cmd, requestParams: params }));
      assert.equal(r.level, 'normal'); assert.equal(r.status, status); assert.equal(r.code, code);
      assert.match(r.originalMessage, /fixture server response/);
      assert.doesNotMatch(r.message, /警告|错误|未确认|待核验|到账/);
    }
    assert.notEqual(classifyBatchDailyError(rejection(code, { requestCmd: 'other', requestParams: params })).level, 'normal');
    assert.notEqual(classifyBatchDailyError(rejection(code)).level, 'normal');
  });
}
test('command/parameter boundaries and interruption flags cannot become normal', () => {
  for (const [requestCmd, code, requestParams] of [
    ['gacha_drawreward', 400000, { num: 10, isGroup: true }],
    ['gacha_drawreward', 1000020, {}],
    ['genie_sweep', 3300060, { genieId: 5, sweepCnt: 1 }],
    ['genie_sweep', 3300060, { genieId: 1, sweepCnt: 10 }],
    ['card_claimreward', 1400010, { cardId: 4001 }],
    ['role_getroleinfo', 200020, {}],
    ['task_claimreward', 700020, {}],
    ['task_claimdailyreward', 200160, {}],
    ['task_claimdailyreward', 400340, {}],
  ]) assert.notEqual(classifyBatchDailyError(rejection(code, { requestCmd, requestParams })).level, 'normal');
  for (const flag of ['haltDaily', 'stopped', 'notExecuted']) {
    assert.notEqual(classifyBatchDailyError(rejection(200020, { requestCmd: 'task_claimdailyreward', [flag]: true })).level, 'normal');
  }
  assert.equal(classifyBatchDailyError({ message: '服务器错误: 200020 - fixture', requestCmd: 'task_claimweekreward' }).level, 'normal');
});

const read = p => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const source = read('utils/dailyTaskRunner.js').replace(/^import\s[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '').replace('export class DailyTaskRunner', 'class DailyTaskRunner');
const TUESDAY = Date.parse('2026-10-27T12:00:00+08:00');
function harness({ now = TUESDAY, reject, disconnect = false, batch = true, enabled = true, claimed = false } = {}) {
  const calls = [], logs = [], waits = [];
  let connected = true;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const state = { role: { roleId: 1, levelId: 9000,
    dailyTask: { complete: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [i, -1])) },
    statisticsTime: claimed ? { 'gacha:free': now / 1000 } : {},
    bottleHelpers: { helperStopTime: 1 },
    dungeon: { beginTime: now / 1000, battleTeam: { 0: { heroId: 107, hp: 0 } } },
  } };
  const fastHang = Object.fromEntries(Object.entries(hang).map(([name, fn]) =>
    [name, name.startsWith('run') ? opts => fn({ ...opts, delay: async () => {} }) : fn]));
  const scope = { getActivityCycle, ...fastHang, ...bottle, ...connection, ...unlocks, ...dream,
    runBottleAction: opts => bottle.runBottleAction({ ...opts, delay: async () => {} }),
    useTokenStore: () => {}, extractDreamBattleTeam: () => ({ 0: 107 }),
    dailyDreamPreflight: r => dream.dailyDreamPreflight(r, now), getDreamRound: () => dream.getDreamRound(now),
    Date: Clock, setTimeout: (fn, ms) => { waits.push(ms); fn(); return 0; },
  };
  const Runner = new Function(...Object.keys(scope), source + ';return DailyTaskRunner;')(...Object.values(scope));
  const store = { gameTokens: [{ id: 'A', name: 'A' }], gameData: {},
    getWebSocketStatus: () => connected ? 'connected' : 'disconnected',
    closeWebSocketConnectionAsync: async () => {}, sendGetRoleInfo: async () => state,
    sendMessageWithPromise: async (id, cmd, params) => {
      calls.push({ cmd, params }); const error = reject?.(cmd, params);
      if (error) { if (disconnect) connected = false; throw error; }
      if (cmd === 'activity_get') return { activity: { activity: [] } };
      if (cmd === 'role_getroleinfo') return state;
      if (cmd === 'presetteam_getinfo') return { presetTeamInfo: { useTeamId: 1 } };
      return {};
    },
  };
  const settings = { bossFormation: 1, arenaFormation: 1, bossTimes: 0, claimBottle: true,
    claimHangUp: false, freeGachaEnable: enabled, claimEmail: false, blackMarketPurchase: false };
  const runner = new Runner(store, { commandDelay: 17, taskDelay: 29 }, {
    ...(batch ? { classifyError: classifyBatchDailyError } : {}), productionLogs: true, verboseLogs: true,
  });
  return { calls, logs, waits, store, Runner, settings, run: () => runner.run('A', { onLog: l => logs.push(l) }, settings) };
}
const allNormal = (cmd, params) => {
  const found = cases.find(([c, , p]) => c === cmd && (c !== 'card_claimreward' || p.cardId === params.cardId));
  return found ? rejection(found[1]) : null;
};
test('actual runner handles all listed scenarios normally without replay or losing pacing', async () => {
  const h = harness({ reject: allNormal }), r = await h.run();
  assert.equal(r.warningCount, 0); assert.equal(r.verificationCount, 0); assert.equal(r.failedCount, 0);
  assert.equal(r.aborted, false); assert.equal(r.unexecutedCount, 0);
  const expectedBenefits=getActivityCycle(TUESDAY).type==='blackMarket'?['领取金砖商店免费福利','领取江湖黑市免费福利']:getActivityCycle(TUESDAY).type==='box'?['领取宝箱周免费福利']:[];
  assert.equal(h.calls.filter(c => c.cmd === 'activity_get').length, expectedBenefits.length);
  for (const name of expectedBenefits) assert.equal(r.taskResults.find(t => t.name === name).status, 'skipped');
  assert.equal(r.completedCount + r.skippedCount, r.totalTasks);
  assert.equal(h.waits.filter(ms => ms === 29).length, r.totalTasks);
  for (const cmd of ['task_claimdailyreward', 'task_claimweekreward', 'gacha_drawreward']) {
    assert.equal(h.calls.filter(c => c.cmd === cmd).length, 1);
  }
  assert.equal(r.taskResults.filter(t => t.normalResponse).length, 26);
  assert.ok(r.taskResults.filter(t => t.normalResponse).every(t => t.originalMessage && !t.verificationRequired));
  assert.ok(h.logs.every(l => !['warning', 'error'].includes(l.type)));
  assert.doesNotMatch(h.logs.map(l => l.message).join('\n'), /奖励领取诊断|执行结果未确认/);
  assert.match(r.observations.join('\n'), /领取日常任务奖励：正常处理 \[200020\]/);
  assert.doesNotMatch(r.observations.join('\n'), /请求正常返回 \[200020\]/);
});
for (const code of [400000, 1000020]) test(`free gacha activity-day code ${code} is a normal skip`, async () => {
  const h = harness({ reject: cmd => cmd === 'gacha_drawreward' ? rejection(code) : null }), r = await h.run();
  assert.equal(r.taskResults.find(t => t.name === '免费扭蛋').status, 'skipped');
  assert.equal(r.warningCount, 0); assert.equal(h.calls.filter(c => c.cmd === 'gacha_drawreward').length, 1);
});
test('free gacha respects all seven UTC+8 weekdays, including midnight boundaries', async () => {
  const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
  for (const [i, day] of days.entries()) {
    const h = harness({ now: Date.parse(day + 'T12:00:00+08:00') }), r = await h.run();
    const active = [1, 3, 5].includes(i);
    assert.equal(h.calls.some(c => c.cmd === 'gacha_drawreward'), active, day);
    assert.equal(r.taskResults.find(t => t.name === '免费扭蛋').status, active ? 'completed' : 'skipped');
    assert.equal(r.warningCount, 0);
  }
  for (const [time, active] of [['2026-10-26T15:59:59Z', false], ['2026-10-26T16:00:00Z', true], ['2026-10-27T16:00:00Z', false]]) {
    const h = harness({ now: Date.parse(time) }); await h.run();
    assert.equal(h.calls.some(c => c.cmd === 'gacha_drawreward'), active, time);
  }
});
test('gacha switch and claimed statistics still suppress requests; single-account policy is preserved', async () => {
  for (const options of [{ enabled: false }, { claimed: true }]) {
    const h = harness(options), r = await h.run();
    assert.equal(h.calls.some(c => c.cmd === 'gacha_drawreward'), false);
    assert.equal(r.taskResults.some(t => t.name === '免费扭蛋'), false);
  }
  const h = harness({ batch: false, now: Date.parse('2026-10-26T12:00:00+08:00'), reject: cmd => cmd === 'gacha_drawreward' ? rejection(400000) : null });
  const r = await h.run(); assert.equal(r.failedTasks.find(t => t.name === '免费扭蛋').code, 400000);
  assert.equal(h.calls.filter(c => c.cmd === 'gacha_drawreward').length, 1);
});
for (const [label, error, disconnect] of [
  ['timeout', new Error('请求超时: task_claimdailyreward'), false],
  ['disconnect with known code', rejection(200020), true],
]) test(`${label} remains pending and stops without replay`, async () => {
  const h = harness({ reject: cmd => cmd === 'task_claimdailyreward' ? error : null, disconnect }), r = await h.run();
  assert.equal(r.aborted, true); assert.equal(r.verificationCount, 1);
  assert.equal(h.calls.filter(c => c.cmd === 'task_claimdailyreward').length, 1);
  assert.equal(h.calls.some(c => c.cmd === 'task_claimweekreward'), false);
});
test('unlisted codes and same codes in unrelated commands remain visible', async () => {
  for (const [cmd, code, status] of [['task_claimdailyreward', 400340, 'failed'], ['presetteam_getinfo', 200020, 'warning'], ['fight_startboss', 400000, 'warning']]) {
    const h = harness({ reject: c => c === cmd ? rejection(code) : null }), r = await h.run();
    assert.ok(r.taskResults.some(t => t.status === status && t.code === code));
    assert.ok(h.logs.some(l => ['error', 'warning'].includes(l.type) && l.message.includes(String(code))));
  }
});
test('real runner -> Vue wrapper -> scheduled console and PushPlus yields a normal account', async () => {
  const h = harness({ reject: allNormal });
  // The wrapper loads settings; keep storage outside the fixture with this adapter.
  class Runner extends h.Runner { loadSettings() { return h.settings; } }
  const vue = read('views/BatchDailyTasks.vue');
  const scope = { ...connection, classifyBatchDailyError, DailyTaskRunner: Runner, ...bottle,
    getVerificationMetadata, summarizeEntries, buildBatchDailyPushReport,
    selectedTokens: { value: ['A'] }, tokens: { value: h.store.gameTokens }, tokenStatus: { value: {} },
    isRunning: { value: false }, scheduledExecutionActive: { value: true }, shouldStop: { value: false },
    ensureConnection: async () => {}, batchSettings: { maxActive: 3, commandDelay: 0, taskDelay: 0 },
    tokenStore: h.store, releaseConnectionSlot() {}, connectionQueue: { active: 0 },
    addLog: l => h.logs.push(l), currentRunningTokenId: { value: null }, message: { success() {}, warning() {} },
    setTimeout: cb => { cb(); return 0; }, availableTasks: [{ value: 'startBatch', label: '日常任务' }],
  };
  const start = vue.indexOf('const startBatch =');
  const run = new Function(...Object.keys(scope), vue.slice(start, vue.indexOf('const stopBatch =', start)) + ';return startBatch;')(...Object.values(scope));
  const results = await run();
  assert.equal(results[0].status, 'completed'); assert.deepEqual(results[0].warnings, []);
  assert.equal(results[0].verificationCount, 0);
  const at = vue.indexOf('const SCHEDULED_TERMINAL_STATUSES');
  const collect = new Function(...Object.keys(scope), vue.slice(at, vue.indexOf('const createScopedScheduledTaskFunctions', at)) + ';return createScheduledReportCollector;')(...Object.values(scope));
  const collector = collect({ name: 'fixture', selectedTasks: ['startBatch'], selectedTokens: ['A'] }, TUESDAY);
  collector.applyTaskResult('startBatch', results);
  const report = collector.finish({ onLog: l => h.logs.push(l) });
  const summary = h.logs.find(l => l.message.startsWith('[汇总]'));
  assert.equal(summary.type, 'info'); assert.match(summary.message, /完成\/跳过1\/1/);
  assert.doesNotMatch(summary.message, /含待核验|\[200020\].*未确认/);
  assert.match(summary.message, /普通警告0，待核验0，异常0/);
  assert.match(report.content, /确认完成 1/); assert.match(report.content, /普通警告 0｜待核验 0｜部分异常 0｜失败 0/);
  assert.doesNotMatch(report.content, /fixture server response|执行结果未确认/);
});

test('三周免费福利按北京时间轮换生成对应任务',async()=>{
 for(const [date,expected] of [
  ['2026-11-14',['领取金砖商店免费福利','领取江湖黑市免费福利']],
  ['2026-11-21',['领取招募周免费福利']],['2026-11-28',['领取宝箱周免费福利']],
  ['2026-11-13T11:59:59', ['领取宝箱周免费福利']],
  ['2026-11-13T12:00:00', ['领取金砖商店免费福利','领取江湖黑市免费福利']],
 ]) {
  const now=Date.parse((date.includes('T')?date:date+'T12:00:00')+'+08:00');
  const h=harness({now}),r=await h.run();
  assert.deepEqual(r.taskResults.filter(t=>/免费福利/.test(t.name)).map(t=>t.name),expected);
  assert.equal(h.calls.filter(c=>c.cmd==='activity_get').length,expected.length);
  assert.ok(!h.calls.some(c=>c.cmd==='activity_buystoregoods'));
 }
});
