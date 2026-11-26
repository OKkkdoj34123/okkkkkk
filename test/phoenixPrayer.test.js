import test from 'node:test';
import assert from 'node:assert/strict';
import { drawSize, runPhoenixPrayer } from '../src/utils/batch/phoenixPrayer.js';

const day = Date.parse('2026-11-13T16:00:00+08:00');
const drawCmd = 'activity_lottery';
function scenario({today = 0, total = today, tickets = 10, signed = true, arena = 1} = {}) {
  const calls = [], ledger = new Map(), claimed = {}, milestones = {};
  const s = {today, total, tickets, signed, arena, roleId: 501, dailyTime: 1794499200};
  const storage = {getItem: k => ledger.get(k) ?? null, setItem: (k,v) => ledger.set(k,v), removeItem: k => ledger.delete(k)};
  const war = () => ({
    dailyTime: s.dailyTime, taskClaimed: {...claimed},
    complete: {261113101: 1, 261113102: s.arena, 261113103:s.today, 261113104:s.today, 261113105:s.today, 261113142:s.total, 261113143:s.total},
  });
  const activity = () => ({activity: {warOrderActivityInfo: {2611131: war()}, commonActivityInfo: {2611135: {record:s.signed ? {1:day/1000} : {}}}}});
  const send = async (cmd,body) => {
    calls.push([cmd,body]);
    if (cmd === 'fight_startlevel') return {battleData:{version:240523}};
    if (cmd === 'arena_startarea') return {};
    if (cmd === 'arena_getareatarget') return {roleList:[{roleId:502}]};
    if (cmd === 'fight_startareaarena') { assert.equal(body.battleVersion,240523); s.arena=1; return {}; }
    if (cmd === 'role_getroleinfo') return {role:{roleId:s.roleId, items:s.tickets ? {5295:{quantity:s.tickets}} : {}}};
    if (cmd === 'activity_get' || cmd === 'activity_warorderget') return activity();
    if (cmd === 'activity_getlotteryinfo') return {lotteryInfo:{...(s.total ? {lotteryNum:s.total}:{}), cumulativeClaimedMap:{...milestones}}};
    if (cmd === 'activity_claimsignreward') { s.signed=true; s.tickets+=10; return activity(); }
    if (cmd === drawCmd) { assert.ok(s.tickets >= body.times); s.tickets-=body.times; s.today+=body.times; s.total+=body.times; return {lotteryInfo:{lotteryNum:s.total}}; }
    if (cmd === 'activity_claimlotterycumulative') { assert.ok(!milestones[body.id]); milestones[body.id]=true; s.tickets++; return {lotteryInfo:{lotteryNum:0,cumulativeClaimedMap:{[body.id]:true}}}; }
    if (cmd === 'activity_warordertaskclaim') { assert.ok(!claimed[body.missionId]); claimed[body.missionId]=true; return activity(); }
    if (cmd === 'activity_warorderrewardclaim') { s.tickets+=5; return {...activity(),reward:[{itemId:5295,value:5}]}; }
    assert.fail(cmd);
  };
  return {s,calls,ledger,claimed,run:(opts={})=>runPhoenixPrayer({send,storage,now:()=>day,...opts}),send};
}
test('模拟首日且竞技场已完成：点卯10券，十连，6项任务、2个累计奖励，战令返5券；同日重跑只读',async()=>{
  const h=scenario({signed:false,tickets:0});
  await h.run(); assert.equal(h.s.today,10); assert.equal(h.s.tickets,7);
  assert.equal(Object.keys(h.claimed).length,6);
  const before=h.calls.length; await h.run();
  assert.ok(h.calls.slice(before).every(([c])=>['role_getroleinfo','activity_get','activity_getlotteryinfo','activity_warorderget'].includes(c)));
});
test('前日已抽20、今日手动抽7，补3次单抽；不能用本期总数充当日计数',async()=>{
  const h=scenario({today:7,total:27});await h.run();
  assert.deepEqual(h.calls.filter(([c])=>c===drawCmd).map(([,b])=>b.times),[1,1,1]);
  assert.equal(h.s.total,30);
});
test('已手动超过上限仍可领奖，不能再抽',async()=>{
  const h=scenario({today:20,tickets:50});await h.run();assert.equal(h.s.today,20);
  assert.ok(!h.calls.some(([c])=>c===drawCmd));
});
test('明确拒绝以外，超时跨刷新禁止重发，计数回读已落实才清除未决',async()=>{
  const h=scenario();await assert.rejects(h.run({send:(c,b)=>c===drawCmd?Promise.reject(Error('超时')):h.send(c,b)}),/超时/);
  await assert.rejects(h.run(),/上一次抽奖/);assert.equal(h.s.today,0);
  h.s.today=h.s.total=10;await h.run();assert.equal(h.s.today,10);
});
test('不同期、陈旧战令、角色不符均无抽奖',async()=>{
  const h=scenario();await h.run({now:()=>day+7*86400000});assert.equal(h.calls.length,0);
  await assert.rejects(h.run({expectedRole:502}),/账号/);
  h.s.dailyTime-=86400;await assert.rejects(h.run(),/日期/);
  assert.ok(!h.calls.some(([c])=>c===drawCmd));
});
test('有券不足10或已经部分完成均使用单抽；异常计数拒绝',()=>{
  for (let today=0; today<=12; today++) for (let tickets=0;tickets<=20;tickets++) {
    const n=drawSize(today,tickets);assert.ok(n<=tickets && n<=Math.max(0,10-today));
    assert.ok([0,1,10].includes(n));
  }
  assert.throws(()=>drawSize(undefined,10));assert.throws(()=>drawSize(0,-1));
});
test('回执序号过期的战令包不会落到旧通行证；旧无序号响应仍可结算',async()=>{
  const {registerHooks}=await import('node:module');
  const hook=registerHooks({resolve(id,ctx,next){
    if(id==='@/stores/cache'||id.endsWith('/logger.js')){
      const code='export const $CacheManager={};export const wsLogger={};export const gameLogger={}';
      return {url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true};
    }
    return next(id,ctx);
  }});
  try{
    const {CommandRegistry,registerDefaultCommands,XyzwWebSocketClient}=await import('../src/utils/xyzwWebSocket.js');
    const registry=new CommandRegistry();registerDefaultCommands(registry);
    assert.equal(registry.build(drawCmd,0,7,{times:10}).seq,7);
    const order={activityId:2611133,goodsId:261113303,quantity:1};
    assert.deepEqual(registry.build('activity_exchange',0,17,order).body,order);
    const c=Object.create(XyzwWebSocketClient.prototype);let resolved=false;
    c.promises={17:{originalCmd:'activity_exchange',resolve:()=>{resolved=true}}};
    c._handlePromiseResponse({cmd:'common_rewardresp',resp:16,code:0,rawData:{}});
    assert.equal(resolved,false);
    c._handlePromiseResponse({cmd:'common_rewardresp',resp:17,code:0,rawData:{}});
    assert.equal(resolved,true);resolved=false;
    c.promises={12:{originalCmd:'activity_recyclewarorderrewardclaim',resolve:()=>{resolved=true}}};
    c._handlePromiseResponse({cmd:'activity_warorderclaimresp',resp:11,code:0,rawData:{}});
    assert.equal(resolved,false);
    c._handlePromiseResponse({cmd:'activity_warorderclaimresp',code:0,rawData:{}});
    assert.equal(resolved,true);
  }finally{hook.deregister();}
});

test('竞技场未完成只挑战一次，回读达标后才点卯抽奖；重复执行不再挑战', async () => {
  const h=scenario({arena:0,signed:false,tickets:0});await h.run();
  assert.equal(h.calls.filter(([c])=>c==='fight_startareaarena').length,1);
  const fight=h.calls.findIndex(([c])=>c==='fight_startareaarena');
  const sign=h.calls.findIndex(([c])=>c==='activity_claimsignreward');assert.ok(sign>fight);
  assert.equal(h.s.today,10);assert.ok(h.claimed[261113102]);await h.run();
  assert.equal(h.calls.filter(([c])=>c==='fight_startareaarena').length,1);
});
test('竞技场战斗缺少本账号版本、对手无效、未开放，不消费抽奖券',async()=>{
  for(const kind of ['version','target','hour']) {
    const h=scenario({arena:0});await assert.rejects(h.run({now:()=>kind==='hour'?day-11*3600000:day,send:(c,b)=>{
      if(kind==='version'&&c==='fight_startlevel')return {};
      if(kind==='target'&&c==='arena_getareatarget')return {};
      return h.send(c,b);
    }}));
    assert.ok(!h.calls.some(([c])=>[drawCmd,'fight_startareaarena'].includes(c)));
  }
});
test('竞技场未决跨运行保留；回读进度才解除，不重放战斗',async()=>{
  for(const failure of ['timeout','unconfirmed']) {
    const h=scenario({arena:0});let writes=0;
    await assert.rejects(h.run({send:(c,b)=>{if(c==='fight_startareaarena'){writes++;if(failure==='timeout')throw Error('timeout');return {};}return h.send(c,b);}}));
    assert.equal(writes,1);await assert.rejects(h.run(),/待核验/);
    assert.ok(!h.calls.some(([c])=>c===drawCmd));h.s.arena=1;await h.run();assert.equal(h.s.today,10);
  }
});
test('竞技场期间停止、跨日或角色变化均中止祈愿；不执行无关日常',async()=>{
  for(const kind of ['stop','day','role']) {
    const h=scenario({arena:0});let now=day,stopped=false;
    await assert.rejects(h.run({now:()=>now,stopped:()=>stopped,send:async(c,b)=>{
      const result=await h.send(c,b);if(c==='fight_startareaarena') {if(kind==='stop')stopped=true;if(kind==='day')now+=86400000;if(kind==='role')h.s.roleId=503;}return result;
    }}));assert.ok(!h.calls.some(([c])=>c===drawCmd));
  }
});
test('明确服务器拒绝不保留竞技场未决，但仍停止本轮',async()=>{
 const h=scenario({arena:0});await assert.rejects(h.run({send:(c,b)=>{if(c==='fight_startareaarena')throw Object.assign(Error('reject'),{code:200750,requestCmd:c});return h.send(c,b);}}));
 assert.ok(![...h.ledger.keys()].some(k=>k.endsWith(':arena')));assert.ok(!h.calls.some(([c])=>c===drawCmd));
});

test('批量入口模拟网络与时钟：每次回包后等待1000ms；仅当前账号挑战一次', async t => {
  const {batchPhoenixPrayer}=await import('../src/utils/batch/tasksPhoenixPrayer.js');
  const h=scenario({today:8,total:8,arena:0}); let clock=0,done=false,closed=0;
  const times=[];const props=['navigator','localStorage'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(n,o,fn)=>fn({})}}});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>h.ledger.get(k)??null,setItem:(k,v)=>h.ledger.set(k,v),removeItem:k=>h.ledger.delete(k)}});
  t.mock.timers.enable({apis:['setTimeout','Date'],now:day});
  const d={isBusy:()=>false,selectedTokens:{value:['A']},tokens:{value:[{id:'A',roleId:501}]},isRunning:{value:false},shouldStop:{value:false},currentRunningTokenId:{value:null},tokenStatus:{value:{}},
    message:{error:assert.fail,warning:assert.fail},addLog:()=>{},acquireLease:async()=>1,releaseLease:async()=>{},openReadOnly:async()=>{},closeReadOnly:async()=>{closed++;},
    tokenStore:{sendMessageWithPromise:async(id,c,b)=>{assert.equal(id,'A');times.push(clock);return h.send(c,b);}}};
  try {
    const p=batchPhoenixPrayer(d).finally(()=>{done=true;});
    for(let i=0;i<200&&!done;i++) {for(let j=0;j<30;j++)await Promise.resolve();clock+=999;t.mock.timers.tick(999);for(let j=0;j<30;j++)await Promise.resolve();clock++;t.mock.timers.tick(1);}
    assert.equal(done,true);const rows=await p;assert.deepEqual(rows.map(row=>row.status),['completed']);assert.equal(rows[0].tokenId,'A');assert.ok(rows[0].details.length);
    assert.equal(h.calls.filter(([c])=>c==='fight_startareaarena').length,1);assert.equal(closed,1);assert.equal(d.tokenStatus.value.A,'completed');assert.equal(h.s.today,10);
    assert.ok(times.length>5);assert.ok(times.slice(1).every((time,i)=>time-times[i]>=1000));
    assert.equal(d.isRunning.value,false);
  } finally {t.mock.timers.reset();for(const [key,desc] of props)desc?Object.defineProperty(globalThis,key,desc):delete globalThis[key];}
});

test('Vue祈愿入口无需完整日常执行器，避免配置/无关日常中断祈愿',async()=>{
 const {readFileSync}=await import('node:fs');const vue=readFileSync(new URL('../src/views/BatchDailyTasks.vue',import.meta.url),'utf8');
 const body=vue.match(/const handlePhoenixPrayer = async \(\) => \{([\s\S]*?)\n\};/)[1];
 const run=new Function('batchPhoenixPrayer','createTaskDeps','isRunning','autoExecutionActive','scheduledExecutionActive','openGenieReadOnly','closeGenieReadOnly','acquireTaskPreemption','releasePreemptionLease','message','return async()=>{'+body+'}');
 let calls=0;await run(async d=>{calls++;assert.equal(d.runDaily,undefined);},()=>({}),{value:false},{value:false},{value:false},()=>{},()=>{},()=>{},()=>{},{error:assert.fail})();assert.equal(calls,1);
});
