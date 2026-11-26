import {
  decodeConfigBin, encodeConfigBin, importTokenRecords, resolveTokenRefreshSource,
} from "./tokenRefreshSource.js";

export const BIN_ARCHIVE = "xyzw-bin-archive";

async function readOriginal(account, accounts, access) {
  // 旧版按唯一名称保存；查重必须看全设备账号，不能只看本次勾选项。
  const source = await resolveTokenRefreshSource({ ...account, importMethod: "bin" }, access.read, accounts);
  return source.data;
}

export async function exportBinArchive(selected, accounts, access, groups = []) {
  const files = [];
  const missing = [];
  for (const account of selected) {
    const bytes = await readOriginal(account, accounts, access);
    if (!bytes) {
      missing.push(account.name || account.id);
      continue;
    }
    files.push({ id: account.id, name: account.name || account.id, binBase64: encodeConfigBin(bytes) });
  }
  if (missing.length) {
    const labels = missing.slice(0, 5).join("、");
    throw new Error(`有 ${missing.length} 个所选账号缺少原始 BIN（${labels}${missing.length > 5 ? " 等" : ""}）。请取消勾选这些账号，或改用账号配置导出。`);
  }
  if (!files.length) throw new Error("请至少选择一个账号");
  const selectedIds = new Set(files.map(file => file.id));
  const allSelected = accounts.every(account => selectedIds.has(account.id));
  const scoped = groups.map(group => {
    if (!Array.isArray(group?.tokenIds)) throw new Error("本机分组的成员列表无效");
    return { ...group, tokenIds: group.tokenIds.filter(id => selectedIds.has(id)) };
  }).filter(group => allSelected || group.tokenIds.length);
  return { format: BIN_ARCHIVE, version: 2, files, tokenGroups: readArchiveGroups(scoped, selectedIds) };
}

function readArchiveGroups(groups, fileIds) {
  if (!Array.isArray(groups)) throw new Error("BIN 配置缺少分组列表");
  const seen = new Set();
  return groups.map(group => {
    if (typeof group?.id !== "string" || !group.id.trim() || seen.has(group.id)
      || typeof group.name !== "string" || !group.name.trim() || !Array.isArray(group.tokenIds)
      || (group.color != null && typeof group.color !== "string")) {
      throw new Error("BIN 配置含无效或重复的分组");
    }
    if (group.tokenIds.some(id => !fileIds.has(id))) throw new Error("分组引用了本文件以外的账号");
    seen.add(group.id);
    return { id: group.id, name: group.name, color: group.color || "#1677ff", tokenIds: [...new Set(group.tokenIds)] };
  });
}

function mergeArchiveGroups(current, incoming, idMap) {
  if (!incoming.length) return current;
  const merged = [...current];
  for (const group of incoming) {
    const index = merged.findIndex(item => item.id === group.id);
    const existing = merged[index];
    const members = [...(existing?.tokenIds || []), ...group.tokenIds];
    const tokenIds = [...new Set(members.map(id => idMap.get(id) ?? id))];
    if (existing) merged[index] = { ...existing, tokenIds };
    else merged.push({ ...group, tokenIds });
  }
  return merged;
}

export async function importBinArchive(archive, current, access, authenticate, assertCurrent = () => {},
  { groups = [], onCommit } = {}) {
  if (archive?.format !== BIN_ARCHIVE || ![1, 2].includes(archive.version) || !Array.isArray(archive.files) || !archive.files.length) {
    throw new Error("纯 BIN 配置格式或版本无效");
  }
  // 先检查整份文件，再进行认证。相同字节代表同一份 BIN，重名不代表同一账号。
  const ids = new Map();
  const files = new Map();
  for (const file of archive.files) {
    if (typeof file?.id !== "string" || !file.id.trim() || typeof file.name !== "string") {
      throw new Error("BIN 文件缺少账号标识或名称");
    }
    if (ids.has(file.id) && ids.get(file.id) !== file.binBase64) throw new Error("同一账号 ID 对应不同 BIN");
    ids.set(file.id, file.binBase64);
    const same = files.get(file.binBase64);
    if (same) same.ids.add(file.id);
    else files.set(file.binBase64, { ...file, bytes: decodeConfigBin(file.binBase64), ids: new Set([file.id]) });
  }

  const incomingGroups = archive.version === 1 ? [] : readArchiveGroups(archive.tokenGroups, ids);

  // 识别在另一台设备上单独添加过、但本地 ID 不同的同一份 BIN。
  const localById = new Map(current.map(account => [account.id, account]));
  for (const account of current) {
    const bytes = await readOriginal(account, current, access);
    if (!bytes) continue;
    const key = encodeConfigBin(bytes);
    if (ids.has(account.id) && ids.get(account.id) !== key) throw new Error("本地账号 ID 与导入的 BIN 冲突");
    files.get(key)?.ids.add(account.id);
  }

  const planned = [];
  for (const file of files.values()) {
    const matches = [...file.ids].map(id => localById.get(id)).filter(Boolean);
    if (matches.length > 1) throw new Error("一份 BIN 匹配多个本地账号，请先核对重复账号");
    const account = matches[0];
    const id = account?.id || file.id;
    const stored = await access.read(id);
    if (stored && encodeConfigBin(stored) !== file.binBase64) throw new Error("本地存储与导入的 BIN 冲突");
    planned.push({ file, account, id });
  }

  const records = [];
  for (const { file, account, id } of planned) {
    let token = account?.token;
    if (!token) {
      try {
        token = await authenticate(file.bytes);
        if (typeof token !== "string" || !token.trim()) throw new Error();
      } catch {
        throw new Error(`账号“${file.name || file.id}”的 BIN 认证失败，请检查网络或原文件后重试。本次未写入账号。`);
      }
    }
    records.push({ id, name: file.name || id, token, binBase64: file.binBase64, importMethod: "bin" });
  }
  assertCurrent();
  return importTokenRecords(records, current, access, {
    retainEmbeddedBin: true,
    commit(result) {
      assertCurrent();
      // 同一 BIN 可有多个来源 ID。认证后也可能按 Token 命中另一条本地记录。
      const idMap = new Map(result.idMap);
      for (const { file, id } of planned) {
        const localId = result.idMap.get(id);
        for (const alias of file.ids) idMap.set(alias, localId);
      }
      const restored = { ...result, idMap, duplicates: archive.files.length - result.added,
        tokenGroups: mergeArchiveGroups(groups, incomingGroups, idMap), groupCount: incomingGroups.length };
      onCommit?.(restored);
      return restored;
    },
  });
}

// 页面与空设备恢复入口共用。账号、分组都持久化后，才发布新的响应式状态。
export function restoreBinArchive(archive, { accounts, groups, storage, access, authenticate }) {
  const original = accounts.value;
  const originalGroups = groups.value;
  const snapshot = JSON.stringify(original);
  const saved = storage.getItem("gameTokens");
  const hasGroups = archive.version === 2 && Array.isArray(archive.tokenGroups) && archive.tokenGroups.length > 0;
  const groupSnapshot = hasGroups ? JSON.stringify(originalGroups) : null;
  const savedGroups = hasGroups ? storage.getItem("tokenGroups") : null;

  function assertCurrent() {
    if (JSON.stringify(accounts.value) !== snapshot || storage.getItem("gameTokens") !== saved
      || (hasGroups && (JSON.stringify(groups.value) !== groupSnapshot || storage.getItem("tokenGroups") !== savedGroups))) {
      throw new Error("导入期间账号或分组已变化，请重试");
    }
  }

  function onCommit(result) {
    const nextTokens = JSON.stringify(result.tokens);
    const nextGroups = hasGroups ? JSON.stringify(result.tokenGroups) : null;
    let wroteTokens = false;
    try {
      if (nextTokens !== saved) {
        storage.setItem("gameTokens", nextTokens);
        wroteTokens = true;
      }
      if (hasGroups && nextGroups !== savedGroups) storage.setItem("tokenGroups", nextGroups);
    } catch {
      if (wroteTokens) {
        try {
          if (saved === null) storage.removeItem("gameTokens");
          else storage.setItem("gameTokens", saved);
        } catch {
          throw new Error("账号列表回滚失败，请检查浏览器存储空间后重新导入同一文件");
        }
      }
      throw new Error("账号或分组保存失败，请检查浏览器存储空间后重试");
    }
    accounts.value = result.tokens;
    if (hasGroups && nextGroups !== groupSnapshot) groups.value = result.tokenGroups;
  }
  return importBinArchive(archive, original, access, authenticate, assertCurrent, { groups: originalGroups, onCommit });
}
