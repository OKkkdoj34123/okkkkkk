import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAccountKey,
  findMatchingToken,
  parseBinFileName,
} from "../src/utils/accountIdentity.js";

test("parseBinFileName extracts stable role metadata from a game export", () => {
  assert.deepEqual(parseBinFileName("bin-无尽海域服-1-123456789-二阶导数4.bin"), {
    server: "无尽海域",
    roleIndex: "1",
    roleId: "123456789",
    roleName: "二阶导数4",
  });
});

test("parseBinFileName rejects unsupported file names", () => {
  assert.equal(parseBinFileName("token.json"), null);
  assert.equal(parseBinFileName("bin-随意.bin"), null);
  assert.equal(parseBinFileName(""), null);
  assert.equal(parseBinFileName(null), null);
});

test("buildAccountKey is stable across differently encoded BIN files", () => {
  const first = parseBinFileName("bin-无尽海域服-1-123456789-二阶导数4.bin");
  const second = parseBinFileName("bin-无尽海域服-1-123456789-二阶导数4.bin");
  assert.equal(
    buildAccountKey(first.server, first.roleId),
    buildAccountKey(second.server, second.roleId),
  );
  assert.equal(buildAccountKey("无尽海域", "123456789"), "无尽海域:123456789");
});

test("buildAccountKey requires a role id", () => {
  assert.equal(buildAccountKey("无尽海域", ""), null);
  assert.equal(buildAccountKey("无尽海域", null), null);
});

test("re-import matches an existing account by stable key even when the token string changed", () => {
  const meta = parseBinFileName("bin-无尽海域服-1-123456789-二阶导数4.bin");
  const key = buildAccountKey(meta.server, meta.roleId);
  const existing = {
    id: "old-bin-content-hash",
    name: meta.roleName,
    server: `${meta.server}${meta.roleIndex}`,
    accountKey: key,
    roleId: meta.roleId,
    token: "OLD_TOKEN_STRING",
  };
  // 新 bin 的 token 字符串、内容 MD5 都变了，但稳定标识没变
  const found = findMatchingToken([existing], {
    accountKey: key,
    roleId: meta.roleId,
    server: `${meta.server}${meta.roleIndex}`,
    name: meta.roleName,
  });
  assert.equal(found, existing);
  assert.equal(found.id, "old-bin-content-hash");
});

test("first re-import upgrades a legacy token that has no accountKey or roleId", () => {
  // 本次改动前导入的老账号：既没有 accountKey 也没有 roleId
  const legacy = {
    id: "legacy-id",
    name: "二阶导数4",
    server: "无尽海域1",
    token: "OLD_TOKEN",
  };
  const meta = parseBinFileName("bin-无尽海域服-1-123456789-二阶导数4.bin");
  const found = findMatchingToken([legacy], {
    accountKey: buildAccountKey(meta.server, meta.roleId),
    roleId: meta.roleId,
    server: `${meta.server}${meta.roleIndex}`,
    name: meta.roleName,
  });
  assert.equal(found, legacy);
});

test("a different role is not matched to an existing account", () => {
  const existing = {
    id: "account-a",
    name: "角色A",
    server: "无尽海域1",
    accountKey: "无尽海域:111111",
    roleId: "111111",
  };
  const meta = parseBinFileName("bin-无尽海域服-1-222222-角色B.bin");
  const found = findMatchingToken([existing], {
    accountKey: buildAccountKey(meta.server, meta.roleId),
    roleId: meta.roleId,
    server: `${meta.server}${meta.roleIndex}`,
    name: meta.roleName,
  });
  assert.equal(found, undefined);
});

test("re-import matches legacy account regardless of (1)/(2) suffix in file name", () => {
  const legacy = {
    id: "legacy-id",
    name: "散列算法(2)",
    server: "166411",
    token: "OLD_TOKEN",
  };
  const identity = {
    accountKey: "16641:440494772",
    roleId: "440494772",
    server: "166411",
    name: "散列算法(1)",
  };
  assert.equal(findMatchingToken([legacy], identity), legacy);
  // 删掉括号也一样能匹配
  assert.equal(
    findMatchingToken([legacy], { ...identity, name: "散列算法" }),
    legacy,
  );
});

test("real game file names from the same role share one stable account key", () => {
  const a = parseBinFileName("bin-16641服-1-440494772-散列算法(2).bin");
  const b = parseBinFileName("bin-16641服-1-440494772-散列算法(1).bin");
  assert.equal(buildAccountKey(a.server, a.roleId), buildAccountKey(b.server, b.roleId));
  assert.equal(buildAccountKey(a.server, a.roleId), "16641:440494772");
});
