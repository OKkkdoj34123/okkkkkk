import {
  buildAccountKey,
  findMatchingToken,
  parseBinFileName,
} from "./accountIdentity.js";
/**
 * 扫码角色列表 → bin → 账号匹配/更新 的核心逻辑（与 UI 解耦，便于测试）
 *
 * 用户提供扫码得到的 combUser 和服务器角色列表，为每个选中角色：
 *   1. 构造与游戏 encMsg 一致的登录数据，用项目现有 bonProtocol + XCrypto 编码成 bin
 *   2. 合成 bin 文件名（bin-<服务器>服-<序号>-<角色ID>-<名字>.bin），复用现有身份解析
 *   3. 用服务器:角色ID 匹配旧账号（findMatchingToken），命中则复用旧 id
 *   4. 返回结构交给调用方 storeArrayBuffer 覆盖 bin、updateToken/addToken 落库
 *
 * 这样定时任务/分组/账号设置里保存的旧 id 引用保持不变。
 */
import { bonProtocol, XCrypto } from "./bonProtocol.js";

/** 与 demoqr gEncode 完全一致：BON 编码 → x 加密 */
export const encodeLoginBin = (loginData) => {
  const plain = bonProtocol.encode(loginData, false);
  const out = XCrypto.encrypt(plain);
  const buffer =
    out.buffer.byteLength === out.length && out.byteOffset === 0
      ? out.buffer
      : out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
  return buffer;
};

/**
 * 由 serverId 推算区服号与角色槽位序号。
 * 规则来自 demoqr / wechatForceLogout：>=2,000,000 为 2 号位，>=1,000,000 为 1 号位，
 * 区服号 = 剩余值 - 27。
 */
export const decodeServerId = (serverId) => {
  let sid = Number(serverId);
  let roleIndex = 0;
  if (sid >= 2000000) {
    roleIndex = 2;
    sid -= 2000000;
  } else if (sid >= 1000000) {
    roleIndex = 1;
    sid -= 1000000;
  }
  return { serverNum: sid - 27, roleIndex };
};

/** 合成 bin 文件名（不落盘，仅用于复用现有文件名身份解析） */
export const buildBinFileName = (roleInfo) => {
  const { serverNum, roleIndex } = decodeServerId(roleInfo.serverId);
  const roleId = String(roleInfo.roleId ?? "");
  const name = roleInfo.name || "未命名";
  return `bin-${serverNum}服-${roleIndex}-${roleId}-${name}.bin`;
};

/**
 * 构造单个角色的导入计划（不落库）。
 * @param {object} roleInfo 角色 { serverId, roleId, name }
 * @param {object} combUser 扫码登录得到的 combUser（bin info 字段）
 * @param {Array<object>} tokens 现有账号列表
 * @returns {{success:boolean, plan?:object, error?:string}}
 */
export const buildRoleImportPlan = (roleInfo, combUser, tokens = []) => {
  try {
    if (!roleInfo || roleInfo.serverId === undefined || roleInfo.serverId === null)
      return { success: false, error: "缺少 serverId" };
    if (!roleInfo.roleId)
      return { success: false, error: "缺少角色ID" };

    const fileName = buildBinFileName(roleInfo);
    const meta = parseBinFileName(fileName);
    if (!meta) return { success: false, error: `无法解析角色身份: ${  fileName}` };

    const accountKey = buildAccountKey(meta.server, meta.roleId);
    const serverLabel = `${meta.server}${meta.roleIndex}` || meta.server;
    const roleName = meta.roleName || roleInfo.name || "";

    // 用文件名身份匹配旧账号（含 legacy 回退）
    const existing = findMatchingToken(tokens, {
      accountKey,
      roleId: meta.roleId,
      server: serverLabel,
      name: roleName,
    });

    // 构造 bin：与 game getServerRoles/downloadRole 的 loginData 结构一致
    const loginData = {
      platform: "hortor",
      platformExt: "mix",
      info: combUser,
      serverId: Number(roleInfo.serverId),
      scene: 0,
      referrerInfo: "",
    };
    const bin = encodeLoginBin(loginData);

    return {
      success: true,
      plan: {
        // 命中旧账号则复用其 id，定时任务/分组引用不变
        id: existing?.id ?? null,
        accountKey,
        roleId: meta.roleId,
        roleIndex: meta.roleIndex,
        server: serverLabel,
        name: roleName,
        token: null, // 由调用方 transformToken(bin) 后填入
        wsUrl: existing?.wsUrl || null,
        importMethod: "bin",
        bin,
        fileName,
        isUpdate: Boolean(existing),
      },
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
};

/**
 * 批量构造导入计划。
 * @param {Array<object>} roles 选中的角色列表
 * @param {object} combUser 扫码登录凭证
 * @param {Array<object>} tokens 现有账号
 * @returns {{plans:Array<object>, failures:Array<object>}}
 */
export const buildBatchImportPlans = (roles, combUser, tokens = []) => {
  const plans = [];
  const failures = [];
  if (!Array.isArray(roles)) return { plans, failures };
  for (const role of roles) {
    const result = buildRoleImportPlan(role, combUser, tokens);
    if (result.success) plans.push(result.plan);
    else failures.push({ role, error: result.error });
  }
  return { plans, failures };
};
