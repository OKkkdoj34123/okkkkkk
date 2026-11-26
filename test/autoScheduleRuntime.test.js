import { removeRetiredTasks } from "../src/utils/batch/retiredActivities.js";
import { importTokenRecords, remapTokenIds } from '../src/utils/tokenRefreshSource.js';
import { getVerificationMetadata } from "../src/utils/batch/taskResult.js";
import { createBottleTaskContext, runBottleAction } from "../src/utils/batch/bottleWorkflow.js";
import { dailyConnectionFailure, markDailyConnectionError } from "../src/utils/batch/dailyConnectionPolicy.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAutoScheduler } from "../src/utils/autoSchedule/scheduler.js";
import { createScheduleStorage } from "../src/utils/autoSchedule/scheduleStorage.js";
import { generateDayPlan } from "../src/utils/autoSchedule/planGenerator.js";
import { gameTimestamp } from "../src/utils/autoSchedule/activityCycle.js";
import { summarizeEntries } from "../src/utils/autoSchedule/scheduleGuard.js";
const flush = () => new Promise((resolve) => setImmediate(resolve));
function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), key: (i) => [...data.keys()][i], get length() { return data.size; } };
}
function fakeLocks() {
  const held = new Set();
  return { async request(name, options, callback) {
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name }); } finally { held.delete(name); }
  } };
}
function harness(options = {}) {
  const storage = options.storage || createScheduleStorage(memoryStorage());
  if (!options.storage) storage.saveConfig({ enabled: true, batches: { A: { groupId: "a" }, B: { groupId: "b" }, C: { groupId: "c" } } });
  let clock = gameTimestamp("2026-10-13", 30);
  let chain = Promise.resolve();
  const queued = [], executed = [], groups = [{ id: "a", tokenIds: ["1"] }, { id: "b", tokenIds: ["2"] }, { id: "c", tokenIds: ["3"] }];
  const runtime = createAutoScheduler({ storage, locks: options.locks || fakeLocks(), now: () => clock,
    getGroups: () => groups, getTokens: () => ["1", "2", "3"].map((id) => ({ id })),
    enqueue: (plan, key, run) => { queued.push(key); chain = chain.then(run); return chain; },
    execute: async (task, key) => { executed.push(task); return options.execute ? options.execute(task, key) : { status: "completed" }; },
    waitForIdle: options.waitForIdle, log: options.log, uuid: () => String(queued.length) });
  return { runtime, storage, groups, queued, executed, setTime: (time) => { clock = time; }, drain: () => chain };
}

test("周六20点不入队盐场，旧盐场任务也不能重试", async () => {
  const h = harness();
  h.setTime(gameTimestamp("2026-10-17", 1200));
  h.runtime.poll(); await h.drain();
  assert.equal(h.queued.length, 0);
  const legacy = { type: "task", dateKey: "2026-10-17", batchId: "ALL",
    scheduleId: "salt", executionKey: "autoWeekly:20261017:salt:ALL",
    taskChain: ["batchSaltOnce"], scheduledAt: gameTimestamp("2026-10-17", 1200) };
  for (const plan of [legacy, { ...legacy, scheduleId: "old", executionKey: "legacy" },
    { ...legacy, scheduleId: undefined, taskChain: [] }]) {
    assert.throws(() => h.runtime.retry(plan), /已取消盐场任务/);
  }
  assert.equal(h.executed.length, 0);
  h.runtime.dispose();
});

test("旧盐场排队与运行记录停用且保留证据，已完成历史不变", async () => {
  const h = harness();
  h.setTime(gameTimestamp("2026-10-17", 1200));
  for (const [i, status] of ["queued", "running", "completed"].entries()) {
    h.storage.put(`autoWeekly:20261017:salt:ALL:retry:${i}`, {
      status, dateKey: "2026-10-17", entries: [{ status: "unknown", details: ["待核验"] }],
    });
  }
  h.runtime.poll(); await h.drain();
  const history = h.storage.list().filter(r => r.executionKey.includes(":salt:"));
  assert.deepEqual(history.map(r => r.status), ["skipped", "skipped", "completed"]);
  assert.deepEqual(history.slice(0, 2).map(r => r.retiredPreviousStatus), ["queued", "running"]);
  assert.ok(history.every(r => r.entries[0].status === "unknown"));
  assert.equal(h.executed.length, 0);
  h.runtime.dispose();
});

test("执行前再次拦截盐场，正常日常任务不受影响", async () => {
  const storage = createScheduleStorage(memoryStorage());
  storage.saveConfig({ enabled: true, batches: { A: { groupId: "a" } } });
  let queuedPlan, invoke, executed = 0;
  const runtime = createAutoScheduler({ storage, locks: fakeLocks(),
    now: () => gameTimestamp("2026-10-13", 30),
    getGroups: () => [{ id: "a", tokenIds: ["1"] }], getTokens: () => [{ id: "1" }],
    enqueue: (plan, key, run) => { queuedPlan = plan; invoke = run; },
    execute: async () => { executed++; return { status: "completed" }; },
  });
  runtime.poll();
  queuedPlan.taskChain.push("batchSaltOnce");
  await invoke();
  assert.equal(executed, 0);
  assert.equal(storage.get(queuedPlan.executionKey).status, "skipped");
  runtime.dispose();
});
test("同一key多次tick只入队一次，刷新不重跑已完成", async () => {
  const h = harness(); h.runtime.poll(); h.runtime.tick(); h.runtime.tick(); await h.drain();
  assert.equal(h.queued.length, 1); h.runtime.dispose(); await flush();
  const next = harness({ storage: h.storage }); next.runtime.poll(); await next.drain(); assert.equal(next.queued.length, 0); next.runtime.dispose();
});
test("两个标签页只一个leader", async () => {
  const locks = fakeLocks(), a = harness({ locks }), b = harness({ locks, storage: a.storage });
  a.runtime.poll(); b.runtime.poll(); await a.drain(); await b.drain();
  assert.equal(a.executed.length + b.executed.length, 1); assert.equal(b.runtime.state().leader, false);
  a.runtime.dispose(); b.runtime.dispose();
});
test("到点持续入队，长任务不超时，排队超grace仍执行", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const h = harness({ execute: async () => { await gate; return { status: "completed" }; } });
  h.runtime.poll(); await flush(); h.setTime(gameTimestamp("2026-10-13", 50)); h.runtime.tick();
  assert.equal(h.queued.length, 2); assert.equal(h.executed.length, 1);
  h.setTime(gameTimestamp("2026-10-13", 80)); h.runtime.tick(); release(); await h.drain();
  assert.equal(h.executed.length, 2); assert.ok(h.storage.list().every((r) => r.status === "completed")); h.runtime.dispose();
});
test("入队后移动分组，执行前使用新成员", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const h = harness({ waitForIdle: () => gate }); h.runtime.poll(); await flush();
  h.groups[0].tokenIds = ["2"]; h.groups[1].tokenIds = ["1"]; release(); await h.drain();
  assert.deepEqual(h.executed[0].selectedTokens, ["2"]); h.runtime.dispose();
});
test("执行前重复账号阻止请求，空批次也跳过", async () => {
  for (const ids of [["2"], []]) {
    const h = harness(); h.groups[0].tokenIds = ids; h.runtime.poll(); await h.drain();
    assert.equal(h.executed.length, 0); assert.equal(h.storage.list()[0].status, "skipped"); h.runtime.dispose();
  }
});
test("下午恢复标记missed，不补凌晨", async () => {
  const h = harness(); h.setTime(gameTimestamp("2026-10-13", 1000)); h.runtime.poll(); await h.drain();
  assert.equal(h.executed.length, 0); assert.ok(h.storage.list().every((r) => r.status === "missed")); h.runtime.dispose();
});
test("崩溃残留queued/running转待核验，不自动重跑", async () => {
  for (const status of ["queued", "running"]) {
    const h = harness(); const plan = generateDayPlan("2026-10-13")[0]; h.storage.put(plan.id, { status, dateKey: plan.dateKey });
    h.runtime.poll(); await h.drain(); assert.equal(h.executed.length, 0); assert.equal(h.storage.get(plan.id).status, "warning"); h.runtime.dispose();
  }
});
test("关闭不强停运行，取消后续排队，锁等待运行结束才释放", async () => {
  let release; const gate = new Promise((r) => { release = r; }); const locks = fakeLocks();
  const h = harness({ locks, execute: async () => { await gate; return { status: "completed" }; } });
  h.runtime.poll(); await flush(); h.setTime(gameTimestamp("2026-10-13", 50)); h.runtime.tick();
  h.storage.saveConfig({ ...h.storage.loadConfig(), enabled: false }); h.runtime.poll(); await flush();
  assert.equal(h.runtime.state().leader, true); assert.equal(h.executed.length, 1);
  release(); await h.drain(); await flush(); assert.equal(h.runtime.state().leader, false);
  assert.deepEqual(h.storage.list().map((r) => r.status), ["completed", "skipped"]); h.runtime.dispose();
});
test("手动重试新key，原记录保留，排队时重复点击无效", async () => {
  const h = harness({ execute: async () => ({ status: "partial", entries: [{ status: "failed" }] }) });
  h.runtime.poll(); await h.drain(); const plan = generateDayPlan("2026-10-13")[0];
  const original = h.storage.get(plan.id); h.runtime.retry(plan); assert.throws(() => h.runtime.retry(plan)); await h.drain();
  assert.deepEqual(h.storage.get(plan.id), original); assert.equal(h.storage.list().length, 2); assert.equal(h.storage.list()[1].parentExecutionKey, plan.id); h.runtime.dispose();
});
test("不支持Web Locks时零执行，持久化失败时零执行", async () => {
  const h = harness({ locks: {} }); h.runtime.poll(); await h.drain(); assert.equal(h.executed.length, 0); assert.match(h.runtime.state().error, /Web Locks/); h.runtime.dispose();
  const broken = createScheduleStorage({ getItem: () => '{broken' });
  const b = harness({ storage: broken }); b.runtime.poll(); assert.equal(b.executed.length, 0); assert.ok(b.runtime.state().error); b.runtime.dispose();
});

// Exercise the actual existing Vue executor with injected offline task adapters.
const vue = readFileSync(new URL("../src/views/BatchDailyTasks.vue", import.meta.url), "utf8");
function actualExecutor(callbacks) {
  const start = vue.indexOf("const SCHEDULED_TERMINAL_STATUSES");
  const collector = vue.slice(start, vue.indexOf("const createScopedScheduledTaskFunctions", start));
  const executorStart = vue.indexOf("const executeScheduledTask =");
  const executor = vue.slice(executorStart, vue.indexOf("// 注: boxTypeOptions", executorStart));
  const reports = [], results = [];
  const deps = { getVerificationMetadata, createBottleTaskContext,
    tokens: { value: [{ id: "1", name: "test" }] }, tokenStatus: { value: {} },
    availableTasks: [], summarizeEntries, buildBatchDailyPushReport: (v) => v,
    acquireTaskPreemption: async () => null, verifyTaskDependencies: async () => true,
    selectedTokens: { value: [] }, shouldStop: { value: false },
    isRunning: { value: false }, scheduledExecutionActive: { value: false },
    tokenStore: { closeWebSocketConnectionAsync: async () => {} },
    releasePreemptionLease: async () => {}, addLog: () => {},
    isAutoTaskOpen: () => true,
    ismengjingActivityOpen: { value: true },
    isCarActivityOpen: { value: true }, isarenaActivityOpen: { value: true }, isWeirdTowerActivityOpen: { value: true },
    resolveScheduledTaskFunction: (name, opts) => async () => {
      await callbacks[name](opts); opts.tokenStatusRef.value["1"] = "completed";
    },
    enqueuePushPlusNotification: async (report) => { reports.push(report); return { status: "disabled" }; },
  };
  const run = new Function(...Object.keys(deps), `${collector}\n${executor}\nreturn executeScheduledTask;`)(...Object.values(deps));
  return { run: (auto = true) => run({ id: "x", name: "offline", selectedTokens: ["1"], selectedTasks: Object.keys(callbacks) },
    { scheduled: true, autoWeekly: auto, executionKey: "autoWeekly:test", onResult: (r) => results.push(r) }), reports, results };
}
test("实际Vue执行器自动和人工Bundle均串行，复用报告及dedupeKey", async () => {
  for (const auto of [true, false]) {
    let release; const events = []; const gate = new Promise((r) => { release = r; });
    const h = actualExecutor({ startBatch: async () => { events.push("daily"); await gate; events.push("dailyEnd"); }, claimHangUpRewards: async () => { events.push("hangup"); } });
    const running = h.run(auto); await flush(); assert.deepEqual(events, ["daily"]);
    release(); await running;
    assert.equal(h.results[0].status, "completed"); assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0].dedupeKey, auto ? "autoWeekly:test" : "daily:autoWeekly:test");
  }
});
test("日常计划经调度器和实际Vue执行器先领罐，完成后再执行日常并共享上下文", async () => {
  const expected = ["batchlingguanzi", "startBatch", "claimHangUpRewards", "resetBottles"];
  const events = [], contexts = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ execute: async task => {
    const executor = actualExecutor(Object.fromEntries(task.selectedTasks.map(name => [name, async opts => {
      events.push(name);
      contexts.push(opts.bottleTaskContext);
      if (name === "batchlingguanzi") await gate;
    }])));
    await executor.run();
    return executor.results[0];
  } });
  try {
    h.setTime(gameTimestamp("2026-10-13", 390));
    h.runtime.poll(); await flush();
    assert.deepEqual(h.executed[0].selectedTasks, expected);
    assert.deepEqual(events, ["batchlingguanzi"]);
    release(); await h.drain();
    assert.deepEqual(events, expected);
    assert.equal(contexts.length, 4);
    assert.ok(contexts.every(context => context === contexts[0] && context.dailyGoal === true));
    const record = h.storage.get("autoWeekly:20261013:morningDaily:A");
    assert.deepEqual(record.taskChain, expected);
    assert.equal(record.status, "completed");
  } finally {
    release(); await h.drain(); h.runtime.dispose();
  }
});
test("实际Vue执行器步骤失败仍按顺序继续并记录partial", async () => {
  const events = []; const h = actualExecutor({ batchmengjing: async () => { events.push("dream"); throw new Error("offline failure"); }, batchBuyDreamItems: async () => { events.push("buy"); } });
  await h.run(); assert.deepEqual(events, ["dream", "buy"]); assert.equal(h.results[0].status, "partial"); assert.match(h.results[0].entries[0].details[0], /offline failure/);
});

test("自行定时盐场仍调用原执行器且正常产出报告", async () => {
  let called = 0;
  const h = actualExecutor({ batchSaltOnce: async () => { called++; } });
  await h.run(false);
  assert.equal(called, 1);
  assert.equal(h.results[0].status, "completed");
  assert.equal(h.reports[0].dedupeKey, "daily:autoWeekly:test");
});

test("实际共享队列将人工定时与自动任务串行，前序失败不阻塞后续", async () => {
  const start = vue.indexOf("const enqueueScheduledTask =");
  const code = vue.slice(start, vue.indexOf("// Task countdowns ref", start));
  const events = []; let release;
  const gate = new Promise((r) => { release = r; });
  const enqueue = new Function("executeScheduledTask", "addLog", `let scheduledQueueDepth=0; let scheduledExecutionChain=Promise.resolve(); let preparedPreemption=null; ${code}; return enqueueScheduledTask;`)(
    async () => { events.push("manual"); await gate; throw new Error("offline"); }, () => {},
  );
  enqueue({ name: "manual" }, "m"); const done = enqueue({ name: "auto" }, "a", async () => { events.push("auto"); });
  await flush(); assert.deepEqual(events, ["manual"]); release(); await done; assert.deepEqual(events, ["manual", "auto"]);
});
test("实际旧配置导入保留已有计划，新增配置导入只合并缺失分组", async () => {
  const start = vue.indexOf("const importConfig ="); const code = vue.slice(start, vue.indexOf("// Scheduled Tasks Countdown", start));
  let content, reading; const saved = [], errors = [];
  const deps = {
    FileReader: class { readAsText() { reading = this.onload({ target: { result: JSON.stringify(content) } }); } },
    configTransferBusy: { value: false }, importTokenRecords, remapTokenIds, removeRetiredTasks,
    configBinAccess: { read: async () => null, write: async () => {}, remove: async () => {} },
    gameTokens: { value: [{ id: "1", token: "offline" }] }, scheduledTasks: { value: [{ id: "old" }] },
    tokenGroups: { value: [{ id: "a", name: "existing", tokenIds: ["1"] }] }, batchSettings: {},
    normalizeExtrasSettings: () => {}, saveBatchSettings: () => {}, saveScheduledTasks: () => {},
    saveAutoConfig: async (v) => { saved.push(createScheduleStorage(deps.localStorage).saveConfig(v)); }, localStorage: memoryStorage(), message: { error: (v) => errors.push(v), success: () => {} },
  };
  const run = new Function(...Object.keys(deps), `${code}; return importConfig;`)(...Object.values(deps));
  content = { version: "1.1", tokens: [], scheduledTasks: [{ id: "new", runType: "cron" }] };
  await run({ file: { file: {} } }); await reading; assert.deepEqual(saved, []); assert.deepEqual(deps.scheduledTasks.value.map((t) => t.id), ["old", "new"]);
  content = { ...content, autoWeeklySchedule: { enabled: false }, tokenGroups: [{ id: "a", name: "overwrite", tokenIds: [] }, { id: "b", name: "new", tokenIds: ["1", "missing"] }] };
  await run({ file: { file: {} } }); await reading; assert.equal(saved.length, 1); assert.deepEqual(deps.tokenGroups.value[0].tokenIds, ["1"]); assert.deepEqual(deps.tokenGroups.value[1].tokenIds, ["1"]); assert.deepEqual(errors, []);
  assert.equal(saved[0].batches.A.taskEnabled.camp, true);
  content.autoWeeklySchedule = { enabled: true, batches: { A: { groupId: "a", taskEnabled: { dream: false } } } };
  await run({ file: { file: {} } }); await reading;
  const restored = createScheduleStorage(deps.localStorage).loadConfig();
  assert.equal(restored.batches.A.taskEnabled.dream, false);
  assert.equal(restored.batches.B.taskEnabled.dream, true);
  assert.equal(restored.batches.A.groupId, "a");
  assert.deepEqual(errors, []);
});
test("历史明细压缩保留executionKey/状态/重试，运行中不压缩", () => {
  const storage = createScheduleStorage(memoryStorage());
  storage.put("old", { dateKey: "2026-10-11", status: "partial", entries: [{ status: "failed" }] });
  storage.put("retry", { dateKey: "2026-10-11", parentExecutionKey: "old", status: "running", entries: [1] });
  storage.compactHistory("2026-10-13"); assert.equal(storage.get("old").status, "partial"); assert.equal(storage.get("old").detailCount, 1); assert.equal(storage.get("retry").entries.length, 1);
});


function switchWeeklyTask(storage, batch, rule, value) {
  storage.saveConfig(config => {
    config.batches[batch].taskEnabled[rule] = value;
    return config;
  });
}

test("执行队列遵从各批独立选择，已关闭的格子没有历史记录", async () => {
  const h = harness(), date = "2026-10-14";
  for (const [batch, rule] of [["A", "morningDaily"], ["A", "nightTower"], ["B", "dream"]])
    switchWeeklyTask(h.storage, batch, rule, false);
  const ids = { A: "1", B: "2", C: "3" };
  const plans = generateDayPlan(date, h.storage.loadConfig()).filter(p => p.type === "task");
  for (const p of plans) {
    h.setTime(p.scheduledAt); h.runtime.poll(); await h.drain();
    const record = h.storage.get(p.executionKey);
    if (p.enabled) {
      assert.equal(record.status, "completed");
      assert.deepEqual(h.executed.find(task => task.id === p.executionKey).selectedTokens, [ids[p.batchId]]);
    } else {
      assert.equal(record, null);
      assert.ok(!h.queued.includes(p.executionKey));
    }
  }
  h.runtime.dispose();
});

test("关闭期间不排队、不记错过，重新开启按五分钟边界处理", async () => {
  for (const [offset, expected] of [[300000, "completed"], [300001, "missed"]]) {
    const h = harness(), at = gameTimestamp("2026-10-13", 30), key = "autoWeekly:20261013:nightLight:A";
    switchWeeklyTask(h.storage, "A", "nightLight", false);
    h.runtime.poll(); h.setTime(at + offset); h.runtime.tick();
    assert.equal(h.storage.get(key), null); assert.deepEqual(h.queued, []);
    switchWeeklyTask(h.storage, "A", "nightLight", true);
    h.runtime.tick(); await h.drain(); h.runtime.tick();
    assert.equal(h.storage.get(key).status, expected);
    assert.equal(h.executed.length, expected === "completed" ? 1 : 0);
    h.runtime.dispose();
  }
});

test("入队后关闭任务或批次，执行前静默跳过，重新启用和手动重试均不会重放", async () => {
  for (const master of [false, true]) {
    let resume; const logs = [];
    const gate = new Promise(resolve => { resume = resolve; });
    const h = harness({ waitForIdle: () => gate, log: (...args) => logs.push(args) });
    const p = generateDayPlan("2026-10-13").find(p => p.scheduleId === "nightLight" && p.batchId === "A");
    h.runtime.poll(); await flush(); assert.equal(h.storage.get(p.executionKey).status, "queued");
    const cfg = h.storage.loadConfig();
    if (master) cfg.batches.A.enabled = false;
    else cfg.batches.A.taskEnabled.nightLight = false;
    h.storage.saveConfig(cfg);
    resume(); await h.drain();
    assert.equal(h.storage.get(p.executionKey).status, "skipped");
    assert.equal(h.storage.get(p.executionKey).disabledBeforeStart, true);
    assert.match(h.storage.get(p.executionKey).reason, /已关闭/); assert.deepEqual(logs, []);
    assert.throws(() => h.runtime.retry(p), /已关闭/);
    cfg.batches.A.enabled = true; cfg.batches.A.taskEnabled.nightLight = true;
    h.storage.saveConfig(cfg); h.runtime.tick();
    assert.throws(() => h.runtime.retry(p), /不可重复重试/);
    assert.deepEqual(h.queued, [p.executionKey]); assert.deepEqual(h.executed, []);
    h.runtime.dispose();
  }
});

test("运行中关闭单项允许安全结束，普通失败仅在该项重开后可手动重试", async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const h = harness({ execute: async () => { await gate; return { status: "failed" }; } });
  const p = generateDayPlan("2026-10-13").find(p => p.scheduleId === "nightLight" && p.batchId === "A");
  h.runtime.poll(); await flush();
  assert.equal(h.storage.get(p.executionKey).status, "running");
  switchWeeklyTask(h.storage, "A", p.scheduleId, false); h.runtime.tick();
  assert.equal(h.storage.get(p.executionKey).status, "running");
  finish(); await h.drain(); assert.equal(h.storage.get(p.executionKey).status, "failed");
  assert.throws(() => h.runtime.retry(p), /已关闭/); assert.equal(h.queued.length, 1);
  switchWeeklyTask(h.storage, "A", p.scheduleId, true);
  assert.equal(h.runtime.retry(p), true); await h.drain();
  assert.equal(h.storage.get(h.queued[1]).parentExecutionKey, p.executionKey);
  assert.ok(h.queued[1].startsWith(p.executionKey + ":retry:")); h.runtime.dispose();
});

test("重复账号仅阻止同项参与批次，移动开关后也不能跨批重复执行", async () => {
  const h = harness(), day = "2026-10-13";
  h.groups[1].tokenIds = ["1", "2"];
  switchWeeklyTask(h.storage, "B", "nightLight", false);
  h.runtime.poll(); await h.drain(); assert.deepEqual(h.executed[0].selectedTokens, ["1"]);
  h.setTime(gameTimestamp(day, 50)); h.runtime.tick(); await h.drain();
  assert.match(h.storage.get("autoWeekly:20261013:nightTower:A").reason, /重复账号/);
  switchWeeklyTask(h.storage, "A", "nightLight", false);
  switchWeeklyTask(h.storage, "B", "nightLight", true);
  h.setTime(gameTimestamp(day, 90)); h.runtime.tick(); await h.drain();
  assert.match(h.storage.get("autoWeekly:20261013:nightLight:B").reason, /已开始处理重复账号/);
  assert.equal(h.executed.length, 1);
  h.setTime(gameTimestamp(day, 150)); h.runtime.tick(); await h.drain();
  assert.deepEqual(h.executed.map(task => task.selectedTokens), [["1"], ["3"]]); h.runtime.dispose();
});

test("完整配置经实际导出入口保留 39 个选择，选区导出保持原范围", async () => {
  const storage = createScheduleStorage(memoryStorage());
  const autoConfig = { value: storage.saveConfig({ batches: { A: { taskEnabled: { nightTower: false } }, C: { taskEnabled: { tokenRefresh: false } } } }) };
  const output = [], errors = [];
  const deps = {
    configTransferBusy: { value: false }, tokens: { value: [{ id: "1" }, { id: "2" }] },
    configBinAccess: {}, exportTokenRecords: async records => ({ records, included: 0, missing: 0 }),
    scheduledTasks: { value: [] }, localStorage: memoryStorage(), tokenGroups: { value: [] },
    autoConfig, batchSettings: { dreamPurchaseList: [] }, showConfigExport: { value: true },
    downloadConfig: data => output.push(JSON.parse(JSON.stringify(data))),
    message: { error: e => errors.push(e), success() {} },
  };
  const source = vue.slice(vue.indexOf("const exportConfig ="), vue.indexOf("const importConfig ="));
  const run = new Function(...Object.keys(deps), source + ";return exportConfig;")(...Object.values(deps));
  await run({ includeBin: false }); await run({ ids: ["2"], includeBin: false });
  assert.deepEqual(errors, []);
  assert.deepEqual(output[0].autoWeeklySchedule, autoConfig.value);
  assert.deepEqual(createScheduleStorage(memoryStorage()).saveConfig(output[0].autoWeeklySchedule), autoConfig.value);
  assert.equal(output[1].autoWeeklySchedule, undefined);
  assert.equal(output[1].scope, "selected-accounts");
});

test("中断恢复时已关闭的排队项记跳过，运行中的项仍待核验", async () => {
  const h = harness(), date = "2026-10-13";
  for (const [batchId, status] of [["A", "queued"], ["B", "running"]]) {
    const p = generateDayPlan(date).find(p => p.batchId === batchId && p.scheduleId === "nightLight");
    h.storage.put(p.executionKey, { ...p, status });
    switchWeeklyTask(h.storage, batchId, p.scheduleId, false);
  }
  h.runtime.poll(); await h.drain();
  assert.equal(h.storage.get("autoWeekly:20261013:nightLight:A").disabledBeforeStart, true);
  assert.equal(h.storage.get("autoWeekly:20261013:nightLight:A").status, "skipped");
  assert.equal(h.storage.get("autoWeekly:20261013:nightLight:B").status, "warning");
  assert.deepEqual(h.executed, []); h.runtime.dispose();
});

test("跨午夜排队保留同一规则其他批次的防重证据，队列结束后可压缩", () => {
  const storage = createScheduleStorage(memoryStorage());
  const prior = { dateKey: "2026-10-13", scheduleId: "eveningDaily" };
  const a = "autoWeekly:20261013:eveningDaily:A", b = "autoWeekly:20261013:eveningDaily:B";
  storage.put(a, { ...prior, batchId: "A", status: "completed", startedAt: 1, startedTokenIds: ["x"], entries: [] });
  storage.put(b, { ...prior, batchId: "B", status: "queued" });
  storage.compactHistory("2026-10-14");
  assert.deepEqual(storage.get(a).startedTokenIds, ["x"]);
  storage.put(b, { ...prior, batchId: "B", status: "skipped" });
  storage.compactHistory("2026-10-15");
  assert.equal(storage.get(a).startedTokenIds, undefined);
  assert.equal(storage.get(a).status, "completed");
});

