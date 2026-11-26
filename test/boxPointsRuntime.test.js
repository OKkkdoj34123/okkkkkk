import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBoxRules, nextBoxBatch, readBoxInventory, runBoxPoints } from '../src/utils/batch/boxPointsRuntime.js';
function fixture(inventory, extra = {}) {
  const inv = { 2001: 200, 2002: 0, 2003: 0, 2004: 0, ...inventory };
  const calls = []; let claims = 0;
  return { calls, inv, request: async (cmd, p) => {
    calls.push([cmd, p]);
    if (cmd === 'role_getroleinfo') return { role: { items: Object.fromEntries(Object.entries(inv).map(([id, quantity]) => [id, { quantity }])) } };
    if (cmd === 'item_openbox') { if (!extra.noProgress) inv[p.itemId] -= p.number; if (extra.timeout) throw new Error('timeout'); }
    if (cmd === 'item_batchclaimboxpointreward') { claims++; if (extra.claimError) throw new Error('claim failed'); extra.onClaim?.(inv, claims); }
    return {};
  } };
}
test('strict priority and switches, normalize duplicate ranks', () => {
 const rules = normalizeBoxRules([{ id:2004, priority:1 }, { id:2001, priority:4, enabled:false }]);
 assert.equal(nextBoxBatch({2001:999,2002:20,2003:20,2004:20},rules,1).id,2004);
 assert.equal(new Set(rules.map(r=>r.priority)).size,4);
});
test('reserve wood and do not use disabled boxes', () => {
 const rules=normalizeBoxRules().map(r=>({...r,enabled:r.id===2001}));
 assert.equal(nextBoxBatch({2001:209},rules,10),null);
 assert.equal(nextBoxBatch({2001:210},rules,10).number,10);
});
test('claim generated boxes continue and points do not reset', async () => {
 const f=fixture({2002:10},{onClaim:(inv,n)=>{if(n===1)inv[2002]+=10;}});
 const r=await runBoxPoints({target:200,...f});
 assert.equal(r.status,'completed');assert.equal(r.points,200);assert.equal(r.claims,2);assert.equal(r.rounds,2);
});
test('reward new higher priority boxes are used next', async () => {
 const f=fixture({2002:20},{onClaim:(inv,n)=>{if(n===1) inv[2001]+=10;}});
 const r=await runBoxPoints({target:110,...f});
 assert.equal(r.points,110); assert.deepEqual(f.calls.filter(c=>c[0]==='item_openbox').map(c=>c[1].itemId),[2002,2001]);
});
test('insufficient inventory exits after one initial claim',async()=>{
 const f=fixture({});const r=await runBoxPoints({target:100,...f});assert.equal(r.status,'incomplete');assert.equal(r.claims,1);
});
test('no progress never resends',async()=>{
 const f=fixture({2002:10},{noProgress:true});const r=await runBoxPoints({target:100,...f});assert.equal(r.status,'uncertain');assert.equal(r.rounds,1);assert.equal(r.claims,0);
});
test('timeout after consumption counts once then stops',async()=>{
 const f=fixture({2002:10},{timeout:true});const r=await runBoxPoints({target:100,...f});assert.equal(r.status,'uncertain');assert.equal(r.points,100);assert.equal(r.claims,0);
});
test('final claim failure must not report completed',async()=>{
 const f=fixture({2002:10},{claimError:true});const r=await runBoxPoints({target:100,...f});assert.equal(r.status,'failed');assert.equal(r.points,100);
});
test('round cap prevents infinite reward replenishment',async()=>{
 const f=fixture({2002:10},{onClaim:inv=>inv[2002]+=10});const r=await runBoxPoints({target:1000,maxRounds:2,...f});assert.equal(r.status,'incomplete');assert.equal(r.rounds,2);
});
test('user stop prevents commands',async()=>{
 const f=fixture({2002:10});const r=await runBoxPoints({target:100,stopped:()=>true,...f});assert.equal(r.status,'stopped');assert.equal(f.calls.length,0);
});
test('all disabled rejects before consumption',async()=>{
 const f=fixture({2002:10});await assert.rejects(()=>runBoxPoints({target:100,rules:normalizeBoxRules().map(r=>({...r,enabled:false})),...f}));assert.equal(f.calls.length,0);
});
test('missing role inventory is not zero inventory',()=>assert.throws(()=>readBoxInventory({})));
test('partial final batch allowed to exceed target only by batch',async()=>{
 const f=fixture({2002:20});const r=await runBoxPoints({target:1,...f});assert.equal(r.points,100);assert.equal(r.rounds,1);
});
test('cancel after open verifies but does not claim',async()=>{
 const f=fixture({2002:20});let stop=false;const orig=f.request;
 const r=await runBoxPoints({target:100,request:async(c,p)=>{const out=await orig(c,p);if(c==='item_openbox')stop=true;return out;},stopped:()=>stop});
 assert.equal(r.status,'stopped');assert.equal(r.points,100);assert.equal(r.claims,0);
});

import { createPacedBoxRequest } from '../src/utils/batch/boxPointsRuntime.js';
function clock() { let t=0;return { now:()=>t,sleep:async ms=>{t+=ms;} }; }
test('all commands separated by 1500ms after response',async()=>{
 const c=clock(), times=[];
 const request=createPacedBoxRequest({...c,send:async cmd=>{times.push([cmd,c.now()]);await c.sleep(200);return {};}});
 await request('role_getroleinfo',{});await request('item_openbox',{});await request('role_getroleinfo',{});await request('item_batchclaimboxpointreward',{});
 assert.deepEqual(times.map(x=>x[1]),[0,1700,3400,5100]);
});
test('rate-limited read retries at most three times with cooldown',async()=>{
 const c=clock(),times=[];
 const request=createPacedBoxRequest({...c,send:async()=>{times.push(c.now());throw Object.assign(new Error('fast'),{code:200400});}});
 await assert.rejects(()=>request('role_getroleinfo',{}));
 assert.equal(times.length,4);assert.deepEqual(times,[0,6500,18000,39500]);
});
test('mutations and non-rate errors never retry',async()=>{
 for(const [cmd,code] of [['item_openbox',200400],['item_batchclaimboxpointreward',200400],['role_getroleinfo',200020]]) {
  let n=0;const request=createPacedBoxRequest({...clock(),send:async()=>{n++;throw Object.assign(new Error('error'),{code});}});
  await assert.rejects(()=>request(cmd,{}));assert.equal(n,1);
 }
});
test('stop interrupts cooldown without retry',async()=>{
 const c=clock();let n=0;
 const request=createPacedBoxRequest({...c,stopped:()=>c.now()>=300,send:async()=>{n++;throw Object.assign(new Error('fast'),{code:200400});}});
 await assert.rejects(()=>request('role_getroleinfo',{}),e=>e.boxStopped===true);assert.equal(n,1);assert.equal(c.now(),300);
});
test('retry final post-claim query without opening or claiming twice',async()=>{
 const f=fixture({2002:10});const c=clock();let fail=true;let afterClaim=false;
 const request=createPacedBoxRequest({...c,send:async(cmd,p)=>{
  if(cmd==='role_getroleinfo'&&afterClaim&&fail){fail=false;throw Object.assign(new Error('rate'),{code:200400});}
  const r=await f.request(cmd,p);if(cmd==='item_batchclaimboxpointreward')afterClaim=true;return r;
 }});
 const result=await runBoxPoints({target:100,request});assert.equal(result.status,'completed');assert.equal(result.points,100);
 assert.equal(f.calls.filter(x=>x[0]==='item_openbox').length,1);assert.equal(result.claims,1);
});
