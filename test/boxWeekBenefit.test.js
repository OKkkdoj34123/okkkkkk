import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRouter, createMemoryHistory } from 'vue-router';
import { dailyConnectionFailure } from '../src/utils/batch/dailyConnectionPolicy.js';
import { getActivityCycle } from '../src/utils/autoSchedule/activityCycle.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/boxWeekBenefit-20261107.json', import.meta.url), 'utf8'));
const recruitFixture = JSON.parse(readFileSync(new URL('./fixtures/recruitWeekBenefit-20261120.json', import.meta.url), 'utf8'));
const raw = readFileSync(new URL('../src/utils/dailyTaskRunner.js', import.meta.url), 'utf8');
const source = raw.replace(/^import\s[\s\S]*?from\s*["'][^"']+["'];\s*/gm, '').replace('export class DailyTaskRunner', 'class DailyTaskRunner');
const NOW = Date.parse('2026-11-07T00:12:00+08:00');
class Clock extends Date { static now() { return NOW; } }
function storage() { const values = new Map(); return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values}; }
function harness({ selectedFixture = fixture, activityId = 7, clock = Clock, mutate, used = 0, fail, store = storage(), afterUsed = 1, stopOnClaim = false, missingReward = false, locks } = {}) {
  const calls = []; let stopped = false, closed = 0;
  const catalog = structuredClone(selectedFixture.activity); catalog.myStoreInfo[activityId].complete = used ? {'0':used} : {};
  mutate?.(catalog);
  const globals = {localStorage:store,navigator:locks?{locks}:undefined};
  const Runner = new Function('dailyConnectionFailure', 'Date', 'globalThis', source+';return DailyTaskRunner;')(dailyConnectionFailure,clock,globals);
  const runner = Object.create(Runner.prototype);
  const send = async (id,cmd,params) => {
    calls.push({cmd,params}); const count = calls.filter(c=>c.cmd==='activity_get').length;
    const error = fail?.(cmd,count); if(error) throw error;
    if(cmd==='activity_get') {
      const activity = structuredClone(catalog);
      if(count>1)activity.myStoreInfo[activityId].complete = {'0':afterUsed};
      return {activity};
    }
    if(cmd==='activity_buystoregoods') { if(stopOnClaim) stopped=true; return {reward:missingReward?[]:selectedFixture.reward}; }
    throw new Error('Unexpected command '+cmd);
  };
  runner.tokenStore = {sendMessageWithPromise:send,closeWebSocketConnectionAsync:async()=>{closed++;},getWebSocketStatus:()=> 'connected'};
  runner.checkCancelled = () => { if(stopped)throw Object.assign(new Error('stopped'),{stopped:true}); };
  runner.executeGameCommand = (id,cmd,params) => {runner.checkCancelled();return send(id,cmd,params);};
  runner.log = () => {};
  return {calls,store,runner,closed:()=>closed,run:()=>runner.claimBoxWeekBenefit('A',{roleId:501},activityId),writes:()=>calls.filter(c=>c.cmd==='activity_buystoregoods')};
}
test('captured free catalog: one claim, matching reward and readback; next run skips',async()=>{
 const h=harness();assert.equal((await h.run()).taskStatus,'completed');assert.deepEqual(h.writes().map(c=>c.params),[{activityId:7,goodsIndex:0,buyNum:1}]);assert.equal(h.store.values.size,0);
 const again=harness({used:1,store:h.store});assert.equal((await again.run()).taskStatus,'skipped');assert.equal(again.writes().length,0);
 // Stop after a submitted request still permits the mandatory readback.
 const stop=harness({stopOnClaim:true});assert.equal((await stop.run()).taskStatus,'completed');assert.equal(stop.calls.filter(c=>c.cmd==='activity_get').length,2);
});
test('unavailable, changed or incomplete catalog never sends a claim',async()=>{
 for(const mutate of [a=>a.activity=[],a=>a.activity[0].endTime=NOW-1,a=>a.activity[0].openTime=NOW+1,
  a=>a.activity[0].data.goodsList[0].price=1,a=>a.activity[0].data.goodsList[0].limit=2,
  a=>a.activity[0].data.goodsList[0].rewardList[0].value=999,a=>delete a.myStoreInfo['7'],
  a=>a.myStoreInfo['7'].complete={'0':null}]) {
  const h=harness({mutate});assert.notEqual((await h.run()).taskStatus,'completed');assert.equal(h.writes().length,0);
 }
 const noStorage=harness({store:{getItem(){throw new Error('denied');}}});assert.equal((await noStorage.run()).taskStatus,'warning');assert.equal(noStorage.writes().length,0);
});
test('claim timeout persists across instances, closes queued transport, never replays',async()=>{
 const h=harness({fail:cmd=>cmd==='activity_buystoregoods'?new Error('timeout'):null});await assert.rejects(h.run(),e=>e.haltDaily===true);assert.equal(h.writes().length,1);assert.equal(h.closed(),1);assert.equal(h.store.values.size,1);
 const retry=harness({store:h.store});assert.equal((await retry.run()).taskStatus,'warning');assert.equal(retry.writes().length,0);
 const resolved=harness({store:h.store,used:1});assert.equal((await resolved.run()).taskStatus,'skipped');assert.equal(h.store.values.size,0);
});
test('missing reward or unconfirmed/failed readback retains pending marker',async()=>{
 for(const opts of [{missingReward:true},{afterUsed:0}]) {const h=harness(opts);assert.equal((await h.run()).taskStatus,'warning');assert.equal(h.store.values.size,1);assert.equal(h.writes().length,1);}
 const h=harness({fail:(cmd,n)=>cmd==='activity_get'&&n===2?new Error('timeout'):null});await assert.rejects(h.run());assert.equal(h.store.values.size,1);assert.equal(h.writes().length,1);
});
test('concurrent invocation and unavailable cross-tab lock perform at most one claim',async()=>{
 const h=harness();const results=await Promise.all([h.run(),h.run()]);assert.equal(h.writes().length,1);assert.ok(results.some(r=>r.taskStatus==='skipped'));
 const locked=harness({locks:{request:async(name,opts,fn)=>fn(null)}});assert.equal((await locked.run()).taskStatus,'skipped');assert.equal(locked.calls.length,0);
});
test('/tokens keeps public import params and layout, and disposes task caches as before',()=>{
 const script=readFileSync(new URL('../src/router/index.js',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace('export default router','return router');
 const router=new Function('createRouter','createWebHistory','autoRoutes','useTokenStore','isNowInLegionWarTime',script)(createRouter,createMemoryHistory,{routes:[]},()=>({hasTokens:false}),()=>true);
 const target=router.resolve('/tokens?token=placeholder&name=test&server=7&wsUrl=wss%3A%2F%2Fexample.invalid&api=https%3A%2F%2Fexample.invalid&auto=true');
 assert.equal(target.name,'TokenImport');assert.equal(target.meta.requiresToken,false);assert.equal(target.matched[0].name,'DefaultLayout');assert.deepEqual(target.matched.at(-1).props.default(target),{token:'placeholder',name:'test',server:'7',wsUrl:'wss://example.invalid',api:'https://example.invalid',auto:true});
 const layout=readFileSync(new URL('../src/layout/DefaultLayout.vue',import.meta.url),'utf8');const body=layout.match(/const cachedViewNames = computed\(\(\) => \{([\s\S]*?)\n\}\);/)[1];const included=new Function('route',body);
 assert.deepEqual(included({name:'TokenImport'}),[]);assert.deepEqual(included({name:'BatchDailyTasks'}),['BatchDailyTasks','PushingLevels']);assert.deepEqual(included({name:'MessageTest'}),['BatchDailyTasks']);
});

test('金砖商店200与江湖黑市500使用各自免费目录、已领记录和独立防重键', async()=>{
 const captured=JSON.parse(readFileSync(new URL('./fixtures/freeWeekBenefit-20261114.json',import.meta.url),'utf8'));
 class MarketClock extends Date {static now(){return Date.parse('2026-11-14T10:00:00+08:00');}}
 const shared=storage();
 for(const activityId of [5,9]) {
   const opts={activityId,selectedFixture:captured.benefits[activityId],clock:MarketClock};
   const h=harness(opts);assert.equal((await h.run()).taskStatus,'completed');
   assert.deepEqual(h.writes().map(c=>c.params),[{activityId,goodsIndex:0,buyNum:1}]);
   const already=harness({...opts,used:1});assert.equal((await already.run()).taskStatus,'skipped');assert.equal(already.writes().length,0);
   for(const mutate of [a=>a.activity[0].data.goodsList[0].price=1,a=>a.activity[0].data.goodsList[0].rewardList[0].value=999,a=>delete a.myStoreInfo[activityId],a=>a.activity[0].data.buyType=2]) {
     const invalid=harness({...opts,mutate});assert.equal((await invalid.run()).taskStatus,'warning');assert.equal(invalid.writes().length,0);
   }
   const timeout=harness({...opts,store:shared,fail:cmd=>cmd==='activity_buystoregoods'?Error('timeout'):null});await assert.rejects(timeout.run());
   const retry=harness({...opts,store:shared});assert.equal((await retry.run()).taskStatus,'warning');assert.equal(retry.writes().length,0);
   const unread=harness({...opts,afterUsed:0});assert.equal((await unread.run()).taskStatus,'warning');assert.equal(unread.store.values.size,1);
 }
 assert.equal(shared.values.size,2);
 assert.equal(captured.benefits[5].diamond,11348+200);assert.equal(captured.benefits[9].diamond,11348+200+500);
});

test('招募周活动6按实服目录领取5个招募令，并保留未决保护', async () => {
 class RecruitClock extends Date { static now() { return Date.parse('2026-11-20T20:31:00+08:00'); } }
 const opts = { selectedFixture: recruitFixture, activityId: 6, clock: RecruitClock };
 const h = harness(opts);
 assert.equal((await h.run()).taskStatus, 'completed');
 assert.deepEqual(h.writes().map(c => c.params), [{ activityId: 6, goodsIndex: 0, buyNum: 1 }]);
 assert.deepEqual(h.calls.map(c => c.cmd), ['activity_get', 'activity_buystoregoods', 'activity_get']);
 assert.equal(h.store.values.size, 0);

 const already = harness({ ...opts, used: 1 });
 assert.equal((await already.run()).taskStatus, 'skipped');
 assert.equal(already.writes().length, 0);

 for (const mutate of [
  a => a.activity[0].type = 5,
  a => a.activity[0].data.buyType = 3,
  a => a.activity[0].data.goodsList[0].price = 1,
  a => a.activity[0].data.goodsList[0].limit = 2,
  a => a.activity[0].data.goodsList[0].rewardList[0].type = 2,
  a => a.activity[0].data.goodsList[0].rewardList[0].itemId = 1002,
  a => a.activity[0].data.goodsList[0].rewardList[0].value = 6,
  a => delete a.myStoreInfo['6'],
  a => a.myStoreInfo['6'].complete = { '0': 2 },
 ]) {
  const invalid = harness({ ...opts, mutate });
  assert.equal((await invalid.run()).taskStatus, 'warning');
  assert.equal(invalid.writes().length, 0);
 }

 const shared = storage();
 const timeout = harness({
  ...opts, store: shared,
  fail: cmd => cmd === 'activity_buystoregoods' ? new Error('timeout') : null,
 });
 await assert.rejects(timeout.run(), error => error.haltDaily === true);
 assert.equal(timeout.writes().length, 1);
 const retry = harness({ ...opts, store: shared });
 assert.equal((await retry.run()).taskStatus, 'warning');
 assert.equal(retry.writes().length, 0);

 const unread = harness({ ...opts, afterUsed: 0 });
 assert.equal((await unread.run()).taskStatus, 'warning');
 assert.equal(unread.store.values.size, 1);
});

test('北京时间活动周期分别映射黑市周、招募周和宝箱周', () => {
 assert.equal(getActivityCycle(Date.parse('2026-11-13T12:00:00+08:00')).type, 'blackMarket');
 assert.equal(getActivityCycle(Date.parse('2026-11-20T12:00:00+08:00')).type, 'recruit');
 assert.equal(getActivityCycle(Date.parse('2026-11-27T12:00:00+08:00')).type, 'box');

 const normalizedRaw = raw.replace(/\r\n?/g, '\n');
 const start = normalizedRaw.indexOf('const benefitWeek = getActivityCycle(Date.now()).type;');
 const end = normalizedRaw.indexOf('\n\n    if (isTodayAvailable', start);
 assert.ok(start >= 0 && end > start, 'weekly benefit dispatch block exists');
 const dispatch = normalizedRaw.slice(start, end);
 assert.match(dispatch, /benefitWeek === "blackMarket"[\s\S]*claimBoxWeekBenefit\(tokenId, roleData, 5\)[\s\S]*claimBoxWeekBenefit\(tokenId, roleData, 9\)/);
 assert.match(dispatch, /benefitWeek === "recruit"[\s\S]*claimBoxWeekBenefit\(tokenId, roleData, 6\)/);
 assert.match(dispatch, /benefitWeek === "box"[\s\S]*claimBoxWeekBenefit\(tokenId, roleData, 7\)/);
});

