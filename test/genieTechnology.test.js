import test from 'node:test';
import assert from 'node:assert/strict';
import { createTechnologySession, createTechnologyLedger, research, swapTechnology, activeTechnology } from '../src/utils/batch/genieTechnology.js';
function harness({raw={101:60,102:50,103:26,104:2},diamond=500,fail='',applies=true}={}) {
 const data=new Map(),ledger=createTechnologyLedger({getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)});
 const role={legionResearch:raw,diamond}, calls=[];let stop=false,offline=false;
 const send=async(cmd,b)=>{ calls.push({cmd,b});if(offline)throw Error('offline');if(cmd==='role_getroleinfo')return {role:structuredClone(role)};
 if(cmd==='legion_exchangeresearch' && applies){role.legionResearch=swapTechnology(research(role.legionResearch),b.type,b.targetType);role.diamond-=20;}
 if(cmd==='legion_resetresearch' && applies){const p={1:1,2:6,3:5,4:2,5:4,6:3}[b.type];for(let i=1;i<=14;i++)role.legionResearch[p*100+i]=0;}
 if(cmd==='legion_research' && applies)role.legionResearch[b.researchId]=(role.legionResearch[b.researchId]||0)+1;
 if(fail)throw Error(fail);return {};};
 const options={id:'test',send,ledger,stopped:()=>stop};
 return {role,calls,ledger,session:createTechnologySession(options),options,stop:()=>stop=true,offline:v=>offline=v,swaps:()=>calls.filter(c=>c.cmd==='legion_exchangeresearch')};
}
test('four nations retain all fourteen slots and return warrior, spending four exchanges',async()=>{
 const h=harness(),initial=research(h.role.legionResearch);await h.session.prepare();for(const n of [1,2,3,4])await h.session.beforeNation(n);await h.session.finish();
 assert.deepEqual(research(h.role.legionResearch),initial);assert.equal(h.role.diamond,420);assert.deepEqual(h.swaps().map(c=>c.b),[{type:1,targetType:4},{type:4,targetType:1},{type:1,targetType:6},{type:6,targetType:1}]);assert.equal(h.ledger.get('test'),null);
});
test('existing support is reused, never upgraded, finish returns warrior',async()=>{const h=harness({raw:{501:60}});await h.session.prepare(true);await h.session.beforeNation(1);await h.session.finish();assert.equal(h.role.legionResearch[101],60);assert.equal(h.calls.some(c=>c.cmd==='legion_research'),false);});
test('same target and disabled nation need no exchange',async()=>{const h=harness();await h.session.beforeNation(2);await h.session.beforeNation(4);await h.session.finish();assert.equal(h.swaps().length,0);});
test('stop still restores warrior',async()=>{const h=harness();await h.session.beforeNation(1);h.stop();await assert.rejects(h.session.beforeNation(3));await h.session.finish();assert.equal(activeTechnology(research(h.role.legionResearch)),1);});
test('lost response with applied exchange is not replayed; restores',async()=>{const h=harness({fail:'timeout'});await assert.rejects(h.session.beforeNation(1));await h.session.finish();assert.equal(h.swaps().length,2);assert.equal(h.ledger.get('test'),null);});
test('unknown unapplied timeout is retained and never resent',async()=>{const h=harness({fail:'timeout',applies:false});await assert.rejects(h.session.beforeNation(1));await assert.rejects(h.session.finish());await assert.rejects(createTechnologySession(h.options).recover());assert.equal(h.swaps().length,1);assert.ok(h.ledger.get('test').pending);});
test('offline restoration persisted and next session restores before continuing',async()=>{const h=harness();await h.session.beforeNation(1);h.offline(true);await assert.rejects(h.session.finish());assert.ok(h.ledger.get('test'));h.offline(false);assert.equal(await createTechnologySession(h.options).recover(),true);assert.equal(h.ledger.get('test'),null);assert.equal(activeTechnology(research(h.role.legionResearch)),1);});
test('multiple nonzero and missing/malformed research cannot be exchanged',async()=>{for(const raw of [{101:1,201:1},undefined,{999:1},{101:-1}]){const h=harness();h.role.legionResearch=raw;await assert.rejects(h.session.beforeNation(1));assert.equal(h.swaps().length,0);}});
test('reserve restoration fee before leaving warrior',async()=>{const h=harness({diamond:39});await assert.rejects(h.session.beforeNation(1));assert.equal(h.swaps().length,0);});
test('storage failure before mutation sends nothing',async()=>{const h=harness();h.options.ledger.set=()=>{throw Error('quota exceeded');};await assert.rejects(h.session.beforeNation(1));assert.equal(h.swaps().length,0);});
test('empty upgrade opt in only, ordered one-key commands',async()=>{const h=harness({raw:{}});await assert.rejects(h.session.prepare());await h.session.prepare(true);assert.deepEqual(h.calls.filter(c=>c.cmd==='legion_research').map(c=>c.b),[101,102,103,104,105,106,107,108].map(researchId=>({researchId,isMax:true})));await h.session.finish();assert.equal(h.ledger.get('test'),null);});
test('unexpected outside changes block restoration',async()=>{const h=harness();await h.session.beforeNation(1);h.role.legionResearch[201]++;await assert.rejects(h.session.finish());assert.equal(h.swaps().length,1);});
test('acknowledged upgrade with no progress stops without replay or permanent pending',async()=>{const h=harness({raw:{},applies:false});await assert.rejects(h.session.prepare(true),/仍为空/);await h.session.finish();assert.equal(h.calls.filter(c=>c.cmd==='legion_research').length,8);assert.equal(h.ledger.get('test'),null);});

test('multiple technologies reset every active basic profession then upgrade 101 through 108',async()=>{
 const h=harness({raw:{101:4,201:8,501:2}});await h.session.prepare();
 assert.deepEqual(h.calls.filter(c=>c.cmd==='legion_resetresearch').map(c=>c.b),[{type:1,advanced:false},{type:3,advanced:false},{type:4,advanced:false}]);
 assert.deepEqual(h.calls.filter(c=>c.cmd==='legion_research').map(c=>c.b.researchId),[101,102,103,104,105,106,107,108]);
 assert.equal(h.role.legionResearch[201],0);assert.equal(h.role.legionResearch[108],1);await h.session.finish();assert.equal(h.ledger.get('test'),null);
});
test('reset timeout applied is settled without repeat and reconstruction resumes',async()=>{
 const h=harness({raw:{101:4,201:8},fail:'timeout'});await assert.rejects(h.session.prepare());assert.equal(h.calls.filter(c=>c.cmd==='legion_resetresearch').length,1);
 assert.ok(h.ledger.get('test').consolidating);assert.deepEqual(h.ledger.get('test').resetTypes,[4]);await assert.rejects(h.session.finish());
});
test('reset timeout without change never replays or upgrades',async()=>{
 const h=harness({raw:{101:4,201:8},fail:'timeout',applies:false});await assert.rejects(h.session.prepare());await assert.rejects(createTechnologySession(h.options).recover());assert.equal(h.calls.filter(c=>c.cmd==='legion_resetresearch').length,1);assert.equal(h.calls.filter(c=>c.cmd==='legion_research').length,0);
});
test('resume after reset confirmation preserves upgrade progress and does not reset warrior twice',async()=>{
 const h=harness({raw:{101:1,102:1}});const current=research(h.role.legionResearch);
 h.ledger.set('test',{version:1,pending:false,current,consolidating:true,resetTypes:[],nextUpgrade:103});
 assert.equal(await h.session.recover(),true);assert.equal(h.calls.filter(c=>c.cmd==='legion_resetresearch').length,0);assert.deepEqual(h.calls.filter(c=>c.cmd==='legion_research').map(c=>c.b.researchId),[103,104,105,106,107,108]);assert.equal(h.ledger.get('test'),null);
});
