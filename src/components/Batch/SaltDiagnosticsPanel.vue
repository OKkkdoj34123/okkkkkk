<template>
  <n-card size="small" style="margin-bottom: 12px">
    <div class="salt-diagnostics-toolbar">
      <strong>盐场诊断</strong>
      <n-select v-model:value="selected" :options="options" placeholder="运行盐场后可导出" class="salt-diagnostics-select" />
      <n-button size="small" :disabled="!selected || exporting" :loading="exporting" @click="download">导出诊断 JSON</n-button>
      <n-button size="small" :disabled="loading" @click="refresh">刷新记录列表</n-button>
    </div>
    <p class="salt-diagnostics-note">运行“盐场参与一次”时自动记录，本机保留最近 3 批；每批最多 12 MiB / 30000 条。结束后请导出上传，运行中也可导出。不会导出 Token 或原始 BIN。</p>
    <p v-if="selectedStatus" class="salt-diagnostics-note">所选批次：{{ selectedStatus.accountCount }} 个账号，已记录 {{ selectedStatus.eventCount }} 条；{{ selectedStatus.finishedAt ? '已结束' : '未结束/运行中' }}。</p>
    <n-alert v-if="warning" type="warning" :show-icon="true">{{ warning }}</n-alert>
    <n-alert v-if="error" type="warning" :show-icon="true">{{ error }}</n-alert>
  </n-card>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NAlert, NButton, NCard, NSelect, useMessage } from 'naive-ui';
import { getSaltDiagnosticStatus, listSaltDiagnostics, readSaltDiagnostic, subscribeSaltDiagnostics } from '@/utils/saltField/diagnostics.js';

const message = useMessage();
const status = ref(getSaltDiagnosticStatus());
const rows = ref([]), selected = ref(status.value?.runId || null);
const loading = ref(false), exporting = ref(false), error = ref('');
const options = computed(() => {
  const all = rows.value.filter(row => row.runId !== status.value?.runId);
  if (status.value) all.unshift(status.value);
  return all.map(row => ({ value: row.runId,
    label: `${new Date(row.startedAt).toLocaleString()} · ${row.accountCount ?? row.accounts?.length ?? '?'}个账号 · ${row.finishedAt ? '已结束' : '未结束/运行中'}` }));
});
const selectedStatus = computed(() => status.value?.runId === selected.value ? status.value : rows.value.find(row => row.runId === selected.value));
const warning = computed(() => [selectedStatus.value?.storageWarning,
  selectedStatus.value?.droppedEvents ? `已达记录上限，另有 ${selectedStatus.value.droppedEvents} 条未收录；导出文件不是完整记录。` : ''].filter(Boolean).join('；'));
async function refresh() {
  if (loading.value) return;
  loading.value = true; error.value = '';
  try {
    rows.value = await listSaltDiagnostics();
    if (!selected.value || !options.value.some(row => row.value === selected.value)) selected.value = options.value[0]?.value || null;
  } catch { error.value = '无法读取本机历史记录；当前批次仍可从内存导出。'; }
  finally { loading.value = false; }
}
const unsubscribe = subscribeSaltDiagnostics(next => {
  const changed = status.value?.runId !== next.runId;
  status.value = next;
  if (changed) { selected.value = next.runId; void refresh(); }
});
onMounted(refresh);
onBeforeUnmount(unsubscribe);
async function download() {
  exporting.value = true;
  let url;
  try {
    const run = await readSaltDiagnostic(selected.value);
    url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${run.runId}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    // Allow the browser time to consume the download URL.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    message.success('盐场诊断 JSON 已导出');
  } catch (err) { if (url) URL.revokeObjectURL(url); message.error(`导出失败：${err?.message || '请重试'}`); }
  finally { exporting.value = false; }
}
</script>

<style scoped>
.salt-diagnostics-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.salt-diagnostics-select { flex: 1 1 300px; min-width: 0; }
.salt-diagnostics-note { margin: 8px 0 0; color: var(--text-secondary); font-size: 12px; overflow-wrap: anywhere; }
</style>
