import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getActivityCycle, gameTimestamp } from "../src/utils/autoSchedule/activityCycle.js";
import { generateDayPlan, generateWeekPlan } from "../src/utils/autoSchedule/planGenerator.js";
import { resolveBatches, resolvePlanTokens } from "../src/utils/autoSchedule/batchResolver.js";
import { createScheduleStorage, normalizeConfig } from "../src/utils/autoSchedule/scheduleStorage.js";
import { BATCH_IDS, WEEKLY_RULES } from "../src/utils/autoSchedule/weeklyPlan.js";
import { getDueState, summarizeEntries } from "../src/utils/autoSchedule/scheduleGuard.js";
const tasks = (date, override = "auto") => generateDayPlan(date, { manualCycleOverride: override }).filter((p) => p.type === "task");
const slots = (date, id, override) => tasks(date, override).filter((p) => p.scheduleId === id).map((p) => (p.scheduledAt - gameTimestamp(date)) / 60000);
export function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), key: (i) => [...map.keys()][i], get length() { return map.size; } };
}
for (const [date, type] of [["2025-12-12", "blackMarket"], ["2025-12-19", "recruit"], ["2025-12-26", "box"], ["2026-01-02", "blackMarket"]]) {
  test(`活动基准 ${date}`, () => assert.equal(getActivityCycle(gameTimestamp(date, 720)).type, type));
}
test("切换前后1秒", () => { const time = gameTimestamp("2025-12-19", 720); assert.equal(getActivityCycle(time - 1000).type, "blackMarket"); assert.equal(getActivityCycle(time + 1000).type, "recruit"); });
test("不同宿主时区计划相同", () => {
  const script = 'import {generateDayPlan} from "./src/utils/autoSchedule/planGenerator.js"; console.log(JSON.stringify([{}, {batches:{A:{enabled:false},B:{taskEnabled:{fridayAfternoonWeirdIntegrated:false}}}}].map(c=>generateDayPlan("2026-01-02",c))))';
  const outputs = ["UTC", "America/Los_Angeles", "Asia/Shanghai"].map((TZ) => execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ }, cwd: new URL("..", import.meta.url), encoding: "utf8" }));
  assert.equal(outputs[0], outputs[1]); assert.equal(outputs[0], outputs[2]);
});
for (const [date, dream, camp] of [["2026-10-12", true, false], ["2026-10-13", false, true], ["2026-10-14", true, true], ["2026-10-15", true, true], ["2026-10-16", false, false], ["2026-10-17", false, false], ["2026-10-18", true, false]]) {
  test(`${date} 梦境与营地`, () => { assert.equal(tasks(date).filter((p) => p.scheduleId === "dream").length, dream ? 3 : 0); assert.deepEqual(slots(date, "camp"), camp ? [570, 600, 630] : []); });
}
test("周五凌晨和早间替换", () => {
  assert.ok(!tasks("2026-10-16").some((p) => ["nightLight", "nightTower", "morningDaily"].includes(p.scheduleId)));
  assert.deepEqual(slots("2026-10-16", "fridayDaily"), [30, 90, 150]); assert.deepEqual(slots("2026-10-16", "fridayLight"), [450, 480, 510]);
});
test("周五按下午活动判断，进入黑市生成、离开黑市不生成", () => {
  assert.deepEqual(slots("2026-01-02", "fridayWeirdTower"), [930, 960, 990]);
  assert.deepEqual(slots("2025-12-19", "fridayWeirdTower"), []);
  assert.deepEqual(slots("2025-12-26", "fridayWeirdTower"), []);
});
for (const [cycle, name] of [["blackMarket", "climbWeirdTower"], ["recruit", "climbTower"], ["box", "climbTower"]]) {
  test(`凌晨塔 ${cycle}`, () => assert.ok(tasks("2026-10-12", cycle).filter((p) => p.scheduleId === "nightTower").every((p) => p.taskChain[0] === name)));
}
test("每日中午晚间与Bundle顺序", () => {
  for (const day of generateWeekPlan(gameTimestamp("2026-10-14"))) {
    assert.deepEqual(slots(day.dateKey, "noonDaily"), [750, 810, 870]); assert.deepEqual(slots(day.dateKey, "eveningDaily"), [1110, 1140, 1170]);
    for (const p of day.items.filter((p) => p.label.includes("日常"))) assert.deepEqual(p.taskChain, ["batchlingguanzi", "startBatch", "claimHangUpRewards", "resetBottles"]);
  }
});
test("所有活动周均不再生成盐场计划", () => {
  for (const manualCycleOverride of ["auto", "blackMarket", "recruit", "box"]) {
    for (const day of generateWeekPlan(gameTimestamp("2026-10-17"), { manualCycleOverride })) {
      assert.equal(day.items.some((p) => p.scheduleId === "salt" || p.taskChain.includes("batchSaltOnce")), false);
    }
  }
});
test("领罐前置只影响日常链，夜间和周五基础顺序保持不变", () => {
  for (const day of generateWeekPlan(gameTimestamp("2026-10-14"))) {
    for (const p of day.items.filter(p => ["nightLight", "fridayLight"].includes(p.scheduleId))) {
      assert.deepEqual(p.taskChain, ["claimHangUpRewards", "batchlingguanzi", "batchStudy"]);
    }
  }
});
const config = normalizeConfig({ batches: { A: { groupId: "a" }, B: { groupId: "b" }, C: { groupId: "c" } } });
const tokens = [1, 2, 3].map((id) => ({ id: String(id) }));
test("分组动态解析、去重并集、无效账号过滤", () => {
  const groups = [{ id: "a", tokenIds: ["1", "1", "missing"] }, { id: "b", tokenIds: ["2"] }];
  assert.deepEqual(resolveBatches(config, groups, tokens).allTokenIds, ["1", "2"]);
  groups[0].tokenIds = []; groups[1].tokenIds.push("1");
  assert.deepEqual(resolvePlanTokens({ batchId: "B" }, config, groups, tokens).tokenIds, ["2", "1"]);
});
test("批次重叠无效，ALL并集仍去重但禁止执行", () => {
  const groups = [{ id: "a", tokenIds: ["1"] }, { id: "b", tokenIds: ["1", "2"] }];
  const result = resolveBatches(config, groups, tokens); assert.equal(result.valid, false); assert.deepEqual(result.allTokenIds, ["1", "2"]);
  assert.equal(resolvePlanTokens({ batchId: "ALL" }, config, groups, tokens).status, "skipped");
});
test("空批次跳过", () => assert.equal(resolvePlanTokens({ batchId: "C" }, config, [], tokens).status, "skipped"));
test("备用窗口不执行", () => { for (const p of generateDayPlan("2026-01-02").filter((p) => p.type === "reserved")) { assert.deepEqual(p.taskChain, []); assert.equal(getDueState(p, null, p.scheduledAt), null); } });
test("持久化queued防重，刷新及延迟不missed", () => {
  const storage = memoryStorage(); const s = createScheduleStorage(storage); const p = tasks("2026-10-12")[0];
  assert.equal(getDueState(p, s.get(p.id), p.scheduledAt), "queued"); s.put(p.id, { status: "queued" });
  assert.equal(getDueState(p, createScheduleStorage(storage).get(p.id), p.scheduledAt + 3600000), null);
});
test("补执行窗口边界", () => { const p = tasks("2026-10-12")[0]; assert.equal(getDueState(p, null, p.scheduledAt + 300000), "queued"); assert.equal(getDueState(p, null, p.scheduledAt + 300001), "missed"); });
test("warning及已完成不转失败，partial保留", () => { assert.equal(summarizeEntries([{ status: "warning" }, { status: "skipped" }]).status, "warning"); assert.equal(summarizeEntries([{ status: "partial" }]).status, "partial"); });
test("旧配置默认关闭，不保存token快照", () => { assert.equal(normalizeConfig().enabled, false); assert.equal(JSON.stringify(normalizeConfig({ selectedTokens: ["secret"] })).includes("secret"), false); });


test('black market afternoon reserve gets integrated tower for all batches without overlaps',()=>{
 for(const date of ['2026-01-02','2026-01-03','2026-01-05']){
  const plan=generateDayPlan(date), integrated=plan.filter(p=>p.taskChain.includes('batchWeirdTowerIntegrated'));
  assert.equal(integrated.length,3);assert.deepEqual(integrated.map(p=>p.batchId),['A','B','C']);
  assert.deepEqual(integrated.map(p=>(p.scheduledAt-gameTimestamp(date))/60000),date==='2026-01-02'?[1020,1050,1080]:[930,960,990]);
  for(const p of integrated)assert.ok(!plan.some(q=>q!==p&&q.scheduledAt<p.scheduledAt+30*60000&&q.scheduledAt+q.reservedMinutes*60000>p.scheduledAt));
 }
 for(const date of ['2025-12-19','2025-12-26'])assert.equal(generateDayPlan(date).some(p=>p.taskChain.includes('batchWeirdTowerIntegrated')),false);
});

test("旧 v1、稀疏配置和完整配置按规则 ID 归一化，各批次独立回读", () => {
  const bytes = memoryStorage();
  const first = createScheduleStorage(bytes), second = createScheduleStorage(bytes);
  bytes.setItem("auto-weekly-schedule:v1", JSON.stringify({ enabled: true, batches: { A: { groupId: "g" } } }));
  const legacy = first.loadConfig();
  const ids = WEEKLY_RULES.map(rule => rule.id);
  for (const id of BATCH_IDS) {
    assert.deepEqual(Object.keys(legacy.batches[id].taskEnabled), ids);
    assert.ok(Object.values(legacy.batches[id].taskEnabled).every(value => value === true));
  }
  assert.notEqual(legacy.batches.A.taskEnabled, legacy.batches.B.taskEnabled);
  first.saveConfig(config => {
    config.batches.A.taskEnabled.morningDaily = false;
    return config;
  });
  second.saveConfig(config => {
    config.batches.B.taskEnabled.dream = false;
    return config;
  });
  const saved = JSON.parse(bytes.getItem("auto-weekly-schedule:v1"));
  assert.equal(saved.scheduleVersion, 1);
  assert.equal(saved.batches.A.groupId, "g");
  assert.equal(saved.batches.A.taskEnabled.morningDaily, false);
  assert.equal(saved.batches.B.taskEnabled.dream, false);
  assert.equal(saved.batches.C.taskEnabled.dream, true);
  const imported = normalizeConfig({ ...saved, batches: { ...saved.batches, C: { taskEnabled: { camp: false, obsolete: true } } } });
  assert.deepEqual(Object.keys(imported.batches.C.taskEnabled), ids);
  assert.equal(imported.batches.C.taskEnabled.nightTower, true);
  assert.equal(imported.batches.C.taskEnabled.camp, false);
});

test("七日计划逐个验证所有开关、现有执行键、任务链、时间及周五规则", () => {
  const start = gameTimestamp("2026-01-05"), base = { manualCycleOverride: "blackMarket" };
  const baseline = generateWeekPlan(start, base).flatMap(day => day.items.filter(p => p.type === "task"));
  assert.deepEqual(new Set(baseline.map(p => p.scheduleId)), new Set(WEEKLY_RULES.map(r => r.id)));
  for (const { id: ruleId } of WEEKLY_RULES) {
    for (const batchId of BATCH_IDS) {
      const config = { ...base, batches: { [batchId]: { taskEnabled: { [ruleId]: false } } } };
      const plans = generateWeekPlan(start, config).flatMap(day => day.items.filter(p => p.type === "task"));
      assert.equal(plans.length, baseline.length);
      for (const [i, item] of plans.entries()) {
        const off = item.scheduleId === ruleId && item.batchId === batchId;
        assert.deepEqual(item, { ...baseline[i], enabled: !off, disabledReason: off ? `${batchId} 批次的本项任务已关闭` : "" });
      }
    }
  }
});

test("批次主开关暂停整批，再开启恢复该批此前的每项选择", () => {
  const cfg = normalizeConfig({ batches: { A: { enabled: false, taskEnabled: { morningDaily: false } } } });
  const day = () => generateDayPlan("2026-10-14", cfg).filter(item => item.type === "task");
  assert.ok(day().filter(p => p.batchId === "A").every(p => !p.enabled && p.disabledReason.includes("批次已关闭")));
  assert.ok(day().filter(p => p.batchId !== "A").every(p => p.enabled));
  cfg.batches.A.enabled = true;
  assert.deepEqual(day().filter(p => !p.enabled).map(p => p.scheduleId), ["morningDaily"]);
});

test("下午备用窗口按最后一个启用塔时段释放，常规日和周五分别计算", () => {
  const regular = "afternoonWeirdIntegrated", friday = "fridayAfternoonWeirdIntegrated", early = "fridayWeirdTower";
  for (const [date, allowed, start] of [
    ["2026-01-03", [], 930], ["2026-01-03", [regular + "A"], 960],
    ["2026-01-03", [regular + "B"], 990], ["2026-01-03", [regular + "C"], 1020],
    ["2026-01-02", [], 930], ["2026-01-02", [early + "B"], 990],
    ["2026-01-02", [early + "C"], 1020], ["2026-01-02", [friday + "A"], 1050],
    ["2026-01-02", [early + "A", friday + "B"], 1080], ["2026-01-02", [friday + "C"], 1110],
  ]) {
    const batches = Object.fromEntries(BATCH_IDS.map(id => [id, { taskEnabled: Object.fromEntries(
      [regular, friday, early].map(rule => [rule, allowed.includes(rule + id)]),
    ) }]));
    const plan = generateDayPlan(date, { batches });
    const reserve = plan.find(p => p.scheduleId === "afternoonReserve");
    if (start === 1110) assert.equal(reserve, undefined);
    else {
      assert.equal(reserve.scheduledAt, gameTimestamp(date, start));
      assert.equal(reserve.reservedMinutes, 1110 - start);
    }
    const night = plan.find(p => p.scheduleId === "nightReserve");
    assert.equal(night.scheduledAt, gameTimestamp(date, 1260));
    assert.equal(night.reservedMinutes, 180);
  }
});
