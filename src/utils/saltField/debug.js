// SALT_ONCE_DIAGNOSTICS_V4
// 默认关闭。浏览器控制台执行 localStorage.setItem('xyzw_salt_once_debug_v1', '1') 开启。
export const SALT_DEBUG_KEY = 'xyzw_salt_once_debug_v1';

export function saltDebugEnabled() {
  try {
    return globalThis.localStorage?.getItem(SALT_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

const secretKey = /token|cookie|authorization|password|passwd|secret|^sid$|^p$/i;

export function sanitizeSaltDebugValue(value, depth = 0, key = '') {
  if (secretKey.test(String(key))) return '[已脱敏]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return value.length > 240 ? `${value.slice(0, 240)}…[截断]` : value;
  }
  if (value instanceof Uint8Array) return `[二进制数据 ${value.byteLength} bytes]`;
  if (depth >= 4) return '[深度限制]';
  if (Array.isArray(value)) {
    if (value.length > 32 && value.every(item => typeof item === 'number')) {
      return `[数字数组 ${value.length} 项]`;
    }
    return value.slice(0, 20).map(item => sanitizeSaltDebugValue(item, depth + 1)).concat(
      value.length > 20 ? [`…其余 ${value.length - 20} 项已省略`] : [],
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length && entries.every(([name]) => /^\d+$/.test(name))) {
      return `[数字键对象 ${entries.length} 项]`;
    }
    const result = {};
    for (const [name, item] of entries.slice(0, 30)) {
      result[name] = sanitizeSaltDebugValue(item, depth + 1, name);
    }
    if (entries.length > 30) result._truncatedKeys = entries.length - 30;
    return result;
  }
  return String(value);
}

export function summarizeSaltResponse(packet, raw = packet?._raw || packet) {
  const body = packet?.rawData ?? packet?.decodedBody ?? raw?.decodedBody
    ?? packet?.body ?? raw?.body ?? null;
  return sanitizeSaltDebugValue({
    cmd: packet?.cmd ?? raw?.cmd ?? null,
    seq: packet?.seq ?? raw?.seq ?? null,
    resp: packet?.resp ?? raw?.resp ?? null,
    code: packet?.code ?? raw?.code ?? null,
    message: packet?.message ?? packet?.msg ?? packet?.error ?? raw?.message ?? raw?.msg ?? null,
    body,
  });
}

export function saltDebug(event, detail = {}) {
  if (!saltDebugEnabled()) return;
  const entry = sanitizeSaltDebugValue({
    at: new Date().toISOString(),
    event,
    ...detail,
  });
  globalThis.console?.info?.('[盐场调试][v4]', entry);
}
