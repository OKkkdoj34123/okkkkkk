/** 篝火报名：手动独立任务，按俱乐部/下周赛期核验，结果未知不重发。 */
import { gameDay, gameDateKey, safeError } from '../campReadOnly.js';
const PREFIX = 'xyzw_bonfire_signup_v1:';
const positive = value => Number.isSafeInteger(value) && value > 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = (status, message) => ({ status, message });
const stoppedError = () => Object.assign(new Error('已停止'), { stopped: true });

export function bonfirePeriod(time = Date.now()) {
  const day = gameDay(time);
  if (![5, 6, 0].includes(day)) return null;
  return gameDateKey(time + (day === 0 ? 1 : 8 - day) * 86400000);
}
export function bonfireIdentity(roleData, legionData) {
  const role = roleData?.role, info = legionData?.info;
  if (!positive(role?.roleId) || !positive(role?.legionId) || info?.id !== role.legionId) {
    throw new Error('角色与当前俱乐部信息未匹配，未提交报名');
  }
  const member = info.members?.[String(role.roleId)];
  if (member?.roleId !== role.roleId || !Number.isInteger(member.job)) {
    throw new Error('当前账号的俱乐部职位未确认，未提交报名');
  }
  if (member.job === 1 && info.leaderId !== role.roleId) {
    throw new Error('团长身份字段不一致，未提交报名');
  }
  return { roleId: role.roleId, legionId: info.id, allowed: [1, 2].includes(member.job), job: member.job };
}
function clubState(data, legionId) {
  const club = data?.club;
  // 报名响应可能是 legionId=0 的增量；仅使用独立 getinfo 的完整回包判断。
  if (club?.legionId !== legionId || !/^\d{6}$/.test(String(club.phase ?? ''))) {
    throw new Error('活动所属俱乐部或赛期未确认');
  }
  return String(club.phase);
}
function readRecord(storage, key) {
  if (!storage?.getItem || !storage?.setItem) throw new Error('报名记录存储不可用，未提交报名');
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (!value || !['pending', 'verified', 'rejected'].includes(value.state)) {
    throw new Error('报名记录异常，请核对游戏状态');
  }
  return value;
}

export async function runBonfireSignup({ send, storage, now = Date.now, stopped = () => false,
  onUncertain = async () => {}, seenClubs = new Set() }) {
  const phase = bonfirePeriod(now());
  if (!phase) return result('skipped', '非北京时间周五至周日，跳过');
  const check = () => { if (stopped()) throw stoppedError(); };
  const request = async (cmd, afterWrite = false) => {
    if (!afterWrite) check();
    const response = await send(cmd, {});
    if (response?.code != null && Number(response.code) !== 0) {
      throw Object.assign(new Error(`服务器错误码 ${response.code}`), { code: Number(response.code), requestCmd: cmd });
    }
    return response;
  };
  check();
  const role = await request('role_getroleinfo');
  let legion;
  try { legion = await request('legion_getinfo'); }
  catch (error) {
    if (Number(error?.code) === 2300070) return result('skipped', '未加入俱乐部，跳过');
    throw error;
  }
  const identity = bonfireIdentity(role, legion);
  if (!identity.allowed) return result('skipped', '不是团长或副团长，跳过');
  const key = `${PREFIX}${identity.legionId}:${phase}`;
  if (seenClubs.has(key)) return result('skipped', '本批次已处理同一俱乐部，跳过');
  seenClubs.add(key);
  const state = clubState(await request('club_getinfo'), identity.legionId);
  if (state === phase) {
    // 已报名即使没有本地记录也跳过；无需人数查询或再次提交。
    if (storage?.getItem(key)) storage.setItem(key, JSON.stringify({ state: 'verified', time: now() }));
    return result('skipped', `本期 ${phase} 已报名，跳过`);
  }
  if (state > phase) throw new Error('服务器赛期晚于预期，请核对设备时间，未提交报名');
  const prior = readRecord(storage, key);
  if (prior && prior.state !== 'rejected') {
    return result('unverified', '本期存在报名记录，但服务端尚未核实；未重复提交，请在游戏内核对');
  }
  const count = (await request('club_getsignupcnt'))?.cnt;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('俱乐部人数响应异常，未提交报名');
  check();
  if (bonfirePeriod(now()) !== phase) return result('skipped', '报名时间或赛期已变化，未提交');
  storage.setItem(key, JSON.stringify({ state: 'pending', time: now() }));
  let writeError;
  try { await request('club_signup'); }
  catch (error) {
    if (error.stopped) {
      storage.removeItem(key);
      throw error;
    }
    writeError = error;
    if (Number.isInteger(error.code) && error.code !== 0 && (!error.requestCmd || error.requestCmd === 'club_signup')) {
      storage.setItem(key, JSON.stringify({ state: 'rejected', time: now(), code: error.code }));
      return result('failed', `报名被服务器拒绝（${error.code}），未重试`);
    }
    // 丢弃未发送队列并关闭旧连接，再建立只读连接回查，不能让超时队列迟到发送。
    try { await onUncertain(); }
    catch { return result('unverified', '请求异常且连接清理失败，已保留报名记录；请刷新页面并在游戏内核对'); }
  }
  try {
    const after = clubState(await request('club_getinfo', true), identity.legionId);
    if (after === phase) {
      storage.setItem(key, JSON.stringify({ state: 'verified', time: now() }));
      return result('completed', `报名成功，已核验赛期 ${phase}；俱乐部人数 ${count}${writeError ? '（请求异常后回读确认）' : ''}`);
    }
  } catch { /* pending retained until future readback verifies */ }
  return result('unverified', '报名结果待确认，已保留记录；未重复提交，请在游戏内核对');
}

export function createTasksBonfire(d) {
  let active = false;
  return {
    async batchBonfireSignup() {
      if (active || d.isBusy() || !d.selectedTokens.value.length) return [];
      active = true; d.shouldStop.value = false; d.isRunning.value = true;
      const results = [], seenClubs = new Set(); let lease;
      const log = (name, text, type = 'info') => d.addLog({ time: new Date().toLocaleTimeString(), type,
        message: `[篝火报名][${name}] ${text}` });
      try {
        lease = await d.acquireLease();
        for (const id of [...new Set(d.selectedTokens.value)]) {
          if (d.shouldStop.value) {
            d.tokenStatus.value[id] = "stopped";
            results.push({ tokenId: id, status: "stopped", details: ["用户主动停止，未执行"] });
            continue;
          }
          const name = d.tokens.value.find(t => t.id === id)?.name || String(id);
          let connected = false, submitted = false, row;
          const open = async () => {
            if (!connected) { await d.openReadOnly(id, () => !submitted && d.shouldStop.value); connected = true; }
          };
          d.tokenStatus.value[id] = 'running';
          if (d.currentRunningTokenId) d.currentRunningTokenId.value = id;
          try {
            row = await runBonfireSignup({ storage: d.storage, now: d.now || Date.now,
              stopped: () => d.shouldStop.value, seenClubs,
              onUncertain: async () => { await d.closeReadOnly(id); connected = false; },
              send: async (cmd, body) => {
                await open();
                await (d.sleep || pause)(Math.max(300, Number(d.delayConfig?.command) || 500));
                if (!submitted && d.shouldStop.value) throw stoppedError();
                if (cmd === 'club_signup') {
                  if (!bonfirePeriod((d.now || Date.now)())) throw stoppedError();
                  submitted = true;
                }
                return d.tokenStore.sendMessageWithPromise(id, cmd, body, 10000);
              } });
          } catch (error) {
            row = result(error.stopped || d.shouldStop.value ? 'stopped' : 'failed', safeError(error));
          } finally {
            if (connected) {
              try { await d.closeReadOnly(id); }
              catch { log(name, '连接清理失败，请刷新页面后核对', 'warning'); }
            }
          }
          d.tokenStatus.value[id] = row.status === 'unverified' ? 'failed' : row.status;
          const reportStatus = row.status === 'unverified' ? 'warning' : row.status;
          const detail = row.message || '篝火报名已返回，缺少结果说明';
          results.push({ tokenId: id, status: reportStatus, details: [detail],
            warnings: ['warning', 'failed'].includes(reportStatus) ? [detail] : [],
            verificationRequired: row.status === 'unverified', verificationDetails: row.status === 'unverified' ? [detail] : [] });
          log(name, row.message, ['completed', 'skipped'].includes(row.status) ? 'info' : 'warning');
        }
      } finally {
        try { await d.releaseLease(lease); }
        finally {
          active = false; d.isRunning.value = false;
          if (d.currentRunningTokenId) d.currentRunningTokenId.value = null;
        }
      }
      return results;
    },
  };
}
