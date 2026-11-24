<template>
  <!-- 扫码角色导入：微信扫码 → combUser → 角色列表 → 多选导入（自动匹配旧账号） -->
  <NForm label-placement="top" size="medium">
    <NAlert type="info" show-icon style="margin-bottom: 16px">
      微信扫码登录后拉取角色列表，可多选导入。已存在的角色会<strong>复用原账号 ID</strong>，
      定时任务/分组/账号设置引用不变；本次导入会同步更新该账号的 bin。
    </NAlert>

    <!-- 代理设置（借鉴 demoqr：可配置 Worker URL，GitHub Pages 也能用） -->
    <NCollapse style="margin-bottom: 12px">
      <NCollapseItem title="代理设置（Worker URL）" name="proxy">
        <NSpace vertical size="small">
          <NText depth="3" style="font-size: 12px">
            若站点部署在 Cloudflare Pages 根路径，可留空走同源代理；若部署在 GitHub Pages
            等静态托管，请单独部署一份 worker.js 为 Cloudflare Worker，把它的地址填在下面（会保存到浏览器本地）。
          </NText>
          <NSpace>
            <NInput
              v-model:value="workerUrlInput"
              placeholder="https://xyzw-proxy.workers.dev"
              size="small"
              style="width: 320px"
              clearable
            />
            <NButton size="small" type="primary" ghost @click="applyWorkerUrl">保存</NButton>
            <NButton size="small" :loading="isTestingWorker" @click="onTestWorker">测试连接</NButton>
          </NSpace>
          <NText :type="workerTestOk === null ? 'default' : workerTestOk ? 'success' : 'error'" style="font-size: 12px">
            {{ workerTestMsg }}
          </NText>
        </NSpace>
      </NCollapseItem>
    </NCollapse>

    <!-- 扫码区 -->
    <div class="qr-login-block">
      <div class="qr-image-wrap">
        <img v-if="qrUrl" :src="qrUrl" class="qr-image" alt="微信登录二维码" />
        <div v-else class="qr-placeholder"><span>尚未获取二维码</span></div>
      </div>
      <div class="qr-side">
        <NSpace vertical size="small">
          <NButton type="primary" size="small" :loading="isFetchingQr" @click="fetchQrCode">
            {{ qrUrl ? "刷新二维码" : "获取微信二维码" }}
          </NButton>
          <NButton size="small" :disabled="!combUser" :loading="isFetchingRoles" @click="fetchRolesFromCombUser">
            重新拉取角色列表
          </NButton>
          <div class="scan-status" :class="[scanStatusType]">{{ scanStatus }}</div>
          <div v-if="combUser" class="comb-user-tip">
            ✓ 已登录：{{ combUserNickname || combUser?.openid || "未知用户" }}
          </div>
          <div class="scan-hint">扫码有效期 2 分钟，超时请刷新二维码</div>
        </NSpace>
      </div>
    </div>

    <!-- 角色列表（单选/多选） -->
    <NDivider style="margin: 16px 0">角色列表</NDivider>
    <NSpace align="center" style="margin-bottom: 12px">
      <NButton size="small" :disabled="!roles.length" @click="checkAll = !checkAll">
        {{ checkAll ? "取消全选" : "全选" }}
      </NButton>
      <NButton size="small" type="error" ghost :disabled="!checkedIds.length" @click="clearChecked">
        清空选择
      </NButton>
      <span style="color: #888; font-size: 13px">已选 {{ checkedIds.length }} / {{ roles.length }} 个角色</span>
    </NSpace>

    <NDataTable
      v-if="roles.length"
      :columns="columns"
      :data="roles"
      :row-key="(row) => row.roleId"
      :checked-row-keys="checkedIds"
      @update:checked-row-keys="onChecked"
      :single-line="false"
      size="small"
      :max-height="340"
    />
    <NEmpty v-else description="扫码后在此显示角色列表" />

    <!-- 协议分析工具（借鉴 demoqr：粘贴 bin/base64/hex 自动检测解密 + BON 解码） -->
    <NCollapse style="margin-top: 16px">
      <NCollapseItem name="inspector" title="协议分析工具（自动检测解密）">
        <NSpace vertical size="small">
          <NText depth="3" style="font-size: 12px">
            粘贴加密数据（hex / base64 / 文本），自动识别 lx / x / xtm 加密并做 BON 解码，用于排查协议问题。
          </NText>
          <NInput
            v-model:value="inspectorInput"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 5 }"
            placeholder="例如：707887e733... 或 base64 字符串"
          />
          <NSpace>
            <NButton size="small" type="primary" @click="onInspect">解析</NButton>
            <NButton size="small" @click="inspectorInput = ''; inspectorResult = null">清空</NButton>
          </NSpace>
          <template v-if="inspectorResult">
            <NAlert v-if="!inspectorResult.ok" type="error" show-icon>
              {{ inspectorResult.error }}
            </NAlert>
            <template v-else>
              <NTag :type="schemeTagType" size="small">
                加密方案：{{ schemeLabel }}
              </NTag>
              <NScrollbar style="max-height: 260px; background: #fafafa; padding: 8px; border-radius: 6px">
                <pre style="font-size: 12px; margin: 0">{{ inspectorJson }}</pre>
              </NScrollbar>
            </template>
          </template>
        </NSpace>
      </NCollapseItem>
    </NCollapse>

    <div class="form-actions">
      <NButton type="primary" :loading="isImporting" :disabled="!checkedIds.length || !combUser" @click="handleImport">
        导入选中角色（{{ checkedIds.length }}）
      </NButton>
      <NButton @click="cancel">取消</NButton>
    </div>

    <NAlert v-if="lastResult" :type="lastResult.failed ? 'warning' : 'success'" show-icon style="margin-top: 16px">
      <div>更新 {{ lastResult.updated }} 个 / 新增 {{ lastResult.created }} 个，失败 {{ lastResult.failed }} 个</div>
      <div v-for="msg in lastResult.messages" :key="msg" style="font-size: 12px">{{ msg }}</div>
    </NAlert>
  </NForm>
</template>

<script setup>
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NDataTable,
  NEmpty,
  NForm,
  NInput,
  NScrollbar,
  NSpace,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { computed, h, onBeforeUnmount, ref } from "vue";
import { useWxQrLogin } from "@/composables/useWxQrLogin";
import useIndexedDB from "@/hooks/useIndexedDB";
import { useTokenStore } from "@/stores/tokenStore";
import { formatInspectedData, inspectProtocol } from "@/utils/protocolInspector";
import { buildBatchImportPlans } from "@/utils/qrRoleImport";
import { getTokenId, transformToken } from "@/utils/token";

const emit = defineEmits(["cancel", "ok"]);
const message = useMessage();
const tokenStore = useTokenStore();
const { storeArrayBuffer } = useIndexedDB();

// 扫码逻辑全部来自 composable（UI 只负责展示与交互）
const {
  workerUrl,
  setWorkerUrl,
  testWorker,
  qrUrl,
  scanStatus,
  scanStatusType,
  combUser,
  combUserNickname,
  isFetchingQr,
  isFetchingRoles,
  fetchQrCode,
  fetchRolesFromCombUser,
  reset: resetQrLogin,
  setRolesLoadedHandler,
} = useWxQrLogin();

// ---- Worker URL 设置 ----
const workerUrlInput = ref(workerUrl.value);
const workerTestOk = ref(null);
const workerTestMsg = ref("");
const isTestingWorker = ref(false);

const applyWorkerUrl = () => {
  setWorkerUrl(workerUrlInput.value);
  workerTestOk.value = null;
  workerTestMsg.value = workerUrl.value ? `已保存 Worker：${workerUrl.value}` : "已清空，将使用同源代理";
  message.success("代理设置已保存");
};

const onTestWorker = async () => {
  if (workerUrlInput.value !== workerUrl.value) setWorkerUrl(workerUrlInput.value);
  isTestingWorker.value = true;
  try {
    const result = await testWorker();
    workerTestOk.value = result.ok;
    workerTestMsg.value = result.message;
  } finally {
    isTestingWorker.value = false;
  }
};

// ---- 角色列表（收集 composable 回调）----
const roles = ref([]);
const checkedIds = ref([]);
const isImporting = ref(false);
const lastResult = ref(null);

setRolesLoadedHandler((rows) => {
  roles.value = rows;
  checkedIds.value = rows.map((r) => r.roleId);
  lastResult.value = null;
  message.success(`获取角色列表成功，共 ${rows.length} 个`);
});

const checkAll = computed({
  get: () => roles.value.length > 0 && checkedIds.value.length === roles.value.length,
  set: (val) => {
    checkedIds.value = val ? roles.value.map((r) => r.roleId) : [];
  },
});

const columns = [
  { type: "selection" },
  { title: "角色名", key: "name" },
  { title: "区服ID", key: "serverId", width: 110 },
  { title: "角色ID", key: "roleId", width: 130 },
  { title: "战力", key: "power", width: 110 },
  {
    title: "匹配状态",
    key: "match",
    render: (row) => {
      const hit = tokenStore.gameTokens.find(
        (t) => t.roleId !== undefined && String(t.roleId) === String(row.roleId),
      );
      return h("span", { style: { color: hit ? "#18a058" : "#888" } }, hit ? "已存在 → 更新 bin" : "新账号");
    },
  },
];

const onChecked = (keys) => { checkedIds.value = keys; };
const clearChecked = () => { checkedIds.value = []; };

// ---- 协议分析工具 ----
const inspectorInput = ref("");
const inspectorResult = ref(null);
const inspectorJson = computed(() =>
  inspectorResult.value?.data ? formatInspectedData(inspectorResult.value.data) : "",
);
const schemeLabel = computed(() => ({
  lx: "lx（lz4+xor）", x: "x", xtm: "xtm", plain: "明文 BON", unknown: "未知",
}[inspectorResult.value?.scheme] || "未知"));
const schemeTagType = computed(() => (inspectorResult.value?.scheme === "plain" ? "default" : "success"));

const onInspect = () => {
  inspectorResult.value = inspectProtocol(inspectorInput.value);
};

// ---- 生命周期 ----
const cancel = () => {
  resetQrLogin();
  roles.value = [];
  checkedIds.value = [];
  emit("cancel");
};

onBeforeUnmount(() => resetQrLogin());

// ---- 导入（复用匹配旧账号 / 复用 id 逻辑）----
const handleImport = async () => {
  if (!checkedIds.value.length || !combUser.value) return;
  isImporting.value = true;
  const selected = roles.value.filter((r) => checkedIds.value.includes(r.roleId));
  try {
    const { plans, failures } = buildBatchImportPlans(selected, combUser.value, tokenStore.gameTokens);
    let updated = 0;
    let created = 0;
    const messages = [];

    for (const plan of plans) {
      let roleToken;
      try {
        roleToken = await transformToken(plan.bin);
      } catch (e) {
        failures.push({ role: { name: plan.name }, error: `换取token失败: ${e?.message || e}` });
        continue;
      }
      const id = plan.id || getTokenId(plan.bin);
      const saved = await storeArrayBuffer(id, plan.bin);
      if (!saved) {
        failures.push({ role: { name: plan.name }, error: "保存bin失败" });
        continue;
      }
      const record = {
        id,
        name: plan.name,
        token: roleToken,
        server: plan.server,
        wsUrl: plan.wsUrl || "",
        importMethod: "wxQrcode",
        accountKey: plan.accountKey,
        roleId: plan.roleId,
        roleIndex: plan.roleIndex,
        updatedAt: new Date().toISOString(),
      };
      if (plan.isUpdate) {
        tokenStore.updateToken(id, record);
        updated++;
        messages.push(`更新 ${plan.name} → 复用 id ${id}（定时任务引用不变）`);
      } else {
        tokenStore.addToken(record);
        created++;
        messages.push(`新增 ${plan.name} → ${id}`);
      }
    }
    for (const f of failures) messages.push(`失败 ${f.role?.name || "?"}: ${f.error}`);
    lastResult.value = { updated, created, failed: failures.length, messages };
    if (failures.length) message.warning(`导入完成，${failures.length} 个失败`);
    else message.success(`导入完成：更新 ${updated}，新增 ${created}`);
    emit("ok");
  } finally {
    isImporting.value = false;
  }
};
</script>

<style scoped lang="scss">
.qr-login-block { display: flex; gap: 20px; align-items: flex-start; }
.qr-image-wrap { flex: 0 0 auto; }
.qr-image { width: 180px; height: 180px; border: 1px solid #e0e0e0; border-radius: 10px; }
.qr-placeholder {
  width: 180px; height: 180px; border: 2px dashed #d0d0d0; border-radius: 10px;
  display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 13px; background: #fafafa;
}
.qr-side { flex: 1; }
.scan-status { font-size: 13px; padding: 6px 10px; border-radius: 6px; background: #f0f0f0; color: #666; }
.scan-status.success { background: rgba(24, 160, 88, 0.1); color: #18a058; }
.scan-status.error { background: rgba(208, 48, 48, 0.1); color: #d03050; }
.comb-user-tip { font-size: 12px; color: #18a058; }
.scan-hint { font-size: 12px; color: #999; }
.form-actions { margin-top: 20px; display: flex; gap: 12px; }
</style>
