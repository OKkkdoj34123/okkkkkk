import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
// Only the application's browser logger is stubbed; the existing BON and WS
// classes and the new transaction/cleanup behavior remain the production code.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/logger.js')) return { url: 'data:text/javascript,' + encodeURIComponent('const log=new Proxy({}, {get:()=>()=>{}}); export {log as wsLogger, log as gameLogger};'), shortCircuit: true };
  return next(specifier, context);
} });
const { SaltOnceClient, openSaltSession } = await import('../src/utils/saltField/session.js');
hooks.deregister();
function client() {
  const c = new SaltOnceClient({ url: 'wss://offline.invalid', hint: 1 });
  c.connected = true; c.socket = { close() {} }; return c;
}
test('six required commands are registered on the task client', () => {
  const c = client();
  for (const name of ['war_enterbattlefield', 'war_getbattlefieldinfo', 'war_teamsetbattleteam', 'war_setbattleteam', 'war_startmarch', 'war_startattackbuilding']) assert.ok(c.registry.commands.has(name));
  c.disconnect();
});
test('response matched by resp, clears timer and propagates server rejection', async () => {
  const c = client(), p = c.sendWithPromise('war_startmarch', {});
  c._handlePromiseResponse({ cmd: 'war_startmarchresp', resp: c.seq, code: 42 });
  await assert.rejects(p, e => e.serverRejected && e.code === 42); assert.equal(Object.keys(c.promises).length, 0); c.disconnect();
});
test('late resp cannot resolve a newer command', async () => {
  const c = client(); await assert.rejects(c.sendWithPromise('war_startmarch', {}, 5), /超时/);
  const old = c.seq, p = c.sendWithPromise('war_startmarch', {}, 2000);
  c._handlePromiseResponse({ cmd: 'war_startmarchresp', resp: old, code: 0 });
  assert.equal(Object.keys(c.promises).length, 1);
  c._handlePromiseResponse({ cmd: 'war_startmarchresp', resp: c.seq, code: 0, body: { ok: true } });
  assert.deepEqual(await p, { ok: true }); c.disconnect();
});
test('timeout drops queued mutation instead of replaying on reconnect', async () => {
  const c = client(); await assert.rejects(c.sendWithPromise('war_startattackbuilding', {}, 5), /超时/);
  assert.equal(c.sendQueue.length, 0); assert.equal(Object.keys(c.promises).length, 0); c.disconnect();
});
test('disconnect rejects pending requests and clears queues and heartbeat', async () => {
  const c = client(), p = c.sendWithPromise('war_startattackbuilding', {});
  c._setupHeartbeat(); c.disconnect(); await assert.rejects(p, /断开/);
  assert.equal(c.sendQueue.length, 0); assert.equal(c.heartbeatTimer, null);
  await assert.rejects(c.sendWithPromise('war_startmarch', {}), /断开/);
});
test('command fallback only resolves exact response without resp ID', async () => {
  const c = client(), p = c.sendWithPromise('war_setbattleteam', {});
  c._handlePromiseResponse({ cmd: 'war_setbattleteamresp', code: 0, body: { applied: true } });
  assert.deepEqual(await p, { applied: true }); c.disconnect();
});
test('session rejects a refresh that lacks this role instead of using stale arrival', async () => {
  let closed = false;
  class FakeClient {
    setMessageListener(fn) { this.listener = fn; }
    init() { this.onConnect(); }
    disconnect() { closed = true; }
    async sendWithPromise(cmd) {
      return cmd === 'war_enterbattlefield' ? { roleCodeId: 'a', battlefield: { roles: { a: { state: 'idle' } } } }
        : { battlefield: { roles: { b: { state: 'idle' } } } };
    }
  }
  await assert.rejects(openSaltSession({ token: 'offline', info: { sid: 1, battlefieldId: 2 }, signal: new AbortController().signal, Client: FakeClient }), /本角色快照/);
  assert.ok(closed);
});
