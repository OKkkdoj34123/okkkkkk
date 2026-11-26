// BATCH_RUNTIME_FIX_20261015
export function createConnectionSlots() {
  const owners = new Set();
  return {
    get active() { return owners.size; },
    has(tokenId) { return owners.has(String(tokenId)); },
    reserve(tokenId) {
      if (tokenId == null) throw new Error("连接名额缺少账号ID");
      const key = String(tokenId);
      if (owners.has(key)) return false;
      owners.add(key);
      return true;
    },
    release(tokenId) { return tokenId != null && owners.delete(String(tokenId)); },
  };
}
