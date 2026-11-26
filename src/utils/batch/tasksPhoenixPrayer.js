import { safeError } from "../campReadOnly.js";
import { runPhoenixPrayer } from "./phoenixPrayer.js";

export async function batchPhoenixPrayer(d) {
  const selected = [...new Set(d.selectedTokens.value || [])];
  if (d.isBusy() || !selected.length) return [];

  const locks = d.locks || globalThis.navigator?.locks;
  if (!locks?.request) {
    d.message.error("浏览器不支持跨标签互斥，请在 HTTPS 或 localhost 打开");
    return [];
  }
  const storage = d.storage || globalThis.localStorage;
  if (!storage?.getItem || !storage?.setItem || !storage?.removeItem) {
    d.message.error("凤仪祈愿未执行：本地未决记录存储不可用");
    return [];
  }

  return locks.request("xyzw-phoenix-prayer", { ifAvailable: true }, async (lock) => {
    const selected = [...new Set(d.selectedTokens.value || [])];
    if (!selected.length) return [];
    if (!lock || d.isBusy()) {
      d.message.warning("已有任务在运行或其他标签页正在执行凤仪祈愿");
      return selected.map((id) => ({ tokenId: id, status: "skipped", details: ["凤仪祈愿互斥锁未取得，未执行"] }));
    }

    const results = [];
    d.isRunning.value = true;
    d.shouldStop.value = false;
    let lease;
    try {
      lease = await d.acquireLease();
      for (const id of selected) {
        if (d.shouldStop.value) {
          d.tokenStatus.value[id] = "stopped";
          results.push({ tokenId: id, status: "stopped", details: ["用户主动停止，未执行"] });
          continue;
        }

        const name = d.tokens.value.find((token) => token.id === id)?.name ?? String(id);
        const log = (message, type = "info") => d.addLog({
          time: new Date().toLocaleTimeString(),
          type,
          message: `[凤仪祈愿][${name}] ${message}`,
        });
        let connected = false;
        try {
          d.currentRunningTokenId.value = id;
          d.tokenStatus.value[id] = "running";
          await d.openReadOnly(id, () => d.shouldStop.value);
          connected = true;
          const token = d.tokens.value.find((item) => item.id === id);
          let status = "completed";
          let warnings = [];
          const result = await (d.runPhoenixPrayer || runPhoenixPrayer)({
            storage,
            stopped: () => d.shouldStop.value,
            log,
            onStatus: (outcome, reasons = []) => {
              status = outcome; warnings = reasons;
            },
            expectedRole: token?.roleId,
            send: async (cmd, args) => {
              if (d.shouldStop.value) throw new Error("用户已停止");
              try {
                return await d.tokenStore.sendMessageWithPromise(id, cmd, args, 10000);
              } finally {
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            },
          });
          const detail = String(result || "凤仪祈愿执行完成");
          d.tokenStatus.value[id] = status;
          results.push({ tokenId: id, status, details: [detail], warnings });
          log(detail, status === "warning" ? "warning" : "info");
        } catch (error) {
          const detail = safeError(error);
          const status = d.shouldStop.value ? "stopped" : "failed";
          d.tokenStatus.value[id] = status;
          results.push({ tokenId: id, status, details: [detail], warnings: status === "failed" ? [detail] : [] });
          log(detail, "warning");
        } finally {
          if (connected) await d.closeReadOnly(id);
        }
      }
      return results;
    } finally {
      try {
        await d.releaseLease(lease);
      } finally {
        d.currentRunningTokenId.value = null;
        d.isRunning.value = false;
      }
    }
  });
}
