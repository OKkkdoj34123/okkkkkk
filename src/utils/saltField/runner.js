import { MIN_MARCH_MS, MAX_ATTEMPTS, TEAM, arrived, counters, nearestTarget,
  settlementEvidence, targetLegal, navigationMap, navigationEvidence, NAVIGATION_VERSION, canRecoverLegacyTargetFailure } from './model.js';
import { saltDebug } from './debug.js';
import { battlefieldEvidence, explainSaltNavigation } from './diagnostics.js';

// SALT_ONCE_DIAGNOSTICS_V4

export const abortError = () => Object.assign(new Error('任务已停止'), { stopped: true });
export function wait(ms, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, Math.max(0, ms));
    signal.addEventListener('abort', stop, { once: true });
  });
}
export class SaltOnceRunner {
  constructor({ tokenId, records, connect, signal, onUpdate = () => {}, now = Date.now, sleep = wait, diagnostic = null,
    targetAssignments = new Map() }) {
    Object.assign(this, { tokenId, records, connect, signal, onUpdate, now, sleep, diagnostic, targetAssignments });
    this.record = null;
    this.entryFailures = 0;
  }
  debug(event, detail) { saltDebug(event, detail); this.diagnostic?.record(event, detail); }
  assignmentKey(session) { return JSON.stringify([String(session.battlefieldId), String(session.roleCodeId)]); }
  rememberAssignment(session) {
    const key = this.assignmentKey(session), record = this.record;
    if (record?.target?.buildingId && (record.marchIntentAt || record.marchAccepted || record.attackIntentAt)) {
      this.targetAssignments.set(key, { battlefieldId: String(session.battlefieldId),
        legionId: Number(session.role?.legionID), buildingId: record.target.buildingId });
    } else this.targetAssignments.delete(key);
  }
  rankCandidates(candidates, session) {
    const ownKey = this.assignmentKey(session), counts = new Map();
    for (const [key, assignment] of this.targetAssignments) {
      if (key === ownKey || assignment.battlefieldId !== String(session.battlefieldId)
        || assignment.legionId !== Number(session.role?.legionID)) continue;
      counts.set(assignment.buildingId, (counts.get(assignment.buildingId) || 0) + 1);
    }
    // Soft balancing within equal-distance/equal-ownership candidates. Counts
    // are this batch's intents, not server troop counts or an exclusive lock.
    return candidates.map(candidate => ({ ...candidate, assignedCount: counts.get(candidate.buildingId) || 0 }))
      .sort((a, b) => a.distance - b.distance
        || Number(b.belongsLegionId === -1) - Number(a.belongsLegionId === -1)
        || a.assignedCount - b.assignedCount || a.x - b.x || a.y - b.y);
  }
  check() { if (this.signal.aborted) throw abortError(); }
  save(changes) {
    Object.assign(this.record, changes, { updatedAt: this.now() });
    this.records.save(this.record);
    this.onUpdate({ ...this.record });
    this.diagnostic?.record('record.updated', { phase: this.activePhase, record: this.record });
  }
  async open() {
    this.check();
    const session = await this.connect(this.tokenId, this.signal);
    try {
      this.check();
      if (this.record && (String(this.record.battlefieldId) !== String(session.battlefieldId)
        || this.record.roleCodeId !== session.roleCodeId)) throw new Error('战场或角色身份已变化，停止本次任务');
      {
        // Re-read on every reconnect: an alias of this account earlier in the batch
        // may already have completed, making this runner's in-memory record stale.
        this.record = this.records.get(session.battlefieldId, session.roleCodeId) || this.record || {
          tokenId: this.tokenId, battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
          state: 'pending', attempts: 1 + this.entryFailures, excluded: [], createdAt: this.now(), navigationVersion: NAVIGATION_VERSION,
        };
        // Persistent role-based key also prevents the same account imported under a different token ID from attacking again.
        this.diagnostic?.record('record.loaded', { record: this.record });
        this.record.tokenId = this.tokenId;
        if (canRecoverLegacyTargetFailure(this.record, session.role)) {
          // One-time recovery of the pre-march v1/v3 defect, after a fresh server
          // read proves the same role is idle. Preserve the old failure history.
          this.save({ legacyFailure: { attempts: this.record.attempts, error: this.record.error,
            navigationVersion: this.record.navigationVersion, recoveredAt: this.now() },
            targetingRecoveryVersion: NAVIGATION_VERSION, navigationVersion: NAVIGATION_VERSION,
            state: 'pending', attempts: 1, error: null });
        } else this.save({});
      }
      this.rememberAssignment(session);
      return session;
    } catch (error) { session.close(); throw error; }
  }
  async fresh(session) { this.check(); return session.refresh(); }
  async until(session, predicate, duration, event = null) {
    const end = this.now() + duration;
    let last = '', loggedAt = -Infinity;
    do {
      const role = await this.fresh(session);
      const ready = predicate(role);
      if (event) {
        const observed = { state: role?.state, position: role?.position, ...counters(role) };
        const key = JSON.stringify(observed);
        if (ready || key !== last || this.now() - loggedAt >= 10000) {
          this.debug(event, { target: this.record.target, observedRole: observed, ready,
            elapsedSinceMarchMs: this.now() - (this.record.marchStartedAt || this.now()) });
          last = key; loggedAt = this.now();
        }
      }
      if (ready) return role;
      await this.sleep(1500, this.signal);
    } while (this.now() < end);
    if (event) this.debug(`${event}.timeout`, { target: this.record.target, duration });
    throw new Error(event ? '等待行军到达超时；尚未确认目标坐标，未发送攻击' : '等待服务器角色状态超时');
  }
  async prepare(session) {
    let role = await this.fresh(session);
    this.debug('runner.prepare.snapshot', {
      battlefieldId: session.battlefieldId,
      roleCodeId: session.roleCodeId,
      role: role ? {
        state: role.state, position: role.position, legionID: role.legionID,
        aB: role.aB, d: role.d, killCnt: role.killCnt,
      } : null,
      teamSelected: Boolean(this.record.teamSelected),
      teamApplied: Boolean(this.record.teamApplied),
      teamReady: Boolean(this.record.teamReady),
      excluded: this.record.excluded,
      dynamicBuildingCount: Object.keys(session.snapshot?.buildingData || {}).length,
    });
    if (this.record.state === 'completed' || this.record.attackIntentAt) return;
    if (this.record.marchIntentAt) {
      // Intent may have reached the server even if the response was lost.
      if (arrived(role, this.record.target) || role?.state === 'march') {
        this.save({ state: 'marching', marchStartedAt: this.record.marchStartedAt || this.now(), marchAccepted: true });
        this.debug('march.reconciled', { target: this.record.target, role: { state: role.state, position: role.position },
          confirmation: arrived(role, this.record.target) ? 'arrived-at-target' : 'role-is-marching-await-target-arrival' });
        return;
      }
      throw Object.assign(new Error('此前行军提交结果不明；没有可证明未执行的证据，停止重发'), { uncertain: true });
    }
    if (!this.record.teamReady) {
      if (this.record.teamIntentAt) {
        if (!this.record.teamApplied) throw Object.assign(new Error('布阵响应不明，停止重复部署；请在游戏内核对'), { uncertain: true });
      } else {
        if (!role || !['watching', 'idle'].includes(role.state)) throw new Error('角色不处于可部署状态');
        this.save({ state: 'preparing', teamIntentAt: this.now() });
        this.check();
        try {
          // If step one was explicitly confirmed before, retry only the unfinished step.
          if (!this.record.teamSelected) {
            await session.send('war_teamsetbattleteam', { battleTeam: TEAM });
            this.save({ teamSelected: true });
            this.check();
            // Match the reference salt runner's settle delay between the two team commands.
            await this.sleep(800, this.signal);
          } else {
            this.debug('team.select.skipped', {
              battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
              reason: 'teamSelected was already confirmed; retrying only war_setbattleteam',
            });
          }
          if (!this.record.teamApplied) {
            await session.send('war_setbattleteam', { battleTeam: TEAM });
            this.save({ teamApplied: true });
          }
        } catch (error) {
          this.debug('team.command.failed', {
            battlefieldId: session.battlefieldId,
            roleCodeId: session.roleCodeId,
            command: this.record.teamSelected && !this.record.teamApplied
              ? 'war_setbattleteam' : 'war_teamsetbattleteam',
            code: error?.code ?? null,
            serverRejected: Boolean(error?.serverRejected),
            message: error?.message || String(error),
            serverResponse: error?.serverResponse ?? null,
          });
          // Explicit rejection is retryable; ambiguity is read back before another mutation.
          if (error.serverRejected) this.save({ teamIntentAt: null });
          throw error;
        }
      }
      role = await this.until(session, r => r?.state === 'idle' && r.position, 15000);
      this.save({ teamReady: true });
      this.debug('team.ready', {
        battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
        role: { state: role.state, position: role.position, legionID: role.legionID },
      });
    }
    if (role?.state !== 'idle') throw new Error('角色尚未空闲，未提交行军');
    // Reaching this branch proves there is no unresolved march/attack intent.
    // Clear display-only leftovers before a new selection, preserving history.
    this.save({ state: 'targeting', target: null, candidateQueue: [], error: null });
    this.rememberAssignment(session);
    const excludedBefore = [...this.record.excluded];
    const analysis = explainSaltNavigation(role, session.snapshot.buildingData, excludedBefore, session.snapshot);
    if (analysis.candidates) analysis.candidates = this.rankCandidates(analysis.candidates, session);
    this.debug('navigation.origin', analysis.origin || { error: analysis.error });
    this.diagnostic?.record('navigation.snapshot', {
      battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
      battlefield: battlefieldEvidence(session.snapshot, session.roleCodeId),
      excluded: excludedBefore,
      analysis,
    });
    let evidence;
    let target;
    try {
      evidence = navigationEvidence(role, session.snapshot.buildingData, session.snapshot, excludedBefore);
      this.debug('navigation.evidence', { ...evidence,
        battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId });
      this.save({ candidateQueue: analysis.candidates || [], navigationVersion: NAVIGATION_VERSION });
      this.debug('navigation.candidates', { mapId: session.snapshot.legionWarMap,
        start: role.position, staticRoadsEnabled: analysis.staticRoadsEnabled,
        allocationScope: 'same-batch-battlefield-legion',
        candidates: analysis.candidates || [], excluded: excludedBefore,
        attemptsRemaining: MAX_ATTEMPTS - this.record.attempts + 1,
        note: '只依次提交候选；服务器接受后停止换点；超时先回查' });
      target = analysis.candidates?.[0]
        || nearestTarget(role, session.snapshot.buildingData, this.record.excluded, session.snapshot);
      const map = navigationMap(role, session.snapshot.buildingData, session.snapshot);
      const tile = map[target.buildingId];
      this.debug('navigation.target.selected', {
        battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
        role: { state: role.state, position: role.position, legionID: role.legionID },
        target,
        targetTile: tile ? {
          id: tile.id, type: tile.type, belongsLegionId: tile.belongsLegionId, source: tile.source,
        } : null,
        excluded: excludedBefore,
        dynamicBuildingCount: Object.keys(session.snapshot.buildingData || {}).length,
        mergedMapCount: Object.keys(map).length,
      });
    } catch (error) {
      if (error.code === 'SALT_NO_TARGET') {
        const rejected = (this.record.marchRejections || []).map(item => `${item.target.buildingId}(错误码${item.code ?? '?'})`);
        if (rejected.length) error.message += `；此前已拒绝：${rejected.join('、')}`;
        this.save({ target: null, navigationDiagnostic: evidence ?? null });
      }
      this.debug('navigation.target.failed', {
        battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
        role: role ? { state: role.state, position: role.position, legionID: role.legionID } : null,
        excluded: excludedBefore,
        dynamicBuildingCount: Object.keys(session.snapshot.buildingData || {}).length,
        message: error?.message || String(error), code: error?.code ?? null,
      });
      throw error;
    }
    this.save({ target, state: 'submitting', marchIntentAt: this.now(), error: null, navigationVersion: NAVIGATION_VERSION });
    this.rememberAssignment(session);
    this.debug('navigation.assignment', { battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
      legionId: role.legionID, target: target.buildingId, assignedBefore: target.assignedCount,
      stage: 'intent-persisted', scope: 'same-batch-battlefield-legion' });
    this.debug('march.intent.saved', {
      battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
      target, marchIntentAt: this.record.marchIntentAt,
    });
    this.check();
    try {
      const response = await session.send('war_startmarch', { target: { x: target.x, y: target.y } });
      this.save({ state: 'marching', marchStartedAt: this.now(), marchAccepted: true });
      this.debug('march.accepted', {
        battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
        target, marchStartedAt: this.record.marchStartedAt,
        responseKeys: Object.keys(response || {}), responseDetail: '见transport.response.matched与battlefield.packet',
      });
    } catch (error) {
      this.debug('march.rejected-or-unknown', {
        battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
        target, code: error?.code ?? null, serverRejected: Boolean(error?.serverRejected),
        message: error?.message || String(error), serverResponse: error?.serverResponse ?? null,
        excludedBefore,
      });
      if (error.serverRejected) this.save({ state: 'targeting', target: null,
        marchIntentAt: null, marchStartedAt: null, marchAccepted: false,
        excluded: [...new Set([...this.record.excluded, target.buildingId])],
        marchRejections: [...(this.record.marchRejections || []), {
          target: { ...target }, code: error.code ?? null, at: this.now(),
          response: error.serverResponse ? {
            cmd: error.serverResponse.cmd, seq: error.serverResponse.seq,
            resp: error.serverResponse.resp, code: error.serverResponse.code,
          } : null,
        }].slice(-MAX_ATTEMPTS) });
      this.rememberAssignment(session); // Explicit rejection releases; unknown intent remains counted.
      throw error;
    }
    // Caller closes immediately after acknowledged march; no arrival waiting here.
  }
  async verifyBattle(session) {
    const end = this.now() + 60000;
    let previousProof = null, observedRole = null;
    do {
      const role = await this.fresh(session);
      observedRole = role ? { state: role.state, ...counters(role) } : null;
      const proof = settlementEvidence(this.record, role);
      this.debug('attack.settlement.check', { target: this.record.target, before: this.record.beforeAttack,
        observedRole, proof, consecutive: Boolean(proof && proof === previousProof) });
      if (proof && proof === previousProof) {
        this.save({ state: 'completed', finishedAt: this.now(), proof, afterAttack: counters(role), observedRole, error: null });
        return;
      }
      previousProof = proof;
      await this.sleep(2000, this.signal);
    } while (this.now() < end);
    this.save({ state: 'unknown', observedRole, error: '未取得个人战斗结算证据；本场禁止再次攻击' });
  }
  async attack(session) {
    if (this.record.state === 'completed') return;
    if (this.record.attackIntentAt) { await this.verifyBattle(session); return; }
    if (!this.record.marchAccepted || !this.record.marchStartedAt) throw new Error('行军未确认');
    const remaining = this.record.marchStartedAt + MIN_MARCH_MS - this.now();
    if (remaining > 0) await this.sleep(remaining, this.signal);
    const role = await this.until(session, r => arrived(r, this.record.target), 60000, 'march.arrival.check');
    const currentTile = navigationMap(role, session.snapshot.buildingData, session.snapshot)[this.record.target.buildingId];
    const isLegalTarget = targetLegal(currentTile, role.legionID);
    this.debug('attack.target.recheck', {
      battlefieldId: session.battlefieldId, roleCodeId: session.roleCodeId,
      role: { state: role.state, position: role.position, legionID: role.legionID },
      target: this.record.target,
      targetTile: currentTile ? {
        id: currentTile.id, type: currentTile.type, belongsLegionId: currentTile.belongsLegionId, source: currentTile.source,
      } : null,
      legal: isLegalTarget,
      dynamicBuildingCount: Object.keys(session.snapshot.buildingData || {}).length,
    });
    if (!isLegalTarget) {
      // Refresh first; safely start a new march on the next bounded attempt.
      this.save({ state: 'targeting', target: null, marchIntentAt: null, marchStartedAt: null, marchAccepted: false,
        excluded: [...this.record.excluded, this.record.target.buildingId] });
      throw new Error('到达后目标已不可攻击，重新选择目标');
    }
    const beforeAttack = counters(role);
    if (beforeAttack.aB == null || beforeAttack.d == null) throw new Error('缺少 aB/d 个人计数，无法确认战斗结算，未发送攻击');
    this.save({ state: 'ready' });
    this.check();
    this.save({ state: 'fighting', beforeAttack, attackIntentAt: this.now() });
    this.debug('attack.intent.saved', { target: this.record.target, beforeAttack,
      role: { state: role.state, position: role.position }, attackIntentAt: this.record.attackIntentAt });
    try {
      this.check();
      const response = await session.send('war_startattackbuilding', { buildingId: this.record.target.buildingId });
      this.save({ attackAcceptedAt: this.now() });
      this.debug('attack.accepted', { target: this.record.target, beforeAttack,
        responseKeys: Object.keys(response || {}), responseDetail: '见transport.response.matched与battlefield.packet' });
    } catch (error) {
      if (error.serverRejected) {
        this.save({ attackIntentAt: null, attackAcceptedAt: null, state: 'ready' });
        throw error;
      }
      // Timeout/disconnect: keep the write-ahead intent and verify, never resend.
      this.save({ state: 'unknown', error: '攻击响应不明，正在核验，禁止重发' });
    }
    await this.verifyBattle(session);
  }
  async phase(name) {
    this.activePhase = name;
    this.diagnostic?.record('phase.start', { phase: name });
    while (true) {
      let session;
      try {
        this.check();
        if (name === 'attack' && this.record?.marchStartedAt && !this.record.attackIntentAt) {
          await this.sleep(this.record.marchStartedAt + MIN_MARCH_MS - this.now(), this.signal);
        }
        session = await this.open();
        if (this.record.state === 'completed') return;
        if (this.record.attempts > MAX_ATTEMPTS || (this.record.state === 'failed' && this.record.attempts >= MAX_ATTEMPTS)) return;
        if (name === 'prepare') await this.prepare(session);
        else {
          if (!this.record.attackIntentAt && !this.record.marchAccepted) await this.prepare(session);
          if (this.record.marchStartedAt + MIN_MARCH_MS > this.now()) {
            session.close(); session = null;
            await this.sleep(this.record.marchStartedAt + MIN_MARCH_MS - this.now(), this.signal);
            session = await this.open();
          }
          await this.attack(session);
        }
        return;
      } catch (error) {
        if (this.signal.aborted || error.stopped) {
          if (this.record) this.save({ state: this.record.attackIntentAt ? 'unknown' : 'stopped', error: '任务已停止；保留恢复记录' });
          return;
        }
        const attempts = this.record?.attempts ?? ++this.entryFailures;
        this.debug('runner.error', {
          phase: name,
          battlefieldId: this.record?.battlefieldId ?? null,
          roleCodeId: this.record?.roleCodeId ?? null,
          attempts,
          state: this.record?.state ?? null,
          code: error?.code ?? null,
          serverRejected: Boolean(error?.serverRejected),
          uncertain: Boolean(error?.uncertain),
          message: error?.message || String(error),
          serverResponse: error?.serverResponse ?? null,
        });
        if (this.record) this.save({ error: error.message });
        if (error.uncertain || attempts >= MAX_ATTEMPTS) {
          if (this.record) this.save({ state: this.record.attackIntentAt
            || (this.record.marchIntentAt && !this.record.marchAccepted) ? 'unknown' : 'failed' });
          else this.onUpdate({ tokenId: this.tokenId, state: 'failed', attempts, error: error.message });
          return;
        }
        if (this.record) this.save({ attempts: attempts + 1 });
      } finally { session?.close(); }
      try { await this.sleep(1500, this.signal); } catch (error) {
        if (!this.signal.aborted) throw error;
        if (this.record) this.save({ state: this.record.attackIntentAt ? 'unknown' : 'stopped' });
        return;
      }
    }
  }
}
export async function runSaltBatch(runners, signal) {
  const assignments = new Map();
  for (const runner of runners) runner.targetAssignments = assignments;
  for (const runner of runners) { if (signal.aborted) break; await runner.phase('prepare'); }
  for (const runner of runners) {
    if (signal.aborted) break;
    const record = runner.record;
    if (record && record.state !== 'completed' && (record.attackIntentAt || record.marchAccepted)
      && record.state !== 'failed') await runner.phase('attack');
  }
}
