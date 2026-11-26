import { GENIE_TEAMS, normalizeGenieConfig, issue } from './genieChallengePolicy.js';

export const DEFAULT_GENIE_ATTEMPTS = Object.freeze({ 1: 2, 2: 2, 3: 2, 4: 4 });

export function normalizeGeniePlan(input = {}) {
  // Preserve the single-nation API for existing callers and offline fixtures.
  if (input.attemptsByNation === undefined && input.genieId !== undefined) {
    const single = normalizeGenieConfig(input);
    return { ...single, attemptsByNation: Object.fromEntries([1, 2, 3, 4].map(id => [id, id === single.genieId ? single.attempts : 0])), total: single.attempts };
  }
  const raw = input.attemptsByNation ?? DEFAULT_GENIE_ATTEMPTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(id => !GENIE_TEAMS[id])) throw issue('仅支持普通四国次数配置', 'conditions');
  const attemptsByNation = {};
  for (const id of [1, 2, 3, 4]) {
    const value = raw[id];
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === ''
      || !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 10)
      throw issue(`${GENIE_TEAMS[id].name}次数必须为0–10的整数`, 'conditions');
    attemptsByNation[id] = Number(value);
  }
  const total = Object.values(attemptsByNation).reduce((sum, n) => sum + n, 0);
  if (total < 1 || total > 10) throw issue('四国挑战总次数必须为1–10次', 'conditions');
  return { attemptsByNation, total, useTechnology: input.useTechnology === true, upgradeEmptyTechnology: input.upgradeEmptyTechnology === true, stopOnLoss: input.stopOnLoss === true, allowInitialProbe: input.allowInitialProbe !== false };
}
