import { XyzwLegionWarWebSocketClient } from '../xyzwLegionWarWebSocket.js';
import { mergeBattlefield, pick } from './model.js';
import { saltDebug, summarizeSaltResponse } from './debug.js';
import { battlefieldEvidence } from './diagnostics.js';

// SALT_ONCE_DIAGNOSTICS_V4

const COMMANDS = ['war_enterbattlefield', 'war_getbattlefieldinfo', 'war_teamsetbattleteam',
  'war_setbattleteam', 'war_startmarch', 'war_startattackbuilding'];

// Isolate stricter transaction behavior to the new task. The existing map page
// and general game WebSocket retain their existing behavior.
export class SaltOnceClient extends XyzwLegionWarWebSocketClient {
  constructor(options) {
    super(options);
    this.diagnostic = options.diagnostic;
    for (const cmd of COMMANDS) this.registry.register(cmd);
    this.closed = false;
    this.heartbeatStart = null;
  }
  trace(event, detail) { saltDebug(event, detail); this.diagnostic?.record(event, detail); }
  send(cmd, params = {}, options = {}) {
    if (this.closed || !this.connected) throw new Error('盐场连接已断开');
    return super.send(cmd, params, options);
  }
  reconnect() { /* Reconnect only through a fresh entry + new session. Never replay queues. */ }
  sendWithPromise(cmd, params = {}, timeoutMs = 10000) {
    if (this.closed || !this.connected) return Promise.reject(new Error('盐场连接已断开'));
    const seq = ++this.seq;
    this.diagnostic?.record('transport.request', { cmd, seq, body: params, timeoutMs });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete this.promises[seq];
        this.sendQueue = this.sendQueue.filter(item => item.seq !== seq);
        this.diagnostic?.record('transport.timeout', { cmd, seq, timeoutMs });
        reject(new Error(`盐场请求超时：${cmd}`));
      }, timeoutMs);
      this.promises[seq] = { resolve, reject, timer, originalCmd: cmd };
      try { this.send(cmd, params, { seq }); }
      catch (error) { clearTimeout(timer); delete this.promises[seq]; reject(error); }
    });
  }
  _handlePromiseResponse(packet) {
    const raw = packet._raw || packet;
    const cmd = String(packet.cmd || raw.cmd || '').toLowerCase();
    const resp = packet.resp ?? raw.resp;
    let id = resp;
    if (resp != null && Number(resp) !== 0) {
      if (!this.promises[id]) {
        this.trace('response.unmatched', {
          cmd, resp, code: packet.code ?? raw.code ?? null,
          pending: Object.entries(this.promises).map(([seq, item]) => ({ seq, command: item.originalCmd })),
        });
        return; // Never match a late response to a new request.
      }
    } else {
      const matches = Object.entries(this.promises).filter(([, p]) => cmd === `${p.originalCmd}resp`);
      if (matches.length !== 1) {
        this.trace('response.without-unique-command-match', {
          cmd, resp, code: packet.code ?? raw.code ?? null,
          pending: Object.entries(this.promises).map(([seq, item]) => ({ seq, command: item.originalCmd })),
        });
        return;
      }
      id = matches[0][0];
    }
    const pending = this.promises[id];
    if (!pending) return;
    if (cmd && cmd !== pending.originalCmd && cmd !== `${pending.originalCmd}resp` && !Number(raw.code)) {
      this.trace('response.command-mismatch', {
        requested: pending.originalCmd, received: cmd, resp, code: packet.code ?? raw.code ?? null,
      });
      return;
    }
    delete this.promises[id];
    clearTimeout(pending.timer);
    const code = Number(packet.code ?? raw.code ?? 0);
    const diagnosticBody = packet.rawData ?? packet.decodedBody ?? raw.decodedBody ?? packet.body ?? raw.body;
    this.diagnostic?.record('transport.response.matched', { command: pending.originalCmd, requestSeq: Number(id),
      cmd, seq: packet.seq ?? raw.seq, resp, code,
      body: pick(diagnosticBody, 'battlefield') ? '[战场内容见battlefield.packet]' : diagnosticBody });
    const responseDetails = summarizeSaltResponse(packet, raw);
    if (!Number.isFinite(code) || code !== 0) {
      const error = new Error(`盐场服务器错误 ${code}（${pending.originalCmd}）`);
      error.serverRejected = Number.isFinite(code) && code !== 0;
      error.code = code;
      error.serverResponse = responseDetails;
      this.trace('response.rejected', { command: pending.originalCmd, response: responseDetails });
      pending.reject(error);
    } else {
      this.trace('response.accepted', { command: pending.originalCmd, response: responseDetails });
      pending.resolve(packet.rawData ?? packet.decodedBody ?? raw.decodedBody ?? packet.body ?? raw.body ?? {});
    }
  }
  _setupHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (!this.closed && this.connected) this.sendHeartbeat();
    }, this.heartbeatInterval);
  }
  _clearTimers() {
    super._clearTimers();
    clearTimeout(this.heartbeatStart);
    this.sendQueue = [];
    for (const [id, pending] of Object.entries(this.promises)) {
      this.diagnostic?.record('transport.closed.pending', { seq: Number(id), cmd: pending.originalCmd });
      clearTimeout(pending.timer);
      delete this.promises[id];
      pending.reject(new Error('盐场连接已断开；请求结果可能不明'));
    }
  }
  disconnect() {
    this.closed = true;
    this.messageListener = null;
    super.disconnect();
  }
}

export async function openSaltSession({ token, info, signal, Client = SaltOnceClient, diagnostic = null }) {
  const trace = (event, detail) => { saltDebug(event, detail); diagnostic?.record(event, detail); };
  if (signal.aborted) throw new Error('任务已停止');
  const url = 'wss://xxz-xyzw-new.hortorgames.com/agent'
    + `?p=${encodeURIComponent(token)}&e=x&sid2=${encodeURIComponent(info.sid)}&lang=chinese&sid2=${encodeURIComponent(info.sid)}`;
  const ws = new Client({ url, hint: info.battlefieldId, heartbeatMs: 5000, diagnostic });
  let snapshot = { roles: {}, buildingData: {}, marches: {} }, roleCodeId;
  let revision = 0;
  let lastMapEvidence = null;
  const merge = (data, source = 'push-or-response') => {
    const bf = pick(data, 'battlefield');
    if (diagnostic) try {
      const incomingRole = roleCodeId ?? pick(data, 'roleCodeId');
      const raw = data?._raw || data;
      const evidence = battlefieldEvidence(bf, incomingRole);
      // Keep every packet header and role state; avoid duplicating identical maps.
      if (evidence?.buildingData) {
        const signature = JSON.stringify(evidence.buildingData);
        if (signature === lastMapEvidence) evidence.buildingData = { $unchangedFromPreviousMap: true };
        else lastMapEvidence = signature;
      }
      diagnostic.record('battlefield.packet', { source, roleCodeId: incomingRole,
        cmd: data?.cmd ?? raw?.cmd, seq: data?.seq ?? raw?.seq, resp: data?.resp ?? raw?.resp,
        code: data?.code ?? raw?.code, revisionBefore: revision, battlefield: evidence,
        bodyKeys: data && typeof data === 'object' ? Object.keys(data) : [],
      });
    } catch { diagnostic.record('diagnostic.packet.failed', { source, revisionBefore: revision }); }
    if (bf) { mergeBattlefield(snapshot, bf); revision++; }
  };
  ws.setMessageListener(data => merge(data, 'socket'));
  const abort = () => ws.disconnect();
  signal.addEventListener('abort', abort, { once: true });
  const close = () => { signal.removeEventListener('abort', abort); ws.disconnect(); };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('盐场连接超时')), 10000);
      const onAbort = () => finish(new Error('任务已停止'));
      function finish(error) {
        clearTimeout(timer); signal.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve();
      }
      signal.addEventListener('abort', onAbort, { once: true });
      ws.onConnect = () => {
        trace('websocket.connected', { battlefieldId: info.battlefieldId });
        finish();
      };
      ws.onError = error => {
        trace('websocket.error', {
          battlefieldId: info.battlefieldId,
          message: error?.message || 'WebSocket error',
        });
        finish(new Error('盐场连接失败'));
      };
      ws.onDisconnect = event => {
        trace('websocket.closed', {
          battlefieldId: info.battlefieldId,
          code: event?.code ?? null,
          reason: event?.reason ?? '',
        });
        finish(new Error('盐场连接关闭'));
      };
      ws.init();
    });
    const send = async (cmd, body = {}) => {
      if (signal.aborted) throw new Error('任务已停止');
      const requestBody = { battlefieldId: info.battlefieldId, ...body };
      trace('command.request', { cmd, body: requestBody, roleCodeId: roleCodeId ?? null });
      try {
        const result = await ws.sendWithPromise(cmd, requestBody, 10000);
        merge(result, 'resolved-body');
        if (!pick(result, 'battlefield')) diagnostic?.record('command.result.body', { cmd, body: result });
        trace('command.resolved', {
          cmd,
          roleCodeId: roleCodeId ?? pick(result, 'roleCodeId') ?? null,
          response: summarizeSaltResponse({ cmd: `${cmd}resp`, rawData: result }),
          dynamicBuildingCount: Object.keys(snapshot.buildingData).length,
          roleCount: Object.keys(snapshot.roles).length,
        });
        return result;
      } catch (error) {
        trace('command.failed', {
          cmd,
          message: error?.message || String(error),
          code: error?.code ?? null,
          serverRejected: Boolean(error?.serverRejected),
          serverResponse: error?.serverResponse ?? null,
        });
        throw error;
      }
    };
    const entered = await send('war_enterbattlefield', { useGzip: true });
    roleCodeId = pick(entered, 'roleCodeId');
    if (roleCodeId == null || !String(roleCodeId)) throw new Error('进场响应缺少 roleCodeId');
    trace('session.entered', {
      battlefieldId: info.battlefieldId,
      roleCodeId: String(roleCodeId),
      mapIdentity: { confId: snapshot.confId, legionWarMap: snapshot.legionWarMap,
        mapName: snapshot.mapName, type: snapshot.type, subType: snapshot.subType },
      role: snapshot.roles[String(roleCodeId)] ? {
        state: snapshot.roles[String(roleCodeId)].state,
        position: snapshot.roles[String(roleCodeId)].position,
        legionID: snapshot.roles[String(roleCodeId)].legionID,
        aB: snapshot.roles[String(roleCodeId)].aB,
        d: snapshot.roles[String(roleCodeId)].d,
      } : null,
      dynamicBuildingCount: Object.keys(snapshot.buildingData).length,
      roleCount: Object.keys(snapshot.roles).length,
    });
    const refresh = async () => {
      const result = await send('war_getbattlefieldinfo');
      const bf = pick(result, 'battlefield');
      // A refresh must contain this role explicitly; stale cached state cannot
      // prove arrival or settlement. If the protocol only returns deltas, stop.
      if (!bf?.roles || !Object.prototype.hasOwnProperty.call(bf.roles, String(roleCodeId))) {
        throw new Error('战场刷新未返回本角色快照，无法核验状态');
      }
      // send() already merged this response. Preserve dynamic tile ownership
      // when a role-only refresh omits buildingData; otherwise static defaults
      // could overwrite a previously known friendly tile. New connections start
      // with a fresh snapshot and explicit null tile updates remain tombstones.
      snapshot.roles[String(roleCodeId)] = bf.roles[String(roleCodeId)] == null
        ? null : { ...bf.roles[String(roleCodeId)] };
      const current = snapshot.roles[String(roleCodeId)];
      trace('battlefield.refresh', {
        battlefieldId: info.battlefieldId,
        roleCodeId: String(roleCodeId),
        mapIdentity: { confId: snapshot.confId, legionWarMap: snapshot.legionWarMap,
          mapName: snapshot.mapName, type: snapshot.type, subType: snapshot.subType },
        role: current ? {
          state: current.state, position: current.position, legionID: current.legionID,
          aB: current.aB, d: current.d, killCnt: current.killCnt,
        } : null,
        dynamicBuildingCount: Object.keys(snapshot.buildingData).length,
        roleCount: Object.keys(snapshot.roles).length,
        revision,
      });
      return current;
    };
    await refresh();
    return { send, refresh, close, roleCodeId: String(roleCodeId), battlefieldId: info.battlefieldId,
      get role() { return snapshot.roles[String(roleCodeId)]; },
      get snapshot() { return snapshot; }, get revision() { return revision; } };
  } catch (error) {
    trace('session.open.failed', {
      battlefieldId: info.battlefieldId,
      message: error?.message || String(error),
      code: error?.code ?? null,
      serverRejected: Boolean(error?.serverRejected),
      serverResponse: error?.serverResponse ?? null,
    });
    close();
    throw error;
  }
}
