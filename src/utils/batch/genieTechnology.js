import { roleFrom, issue } from './genieChallengePolicy.js';

export const TECH_PREFIX = Object.freeze({1:1, 2:6, 3:5, 4:2, 5:4, 6:3});
export const NATION_TECH = Object.freeze({1:4, 2:1, 3:6, 4:1});
const names = {1:'战士', 2:'肉盾', 3:'辅助', 4:'法师', 5:'刺客', 6:'射手'};
export function research(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw issue('完整科技数据缺失');
  const out = {};
  for (let p=1;p<=6;p++) for(let s=1;s<=14;s++) out[p*100+s]=0;
  for (const [k,v] of Object.entries(raw)) {
    if (!Object.hasOwn(out,k) || !Number.isInteger(v) || v<0) throw issue('科技条目或等级不受支持');
    out[k]=v;
  }
  return out;
}
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function activeTypes(r) { return Object.keys(TECH_PREFIX).map(Number).filter(t => Object.entries(r).some(([k,v]) => Math.floor(Number(k)/100)===TECH_PREFIX[t] && v>0));
}
export function activeTechnology(r) {
  const types=activeTypes(r);
  if (types.length>1) throw issue('存在多套非零科技，尚未验证双向置换；未发送置换');
  return types[0] || null;
}
export function swapTechnology(r, from, to) {
  const out={...r};
  for(let s=1;s<=14;s++) [out[TECH_PREFIX[from]*100+s],out[TECH_PREFIX[to]*100+s]]=[out[TECH_PREFIX[to]*100+s],out[TECH_PREFIX[from]*100+s]];
  return out;
}
export function createTechnologyLedger(storage) {
  const key=id=>`xyzw_genie_technology_v1:${id}`;
  return {
    get(id) { try { return JSON.parse(storage.getItem(key(id)) || 'null'); } catch { throw issue('科技恢复记录无法读取'); } },
    set(id,v) { try { storage.setItem(key(id),JSON.stringify(v)); } catch { throw issue('科技恢复记录保存失败，未发送资源命令'); } },
    clear(id) { storage.removeItem(key(id)); },
  };
}
// Every mutation is journalled before enqueueing. Only full role reads settle it.
export function createTechnologySession({id, send, ledger, onUncertain=async()=>{}, log=()=>{}, stopped=()=>false}) {
  if (!ledger) throw issue('科技恢复存储未配置');
  let touched=false;
  const read = async () => {
    try { return roleFrom(await send('role_getroleinfo',{})); }
    catch { await onUncertain(); return roleFrom(await send('role_getroleinfo',{})); }
  };
  const settle = async () => {
    const role=await read(), current=research(role.legionResearch), marker=ledger.get(id);
    if (marker) {
      if (marker.version!==1) throw issue('科技恢复记录版本异常');
      if (marker.pending) {
        if (['swap','reset'].includes(marker.kind) && same(current,marker.after)) {
          ledger.set(id,{...marker,pending:false,current, ...(marker.kind==='reset' ? {resetTypes:marker.resetTypes.filter(t=>t!==marker.resetType)} : {})});
        } else if (marker.kind==='upgrade' && Object.keys(current).every(k => Number(k)===marker.researchId ? current[k]>=marker.before[k] : current[k]===marker.before[k]) && current[marker.researchId]>marker.before[marker.researchId]) {
          ledger.set(id,{...marker,pending:false,current, nextUpgrade:marker.researchId+1});
        } else throw issue('科技请求结果不明，保留待恢复记录；未重发，请核对游戏科技');
      } else if (!same(current,marker.current)) throw issue('科技已被其他操作改变，停止自动恢复');
    }
    return {role,current};
  };
  const exchange = async (target, restoring=false) => {
    const {role,current}=await settle(), from=activeTechnology(current);
    if (!from) throw issue('科技为空；请启用空科技升级或先在游戏升级');
    if (from===target) return;
    if (!restoring && stopped()) throw issue('用户主动停止','stopped');
    const diamond=role.diamond;
    // Reserve one further exchange to warrior. 20 is observed, not a server quote.
    if (!Number.isFinite(diamond) || diamond < (target===1 ? 20 : 40)) throw issue('钻石不足或余额缺失，需预留恢复战士费用');
    const after=swapTechnology(current,from,target);
    ledger.set(id,{version:1,kind:'swap',pending:true,before:current,after}); touched=true;
    let failed=false;
    try { await send('legion_exchangeresearch',{type:from,targetType:target}); }
    catch { failed=true; await onUncertain(); }
    const checked=await settle();
    if (!same(checked.current,after)) throw issue('科技置换回读不匹配');
    log(`科技 ${names[from]}→${names[target]}已确认；钻石变化 ${diamond-checked.role.diamond}`);
    if (!restoring && (!Number.isFinite(checked.role.diamond) || diamond-checked.role.diamond>20)) throw issue('实际置换费用超过实测20钻，停止并恢复战士');
    if (failed && !restoring) throw issue('置换回包异常，已回读确认；停止挑战并恢复战士');
  };
  const upgrade = async () => {
    let marker=ledger.get(id);
    for (let researchId=marker?.nextUpgrade || 101; researchId<=108; researchId++) {
      if (stopped()) throw issue('用户主动停止','stopped');
      const {current:before}=await settle();
      marker=ledger.get(id);
      ledger.set(id,{...marker,version:1,kind:'upgrade',pending:true,before,researchId}); touched=true;
      let failed=false;
      try { await send('legion_research',{researchId,isMax:true}); }
      catch { failed=true; await onUncertain(); }
      if (!failed) {
        const observed=research((await read()).legionResearch);
        if (same(observed,before)) {
          ledger.set(id,{...ledger.get(id),pending:false,current:observed,nextUpgrade:researchId+1});
          log(`战士科技${researchId}无等级变化，已回读；继续下一项，不重复升级`);
          continue;
        }
      }
      const {current:after}=await settle();
      log(`战士科技${researchId}等级${after[researchId]}，已回读确认`);
      if (failed) throw issue('升级回包异常，已回读；停止，不重试');
    }
    const {current}=await settle();
    ledger.set(id,{version:1,pending:false,current});
    if (!activeTechnology(current)) throw issue('升级后科技仍为空，停止挑战','conditions');
  };
  const consolidate = async () => {
    // Keep the original reset list and complete snapshot across interruption.
    const initial=await settle();
    if (!ledger.get(id)?.consolidating) ledger.set(id,{version:1,pending:false,current:initial.current,original:initial.current,consolidating:true,resetTypes:activeTypes(initial.current),nextUpgrade:101});
    touched=true;
    for (const type of ledger.get(id).resetTypes) {
      const {current}=await settle();
      if (!activeTypes(current).includes(type)) continue;
      if (stopped()) throw issue('用户主动停止','stopped');
      const after={...current};
      for(let slot=1;slot<=14;slot++) after[TECH_PREFIX[type]*100+slot]=0;
      ledger.set(id,{...ledger.get(id),kind:'reset',resetType:type,pending:true,before:current,after});
      let failed=false;
      try { await send('legion_resetresearch',{type,advanced:false}); }
      catch { failed=true; await onUncertain(); }
      await settle();
      log(`${names[type]}基础科技重置已回读确认`);
      // Remove confirmed steps, so a resumed upgrade never resets warrior again.
      const m=ledger.get(id);ledger.set(id,{...m,resetTypes:m.resetTypes.filter(t=>t!==type)});
      if(failed) throw issue('重置回包异常，已回读；停止，不重发');
    }
    await upgrade();
  };
  return {
    async recover() {
      const marker=ledger.get(id);
      if (!marker) return false;
      touched=true;
      await settle();
      if (marker.consolidating) await consolidate();
      else if (marker.upgrading) await upgrade();
      await exchange(1,true); ledger.clear(id); touched=false;
      log('上次科技任务已恢复战士；本次未挑战，请再次开始'); return true;
    },
    async prepare(allowUpgrade=false) {
      const {current}=await settle();
      const types=activeTypes(current);
      if (types.length>1) { await consolidate(); return; }
      if (types.length) return;
      if (!allowUpgrade) throw issue('所有职业科技为空，请勾选空科技升级或先在游戏升级');
      ledger.set(id,{version:1,pending:false,current,upgrading:true,nextUpgrade:101});
      await upgrade();
    },
    beforeNation: id=>exchange(NATION_TECH[id]),
    async finish() {
      if (!touched && !ledger.get(id)) return;
      const {current}=await settle();
      if (ledger.get(id)?.consolidating || ledger.get(id)?.upgrading) throw issue('科技重建未完成，已保留进度；下次开始继续，未发送挑战');
      if (activeTechnology(current)) await exchange(1,true);
      ledger.clear(id); touched=false; log(activeTechnology(current) ? '已回读确认科技恢复战士' : '科技仍为空，未发生置换，已停止');
    },
  };
}
