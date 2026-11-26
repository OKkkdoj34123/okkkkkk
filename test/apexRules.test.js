import test from "node:test";
import assert from "node:assert/strict";
import {
  APEX_SEASON,
  APEX_TAOTAI_STAGES,
  apexScheduleMap,
} from "../src/utils/apexStageMap.js";
import {
  ApexScheduleStatus,
  getApexScheduleConf,
  getApexScheduleIdsForRound,
  getApexClaimScheduleIds,
  getAutoApexSchedule,
  getBeijingDateZeroTime,
  getPreviousRoundScheduleIds,
  getScheduleStatus,
} from "../src/utils/apexRules.js";

const beijing = (year, month, day, hour = 0, minute = 0, second = 0) =>
  Date.UTC(year, month - 1, day, hour - 8, minute, second);

test("schedule snapshot contains only first-season records", () => {
  const rows = Object.values(apexScheduleMap);
  assert.equal(APEX_SEASON, 1);
  assert.equal(rows.length, 312);
  assert.equal(rows.every((row) => Number(row.season) === 1), true);
  assert.deepEqual(APEX_TAOTAI_STAGES, [4, 5, 6, 7, 8, 9, 10]);
});

test("Beijing date conversion is independent of host display timezone", () => {
  assert.equal(
    getBeijingDateZeroTime("2026/11/10"),
    Date.UTC(2026, 10, 9, 16, 0, 0),
  );
  assert.equal(Number.isNaN(getBeijingDateZeroTime("2026/02/30")), true);
  assert.equal(Number.isNaN(getBeijingDateZeroTime("bad-date")), true);
});

test("same-day previous match gates the next match", () => {
  assert.equal(
    getScheduleStatus(155, beijing(2026, 11, 9, 19, 44, 59)),
    ApexScheduleStatus.None,
  );
  assert.equal(
    getScheduleStatus(155, beijing(2026, 11, 9, 19, 45, 0)),
    ApexScheduleStatus.Unlocked,
  );
  assert.equal(
    getScheduleStatus(155, beijing(2026, 11, 9, 20, 30, 0)),
    ApexScheduleStatus.Locked,
  );
  assert.equal(
    getScheduleStatus(155, beijing(2026, 11, 9, 21, 30, 0)),
    ApexScheduleStatus.Fighting,
  );
  assert.equal(
    getScheduleStatus(155, beijing(2026, 11, 9, 22, 15, 0)),
    ApexScheduleStatus.Completed,
  );
});

test("final schedule 156 changes state at configured Beijing boundaries", () => {
  assert.equal(
    getScheduleStatus(156, beijing(2026, 11, 10, 18, 59, 59)),
    ApexScheduleStatus.Unlocked,
  );
  assert.equal(
    getScheduleStatus(156, beijing(2026, 11, 10, 19, 0, 0)),
    ApexScheduleStatus.Locked,
  );
  assert.equal(
    getScheduleStatus(156, beijing(2026, 11, 10, 20, 0, 0)),
    ApexScheduleStatus.Fighting,
  );
  assert.equal(
    getScheduleStatus(156, beijing(2026, 11, 10, 22, 15, 0)),
    ApexScheduleStatus.Completed,
  );
});

test("automatic detection selects exactly one open knockout schedule", () => {
  const result = getAutoApexSchedule(beijing(2026, 11, 10, 10, 20, 0));
  assert.equal(result.ok, true);
  assert.equal(result.schedule.id, 156);
  assert.equal(result.schedule.round, 6);
  assert.equal(result.schedule.stage, 10);
  assert.equal(result.status, ApexScheduleStatus.Unlocked);
});

test("automatic detection refuses to guess while the schedule is fighting", () => {
  const result = getAutoApexSchedule(beijing(2026, 11, 10, 20, 0, 0));
  assert.equal(result.ok, false);
  assert.match(result.reason, /没有处于/);
});

test("previous-round claim scope is based on round, not scheduleId minus one", () => {
  assert.deepEqual(
    getPreviousRoundScheduleIds(156),
    [124, 125, 126, 127, 128, 129, 130],
  );
  assert.deepEqual(
    getPreviousRoundScheduleIds(153),
    [124, 125, 126, 127, 128, 129, 130],
  );
  assert.equal(getApexScheduleConf(153).round, 6);
  assert.deepEqual(getApexScheduleIdsForRound(5), [124, 125, 126, 127, 128, 129, 130]);
});

test("claim scope includes the latest configured rounds, including current round", () => {
  assert.deepEqual(getApexClaimScheduleIds(156, 1), [
    150, 151, 152, 153, 154, 155, 156,
    124, 125, 126, 127, 128, 129, 130,
  ]);
  assert.deepEqual(getApexClaimScheduleIds(156, 5), [
    150, 151, 152, 153, 154, 155, 156,
    124, 125, 126, 127, 128, 129, 130,
    98, 99, 100, 101, 102, 103, 104,
    72, 73, 74, 75, 76, 77, 78,
    46, 47, 48, 49, 50, 51, 52,
    20, 21, 22, 23, 24, 25, 26,
  ]);
  assert.deepEqual(getApexClaimScheduleIds(156, 0), [150, 151, 152, 153, 154, 155, 156]);
  assert.deepEqual(getApexClaimScheduleIds(156, -1), []);
});
