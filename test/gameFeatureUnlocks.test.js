import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DREAM_UNLOCK_LEVEL,
  GENIE_UNLOCK_LEVEL,
  getMainStageLevel,
  meetsMainStageRequirement,
} from "../src/utils/gameFeatureUnlocks.js";

test("getMainStageLevel reads role-info response shapes", () => {
  assert.equal(getMainStageLevel({ role: { levelId: 999 } }), 999);
  assert.equal(
    getMainStageLevel({ data: { role: { levelId: "3000" } } }),
    3000,
  );
  assert.equal(getMainStageLevel({ levelId: 1234.9 }), 1234);
});

test("getMainStageLevel never mistakes the player level for main progress", () => {
  assert.equal(getMainStageLevel({ level: 600 }), null);
  assert.equal(getMainStageLevel({ role: { level: 600 } }), null);
  assert.equal(getMainStageLevel({ levelId: "" }), null);
});

test("dream unlocks at stage 1000", () => {
  assert.equal(DREAM_UNLOCK_LEVEL, 1000);
  assert.equal(
    meetsMainStageRequirement({ levelId: 999 }, DREAM_UNLOCK_LEVEL),
    false,
  );
  assert.equal(
    meetsMainStageRequirement({ levelId: 1000 }, DREAM_UNLOCK_LEVEL),
    true,
  );
});

test("genie unlocks at stage 3000", () => {
  assert.equal(GENIE_UNLOCK_LEVEL, 3000);
  assert.equal(
    meetsMainStageRequirement({ levelId: 2999 }, GENIE_UNLOCK_LEVEL),
    false,
  );
  assert.equal(
    meetsMainStageRequirement({ levelId: 3000 }, GENIE_UNLOCK_LEVEL),
    true,
  );
});

test("unknown stage preserves the previous request behavior", () => {
  assert.equal(meetsMainStageRequirement({}, DREAM_UNLOCK_LEVEL), true);
  assert.equal(meetsMainStageRequirement(null, GENIE_UNLOCK_LEVEL), true);
});
