export const DREAM_STAGE_MAX_RETRIES = 5; // first request plus five retries
export function getDreamRound(nowMs = Date.now()) {
  const offset = 8 * 3600000, dayMs = 86400000, d = new Date(nowMs + offset), day = d.getUTCDay();
  const open = [0, 1, 3, 4].includes(day);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - offset;
  const startMs = open ? midnight - ([1, 4].includes(day) ? dayMs : 0) : null;
  return { open, day, startMs, endMs: open ? startMs + 2 * dayMs : null };
}
const number = value => {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null;
};
export function dailyDreamPreflight(response, nowMs = Date.now()) {
  const role = (response?._rawData ?? response?.data ?? response)?.role, dungeon = role?.dungeon, round = getDreamRound(nowMs);
  if (!round.open) return { status: "skipped", reason: "当前不在梦境开放轮次" };
  if (!dungeon || typeof dungeon.battleTeam !== "object" || dungeon.battleTeam === null)
    return { status: "warning", reason: "结果待核验：缺少梦境轮次或阵容状态，未发送选将" };
  const begin = number(dungeon.beginTime), beginMs = begin !== null ? (begin >= 1e12 ? begin : begin * 1000) : null;
  if (beginMs === null || beginMs > nowMs + 300000) return { status: "warning", reason: "结果待核验：梦境轮次时间无效，未发送选将" };
  const values = Object.values(dungeon.battleTeam);
  if (values.some(h => number(h?.heroId ?? h) === null)) return { status: "warning", reason: "结果待核验：梦境阵容字段异常" };
  const actors = values.filter(h => Number(h?.heroId ?? h) > 0);
  if (actors.length && beginMs < Date.UTC(2010, 0, 1)) return { status: "warning", reason: "结果待核验：已有阵容但缺少有效轮次时间" };
  if (beginMs < round.startMs) return { status: "select", reason: "旧轮次状态，需要本轮选将" };
  if (!actors.length) return { status: "select", reason: "本轮未上阵武将" };
  if (actors.some(h => number(h?.hp) === null)) return { status: "warning", reason: "结果待核验：本轮已有阵容但血量不完整，未重复选将" };
  return { status: "skipped", reason: actors.every(h => Number(h.hp) === 0) ? "本轮已选将且武将血量归零，无需再次选将" : "本轮已有上阵阵容，无需再次选将；连续战斗由一键梦境执行" };
}
export function decideDreamAfterBattle(before, after, roundStatus, requests) {
  if (roundStatus !== "current") return { action: "warning", reason: "结果待核验：未确认仍为当前梦境轮次" };
  if (after.hp === 0) return { action: "completed", reason: "上阵武将血量归零，正常结束" };
  if (![before.id, before.maxId, after.id, after.maxId, after.hp].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) || after.hp <= 0)
    return { action: "warning", reason: "结果待核验：关卡、最高通关关卡或武将血量缺失" };
  if (after.id < before.id || after.maxId < before.maxId) return { action: "warning", reason: "结果待核验：梦境关卡回退，未重发战斗" };
  if (after.id > before.id || after.maxId > before.maxId) return { action: "advance", reason: "已确认关卡推进" };
  if (requests >= 1 + DREAM_STAGE_MAX_RETRIES) return { action: "warning", reason: `同关卡已请求${requests}次（首次1次+重试${DREAM_STAGE_MAX_RETRIES}次），达到上限；结果待核验` };
  return { action: "retry", retry: requests, reason: `关卡未推进且武将存活，准备重试${requests}/${DREAM_STAGE_MAX_RETRIES}` };
}
