import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {runPhoenixPrayer} from '../src/utils/batch/phoenixPrayer.js';
const capture=JSON.parse(readFileSync(new URL('./fixtures/phoenix-live-20261114.json',import.meta.url),'utf8'));
for(const account of capture.accounts) test('脱敏实服回放 '+account.alias+'：竞技场1次、当日10抽、重复运行零战斗零抽奖',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 let taskClaimed=structuredClone(account.initialTaskClaimed),cumulativeClaimedMap=structuredClone(account.initialCumulativeClaimed);
 for(const [index,records] of account.runs.entries()) {
  let pos=0;const result=await runPhoenixPrayer({storage,expectedRole:account.roleId,now:()=>records[0].at,send:async(cmd,args)=>{
   const expected=records[pos++];assert.ok(expected,cmd);assert.equal(cmd,expected.cmd);assert.deepEqual(args,expected.args);assert.equal(expected.code,0);const reply=structuredClone(expected.data);
   if(['activity_get','activity_warorderget'].includes(cmd)) {
    const war=reply.activity?.warOrderActivityInfo?.[2611131];if(war)war.taskClaimed=structuredClone(taskClaimed);
   }
   if(cmd==='activity_getlotteryinfo')reply.lotteryInfo.cumulativeClaimedMap=structuredClone(cumulativeClaimedMap);
   if(cmd==='activity_warordertaskclaim')taskClaimed={...taskClaimed,...reply.activity.warOrderActivityInfo[2611131].taskClaimed};
   if(cmd==='activity_claimlotterycumulative')cumulativeClaimedMap={...cumulativeClaimedMap,...reply.lotteryInfo.cumulativeClaimedMap};
   return reply;
  }});
  assert.equal(pos,records.length);assert.match(result,/10\/10 次，剩券 9/);
  assert.equal(records.filter(r=>r.cmd==='fight_startareaarena').length,index?0:1);
  assert.deepEqual(records.filter(r=>r.cmd==='activity_lottery').map(r=>r.args.times),index?[]:account.expectedDraws);
  if(index) assert.ok(records.every(r=>['role_getroleinfo','activity_get','activity_warorderget','activity_getlotteryinfo'].includes(r.cmd)));
 }
 assert.equal(account.final.dailyTask.complete[13],1);assert.equal(account.final.items[5295].quantity,9);
});
