// JIANGHU_MARKET_20261029 — server activity 9, independent of store_purchase.
const spec=[
 [1,'招募令×5＋精铁×1000',600,1,[[1001,5],[1006,1000]]],
 [2,'招募令×10＋进阶石×2000',1200,1,[[1001,10],[1003,2000]]],
 [3,'进阶石×6000',2500,1,[[1003,6000]]],
 [4,'四种宝箱各×10',5000,1,[[2001,10],[2002,10],[2003,10],[2004,10]]],
 [5,'招募令×40＋红色随机碎片×50',8000,1,[[1001,40],[3007,50]]],
 [6,'普通鱼竿×30＋黄金鱼竿×30',12000,1,[[1011,30],[1012,30]]],
 [7,'白玉×2000',2000,1,[[1022,2000]]],
 [8,'灵贝×10',25000,1,[[1033,10]]],
 [9,'扳手×3000＋晶石×2000',8000,4,[[1016,2000],[1026,3000]]],
];
export const JIANGHU_GOODS=spec.map(([id,label,price,limit,rewards])=>({id,label,price,limit,rewards}));
const fail=(message,status='unverified')=>Object.assign(new Error(message),{status});
const unwrap=r=>{if(r?.code!==undefined&&r.code!==0)throw fail(`服务器拒绝（${r.code}）`);return r?.data??r;};
export function normalizeMarketList(list) {
 if(!Array.isArray(list)||!list.length)throw fail('请先选择购买清单','conditions');
 const seen=new Set();return list.map(e=>{
  const good=JIANGHU_GOODS.find(g=>g.id===e.id);
  if(!good||seen.has(e.id)||!Number.isInteger(e.quantity)||e.quantity<1||e.quantity>good.limit)throw fail('购买清单重复或份数无效','conditions');
  seen.add(e.id);return {id:e.id,quantity:e.quantity};
 });
}
const rewardKey=raw=>{
 if(!Array.isArray(raw))throw fail('奖励列表缺失');
 return JSON.stringify(raw.map(r=>[r.type,r.itemId,r.value,r.ext??0]).sort((a,b)=>a[1]-b[1]));
};
const activityTime=v=>v instanceof Date?v.getTime():typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)?Date.parse(v):v;
export function marketState(response,now=Date.now()) {
 const a=unwrap(response)?.activity;
 if(!a||!Array.isArray(a.activity)||!a.myStoreInfo||typeof a.myStoreInfo!=='object')throw fail('活动查询字段缺失');
 const active=a.activity.find(a=>a.id===9);
 if(!active)throw fail('江湖黑市未开放','closed');
 const openTime=activityTime(active.openTime),endTime=activityTime(active.endTime);
 if(!Number.isSafeInteger(openTime)||!Number.isSafeInteger(endTime)||endTime<=openTime)throw fail('活动有效期无效');
 if(now<openTime||now>=endTime)throw fail('江湖黑市不在开放时间内','closed');
 if(active.data?.buyType!==3||!Array.isArray(active.data.goodsList))throw fail('活动货币或商品目录异常');
 const complete=a.myStoreInfo['9']?.complete??{};
 if(!complete||typeof complete!=='object'||Array.isArray(complete))throw fail('已购状态格式异常');
 for(const n of Object.values(complete))if(!Number.isSafeInteger(n)||n<0)throw fail('已购数量异常');
 return {period:`${openTime}:${endTime}`,endTime,goods:active.data.goodsList,complete};
}
function checkedGood(state,id) {
 const spec=JIANGHU_GOODS.find(g=>g.id===id),g=state.goods[id];
 if(!g||g.price!==spec.price||g.limit!==spec.limit||rewardKey(g.rewardList)!==rewardKey(spec.rewards.map(([itemId,value])=>({type:3,itemId,value,ext:0}))))throw fail(`商品${id}价格、限购或奖励已变化，请更新清单`);
 return g;
}
export function marketPlan(state,list,diamond) {
 if(!Number.isSafeInteger(diamond)||diamond<0)throw fail('金砖余额无效');
 const orders=normalizeMarketList(list).map(e=>{
  const g=checkedGood(state,e.id),used=state.complete[e.id]??0;
  if(used>g.limit)throw fail(`商品${e.id}购买记录超过限购`);
  return {...e,used,remaining:Math.max(0,e.quantity-used),price:g.price};
 });
 const total=orders.reduce((n,e)=>n+e.remaining*e.price,0);
 return {orders,total,affordable:diamond>=total,diamond};
}
export function createMarketLedger(storage) {
 const key=id=>`xyzw_jianghu_pending_v1:${id}`;
 return {get(id){try{return JSON.parse(storage.getItem(key(id))||'null');}catch{throw fail('购买记录读取失败');}},
 set(id,v){storage.setItem(key(id),JSON.stringify(v));},clear(id){storage.removeItem(key(id));}};
}
export async function runJianghuMarket({id,list,send,ledger,now=()=>Date.now(),stopped=()=>false,onLog=()=>{},onUncertain=async()=>{}}) {
 const result={status:'unverified',bought:0,spent:0,skipped:0};let phase='读取活动和余额';
 const checkStop=()=>{if(stopped())throw fail('用户主动停止','stopped');};
 const read=async()=>{
  const role=unwrap(await send('role_getroleinfo',{}))?.role;
  const state=marketState(await send('activity_get',{}),now());
  if(!role)throw fail('角色返回缺失');return {state,diamond:role.diamond};
 };
 try {
  const selected=normalizeMarketList(list);checkStop();let current=await read();checkStop();
  const pending=ledger.get(id);
  if(pending){
   if(pending.period!==current.state.period)throw fail('存在其他期次未决购买，需核对；未自动清除');
   checkedGood(current.state,pending.goodsIndex);
   if(current.state.complete[pending.goodsIndex]===pending.beforeCount+1){ledger.clear(id);return {...result,status:'reconciled',message:'上次购买已通过本期已购记录核对；本次未购买，请再次开始'};}
   throw fail('上次购买结果仍不明，未重发');
  }
  let plan=marketPlan(current.state,selected,current.diamond);result.skipped=plan.orders.reduce((n,e)=>n+(e.remaining===0?1:0),0);
  if(!plan.total)return {...result,status:'skipped',message:'所选礼包已达到本期目标份数，无需购买'};
  if(!plan.affordable)return {...result,status:'insufficient',message:`金砖不足：现有${plan.diamond}，未购清单需${plan.total}，缺少${plan.total-plan.diamond}；本账号未执行购买`};
  const period=current.state.period;
  onLog(`开始：未购清单需${plan.total}金砖，现有${plan.diamond}；按清单顺序购买`);
  for(const order of plan.orders)for(let n=0;n<order.remaining;n++){
   checkStop();phase='购买前核对';current=await read();checkStop();
   if(current.state.period!==period)throw fail('活动期次发生变化');
   plan=marketPlan(current.state,selected,current.diamond);
   if(!plan.affordable)throw fail(`余额变化，现有${plan.diamond}，剩余清单需${plan.total}；停止后续购买`,'insufficient');
   const beforeCount=current.state.complete[order.id]??0;
   if(beforeCount>=order.quantity)break;
   const marker={period,goodsIndex:order.id,beforeCount,diamond:current.diamond,price:order.price};
   checkStop();ledger.set(id,marker);phase=`购买商品${order.id}`;
   let response;
   try {response=unwrap(await send('activity_buystoregoods',{activityId:9,goodsIndex:order.id,buyNum:1}));}
   catch(error){
    if(error?.notSent){ledger.clear(id);throw error;}
    await onUncertain();
    try{const recovered=await read();if(recovered.state.period===period&&recovered.state.complete[order.id]===beforeCount+1){ledger.clear(id);return {...result,status:'reconciled',message:`商品${order.id}回包异常，但已购记录确认增加；未重发，停止本账号。此前确认${result.bought}份`};}}catch{}
    throw fail(`商品${order.id}请求异常，已保留未决记录，未重发`);
   }
   phase=`核对商品${order.id}购买结果`;
   const after=await read();
   if(after.state.period!==period||after.state.complete[order.id]!==beforeCount+1||after.diamond!==current.diamond-order.price||rewardKey(response.reward)!==rewardKey(checkedGood(current.state,order.id).rewardList))throw fail(`商品${order.id}奖励、余额或已购记录不一致，停止核验，未重发`);
   ledger.clear(id);result.bought++;result.spent+=order.price;
   onLog(`商品${order.id}购买成功，本期${beforeCount+1}/${order.quantity}份，剩余${after.diamond}金砖`);
  }
  return {...result,status:'completed',message:`完成：购买${result.bought}份，消耗${result.spent}金砖，${result.skipped}项已达目标跳过`};
 }catch(e){return {...result,status:e?.status||'unverified',message:`${phase}：${e?.status?e.message:/timeout|超时/i.test(e?.message||'')?'请求超时':Number.isFinite(e?.code)?`服务器错误码${e.code}`:'请求或本地存储异常'}；已确认${result.bought}份、消耗${result.spent}金砖`};}
}
