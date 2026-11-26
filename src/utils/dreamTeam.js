const getHeroId = (hero) => {
  const rawId = hero?.heroId ?? hero?.id ?? hero;
  const heroId = Number(rawId);
  return Number.isFinite(heroId) && heroId > 0 ? Math.trunc(heroId) : 0;
};

const findUseTeamId = (value, depth = 0) => {
  if (!value || typeof value !== "object" || depth > 4) return null;

  const directId = Number(value.useTeamId);
  if (Number.isFinite(directId) && directId > 0) return Math.trunc(directId);

  for (const nested of Object.values(value)) {
    const found = findUseTeamId(nested, depth + 1);
    if (found !== null) return found;
  }

  return null;
};

const hasNumericKeys = (value) =>
  value &&
  typeof value === "object" &&
  Object.keys(value).some((key) => /^\d+$/.test(key));

/**
 * Convert the active preset formation into the five-slot payload expected by
 * dungeon_selecthero. Empty slots are sent explicitly as zero.
 *
 * @param {object|null|undefined} response presetteam_getinfo response
 * @returns {Record<string, number>|null}
 */
export function extractDreamBattleTeam(response) {
  const responseRoot = response?.data ?? response;
  const root = responseRoot?.presetTeamInfo ?? responseRoot;
  if (!root || typeof root !== "object") return null;

  const useTeamId = findUseTeamId(root) ?? 1;
  const candidates = [root.presetTeamInfo, root.teams, root];
  let teamNode = null;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const selected = candidate[useTeamId] ?? candidate[String(useTeamId)];
    if (selected) {
      teamNode = selected;
      break;
    }
  }

  if (!teamNode && (root.teamInfo || root.team || root.heroes)) {
    teamNode = root;
  }

  if (!teamNode) {
    const teamContainer = candidates.find(hasNumericKeys);
    const firstTeamKey = Object.keys(teamContainer || {}).find((key) =>
      /^\d+$/.test(key),
    );
    teamNode = firstTeamKey ? teamContainer[firstTeamKey] : null;
  }

  const rawTeam =
    teamNode?.teamInfo ?? teamNode?.team ?? teamNode?.heroes ?? teamNode;
  if (!rawTeam || typeof rawTeam !== "object") return null;

  const source = Array.isArray(rawTeam)
    ? Object.fromEntries(rawTeam.map((hero, index) => [String(index), hero]))
    : rawTeam;
  const oneBased = !("0" in source) && "5" in source;
  const battleTeam = {};
  let heroCount = 0;

  for (let position = 0; position < 5; position++) {
    const sourcePosition = oneBased ? position + 1 : position;
    const heroId = getHeroId(source[sourcePosition] ?? source[String(sourcePosition)]);
    battleTeam[String(position)] = heroId;
    if (heroId > 0) heroCount += 1;
  }

  return heroCount > 0 ? battleTeam : null;
}
