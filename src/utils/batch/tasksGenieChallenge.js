import {
  normalizeGenieConfig, roleFrom, parseMainTeam, activePresetTeam, buildPreview,
  readDailyQuota, readBattle, progressFrom, GENIE_TEAMS, issue,
  inspectGenieSetup, settleGenieBattle, challengeTeam,
} from './genieChallengePolicy.js';
import { selectGenieWeapon, ownedGenieWeapons } from './genieWeapon.js';
import { createTechnologySession } from './genieTechnology.js';
import { normalizeGeniePlan } from './genieChallengePlan.js';

export async function withGenieLock(locks, action) {
  if (!locks?.request) throw issue('浏览器不支持跨标签页互斥，请使用支持Web Locks的浏览器');
  return locks.request('xyzw-ordinary-genie-v1', { ifAvailable: true }, lock => {
    if (!lock) throw issue('另一个标签页正在预览或挑战普通灯神');
    return action();
  });
}

export function createGenieLedger(storage) {
  const key = id => `xyzw_genie_pending_v1:${id}`;
  return {
    get(id) { try { return JSON.parse(storage.getItem(key(id)) || 'null'); } catch { throw issue('挑战记录无法读取，停止防止重复请求'); } },
    set(id, value) { try { storage.setItem(key(id), JSON.stringify(value)); } catch { throw issue('挑战记录无法持久化，未发送挑战'); } },
    clear(id) { try { storage.removeItem(key(id)); } catch { throw issue('挑战记录无法清除，请核验后再运行'); } },
  };
}

// Never include arbitrary transport error text: some errors contain token URLs.
export function genieError(error, phase) {
  if (error?.status) return issue(error.message.startsWith(phase) ? error.message : `${phase}：${error.message}`, error.status);
  const message = String(error?.message || '');
  const code = Number.isFinite(error?.code) ? error.code : message.match(/(?:服务器错误|code)[:：=\s]+(\d+)/i)?.[1];
  const detail = code !== undefined ? `服务器错误码 ${code}`
    : /timeout|超时/i.test(message) ? '请求超时'
      : /closed|disconnect|关闭|断开/i.test(message) ? '连接已断开'
        : /connect|network|连接|网络/i.test(message) ? '连接未建立或网络异常'
          : `异常（${['Error','TypeError','RangeError','AbortError'].includes(error?.name) ? error.name : '未知类型'}）`;
  return issue(`${phase}：${detail}`, code !== undefined ? 'protocol' : 'unverified');
}

export async function runGenieAccount({ id, config: input, send, ledger, previewOnly = false,
  now = () => Date.now(), stopped = () => false, readHealth, onPreview = () => {},
  beforeFight = async () => {}, onBattle = () => {}, pause = () => Promise.resolve(), onUncertain = async () => {},
}) {
  const config = normalizeGenieConfig(input);
  const result = { status: 'unverified', attempted: 0, wins: 0, losses: 0, used: null, cleared: null };
  const checkStop = () => { if (stopped()) throw issue('用户主动停止', 'stopped'); };
  let phase = '读取角色';
  // Read-only retries are bounded. Battle submission has no retry path.
  const readRole = async label => {
    phase = label;
    try { return roleFrom(await send('role_getroleinfo', {})); }
    catch (first) {
      if (first?.status === 'stopped') throw first;
      try {
        await onUncertain(); await pause();
        return roleFrom(await send('role_getroleinfo', {}));
      } catch (second) { throw genieError(second, `${label}（只读重连后仍失败）`); }
    }
  };
  try {
    checkStop();
    let role = await readRole('开始前读取角色');
    checkStop();
    result.preview = inspectGenieSetup(role, config, readHealth);
    const quota = readDailyQuota(role, now(), config.allowInitialProbe);
    result.used = quota.used;
    const pending = ledger.get(id);
    if (pending && pending.day === quota.day) {
      if (!pending.battle || quota.probe) throw issue(`上次请求结果待核验：请求前已用${pending.used ?? '未知'}，当前已用${quota.used ?? '未知'}；未重发`);
      const settled = settleGenieBattle(pending.battle, {genie: pending.genie}, role,
        pending, quota, pending.genieId, pending.battleTeam);
      ledger.clear(id);
      return { ...result, status: 'reconciled', cleared: settled.cleared,
        message: `上次${GENIE_TEAMS[pending.genieId]?.name || ''}第${settled.stage}关已核验：${settled.isWin ? '胜利' : '失败'}，今日已用${quota.used}/10；本次未发挑战，请再次点击开始` };
    }
    if (pending && (!pending.day || pending.day > quota.day)) throw issue('上次请求日期异常，未重发');
    if (quota.remaining === 0) return { ...result, status: 'quota', message: '当日普通灯神10次额度已用完' };
    let slots;
    try { slots = parseMainTeam(role.battleTeam); }
    catch {
      phase = '读取当前阵容槽';
      slots = activePresetTeam(await send('presetteam_getinfo', {}));
    }
    checkStop();
    phase = '校验阵容、宠物与次数';
    const preview = buildPreview(role, config, slots, now(), readHealth);
    result.preview = preview; result.cleared = preview.cleared;
    onPreview(preview);
    if (previewOnly) return { ...result, status: 'ready', message: preview.probe
      ? `${preview.probeReason || '今日次数未知'}；已选择受限首战，开始后先发1次，回读确认今日次数和战报后才继续`
      : '预览通过；尚未发送战斗' };
    phase = '科技准备与切换';
    await beforeFight();
    checkStop();
    phase = '比较玩具战力';
    const weapon = await selectGenieWeapon({role,battleTeam:preview.battleTeam,petUId:preview.pet.petUId,send,stopped});
    preview.weapon=weapon; onPreview(preview);
    checkStop();
    const day = preview.day;
    while (result.attempted < preview.limit) {
      checkStop();
      // Initial state and each completed battle's fresh read serve as preflight.
      // No redundant before/after query pair between consecutive battles.
      phase = '挑战前校验';
      const before = readDailyQuota(role, now(), config.allowInitialProbe && result.attempted === 0);
      if (before.day !== day || (result.used !== null && before.used < result.used)) throw issue('日期变化或次数回退，停止重新核验');
      result.used = before.used;
      if (before.remaining === 0) break;
      let currentSlots;
      try { currentSlots = parseMainTeam(role.battleTeam); }
      catch { currentSlots = activePresetTeam(await send('presetteam_getinfo', {})); }
      const current = buildPreview(role, config, currentSlots, now(), readHealth);
      if (JSON.stringify(current.battleTeam) !== JSON.stringify(preview.battleTeam) || current.pet.petUId !== preview.pet.petUId)
        throw issue('阵容或宠物已变化，请再次点击开始');
      if (weapon.lordWeaponId && !ownedGenieWeapons(role).includes(weapon.lordWeaponId)) throw issue('已选玩具不在当前库存，停止挑战');
      checkStop();
      const marker = { day, used: before.used, probe: !!before.probe, genieId: config.genieId,
        genie: role.genie || {}, battleTeam: preview.battleTeam };
      ledger.set(id, marker);
      result.attempted++;
      phase = '发送灯神挑战';
      let battle;
      try {
        const response = await send('fight_startgenie', { battleTeam: preview.battleTeam,
          genieId: config.genieId, lordWeaponId: weapon.lordWeaponId, petUId: preview.pet.petUId });
        phase = '解析战斗回包';
        battle = readBattle(response, config.genieId);
        // Persist only the minimum evidence for later reconciliation, no full
        // report, account identity, pet UID, authentication or cached role.
        const sparse = battle.sparseResult;
        marker.battle = { isWin: battle.isWin, stage: battle.stage, sparseResult: sparse ? {
          sponsor: {teamInfo: sparse.sponsor.teamInfo.map(h => ({heroId:h.heroId,index:h.index,hp:h.hp}))},
          accept: {teamInfo: sparse.accept.teamInfo.map(h => ({heroId:h.heroId,hp:h.hp}))},
        } : null };
        ledger.set(id, marker);
      } catch (error) {
        if (error?.status === 'stopped' && phase === '发送灯神挑战') {
          // The session refused this command BEFORE enqueueing it.
          ledger.clear(id); result.attempted--; throw error;
        }
        const reason = genieError(error, phase);
        await onUncertain();
        try {
          const recovered = await readRole('请求异常后的角色核对');
          const q = readDailyQuota(recovered, now());
          result.used = q.used; result.cleared = progressFrom(recovered, config.genieId, result.cleared);
          if (reason.status === 'protocol' && q.remaining === 0) {
            ledger.clear(id);
            return { ...result, status: 'quota', message: '服务器拒绝挑战，回读确认今日10次额度已用完；已停止' };
          }
          result.reconciliation = before.probe || q.used > before.used ? '次数表明请求可能已被接受' : '次数未增加仍不能确认请求未被接受';
        } catch (e) { result.reconciliation = genieError(e, '核对状态').message; }
        throw issue(`${reason.message}；${result.reconciliation}；未重发`, reason.status);
      }
      const afterRole = await readRole('战后读取角色');
      const after = readDailyQuota(afterRole, now());
      result.used = after.used;
      phase = '核对胜负与共享次数';
      const settled = settleGenieBattle(battle, role, afterRole, before, after, config.genieId, preview.battleTeam);
      if (settled.isWin) result.wins++; else result.losses++;
      result.cleared = settled.cleared;
      ledger.clear(id);
      onBattle({ ...result, ...settled, limit: preview.limit, nation: GENIE_TEAMS[config.genieId].name });
      role = afterRole;
      if (config.stopOnLoss && !settled.isWin) break;
      if (result.attempted < preview.limit && after.remaining) await pause();
    }
    checkStop();
    return { ...result, status: 'completed', message: `完成：挑战${result.attempted}次，胜${result.wins}败${result.losses}，通关至第${result.cleared ?? '待核验'}关，今日已用${result.used}/10` };
  } catch (error) {
    if (stopped() && result.attempted === 0) return { ...result, status: 'stopped', message: '用户主动停止' };
    const safe = genieError(error, phase);
    return { ...result, status: safe.status, message: safe.message };
  }
}

// One account, one shared quota and pending ledger across all four nations.
export async function runGeniePlanAccount(options) {
  const plan = normalizeGeniePlan(options.config);
  const summary = { status: 'completed', attempted: 0, wins: 0, losses: 0, used: null, nations: [] };
  let day, minimumUsed = null, checkedHeroes = false;
  const clock = options.now || (() => Date.now());
  const send = async (cmd, body) => {
    const response = await options.send(cmd, body);
    if (cmd === 'role_getroleinfo') {
      const role = roleFrom(response);
      const quota = readDailyQuota(role, clock(), plan.allowInitialProbe && summary.attempted === 0);
      if (day && (quota.day !== day || quota.probe || quota.used < minimumUsed))
        throw issue('四国任务期间日期变化或共享次数回退，停止核验');
      // Check every selected nation's heroes before spending the first attempt.
      if (!checkedHeroes && quota.remaining !== 0) {
        for (const [id, count] of Object.entries(plan.attemptsByNation)) if (count) challengeTeam(id, 0, role.heroes);
        checkedHeroes = true;
      }
    }
    return response;
  };
  let technology;
  try {
    if (!options.previewOnly && options.technologyLedger) {
      technology = createTechnologySession({ ...options, ledger: options.technologyLedger, log: options.onTechnology });
      if (await technology.recover()) return { ...summary, status:'reconciled', message:'已恢复上次待处理科技至战士；请再次点击开始' };
      if (!plan.useTechnology) technology = null;
    } else if (plan.useTechnology && !options.previewOnly) throw issue('科技恢复存储不可用');
    let prepared=false;
  for (const [id, count] of Object.entries(plan.attemptsByNation)) {
    if (!count) continue;
    if (options.stopped?.()) { summary.status = 'stopped'; summary.reason = '用户主动停止'; break; }
    const genieId = Number(id), nation = GENIE_TEAMS[id].name;
    const result = await runGenieAccount({ ...options, send,
      config: { genieId, attempts: count, stopOnLoss: plan.stopOnLoss, allowInitialProbe: plan.allowInitialProbe && summary.attempted === 0 },
      beforeFight: async () => {
        if (!technology) return;
        if (!prepared) { await technology.prepare(plan.upgradeEmptyTechnology); prepared=true; }
        await technology.beforeNation(genieId);
      },
      onPreview: preview => { options.onPreview?.({ ...preview, genieId, nation }); },
      onBattle: battle => options.onBattle?.({ ...battle, totalAttempted: summary.attempted + battle.attempted, totalLimit: plan.total }),
    });
    summary.attempted += result.attempted; summary.wins += result.wins; summary.losses += result.losses;
    summary.used = result.used; summary.preview = result.preview ? { ...result.preview, genieId, nation } : summary.preview;
    summary.nations.push({ genieId, nation, requested: count, ...result });
    if (!['completed', 'ready'].includes(result.status)) { summary.status = result.status; summary.reason = result.message; break; }
    if (!options.previewOnly) {
      day = result.preview.day; minimumUsed = result.used;
      if (plan.stopOnLoss && result.losses) { summary.reason = '失败即停止已开启，后续国家未执行'; break; }
      if (result.used >= 10) { summary.reason = '今日共享额度已用完，后续挑战停止'; break; }
    }
  }
  } catch (error) {
    summary.status=error.status || 'unverified'; summary.reason=genieError(error,'科技处理').message;
  } finally {
    if (technology) {
      try { await technology.finish(); }
      catch (error) { summary.status='unverified'; summary.reason=`${summary.reason || ''}；科技待恢复：${genieError(error,'恢复战士').message}。保持账号可连接，下次开始优先恢复`; }
    }
  }
  if (options.previewOnly && summary.status === 'completed') summary.status = 'ready';
  const detail = summary.nations.map(n => `${n.nation}${n.attempted}/${n.requested}次，胜${n.wins}败${n.losses}，通关至${n.cleared ?? '待核验'}关`).join('；');
  summary.message = `${detail || '未发送挑战'}；合计${summary.attempted}/${plan.total}次，今日已用${summary.used ?? '未知'}/10${summary.reason ? `；${summary.reason}` : ''}`;
  return summary;
}

export function createTasksGenieChallenge(deps) {
  let active = false, cancelled = false;
  const stopGenieChallenge = () => { cancelled = true; };
  const stopped = () => cancelled || deps.shouldStop.value;
  const log = (name, message, type = 'info') => deps.addLog({ time: new Date().toLocaleTimeString(), type, message: `[灯神挑战][${name}] ${message}` });
  const execute = async (input, previewOnly) => {
    if (active || deps.isBusy() || !deps.selectedTokens.value.length) return [];
    let config;
    try { config = normalizeGeniePlan(input); } catch (e) { deps.message.error(e.message); return []; }
    active = true; cancelled = false; deps.shouldStop.value = false; deps.isRunning.value = true;
    const ids = [...new Set(deps.selectedTokens.value)], results = [];
    deps.rows.value = [];
    let lease;
    try {
      lease = await deps.acquireLease();
      for (const id of ids) {
        const name = deps.tokens.value.find(t => t.id === id)?.name || String(id);
        if (stopped()) { const row = { id, name, status: 'stopped', message: '用户主动停止' }; results.push(row); deps.rows.value.push(row); continue; }
        deps.tokenStatus.value[id] = 'running';
        let connected = false, lastSend = 0, submitted = false;
        const open = async () => {
          if (!connected) { await deps.openReadOnly(id, () => !submitted && stopped()); connected = true; lastSend = Date.now(); }
        };
        try {
          if (stopped()) throw issue('用户主动停止', 'stopped');
          await open();
          const result = await runGeniePlanAccount({ id, config, previewOnly, ledger: deps.ledger, technologyLedger: deps.technologyLedger,
            onTechnology: text => log(name, text),
            stopped, send: async (cmd, body) => {
              await open();
              // Also space reads from tokenStore's automatic initial role query.
              const wait = Math.max(0, 1000 - (Date.now() - lastSend));
              if (wait) await new Promise(resolve => setTimeout(resolve, wait));
              if (cmd === 'fight_startgenie' && stopped()) throw issue('用户主动停止', 'stopped');
              lastSend = Date.now();
              if (['fight_startgenie','legion_exchangeresearch','legion_research','legion_resetresearch'].includes(cmd)) submitted = true;
              return deps.tokenStore.sendMessageWithPromise(id, cmd, body, 10000);
            },
            onUncertain: async () => { await deps.closeReadOnly(id); connected = false; },
            onPreview: preview => { deps.rows.value = [...deps.rows.value.filter(r => r.id !== id), { id, name, status: previewOnly ? 'ready' : 'running', preview, message: previewOnly ? '读取完成' : `${preview.nation}挑战中` }]; },
            onBattle: b => log(name, `${b.nation} ${b.attempted}/${b.limit}（总${b.totalAttempted}/${b.totalLimit}）：第${b.stage}关 ${b.isWin ? '胜利' : '失败'}；当日已用${b.used}/10`),
            pause: async () => { const end = Date.now() + Math.max(1000, Number(deps.batchSettings.battleDelay) || 1000); while (!stopped() && Date.now() < end) await new Promise(r => setTimeout(r, 100)); },
          });
          const row = { id, name, ...result };
          deps.rows.value = [...deps.rows.value.filter(r => r.id !== id), row]; results.push(row);
          deps.tokenStatus.value[id] = ['completed', 'ready', 'quota', 'reconciled'].includes(result.status) ? 'completed' : 'failed';
          log(name, result.message, ['completed', 'ready', 'quota', 'reconciled'].includes(result.status) ? 'info' : 'warning');
        } catch (error) {
          const row = { id, name, status: stopped() ? 'stopped' : 'unverified', message: stopped() ? '用户主动停止' : `${genieError(error, '建立只读连接').message}；未发送挑战` };
          deps.rows.value.push(row); results.push(row); log(name, row.message, 'warning');
        } finally { await deps.closeReadOnly(id); }
      }
    } finally {
      try { await deps.releaseLease(lease); }
      finally { deps.isRunning.value = false; active = false; }
    }
    return results;
  };
  return { previewGenieChallenge: c => execute(c, true), batchGenieChallenge: c => execute(c, false), stopGenieChallenge };
}
