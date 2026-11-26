import { openDB } from 'idb';
import { navigationPlan } from './model.js';

export const SALT_DIAGNOSTIC_VERSION = 'SALT_ROAD_CANDIDATES_20261114_R2';
const BASELINE = 'e63cd59c9237c5154fc4923d5310f723eeef2652';
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_EVENTS = 30000;
const listeners = new Set();
let current = null;
let database;
const secret = /token|cookie|authorization|password|passwd|secret|credential|^sid\d*$|^p$|wsurl|loginurl|bin(data|file)?$/i;
const cleanText = value => value.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[地址已脱敏]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[凭据已脱敏]');

// Preserve numeric keys and missing/null/zero distinctions. Never use the console
// sanitizer's shallow limit for the diagnostic archive.
export function diagnosticValue(value, depth = 0, key = '', seen = new WeakSet()) {
  if (secret.test(key)) return '[已脱敏]';
  if (value === undefined) return { $missing: true };
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const text = cleanText(value);
    return text.length > 4096 ? { $truncatedString: true, value: text.slice(0, 4096), length: text.length } : text;
  }
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return { $binaryOmitted: true, bytes: value.byteLength };
  if (typeof value !== 'object') return String(value);
  if (depth >= 12) return { $depthLimit: true };
  if (seen.has(value)) return { $circular: true };
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.slice(0, 10000).map(item => diagnosticValue(item, depth + 1, '', seen));
    if (value.length > 10000) result.push({ $omittedItems: value.length - 10000 });
  } else {
    result = Object.fromEntries(Object.entries(value).slice(0, 10000)
      .map(([name, item]) => [name, diagnosticValue(item, depth + 1, name, seen)]));
    if (Object.keys(value).length > 10000) result.$omittedKeys = Object.keys(value).length - 10000;
  }
  seen.delete(value);
  return result;
}

async function db() {
  if (!database) database = openDB('xyzw-salt-diagnostics-v1', 1, {
    upgrade(instance) { instance.createObjectStore('runs', { keyPath: 'runId' }); },
  }).catch(error => { database = null; throw error; });
  return database;
}
const bounded = promise => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('诊断存储响应超时')), 8000);
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const browserStorage = {
  async save(run) {
    const instance = await db();
    await instance.put('runs', run);
    // Explicit retention policy: latest three batches on this browser.
    const runs = await instance.getAll('runs');
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const old of runs.slice(3)) await instance.delete('runs', old.runId);
  },
  async list() { return (await (await db()).getAll('runs')).map(({ events, ...meta }) => ({
    ...meta, eventCount: events.length, accountCount: meta.accounts.length,
  })); },
  async read(id) { return (await db()).get('runs', id); },
};

export class SaltDiagnosticRecorder {
  constructor({ accounts = [], settings = {}, storage = browserStorage, onStatus = () => {},
    maxBytes = MAX_BYTES, maxEvents = MAX_EVENTS, now = () => new Date().toISOString() } = {}) {
    this.storage = storage; this.onStatus = onStatus; this.now = now;
    this.maxBytes = maxBytes; this.maxEvents = maxEvents; this.timer = null;
    this.saving = Promise.resolve(); this.dirty = false;
    const startedAt = now();
    this.data = { schemaVersion: 1, diagnosticVersion: SALT_DIAGNOSTIC_VERSION,
      sourceBaseline: BASELINE, runId: `salt-${startedAt.replace(/[^0-9]/g, '')}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
      startedAt, finishedAt: null, accounts: diagnosticValue(accounts), settings: diagnosticValue(settings),
      retention: { maxBatches: 3, maxBytes, maxEvents }, bytes: 0, droppedEvents: 0,
      storageWarning: '', events: [], results: null };
  }
  status() {
    const { runId, startedAt, finishedAt, bytes, droppedEvents, storageWarning } = this.data;
    return { runId, startedAt, finishedAt, bytes, droppedEvents, storageWarning,
      eventCount: this.data.events.length, accountCount: this.data.accounts.length };
  }
  notify() { try { this.onStatus(this.status()); } catch { /* Diagnostics never control gameplay. */ } }
  record(event, detail = {}) {
    try {
      const entry = diagnosticValue({ index: this.data.events.length + this.data.droppedEvents + 1,
        at: this.now(), event, ...detail });
      const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
      if (this.data.events.length >= this.maxEvents || this.data.bytes + size > this.maxBytes) {
        this.data.droppedEvents++;
      } else { this.data.events.push(entry); this.data.bytes += size; }
      this.dirty = true;
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 2000);
      this.notify();
    } catch { this.data.storageWarning = '诊断序列化失败；业务继续，请导出已记录部分'; this.notify(); }
  }
  scope(context) {
    return { record: (event, detail) => this.record(event, { ...detail, ...context }),
      scope: more => this.scope({ ...context, ...more }) };
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    this.saving = this.saving.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        // Clone now so writes cannot observe a later mutation of the in-memory run.
        await bounded(this.storage.save(JSON.parse(JSON.stringify(this.data))));
      } catch {
        this.data.storageWarning = '本机保存失败或超时；请立即导出JSON，刷新可能丢失未保存记录';
      }
      this.notify();
    });
    return this.saving;
  }
  finish(results) {
    this.data.results = diagnosticValue(results);
    this.data.finishedAt = this.now();
    this.record('batch.finished', { results });
    // No await on the gameplay path; export can always use the in-memory copy.
    void this.flush();
  }
  snapshot() { return JSON.parse(JSON.stringify(this.data)); }
}

export function startSaltDiagnostic(accounts, settings) {
  if (current) void current.flush();
  current = new SaltDiagnosticRecorder({ accounts, settings, onStatus: status => {
    for (const listener of listeners) { try { listener(status); } catch { /* UI only. */ } }
  } });
  current.record('batch.start', { accounts, settings });
  return current;
}
export const getSaltDiagnosticStatus = () => current?.status() || null;
export function subscribeSaltDiagnostics(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export async function listSaltDiagnostics() {
  const stored = await bounded(browserStorage.list());
  const rows = stored.filter(row => row.runId !== current?.data.runId);
  if (current) rows.push(current.status());
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export async function readSaltDiagnostic(runId) {
  const run = current?.data.runId === runId ? current.snapshot() : await bounded(browserStorage.read(runId));
  if (!run) throw new Error('未找到该批次诊断，请先运行盐场任务');
  return { ...run, exportedAt: new Date().toISOString(),
    captureState: run.finishedAt ? 'finished' : 'unfinished-or-running' };
}

// Whitelist the battlefield portion: never archive all players' roles, login
// credentials or a complete unrelated protocol response.
export function battlefieldEvidence(battlefield, roleCodeId) {
  if (!battlefield || typeof battlefield !== 'object') return null;
  const result = { battlefieldKeys: Object.keys(battlefield) };
  for (const key of ['id', 'confId', 'legionWarMap', 'mapName', 'type', 'subType', 'state', 'buildingData', 'marches']) {
    if (Object.prototype.hasOwnProperty.call(battlefield, key)) result[key] = battlefield[key];
  }
  result.rolePresent = Boolean(battlefield.roles && Object.prototype.hasOwnProperty.call(battlefield.roles, String(roleCodeId)));
  if (result.rolePresent) {
    result.self = battlefield.roles[String(roleCodeId)];
  }
  // Live packets use legions; retain the older legionInfo spelling too.
  // Copy only map/ownership fields, never club names or member lists.
  for (const field of ['legions', 'legionInfo']) {
    if (!battlefield[field] || typeof battlefield[field] !== 'object') continue;
    result[field] = Object.fromEntries(Object.entries(battlefield[field]).map(([id, legion]) => [id,
      legion == null ? null : Object.fromEntries(['id', 'strongholdId', 'buildings']
        .filter(key => Object.prototype.hasOwnProperty.call(legion, key)).map(key => [key, legion[key]]))]));
  }
  return result;
}

// Read-only explanation. The runner still uses nearestTarget for decisions.
export function explainSaltNavigation(role, buildings, excluded = [], metadata = {}) {
  try {
    return navigationPlan(role, buildings, excluded, metadata);
  } catch (error) { return { error: error?.message || String(error) }; }
}
