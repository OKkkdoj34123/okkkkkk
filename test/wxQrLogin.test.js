import assert from "node:assert/strict";
import { test } from "node:test";
import { bonProtocol, XCrypto } from "../src/utils/bonProtocol.js";
import {
  buildCombLoginUrl,
  buildLoginPayload,
  buildQrPageUrl,
  buildServerListBin,
  buildServerListUrl,
  encodePayload,
  parseCombUser,
  parseQrPage,
  parseScanStatus,
  parseServerRoles,
  QR_CONFIG,
  SCAN_STATE,
} from "../src/utils/wxQrLogin.js";

test("QR config points at the live game/WeChat endpoints", () => {
  assert.equal(QR_CONFIG.gameApi, "https://xxz-xyzw.hortorgames.com");
  assert.equal(QR_CONFIG.appid, "wxfb0d5667e5cb1c44");
});

test("encodePayload produces stable base64 output", () => {
  const a = encodePayload('{"gameId":"xyzwapp","code":"TESTCODE"}');
  const b = encodePayload('{"gameId":"xyzwapp","code":"TESTCODE"}');
  assert.equal(a, b, "encryption must be deterministic");
  assert.ok(a.length > 0);
  assert.ok(/^[A-Z0-9+/=]+$/i.test(a), "output is base64");
  assert.notEqual(a, '{"gameId":"xyzwapp","code":"TESTCODE"}');
});

test("QR page URL includes appid, bundleid and worker prefix", () => {
  const url = buildQrPageUrl("https://worker.example.com/");
  assert.ok(url.startsWith("https://worker.example.com/api/weixin/connect/app/qrconnect"));
  assert.ok(url.includes(`appid=${  QR_CONFIG.appid}`));
  assert.ok(url.includes(`bundleid=${  QR_CONFIG.bundleid}`));
  assert.ok(!url.includes("//api"));
});

test("parse QR page extracts image url and uuid", () => {
  const html = `<html><img class="auth_qrcode" src="https://open.weixin.qq.com/connect/qrcode/ABC123XYZ?x=1"></html>`;
  const parsed = parseQrPage(html);
  assert.equal(parsed.uuid, "ABC123XYZ");
  assert.ok(parsed.qrUrl.includes("qrcode/ABC123XYZ"));
});

test("scan status parsing handles waiting / success / expired", () => {
  assert.equal(
    parseScanStatus("window.wx_errcode=401;").state,
    SCAN_STATE.WAITING,
  );
  const ok = parseScanStatus(
    "window.wx_errcode=405;wx_redirecturl='https://x?code=AbC123';window.wx_nickname='小明'",
  );
  assert.equal(ok.state, SCAN_STATE.SUCCESS);
  assert.equal(ok.code, "AbC123");
  assert.equal(ok.nickname, "小明");
  assert.equal(parseScanStatus("window.wx_errcode=408").state, SCAN_STATE.EXPIRED);
});

test("login payload carries the scanned code and app identity", () => {
  const p = buildLoginPayload("MYCODE");
  assert.equal(p.code, "MYCODE");
  assert.equal(p.gameId, "xyzwapp");
  assert.equal(p.gameTp, "app");
  assert.ok(buildCombLoginUrl("https://w.example").includes("/api/hortor/comb-login-server/api/v1/login"));
});

test("combUser is parsed only on success", () => {
  assert.deepEqual(parseCombUser({ meta: { errCode: 0 }, data: { combUser: { openid: "o1" } } }), { openid: "o1" });
  assert.equal(parseCombUser({ meta: { errCode: 1, errMsg: "fail" } }), null);
  assert.equal(parseCombUser({ meta: { errCode: 0 }, data: {} }), null);
});

test("serverlist bin is x-encrypted and encodes combUser + serverId", () => {
  const combUser = { openid: "oREAL123" };
  const bin = buildServerListBin(combUser, 180);
  const u8 = new Uint8Array(bin);
  assert.equal(u8[0], 0x70);
  assert.equal(u8[1], 0x78);
  const plain = XCrypto.decrypt(u8);
  const raw = bonProtocol.decode(plain);
  assert.equal(raw.platform, "hortor");
  assert.equal(raw.info.openid, "oREAL123");
  assert.equal(raw.serverId, 180);
  assert.ok(buildServerListUrl().includes("/login/serverlist"));
});

test("serverlist response roles are decrypted and extracted", () => {
  const responsePayload = { body: { roles: [{ serverId: 180, roleId: "123", name: "角色A" }] } };
  const plain = bonProtocol.encode(responsePayload, false);
  const out = XCrypto.encrypt(plain);
  const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
  const roles = parseServerRoles(buf);
  assert.equal(roles.length, 1);
  assert.equal(roles[0].roleId, "123");
  assert.equal(roles[0].name, "角色A");
});
