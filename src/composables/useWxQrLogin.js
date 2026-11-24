/**
 * 微信扫码登录 composable —— 把 Worker 配置、扫码轮询、登录态从 UI 中解耦。
 *
 * 借鉴 demoqr 的可配置代理方案：
 *   - Worker URL 由用户填写并存 localStorage（可填独立部署的 CF Worker）
 *   - 未填时回退到同源 ""（部署在 Cloudflare Pages 时 /api/* 由 _worker.js 处理）
 * 这样同一份静态站点（GitHub Pages / CF Pages / 任意托管）都能用扫码。
 */
import { ref } from "vue";
import {
  buildCombLoginUrl,
  buildLoginPayload,
  buildQrPageUrl,
  buildScanStatusUrl,
  buildServerListBin,
  buildServerListUrl,
  encodePayload,
  parseCombUser,
  parseQrPage,
  parseScanStatus,
  parseServerRoles,
  QR_CONFIG,
  SCAN_STATE,
} from "@/utils/wxQrLogin";

const WORKER_URL_STORAGE_KEY = "wxqr_worker_url";

export const useWxQrLogin = () => {
  // ---- Worker 配置 ----
  const workerUrl = ref(localStorage.getItem(WORKER_URL_STORAGE_KEY) || "");
  const setWorkerUrl = (url) => {
    const clean = String(url || "").trim().replace(/\/+$/, "");
    workerUrl.value = clean;
    if (clean) localStorage.setItem(WORKER_URL_STORAGE_KEY, clean);
    else localStorage.removeItem(WORKER_URL_STORAGE_KEY);
  };
  // 同源部署（CF Pages）时为空串即可；外部 Worker 时用填的地址
  const workerBase = () => workerUrl.value;

  // ---- 状态 ----
  const qrUrl = ref("");
  const qrUuid = ref("");
  const scanStatus = ref("点击「获取微信二维码」开始");
  const scanStatusType = ref("info");
  const combUser = ref(null);
  const combUserNickname = ref("");
  const isFetchingQr = ref(false);
  const isFetchingRoles = ref(false);

  const setStatus = (text, type = "info") => {
    scanStatus.value = text;
    scanStatusType.value = type;
  };

  // ---- 轮询控制 ----
  let scanTimer = null;
  let scanStartedAt = 0;
  // 会话序号：刷新二维码/reset 时递增，让旧会话的异步结果失效，避免竞态回填
  let sessionId = 0;
  const stopPolling = () => {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
  };

  // ---- 角色列表回调（由使用方注入，避免 composable 依赖 UI/store）----
  let onRolesLoaded = () => {};

  const parseRolesToRows = (list) =>
    list.map((r) => ({
      serverId: r.serverId,
      roleId: String(r.roleId ?? ""),
      name: r.name || "",
      power: r.power || 0,
    }));

  // Step 1: 二维码
  const fetchQrCode = async () => {
    isFetchingQr.value = true;
    stopPolling();
    const mySession = ++sessionId;
    try {
      setStatus("正在获取微信二维码...", "info");
      const res = await fetch(buildQrPageUrl(workerBase()), {
        headers: { Accept: "text/html" },
      });
      if (!res.ok) throw new Error(`获取二维码页面失败 HTTP ${  res.status}`);
      const parsed = parseQrPage(await res.text());
      if (mySession !== sessionId) return false; // 期间被刷新/重置，丢弃旧结果
      if (!parsed) throw new Error("未在登录页找到二维码图片");
      qrUrl.value = parsed.qrUrl;
      qrUuid.value = parsed.uuid;
      combUser.value = null;
      combUserNickname.value = "";
      setStatus("请用微信扫码登录", "success");
      startPolling();
      return true;
    } catch (e) {
      setStatus(`获取二维码失败: ${  e?.message || e}`, "error");
      return false;
    } finally {
      isFetchingQr.value = false;
    }
  };

  // Step 2: 扫码状态轮询（串行，避免请求叠加）
  const startPolling = () => {
    stopPolling();
    scanStartedAt = Date.now();
    const mySession = sessionId;
    let pollInFlight = false;
    scanTimer = setInterval(async () => {
      if (!qrUuid.value || pollInFlight || mySession !== sessionId) return;
      if (Date.now() - scanStartedAt > QR_CONFIG.scanTimeoutMs) {
        stopPolling();
        setStatus("二维码已超时，请刷新", "error");
        return;
      }
      pollInFlight = true;
      try {
        const res = await fetch(
          buildScanStatusUrl(workerBase(), qrUuid.value),
          { headers: { Accept: "*/*" } },
        );
        const result = parseScanStatus(await res.text());
        if (mySession !== sessionId) return; // 会话已切换，丢弃结果
        if (result.state === SCAN_STATE.SUCCESS) {
          stopPolling();
          combUserNickname.value = result.nickname || "";
          setStatus("扫码成功，正在登录...", "success");
          await loginWithCode(result.code, mySession);
        } else if (result.state === SCAN_STATE.EXPIRED) {
          stopPolling();
          setStatus("二维码已过期，请刷新", "error");
        }
      } catch {
        // 轮询偶发失败忽略，继续下一次
      } finally {
        pollInFlight = false;
      }
    }, 1500);
  };

  // Step 3: code → combUser
  const loginWithCode = async (code, mySession = sessionId) => {
    try {
      const payload = encodePayload(JSON.stringify(buildLoginPayload(code)));
      const res = await fetch(buildCombLoginUrl(workerBase()), {
        method: "POST",
        headers: { Accept: "*/*", "Content-Type": "text/plain; charset=utf-8" },
        body: payload,
      });
      if (!res.ok) throw new Error(`登录请求失败 HTTP ${  res.status}`);
      const user = parseCombUser(await res.json());
      if (mySession !== sessionId) return; // 会话已切换
      if (!user) throw new Error("登录失败");
      combUser.value = user;
      setStatus("登录成功，正在拉取角色列表...", "success");
      await fetchRolesFromCombUser(mySession);
    } catch (e) {
      if (mySession === sessionId) setStatus(`登录失败: ${  e?.message || e}`, "error");
    }
  };

  // Step 4: combUser → 角色列表
  const fetchRolesFromCombUser = async (mySession = sessionId) => {
    if (!combUser.value) {
      setStatus("请先扫码登录", "error");
      return [];
    }
    isFetchingRoles.value = true;
    try {
      const bin = buildServerListBin(combUser.value);
      const res = await fetch(buildServerListUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bin,
      });
      if (!res.ok) throw new Error(`角色列表请求失败 HTTP ${  res.status}`);
      const rows = parseRolesToRows(parseServerRoles(await res.arrayBuffer()));
      if (mySession !== sessionId) return []; // 会话已切换，丢弃旧角色列表
      setStatus(`拉取到 ${rows.length} 个角色`, "success");
      onRolesLoaded(rows);
      return rows;
    } catch (e) {
      if (mySession === sessionId) setStatus(`拉取角色失败: ${  e?.message || e}`, "error");
      return [];
    } finally {
      isFetchingRoles.value = false;
    }
  };

  // 测试 Worker 是否可达（借鉴 demoqr 的「测试」按钮）
  const testWorker = async () => {
    if (!workerUrl.value) return { ok: false, message: "请先填写 Worker URL" };
    try {
      const res = await fetch(
        buildQrPageUrl(workerBase()),
        { headers: { Accept: "text/html" } },
      );
      const ok = res.ok && (await res.text()).length > 0;
      return { ok, message: ok ? "Worker 连接成功" : `Worker 返回 HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, message: `Worker 连接失败: ${  e?.message || e}` };
    }
  };

  const reset = () => {
    sessionId++; // 让进行中的异步流程失效
    stopPolling();
    qrUrl.value = "";
    qrUuid.value = "";
    combUser.value = null;
    combUserNickname.value = "";
    setStatus("点击「获取微信二维码」开始");
  };

  return {
    // Worker 配置
    workerUrl,
    setWorkerUrl,
    testWorker,
    // 扫码状态
    qrUrl,
    scanStatus,
    scanStatusType,
    combUser,
    combUserNickname,
    isFetchingQr,
    isFetchingRoles,
    // 操作
    fetchQrCode,
    fetchRolesFromCombUser,
    stopPolling,
    reset,
    // 回调注入
    setRolesLoadedHandler: (fn) => {
      if (typeof fn === "function") onRolesLoaded = fn;
    },
  };
};
