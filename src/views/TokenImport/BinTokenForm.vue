<template>
  <!-- 手动输入表单 -->
  <NForm
    :model="importForm"
    label-placement="top"
    size="large"
    :show-label="true"
  >
    <NFormItem label="bin文件" :show-label="true">
      <a-upload
        multiple
        accept="*.bin,*.dmp"
        @before-upload="uploadBin"
        draggable
        dropzone
        placeholder="粘贴Token字符串..."
        clearable
      >
        <!-- <div class="dropzone-content">
          请点击上传或将bind文件拖拽到此处
        </div> -->
      </a-upload>
    </NFormItem>

    <NFormItem label="角色命名格式" :show-label="true">
      <NInput
        v-model:value="importForm.nameTemplate"
        placeholder="{name}-{index}-{id}"
      />
      <template #feedback>
        支持变量: {name}角色名, {id}角色ID, {index}角色序号, {server}区服
      </template>
    </NFormItem>

    <ServerRoleList
      :data="serverListData"
      max-height="50vh"
      @add="addSelectedRole"
      @download="handleDownload"
    />

    <a-list>
      <a-list-item v-for="(role, roleIndex) in roleList" :key="roleIndex">
        <div
          style="
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
          "
        >
          <div>
            <strong>角色名称:</strong> {{ role.name || "未命名角色" }}<br />
            <strong>Token:</strong>
            <span style="word-break: break-all">{{ role.token }}</span
            ><br />
            <strong>服务器:</strong> {{ role.server || "未指定" }}<br />
            <strong>角色序号:</strong> {{ role.roleIndex }}
          </div>
          <NButton type="error" size="small" @click="removeRole(roleIndex)">
            删除
          </NButton>
        </div>
      </a-list-item>
    </a-list>

    <div class="form-actions">
      <NButton
        type="primary"
        size="large"
        block
        :loading="isImporting"
        @click="handleImport"
      >
        <template #icon>
          <NIcon>
            <CloudUpload />
          </NIcon>
        </template>
        添加Token
      </NButton>

      <NButton v-if="tokenStore.hasTokens" size="large" block @click="cancel">
        取消
      </NButton>
    </div>
  </NForm>
</template>

<script lang="ts" setup>
import { CloudUpload } from "@vicons/ionicons5";
import { NButton, NForm, NFormItem, NIcon, NInput, useMessage } from "naive-ui";
import PQueue from "p-queue";

import { reactive, ref } from "vue";

import useIndexedDB from "@/hooks/useIndexedDB";
import { useTokenStore } from "@/stores/tokenStore";
import { buildAccountKey } from "@/utils/accountIdentity";
import {
  buildRoleBin,
  downloadBinFile,
  getRoleBinFileName,
} from "@/utils/binFile";
import { g_utils } from "@/utils/bonProtocol";
import { getServerList, getTokenId, transformToken } from "@/utils/token";

const $emit = defineEmits(["cancel", "ok"]);

const { storeArrayBuffer } = useIndexedDB();

const cancel = () => {
  roleList.value = [];
  $emit("cancel");
};

const removeRole = (index: number) => {
  roleList.value.splice(index, 1);
};

const tokenStore = useTokenStore();
const message = useMessage();
const isImporting = ref(false);
const importForm = reactive({
  name: "",
  server: "",
  wsUrl: "",
  importMethod: "",
  nameTemplate: "{name}-{index}-{id}",
});
const roleList = ref<
  Array<{
    id: string;
    name: string;
    roleId: string;
    token: string;
    server: string;
    roleIndex?: number;
    wsUrl: string;
    importMethod: string;
  }>
>([]);
const serverListData = ref<any[]>([]);
const currentBinData = ref<ArrayBuffer | null>(null);
const binDecodedResult = ref("");
const originalBinData = ref<any>(null);

const tQueue = new PQueue({ concurrency: 1, interval: 1000 });

const handleDownload = (roleInfo: any) => {
  if (!originalBinData.value) {
    message.error("Bin数据丢失，请重新上传");
    return;
  }
  try {
    const newBinBuffer = buildRoleBin(originalBinData.value, roleInfo.serverId);
    const fileName = getRoleBinFileName(roleInfo);
    downloadBinFile(fileName, newBinBuffer);
    message.success(`已开始下载: ${fileName}`);
  } catch (e: any) {
    console.error("下载失败", e);
    message.error(`下载失败: ${e.message}`);
  }
};

const addSelectedRole = async (roleInfo: any) => {
  if (!originalBinData.value) {
    message.error("Bin数据丢失，请重新上传");
    return;
  }

  try {
    const newBinBuffer = buildRoleBin(originalBinData.value, roleInfo.serverId);
    const contentId = getTokenId(newBinBuffer);
    const roleToken = await transformToken(newBinBuffer);
    const roleName = roleInfo.name || `角色_${roleInfo.roleId}`;

    let sid = Number(roleInfo.serverId);
    let roleIndex = 0;
    if (sid >= 2000000) {
      roleIndex = 2;
      sid -= 2000000;
    } else if (sid >= 1000000) {
      roleIndex = 1;
      sid -= 1000000;
    }
    const serverNum = sid - 27;

    const template = importForm.nameTemplate || "{name}-{index}-{id}";
    const finalName = template
      .replace(/\{name\}/g, () => roleName)
      .replace(/\{index\}/g, () => String(roleIndex))
      .replace(/\{id\}/g, () => String(roleInfo.roleId))
      .replace(/\{server\}/g, () => `${String(serverNum)}服`);

    // 用稳定身份「服务器:角色ID」匹配已有账号：
    // 命中则复用旧 id，让定时任务/分组/账号设置里的引用继续有效；
    // 未命中才用 bin 内容 MD5 作为新 id。
    // server 参数与账号存储格式统一为「<服务器>服」，保证 legacy 账号也能按 roleId 匹配。
    const accountKey = buildAccountKey(serverNum, roleInfo.roleId);
    const serverLabel = `${String(serverNum)}服`;
    const existingToken = tokenStore.findTokenByAccountKey(
      accountKey,
      roleInfo.roleId || null,
      serverLabel,
      finalName,
    );
    const tokenId = existingToken?.id || contentId;

    // 判重按稳定身份 accountKey（不再用会随命名模板变化的 name）
    const exists = roleList.value.some((r) => r.accountKey === accountKey && accountKey !== null);
    if (exists) {
      message.warning(`角色 ${finalName} 已在待添加列表中`);
      return;
    }

    if (existingToken) {
      message.warning(
        `识别到已有角色"${finalName}"，导入后将更新该账号（定时任务等设置保持不变）`,
      );
    } else {
      message.success(`已添加角色: ${finalName}`);
    }

    // 匹配结果（id / isUpdate）与 bin 一起挂到 role 上，提交阶段统一落库，
    // 保证 bin 存储位置与 token id 始终一致，也避免取消时提前覆盖旧账号的 bin。
    roleList.value.push({
      id: tokenId,
      roleId: roleInfo.roleId,
      token: roleToken,
      name: finalName,
      server: serverLabel,
      roleIndex,
      wsUrl: importForm.wsUrl || existingToken?.wsUrl || "",
      importMethod: "bin",
      accountKey,
      isUpdate: Boolean(existingToken),
      binBuffer: newBinBuffer,
    });
  } catch (e: any) {
    console.error("添加角色失败", e);
    message.error(`添加角色失败: ${e.message}`);
  }
};

const uploadBin = (binFile: File) => {
  // 必须 await 文件读取完成，否则 PQueue 的 concurrency:1 形同虚设，
  // 多文件上传时回调乱序会覆盖 currentBinData/originalBinData，导致配错角色。
  tQueue.add(async () => {
    console.log("上传文件数据:", binFile);
    const userToken = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as ArrayBuffer);
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.readAsArrayBuffer(binFile);
    }).catch((err) => {
      message.error(err?.message || "读取文件失败，请重试");
      return null;
    });
    if (!userToken) return;
    currentBinData.value = userToken;

    // 获取服务器角色列表
    try {
      const listStr = await getServerList(userToken);
      const parsedList = JSON.parse(listStr);
      if (parsedList && typeof parsedList === "object") {
        serverListData.value = Object.values(parsedList).sort(
          (a: any, b: any) => b.power - a.power,
        );
      } else {
        serverListData.value = [];
      }
      console.log("Server List:", parsedList);
      message.success("获取服务器角色列表成功，请选择角色添加");
    } catch (err) {
      console.error("Failed to get server list", err);
      message.warning("获取服务器角色列表失败，请检查文件是否正确");
      serverListData.value = [];
    }

    // 尝试解析 bin 文件内容
    try {
      const binMsg = g_utils.parse(userToken);
      let binData = binMsg.getData();
      if (!binData && (binMsg as any)._raw) {
        console.log("Bin文件 getData() 为空，尝试使用 _raw");
        binData = { ...(binMsg as any)._raw };
      }
      console.log("Bin文件解析:", binData);
      binDecodedResult.value = JSON.stringify(binData, null, 2);
      originalBinData.value = binData;
    } catch (err: any) {
      console.error("Bin文件解析失败", err);
      binDecodedResult.value = `Bin文件解析失败: ${err.message || err}`;
    }
  });
  return false; // 阻止自动上传
};

const handleImport = async () => {
  if (roleList.value.length === 0) {
    message.error("请先上传bin文件！");
    return;
  }
  // 匹配在 addSelectedRole 阶段已完成，id 与 bin 存储位置在此统一落库，
  // 保证两者一致；命中旧账号则更新（复用 id，定时任务引用不变），否则新增。
  let succeeded = 0;
  let failed = 0;
  for (const role of roleList.value) {
    const { id, isUpdate, binBuffer } = role;
    if (binBuffer) {
      const saved = await storeArrayBuffer(id, binBuffer);
      if (!saved) {
        message.error(`保存BIN数据到IndexedDB失败: ${role.name}`);
        failed++;
        continue;
      }
    }
    const record = { ...role };
    delete record.binBuffer; // 不把二进制塞进 token 记录
    delete record.isUpdate; // 内部标记不写入 token 记录
    if (isUpdate) {
      console.log("更新同名token（保留id，定时任务引用不变）:", role.name);
      tokenStore.updateToken(id, record);
    } else {
      tokenStore.addToken(record);
    }
    succeeded++;
  }
  console.log("当前Token列表:", tokenStore.gameTokens);
  if (failed > 0) message.warning(`Token添加完成：成功 ${succeeded}，失败 ${failed}`);
  else message.success("Token添加成功");
  roleList.value = [];
  $emit("ok");
};
</script>

<style scoped lang="scss">
.optional-fields {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;

  n-form-item {
    flex: 1;
    min-width: 200px;
  }
}

.form-actions {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dropzone-content {
  width: 100%;
  border: 1px dashed #fcc;
  border-radius: 8px;
  text-align: center;
  color: #888;
  padding: 40px 20px;
  font-size: 12px;
}
</style>

<route lang="json">
{
  "name": "/TokenImport/bin",
  "path": "/TokenImport/bin"
}
</route>
