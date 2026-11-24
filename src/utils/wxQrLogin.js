import { bonProtocol, XCrypto } from "./bonProtocol.js";
/**
 * 微信扫码登录 → combUser → 服务器角色列表（核心逻辑，与 UI 解耦）
 *
 * 强依赖 Cloudflare Worker 代理绕过微信接口跨域：
 *   /api/weixin       微信登录页（取二维码）
 *   /api/weixin-long  扫码状态长轮询（取 code）
 *   /api/hortor       comb-login-server 登录（code 换 combUser）
 *   GAME_API 直连      /login/serverlist（combUser 换角色列表）
 *
 * 所有网络请求通过注入的 request 函数发出，便于测试实时的数据解析。
 */
import { CIPHER_TABLE } from "./wxCipherTable.js";

export const QR_CONFIG = {
  appid: "wxfb0d5667e5cb1c44",
  bundleid: "com.hortor.games.xyzw",
  scope: "snsapi_base,snsapi_userinfo,snsapi_friend,snsapi_message",
  state: "weixin",
  gameApi: "https://xxz-xyzw.hortorgames.com",
  scanTimeoutMs: 120000,
};

// ---------- payload 加密（与 demoqr encodePayload 完全一致） ----------

const encodeBase64 = (text) => {
  if (!text) return null;
  // 浏览器环境用 btoa；Node 测试用 Buffer（此分支仅在测试运行，浏览器不会走到）
  if (typeof btoa !== "undefined")
    return btoa(unescape(encodeURIComponent(text)));
  // eslint-disable-next-line node/prefer-global/buffer
  return Buffer.from(text, "utf8").toString("base64");
};

const transCode = (str, times) => {
  if (times <= 0) return str;
  if (str.length % 2 !== 0) return null;
  const right = str.substring(Math.floor(str.length / 2));
  const left = str.substring(0, Math.floor(str.length / 2));
  return transCode(right, times - 1) + transCode(left, times - 1);
};

const getCodeKey = (str, step) => {
  const chars = str.split("");
  const result = [];
  const count = Math.floor(str.length / step);
  for (let i = 0; i < count; i++) result.push(chars[i * step]);
  return result.join("");
};

const dealWithString = (src, key, shift) => {
  if (!src || !key) return null;
  const v = src.split("");
  const w = key.split("");
  const out = Array.from({length: v.length});
  let idx = w.length >> shift;
  for (let i = 0; i < v.length; i++) {
    if (idx >= w.length) idx = 0;
    out[i] = String.fromCharCode(v[i].charCodeAt(0) ^ w[idx].charCodeAt(0));
    idx++;
  }
  return out.join("");
};

/** 登录 payload 加密 */
export const encodePayload = (text) => {
  const xorShift = 1;
  const shuffleTimes = 6;
  const step = 3;
  const shuffled = transCode(CIPHER_TABLE, shuffleTimes);
  const key = getCodeKey(shuffled, step);
  const mid = dealWithString(encodeBase64(text), key, xorShift);
  return encodeBase64(mid);
};

// ---------- Step 1: 取二维码 ----------

export const buildQrPageUrl = (workerUrl) => {
  const base = String(workerUrl || "").replace(/\/+$/, "");
  return (
    `${base 
    }/api/weixin/connect/app/qrconnect?appid=${ 
    QR_CONFIG.appid 
    }&bundleid=${ 
    QR_CONFIG.bundleid 
    }&scope=${ 
    QR_CONFIG.scope 
    }&state=${ 
    QR_CONFIG.state}`
  );
};

/**
 * 从微信登录页 HTML 里解析二维码图片地址与 uuid。
 * @returns {{qrUrl:string, uuid:string}|null}
 */
export const parseQrPage = (html) => {
  if (!html) return null;
  let qrUrl = null;
  const imgMatch = html.match(/<img[^>]*class=["'][^"']*auth_qrcode[^"']*["'][^>]*src=["']([^"']+)["']/i);
  if (imgMatch) qrUrl = imgMatch[1];
  if (!qrUrl) {
    const m = html.match(/https:\/\/[^"']*qrcode[^"']*/i);
    if (m) qrUrl = m[0];
  }
  if (!qrUrl) return null;
  qrUrl = qrUrl.replace(/&amp;/g, "&");
  const uuid = qrUrl.split("/").pop().split("?")[0];
  return { qrUrl, uuid };
};

// ---------- Step 2: 轮询扫码状态 ----------

export const buildScanStatusUrl = (workerUrl, uuid) => {
  const base = String(workerUrl || "").replace(/\/+$/, "");
  return (
    `${base 
    }/api/weixin-long/connect/l/qrconnect?uuid=${ 
    encodeURIComponent(uuid) 
    }&f=url&_=${ 
    Date.now()}`
  );
};

export const SCAN_STATE = {
  WAITING: "waiting",
  SUCCESS: "success",
  EXPIRED: "expired",
};

/**
 * 解析扫码状态长轮询响应。
 * @returns {{state:string, code?:string, nickname?:string}}
 */
export const parseScanStatus = (text) => {
  if (!text) return { state: SCAN_STATE.WAITING };
  if (text.includes("window.wx_errcode=405")) {
    const codeMatch = text.match(/wx_redirecturl='[^']*code=([a-zA-Z0-9]+)/);
    const nicknameMatch = text.match(/window\.wx_nickname\s*=\s*['"]([^'"]+)['"]/);
    if (codeMatch) {
      return {
        state: SCAN_STATE.SUCCESS,
        code: codeMatch[1],
        nickname: nicknameMatch ? nicknameMatch[1] : "",
      };
    }
  }
  if (text.includes("window.wx_errcode=408")) {
    return { state: SCAN_STATE.EXPIRED };
  }
  return { state: SCAN_STATE.WAITING };
};

// ---------- Step 3: code 换 combUser ----------

export const buildLoginPayload = (code) => ({
  gameId: "xyzwapp",
  code,
  gameTp: "app",
  sysInfo:
    '{"system":"Android","hortorSDKVersion":"4.0.6-cn","model":"22081212C","brand":"Redmi"}',
  channel: "android",
  appFrom: "com.tencent.mm",
  noLogin: "2",
  distinctId: "DID-a38175b7-14ce-4b36-aa89-3e092ea03ea6",
  state: "hortor",
  packageName: "com.hortor.games.xyzw",
  tp: "app-we",
  signPrint: "E6:F7:FE:A9:EC:8E:24:D0:4F:2A:32:50:28:78:E1:C5:5E:70:81:13",
});

export const buildCombLoginUrl = (workerUrl) => {
  const base = String(workerUrl || "").replace(/\/+$/, "");
  return (
    `${base 
    }/api/hortor/comb-login-server/api/v1/login` +
    `?gameId=xyzwapp` +
    `&timestamp=${ 
    Date.now() 
    }&version=android-4.2.1-cn-release` +
    `&cryptVersion=1.1.0` +
    `&gameTp=app&system=android` +
    `&deviceUniqueId=DID-0e782e88-2f3b-4f5b-9020-47f5e5a5a026` +
    `&packageName=com.hortorgames.xyzw`
  );
};

/** 从登录响应里取 combUser */
export const parseCombUser = (json) => {
  if (!json || json.meta?.errCode !== 0) return null;
  return json.data?.combUser || null;
};

// ---------- Step 4: combUser 换服务器角色列表 ----------

export const buildServerListBin = (combUser, serverId = null) => {
  const loginData = {
    platform: "hortor",
    platformExt: "mix",
    info: combUser,
    serverId,
    scene: 0,
    referrerInfo: "",
  };
  const plain = bonProtocol.encode(loginData, false);
  const out = XCrypto.encrypt(plain);
  return out.buffer.byteLength === out.length && out.byteOffset === 0
    ? out.buffer
    : out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
};

export const buildServerListUrl = () =>
  `${QR_CONFIG.gameApi  }/login/serverlist?_seq=3`;

/** 解析 serverlist 响应（x 解密 + BON 解码）→ 角色数组 */
export const parseServerRoles = (arrayBuffer) => {
  const u8 = new Uint8Array(arrayBuffer);
  const plain = XCrypto.decrypt(u8);
  const raw = bonProtocol.decode(plain);
  // 服务端响应结构可能是 {roles:[]} 或包在 body/data 里，逐个尝试
  const candidates = [raw, raw?.body, raw?.data, raw?._raw, raw?.body?.data];
  for (const candidate of candidates) {
    if (candidate && Array.isArray(candidate.roles)) return candidate.roles;
  }
  return [];
};
