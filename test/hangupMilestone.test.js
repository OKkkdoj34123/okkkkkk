import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkUpgradeMilestone,
  getUpgradeMilestone,
  UPGRADE_STEP,
} from "../src/utils/hangupMilestone.js";

test("upgrade step is 50 levels", () => {
  assert.equal(UPGRADE_STEP, 50);
});

test("level 51 means the 50-level milestone was crossed", () => {
  assert.equal(getUpgradeMilestone(50), 0);
  assert.equal(getUpgradeMilestone(51), 1);
  assert.equal(getUpgradeMilestone(100), 1);
  assert.equal(getUpgradeMilestone(101), 2);
  assert.equal(getUpgradeMilestone(201), 4);
});

test("invalid or low levels produce no milestone", () => {
  assert.equal(getUpgradeMilestone(0), 0);
  assert.equal(getUpgradeMilestone(49), 0);
  assert.equal(getUpgradeMilestone(null), 0);
  assert.equal(getUpgradeMilestone("abc"), 0);
});

test("crossing 50 triggers an upgrade once per interval", () => {
  const first = checkUpgradeMilestone(51, 0);
  assert.deepEqual(first, { upgrade: true, milestone: 1, crossedLevel: 50 });
  assert.equal(checkUpgradeMilestone(55, 1).upgrade, false);
  assert.equal(checkUpgradeMilestone(75, 1).upgrade, false);
  assert.equal(checkUpgradeMilestone(100, 1).upgrade, false);
});

test("crossing 100 triggers the next upgrade", () => {
  assert.deepEqual(checkUpgradeMilestone(103, 1), {
    upgrade: true,
    milestone: 2,
    crossedLevel: 100,
  });
});

test("a skipped exact level still triggers the upgrade", () => {
  const result = checkUpgradeMilestone(53, 0);
  assert.equal(result.upgrade, true);
  assert.equal(result.crossedLevel, 50);
});

test("restarting at a high level does not upgrade repeatedly", () => {
  const result = checkUpgradeMilestone(250, 0);
  assert.equal(result.upgrade, true);
  assert.deepEqual(result, { upgrade: true, milestone: 4, crossedLevel: 200 });
  assert.equal(checkUpgradeMilestone(250, 4).upgrade, false);
});

test("step can be overridden for flexibility", () => {
  assert.equal(getUpgradeMilestone(101, 100), 1);
  assert.deepEqual(checkUpgradeMilestone(101, 0, 100), {
    upgrade: true,
    milestone: 1,
    crossedLevel: 100,
  });
});
