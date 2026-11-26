import { issue } from './genieChallengePolicy.js';
export function ownedGenieWeapons(role) {
  const raw=role.lordWeapon;
  if (raw == null) return []; // No proven inventory: use only the explicit no-toy option.
  if (typeof raw!=='object' || Array.isArray(raw)) throw issue('玩具库存格式异常');
  const ids=[];
  for(const [key,w] of Object.entries(raw)) {
    if (!w || !Number.isSafeInteger(w.weaponId) || w.weaponId<0 || String(w.weaponId)!==key) throw issue('玩具库存ID不一致，未发送战力查询或挑战');
    if(w.weaponId>0) ids.push(w.weaponId);
  }
  return [...new Set(ids)].sort((a,b)=>a-b);
}
export async function selectGenieWeapon({role,battleTeam,petUId,send,stopped=()=>false}) {
  const owned=ownedGenieWeapons(role);
  if(!owned.length) return {lordWeaponId:0,power:null,compared:0,source:'无已确认拥有的玩具，使用0'};
  let best=null;
  for(const lordWeaponId of [0,...owned]) {
    if(stopped()) throw issue('用户主动停止','stopped');
    const response=await send('hero_calcpowerbyteam',{battleTeam,lordWeaponId,petUId});
    if(response?.code!==undefined && response.code!==0) throw issue(`玩具${lordWeaponId}战力查询失败（${response.code}）`,'protocol');
    const power=(response?.data??response)?.power;
    if(typeof power!=='number' || !Number.isSafeInteger(power) || power<0) throw issue(`玩具${lordWeaponId}战力返回无效，未发送挑战`);
    if(!best || power>best.power || (power===best.power && best.lordWeaponId===0 && lordWeaponId>0)) best={lordWeaponId,power};
  }
  return {...best,compared:owned.length+1,source:'同阵容/宠物/科技下服务器power最大；并列优先已有玩具及较小ID'};
}
