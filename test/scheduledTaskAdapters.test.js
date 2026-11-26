// BATCH_SCHEDULE_TASK_ALIGNMENT_20261115_R2
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { availableTasks } from "../src/utils/batch/constants.js";
import { createScheduledTaskAdapters } from "../src/utils/batch/scheduledTaskAdapters.js";
import { createTasksJianghuMarket } from "../src/utils/batch/tasksJianghuMarket.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}
function fakeLocks({ busy = [] } = {}) {
  const calls = [];
  return {
    calls,
    async request(name, options, callback) {
      calls.push({ name, options });
      return callback(busy.includes(name) ? null : { name });
    },
  };
}
function baseDeps() {
  return {
    selectedTokens: { value: ["a"] },
    tokens: { value: [{ id: "a", name: "A" }] },
    tokenStatus: { value: {} },
    isRunning: { value: false },
    shouldStop: { value: false },
    currentRunningTokenId: { value: null },
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings: { maxActive: 1 },
    tokenStore: { sendMessageWithPromise: async () => ({}) },
    addLog: () => {},
    message: { error: () => {}, warning: () => {}, success: () => {} },
  };
}

test("四个新增任务进入可选列表和日常分组，车辆批量任务从页面/注册表移除", () => {
  const required = ["batchBonfireSignup", "batchPhoenixPrayer", "batchJianghuMarket", "batchApexGuess"];
  for (const value of required) assert.ok(availableTasks.some((item) => item.value === value), value);
  assert.equal(availableTasks.some((item) => ["batchSmartSendCar", "batchClaimCars"].includes(item.value)), false);

  const vue = read("src/views/BatchDailyTasks.vue");
  const start = vue.indexOf("const taskGroupDefinitions = [");
  const dailyStart = vue.indexOf('name: "daily"', start);
  const dailyEnd = vue.indexOf("  },", dailyStart);
  assert.ok(start >= 0 && dailyStart > start && dailyEnd > dailyStart);
  const daily = vue.slice(dailyStart, dailyEnd);
  for (const value of required) assert.ok(daily.includes(`"${value}"`), value);
  assert.ok(daily.includes('"batchRefreshTokens"'));
  assert.equal((vue.match(/\.\.\.createScheduledAdapters/g) || []).length, 2);
  assert.doesNotMatch(vue, /batchSmartSendCar|batchClaimCars|isCarActivityOpen|智能发车|一键收车/);
});

test("适配器复用四个业务执行器、共享外层锁上下文并强制Apex自动识别", async () => {
  const deps = baseDeps();
  const storage = memoryStorage({ "xyzw_jianghu_list_v1": JSON.stringify([{ id: 1, quantity: 1 }]) });
  const locks = fakeLocks();
  const calls = [];
  const captured = {};
  const rows = { value: [] };
  const adapters = createScheduledTaskAdapters({
    deps, storage, locks, rows,
    openReadOnly: async () => {},
    closeReadOnly: async () => {},
    factories: {
      createTasksBonfire: (d) => {
        captured.bonfire = d;
        return { batchBonfireSignup: async () => { calls.push("bonfire"); return []; } };
      },
      batchPhoenixPrayer: async (d) => { captured.phoenix = d; calls.push("phoenix"); return []; },
      createTasksJianghuMarket: (d) => {
        captured.market = d;
        return { batchJianghuMarket: async (list) => { captured.marketList = list; calls.push("market"); return []; } };
      },
      createTasksApex: (d) => {
        captured.apex = d;
        return { batchApexGuess: async (options) => { captured.apexOptions = options; calls.push("apex"); return []; } };
      },
      createMarketLedger: (s) => ({ storage: s }),
      normalizeMarketList: (list) => list,
    },
  });

  // The market list is read at execution time, not when the adapter is created.
  storage.setItem("xyzw_jianghu_list_v1", JSON.stringify([{ id: 2, quantity: 2 }]));
  await adapters.batchBonfireSignup();
  await adapters.batchPhoenixPrayer();
  await adapters.batchJianghuMarket();
  await adapters.batchApexGuess();

  assert.deepEqual(calls, ["bonfire", "phoenix", "market", "apex"]);
  assert.deepEqual(locks.calls.map((item) => item.name), ["xyzw-bonfire-signup-v1", "xyzw-jianghu-market-v1", "xyzw-apex-guess-v1"]);
  assert.ok(locks.calls.every((item) => item.options.ifAvailable === true));
  assert.equal(captured.bonfire.isBusy(), false);
  assert.equal(await captured.bonfire.acquireLease(), null);
  await captured.bonfire.releaseLease(null);
  assert.equal(captured.phoenix.locks, locks);
  assert.equal(captured.market.storage, storage);
  assert.deepEqual(captured.marketList, [{ id: 2, quantity: 2 }]);
  assert.equal(captured.apex, deps);
  assert.deepEqual(captured.apexOptions, { useManualScheduleId: false });
  assert.equal(captured.market.rows, rows);
});

test("江湖黑市清单为空或损坏时零执行，Web Locks冲突不调用业务函数", async () => {
  const deps = baseDeps();
  const storage = memoryStorage({ "xyzw_jianghu_list_v1": "[]" });
  const locks = fakeLocks({ busy: ["xyzw-bonfire-signup-v1"] });
  let bonfireCalls = 0, marketCalls = 0;
  const adapters = createScheduledTaskAdapters({
    deps, storage, locks, openReadOnly: async () => {}, closeReadOnly: async () => {},
    factories: {
      createTasksBonfire: () => ({ batchBonfireSignup: async () => { bonfireCalls++; } }),
      batchPhoenixPrayer: async () => [],
      createTasksJianghuMarket: () => ({ batchJianghuMarket: async () => { marketCalls++; } }),
      createTasksApex: () => ({ batchApexGuess: async () => [] }),
      createMarketLedger: () => ({}),
      normalizeMarketList: (list) => list,
    },
  });
  const busyRows = await adapters.batchBonfireSignup();
  assert.deepEqual(busyRows.map((row) => row.status), ["skipped"]);
  await assert.rejects(async () => adapters.batchJianghuMarket(), /清单为空/);
  assert.equal(bonfireCalls, 0);
  assert.equal(marketCalls, 0);

  storage.setItem("xyzw_jianghu_list_v1", "{broken");
  await assert.rejects(async () => adapters.batchJianghuMarket(), /格式损坏/);
});

test("逐鹿盐山定时固定自动识别；无开放赛程跳过，多候选仍失败", async () => {
  const deps = baseDeps();
  deps.selectedTokens.value = ["a", "b"];
  const storage = memoryStorage({ "xyzw_jianghu_list_v1": JSON.stringify([{ id: 1, quantity: 1 }]) });
  const locks = fakeLocks();
  let receivedOptions;
  const adapters = createScheduledTaskAdapters({
    deps, storage, locks, openReadOnly: async () => {}, closeReadOnly: async () => {},
    factories: {
      createTasksBonfire: () => ({ batchBonfireSignup: async () => [] }),
      batchPhoenixPrayer: async () => [],
      createTasksJianghuMarket: () => ({ batchJianghuMarket: async () => [] }),
      createTasksApex: () => ({ batchApexGuess: async (options) => {
        receivedOptions = options;
        return [
          { tokenId: "a", status: "failed", details: ["无法识别唯一可竞猜赛程：当前时间没有处于 Unlocked / Locked 状态的第一赛季赛程"] },
          { tokenId: "b", status: "failed", details: ["当前时间检测到多个开放赛程，停止新竞猜"] },
        ];
      } }),
      createMarketLedger: () => ({}),
      normalizeMarketList: (list) => list,
    },
  });
  const rows = await adapters.batchApexGuess();
  assert.deepEqual(receivedOptions, { useManualScheduleId: false });
  assert.deepEqual(rows.map((row) => row.status), ["skipped", "failed"]);
  assert.equal(deps.tokenStatus.value.a, "skipped");
  assert.equal(locks.calls[0].name, "xyzw-apex-guess-v1");
});

test("江湖黑市任务工厂返回逐账号可供PushPlus使用的结果明细", async () => {
  const deps = {
    selectedTokens: { value: ["a", "b"] },
    tokens: { value: [{ id: "a", name: "A" }, { id: "b", name: "B" }] },
    tokenStatus: { value: {} },
    isRunning: { value: false },
    shouldStop: { value: false },
    isBusy: () => false,
    rows: { value: [] },
    ledger: {},
    acquireLease: async () => null,
    releaseLease: async () => {},
    openReadOnly: async () => {},
    closeReadOnly: async () => {},
    delayConfig: { command: 300 },
    tokenStore: { sendMessageWithPromise: async () => ({}) },
    addLog: () => {},
    message: { error: () => {} },
    runJianghuMarket: async ({ id }) => id === "a"
      ? { status: "completed", message: "购买已核验" }
      : { status: "unverified", message: "购买结果待核验" },
  };
  const task = createTasksJianghuMarket(deps);
  const results = await task.batchJianghuMarket([{ id: 1, quantity: 1 }]);
  assert.deepEqual(results.map((item) => item.status), ["completed", "warning"]);
  assert.deepEqual(results.map((item) => item.tokenId), ["a", "b"]);
  assert.match(results[0].details[0], /购买已核验/);
  assert.match(results[1].warnings[0], /待核验/);
  assert.equal(results[0].verificationRequired, false);
  assert.equal(results[1].verificationRequired, true);
});
