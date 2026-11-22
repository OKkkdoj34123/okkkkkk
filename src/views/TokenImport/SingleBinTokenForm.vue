<template>
  <!-- 手动输入表单 -->
  <NForm
    :model="importForm"
    label-placement="top"
    size="large"
    :show-label="true"
  >
    <NFormItem label="游戏角色名称" :show-label="true">
      <NInput
        v-model:value="importForm.name"
        placeholder="例如：主号战士"
        clearable
      />
    </NFormItem>

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
    <a-list>
      <a-list-item v-for="(role, roleIndex) in roleList" :key="roleIndex">
        <div>
          <strong>角色名称:</strong> {{ role.name || "未命名角色" }}<br />
          <strong>Token:</strong>
          <span style="word-break: break-all">{{ role.token }}</span
          ><br />
          <strong>服务器:</strong> {{ role.server || "未指定" }}
        </div>
      </a-list-item>
    </a-list>

    <!-- 角色详情 -->
    <NCollapse>
      <NCollapseItem title="角色详情 (可选)" name="optional">
        <div class="optional-fields">
          <NFormItem label="服务器">
            <NInput
              v-model:value="importForm.server"
              placeholder="服务器名称"
            />
          </NFormItem>

          <NFormItem label="自定义连接地址">
            <NInput
              v-model:value="importForm.wsUrl"
              placeholder="留空使用默认连接"
            />
          </NFormItem>
        </div>
      </NCollapseItem>
    </NCollapse>

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
import {
  NButton,
  NCollapse,
  NCollapseItem,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  useMessage,
} from "naive-ui";
import PQueue from "p-queue";

import { reactive, ref } from "vue";

import useIndexedDB from "@/hooks/useIndexedDB";
import { useTokenStore } from "@/stores/tokenStore";
import {
  buildAccountKey,
  parseBinFileName,
} from "@/utils/accountIdentity";
import { getTokenId, transformToken } from "@/utils/token";

const $emit = defineEmits(["cancel", "ok"]);

const { storeArrayBuffer } = useIndexedDB();

const cancel = () => {
  roleList.value = [];
  $emit("cancel");
};

const tokenStore = useTokenStore();
const message = useMessage();
const isImporting = ref(false);
const importForm = reactive({
  name: "",
  server: "",
  wsUrl: "",
  importMethod: "",
});
const roleList = ref<
  Array<{
    id: string;
    name: string;
    token: string;
    server: string;
    wsUrl: string;
    importMethod: string;
    accountKey?: string | null;
    roleId?: string | null;
    roleIndex?: string | null;
  }>
>([]);

const tQueue = new PQueue({ concurrency: 1, interval: 1000 });

const initName = (fileName: string) => {
  if (!fileName) return;
  fileName = fileName.trim();
  const binRes = fileName.match(/^bin-(.*?)服-([0-2])-(\d{6,12})-(.*)\.bin$/);
  console.log(binRes);
  if (binRes) {
    importForm.name = `${binRes[1]}_${binRes[2]}_${binRes[4]}`;
    return {
      server: binRes[1],
      roleIndex: binRes[2],
      roleId: binRes[3],
      roleName: binRes[4],
    };
  }
  return {
    server: "",
    roleIndex: "",
    roleId: "",
    roleName: importForm.name || "",
  };
};

const uploadBin = (binFile: File) => {
  tQueue.add(async () => {
    console.log("上传文件数据:", binFile);
    const roleMeta = initName(binFile.name) as any;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const userToken = e.target?.result as ArrayBuffer;
      // console.log('转换Token:', userToken);
      const contentId = getTokenId(userToken);
      const roleToken = await transformToken(userToken);
      const roleName = roleMeta.roleName || binFile.name.split(".")?.[0] || "";

      // 用文件名里的稳定角色标识（服务器+角色ID）查找已有账号：
      // 命中则复用旧 id，让定时任务/分组/账号设置里的引用继续有效；
      // 未命中才用 bin 内容 MD5 作为新 id。
      const accountKey = buildAccountKey(roleMeta.server, roleMeta.roleId);
      const existingToken = tokenStore.findTokenByAccountKey(
        accountKey,
        roleMeta.roleId || null,
        `${roleMeta.server}${roleMeta.roleIndex}` || roleMeta.server || "",
        roleName,
      );
      const tokenId = existingToken?.id || contentId;

      // 把新 bin 存到（可能复用的）id 下，刷新时即可读取到最新数据
      const saved = await storeArrayBuffer(tokenId, userToken);
      if (!saved) {
        message.error("保存BIN数据到IndexedDB失败");
        return;
      }

      // 上传列表中发现已存在的重复名称，提示消息
      if (roleList.value.some((role) => role.id === tokenId)) {
        message.error("上传列表中已存在同名角色! ");
        return;
      }
      if (existingToken) {
        message.warning(
          `识别到已有角色"${roleName}"，导入后将更新该账号（定时任务等设置保持不变）`,
        );
      } else {
        message.success("Token读取成功，请检查角色名称等信息后提交");
      }
      roleList.value.push({
        id: tokenId,
        token: roleToken,
        name: roleName,
        server: `${roleMeta.server}${roleMeta.roleIndex}` || "",
        wsUrl: importForm.wsUrl || existingToken?.wsUrl || "",
        importMethod: "bin",
        accountKey,
        roleId: roleMeta.roleId || existingToken?.roleId || null,
        roleIndex: roleMeta.roleIndex || existingToken?.roleIndex || null,
      });
    };
    reader.onerror = () => {
      message.error("读取文件失败，请重试");
    };
    reader.readAsArrayBuffer(binFile);
  });
  return false; // 阻止自动上传
};

const handleImport = async () => {
  if (roleList.value.length === 0) {
    message.error("请先上传bin文件！");
    return;
  }
  roleList.value.forEach((role) => {
    // tokenStore.gameTokens中发现已存在的重复名称，则移出token后重新添加
    const gameToken = tokenStore.gameTokens.find((t) => t.id === role.id);
    if (gameToken) {
      // 同一角色更新：保留原 id，定时任务/分组/账号设置引用不变
      console.log("更新同名token:", gameToken);
      tokenStore.updateToken(gameToken.id, {
        ...role,
      });
    } else {
      tokenStore.addToken({
        ...role,
      });
    }
  });
  console.log("当前Token列表:", tokenStore.gameTokens);
  message.success("Token添加成功");
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
  "name": "/TokenImport/singlebin",
  "path": "/TokenImport/singlebin"
}
</route>
