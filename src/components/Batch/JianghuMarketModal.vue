<template>
 <n-modal :show="show" preset="card" title="一键江湖黑市" style="width:min(960px,95vw)" :mask-closable="!running" :closable="!running" @update:show="$emit('update:show',$event)">
  <p>勾选顺序即购买顺序；目标份数指本期累计购买数量，已买部分自动跳过。金砖不足以支付全部未购清单时，该账号不执行购买。</p>
  <n-space vertical>
   <n-checkbox v-for="g in goods" :key="g.id" :checked="list.some(e=>e.id===g.id)" :disabled="running" @update:checked="toggle(g.id,$event)">ID{{g.id}} · {{g.label}} · {{g.price.toLocaleString()}}金砖/份</n-checkbox>
  </n-space>
  <n-table v-if="list.length" size="small" style="margin-top:16px">
   <thead><tr><th>顺序</th><th>礼包</th><th>本期目标份数</th><th>调整</th></tr></thead>
   <tbody><tr v-for="(e,i) in list" :key="e.id"><td>{{i+1}}</td><td>{{good(e.id).label}}</td><td><n-input-number :value="e.quantity" :min="1" :max="good(e.id).limit" :precision="0" :disabled="running" @update:value="quantity(i,$event)" /></td><td><n-space><n-button size="tiny" :disabled="running||i===0" @click="move(i,-1)">上移</n-button><n-button size="tiny" :disabled="running||i===list.length-1" @click="move(i,1)">下移</n-button></n-space></td></tr></tbody>
  </n-table>
  <p>清单总价 {{total.toLocaleString()}} 金砖；逐账号扣除本期已购部分后再核对余额。ID9本期最多4份，默认选中时为1份。保存清单不会购买。</p>
  <n-space justify="end"><n-button :disabled="running" @click="$emit('save')">保存清单</n-button><n-button v-if="running" @click="$emit('stop')">停止购买</n-button><n-button type="primary" :disabled="running||!canStart||!list.length" @click="$emit('start')">开始购买</n-button></n-space>
  <n-table v-if="rows.length" size="small" style="margin-top:16px"><thead><tr><th>账号</th><th>结果</th></tr></thead><tbody><tr v-for="r in rows" :key="r.id"><td>{{r.name}}</td><td>{{r.message}}</td></tr></tbody></n-table>
 </n-modal>
</template>
<script setup>
import {computed} from 'vue';
import {JIANGHU_GOODS} from '@/utils/batch/jianghuMarket.js';
const props=defineProps({show:Boolean,list:{type:Array,default:()=>[]},running:Boolean,canStart:Boolean,rows:{type:Array,default:()=>[]}});
const emit=defineEmits(['update:show','update:list','save','start','stop']);
const goods=JIANGHU_GOODS,good=id=>goods.find(g=>g.id===id);
const total=computed(()=>props.list.reduce((n,e)=>n+good(e.id).price*e.quantity,0));
function toggle(id,on){emit('update:list',on?[...props.list,{id,quantity:1}]:props.list.filter(e=>e.id!==id));}
function quantity(i,n){if(!Number.isInteger(n)||n<1||n>good(props.list[i].id).limit)return;emit('update:list',props.list.map((e,j)=>j===i?{...e,quantity:n}:e));}
function move(i,by){const copy=[...props.list];[copy[i],copy[i+by]]=[copy[i+by],copy[i]];emit('update:list',copy);}
</script>
