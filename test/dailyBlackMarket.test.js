import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { defaultLowMarketLimits, runDailyBlackMarket, validLowMarketLimits } from "../src/utils/batch/dailyBlackMarket.js";
import { createTasksStore } from "../src/utils/batch/tasksStore.js";

const captures = JSON.parse(readFileSync(new URL("./fixtures/daily-market-20261111.json", import.meta.url)));
// 只放宽黄金宝箱和普通鱼竿；黄金鱼竿继续使用默认1999上限。
const relaxed = () => ({ ...defaultLowMarketLimits(), 2: 300, 11: 800 });
function memory() {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
}

// 回放只使用货架折扣、购买请求、奖励和余额。第一份缺少购买前的全量角色包，首笔200来自手动记录。
function harness(trace = captures[1], opts = {}) {
  let prev = trace.startBalance ?? trace.purchases[0].after + 200;
  const prices = new Map();
  for (const receipt of trace.purchases) {
    prices.set(receipt.page + ":" + receipt.goodsId, { ...receipt, price: prev - receipt.after });
    prev = receipt.after;
  }
  const balanceAtOpen = opts.balance ?? trace.startBalance ?? trace.purchases[0].after + 200;
  const h = {
    balance: balanceAtOpen, stage: trace.startStage ?? 454, page: 0, roleId: 501, buys: [], calls: [],
    used: new Set(), storage: memory(), stopped: false, limits: defaultLowMarketLimits(),
    discounts: structuredClone(trace.shelves), getRole() {
      return { roleId: h.roleId, levelId: h.stage, diamond: h.balance, dailyTask: { dailyTime: 1794326400, complete: {12: -1} } };
    },
    shelf() {
      const entries = Object.entries(h.discounts[Math.min(h.page, 1)]).map(([id, discount]) =>
        [id, { discount, buy_quantity: h.used.has(Number(id)) ? 1 : 0 }]);
      return { refresh: h.page, goodsList: Object.fromEntries(entries) };
    },
    async send(cmd, params = {}) {
      h.calls.push(cmd);
      switch (cmd) {
        case "role_getroleinfo": return { role: h.getRole() };
        case "store_goodslist": assert.deepEqual(params, { storeId: 1 }); return h.shelf();
        case "store_purchase": assert.deepEqual(params, { goodsId: 1 }); return {};
        case "store_refresh":
          assert.deepEqual(params, { storeId: 1 });
          assert.equal(h.page, 0, "must not pay for a later refresh");
          h.page++; h.used.clear();
          return { ...h.shelf(), role: { diamond: 0, levelId: 0 } };
        case "store_buy": {
          const { goodsId } = params;
          assert.deepEqual(Object.keys(params), ["goodsId"]);
          assert.equal(h.used.has(goodsId), false, "no repeat purchase");
          const receipt = prices.get(h.page + ":" + goodsId);
          assert.ok(receipt, "no fabricated receipt for goods " + goodsId);
          assert.ok(h.balance >= receipt.price);
          h.balance -= receipt.price; h.used.add(goodsId); h.buys.push([h.page, goodsId]);
          return { ...h.shelf(), role: { levelId: 0, diamond: h.balance },
            reward: [{ type: 3, itemId: receipt.itemId, value: receipt.quantity, ext: 0 }] };
        }
        default: assert.fail("unexpected command " + cmd);
      }
    },
    run(extra = {}) {
      return runDailyBlackMarket({ tokenId: "A", send: h.send, storage: h.storage,
        getLimits: () => h.limits, stopped: () => h.stopped, ...extra });
    },
    writes() { return h.calls.filter(c => ["store_buy", "store_refresh", "store_purchase"].includes(c)); },
  };
  return h;
}

test("20:38 manual sample: boxes on both pages, float 2折, one refresh, 1475 bricks", async () => {
  const h = harness(captures[0]); h.limits[11] = 0; h.limits[12] = 0;
  assert.match((await h.run()).detail, /已确认5组.*扣1475金砖，刷新1次/);
  assert.deepEqual(h.buys, captures[0].purchases.map(r => [r.page, r.goodsId]));
  assert.equal(h.balance, 20909);
});

test("22:25 sample: the 1999 gold-rod cap skips 2000 offers, 3475 bricks, exact balance", async () => {
  const h = harness(); h.limits = relaxed();
  assert.match((await h.run()).detail, /已确认8组.*普通鱼竿×20.*扣3475金砖，刷新1次/);
  assert.equal(h.balance, 5805);
  assert.deepEqual([...h.buys].sort(), captures[1].purchases
    .filter(r => r.goodsId !== 12)
    .map(r => [r.page, r.goodsId]).sort());
  const before = h.writes().length;
  assert.equal((await h.run()).taskStatus, "skipped");
  assert.equal(h.writes().length, before);
});

test("BON live first-page responses omit zero refresh; purchases and repeat still verify", async () => {
  const h = harness();
  const send = async (cmd, params) => {
    const reply = await h.send(cmd, params);
    // 11月12日实服完整货架只有 goodsList，第0页字段省略。
    if (reply?.refresh === 0) delete reply.refresh;
    return reply;
  };
  assert.match((await h.run({ send })).detail, /扣1275金砖，刷新1次/);
  const count = h.writes().length;
  assert.equal((await h.run({ send })).taskStatus, "skipped");
  assert.equal(h.writes().length, count);
});

test("explicit invalid refresh and array-shaped shelves never become page zero", async () => {
  for (const invalid of [null, -1, "?", true, 0.5]) {
    const h = harness();
    const send = async (cmd, params) => {
      const reply = await h.send(cmd, params);
      if (cmd === "store_goodslist") reply.refresh = invalid;
      return reply;
    };
    assert.equal((await h.run({ send })).taskStatus, "warning");
    assert.deepEqual(h.writes(), []);
  }
  const h = harness();
  const send = async (cmd, params) => cmd === "store_goodslist" ? { goodsList: [] } : h.send(cmd, params);
  assert.equal((await h.run({ send })).taskStatus, "warning");
  assert.deepEqual(h.writes(), []);
});

test("three authorized 11/12 BON accounts and configured top-up replay exact requests and zero-write repeat", async () => {
  const live = captures.filter(capture => capture.liveBonCapture);
  assert.equal(live.length, 4);
  for (const capture of live) {
    const storage = memory();
    const makeSend = events => {
      let index = 0;
      const send = async (cmd, params = {}) => {
        const entry = events[index++];
        assert.ok(entry, "unexpected extra request " + cmd);
        assert.equal(cmd, entry.cmd);
        assert.deepEqual(params, entry.params);
        return structuredClone(entry.body);
      };
      return { send, complete: () => assert.equal(index, events.length) };
    };
    const first = makeSend(capture.firstRun);
    const initialRole = { ...capture.before, dailyTask: { dailyTime: capture.before.dailyTime } };
    const result = await runDailyBlackMarket({ tokenId: String(initialRole.roleId),
      initialRole, send: first.send, getLimits: () => capture.limits, storage });
    first.complete();
    assert.deepEqual(result, capture.result);
    assert.equal(capture.before.diamond - capture.after.diamond, capture.cost);
    const rewards = new Map();
    for (const event of capture.firstRun.filter(event => event.cmd === "store_buy")) {
      for (const reward of event.body.reward) rewards.set(reward.itemId, (rewards.get(reward.itemId) ?? 0) + reward.value);
    }
    for (const [id, delta] of Object.entries(capture.inventoryDelta)) assert.equal(rewards.get(Number(id)) ?? 0, delta);
    assert.ok(capture.repeat.every(event => !["store_buy", "store_refresh"].includes(event.cmd)));
    const repeated = makeSend(capture.repeat);
    assert.equal((await runDailyBlackMarket({ tokenId: String(initialRole.roleId),
      send: repeated.send, getLimits: () => capture.limits, storage })).taskStatus, "skipped");
    repeated.complete();
  }
});

test("22:25 sample with initial caps: default 1999 gold-rod cap skips 2000 offers", async () => {
  const h = harness();
  assert.match((await h.run()).detail, /已确认4组.*扣1275金砖.*超价6档/);
  assert.equal(h.balance, 8005); assert.deepEqual(h.buys, [[0,1],[0,3],[1,1],[1,3]]);
});

test("gold rod default limit is 1999: a 2000 offer skips unless the user raises the cap", async () => {
  assert.equal(defaultLowMarketLimits()[12], 1999);

  const capped = harness();
  capped.page = 1;
  capped.limits = { 1: 0, 2: 0, 3: 0, 11: 0, 12: 1999 };
  assert.equal((await capped.run()).taskStatus, "skipped");
  assert.deepEqual(capped.buys, []);
  assert.deepEqual(capped.writes(), []);

  const raised = harness();
  raised.page = 1;
  raised.limits = { 1: 0, 2: 0, 3: 0, 11: 0, 12: 2000 };
  assert.equal((await raised.run()).taskStatus, "completed");
  assert.deepEqual(raised.buys, [[1,12]]);
  assert.equal(raised.balance, 7280);
});

test("3999 uses individual goods; 4000 and 4001 send exactly the original list command", async () => {
  for (const stage of [3999, 4000, 4001]) {
    const h = harness(); h.stage = stage;
    const out = await h.run();
    assert.equal(out.taskStatus, "completed");
    if (stage === 3999) assert.ok(!h.calls.includes("store_purchase"));
    else {
      assert.deepEqual(h.calls, ["role_getroleinfo", "store_purchase"]);
      h.calls.length = 0; assert.equal((await h.run({ daily: true, initialRole: h.getRole() })).taskStatus, "skipped");
      assert.deepEqual(h.writes(), []);
    }
  }
});

test("missing, zero, negative or malformed main stage cannot select a purchase route", async () => {
  for (const stage of [undefined, 0, -1, "?", true, 4000.5]) {
    const h = harness(); h.stage = stage;
    assert.equal((await h.run()).taskStatus, "warning"); assert.deepEqual(h.writes(), []);
  }
  const h = harness();
  assert.equal((await h.run({ initialRole: { levelId: 0, diamond: 0 } })).taskStatus, "completed");
});

test("pre-purchased slot, daily task 12 completed, and an already-refreshed shelf", async () => {
  const h = harness(); h.page = 1; h.used.add(1);
  const out = await h.run({ initialRole: { ...h.getRole(), diamond: 0 }, daily: true });
  assert.equal(out.taskStatus, "completed");
  assert.deepEqual(h.buys, [[1,3]]); assert.ok(!h.calls.includes("store_refresh"));
});

test("zero caps disable every write, invalid saved limits do not revert to expensive defaults", async () => {
  const h = harness();
  for (const v of [null, {}, [], { ...h.limits, 11: -1 }, { ...h.limits, 1: 2.5 }]) {
    assert.equal(validLowMarketLimits(v), false);
    assert.equal((await h.run({ getLimits: () => v })).taskStatus, "warning");
  }
  h.limits = Object.fromEntries(Object.keys(h.limits).map(id => [id, 0]));
  assert.equal((await h.run()).taskStatus, "skipped"); assert.deepEqual(h.writes(), []);
});

test("tight funds buy affordable groups only, zero balance never refreshes", async () => {
  const h = harness(captures[1], { balance: 375 }); h.limits[1] = 0; h.limits[2] = 300;
  assert.match((await h.run()).detail, /已确认1组（黄金宝箱×1）.*余额不足/);
  assert.deepEqual(h.buys, [[0,2]]); assert.equal(h.balance, 75);
  const empty = harness(captures[1], { balance: 0 });
  await empty.run(); assert.deepEqual(empty.writes(), []);
});

test("incomplete shelf, invalid non-tenths discount, or missing balance stops before writes", async () => {
  for (const mutation of [h => delete h.discounts[0][12], h => h.discounts[0][3] = 0.609,
    h => h.discounts[0][1] = null, h => h.balance = null]) {
    const h = harness(); mutation(h);
    assert.equal((await h.run()).taskStatus, "warning"); assert.deepEqual(h.writes(), []);
  }
});

test("wrong reward, balance difference, missing balance or wrong bought count stops after one buy", async () => {
  for (const change of [r => r.reward[0].itemId = 777, r => r.reward[0].value = 10,
    r => r.role.diamond++, r => delete r.role.diamond, r => r.goodsList[1].buy_quantity = 0, r => r.refresh++]) {
    const h = harness();
    const out = await h.run({ send: async (cmd,p) => {
      const receipt = await h.send(cmd,p); if (cmd === "store_buy") change(receipt); return receipt;
    } });
    assert.equal(out.taskStatus, "warning"); assert.equal(out.verificationRequired, true);
    assert.deepEqual(h.writes(), ["store_buy"]);
  }
});

test("partial shelf reply allows a read-only confirmation of the same purchase", async () => {
  const h = harness(); h.page = 1;
  const out = await h.run({ send: async (cmd,p) => {
    const receipt = await h.send(cmd,p); if (cmd === "store_buy") delete receipt.goodsList; return receipt;
  } });
  assert.equal(out.taskStatus, "completed"); assert.equal(h.buys.length, 2);
  assert.equal(h.calls.filter(c => c === "store_goodslist").length, 3);
});

test("server rejection/timeout ends purchases and preserves real code or uncertain outcome", async () => {
  for (const failure of [Object.assign(new Error("server rejection"), { code: 400340 }), new Error("timeout")]) {
    const h = harness(); let n = 0;
    await assert.rejects(h.run({ send: async (cmd,p) => {
      if (cmd === "store_buy" && ++n === 2) throw failure;
      return h.send(cmd,p);
    } }), e => e.requestCmd === "store_buy" && /已确认1组/.test(e.message) &&
      (failure.code ? e.message.includes("400340") : e.message.includes("timeout")));
    assert.equal(n, 2); assert.deepEqual(h.writes(), ["store_buy"]);
  }
});

test("unconfirmed refresh survives a second invocation on page zero, committed refresh resumes on page one", async () => {
  const h = harness(); let attempts = 0;
  await assert.rejects(h.run({ send: async (cmd,p) => {
    if (cmd === "store_refresh") { attempts++; throw new Error("timeout"); }
    return h.send(cmd,p);
  } }), /timeout/);
  assert.equal((await h.run()).taskStatus, "warning");
  assert.equal(attempts, 1); assert.ok(!h.writes().includes("store_refresh"));
  h.page = 1; h.used.clear();
  assert.equal((await h.run()).taskStatus, "completed"); assert.ok(!h.writes().includes("store_refresh"));
});

test("unexpected refresh cost or wrong refresh number stops before second-page purchases", async () => {
  for (const mutate of [(r,h) => { h.balance--; }, r => { r.refresh = 0; }]) {
    const h = harness();
    const out = await h.run({ send: async (cmd,p) => {
      const r = await h.send(cmd,p); if (cmd === "store_refresh") mutate(r,h); return r;
    } });
    assert.equal(out.taskStatus, "warning"); assert.ok(h.buys.every(([page]) => page === 0));
  }
});

test("external page change detected before first refresh; stop during purchases sends no later writes", async () => {
  const h = harness(); let reads = 0;
  const out = await h.run({ send: async (cmd,p) => {
    if (cmd === "store_goodslist" && ++reads === 2) { h.page = 1; h.used.clear(); }
    return h.send(cmd,p);
  } });
  assert.equal(out.taskStatus, "warning"); assert.ok(!h.writes().includes("store_refresh"));
  const t = harness();
  await assert.rejects(t.run({ send: async (cmd,p) => {
    const r = await t.send(cmd,p); if (cmd === "store_buy") t.stopped = true; return r;
  } }), e => e.stopped);
  assert.deepEqual(t.writes(), ["store_buy"]);
});

test("an overlapping call for the same role skips while a different account completes", async () => {
  const a = harness(), b = harness(); b.roleId = 502;
  let release, ready;
  const started = new Promise(r => ready = r), wait = new Promise(r => release = r);
  const pending = a.run({ send: async (cmd,p) => {
    if (cmd === "store_goodslist") { ready(); await wait; }
    return a.send(cmd,p);
  } });
  await started;
  try {
    assert.equal((await a.run({ tokenId: "alias-A" })).taskStatus, "skipped");
    assert.equal((await b.run({ tokenId: "B" })).taskStatus, "completed");
  } finally { release(); }
  assert.equal((await pending).taskStatus, "completed");
  assert.equal(a.buys.length, 4); assert.equal(b.buys.length, 4);
});

const hook = registerHooks({ resolve(name, context, next) {
  const stub = code => ({ url: "data:text/javascript," + encodeURIComponent(code), shortCircuit: true });
  if (name === "@/stores/tokenStore") return stub("export const useTokenStore=()=>({})");
  if (name === "@/stores/cache") return stub("export const $CacheManager={getCache(){},delCache(){}}");
  if (name.endsWith("/logger.js")) return stub("const log=new Proxy({},{get:()=>()=>{}});export {log as wsLogger,log as gameLogger}");
  if (name.startsWith("@/utils/")) return next(new URL("../src/" + name.slice(2) + ".js", import.meta.url).href, context);
  return next(name, context);
}});
const { DailyTaskRunner } = await import("../src/utils/dailyTaskRunner.js");
const { XyzwWebSocketClient } = await import("../src/utils/xyzwWebSocket.js");
const { g_utils } = await import("../src/utils/bonProtocol.js");
hook.deregister();

async function withStorage(storage, fn) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try { return await fn(); }
  finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

test("real daily and independent batch entries share saved prices; a finished task 12 does not hide shelf work", async () => {
  const h = harness();
  h.storage.setItem("batchSettings", JSON.stringify({ lowMarketLimits: relaxed() }));
  const complete = Object.fromEntries(Array.from({length: 26}, (_, i) => [i, -1]));
  const store = {
    gameTokens: [{ id: "A", name: "test" }], getWebSocketStatus: () => "connected",
    sendGetRoleInfo: async () => ({role: { ...h.getRole(), dailyTask: { ...h.getRole().dailyTask, complete } }}),
    sendMessageWithPromise: async (id, cmd, params) => {
      assert.equal(id, "A");
      if (cmd === "role_getroleinfo" || cmd.startsWith("store_")) return h.send(cmd, params);
      if (cmd === "presetteam_getinfo") return { presetTeamInfo: { useTeamId: 1 } };
      if (cmd === "activity_get") return { activity: { activity: [] } };
      return {};
    },
  };
  const runner = new DailyTaskRunner(store, { commandDelay: 0, taskDelay: 0 });
  const deps = {
    selectedTokens: { value: ["A", "A"] }, tokens: { value: store.gameTokens }, tokenStatus: {value:{}},
    isRunning: { value: false }, shouldStop: { value: false }, currentRunningTokenId: {value:null},
    tokenStore: store, batchSettings: {}, delayConfig: {command:0}, ensureConnection: async()=>{},
    releaseConnectionSlot: () => assert.fail("borrowed connection released"), addLog() {},
  };
  await withStorage(h.storage, async () => {
    const off = await runner.run("A", {}, { blackMarketPurchase: false, bossFormation: 1 });
    assert.ok(!off.taskResults.some(t => t.name === "每日黑市采购")); assert.equal(h.writes().length, 0);
    const on = await runner.run("A", {}, { blackMarketPurchase: true, bossFormation: 1 });
    assert.match(on.taskResults.find(t => t.name === "每日黑市采购").detail, /扣3475金砖/);
    const results = await createTasksStore(deps).store_purchase();
    assert.equal(results.length, 1); assert.equal(results[0].status, "skipped");
    assert.equal(h.writes().length, 9);
  });
});

test("mixed standalone batch routes each account by its own role and releases only acquired slots", async () => {
  const high = harness(), low = harness();
  high.stage = 4000; low.stage = 3999; low.roleId = 502;
  const sessions = { high, low }, closed = [], released = [];
  const deps = {
    selectedTokens: {value: ["high","low"]}, tokens: {value: [{id:"high"},{id:"low"}]}, tokenStatus: {value:{}},
    shouldStop: {value:false}, isRunning:{value:false}, currentRunningTokenId:{value:null},
    ensureConnection: async()=>{}, releaseConnectionSlot:id=>released.push(id), addLog(){},
    batchSettings:{}, delayConfig:{command:0}, tokenStore:{
      getWebSocketStatus: id => id === "low" ? "connected" : "disconnected",
      closeWebSocketConnectionAsync: async id => closed.push(id),
      sendMessageWithPromise: (id,cmd,params) => sessions[id].send(cmd,params),
    },
  };
  await withStorage(memory(), async () => {
    const rows = await createTasksStore(deps).store_purchase();
    assert.deepEqual(rows.map(r => r.status), ["completed","completed"]);
    assert.deepEqual(high.writes(), ["store_purchase"]);
    assert.equal(low.balance, 8005); assert.deepEqual(closed, ["high"]); assert.deepEqual(released, ["high"]);
    assert.equal(deps.isRunning.value, false);
  });
});

test("storage failure and ambiguous refresh receipt prevent a second refresh; definite negative reply is recoverable", async () => {
  const h = harness();
  const out = await h.run({ storage: { getItem: () => null, setItem: () => { throw Error("full"); } } });
  assert.equal(out.taskStatus, "warning"); assert.ok(!h.calls.includes("store_refresh"));
  const denied = harness();
  await assert.rejects(denied.run({ send: async (cmd,p) =>
    cmd === "store_refresh" ? { code: 400340 } : denied.send(cmd,p) }), /400340/);
  assert.equal((await denied.run()).taskStatus, "completed");
  assert.equal(denied.calls.filter(c => c === "store_refresh").length, 1);
});

test("real BON registry uses shop 1, exact goods IDs, and both legacy and individual buy replies resolve", () => {
  const c = new XyzwWebSocketClient({url:"wss://offline.invalid"});
  for (const [cmd,params,response] of [
    ["store_goodslist",{storeId:1},"store_goodslistresp"],["store_refresh",{storeId:1},"store_refreshresp"],
    ["store_buy",{goodsId:11},"store_buyresp"],["store_purchase",{goodsId:1},"store_buyresp"],
  ]) {
    const packet = c.registry.commands.get(cmd)(1,2,params);
    assert.deepEqual(g_utils.bon.decode(packet.body),params);
    for (const resp of [undefined, 23]) {
      let got;
      c.promises[23] = {originalCmd:cmd,resolve: v => got=v, reject: assert.fail};
      c._handlePromiseResponse({cmd:response,resp,code:0,rawData:{ok:true}});
      assert.equal(got.ok,true); assert.deepEqual(Object.keys(c.promises),[]);
    }
  }
});

test("missing or stale response sequence cannot settle competing store purchases", () => {
  const c = new XyzwWebSocketClient({url:"wss://offline.invalid"});
  c.promises[5] = {originalCmd:"store_buy",resolve:assert.fail,reject:assert.fail};
  c.promises[6] = {originalCmd:"store_purchase",resolve:assert.fail,reject:assert.fail};
  c._handlePromiseResponse({cmd:"store_buyresp",code:0,rawData:{}});
  assert.equal(Object.keys(c.promises).length,2);
  delete c.promises[6];
  c._handlePromiseResponse({cmd:"store_buyresp",resp:4,code:0,rawData:{}});
  assert.ok(c.promises[5]);
});

test("expired queued shop write is removed and other queued commands survive", async () => {
  const c = new XyzwWebSocketClient({url:"wss://offline.invalid"});
  c.connected = true; c.socket = {readyState: WebSocket.OPEN};
  c.send("heart_beat");
  const refresh = c.sendWithPromise("store_refresh", {storeId:1}, 5);
  assert.equal(c.sendQueue.length,2);
  await assert.rejects(refresh,/超时/);
  assert.deepEqual(c.sendQueue.map(t=>t.cmd),["heart_beat"]);
});

test("non-integer discounted price uses the upper integer for both eligibility and funds", async () => {
  const h = harness(); h.page = 1;
  h.discounts[1][2] = 0.5; h.limits = {1:0,2:187,3:0,11:0,12:0};
  assert.equal((await h.run()).taskStatus,"skipped"); assert.deepEqual(h.buys,[]);
  h.limits[2] = 188; h.balance = 187;
  assert.equal((await h.run()).taskStatus,"skipped"); assert.deepEqual(h.buys,[]);
});
