/**
 * 协议分析工具：把粘贴的 bin / base64 / hex 数据自动识别加密方案并做 BON 解码。
 * 借鉴自 demoqr 的「自动检测解密 / 协议实现」面板，使用项目现有加解密器。
 *
 * 加密标记（前两字节）：
 *   0x70 0x6c ("pl") → lx（lz4 + xor）
 *   0x70 0x78 ("px") → x
 *   0x70 0x74 ("pt") → xtm
 *   其他              → 视为明文 BON
 */
import { bonProtocol, getEnc } from "./bonProtocol.js";

/** 把输入文本解析为字节数组：支持 hex（可带空格/0x）、base64、UTF-8 文本 */
export const parseInputBytes = (input) => {
  if (input === null || input === undefined) return new Uint8Array(0);
  const raw = String(input).trim();
  if (!raw) return new Uint8Array(0);

  // 1) hex：全由 0-9a-fA-F 及分隔符组成，且长度合理
  const hexish = raw.replace(/0x/gi, "").replace(/[\s,_-]/g, "");
  if (/^[0-9a-f]+$/i.test(hexish) && hexish.length % 2 === 0 && hexish.length >= 4) {
    const out = new Uint8Array(hexish.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(hexish.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  // 2) base64：典型字符集，长度 >= 4；允许无 padding（如 aGVsbG8）。
  //    合法 base64 长度 mod 4 不可能为 1（据此排除 "hello" 这类普通文本误判）。
  //    纯数字/纯 a-f 字符串已在上面按 hex 处理，不会误入这里。
  if (/^[A-Z0-9+/]+={0,2}$/i.test(raw) && raw.length >= 4 && raw.length % 4 !== 1) {
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    if (typeof atob !== "undefined") {
      const bin = atob(padded);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    // eslint-disable-next-line node/prefer-global/buffer
    if (typeof Buffer !== "undefined") {
      // eslint-disable-next-line node/prefer-global/buffer
      return new Uint8Array(Buffer.from(padded, "base64"));
    }
  }

  // 3) 兜底：按 UTF-8 文本处理
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(raw);
  return new Uint8Array(0);
};

/** 根据头部字节识别加密方案 */
export const detectScheme = (bytes) => {
  if (!bytes || bytes.length < 4) return "unknown";
  if (bytes[0] === 0x70 && bytes[1] === 0x6c) return "lx";
  if (bytes[0] === 0x70 && bytes[1] === 0x78) return "x";
  if (bytes[0] === 0x70 && bytes[1] === 0x74) return "xtm";
  return "plain";
};

/**
 * 自动解密 + BON 解码。
 * @returns {{scheme:string, ok:boolean, data?:any, decodedBytes?:Uint8Array, error?:string}}
 */
export const inspectProtocol = (input) => {
  try {
    const bytes = parseInputBytes(input);
    if (bytes.length === 0) {
      return { scheme: "unknown", ok: false, error: "输入为空或无法解析" };
    }
    const scheme = detectScheme(bytes);
    let plain = bytes;
    if (scheme === "lx" || scheme === "x" || scheme === "xtm") {
      plain = getEnc(scheme).decrypt(bytes);
    } else if (scheme === "unknown") {
      return { scheme, ok: false, error: "数据太短（至少 4 字节）" };
    }

    let data;
    try {
      data = bonProtocol.decode(plain);
    } catch (decodeError) {
      return {
        scheme,
        ok: false,
        error: `BON 解码失败：${decodeError?.message || decodeError}`,
      };
    }
    return { scheme, ok: true, data, decodedBytes: plain };
  } catch (error) {
    return { scheme: "unknown", ok: false, error: error?.message || String(error) };
  }
};

/** 把解码结果格式化为可读 JSON（处理 Uint8Array / Date 等） */
export const formatInspectedData = (data) => {
  const replacer = (_key, value) => {
    if (value instanceof Uint8Array) {
      return `[Uint8Array ${value.length}] ${Array.from(value.slice(0, 32))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")}${value.length > 32 ? " ..." : ""}`;
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "bigint") return value.toString();
    return value;
  };
  try {
    return JSON.stringify(data, replacer, 2);
  } catch {
    return String(data);
  }
};
