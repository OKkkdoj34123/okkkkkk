import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBatchImportPlans,
  buildBinFileName,
  buildRoleImportPlan,
  decodeServerId,
  encodeLoginBin,
} from "../src/utils/qrRoleImport.js";
import { bonProtocol, XCrypto } from "../src/utils/bonProtocol.js";

const combUser = { openid: "oTEST123", unionid: "uTEST" };

const makeRole = (serverId, roleId, name) => ({ serverId, roleId, name });

test("decodeServerId maps slot bits and server number", () => {
  assert.deepEqual(decodeServerId(180), { serverNum: 153, roleIndex: 0 });
  assert.deepEqual(decodeServerId(1000180), { serverNum: 153, roleIndex: 1 });
  assert.deepEqual(decodeServerId(2000180), { serverNum: 153, roleIndex: 2 });
});

test("bin file name follows the existing identity format", () => {
  assert.equal(buildBinFileName(makeRole(180, "1234567", "测试角色")), "bin-153服-0-1234567-测试角色.bin");
});

test("encoded bin is a valid x-protocol buffer and round-trips", () => {
  const bin = encodeLoginBin({ platform: "hortor", info: combUser, serverId: 180 });
  const u8 = new Uint8Array(bin);
  assert.equal(u8[0], 0x70); // x 协议标记
  assert.equal(u8[1], 0x78);
  const plain = XCrypto.decrypt(u8);
  const raw = bonProtocol.decode(plain);
  assert.equal(raw.platform, "hortor");
  assert.equal(raw.info.openid, "oTEST123");
  assert.equal(raw.serverId, 180);
});

test("new role gets a pending id for the caller to fill", () => {
  const result = buildRoleImportPlan(makeRole(180, "1234567", "测试角色"), combUser, []);
  assert.equal(result.success, true);
  assert.equal(result.plan.isUpdate, false);
  assert.equal(result.plan.id, null);
  assert.equal(result.plan.roleId, "1234567");
  assert.equal(result.plan.accountKey, "153:1234567");
  assert.equal(result.plan.server, "1530");
  assert.ok(result.plan.bin.byteLength > 0);
});

test("existing account is matched by accountKey and its id is reused", () => {
  const tokens = [{
    id: "old-id-aaa",
    name: "测试角色",
    server: "1530",
    accountKey: "153:1234567",
    roleId: "1234567",
    wsUrl: "wss://keep-this",
  }];
  const result = buildRoleImportPlan(makeRole(180, "1234567", "测试角色"), combUser, tokens);
  assert.equal(result.success, true);
  assert.equal(result.plan.isUpdate, true);
  assert.equal(result.plan.id, "old-id-aaa", "scheduled tasks keep referencing the same id");
  assert.equal(result.plan.wsUrl, "wss://keep-this");
});

test("legacy account without accountKey is still matched by roleId+server", () => {
  const tokens = [{
    id: "legacy-id",
    name: "测试角色",
    server: "1530",
    roleId: "1234567",
  }];
  const result = buildRoleImportPlan(makeRole(180, "1234567", "测试角色"), combUser, tokens);
  assert.equal(result.plan.id, "legacy-id");
  assert.equal(result.plan.isUpdate, true);
});

test("batch handles mix of new, existing and invalid roles", () => {
  const tokens = [{ id: "keep", accountKey: "153:1234567", roleId: "1234567", server: "1530" }];
  const roles = [
    makeRole(180, "1234567", "已存在"),
    makeRole(180, "7654321", "新角色"),
    { serverId: null, roleId: "1", name: "坏数据" },
  ];
  const { plans, failures } = buildBatchImportPlans(roles, combUser, tokens);
  assert.equal(plans.length, 2);
  assert.equal(failures.length, 1);
  assert.equal(plans.find((p) => p.roleId === "1234567").id, "keep");
  assert.equal(plans.find((p) => p.roleId === "7654321").id, null);
});
