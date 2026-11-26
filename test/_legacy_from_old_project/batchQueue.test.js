import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkTokens,
  normalizeBatchDelay,
  normalizeBatchSize,
  waitWithStop,
} from "../src/utils/batch/batchQueue.js";

test("chunkTokens splits accounts into fixed-size batches", () => {
  assert.deepEqual(chunkTokens(["a", "b", "c", "d", "e"], 2), [
    ["a", "b"],
    ["c", "d"],
    ["e"],
  ]);
  assert.deepEqual(chunkTokens(["a", "b"], 5), [["a", "b"]]);
  assert.deepEqual(chunkTokens([], 3), []);
});

test("chunkTokens clamps invalid batch sizes instead of looping forever", () => {
  assert.deepEqual(chunkTokens(["a", "b"], 0), [["a"], ["b"]]);
  assert.deepEqual(chunkTokens(["a", "b"], -4), [["a"], ["b"]]);
  assert.equal(normalizeBatchSize(999, 5), 200);
  assert.equal(normalizeBatchSize("not-a-number", 5), 5);
  assert.equal(normalizeBatchSize(3.7), 3);
});

test("delay seconds accept ten minutes but are clamped at 600", () => {
  assert.equal(normalizeBatchDelay(600), 600);
  assert.equal(normalizeBatchDelay(900), 600);
  assert.equal(normalizeBatchDelay(-1), 0);
  assert.equal(normalizeBatchDelay("oops", 30), 30);
});

test("waitWithStop supports long delays without blocking real time in tests", async () => {
  let stopped = false;
  const sleeps = [];
  const completed = await waitWithStop(
    600000,
    () => stopped,
    async (duration) => {
      sleeps.push(duration);
      // Simulate elapsed time by flipping the stop flag after a few ticks.
      if (sleeps.length === 3) stopped = true;
    },
  );
  assert.equal(completed, false);
  assert.equal(sleeps.length, 3);
  assert.ok(sleeps.every((duration) => duration <= 200));
});

test("waitWithStop completes when the delay elapses without a stop", async () => {
  let elapsed = 0;
  const completed = await waitWithStop(
    400,
    () => false,
    async (duration) => {
      elapsed += duration;
    },
  );
  assert.equal(completed, true);
  assert.equal(elapsed, 400);
});
