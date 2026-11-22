import assert from "node:assert/strict";
import { test } from "node:test";
import { createTasksCampChallenge } from "../src/utils/batch/tasksCampChallenge.js";

/**
 * Build camp task executors with isolated mocks.
 * @param {boolean} connectionOwned Whether ensureConnection reports owning a slot.
 */
function fixture(connectionOwned) {
  const calls = { closed: 0, released: 0 };
  const deps = {
    selectedTokens: { value: ["account-a"] },
    tokens: { value: [{ id: "account-a", name: "Test account" }] },
    tokenStatus: { value: {} },
    isRunning: { value: false },
    shouldStop: { value: false },
    currentRunningTokenId: { value: null },
    // Report ownership via the third callback argument, mirroring the real store.
    ensureConnection: async (_id, _retries, onSlotChange) => {
      if (connectionOwned) onSlotChange?.(true);
    },
    releaseConnectionSlot: () => {
      calls.released++;
    },
    connectionQueue: { active: 1 },
    batchSettings: {},
    tokenStore: {
      // Make the task fail right after connecting so the finally block runs.
      sendMessageWithPromise: async () => {
        throw new Error("stop here");
      },
      closeWebSocketConnection: () => {
        calls.closed++;
      },
    },
    addLog: () => {},
    message: { success() {}, warning() {}, error() {} },
    loadSettings: () => ({}),
  };
  return { tasks: createTasksCampChallenge(deps), calls };
}

test("camp challenge only releases the slot it owned", async () => {
  const f = fixture(true);
  // batchCampChallenge also invokes batchCampClaimTasks at the end,
  // so both own a slot: two connect/release cycles in total.
  await f.tasks.batchCampChallenge();
  assert.equal(f.calls.closed, 2);
  assert.equal(f.calls.released, 2);
});

test("camp challenge leaves a pre-existing connection untouched", async () => {
  const f = fixture(false);
  await f.tasks.batchCampChallenge();
  assert.equal(f.calls.closed, 0);
  assert.equal(f.calls.released, 0);
});

test("camp challenge pet leaves a pre-existing connection untouched", async () => {
  const f = fixture(false);
  await f.tasks.batchCampChallengePet();
  assert.equal(f.calls.closed, 0);
  assert.equal(f.calls.released, 0);
});

test("camp claim tasks leaves a pre-existing connection untouched", async () => {
  const f = fixture(false);
  await f.tasks.batchCampClaimTasks();
  assert.equal(f.calls.closed, 0);
  assert.equal(f.calls.released, 0);
});
