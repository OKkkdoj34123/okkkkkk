import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { getActivityCycle, getGameDateKey } from "./activityCycle.js";
import { resolveBatches } from "./batchResolver.js";
import { generateDayPlan, generateWeekPlan } from "./planGenerator.js";
import { createAutoScheduler } from "./scheduler.js";
import { CONFIG_KEY, createScheduleStorage, normalizeConfig, RECORD_PREFIX } from "./scheduleStorage.js";

export function useAutoSchedule({ groups, tokens, enqueue, execute, waitForIdle, log }) {
  const storage = createScheduleStorage(localStorage);
  const config = ref(normalizeConfig());
  const now = ref(Date.now());
  const records = ref([]);
  const runtimeState = ref({ leader: false, pending: 0, error: "" });
  const storageError = ref("");
  const refresh = () => {
    now.value = Date.now();
    try {
      config.value = storage.loadConfig();
      records.value = storage.list();
      storageError.value = "";
    } catch (error) {
      storageError.value = `自动计划存储不可用：${error.message}`;
    }
  };
  refresh();
  const runtime = createAutoScheduler({ storage, locks: globalThis.navigator?.locks, enqueue, execute, waitForIdle, getGroups: () => groups.value, getTokens: () => tokens.value, log, onChange: (state) => {
    runtimeState.value = state;
    refresh();
  } });
  const save = async (value) => {
    try {
      // Serialize the short read-modify-write across tabs, independently of scheduler leadership.
      const persist = () => {
        config.value = storage.saveConfig(value);
      };
      const locks = globalThis.navigator?.locks;
      if (locks?.request)
        await locks.request(`${CONFIG_KEY}:write`, persist);
      else
        persist();
      runtime.clearError();
      runtime.poll();
      return true;
    } catch (error) {
      storageError.value = `自动计划配置保存失败：${error.message}`;
      return false;
    }
  };
  const today = computed(() => generateDayPlan(getGameDateKey(now.value), config.value));
  const week = computed(() => generateWeekPlan(now.value, config.value));
  const batches = computed(() => resolveBatches(config.value, groups.value, tokens.value));
  const activity = computed(() => getActivityCycle(now.value, config.value.manualCycleOverride));
  const onStorage = (event) => {
    if (event.key === null || event.key === CONFIG_KEY || event.key?.startsWith(RECORD_PREFIX)) {
      refresh();
      runtime.poll();
    }
  };
  let timer;
  onMounted(() => {
    runtime.poll();
    timer = setInterval(() => {
      refresh();
      runtime.poll();
    }, 5000);
    window.addEventListener("storage", onStorage);
  });
  onBeforeUnmount(() => {
    clearInterval(timer);
    window.removeEventListener("storage", onStorage);
    runtime.dispose();
  });
  return { config, now, records, today, week, batches, activity, runtimeState, storageError, save, runtime };
}
