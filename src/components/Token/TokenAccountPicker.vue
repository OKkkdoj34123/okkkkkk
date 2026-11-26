<template>
  <n-space vertical :size="12">
    <div v-if="groups.length">
      <div class="group-label">按分组选择（可多选）</div>
      <n-space size="small">
        <n-button
          v-for="group in groups"
          :key="group.id"
          size="small"
          :type="groupIds.includes(group.id) ? 'primary' : 'default'"
          :aria-pressed="groupIds.includes(group.id)"
          @click="toggleGroup(group.id)"
        >{{ group.name }}</n-button>
      </n-space>
    </div>
    <n-space align="center" size="small">
      <strong>已选 {{ selectedCount }} / {{ accounts.length }} 个账号</strong>
      <n-button size="tiny" @click="selectAccounts(accounts.map(account => account.id))">全选</n-button>
      <n-button size="tiny" @click="selectAccounts([])">全不选</n-button>
    </n-space>
    <n-checkbox-group :value="modelValue" @update:value="selectAccounts">
      <div class="account-grid">
        <n-checkbox v-for="account in accounts" :key="account.id" :value="account.id">
          <span>{{ account.name || account.id }}</span>
          <n-tag v-if="account.server" size="small" class="server-tag">{{ account.server }}</n-tag>
        </n-checkbox>
      </div>
    </n-checkbox-group>
  </n-space>
</template>

<script setup>
import { computed, ref } from "vue";
import { NButton, NCheckbox, NCheckboxGroup, NSpace, NTag } from "naive-ui";

const props = defineProps({
  accounts: { type: Array, required: true },
  groups: { type: Array, required: true },
  modelValue: { type: Array, required: true },
});
const emit = defineEmits(["update:modelValue"]);
const groupIds = ref([]);
const selectedCount = computed(() => {
  const selected = new Set(props.modelValue);
  return props.accounts.filter(account => selected.has(account.id)).length;
});

function selectAccounts(ids) {
  groupIds.value = [];
  emit("update:modelValue", ids);
}

function toggleGroup(id) {
  groupIds.value = groupIds.value.includes(id)
    ? groupIds.value.filter(current => current !== id)
    : [...groupIds.value, id];
  const memberIds = new Set(props.groups
    .filter(group => groupIds.value.includes(group.id))
    .flatMap(group => group.tokenIds));
  emit("update:modelValue", props.accounts.map(account => account.id).filter(id => memberIds.has(id)));
}
</script>

<style scoped>
.group-label { margin-bottom: 6px; }
.account-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr));
  gap: 8px 12px;
  max-height: 34vh;
  overflow-y: auto;
  padding: 4px;
  overflow-wrap: anywhere;
}
.server-tag { margin-left: 6px; }
</style>
