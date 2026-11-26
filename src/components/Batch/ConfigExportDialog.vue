<template>
  <n-modal :show="true" preset="card" title="导出配置" style="width: min(740px, 94vw)"
    :closable="!busy" :mask-closable="!busy" :close-on-esc="!busy"
    @update:show="visible => { if (!visible) emit('close') }">
    <n-space vertical :size="14">
      <n-radio-group v-model:value="format" :disabled="busy">
        <n-radio-button value="config">账号与配置</n-radio-button>
        <n-radio-button value="bin">仅原始 BIN</n-radio-button>
      </n-radio-group>
      <n-checkbox v-if="format === 'config'" v-model:checked="includeBin" :disabled="busy">
        包含原始 BIN（跨设备刷新）
      </n-checkbox>
      <div v-else>随原始 BIN 保存所选账号的分组。全选时也保存空组。新设备通过“导入配置”恢复，首次添加账号需联网认证。</div>
      <div v-if="groups.length">
        <div class="group-label">按分组选择（可多选）</div>
        <n-space size="small">
          <n-button v-for="group in groups" :key="group.id" size="small" :disabled="busy"
            :aria-pressed="groupIds.includes(group.id)" :type="groupIds.includes(group.id) ? 'primary' : 'default'"
            @click="toggleGroup(group.id)">{{ group.name }}</n-button>
        </n-space>
      </div>
      <n-space align="center">
        <strong>已选 {{ selected.length }} / {{ accounts.length }} 个账号</strong>
        <n-button size="tiny" :disabled="busy" @click="selectAccounts(accounts.map(t => t.id))">全选</n-button>
        <n-button size="tiny" :disabled="busy" @click="selectAccounts([])">全不选</n-button>
      </n-space>
      <n-checkbox-group :value="selected" :disabled="busy" @update:value="selectAccounts">
        <div class="export-account-grid">
          <n-checkbox v-for="account in accounts" :key="account.id" :value="account.id">
            {{ account.name || account.id }}
          </n-checkbox>
        </div>
      </n-checkbox-group>
      <div v-if="format === 'config' && selected.length < accounts.length">
        仅导出所选账号及其关联的分组、定时任务和日常设置。全选时另含自动周计划和全局批量设置。
      </div>
    </n-space>
    <template #footer>
      <n-space justify="end">
        <n-button :disabled="busy" @click="emit('close')">取消</n-button>
        <n-button type="primary" :disabled="!selected.length || busy" :loading="busy"
          @click="emit('export', { ids: [...selected], format, includeBin })">导出 JSON</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<script setup>
import { ref } from "vue";
import { NButton, NCheckbox, NCheckboxGroup, NModal, NRadioButton, NRadioGroup, NSpace } from "naive-ui";

const props = defineProps({ accounts: Array, groups: Array, busy: Boolean });
const emit = defineEmits(["close", "export"]);
const format = ref("config");
const includeBin = ref(true);
const selected = ref(props.accounts.map(account => account.id));
const groupIds = ref([]);

function selectAccounts(ids) {
  selected.value = ids;
  groupIds.value = [];
}

function toggleGroup(id) {
  const ids = groupIds.value.includes(id)
    ? groupIds.value.filter(item => item !== id)
    : [...groupIds.value, id];
  groupIds.value = ids;
  const members = new Set(props.groups.filter(group => ids.includes(group.id)).flatMap(group => group.tokenIds));
  selected.value = props.accounts.map(account => account.id).filter(id => members.has(id));
}
</script>

<style scoped>
.group-label { margin-bottom: 6px; }
.export-account-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(185px, 100%), 1fr));
  gap: 8px 12px;
  max-height: 34vh;
  overflow-y: auto;
  padding: 4px;
  overflow-wrap: anywhere;
}
</style>
