import { HERO_DICT } from '../HeroList.js';
import { GENIE_UNLOCK_LEVEL, getMainStageLevel } from '../gameFeatureUnlocks.js';

export const GENIE_TEAMS = Object.freeze({
  1: { name: '魏国', heroes: [102, 117, 113, 109, 101], carry: 101 },
  2: { name: '蜀国', heroes: [104, 103, 110, 118, 114], carry: 103 },
  3: { name: '吴国', heroes: [106, 121, 105, 111, 115], carry: 106 },
  4: { name: '群雄', heroes: [107, 116, 112, 120, 108], carry: 107 },
});
export const heroName = id => HERO_DICT[id]?.name || String(id);
export const gameDay = (now = Date.now()) => new Date(now + 28800000).toISOString().slice(0, 10);
export function issue(message, status = 'unverified') { return Object.assign(new Error(message), { status }); }
const numeric = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
export function normalizeGenieConfig(input = {}) {
  const genieId = Number(input.genieId), attempts = Number(input.attempts);
  if (!Number.isInteger(genieId) || !GENIE_TEAMS[genieId]) throw issue('请选择普通四阵营之一', 'conditions');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw issue('挑战次数必须为1–10的整数', 'conditions');
  return { genieId, attempts, stopOnLoss: input.stopOnLoss === true, allowInitialProbe: input.allowInitialProbe === true };
}
export function readDailyQuota(role, now = Date.now(), allowInitialProbe = false) {
  const n = role?.statistics?.['genie:battle'], t = role?.statisticsTime?.['genie:battle'];
  const validDate = ms => Number.isFinite(ms) && Number.isFinite(new Date(ms + 28800000).getTime());
  if (!validDate(now)) throw issue('当前时间无效，请检查电脑日期和时间');
  const day = gameDay(now);
  const stamp = ms => new Date(ms + 28800000).toISOString().slice(0, 19).replace('T', ' ');
  const probe = (reason, extra = {}) => ({ used: null, remaining: null, day, probe: true, probeReason: reason, ...extra });
  const mapsPresent = role?.statistics && role?.statisticsTime
    && typeof role.statistics === 'object' && !Array.isArray(role.statistics)
    && typeof role.statisticsTime === 'object' && !Array.isArray(role.statisticsTime);
  if (allowInitialProbe && mapsPresent
    && !Object.hasOwn(role.statistics, 'genie:battle') && !Object.hasOwn(role.statisticsTime, 'genie:battle'))
    return probe('计数和统计时间均未返回');
  if (!Number.isSafeInteger(Number(n)) || !numeric(n) || Number(n) < 0 || !numeric(t) || Number(t) <= 0)
    throw issue('当日共享次数或统计时间缺失/格式异常，状态待核验');
  const ms = Number(t) > 1e12 ? Number(t) : Number(t) * 1000;
  if (!validDate(ms)) throw issue('统计时间超出有效日期范围，未发送挑战');
  const statsDay = gameDay(ms);
  const diagnostic = `统计北京时间${stamp(ms)}；当前北京时间${stamp(now)}`;
  if (statsDay > day || ms > now + 60000)
    throw issue(`统计时间在未来（${diagnostic}）；请检查电脑日期和时间，未发送挑战`);
  if (statsDay < day) {
    // Historical usage is not today's zero or today's remaining allowance.
    // Explicit opt-in permits ONE probe; settleGenieBattle still requires a
    // fresh same-day count and matching battle/progress before continuing.
    if (allowInitialProbe)
      return probe(`历史统计${statsDay}已用${Number(n)}次，今日次数未知`, { historicalUsed: Number(n), statisticsDay: statsDay });
    throw issue(`统计时间非当日（历史记录：${diagnostic}）；可勾选“允许受限首战”后开始挑战`);
  }
  const used = Number(n);
  return { used, remaining: Math.max(0, 10 - used), day };
}
export function parseMainTeam(raw) {
  if (!raw || typeof raw !== 'object') throw issue('主线阵容缺失');
  const entries = Object.entries(raw);
  if (entries.length !== 5) throw issue('主线阵容不完整');
  const oneBased = !Array.isArray(raw) && !Object.hasOwn(raw, '0') && entries.every(([k]) => /^[1-5]$/.test(k));
  const slots = entries.map(([k, v]) => ({
    position: Number(v?.battleTeamSlot ?? (oneBased ? Number(k) - 1 : k)),
    heroId: Number(typeof v === 'object' ? v?.heroId ?? v?.id : v),
  })).sort((a, b) => a.position - b.position);
  if (slots.some((v, i) => v.position !== i || !Number.isInteger(v.heroId) || v.heroId <= 0) || new Set(slots.map(v => v.heroId)).size !== 5)
    throw issue('主线阵容位置或武将重复/无效');
  return slots;
}
export function activePresetTeam(response) {
  const data = response?.data ?? response;
  const wrapper = data?.presetTeamInfo;
  const dict = wrapper?.presetTeamInfo ?? wrapper;
  const useTeamId = wrapper?.useTeamId ?? data?.useTeamId;
  if (!numeric(useTeamId) || !Number.isInteger(Number(useTeamId)) || Number(useTeamId) < 1) throw issue('无法确认正在使用的阵容槽');
  return parseMainTeam(dict?.[useTeamId]?.teamInfo);
}
export function strongestPosition(slots, heroes) {
  const ranked = slots.map(v => {
    const power = heroes?.[v.heroId]?.power;
    if (!numeric(power) || Number(power) <= 0) throw issue(`${heroName(v.heroId)}个人战力字段不可核验`);
    return { ...v, power: Number(power) };
  });
  // Stable tie rule: the lowest 0-based position wins.
  return ranked.reduce((best, v) => v.power > best.power ? v : best);
}
export function challengeTeam(genieId, position, owned) {
  const nation = GENIE_TEAMS[genieId];
  if (!nation || !Number.isInteger(position) || position < 0 || position > 4) throw issue('阵营或位置无效', 'conditions');
  const missing = nation.heroes.filter(id => !owned?.[id]);
  if (missing.length) throw issue(`缺少武将：${missing.map(heroName).join('、')}`, 'conditions');
  const team = nation.heroes.filter(id => id !== nation.carry);
  team.splice(position, 0, nation.carry);
  return Object.fromEntries(team.map((id, i) => [i, id]));
}

// Rank the server hp field. Extra talent/quench fields are not added again:
// their inclusion in hp has not been established, so this is not a derived total.
export function verifiedPetHealth(pet) {
  if (!pet || typeof pet.uId !== 'string' || !pet.uId.trim() || !numeric(pet.hp) || Number(pet.hp) <= 0)
    throw issue('宠物UID或服务器生命值hp缺失，无法比较');
  return { petUId: pet.uId, maxHp: Number(pet.hp), source: '服务器hp排序（不重复叠加淬炼/天赋；非推算最终总血量）' };
}
export function selectHighestHpPet(pets, readHealth = verifiedPetHealth) {
  if (!pets || typeof pets !== 'object' || !Object.keys(pets).length) throw issue('没有可用宠物', 'conditions');
  const candidates = Object.entries(pets).map(([key, pet]) => {
    // A key is accepted only when the evidence adapter verifies it as a UID.
    const evidence = readHealth(pet, key);
    if (!evidence || typeof evidence.petUId !== 'string' || !evidence.petUId.trim() || !numeric(evidence.maxHp) || Number(evidence.maxHp) <= 0 || !evidence.source)
      throw issue('宠物UID或最大生命值依据不完整');
    if (evidence.petUId === String(pet.petId)) throw issue('不能将petId用作petUId');
    return { petUId: evidence.petUId, petId: pet.petId, maxHp: Number(evidence.maxHp), source: evidence.source };
  });
  if (new Set(candidates.map(p => p.petUId)).size !== candidates.length) throw issue('宠物UID重复');
  candidates.sort((a, b) => b.maxHp - a.maxHp || (a.petUId < b.petUId ? -1 : a.petUId > b.petUId ? 1 : 0));
  return { ...candidates[0], compared: candidates.length, maskedUid: `…${candidates[0].petUId.slice(-3)}` };
}
export function roleFrom(response) {
  const role = response?.data?.role ?? response?.role;
  if (!role || typeof role !== 'object') throw issue('角色查询未返回role');
  return role;
}
export function progressFrom(role, genieId, previous = null) {
  const n = role?.genie?.[genieId];
  return numeric(n) && Number.isInteger(Number(n)) && Number(n) >= 0 ? Number(n) + 1 : previous;
}
export function readBattle(response, genieId) {
  if (response?.code !== undefined && response.code !== 0) throw issue(`服务器拒绝挑战（${Number(response.code)}）`, 'protocol');
  const data = response?.data ?? response;
  const flags = [data?.isWin, data?.battleData?.result?.isWin].filter(v => v !== undefined);
  if (flags.some(v => typeof v !== 'boolean') || flags.some(v => v !== flags[0])) throw issue('胜负字段缺失或冲突');
  const id = data?.battleData?.options?.genieLevelId;
  if (!numeric(id) || !Number.isInteger(Number(id)) || Math.floor(Number(id) / 1000) !== genieId || Number(id) % 1000 < 1) throw issue('战斗阵营/关卡无法核验');
  const result = data?.battleData?.result;
  const teams = [result?.sponsor?.teamInfo, result?.accept?.teamInfo];
  const completeResult = Number.isFinite(result?.id) && result.id > 0 && result?.type === 9
    && Number.isFinite(result.totalFrame) && result.totalFrame > 0
    && Number.isInteger(result.round) && result.round > 0
    && teams.every(team => Array.isArray(team) && team.length === 5
      && team.every(h => Number.isInteger(h.heroId) && numeric(h.hp) && Number(h.hp) >= 0));
  if (!flags.length && !completeResult) throw issue('胜负字段缺失且战报不完整');
  return { isWin: flags.length ? flags[0] : null, stage: Number(id) % 1000, role: data.role,
    sparseResult: !flags.length ? result : null };
}

// Missing isWin is NOT globally false. Only a complete battle plus a fresh
// shared-count increment and unchanged progress can confirm the observed loss.
export function settleGenieBattle(battle, beforeRole, afterRole, before, after, genieId, team) {
  if (after.day !== before.day || (before.probe ? after.probe || !Number.isInteger(after.used) || after.used < 1 || after.used > 10 : after.used !== before.used + 1))
    throw issue('战后共享次数未按预期变化，保留防重放记录');
  const previous = progressFrom(beforeRole, genieId, battle.stage === 1 ? 0 : null);
  if (previous === null || battle.stage !== previous + 1) throw issue('战报关卡与挑战前进度不一致');
  const returned = progressFrom(afterRole, genieId, previous);
  let isWin = battle.isWin;
  if (isWin === null) {
    const result = battle.sparseResult;
    const actual = result.sponsor.teamInfo.slice().sort((a,b) => a.index - b.index).map(h => h.heroId);
    if (!afterRole.genie || typeof afterRole.genie !== 'object' || returned !== previous
      || JSON.stringify(actual) !== JSON.stringify(Object.values(team))
      || !result.accept.teamInfo.some(h => Number(h.hp) > 0))
      throw issue('胜负缺省且战报、阵容或进度不足以确认战败');
    isWin = false;
  }
  const cleared = isWin ? battle.stage : battle.stage - 1;
  if (returned !== cleared) throw issue('胜负与回读关卡冲突，状态待核验');
  return { ...battle, isWin, cleared, resultSource: battle.isWin === null ? '完整战报+次数+未推进关卡' : 'isWin' };
}
export function buildPreview(role, config, slots, now, readHealth) {
  const level = getMainStageLevel(role);
  if (level === null) throw issue('主线进度未知，无法核验灯神开启条件');
  if (level < GENIE_UNLOCK_LEVEL) throw issue(`主线未达到${GENIE_UNLOCK_LEVEL}关`, 'conditions');
  const quota = readDailyQuota(role, now, config.allowInitialProbe);
  if (quota.remaining === 0) return { status: 'quota', ...quota, message: '当日普通灯神10次额度已用完' };
  const strongest = strongestPosition(slots, role.heroes);
  const battleTeam = challengeTeam(config.genieId, strongest.position, role.heroes);
  const pet = selectHighestHpPet(role.petData?.pets, readHealth);
  return { status: 'ready', ...quota, strongest, battleTeam, pet, cleared: progressFrom(role, config.genieId), limit: quota.probe ? config.attempts : Math.min(config.attempts, quota.remaining) };
}

// Independent diagnostics remain visible even when quota prevents execution.
export function inspectGenieSetup(role, config, readHealth) {
  const preview = {}, notes = [];
  try {
    preview.strongest = strongestPosition(parseMainTeam(role.battleTeam), role.heroes);
    preview.battleTeam = challengeTeam(config.genieId, preview.strongest.position, role.heroes);
  } catch (e) { notes.push(e.message); }
  try { preview.pet = selectHighestHpPet(role.petData?.pets, readHealth); }
  catch (e) { notes.push(e.message); }
  return { ...preview, notes };
}
