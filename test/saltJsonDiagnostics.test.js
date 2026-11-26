import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { SaltDiagnosticRecorder, diagnosticValue, battlefieldEvidence, explainSaltNavigation } from '../src/utils/saltField/diagnostics.js';
import { SaltOnceRunner, runSaltBatch } from '../src/utils/saltField/runner.js';
import { createRecordStore, nearestTarget } from '../src/utils/saltField/model.js';
const memory = () => { const saved = new Map(); return { saved, save: async run => saved.set(run.runId, structuredClone(run)) }; };

test('archive preserves numeric keys and large maps, missing/null/zero; removes credentials and other roles', () => {
  const buildings = Object.fromEntries(Array.from({length:100}, (_,i) => [`${i}_1`, {type:9, belongsLegionId:i ? -1 : 0}]));
  const evidence = battlefieldEvidence({buildingData:buildings, legions:{7:{id:7,strongholdId:'100_100',buildings:{'99_100':1},name:'PRIVATE_CLUB',members:{other:'OTHER_ROLE'}}}, legionInfo:{7:{id:7,strongholdId:'100_100',buildings:{'99_100':1},members:{other:'OTHER_ROLE'}}}, roles:{123:{state:'idle',legionID:7},456:{private:'OTHER_ROLE'}}},123);
  const out = diagnosticValue({evidence, missing:undefined, nil:null, zero:0, numeric:{123:{type:9}}, token:'PRIVATE_TOKEN',sid2:'PRIVATE_SID',error:'failed wss://host/agent?p=PRIVATE_QUERY',binary:new Uint8Array([1,2])});
  assert.equal(Object.keys(out.evidence.buildingData).length,100);assert.equal(out.numeric[123].type,9);
  assert.deepEqual(out.missing,{$missing:true});assert.equal(out.nil,null);assert.equal(out.zero,0);
  assert.equal(out.evidence.legions[7].strongholdId,'100_100');assert.equal(out.evidence.legions[7].name,undefined);assert.equal(out.evidence.legionInfo[7].strongholdId,'100_100');assert.equal(out.evidence.legionInfo[7].members,undefined);assert.equal(out.evidence.self.legionID,7);assert.equal(out.evidence.roles,undefined);
  assert.doesNotMatch(JSON.stringify(out),/PRIVATE|OTHER_ROLE/);assert.equal(out.binary.$binaryOmitted,true);
});
test('navigation explanation records exclusion causes and friendly path without changing selection', () => {
  const role={position:{x:100,y:100},legionID:7};
  const buildings={'100_100':{type:4,belongsLegionId:7},'99_100':{type:9,belongsLegionId:7},'98_100':{type:1,belongsLegionId:-1},'101_100':{type:1},'100_99':{type:6,belongsLegionId:-1}};
  const before=JSON.stringify(buildings),actual=nearestTarget(role,buildings),report=explainSaltNavigation(role,buildings);
  assert.equal(JSON.stringify(buildings),before);assert.equal(actual.buildingId,'98_100');
  assert.deepEqual(report.candidates.find(c=>c.id===actual.buildingId).path,['100_100','99_100','98_100']);
  assert.ok(report.inspected.find(c=>c.id==='101_100').reasons.includes('owner-missing-or-invalid'));
  assert.ok(report.inspected.find(c=>c.id==='100_99').reasons.includes('type-missing-or-not-allowed'));
});
async function fifteen(recording) {
  const storage=memory(),recorder=new SaltDiagnosticRecorder({accounts:Array.from({length:15},(_,i)=>({accountRef:i+1})),storage});
  const values=new Map(),records=createRecordStore({getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}),commands=[],signal=new AbortController().signal;
  let now=1000;
  const runners=Array.from({length:15},(_,index)=>{
    const id=String(index+1),role={state:'watching',position:{x:100,y:100},legionID:7,aB:0,d:0};let march;
    return new SaltOnceRunner({tokenId:id,records,signal,now:()=>now,sleep:async ms=>{now+=Math.max(0,ms);},diagnostic:recording?recorder.scope({accountRef:index+1}):null,
      connect:async()=>({battlefieldId:'bf',roleCodeId:id,get role(){return role;},snapshot:{roles:{[id]:role},buildingData:{'100_100':{type:4,belongsLegionId:7},'99_100':{type:1,belongsLegionId:-1}}},
        async refresh(){if(march&&now>=march.at+120000)Object.assign(role,{state:'idle',position:march.target});return role;},
        async send(cmd,body){commands.push({id,cmd,body});if(cmd==='war_setbattleteam')role.state='idle';if(cmd==='war_startmarch'){march={at:now,target:body.target};role.state='march';}if(cmd==='war_startattackbuilding')role.aB++;return {};},close(){}})});
  });
  await runSaltBatch(runners,signal);recorder.finish(runners.map(r=>r.record));await recorder.flush();
  return {commands,records:runners.map(r=>r.record),archive:storage.saved.get(recorder.data.runId)};
}
test('15-account gameplay identical with recording; every account and final state survives JSON save',async()=>{
  const plain=await fifteen(false),recorded=await fifteen(true);
  assert.deepEqual(recorded.commands,plain.commands);assert.deepEqual(recorded.records,plain.records);assert.ok(recorded.records.every(r=>r.state==='completed'));
  const run=JSON.parse(JSON.stringify(recorded.archive));assert.equal(run.results.length,15);assert.equal(run.droppedEvents,0);
  for(let accountRef=1;accountRef<=15;accountRef++){const events=run.events.filter(e=>e.accountRef===accountRef);assert.ok(events.some(e=>e.event==='navigation.snapshot'));assert.ok(events.some(e=>e.event==='record.updated'&&e.record.state==='completed'));}
});
test('capacity preserves first evidence and final summary; storage failure remains exportable without rejecting',async()=>{
  const recorder=new SaltDiagnosticRecorder({maxEvents:2,storage:{save:async()=>{throw new Error('quota');}}});
  recorder.record('first');recorder.record('second');recorder.record('third');recorder.finish([{accountRef:1,state:'unknown'}]);await recorder.flush();
  const run=recorder.snapshot();assert.deepEqual(run.events.map(e=>e.event),['first','second']);assert.equal(run.droppedEvents,2);assert.equal(run.results[0].state,'unknown');assert.ok(run.finishedAt);assert.match(run.storageWarning,/保存失败/);
  const small=new SaltDiagnosticRecorder({maxBytes:1,storage:memory()});small.record('large');await small.flush();assert.equal(small.data.droppedEvents,1);
});
const hooks=registerHooks({resolve(specifier,context,next){if(specifier.endsWith('/logger.js'))return {url:'data:text/javascript,'+encodeURIComponent('const log=new Proxy({}, {get:()=>()=>{}});export {log as wsLogger,log as gameLogger};'),shortCircuit:true};return next(specifier,context);}});
const {SaltOnceClient,openSaltSession}=await import('../src/utils/saltField/session.js');hooks.deregister();
test('transport correlates repeated request sequences across sessions and preserves rejected body',async()=>{
  const recorder=new SaltDiagnosticRecorder({storage:memory()});
  for(let accountRef=1;accountRef<=2;accountRef++){const client=new SaltOnceClient({url:'wss://offline.invalid',hint:1,diagnostic:recorder.scope({accountRef,sessionId:accountRef})});client.connected=true;client.socket={close(){}};
    const pending=client.sendWithPromise('war_startmarch',{target:{x:1,y:2}});client._handlePromiseResponse({cmd:'war_startmarchresp',resp:client.seq,seq:20,code:123,body:{reason:{10:{canAttack:false,owner:0}}}});await assert.rejects(pending,e=>e.code===123);client.disconnect();}
  await recorder.flush();const responses=recorder.data.events.filter(e=>e.event==='transport.response.matched');assert.deepEqual(responses.map(e=>e.sessionId),[1,2]);assert.equal(responses[0].body.reason[10].owner,0);
});
test('session records map updates and self state; repeated-map compression preserves changes',async()=>{
  const recorder=new SaltDiagnosticRecorder({storage:memory()}),role={state:'idle',position:{x:100,y:100},legionID:7,aB:0,d:0};let instance;
  class Client {constructor(){instance=this;}setMessageListener(listener){this.listener=listener;}init(){queueMicrotask(()=>this.onConnect());}disconnect(){}
    async sendWithPromise(cmd){const body={roleCodeId:'123',battlefield:{roles:{123:role},buildingData:{'99_100':{type:1,belongsLegionId:-1}}}};this.listener({cmd:`${cmd}resp`,resp:1,seq:2,body});return body;}}
  const session=await openSaltSession({token:'PRIVATE',info:{battlefieldId:'bf',sid:'PRIVATE_SID'},signal:new AbortController().signal,Client,diagnostic:recorder.scope({accountRef:1,sessionId:1})});
  instance.listener({cmd:'sync',seq:3,body:{battlefield:{buildingData:{'99_100':{belongsLegionId:7},'100_99':null}}}});session.close();await recorder.flush();
  const packets=recorder.data.events.filter(e=>e.event==='battlefield.packet');assert.ok(packets.some(e=>e.battlefield?.buildingData?.$unchangedFromPreviousMap));assert.ok(packets.some(e=>e.seq===3&&e.battlefield.buildingData['99_100'].belongsLegionId===7));
  assert.equal(session.snapshot.buildingData['99_100'].type,1);assert.equal(session.snapshot.buildingData['100_99'],null);assert.doesNotMatch(JSON.stringify(recorder.snapshot()),/PRIVATE/);
});
