import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseApexMajority,
  createTasksApex,
  getApexPendingClaims,
  isApexGroupAlreadyGuessed,
  normalizeApexScheduleId,
  resolveApexScheduleSelection,
} from "../src/utils/batch/tasksApex.js";
import { getPreviousRoundScheduleIds } from "../src/utils/apexRules.js";

const team = (teamId, cheerCnt, voteCnt = 0, name = teamId) => ({
  teamId,
  cheerCnt,
  voteCnt,
  name,
});
const beijing = (year, month, day, hour = 0, minute = 0, second = 0) =>
  Date.UTC(year, month - 1, day, hour - 8, minute, second);
const group = (index) => [
  team(`A${index}`, 10, 999, `少数方${index}`),
  team(`B${index}`, 90, 1, `多数方${index}`),
];

function makeHarness({
  guessMap = {},
  guessClaimMap = {},
  resetTime = { season: 1 },
  pages = {},
  claimErrors = {},
  readbackFailureAt = [],
  stopAfterGuess = false,
  wait: waitImpl = async () => {},
} = {}) {
  const state = {
    guessMap: structuredClone(guessMap),
    guessClaimMap: structuredClone(guessClaimMap),
    resetTime: structuredClone(resetTime),
  };
  const calls = [];
  const logs = [];
  const tokenStatus = { value: {} };
  const shouldStop = { value: false };
  let activeScheduleId = null;
  let roleReadCount = 0;

  const deps = {
    selectedTokens: { value: ["account-1"] },
    tokens: { value: [{ id: "account-1", name: "测试账号" }] },
    tokenStatus,
    isRunning: { value: false },
    shouldStop,
    ensureConnection: async () => {},
    releaseConnectionSlot: () => {},
    connectionQueue: { active: 0 },
    batchSettings: { maxActive: 1 },
    tokenStore: {
      sendMessageWithPromise: async (_tokenId, cmd, params) => {
        calls.push({ cmd, params: structuredClone(params) });
        if (cmd === "apex_getroleinfo") {
          roleReadCount += 1;
          if (readbackFailureAt.includes(roleReadCount)) {
            throw new Error("readback timeout");
          }
          return { apexRoleInfo: structuredClone(state) };
        }
        if (cmd === "apex_guessclaim") {
          const key = `${params.scheduleId}/${params.teamId}`;
          if (claimErrors[key]) throw new Error(claimErrors[key]);
          state.guessClaimMap[String(params.scheduleId)] ||= {};
          state.guessClaimMap[String(params.scheduleId)][params.teamId] = true;
          return { reward: [{ type: 3, itemId: 16002, value: 4, ext: 0 }] };
        }
        if (cmd === "apex_getguesslist") {
          activeScheduleId = Number(params.scheduleId);
          return structuredClone(
            pages[params.idx] || { apexGuessList: [], last: true },
          );
        }
        if (cmd === "apex_guess") {
          if (!activeScheduleId) throw new Error("no active schedule in harness");
          state.guessMap[String(activeScheduleId)] ||= [];
          state.guessMap[String(activeScheduleId)].push(params.teamId);
          if (stopAfterGuess) shouldStop.value = true;
          return { newGuessCnt: 360000 };
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
      closeWebSocketConnection: () => {},
    },
    addLog: (entry) => logs.push(entry),
    message: { success: () => {}, warning: () => {} },
    currentRunningTokenId: { value: null },
    wait: waitImpl,
  };
  return { deps, calls, logs, state, tokenStatus };
}

test("normalizeApexScheduleId rejects empty, invalid and non-positive values", () => {
  assert.equal(normalizeApexScheduleId(null), null);
  assert.equal(normalizeApexScheduleId(""), null);
  assert.equal(normalizeApexScheduleId("abc"), null);
  assert.equal(normalizeApexScheduleId(0), null);
  assert.equal(normalizeApexScheduleId("153"), 153);
});

test("pending claims can be restricted to a supplied scheduleId set", () => {
  assert.deepEqual(
    getApexPendingClaims(
      {
        "127": { A10000409: false, _A10000182: false, A10000157: true },
        "46": { A10000024: false },
      },
      new Set(getPreviousRoundScheduleIds(153)),
    ),
    [{ scheduleId: 127, teamId: "A10000409" }],
  );
});

test("majority selection uses cheerCnt, not voteCnt, and returns support share", () => {
  const left = team("left", 10, 99999);
  const right = team("right", 90, 1);
  const result = chooseApexMajority(left, right);
  assert.equal(result.team.teamId, "right");
  assert.equal(result.share, 90);
  assert.equal(chooseApexMajority(team("a", 5), team("b", 5)), null);
  assert.equal(chooseApexMajority(team("a", null), team("b", 5)), null);
});

test("any existing pick in a match means skip the whole match", () => {
  assert.equal(
    isApexGroupAlreadyGuessed([team("a", 1), team("b", 9)], new Set(["a"])),
    true,
  );
  assert.equal(
    isApexGroupAlreadyGuessed([team("a", 1), team("b", 9)], new Set()),
    false,
  );
});

test("automatic mode ignores a stale manual ID and selects the config schedule", () => {
  const selection = resolveApexScheduleSelection(
    { useManualScheduleId: false, manualScheduleId: 153 },
    beijing(2026, 11, 10, 10, 20, 0),
  );
  assert.equal(selection.scheduleId, 156);
  assert.equal(selection.source, "config");
});

test("manual mode takes priority and invalid manual ID never falls back to auto", () => {
  const manual = resolveApexScheduleSelection(
    { useManualScheduleId: true, manualScheduleId: 153 },
    beijing(2026, 11, 10, 10, 20, 0),
  );
  assert.equal(manual.scheduleId, 153);
  assert.equal(manual.source, "manual");

  const invalid = resolveApexScheduleSelection(
    { useManualScheduleId: true, manualScheduleId: null },
    beijing(2026, 11, 10, 10, 20, 0),
  );
  assert.equal(invalid.scheduleId, null);
  assert.match(invalid.error, /不会回退/);
});

test("claims within current-and-previous round scope, then guesses the majority team", async () => {
  const h = makeHarness({
    guessClaimMap: {
      "127": { A10000409: false, _A10000182: false, A10000157: true },
      "46": { OLD_TEAM: false },
    },
    pages: {
      0: {
        apexGuessList: [[team("A", 10, 9999, "少数方"), team("B", 90, 1, "多数方")]],
        last: true,
      },
    },
  });
  await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: 153,
  });

  const claims = h.calls.filter((call) => call.cmd === "apex_guessclaim");
  assert.deepEqual(
    claims.map((call) => call.params),
    [{ scheduleId: 127, teamId: "A10000409" }],
  );
  assert.equal(
    h.calls.some(
      (call) =>
        call.cmd === "apex_getguesslist" && call.params.scheduleId === 153,
    ),
    true,
  );
  assert.equal(
    h.calls.some((call) => call.cmd === "apex_guess" && call.params.teamId === "B"),
    true,
  );
  assert.equal(
    h.calls.some((call) => call.cmd === "apex_guess" && call.params.teamId === "A"),
    false,
  );
  assert.equal(h.state.guessClaimMap["127"].A10000409, true);
  assert.deepEqual(h.state.guessMap["153"], ["B"]);
  assert.equal(h.tokenStatus.value["account-1"], "completed");
});

test("auto mode sends the scheduleId selected from first-season config", async () => {
  const h = makeHarness({
    pages: {
      0: { apexGuessList: [[team("A", 1), team("B", 9)]], last: true },
    },
  });
  const rows = await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: false,
    manualScheduleId: 153,
    nowMs: beijing(2026, 11, 10, 10, 20, 0),
  });
  assert.equal(rows[0].status, "completed");
  assert.match(rows[0].details[0], /竞猜确认/);
  assert.equal(rows[0].verificationRequired, false);
  assert.equal(
    h.calls.some(
      (call) =>
        call.cmd === "apex_getguesslist" && call.params.scheduleId === 156,
    ),
    true,
  );
  assert.deepEqual(h.state.guessMap["156"], ["B"]);
});


test("config mode refuses an account explicitly marked as another season", async () => {
  const h = makeHarness({
    resetTime: { season: 2 },
    pages: {
      0: { apexGuessList: [[team("A", 1), team("B", 9)]], last: true },
    },
  });
  await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: false,
    nowMs: beijing(2026, 11, 10, 10, 20, 0),
  });
  assert.equal(h.calls.some((call) => call.cmd === "apex_getguesslist"), false);
  assert.equal(h.calls.some((call) => call.cmd === "apex_guess"), false);
  assert.equal(h.tokenStatus.value["account-1"], "failed");
});

test("invalid manual mode sends no game command and does not auto-fallback", async () => {
  const h = makeHarness();
  await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: null,
    nowMs: beijing(2026, 11, 10, 10, 20, 0),
  });
  assert.equal(h.calls.length, 0);
  assert.equal(h.tokenStatus.value["account-1"], "failed");
});

test("server error 20020 stops further claims but does not block current guessing", async () => {
  const h = makeHarness({
    guessClaimMap: {
      "126": { TEAM126: false },
      "127": { TEAM127: false },
    },
    claimErrors: { "126/TEAM126": "服务器错误:20020" },
    pages: {
      0: { apexGuessList: [[team("A", 1), team("B", 9)]], last: true },
    },
  });
  await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: 153,
  });
  assert.equal(
    h.calls.filter((call) => call.cmd === "apex_guessclaim").length,
    1,
  );
  assert.equal(
    h.calls.some((call) => call.cmd === "apex_guess" && call.params.teamId === "B"),
    true,
  );
  assert.equal(
    h.logs.some((entry) => /服务器错误 20020/.test(entry.message)),
    true,
  );
});

test("pagination advances by actual returned group count, not fixed page size", async () => {
  const firstPage = [group(1), group(2), group(3)];
  const secondPage = [group(4), group(5)];
  const h = makeHarness({
    pages: {
      0: { apexGuessList: firstPage, last: false },
      3: { apexGuessList: secondPage, last: true },
    },
  });
  await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: 153,
  });
  const indexes = h.calls
    .filter((call) => call.cmd === "apex_getguesslist")
    .map((call) => call.params.idx);
  assert.deepEqual(indexes, [0, 3]);
  assert.equal(h.calls.filter((call) => call.cmd === "apex_guess").length, 5);
});

test("a previously guessed side skips the match instead of betting on its opponent", async () => {
  const h = makeHarness({
    guessMap: { "153": ["A"] },
    pages: {
      0: { apexGuessList: [[team("A", 10), team("B", 90)]], last: true },
    },
  });
  await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: 153,
  });
  assert.equal(h.calls.some((call) => call.cmd === "apex_guess"), false);
});

test("guess readback failure aborts later guesses and marks account failed", async () => {
  const h = makeHarness({
    readbackFailureAt: [2],
    pages: {
      0: {
        apexGuessList: [
          [team("A1", 1), team("B1", 9)],
          [team("A2", 1), team("B2", 9)],
        ],
        last: true,
      },
    },
  });
  await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: 153,
  });
  assert.equal(h.calls.filter((call) => call.cmd === "apex_guess").length, 1);
  assert.equal(h.tokenStatus.value["account-1"], "failed");
});

test("manual stop marks stopped and does not submit the next match", async () => {
  const h = makeHarness({
    stopAfterGuess: true,
    pages: {
      0: {
        apexGuessList: [
          [team("A1", 1), team("B1", 9)],
          [team("A2", 1), team("B2", 9)],
        ],
        last: true,
      },
    },
  });
  await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: 153,
  });
  assert.equal(h.calls.filter((call) => call.cmd === "apex_guess").length, 1);
  assert.equal(h.tokenStatus.value["account-1"], "stopped");
});

test("a repeated run skips already claimed rewards and already guessed matches", async () => {
  const h = makeHarness({
    guessClaimMap: { "127": { A10000409: false } },
    pages: {
      0: { apexGuessList: [[team("A", 1), team("B", 9)]], last: true },
    },
  });
  const task = createTasksApex(h.deps);
  await task.batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: 153,
  });
  const firstClaimCount = h.calls.filter((call) => call.cmd === "apex_guessclaim").length;
  const firstGuessCount = h.calls.filter((call) => call.cmd === "apex_guess").length;
  await task.batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: 153,
  });
  assert.equal(firstClaimCount, 1);
  assert.equal(firstGuessCount, 1);
  assert.equal(h.calls.filter((call) => call.cmd === "apex_guessclaim").length, 1);
  assert.equal(h.calls.filter((call) => call.cmd === "apex_guess").length, 1);
});

test("claim scope includes current period before previous period", async () => {
  const h = makeHarness({
    guessClaimMap: {
      "153": { CURRENT_TEAM: false },
      "127": { PREVIOUS_TEAM: false },
      "46": { TOO_OLD: false },
    },
    pages: {
      0: { apexGuessList: [[team("A", 1), team("B", 9)]], last: true },
    },
  });
  await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: 153,
  });
  const claims = h.calls.filter((call) => call.cmd === "apex_guessclaim");
  assert.deepEqual(claims.map((call) => call.params), [
    { scheduleId: 153, teamId: "CURRENT_TEAM" },
    { scheduleId: 127, teamId: "PREVIOUS_TEAM" },
  ]);
  assert.equal(h.state.guessClaimMap["153"].CURRENT_TEAM, true);
  assert.equal(h.state.guessClaimMap["127"].PREVIOUS_TEAM, true);
});

test("server error 200020 is reported distinctly and stops later claim requests", async () => {
  const h = makeHarness({
    guessClaimMap: {
      "153": { CURRENT_TEAM: false },
      "127": { PREVIOUS_TEAM: false },
    },
    claimErrors: { "153/CURRENT_TEAM": "服务器错误:200020 - 领奖暂不可用" },
    pages: {
      0: { apexGuessList: [[team("A", 1), team("B", 9)]], last: true },
    },
  });
  await createTasksApex(h.deps).batchApexGuess({
    useManualScheduleId: true,
    manualScheduleId: 153,
  });
  assert.equal(h.calls.filter((call) => call.cmd === "apex_guessclaim").length, 1);
  assert.equal(h.logs.some((entry) => /服务器错误 200020/.test(entry.message)), true);
});
