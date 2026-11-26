import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {removeRetiredTasks} from '../src/utils/batch/retiredActivities.js';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('历史混合定时保留其他步骤，纯宝库/车辆任务禁用；迁移幂等、不改历史输入',()=>{
 const old={id:1,enabled:true,selectedTasks:['batchbaoku13','startBatch','batchbaoku45','batchmengjing','batchSmartSendCar','batchClaimCars'],selectedTokens:['A']};
 const migrated=removeRetiredTasks(old);assert.deepEqual(migrated.selectedTasks,['startBatch','batchmengjing']);assert.equal(migrated.enabled,true);assert.equal(old.selectedTasks.length,6);assert.deepEqual(removeRetiredTasks(migrated),migrated);
 assert.equal(removeRetiredTasks({...old,selectedTasks:['batchbaoku45']}).enabled,false);
 assert.equal(removeRetiredTasks({...old,selectedTasks:['batchSmartSendCar','batchClaimCars']}).enabled,false);
 assert.deepEqual(removeRetiredTasks({...old,enabled:false}).enabled,false);
});
test('加载旧定时配置时落盘清理，导入也调用迁移；不存在宝库入口、执行器或专用协议',()=>{
 const vue=read('src/views/BatchDailyTasks.vue');let saved=JSON.stringify([{id:1,enabled:true,selectedTasks:['batchbaoku13']},{id:2,enabled:true,selectedTasks:['startBatch','batchbaoku45']}]);
 const body=vue.match(/const loadScheduledTasks = \(\) => \{([\s\S]*?)\n\};/)[1];const ref={value:[]};
 new Function('localStorage','scheduledTasks','removeRetiredTasks',body)({getItem:()=>saved,setItem:(k,v)=>{saved=v}},ref,removeRetiredTasks);
 assert.equal(ref.value[0].enabled,false);assert.deepEqual(JSON.parse(saved)[1].selectedTasks,['startBatch']);
 const memory={value:[]};new Function('localStorage','scheduledTasks','removeRetiredTasks','console',body)({getItem:()=>saved,setItem:()=>{throw Error('quota');}},memory,removeRetiredTasks,{warn(){}});assert.equal(memory.value.length,2);
 assert.match(vue,/importData\.scheduledTasks\.map\(removeRetiredTasks\)/);
 for(const file of ['src/views/BatchDailyTasks.vue','src/utils/batch/constants.js','src/utils/batch/tasksDungeon.js','src/utils/batch/connectionManager.js','src/components/GameStatus.vue','src/stores/events/tower.ts','src/stores/tokenStore.ts','src/utils/xyzwWebSocket.js','src/utils/xyzwLegionWarWebSocket.js']) assert.doesNotMatch(read(file),/baoku|bosstower|宝库/i,file);
 assert.equal(existsSync(new URL('../src/components/Tower/BossTower.vue',import.meta.url)),false);
 assert.match(read('src/utils/xyzwWebSocket.js'),/fight_starttower/);assert.match(read('src/utils/batch/tasksDungeon.js'),/batchmengjing/);
 assert.doesNotMatch(vue,/batchSmartSendCar|batchClaimCars/);
 assert.doesNotMatch(read('src/utils/batch/constants.js'),/batchSmartSendCar|batchClaimCars/);
 assert.doesNotMatch(read('src/utils/batch/index.js'),/tasksCar|carUtils/);
 assert.equal(existsSync(new URL('../src/utils/batch/tasksCar.js',import.meta.url)),false);
 assert.equal(existsSync(new URL('../src/utils/batch/carUtils.js',import.meta.url)),false);
});
