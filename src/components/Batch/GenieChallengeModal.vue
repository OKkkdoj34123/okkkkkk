<template>
  <n-modal :show="show" preset="card" title="普通灯神挑战" style="width: min(1100px, 95vw)" :mask-closable="!running" :closable="!running" @update:show="$emit('update:show', $event)">
    <n-alert type="warning" :bordered="false">
      仅调整本次挑战站位，不转移养成、装备或鱼灵。宠物按服务器hp排序，淬炼/天赋值不重复叠加，不表示已核实最终总血量。玩具按当前阵容战力自动择优，只查询库存中拥有的ID及0。
    </n-alert>
    <n-space style="margin: 16px 0" align="center">
      <label v-for="nation in nations" :key="nation.value" class="genie-nation-count">
        {{ nation.label }}
        <n-input-number :value="config.attemptsByNation[nation.value]" :min="0" :max="10" :precision="0" :disabled="running" style="width: 110px" @update:value="changeCount(nation.value, $event)" />
      </label>
    </n-space>
    <p :style="{ color: validation.error ? '#d03050' : undefined }">{{ validation.error || `合计 ${validation.total}/10 次，按魏 → 蜀 → 吴 → 群执行；0 次表示跳过该国。` }}</p>
    <n-space vertical>
      <n-checkbox :checked="config.stopOnLoss" :disabled="running" @update:checked="change('stopOnLoss', $event)">失败即停止本账号后续挑战（默认关闭）</n-checkbox>
      <n-checkbox :checked="config.allowInitialProbe" :disabled="running" @update:checked="change('allowInitialProbe', $event)">计数缺失或统计日期早于今天时，允许受限首战（默认开启）</n-checkbox>
      <n-checkbox :checked="config.useTechnology" :disabled="running" @update:checked="change('useTechnology', $event)">随国家切换科技，结束或停止后恢复战士（默认开启）</n-checkbox>
      <n-checkbox :checked="config.upgradeEmptyTechnology" :disabled="running || !config.useTechnology" @update:checked="change('upgradeEmptyTechnology', $event)">所有科技为空时，按101→108依次一键升级（消耗可用升级资源，默认关闭）</n-checkbox>
    </n-space>
    <p v-if="config.useTechnology">魏用法师、蜀/群用战士、吴用射手。置换实测每次20钻，默认四国从战士出发约80钻；其他职业出发可能更多。预留恢复费用；多套非零科技将全部重置基础科技，再按101→108一键升级战士，会重新分配等级并消耗升级资源。断网恢复失败会保留记录，下次开始优先恢复，请勿清除浏览器数据。</p>
    <p>点击开始后自动读取阵容、宠物和共享次数。次数未知时先挑战1次，依据战报和战后当日次数继续；无次数或状态不明即停止，不重发。</p>
    <p>四国共用每日10次，胜负均消耗次数；实际次数以当天剩余额度为限。主线战力并列时选索引最小的位置。</p>
    <div style="overflow-x:auto">
      <n-table :single-line="false" size="small">
        <thead><tr><th>账号</th><th>主线最强 / 主C位置</th><th>当前国家 / 挑战阵容（索引0–4）</th><th>宠物 / 血量依据</th><th>玩具 / 战力</th><th>当日剩余</th><th>结果</th></tr></thead>
        <tbody><tr v-for="row in rows" :key="row.id">
          <td>{{ row.name }}</td>
          <td>{{ row.preview?.strongest ? `${heroName(row.preview.strongest.heroId)} / 索引${row.preview.strongest.position}` : '待核验' }}</td>
          <td>{{ row.preview?.nation || '' }} {{ row.preview?.battleTeam ? Object.values(row.preview.battleTeam).map(heroName).join('、') : '待核验' }}</td>
          <td>{{ row.preview?.pet ? `${PET_DICT[row.preview.pet.petId]?.name || row.preview.pet.petId} ${row.preview.pet.maskedUid}；${row.preview.pet.maxHp}；${row.preview.pet.source}（比较${row.preview.pet.compared}只）` : '未确认最高血量宠物' }}</td>
          <td>{{ row.preview?.weapon ? `ID ${row.preview.weapon.lordWeaponId} / ${row.preview.weapon.power ?? '未查询'}` : '待比较' }}</td>
          <td>{{ row.used != null ? Math.max(0, 10 - row.used) : row.preview?.probe ? '未知（受限首战）' : row.preview?.remaining ?? '待核验' }}</td>
          <td><div v-for="note in (row.preview?.notes || [])" :key="note">{{ note }}</div>{{ labels[row.status] || row.status }}：{{ row.message || '读取完成' }}</td>
        </tr></tbody>
      </n-table>
    </div>
    <n-space justify="end" style="margin-top:16px">
      <n-button type="primary" :disabled="running || !canStart" @click="$emit('start')">开始挑战</n-button>
      <n-button type="error" :disabled="!running" @click="$emit('stop')">停止</n-button>
    </n-space>
  </n-modal>
</template>
<script setup>
import { NModal, NAlert, NSpace, NInputNumber, NCheckbox, NTable, NButton } from 'naive-ui';
import { computed } from 'vue';
import { normalizeGeniePlan } from '@/utils/batch/genieChallengePlan.js';
import { GENIE_TEAMS, heroName } from '@/utils/batch/genieChallengePolicy.js';
import { PET_DICT } from '@/utils/PetList.js';
const props = defineProps({ show: Boolean, running: Boolean, canStart: Boolean, selectedCount: Number, config: Object, rows: Array });
const emit = defineEmits(['update:show', 'update:config', 'start', 'stop']);
const nations = Object.entries(GENIE_TEAMS).map(([id, v]) => ({ label: v.name, value: Number(id) }));
const labels = { ready: '校验通过', running: '执行中', reconciled: '上次已核验', completed: '正常完成', quota: '次数用完，正常跳过', conditions: '条件不足', protocol: '协议失败', unverified: '状态待核验', stopped: '主动停止' };
const change = (key, value) => emit('update:config', { ...props.config, [key]: value });
const validation = computed(() => {
  try { return { total: normalizeGeniePlan(props.config).total }; }
  catch (error) { return { error: error.message }; }
});
const changeCount = (id, value) => change('attemptsByNation', { ...props.config.attemptsByNation, [id]: value });
</script>
<style scoped>
.genie-nation-count { display: flex; align-items: center; gap: 8px; }
</style>
