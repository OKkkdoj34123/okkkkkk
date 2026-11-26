import assert from "node:assert/strict";
import { test } from "node:test";

import { extractDreamBattleTeam } from "../src/utils/dreamTeam.js";

test("extractDreamBattleTeam reads the active preset formation", () => {
  const response = {
    presetTeamInfo: {
      useTeamId: 2,
      presetTeamInfo: {
        1: { teamInfo: { 0: { heroId: 101 } } },
        2: {
          teamInfo: {
            0: { heroId: 107 },
            1: { heroId: 104 },
            3: { heroId: 120 },
          },
        },
      },
    },
  };

  assert.deepEqual(extractDreamBattleTeam(response), {
    0: 107,
    1: 104,
    2: 0,
    3: 120,
    4: 0,
  });
});

test("extractDreamBattleTeam supports data wrappers and direct hero ids", () => {
  const response = {
    data: {
      presetTeamInfo: {
        useTeamId: "1",
        presetTeamInfo: {
          1: { teamInfo: { 0: 101, 1: "102", 2: { id: 103 } } },
        },
      },
    },
  };

  assert.deepEqual(extractDreamBattleTeam(response), {
    0: 101,
    1: 102,
    2: 103,
    3: 0,
    4: 0,
  });
});

test("extractDreamBattleTeam normalizes one-based slot maps", () => {
  const response = {
    useTeamId: 1,
    teams: {
      1: {
        team: {
          1: { heroId: 101 },
          2: { heroId: 102 },
          3: 0,
          4: { heroId: 104 },
          5: { heroId: 105 },
        },
      },
    },
  };

  assert.deepEqual(extractDreamBattleTeam(response), {
    0: 101,
    1: 102,
    2: 0,
    3: 104,
    4: 105,
  });
});

test("extractDreamBattleTeam rejects missing or empty formations", () => {
  assert.equal(extractDreamBattleTeam(null), null);
  assert.equal(
    extractDreamBattleTeam({
      presetTeamInfo: {
        useTeamId: 1,
        presetTeamInfo: { 1: { teamInfo: { 0: 0, 1: 0 } } },
      },
    }),
    null,
  );
});
