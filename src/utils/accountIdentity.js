/**
 * 账号稳定标识工具
 *
 * bin 文件的 ID 是文件内容的 MD5，每次从游戏重新导出都会变化，
 * 导致定时任务/分组里保存的旧 ID 失效。这里从文件名中提取游戏角色的
 * 稳定标识（服务器 + 角色ID），用于把「同一角色的新 bin」匹配回旧账号。
 */

/**
 * 解析游戏导出的 bin 文件名。
 * 格式：bin-<服务器>服-<角色序号0-2>-<角色ID>-<角色名>.bin
 * @param {string} fileName 文件名
 * @returns {{server:string, roleIndex:string, roleId:string, roleName:string}|null}
 */
export const parseBinFileName = (fileName) => {
  if (!fileName || typeof fileName !== "string") return null;
  const match = fileName
    .trim()
    .match(/^bin-(.*?)服-([0-2])-(\d{6,12})-(.*)\.bin$/);
  if (!match) return null;
  return {
    server: match[1],
    roleIndex: match[2],
    roleId: match[3],
    roleName: match[4],
  };
};

/**
 * 构造账号稳定标识键（服务器 + 角色ID）。
 * @param {string} server 服务器名
 * @param {string|number} roleId 游戏角色ID
 * @returns {string|null} 稳定标识键，缺少角色ID 时返回 null
 */
export const buildAccountKey = (server, roleId) => {
  if (roleId === null || roleId === undefined || roleId === "") return null;
  return `${String(server ?? "").trim()}:${String(roleId).trim()}`;
};

/**
 * Find an existing account that matches a freshly imported BIN.
 * Priority: stable accountKey (server:roleId) → legacy roleId+server →
 * legacy name+server. The last two support accounts imported before role
 * identity was stored, so the very first re-import after upgrading still
 * reuses the old id (and therefore keeps scheduled-task references valid).
 * @param {Array<object>} tokens Existing token records.
 * @param {object} identity Identity parsed from the new BIN file.
 * @param {string|null} identity.accountKey Stable identity key.
 * @param {string|number|null} identity.roleId Game role id.
 * @param {string} [identity.server] Server label.
 * @param {string} [identity.name] Role name.
 * @returns {object|undefined} Matching existing token record.
 */
export const findMatchingToken = (
  tokens,
  { accountKey = null, roleId = null, server = "", name = "" } = {},
) => {
  if (!Array.isArray(tokens) || tokens.length === 0) return undefined;
  const role = roleId === null || roleId === undefined ? null : String(roleId);

  if (accountKey) {
    const byKey = tokens.find((token) => token.accountKey === accountKey);
    if (byKey) return byKey;
  }
  if (role) {
    const byRole = tokens.find(
      (token) =>
        String(token.roleId ?? "") === role &&
        (!server || !token.server || token.server === server),
    );
    if (byRole) return byRole;
  }
  // Legacy accounts have neither accountKey nor roleId; fall back to name+server.
  // Game exports may append "(1)", "(2)" etc. to the role name; ignore that
  // suffix so re-imports match regardless of the chosen file name.
  if (name) {
    const normalizeName = (value) =>
      String(value ?? "")
        .trim()
        .replace(/\(\d+\)\s*$/, "");
    const normalized = normalizeName(name);
    const byName = tokens.find(
      (token) =>
        normalizeName(token.name) === normalized &&
        (!server || token.server === server),
    );
    if (byName) return byName;
  }
  return undefined;
};
