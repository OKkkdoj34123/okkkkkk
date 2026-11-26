const PUSHPLUS_ENDPOINT = "https://www.pushplus.plus/send";
const PUSHPLUS_SETTINGS_KEY = "xyzw_pushplus_settings_v1";
const PUSHPLUS_RATE_KEY = "xyzw_pushplus_last_request_v1";
const PUSHPLUS_DEDUPE_KEY = "xyzw_pushplus_delivery_claims_v1";
// Conservative local UTF-8 byte budget, not a claim about the provider's limit.
const MAX_CONTENT_LENGTH = 18000;
const contentSize = value => new TextEncoder().encode(String(value ?? "")).length;
const MIN_REQUEST_INTERVAL_MS = 13000;
const REQUEST_TIMEOUT_MS = 15000;
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_CLAIM_TTL_MS = 10 * 60 * 1000;

let deliveryQueue = Promise.resolve();

const defaultSettings = Object.freeze({
  enabled: false,
  token: "",
});

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, Math.max(0, Number(milliseconds) || 0));
});

const safeStorage = () => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

const readJson = (key, fallback) => {
  const storage = safeStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key, value) => {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

export const loadPushPlusSettings = () => {
  const stored = readJson(PUSHPLUS_SETTINGS_KEY, {});
  return {
    enabled: stored?.enabled === true,
    token: typeof stored?.token === "string" ? stored.token.trim() : "",
  };
};

export const savePushPlusSettings = (settings = {}) => {
  const normalized = {
    enabled: settings.enabled === true,
    token: typeof settings.token === "string" ? settings.token.trim() : "",
  };
  if (!writeJson(PUSHPLUS_SETTINGS_KEY, normalized)) {
    throw new Error("浏览器无法保存 PushPlus 配置");
  }
  return normalized;
};

export const clearPushPlusToken = () => savePushPlusSettings({
  ...loadPushPlusSettings(),
  enabled: false,
  token: "",
});

export const escapePushPlusHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const truncate = (value, length) => {
  const text = String(value ?? "");
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1))}…`;
};

const minifyHtml = (html) => String(html ?? "")
  .replace(/[\r\n]+/g, "")
  .replace(/>\s+</g, "><")
  .trim();

const formatDateTime = (timestamp) => {
  const date = new Date(Number(timestamp) || Date.now());
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const formatDuration = (milliseconds) => {
  const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}时${minutes}分${rest}秒`;
  if (minutes > 0) return `${minutes}分${rest}秒`;
  return `${rest}秒`;
};

const statusText = (status) => {
  const labels = {
    completed: "完成",
    warning: "有警告",
    partial: "部分异常",
    failed: "失败",
    skipped: "跳过",
    stopped: "手动停止",
    blocked: "锁停",
    unavailable: "账号异常",
  };
  return labels[status] || "异常";
};

const reportShell = (summary, header, rows) => minifyHtml(`
  <div style="font-family:Arial,sans-serif;color:#333;font-size:13px">
    ${summary}
    <table border="1" cellspacing="0" cellpadding="5" style="width:100%;border-collapse:collapse;text-align:center;border-color:#ddd">
      <thead><tr style="background:#4caf50;color:#fff">${header}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
`);

const ultraCompactShell = (summary, lines) => minifyHtml(`
  <div style="font-family:Arial,sans-serif;color:#333;font-size:13px">
    ${summary}<hr>${lines.map((line) => `<div>${line}</div>`).join("")}
  </div>
`);

const ensureReportLength = (builders) => {
  for (const builder of builders) {
    const content = minifyHtml(builder());
    if (contentSize(content) <= MAX_CONTENT_LENGTH) return content;
  }
  throw new Error(`PushPlus 汇报内容超过安全上限 ${MAX_CONTENT_LENGTH} UTF-8字节`);
};

// Single notification overview. Full records are emitted by the scheduler to its log.
export const BATCH_OVERVIEW_SAFE_BYTES = 9000;
export const buildBatchDailyPushReport = ({
  taskName, startedAt, finishedAt, selectedTaskCount,
  runId = "", executionClient = "", taskOrder = [], accounts = [],
}) => {
  const uncertain = account => account.verificationRequired === true || account.verificationDetails?.length > 0;
  const counts = accounts.reduce((result, account) => {
    const key = uncertain(account) && ["completed", "warning", "skipped"].includes(account.status)
      ? "unverified" : account.status || "failed";
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  const pending = accounts.filter(uncertain).length;
  const h = value => escapePushPlusHtml(value);
  const summary = `<h3>定时任务汇总｜${h(truncate(taskName, 40))}</h3>`
    + `<div>${formatDateTime(startedAt)}—${formatDateTime(finishedAt)}｜耗时${formatDuration(finishedAt - startedAt)}</div>`
    + `<div>运行版本：20261023.4（逐账号表格/控制台详细日志）</div>`
    + `<div>账号：${accounts.length}｜任务：${Number(selectedTaskCount) || 0}</div>`
    + (runId ? `<div>运行编号：${h(truncate(runId, 64))}｜执行端：${h(truncate(executionClient, 40))}</div>` : "")
    + (taskOrder.length ? `<div>执行顺序：${h(truncate(taskOrder.join(" → "), 120))}</div>` : "")
    + `<div>确认完成 ${counts.completed || 0}｜正常跳过 ${counts.skipped || 0}｜普通警告 ${counts.warning || 0}｜待核验 ${counts.unverified || 0}｜部分异常 ${counts.partial || 0}｜失败 ${counts.failed || 0}｜其他 ${accounts.length - ["completed", "skipped", "warning", "unverified", "partial", "failed"].reduce((n, key) => n + (counts[key] || 0), 0)}</div>`
    + (pending ? `<div>含待核验账号 ${pending}（与部分异常/失败可能重叠，不相加）</div>` : "");
  // Every account gets a row when it fits. Reduce detail before omitting rows.
  const priority = account => ["failed", "unavailable", "blocked", "stopped"].includes(account.status) ? 0
    : account.status === "partial" ? 1 : uncertain(account) ? 2 : 3;
  const ordered = accounts.map((account, index) => ({account, index}))
    .sort((a, b) => priority(a.account) - priority(b.account) || a.index - b.index);
  const header = '<th style="width:25%">账号</th><th style="width:16%">结果</th>'
    + '<th style="width:23%">完成/跳过</th><th>异常/待核验明细</th>';
  const codePattern = /(?:\[(\d{6,8})\]|(?:服务器错误\s*[:：]?\s*|错误码\s*[:：=]?\s*|\bcode\s*=\s*)(\d{6,8}))(?=\D|$)/g;
  const entries = ordered.map(({account}) => {
    const result = uncertain(account) && ["completed", "warning", "skipped"].includes(account.status)
      ? "待核验" : `${statusText(account.status)}${uncertain(account) ? "（含待核验）" : ""}`;
    const details = [...new Set([...(account.exceptions || []), ...(account.verificationDetails || [])].map(String))];
    const codes = [...new Set(details.flatMap(value => [...value.matchAll(codePattern)].map(match => match[1] || match[2])))].slice(0, 6);
    return {account, result, details, codes};
  });
  const row = ({account, result, details, codes}, level) => {
    const limit = [60, 40, 24][level];
    const brief = details.slice(0, 3).map(value => {
      // Keep task names/codes; the repeated server advice belongs in the console.
      const concise = value.replace(/出了点小问题，请尝试重启游戏解决～?（执行结果未确认）/g, "结果未确认");
      const phase = concise.match(/阶段[=:：]([^；\r\n]+)/)?.[1];
      return truncate(concise.split(/[；\r\n]/)[0], limit) + (phase && level === 0 ? `（${truncate(phase, 18)}）` : "");
    }).join("；");
    const missingCodes = codes.filter(code => !brief.includes(code));
    const detail = (brief || (uncertain(account) ? "结果待核验，详见控制台" : priority(account) < 3 ? "未返回详细原因，详见控制台" : "无"))
      + (missingCodes.length ? ` [码:${missingCodes.join(",")}]` : "")
      + (details.length > 3 ? `（另${details.length - 3}项）` : "");
    const count = account.taskCounts;
    const taskCounts = count ? `<br>完成${Number(count.completed) || 0} 跳过${Number(count.skipped) || 0}`
      + `<br>警告${Number(count.warning) || 0} 异常${["partial", "failed", "stopped", "unavailable", "blocked"].reduce((n, key) => n + (Number(count[key]) || 0), 0)}` : "";
    return `<tr><td style="overflow-wrap:anywhere">${h(truncate(account.name, 120))}</td><td>${h(result)}</td>`
      + `<td>${Number(account.completedCount) || 0}/${Number(account.totalCount) || 0}${taskCounts}</td><td style="text-align:left">${h(detail)}</td></tr>`;
  };
  const render = rows => reportShell(summary + `<div>账号明细（${rows.length}/${accounts.length}账号）</div>`, header, rows.join(""))
    + (accounts.length > rows.length ? `<div>另有 ${accounts.length - rows.length} 个账号未展开（单条长度限制，异常优先）。</div>` : "")
    + '<div>完成/跳过=完成与正常跳过之和/所选任务数；警告包含待核验。完整步骤及诊断见网页控制台“运行日志”，可复制日志。</div>';
  let content, compactRows;
  for (let level = 0; level < 3; level++) {
    compactRows = entries.map(entry => row(entry, level));
    content = render(compactRows);
    if (contentSize(content) <= BATCH_OVERVIEW_SAFE_BYTES) break;
  }
  if (contentSize(content) > BATCH_OVERVIEW_SAFE_BYTES) {
    // Only extreme batches fall back to fewer rows; keep a valid complete table.
    let low = 0, high = compactRows.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (contentSize(render(compactRows.slice(0, middle))) <= BATCH_OVERVIEW_SAFE_BYTES) low = middle;
      else high = middle - 1;
    }
    content = render(compactRows.slice(0, low));
  }
  if (contentSize(content) > BATCH_OVERVIEW_SAFE_BYTES) throw new Error("定时任务概览超过本地预算");
  return { title: `定时任务汇总｜${truncate(taskName, 48)}`, content };
};

export const buildPushingRoundPushReport = ({
  startedAt,
  finishedAt,
  winLimit,
  accounts = [],
}) => {
  const counts = accounts.reduce((result, account) => {
    const key = account.status || "failed";
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  const summary = `
    <h3 style="margin:0 0 8px">主线推图整轮汇总</h3>
    <div>时间：${formatDateTime(startedAt)}—${formatDateTime(finishedAt)}</div>
    <div>耗时：${formatDuration(finishedAt - startedAt)}｜胜场阈值：${Number(winLimit) || 0}｜账号：${accounts.length}</div>
    <div style="margin:4px 0 8px">完成 ${counts.completed || 0}｜锁停 ${counts.blocked || 0}｜手动停止 ${counts.stopped || 0}｜异常 ${counts.unavailable || 0}</div>
  `;

  const rows = (compact = false) => accounts.map((account) => {
    const level = `${Number(account.startLevel) || 0}→${Number(account.endLevel) || 0}`;
    const record = `${Number(account.wins) || 0}/${Number(account.losses) || 0}/${Number(account.battles) || 0}`;
    const note = account.note ? truncate(account.note, compact ? 18 : 36) : "-";
    return `<tr><td>${escapePushPlusHtml(truncate(account.name, compact ? 13 : 20))}</td><td>${escapePushPlusHtml(statusText(account.status))}</td><td>${level}</td><td>${record}</td><td>${escapePushPlusHtml(note)}</td></tr>`;
  }).join("");

  const content = ensureReportLength([
    () => reportShell(summary, "<th>账号</th><th>结果</th><th>关卡</th><th>胜/负/场</th><th>备注</th>", rows(false)),
    () => reportShell(summary, "<th>账号</th><th>结果</th><th>关卡</th><th>胜/负/场</th><th>备注</th>", rows(true)),
    () => ultraCompactShell(summary, accounts.map((account) => {
      const level = `${Number(account.startLevel) || 0}→${Number(account.endLevel) || 0}`;
      const record = `${Number(account.wins) || 0}/${Number(account.losses) || 0}/${Number(account.battles) || 0}`;
      const note = account.note ? truncate(account.note, 12) : "-";
      return `${escapePushPlusHtml(truncate(account.name, 11))}｜${escapePushPlusHtml(statusText(account.status))}｜${level}｜${record}｜${escapePushPlusHtml(note)}`;
    })),
  ]);

  return {
    title: `主线推图整轮汇总｜${formatDateTime(finishedAt)}`,
    content,
  };
};

const pruneClaims = (claims, now = Date.now()) => Object.fromEntries(
  Object.entries(claims || {}).filter(([, entry]) => {
    const age = now - Number(entry?.timestamp || 0);
    const ttl = entry?.status === "pending" ? PENDING_CLAIM_TTL_MS : CLAIM_TTL_MS;
    return age >= 0 && age < ttl;
  }),
);

const acquireClaim = (dedupeKey) => {
  if (!dedupeKey) return { acquired: true, owner: "" };
  const now = Date.now();
  const claims = pruneClaims(readJson(PUSHPLUS_DEDUPE_KEY, {}), now);
  if (claims[dedupeKey]) return { acquired: false, owner: "" };
  const owner = `${now}-${Math.random().toString(36).slice(2)}`;
  claims[dedupeKey] = { status: "pending", timestamp: now, owner };
  writeJson(PUSHPLUS_DEDUPE_KEY, claims);
  const saved = readJson(PUSHPLUS_DEDUPE_KEY, {});
  return { acquired: saved?.[dedupeKey]?.owner === owner, owner };
};

const finishClaim = (dedupeKey, owner, accepted) => {
  if (!dedupeKey) return;
  const claims = pruneClaims(readJson(PUSHPLUS_DEDUPE_KEY, {}));
  if (claims?.[dedupeKey]?.owner !== owner) return;
  if (accepted) {
    claims[dedupeKey] = {
      status: "accepted",
      timestamp: Date.now(),
      owner,
    };
  } else {
    delete claims[dedupeKey];
  }
  writeJson(PUSHPLUS_DEDUPE_KEY, claims);
};

const waitForRateLimit = async () => {
  const storage = safeStorage();
  const lastRequest = Number(storage?.getItem(PUSHPLUS_RATE_KEY) || 0);
  const delay = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequest);
  if (delay > 0) await wait(delay);
  try {
    storage?.setItem(PUSHPLUS_RATE_KEY, String(Date.now()));
  } catch {}
};

const sendNow = async ({ title, content, dedupeKey = "", settings = null }) => {
  const currentSettings = settings
    ? {
        enabled: settings.enabled === true,
        token: typeof settings.token === "string" ? settings.token.trim() : "",
      }
    : loadPushPlusSettings();

  if (!currentSettings.enabled) return { status: "skipped", reason: "disabled" };
  if (!currentSettings.token) return { status: "skipped", reason: "token-missing" };

  const safeTitle = truncate(title || "XYZW 运行通知", 100);
  const safeContent = minifyHtml(content);
  if (!safeContent) return { status: "failed", error: "通知内容为空" };
  if (contentSize(safeContent) > MAX_CONTENT_LENGTH) {
    return { status: "failed", error: `通知内容 ${contentSize(safeContent)} UTF-8字节，超过安全上限 ${MAX_CONTENT_LENGTH}` };
  }

  const claim = acquireClaim(dedupeKey);
  if (!claim.acquired) return { status: "skipped", reason: "duplicate" };

  await waitForRateLimit();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let accepted = false;

  try {
    const response = await fetch(PUSHPLUS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: currentSettings.token,
        title: safeTitle,
        content: safeContent,
        template: "html",
      }),
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${payload?.msg ? `：${payload.msg}` : ""}`);
    }
    if (Number(payload?.code) !== 200) {
      throw new Error(`PushPlus code=${Number.isFinite(Number(payload?.code)) ? Number(payload.code) : "未知"}：${truncate(payload?.msg || "无详细原因", 120)}；正文${contentSize(safeContent)}字节`);
    }
    accepted = true;
    return {
      status: "accepted",
      messageId: payload?.data || "",
      contentLength: safeContent.length,
      contentBytes: contentSize(safeContent),
    };
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "PushPlus 请求超时"
      : String(error?.message || error || "PushPlus 请求失败");
    return { status: "failed", error: message };
  } finally {
    clearTimeout(timeout);
    finishClaim(dedupeKey, claim.owner, accepted);
  }
};

export const enqueuePushPlusNotification = (payload) => {
  const scheduled = deliveryQueue.then(async () => {
    if (!Array.isArray(payload?.parts) || payload.parts.length === 0) {
      return sendNow(payload);
    }
    const results = [];
    for (let index = 0; index < payload.parts.length; index++) {
      const part = payload.parts[index];
      const result = await sendNow({
        title: part.title || payload.title,
        content: part.content,
        settings: payload.settings,
        dedupeKey: payload.dedupeKey
          ? `${payload.dedupeKey}:part:${index + 1}/${payload.parts.length}`
          : "",
      });
      results.push({ part: index + 1, ...result });
    }
    const acceptedCount = results.filter((result) => result.status === "accepted").length;
    const failures = results.filter((result) => result.status === "failed");
    const unsent = results.filter((result) =>
      result.status === "skipped" && result.reason !== "duplicate",
    );
    if (failures.length > 0 || (acceptedCount > 0 && unsent.length > 0)) {
      return {
        status: "failed",
        acceptedCount,
        totalParts: results.length,
        results,
        error: failures.concat(unsent).map((result) =>
          `第${result.part}部分：${result.error || result.reason || "未发送"}`,
        ).join("；"),
      };
    }
    if (acceptedCount > 0) {
      return { status: "accepted", acceptedCount, totalParts: results.length, results };
    }
    return {
      status: "skipped",
      reason: results[0]?.reason || "duplicate",
      totalParts: results.length,
      results,
    };
  });
  deliveryQueue = scheduled.catch(() => {});
  return scheduled;
};

export const PUSHPLUS_CONTENT_SAFE_LIMIT = MAX_CONTENT_LENGTH;
export const PUSHPLUS_STORAGE_KEY = PUSHPLUS_SETTINGS_KEY;
