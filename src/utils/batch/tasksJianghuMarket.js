import { normalizeMarketList, runJianghuMarket } from "./jianghuMarket.js";

const REPORT_STATUS = {
  completed: "completed",
  skipped: "skipped",
  reconciled: "completed",
  closed: "skipped",
  insufficient: "skipped",
  stopped: "stopped",
  unverified: "warning",
  failed: "failed",
};

export function createTasksJianghuMarket(d) {
  let active = false;
  let cancelled = false;
  const stopped = () => cancelled || d.shouldStop.value;
  const runMarket = d.runJianghuMarket || runJianghuMarket;
  const log = (name, message, type = "info") => d.addLog({
    time: new Date().toLocaleTimeString(),
    type,
    message: `[江湖黑市][${name}] ${message}`,
  });

  return {
    stopJianghuMarket() {
      cancelled = true;
    },

    async batchJianghuMarket(input) {
      if (active || d.isBusy() || !d.selectedTokens.value.length) return [];
      let list;
      try {
        list = normalizeMarketList(input);
      } catch (error) {
        d.message.error(error.message);
        return [];
      }

      active = true;
      cancelled = false;
      d.shouldStop.value = false;
      d.isRunning.value = true;
      d.rows.value = [];
      const results = [];
      let lease;
      try {
        lease = await d.acquireLease();
        for (const id of [...new Set(d.selectedTokens.value)]) {
          if (stopped()) {
            d.tokenStatus.value[id] = "stopped";
            results.push({ tokenId: id, status: "stopped", details: ["用户主动停止，未执行"] });
            continue;
          }

          const name = d.tokens.value.find((token) => token.id === id)?.name || String(id);
          let connected = false;
          let submitted = false;
          let last = 0;
          const open = async () => {
            if (!connected) {
              await d.openReadOnly(id, () => !submitted && stopped());
              connected = true;
              last = Date.now();
            }
          };

          d.tokenStatus.value[id] = "running";
          try {
            await open();
            const result = await runMarket({
              id,
              list,
              ledger: d.ledger,
              stopped,
              onLog: (message) => log(name, message),
              onUncertain: async () => {
                await d.closeReadOnly(id);
                connected = false;
              },
              send: async (cmd, body) => {
                await open();
                const wait = Math.max(0, 1000 - (Date.now() - last));
                if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
                if (cmd === "activity_buystoregoods" && stopped()) {
                  throw Object.assign(new Error("用户主动停止"), { status: "stopped", notSent: true });
                }
                last = Date.now();
                if (cmd === "activity_buystoregoods") submitted = true;
                return d.tokenStore.sendMessageWithPromise(id, cmd, body, 10000);
              },
            });

            d.rows.value.push({ id, name, ...result });
            const uiStatus = result.status === "stopped"
              ? "stopped"
              : ["completed", "skipped", "reconciled", "closed", "insufficient"].includes(result.status)
                ? "completed"
                : "failed";
            d.tokenStatus.value[id] = uiStatus;

            const reportStatus = REPORT_STATUS[result.status] || "warning";
            const detail = result.message || `江湖黑市返回状态：${result.status || "未知"}`;
            results.push({
              tokenId: id,
              status: reportStatus,
              details: [detail],
              warnings: ["warning", "failed"].includes(reportStatus) ? [detail] : [],
              verificationRequired: result.status === "unverified",
              verificationDetails: result.status === "unverified" ? [detail] : [],
            });
            log(name, detail, ["completed", "skipped", "reconciled", "closed", "insufficient"].includes(result.status) ? "info" : "warning");
          } catch (error) {
            const detail = error?.message || "连接或执行异常，请核对；未自动重试";
            d.rows.value.push({ id, name, status: "unverified", message: detail });
            d.tokenStatus.value[id] = "failed";
            results.push({ tokenId: id, status: "warning", details: [detail], warnings: [detail],
              verificationRequired: true, verificationDetails: [detail] });
            log(name, detail, "warning");
          } finally {
            try {
              await d.closeReadOnly(id);
            } catch {
              log(name, "关闭连接失败，请刷新页面并核对", "warning");
            }
          }
        }
      } finally {
        try {
          await d.releaseLease(lease);
        } finally {
          active = false;
          d.isRunning.value = false;
        }
      }
      return results;
    },
  };
}
