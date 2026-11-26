import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { drawSize, runPhoenixPrayer } from "../src/utils/batch/phoenixPrayer.js";
import { prayerWindow } from "../src/utils/batch/phoenixSign.js";
import { batchPhoenixPrayer } from "../src/utils/batch/tasksPhoenixPrayer.js";

const capture = JSON.parse(readFileSync(new URL("./fixtures/phoenix-final-20261119.json", import.meta.url), "utf8"));
const pass = 2611131;
const sign = 2611135;
const salt = 261113141;
const reset = capture.last.reset;
const now = reset * 1000 + 20 * 3600000;
const completeSign = capture.last.signs.at(-1).record;
const clone = structuredClone;

function simulate(overrides = {}) {
  const s = {
    role: 501,
    now,
    reset,
    today: 10,
    total: 20,
    tickets: 0,
    salt: 0,
    record: { ...completeSign },
    slot: 7,
    catalog: [],
    claimed: {},
    milestones: { 68: true, 69: true, 70: true, 71: true },
    passRefund: 0,
    passProgress: {},
    material: 31,
    bought: {},
    ...overrides,
  };
  const ledger = new Map();
  const calls = [];
  const statuses = [];
  const storage = {
    getItem: (key) => ledger.get(key) ?? null,
    setItem: (key, value) => ledger.set(key, value),
    removeItem: (key) => ledger.delete(key),
  };
  const war = () => ({
    dailyTime: s.reset,
    complete: { 261113101: 1, 261113102: 1, 261113105: s.today, 261113142: s.total, [salt]: s.salt },
    taskClaimed: { 261113101: true, 261113102: true, 261113105: true, 261113142: true, ...s.claimed },
    rewardClaimed: { ...s.passProgress },
  });
  const catalog = () => ({ activity: {
    activity: s.catalog,
    warOrderActivityInfo: { [pass]: war() },
    commonActivityInfo: { [sign]: { record: { ...s.record } }, 2611133: { record: { ...s.bought } } },
  } });
  function respond(cmd, args) {
    switch (cmd) {
      case "role_getroleinfo": return { role: { roleId: s.role, items: { 5295: { quantity: s.tickets }, 5297: { quantity: s.material } } } };
      case "activity_get": return catalog();
      case "activity_warorderget": return { activity: { warOrderActivityInfo: { [pass]: war() } } };
      case "activity_getlotteryinfo": return { lotteryInfo: { lotteryNum: s.total, cumulativeClaimedMap: { ...s.milestones } } };
      case "activity_claimsignreward": {
        assert.equal(args.activityId, sign);
        const slot = args.patchDay || s.slot;
        assert.ok(!s.record[slot], `duplicate sign ${slot}`);
        s.record[slot] = Math.floor(s.now / 1000);
        return catalog();
      }
      case "activity_lottery":
        assert.ok(s.tickets >= args.times);
        s.tickets -= args.times;
        s.today += args.times;
        s.total += args.times;
        return { lotteryInfo: { lotteryNum: s.total } };
      case "activity_claimlotterycumulative":
        assert.ok([68, 69, 70, 71].includes(args.id));
        assert.ok(!s.milestones[args.id]);
        s.milestones[args.id] = true;
        s.tickets++;
        return { lotteryInfo: { cumulativeClaimedMap: { [args.id]: true } } };
      case "activity_warordertaskclaim":
        assert.equal(args.actId, pass);
        assert.equal(args.missionId, salt);
        assert.equal(s.salt, 1);
        assert.ok(!s.claimed[salt]);
        s.claimed[salt] = true;
        return catalog();
      case "activity_warorderrewardclaim": {
        if (!s.passRefund)
          throw Object.assign(new Error("已领完"), { code: 3500020, requestCmd: cmd });
        const tickets = s.passRefund;
        s.passRefund = 0;
        s.passProgress[1281] = 1;
        s.tickets += tickets;
        return { ...catalog(), reward: [{ itemId: 5295, value: tickets }] };
      }
      default: assert.fail(cmd);
    }
  }
  const run = (hook = (cmd, args) => respond(cmd, args), stopped = () => false) => runPhoenixPrayer({
    expectedRole: 501,
    now: () => s.now,
    storage,
    stopped,
    onStatus: (status, warnings) => statuses.push({ status, warnings }),
    send: (cmd, args) => {
      calls.push({ cmd, args });
      return hook(cmd, args);
    },
  });
  const args = (cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
  return { s, calls, args, ledger, storage, statuses, run, respond };
}

test("真实记录投影：同一 patchDay=0 在首日写1、末日写7，补签3至6的时间都在末日", () => {
  assert.equal(capture.first.signs[0].patchDay, 0);
  assert.deepEqual(Object.keys(capture.first.signs[0].record), ["1"]);
  assert.equal(reset - capture.first.reset, 6 * 86400);
  assert.deepEqual(capture.last.signs.map((e) => e.patchDay), [3, 4, 5, 6, 0]);
  for (const e of capture.last.signs) {
    const slot = e.patchDay || 7;
    assert.ok(e.record[slot] >= reset && e.record[slot] < reset + 86400);
  }
  assert.equal(capture.last.signs.at(-2).record[7], undefined);
});

test("真实记录投影：三份文件的盐场状态、兑换单位及累计82回包", () => {
  assert.deepEqual(capture.samples.map((s) => [s.commands, s.errors]), [[50, 0], [16, 0], [6, 0]]);
  assert.ok(capture.samples[0].salt.every((s) => s.count === 0));
  const states = capture.samples[1].salt;
  assert.ok(states.some((s) => s.count === 1 && s.claimed !== true));
  assert.ok(states.some((s) => s.method === "warOrderTaskClaim" && s.claimed === true));
  for (const sample of capture.samples) {
    for (const row of sample.exchange) {
      const { activityId, goodsId, quantity } = row.order;
      assert.equal(row.record[goodsId], quantity);
      if (activityId === 2611136) {
        const [gift, amount] = goodsId === 261113607 ? [1033, 10] : [1022, 2500];
        assert.deepEqual(row.reward, [[gift, amount * quantity]]);
        assert.deepEqual(Object.keys(row.updatedItems), [String(gift)]);
      } else {
        const pill = goodsId === 261113303;
        assert.deepEqual(row.reward, [[pill ? 1017 : 15001, (pill ? 1 : 5000) * quantity]]);
        if (row.previous5297 !== null)
          assert.equal(row.previous5297 - row.updatedItems[5297], (pill ? 3 : 5) * quantity);
      }
    }
  }
  assert.ok(capture.samples[1].cumulativeClaims.includes(82));
  assert.ok(capture.samples[2].lotteryQueries.some((row) => row.total === 111 && row.claimed.includes(82)));
});

test("真实补签第6日回包作为输入，仍领取今天第7格；同日重跑零写请求", async () => {
  const h = simulate({ record: clone(capture.last.signs.at(-2).record) });
  const result = await h.run();
  assert.deepEqual(h.args("activity_claimsignreward"), [{ activityId: sign, patchDay: 0 }]);
  assert.match(result, /末日已核对7天点卯/);
  const before = h.calls.length;
  await h.run();
  assert.ok(h.calls.slice(before).every((c) => ["role_getroleinfo", "activity_get", "activity_warorderget", "activity_getlotteryinfo"].includes(c.cmd)));
});

test("模拟缺第1至6格，先确认今天再逐格补签；回读已由另一设备补的格直接跳过", async () => {
  const h = simulate({ record: {} });
  let signed = false;
  await h.run((cmd, args) => {
    if (cmd === "activity_get" && signed)
      h.s.record[4] = reset + 5;
    const out = h.respond(cmd, args);
    if (cmd === "activity_claimsignreward")
      signed = true;
    return out;
  });
  assert.deepEqual(h.args("activity_claimsignreward").map((a) => a.patchDay), [0, 1, 2, 3, 5, 6]);
  assert.equal(Object.keys(h.s.record).length, 7);
});

test("末日10连优先、返券重新读入、最后不足10单抽；两商店无消费", async () => {
  const h = simulate({ tickets: 20, passRefund: 3, salt: 1, milestones: { 68: true, 69: true }, material: 31 });
  const result = await h.run();
  assert.deepEqual(h.args("activity_lottery").map((a) => a.times), [10, 10, 1, 1, 1, 1, 1]);
  assert.equal(h.s.tickets, 0);
  assert.equal(h.s.total, 45);
  assert.deepEqual(h.args("activity_warordertaskclaim"), [{ actId: pass, missionId: salt }]);
  assert.deepEqual(h.args("activity_claimlotterycumulative").map((a) => a.id), [70, 71]);
  assert.match(result, /材料5297余31.*复活丹1份、饼干5组/);
  assert.equal(h.statuses.at(-1).status, "warning");
  assert.ok(!h.calls.some((c) => c.cmd === "activity_exchange" || c.cmd.startsWith("war_")));
});

test("余额49且已换复活丹只列9组饼干；余额不足及缺失商店字段均无兑换", async () => {
  for (const [material, bought, expected] of [[49, { 261113303: 1 }, /复活丹0份、饼干9组/], [2, {}, /复活丹0份、饼干0组/], [3, {}, /复活丹1份、饼干0组/], [8, {}, /复活丹1份、饼干1组/]]) {
    const h = simulate({ material, bought });
    assert.match(await h.run(), expected);
    assert.equal(h.args("activity_exchange").length, 0);
  }
  const h = simulate();
  const result = await h.run((cmd, args) => {
    const out = h.respond(cmd, args);
    if (cmd === "activity_get")
      delete out.activity.commonActivityInfo[2611133];
    return out;
  });
  assert.match(result, /第二类商店记录待核对/);
});

test("普通日维持10抽并保留返券；江湖黑市的结束时间不能触发凤仪清券", async () => {
  const earlier = reset - 86400;
  const h = simulate({ now: earlier * 1000 + 15 * 3600000, reset: earlier, slot: 6, today: 9, total: 20, tickets: 12, record: {}, catalog: [{ id: 9, openTime: earlier * 1000, endTime: reset * 1000 }] });
  await h.run();
  assert.deepEqual(h.args("activity_claimsignreward").map((x) => x.patchDay), [0]);
  assert.deepEqual(h.args("activity_lottery").map((x) => x.times), [1]);
  assert.equal(h.s.tickets, 11);
});

test("活动窗口只认签到活动自身，单个唯一有效窗口；同日截止瞬间、重复目录、错误单位停止", () => {
  const end = (reset + 86400) * 1000;
  const start = (reset - 6 * 86400) * 1000;
  const entry = { id: sign, openTime: start, endTime: end };
  assert.deepEqual(prayerWindow([entry], sign, reset, now), { finalDay: true, endTime: end });
  assert.equal(prayerWindow([{ ...entry, id: 9 }], sign, reset, now), undefined);
  for (const [rows, time] of [[[entry, entry], now], [[entry], end], [[{ ...entry, endTime: reset }], now]]) {
    assert.throws(() => prayerWindow(rows, sign, reset, time));
  }
});

test("末日候选但今日签到实际写到第6格时停止，重复运行不会再次发送", async () => {
  const h = simulate({ record: {}, slot: 6, tickets: 20 });
  await assert.rejects(h.run(), /点卯/);
  await assert.rejects(h.run(), /点卯/);
  assert.equal(h.args("activity_claimsignreward").length, 1);
  assert.equal(h.args("activity_lottery").length, 0);
});

test("末日补签超时仅回读；未确认时跨刷新防重；已兑现时不重复补", async () => {
  for (const applied of [true, false]) {
    const record = { ...completeSign };
    delete record[3];
    const h = simulate({ record });
    const p = h.run((cmd, args) => {
      if (cmd === "activity_claimsignreward") {
        if (applied)
          h.respond(cmd, args);
        throw new Error("回包超时");
      }
      return h.respond(cmd, args);
    });
    if (applied) {
      await p;
    } else {
      await assert.rejects(p, /点卯/);
      await assert.rejects(h.run(), /上次点卯/);
      h.s.record[3] = reset + 1;
    }
    await h.run();
    assert.equal(h.args("activity_claimsignreward").length, 1);
  }
});

test("末日抽奖超时以双计数复核；未确认时不重发", async () => {
  for (const applied of [true, false]) {
    const h = simulate({ tickets: 10 });
    const p = h.run((cmd, args) => {
      if (cmd === "activity_lottery") {
        if (applied)
          h.respond(cmd, args);
        throw new Error("超时");
      }
      return h.respond(cmd, args);
    });
    if (applied) {
      await p;
      await h.run();
    } else {
      await assert.rejects(p, /抽奖/);
      await assert.rejects(h.run(), /抽奖/);
    }
    assert.equal(h.args("activity_lottery").length, 1);
  }
});

test("盐场未完成、缺字段和已领取均零领奖；超时只读复核，未决不重放", async () => {
  for (const [count, claimed] of [[0, false], [undefined, false], [1, true]]) {
    const h = simulate({ salt: count, claimed: { [salt]: claimed } });
    await h.run();
    assert.equal(h.args("activity_warordertaskclaim").length, 0);
  }
  for (const applied of [true, false]) {
    const h = simulate({ salt: 1 });
    const run = h.run((cmd, args) => {
      if (cmd === "activity_warordertaskclaim") {
        if (applied)
          h.respond(cmd, args);
        throw new Error("超时");
      }
      return h.respond(cmd, args);
    });
    if (applied) {
      await run;
    } else {
      await assert.rejects(run, /领奖/);
      await assert.rejects(h.run(), /领奖/);
    }
    assert.equal(h.args("activity_warordertaskclaim").length, 1);
  }
});

test("累计档和战令领奖超时，分别用已领键和战令档位增长核实；无增长不重放", async () => {
  for (const cmd of ["activity_claimlotterycumulative", "activity_warorderrewardclaim"]) {
    for (const applied of [false, true]) {
      const h = simulate({ milestones: { 68: true, 69: true, 70: true, ...(cmd === "activity_warorderrewardclaim" ? { 71: true } : {}) }, passRefund: 1 });
      const p = h.run((c, args) => {
        if (c === cmd) {
          if (applied)
            h.respond(c, args);
          throw new Error("timeout");
        }
        return h.respond(c, args);
      });
      if (applied) {
        await p;
        await h.run();
      } else {
        await assert.rejects(p, /领奖/);
        await assert.rejects(h.run(), /领奖/);
      }
      assert.equal(h.args(cmd).length, 1);
    }
  }
});

test("停止、换号、跨日和持久化失败均阻止新消费", async () => {
  for (const reason of ["stop", "role", "midnight", "ledger"]) {
    const h = simulate({ tickets: 20 });
    let stop = false;
    if (reason === "ledger")
      h.storage.setItem = () => {};
    const p = h.run((cmd, args) => {
      const r = h.respond(cmd, args);
      if (cmd === "activity_getlotteryinfo") {
        if (reason === "stop")
          stop = true;
        if (reason === "role")
          h.s.role = 502;
        if (reason === "midnight")
          h.s.now = (reset + 86400) * 1000;
      }
      return r;
    }, () => stop);
    await assert.rejects(p);
    assert.equal(h.args("activity_lottery").length, 0);
  }
});

test("奖励或库存异常不能形成无界循环，单轮最多100个抽奖请求", async () => {
  const h = simulate({ tickets: 1100 });
  await assert.rejects(h.run(), /请求上限/);
  assert.equal(h.args("activity_lottery").length, 100);
  assert.equal(h.s.tickets, 100);
  assert.equal(drawSize(99, 9, true), 1);
  assert.equal(drawSize(99, 10, true), 10);
});

test("过期跳过及商店待核对能传到批量和定时共用的账号结果", async () => {
  for (const [timestamp, expected] of [[now, "warning"], [(reset + 86400) * 1000, "skipped"]]) {
    const h = simulate({ now: timestamp });
    const ref = (value) => ({ value });
    const result = await batchPhoenixPrayer({
      selectedTokens: ref(["A"]),
      tokens: ref([{ id: "A", roleId: 501 }]),
      locks: { request: async (k, o, fn) => fn({}) },
      storage: h.storage,
      isBusy: () => false,
      isRunning: ref(false),
      shouldStop: ref(false),
      currentRunningTokenId: ref(null),
      tokenStatus: ref({}),
      addLog() {},
      message: {},
      openReadOnly: async () => {},
      closeReadOnly: async () => {},
      acquireLease: async () => null,
      releaseLease: async () => {},
      runPhoenixPrayer: (options) => runPhoenixPrayer({ ...options, now: () => h.s.now, send: h.respond }),
    });
    assert.equal(result[0].status, expected);
    assert.equal(result[0].warnings.length > 0, expected === "warning");
  }
});

test("同一天两个角色复用同一存储，仅阻止自身未决抽奖；每日不足10券保持单抽", async () => {
  const a = simulate({ tickets: 10 });
  const b = simulate({ role: 502, tickets: 2 });
  await assert.rejects(a.run((cmd, args) => {
    if (cmd === "activity_lottery")
      throw new Error("超时");
    return a.respond(cmd, args);
  }), /抽奖/);
  const calls = [];
  await runPhoenixPrayer({ expectedRole: 502, storage: a.storage, now: () => now, send(cmd, args) {
    calls.push([cmd, args]);
    return b.respond(cmd, args);
  } });
  assert.deepEqual(calls.filter(([cmd]) => cmd === "activity_lottery").map(([,args]) => args.times), [1, 1]);
  await assert.rejects(a.run(), /上一次抽奖/);
  assert.equal(drawSize(0, 9), 1);
});

test("末日批量入口使用模拟时钟，两次祈愿请求之间至少1000毫秒", async (t) => {
  const h = simulate({ tickets: 11 });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const starts = [];
  const ref = (value) => ({ value });
  let done = false;
  try {
    const run = batchPhoenixPrayer({
      selectedTokens: ref(["A"]),
      tokens: ref([{ id: "A", roleId: 501 }]),
      locks: { request: async (k, o, fn) => fn({}) },
      storage: h.storage,
      isBusy: () => false,
      isRunning: ref(false),
      shouldStop: ref(false),
      currentRunningTokenId: ref(null),
      tokenStatus: ref({}),
      openReadOnly: async () => {},
      closeReadOnly: async () => {},
      acquireLease: async () => null,
      releaseLease: async () => {},
      message: {},
      addLog() {},
      tokenStore: { sendMessageWithPromise(id, cmd, args) {
        assert.equal(id, "A");
        starts.push([cmd, Date.now()]);
        return h.respond(cmd, args);
      } },
    }).finally(() => {
      done = true;
    });
    for (let i = 0; i < 200 && !done; i++) {
      for (let j = 0; j < 20; j++) await Promise.resolve();
      t.mock.timers.tick(1000);
    }
    assert.equal(done, true);
    assert.equal((await run)[0].status, "warning");
    assert.equal(starts.filter(([cmd]) => cmd === "activity_lottery").length, 2);
    assert.ok(starts.slice(1).every(([,time], i) => time - starts[i][1] >= 1000), JSON.stringify(starts));
  } finally {
    t.mock.timers.reset();
  }
});
