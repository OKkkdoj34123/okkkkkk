import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { harness, marked } from "./helpers/studyHarness.js";


const answerRows = JSON.parse(readFileSync(new URL("../public/answer.json", import.meta.url), "utf8"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  headers: { get: () => "application/json" },
  json: async () => answerRows,
});
const questionsModule = await import("../src/utils/studyQuestionsFromJSON.js?study-flow-test");
await questionsModule.loadQuestionsData();
globalThis.fetch = originalFetch;

const captureQuestions = [
  "《咸鱼之王》中，「咸王梦境」玩法在通关1000关后开放？",
  "《三国演义》中，「怒打督邮」的是张飞。",
  "《咸鱼之王》中，装备中的坐骑会为咸将提供防御加成？",
  "《咸鱼之王》中，「黑市」每日0点自动刷新商品？",
  "《咸鱼之王》中，「邮件」最长保存30天。",
  "《咸鱼之王》中，玩家每次占领「盐罐」会消耗10点「能量」",
  "《咸鱼之王》中，「咸王梦境」周二会开放。",
  "《咸鱼之王》中，「灯神挑战」内分为四个阵营？",
  "《咸鱼之王》中，副本「每日咸王考验」累计伤害奖励上限为1亿？",
  "《咸鱼之王》中，「军团币」可以用于升级「俱乐部科技」？",
];
const captureAnswers = [1, 1, 2, 1, 1, 1, 2, 1, 2, 1];

test("answer.json contains 582 usable unique questions and matches the supplied 10-question capture", async () => {
  assert.equal(answerRows.length, 584);
  assert.equal(await questionsModule.getQuestionCount(), 582);
  for (let index = 0; index < captureQuestions.length; index++) {
    assert.equal(await questionsModule.findAnswer(captureQuestions[index]), captureAnswers[index], `question ${index + 1}`);
  }
});

test("answer matching is exact after NFKC/whitespace normalization and rejects ambiguity", () => {
  const { matchQuestion, findAnswerInQuestions } = questionsModule;
  assert.equal(matchQuestion("甲　题目？", "甲 题目？"), true);
  assert.equal(matchQuestion("甲题", "甲题？"), false);
  assert.equal(findAnswerInQuestions("题目A？", [
    { name: "题目A？", value: 2 },
    { name: " 题目A？ ", value: 2 },
  ]), 2);
  assert.equal(findAnswerInQuestions("题目A？", [
    { name: "题目A？", value: 1 },
    { name: "题目A？", value: 2 },
  ]), null);
  assert.equal(findAnswerInQuestions("题目A？", [{ name: "题目A？", value: 0 }]), null);
});

test("T01/T14 all ten claimed: no start, answer, claim or redundant role read", async () => {
  const h = harness({ initial: marked(10) });
  assert.equal((await h.run()).status, "skipped");
  assert.deepEqual(h.calls, []);
});
test("T02 current best ten: claim exactly yes keys, final independent read", async () => {
  const h = harness({ initial: marked(10, 7) });
  assert.match((await h.run()).detail, /最终回读确认已领10\/10/);
  assert.deepEqual(h.calls.map(c => c.cmd), [...Array(3).fill("study_claimreward"), "role_getroleinfo"]);
  assert.deepEqual(h.of("study_claimreward").map(c => c.params.rewardId), [8, 9, 10]);
});
for (const [name, best] of [["T03", 9], ["T04", 3]]) {
  test(name + " partial weekly best, cumulative 18: start and submit full round", async () => {
    const h = harness({ initial: marked(best) });
    assert.equal((await h.run()).status, "completed");
    assert.equal(h.of("study_startgame").length, 1);
    assert.equal(h.of("study_answer").length, 10);
    assert.equal(h.of("study_claimreward").length, 10 - best);
  });
}
test("T05 old week never skips; T06 missing/invalid/future state never writes", async () => {
  const h = harness({ initial: { ...marked(10), beginTime: Math.floor(Date.now()/1000) - 8 * 86400 } });
  await h.run();
  assert.equal(h.of("study_startgame").length, 1);
  for (const study of [null, {}, { beginTime: Math.floor(Date.now()/1000) + 100000 }, {beginTime: 0}]) {
    const missing = harness({ cache: false, read: () => ({ role: { study } }) });
    assert.equal((await missing.run()).status, "warning");
    assert.deepEqual(missing.calls.map(c => c.cmd), ["role_getroleinfo"]);
  }
});
test("T07 actual ID 291 and distinct Xiahou Yuan variant retain different strict answers", async () => {
  assert.equal(await questionsModule.findAnswer("《三国演义》中，「拔矢啖睛」的是夏侯惇。"), 1);
  assert.equal(await questionsModule.findAnswer("《三国演义》中，「拔矢啖睛」的是夏侯渊。"), 2);
  const h = harness();
  h.questions[6].question = "《三国演义》中，「拔矢啖睛」的是夏侯惇。";
  await h.run();
  assert.deepEqual(h.of("study_answer")[6].params.option, [1]);
});
test("T08 unknown: raw wording, index and ID logged; no default answer or partial claims", async () => {
  const h = harness();
  h.questions[6].question = "全角　未知？";
  const original = console.warn, logs = [];
  console.warn = (...args) => logs.push(args);
  try {
    assert.match((await h.run()).detail, /正确9.*未匹配1/);
    const [tag, data] = logs.find(([tag]) => tag.includes("题库无有效答案"));
    assert.equal(tag, "[一键答题][题库无有效答案]");
    assert.equal(data.questionId, 7); assert.equal(data.questionIndex, 7);
    assert.equal(data.questionText, "全角　未知？"); assert.equal(data.normalizedQuestionText, "全角未知?");
    assert.equal(data.reason, "not_found"); assert.equal(data.databaseSize, 584);
    assert.equal(h.of("study_answer").length, 9);
    assert.ok(h.of("study_answer").every(c => c.params.questionId[0] !== 7));
    assert.equal(h.of("study_claimreward").length, 0);
  } finally { console.warn = original; }
});
test("T09/T10 conflict, invalid and empty databases have distinct diagnoses and no answer", () => {
  for (const [values, reason] of [[[1, 4], "conflicting_answers"], [[0, 5], "invalid_answer"], [[], "database_empty"]]) {
    const entries = values.map(value => ({ name: "Q", value }));
    const result = questionsModule.diagnoseQuestion("Q", entries, 7, 291);
    assert.equal(result.reason, reason); assert.equal(result.answer, null);
    assert.equal(result.matchedRecordCount, entries.length);
    assert.equal(result.validRecordCount, reason === "conflicting_answers" ? 2 : 0);
    assert.deepEqual(result.databaseEntries, entries); assert.deepEqual(result.answerValues, values);
  }
});
test("T11 answer error after progress: retain 400340, read once and stop all writes", async () => {
  const h = harness({ answerFailure: 4 });
  const r = await h.run();
  assert.equal(r.status, "partial"); assert.match(r.detail, /400340/);
  assert.equal(h.of("study_answer").length, 4);
  assert.equal(h.of("role_getroleinfo").length, 1);
  assert.equal(h.of("study_claimreward").length, 0);
});
test("T12 claim failure stops next write but still reads back", async () => {
  const h = harness({ initial: marked(10, 7), claimFailure: 9 });
  const r = await h.run();
  assert.match(r.detail, /3100060/);
  assert.deepEqual(h.of("study_claimreward").map(c => c.params.rewardId), [8, 9]);
  assert.equal(h.calls.at(-1).cmd, "role_getroleinfo");
});
test("T13 missing reward evidence or final snapshot cannot be promoted to confirmed", async () => {
  for (const missingAt of [1, 2]) {
    const h = harness({ read(body, n) { if (n === missingAt) delete body.role.study.taskComplete; return body; } });
    assert.equal((await h.run()).status, "warning");
    assert.equal(h.of("study_claimreward").length, missingAt === 1 ? 0 : 10);
  }
});
test("T15 active account cannot be reopened or closed by another entry; passive packets never write", async () => {
  const h = harness(), other = harness({ store: h.store, id: "B", initial: marked(10) });
  let unlock; const gate = new Promise(resolve => { unlock = resolve; });
  const first = h.run({ open: () => gate });
  try {
    assert.match((await h.run({ open: () => assert.fail(), close: () => assert.fail() })).detail, /重复启动/);
    assert.equal((await other.run()).status, "skipped");
    h.handlers.get("studyresp")({ tokenId: "A", body: { questionList: h.questions } });
    assert.equal(h.calls.length, 0);
  } finally { unlock(); }
  assert.equal((await first).status, "completed"); assert.equal(h.of("study_startgame").length, 1);
  assert.equal(h.store.gameData.studyStatuses.B.status, "skipped");
});
test("T16 elapsed virtual clock covers spacing and both settling waits", async () => {
  const h = harness();
  await h.run();
  for (const cmd of ["study_answer", "study_claimreward"]) {
    const calls = h.of(cmd);
    assert.equal(calls.length, 10);
    calls.slice(1).forEach((c, i) => assert.equal(c.at - calls[i].at, 1000));
  }
  const reads = h.of("role_getroleinfo");
  assert.equal(reads[0].at - h.of("study_answer").at(-1).at, 1500);
  assert.equal(reads[1].at - h.of("study_claimreward").at(-1).at, 1500);
});
test("server judged one wrong despite ten successful requests: keep rewards untouched", async () => {
  const h = harness({wrong: 4});
  assert.match((await h.run()).detail, /响应10\/10.*正确9、错误1/);
  assert.equal(h.of("study_claimreward").length, 0);
});
test("first-ever account matches the recorded complete zero state; a lone zero stays unknown", async () => {
  const h = harness({ initial: { id: 0, beginTime: 0, question: [], maxCorrectNum: 0,
    totRightNum: 0, totCplTaskNum: 0, taskComplete: {} } });
  const result = await h.run();
  assert.equal(h.of("study_startgame").length, 1);
  assert.equal(result.status, "completed");
});
test("weekly boundary at Monday 00:00 UTC+8 does not depend on browser timezone", async t => {
  t.mock.timers.enable({apis:["Date"], now: Date.parse("2026-11-08T16:00:00Z")});
  const h = harness({ initial: { ...marked(10), beginTime: Date.now()/1000 - 1 } });
  await h.run(); assert.equal(h.of("study_startgame").length, 1);
});
test("another token's initialization on the same client cannot supply this account's state", async () => {
  const h = harness();
  h.initialize({ role: { study: { ...h.study, ...marked(10) } } }, "B");
  await h.run();
  assert.equal(h.calls[0].cmd, "role_getroleinfo"); assert.equal(h.of("study_startgame").length, 1);
});
test("changed round in final read cannot confirm rewards from a different round", async () => {
  const h = harness({initial: marked(10, 9), read(body) { body.role.study.id++; return body; }});
  assert.match((await h.run()).detail, /最终回读确认已领0\/10/);
});
test("array-shaped reward data and contradictory weekly counters never authorize writes", async () => {
  for (const initial of [{ ...marked(10), taskComplete: Array(11).fill("yes") },
    { ...marked(10), maxCorrectNum: 9 }]) {
    const h = harness({ initial });
    assert.equal((await h.run()).status, "warning");
    assert.ok(h.calls.every(c => c.cmd === "role_getroleinfo"));
  }
});
test("T09/T10 the command path omits both conflicting and out-of-range answers", async () => {
  const db = await import("../src/utils/studyQuestionsFromJSON.js");
  const original = globalThis.fetch;
  const replace = async rows => {
    db.clearCache();
    globalThis.fetch = async () => new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
    await db.loadQuestionsData();
  };
  try {
    await replace([...answerRows, {name:"冲突题",value:1}, {name:"冲突题",value:2}, {name:"越界题",value:7}]);
    const h = harness(); h.questions[3].question = "冲突题"; h.questions[6].question = "越界题";
    assert.match((await h.run()).detail, /正确8.*未匹配2/);
    assert.deepEqual(h.of("study_answer").map(c => c.params.questionId[0]), [1,2,3,5,6,8,9,10]);
    assert.equal(h.of("study_claimreward").length, 0);
  } finally {
    try { await replace(answerRows); } finally { globalThis.fetch = original; }
  }
});
test("partial post-answer reward map merges round deltas; partial final map stays partial", async () => {
  const h = harness({read(body) {
    const map = body.role.study.taskComplete;
    body.role.study.taskComplete = {10: map[10]};
    return body;
  }});
  const result = await h.run();
  assert.equal(h.of("study_claimreward").length, 10);
  assert.equal(result.status, "warning"); assert.match(result.detail, /最终回读确认已领1\/10/);
});
