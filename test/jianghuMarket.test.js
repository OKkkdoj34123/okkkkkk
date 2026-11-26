import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JIANGHU_GOODS,marketState,marketPlan,normalizeMarketList,createMarketLedger,runJianghuMarket} from '../src/utils/batch/jianghuMarket.js';
const f=JSON.parse(readFileSync(new URL('./fixtures/jianghu-market-real.json',import.meta.url))),now=1793276200000;
function harness({ids=[1,2],diamond=50000,count={},fail='',applies=true,stopAfter=Infinity}={}) {
 const activity=structuredClone(f.before);activity.activity.myStoreInfo['9'].complete={...count};let cash=diamond,stop=false,buys=0;
 const map=new Map(),ledger=createMarketLedger({getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}),calls=[];
 const options={id:'fixture-account',list:ids.map(id=>({id,quantity:1})),ledger,now:()=>now,stopped:()=>stop,send:async(cmd,b)=>{
 calls.push({cmd,b});if(cmd==='role_getroleinfo')return {role:{diamond:cash}};if(cmd==='activity_get')return structuredClone(activity);
 assert.equal(cmd,'activity_buystoregoods');buys++;const g=activity.activity.activity[0].data.goodsList[b.goodsIndex];
 if(applies){cash-=g.price;const complete=activity.activity.myStoreInfo['9'].complete;complete[b.goodsIndex]=(complete[b.goodsIndex]||0)+1;}
 if(buys>=stopAfter)stop=true;if(fail)throw Error(fail);return {reward:structuredClone(g.rewardList)};
 }};
 return {options,calls,activity,ledger,buys:()=>buys,cash:()=>cash};
}
test('real before/after has six new purchase records and consistent price/rewards',()=>{
 const a=marketState(f.before,now),b=marketState(f.after,now);for(const x of f.buys){assert.equal(a.complete[x.request.goodsIndex]??0,0);assert.equal(b.complete[x.request.goodsIndex],1);}
 assert.equal(marketPlan(a,[1,2,3,4,6,8].map(id=>({id,quantity:1})),200439).total,46300);
 assert.equal(marketPlan(a,JIANGHU_GOODS.map(g=>({id:g.id,quantity:1})),100000).total,64300);
});
test('insufficient for entire unbought list sends zero purchases',async()=>{const h=harness({diamond:1799});const r=await runJianghuMarket(h.options);assert.equal(r.status,'insufficient');assert.equal(h.buys(),0);assert.match(r.message,/1800/);});
test('exact funds succeed and ordered selection preserved',async()=>{const h=harness({ids:[2,1],diamond:1800});const r=await runJianghuMarket(h.options);assert.equal(r.status,'completed');assert.equal(h.cash(),0);assert.deepEqual(h.calls.filter(c=>c.cmd==='activity_buystoregoods').map(c=>c.b.goodsIndex),[2,1]);});
test('already purchased excluded from budget and fully completed rerun does not buy',async()=>{const h=harness({count:{1:1},diamond:1200});const r=await runJianghuMarket(h.options);assert.equal(r.bought,1);assert.equal((await runJianghuMarket(h.options)).status,'skipped');assert.equal(h.buys(),1);});
test('ID9 desired period total four, only remaining quantity purchased',async()=>{const h=harness({ids:[9],count:{9:2}});h.options.list[0].quantity=4;const r=await runJianghuMarket(h.options);assert.equal(r.bought,2);assert.equal(r.spent,16000);assert.equal((await runJianghuMarket(h.options)).status,'skipped');});
test('invalid selections rejected',()=>{for(const l of [[],[{id:0,quantity:1}],[{id:9,quantity:5}],[{id:1,quantity:2}],[{id:1,quantity:1},{id:1,quantity:1}]])assert.throws(()=>normalizeMarketList(l));});
test('closed activity and changed catalog never buy',async()=>{for(const mode of ['closed','price','reward','limit']){const h=harness();const a=h.activity.activity.activity[0];if(mode==='closed')a.endTime=now;else if(mode==='reward')a.data.goodsList[1].rewardList[0].value++;else a.data.goodsList[1][mode]++;const r=await runJianghuMarket(h.options);assert.notEqual(r.status,'completed');assert.equal(h.buys(),0);}});
test('stop after first purchase still reconciles then sends no second',async()=>{const h=harness({stopAfter:1});const r=await runJianghuMarket(h.options);assert.equal(r.status,'stopped');assert.equal(r.bought,1);assert.equal(h.buys(),1);assert.equal(h.ledger.get(h.options.id),null);});
test('timeout accepted purchase reconciled and never automatically retries',async()=>{const h=harness({fail:'timeout'});const r=await runJianghuMarket(h.options);assert.equal(r.status,'reconciled');assert.equal(h.buys(),1);assert.equal(h.ledger.get(h.options.id),null);});
test('timeout without observed purchase blocks reload replay',async()=>{const h=harness({fail:'timeout',applies:false});assert.equal((await runJianghuMarket(h.options)).status,'unverified');assert.equal((await runJianghuMarket(h.options)).status,'unverified');assert.equal(h.buys(),1);});
test('ledger storage failure precedes any mutation',async()=>{const h=harness();h.ledger.set=()=>{throw Error('storage full');};await runJianghuMarket(h.options);assert.equal(h.buys(),0);});
test('unexpected reward keeps pending and stops subsequent items',async()=>{const h=harness();const send=h.options.send;h.options.send=async(cmd,b)=>{const r=await send(cmd,b);if(cmd==='activity_buystoregoods')r.reward=[];return r;};const r=await runJianghuMarket(h.options);assert.equal(r.status,'unverified');assert.equal(h.buys(),1);assert.ok(h.ledger.get(h.options.id));});
test('transport registers activity buy and shared syncreward response',()=>{const s=readFileSync(new URL('../src/utils/xyzwWebSocket.js',import.meta.url),'utf8');assert.match(s,/\.register\("activity_buystoregoods"\)/);assert.match(s,/syncrewardresp:\s*\[\s*"activity_buystoregoods"/);});

test('live BON dates and exported ISO timestamps share the same activity period',()=>{
 const expected=marketState(f.before,now).period;
 for(const convert of [v=>new Date(v),v=>new Date(v).toISOString()]){const copy=structuredClone(f.before),a=copy.activity.activity[0];a.openTime=convert(a.openTime);a.endTime=convert(a.endTime);assert.equal(marketState(copy,now).period,expected);}
 const invalid=structuredClone(f.before);invalid.activity.activity[0].openTime=new Date(NaN);assert.throws(()=>marketState(invalid,now));
});

test('balance change after first purchase stops before the next purchase',async()=>{
 const h=harness({diamond:1800}),send=h.options.send;
 h.options.send=async(cmd,b)=>{const r=await send(cmd,b);if(cmd==='role_getroleinfo'&&h.buys()===1&&h.calls.filter(c=>c.cmd==='role_getroleinfo').length>=4)r.role.diamond=100;return r;};
 const r=await runJianghuMarket(h.options);assert.equal(r.status,'insufficient');assert.equal(h.buys(),1);assert.equal(r.bought,1);
});
test('pending purchase from another period prevents new purchases',async()=>{
 const h=harness();h.ledger.set(h.options.id,{period:'old',goodsIndex:1,beforeCount:0});
 assert.equal((await runJianghuMarket(h.options)).status,'unverified');assert.equal(h.buys(),0);assert.ok(h.ledger.get(h.options.id));
});
