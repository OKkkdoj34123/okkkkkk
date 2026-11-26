import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hook = registerHooks({ resolve(s,c,next) {
  if (s === '@/stores/cache') return { url:'data:text/javascript,'+encodeURIComponent('export const $CacheManager={getCache:()=>({}),delCache(){}}'),shortCircuit:true };
  if (s.endsWith('/logger.js')) return {url:'data:text/javascript,'+encodeURIComponent('const x=new Proxy({}, {get:()=>()=>{}});export {x as wsLogger,x as gameLogger}'),shortCircuit:true};
  return next(s,c);
}});
const { XyzwWebSocketClient } = await import('../src/utils/xyzwWebSocket.js');
const { g_utils } = await import('../src/utils/bonProtocol.js');
hook.deregister();
test('production registry serializes exact ordinary-genie fields without sweep defaults', () => {
  const c=new XyzwWebSocketClient({url:'wss://offline.invalid'});
  const payload={battleTeam:{0:104,1:103,2:110,3:118,4:114},genieId:2,lordWeaponId:0,petUId:'fixture-pet'};
  const packet=c.registry.commands.get('fight_startgenie')(1,2,payload);
  assert.equal(packet.cmd,'fight_startgenie');assert.deepEqual(g_utils.bon.decode(packet.body),payload);
  assert.ok(c.registry.commands.has('genie_sweep'));
});
test('actual response handler matches genie resp by sequence and by exact command', () => {
  for(const seq of [true,false]){
    const c=new XyzwWebSocketClient({url:'wss://offline.invalid'});let got;
    c.promises[3]={originalCmd:'fight_startgenie',resolve:d=>{got=d;},reject:()=>assert.fail('unexpected reject')};
    const data={isWin:false,battleData:{result:{isWin:false}}};
    c._handlePromiseResponse({cmd:'fight_startgenieresp',...(seq?{resp:3}:{}),code:0,rawData:data});
    assert.equal(got.isWin,false);assert.equal(Object.keys(c.promises).length,0);
  }
});
