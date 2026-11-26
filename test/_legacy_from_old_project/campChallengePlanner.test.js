import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAMP_DAILY_ATTACK_LIMIT,
  CAMP_NO_CHANCE_THRESHOLD,
  CAMP_PET_ATTEMPT_LIMIT,
  CAMP_WINS_TARGET,
  decideNextStep,
  hasAttacksLeft,
  hasEnoughWins,
  isNoChanceError,
  shouldStopNaturalAttacks,
  sortTargetsByPower,
} from "../src/utils/batch/campChallengePlanner.js";

test("targets are three wins and ten daily attacks", () => {
  assert.equal(CAMP_WINS_TARGET, 3);
  assert.equal(CAMP_DAILY_ATTACK_LIMIT, 10);
  assert.ok(CAMP_PET_ATTEMPT_LIMIT > 0);
});

test("weakest targets come first by power", () => {
  const targets = [
    { roleId: 1, name: "strong" },
    { roleId: 2, name: "weak" },
    { roleId: 3, name: "middle" },
  ];
  const powerById = { 1: 900, 2: 100, 3: 500 };
  assert.deepEqual(
    sortTargetsByPower(targets, powerById).map((t) => t.roleId),
    [2, 3, 1],
  );
  // 原数组不被修改
  assert.deepEqual(targets.map((t) => t.roleId), [1, 2, 3]);
});

test("targets without power data fall back to their own power field", () => {
  const targets = [
    { roleId: 1, power: 300 },
    { roleId: 2, power: 50 },
  ];
  assert.deepEqual(
    sortTargetsByPower(targets, {}).map((t) => t.roleId),
    [2, 1],
  );
});

test("enough wins stops challenging people", () => {
  assert.equal(hasEnoughWins(3), true);
  assert.equal(hasEnoughWins(4), true);
  assert.equal(hasEnoughWins(2), false);
  const decision = decideNextStep({ winCount: 3, attackCount: 5 });
  assert.deepEqual(decision, {
    done: true,
    usePets: false,
    reason: "已赢够目标场数",
  });
});

test("ten attacks spent but short of wins switches to pets", () => {
  assert.equal(hasAttacksLeft(10), false);
  const decision = decideNextStep({ winCount: 2, attackCount: 10 });
  assert.equal(decision.done, false);
  assert.equal(decision.usePets, true);
});

test("still has attacks means keep challenging people", () => {
  const decision = decideNextStep({ winCount: 1, attackCount: 4 });
  assert.equal(decision.usePets, false);
  assert.equal(decision.done, false);
});

test("isNoChanceError recognizes 200020 / generic message", () => {
  assert.equal(isNoChanceError(new Error("服务器错误: 200020 - 出了点小问题")), true);
  assert.equal(isNoChanceError({ message: "出了点小问题，请尝试重启游戏" }), true);
  assert.equal(isNoChanceError(new Error("连接超时")), false);
  assert.equal(isNoChanceError(null), false);
});

test("shouldStopNaturalAttacks stops after consecutive threshold", () => {
  assert.equal(CAMP_NO_CHANCE_THRESHOLD, 5);
  assert.equal(shouldStopNaturalAttacks(0), false);
  assert.equal(shouldStopNaturalAttacks(2), false);
  assert.equal(shouldStopNaturalAttacks(4), false);
  assert.equal(shouldStopNaturalAttacks(5), true);
  assert.equal(shouldStopNaturalAttacks(6), true);
});
