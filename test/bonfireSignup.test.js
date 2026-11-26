import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bonfirePeriod, bonfireIdentity, runBonfireSignup, createTasksBonfire } from '../src/utils/batch/tasksBonfire.js';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/bonfire-live-redacted.json', import.meta.url)));
const friday = Date.parse('2026-11-06T10:30:00+08:00');
function harness(options = {}) {
  const f = structuredClone(fixture), calls = [], map = new Map(); let signed = false, stopped = false, closes = 0;
  const storage = { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k) };
  const d = { storage, now: () => friday, stopped: () => stopped,
    onUncertain: async () => { closes++; },
    send: async (cmd, body) => {
      calls.push(cmd); assert.deepEqual(body, {});
      if (cmd === 'role_getroleinfo') return f.role;
      if (cmd === 'legion_getinfo') return f.legion;
      if (cmd === 'club_getinfo') return signed || options.already ? f.after : f.before;
      if (cmd === 'club_getsignupcnt') { if (options.stopBefore) stopped = true; return f.count; }
      if (cmd === 'club_signup') {
        signed = !options.noCommit;
        if (options.stopAfter) stopped = true;
        if (options.timeout) throw new Error('timeout');
        if (options.reject) throw Object.assign(new Error('server rejected'), { code: 200160, requestCmd: cmd });
        return f.signup;
      }
      throw new Error('unexpected request '+cmd);
    } };
  return { f, d, calls, map, closes: () => closes };
}
test('Beijing window, year rollover, actual leader/deputy/member evidence and mismatched identity', async () => {
  for (const [date,expected] of [
    ['2026-11-05T23:59:59+08:00',null],['2026-11-06T00:00:00+08:00','261109'],
    ['2026-11-08T23:59:59+08:00','261109'],['2026-11-09T00:00:00+08:00',null],
    ['2027-01-01T12:00:00+08:00','270104']]) assert.equal(bonfirePeriod(Date.parse(date)),expected);
  const h=harness(); assert.equal(bonfireIdentity(h.f.role,h.f.legion).allowed,true);
  h.f.role.role.roleId=100;assert.equal(bonfireIdentity(h.f.role,h.f.legion).allowed,true);
  h.f.role.role.roleId=102;assert.equal((await runBonfireSignup(h.d)).status,'skipped');assert.ok(!h.calls.includes('club_signup'));
  h.f.role.role.legionId=99;assert.throws(()=>bonfireIdentity(h.f.role,h.f.legion),/未匹配/);
  const outside=harness();outside.d.now=()=>Date.parse('2026-11-09T12:00:00+08:00');
  assert.equal((await runBonfireSignup(outside.d)).status,'skipped');assert.equal(outside.calls.length,0);
});
test('real redacted phase transition verifies success, repeated same-club execution skips', async () => {
  const h=harness();assert.equal((await runBonfireSignup(h.d)).status,'completed');
  assert.equal((await runBonfireSignup(h.d)).status,'skipped');
  assert.equal(h.calls.filter(c=>c==='club_signup').length,1);
  const fresh=harness({already:true});assert.equal((await runBonfireSignup(fresh.d)).status,'skipped');
  assert.ok(!fresh.calls.includes('club_getsignupcnt'));assert.ok(!fresh.calls.includes('club_signup'));
});
test('timeout closes old transport, readback reconciles commit; unconfirmed persists across reruns', async () => {
  const committed=harness({timeout:true});assert.equal((await runBonfireSignup(committed.d)).status,'completed');assert.equal(committed.closes(),1);
  const pending=harness({timeout:true,noCommit:true});assert.equal((await runBonfireSignup(pending.d)).status,'unverified');
  assert.equal((await runBonfireSignup(pending.d)).status,'unverified');assert.equal(pending.calls.filter(c=>c==='club_signup').length,1);
  assert.equal(pending.closes(),1);
  const accepted=harness({noCommit:true});assert.equal((await runBonfireSignup(accepted.d)).status,'unverified');
});
test('stop before signup sends nothing; stop after signup still reads result; rejects never become success', async () => {
  const before=harness({stopBefore:true});await assert.rejects(runBonfireSignup(before.d),/已停止/);assert.ok(!before.calls.includes('club_signup'));
  const after=harness({stopAfter:true});assert.equal((await runBonfireSignup(after.d)).status,'completed');assert.equal(after.calls.at(-1),'club_getinfo');
  const rejected=harness({reject:true});assert.equal((await runBonfireSignup(rejected.d)).status,'failed');assert.equal(rejected.calls.filter(c=>c==='club_signup').length,1);
});
test('storage failure and bad count prevent signup; one club attempted at most once in batch', async () => {
  const broken=harness();broken.d.storage.setItem=()=>{throw new Error('quota')};await assert.rejects(runBonfireSignup(broken.d),/quota/);assert.ok(!broken.calls.includes('club_signup'));
  const count=harness();count.f.count.cnt='20';await assert.rejects(runBonfireSignup(count.d),/人数/);assert.ok(!count.calls.includes('club_signup'));
  const same=harness({noCommit:true});same.d.seenClubs=new Set();await runBonfireSignup(same.d);assert.equal((await runBonfireSignup(same.d)).status,'skipped');assert.equal(same.calls.filter(c=>c==='club_signup').length,1);
});
test('batch adapter uses selected accounts, releases connection/lease and restores running state', async () => {
  const h=harness();const logs=[];let opens=0,closes=0,leases=0;
  const d={selectedTokens:{value:['a','a','b']},tokens:{value:[{id:'a',name:'A'},{id:'b',name:'B'}]},tokenStatus:{value:{}},
    isRunning:{value:false},shouldStop:{value:true},currentRunningTokenId:{value:null},isBusy:()=>false,
    now:()=>friday,storage:h.d.storage,sleep:async()=>{},addLog:x=>logs.push(x),
    openReadOnly:async()=>{opens++;},closeReadOnly:async()=>{closes++;},acquireLease:async()=>1,releaseLease:async()=>{leases++;},
    tokenStore:{sendMessageWithPromise:async(_id,cmd,body)=>h.d.send(cmd,body)}};
  const task=createTasksBonfire(d);const rows=await task.batchBonfireSignup();
  assert.deepEqual(rows.map(r=>r.status),['completed','skipped']);assert.ok(rows[0].details.length);assert.equal(opens,2);assert.equal(closes,2);assert.equal(leases,1);
  assert.equal(d.isRunning.value,false);assert.equal(d.currentRunningTokenId.value,null);assert.equal(logs.length,2);
  d.isBusy=()=>true;assert.deepEqual(await task.batchBonfireSignup(),[]);assert.equal(opens,2);
});

test('production transport encodes empty signup body and resolves both response mappings', async () => {
  const { registerHooks } = await import('node:module');
  const hook = registerHooks({ resolve(s,c,next) {
    if (s === '@/stores/cache') return {url:'data:text/javascript,'+encodeURIComponent('export const $CacheManager={getCache:()=>({}),delCache(){}}'),shortCircuit:true};
    if (s.endsWith('/logger.js')) return {url:'data:text/javascript,'+encodeURIComponent('const x=new Proxy({},{get:()=>()=>{}});export {x as wsLogger,x as gameLogger}'),shortCircuit:true};
    return next(s,c);
  }});
  let XyzwWebSocketClient,g_utils;
  try {
    ({XyzwWebSocketClient}=await import('../src/utils/xyzwWebSocket.js'));
    ({g_utils}=await import('../src/utils/bonProtocol.js'));
  } finally {hook.deregister();}
  for (const cmd of ['club_getsignupcnt','club_signup']) {
    const c=new XyzwWebSocketClient({url:'wss://offline.invalid'});
    const p=c.registry.build(cmd,0,1,{});assert.deepEqual(g_utils.bon.decode(p.body),{});
    let value; c.promises[3]={originalCmd:cmd,resolve:d=>{value=d},reject:()=>assert.fail('unexpected error')};
    c._handlePromiseResponse({cmd:cmd+'resp',code:0,rawData:cmd==='club_signup'?fixture.signup:fixture.count});
    assert.ok(value);assert.equal(Object.keys(c.promises).length,0);
  }
});
