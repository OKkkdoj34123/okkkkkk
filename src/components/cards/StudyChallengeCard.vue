<template>
  <MyCard
    class="study"
    :statusClass="{ weekly: true, completed: study.status === 'completed' || study.status === 'skipped' }"
  >
    <template #icon>
      <img src="/icons/1736425783912140.png" alt="学习图标" />
    </template>
    <template #title>
      <h3>咸鱼大冲关</h3>
      <p>每日知识挑战</p>
    </template>
    <template #badge>
      <span>每周任务</span>
    </template>
    <template #default>
      <p class="description">没有什么可以阻挡我求知的欲望！</p>
    </template>
    <template #action>
      <a-button status="primary" :disabled="study.isAnswering" @click="startStudy">
        {{ study.isAnswering ? (study.status === "claiming_rewards" ? "领取奖励中…" : "答题状态核验中…") : "一键答题" }}
      </a-button>
      <p v-if="study.detail">{{ study.detail }}</p>
    </template>
  </MyCard>
</template>

<script setup>
import { computed } from "vue";
import { useMessage } from "naive-ui";
import { runStudy } from "@/stores/events/study.ts";
import { useTokenStore } from "@/stores/tokenStore";
import MyCard from "../Common/MyCard.vue";

const tokenStore = useTokenStore();
const message = useMessage();
const study = computed(() => tokenStore.gameData.studyStatuses?.[tokenStore.selectedToken?.id] || {});

const startStudy = async () => {
  const tokenId = tokenStore.selectedToken?.id;
  if (!tokenId) return;
  try {
    const result = await runStudy(tokenStore, tokenId);
    if (result.status === "completed") message.success(result.detail);
    else if (result.status === "skipped") message.info(result.detail);
    else message.warning(result.detail);
  } catch (error) {
    message.error(String(error?.message || error));
  }
};
</script>
