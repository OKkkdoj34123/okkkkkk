/* eslint-disable node/prefer-global/buffer -- Node test environment uses Buffer */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bonProtocol, LXCrypto, XCrypto } from "../src/utils/bonProtocol.js";
import {
  detectScheme,
  formatInspectedData,
  inspectProtocol,
  parseInputBytes,
} from "../src/utils/protocolInspector.js";

const toHex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");

test("detectScheme identifies lx / x / xtm / plain", () => {
  assert.equal(detectScheme(new Uint8Array([0x70, 0x6c, 0, 0])), "lx");
  assert.equal(detectScheme(new Uint8Array([0x70, 0x78, 0, 0])), "x");
  assert.equal(detectScheme(new Uint8Array([0x70, 0x74, 0, 0])), "xtm");
  assert.equal(detectScheme(new Uint8Array([8, 1, 2, 3])), "plain");
  assert.equal(detectScheme(new Uint8Array([1, 2])), "unknown");
});

test("parseInputBytes handles hex, base64 and plain text", () => {
  assert.equal(toHex(parseInputBytes("70 78 ab cd")), "7078abcd");
  assert.equal(toHex(parseInputBytes("0x70,0x78")), "7078");
  assert.deepEqual(Array.from(parseInputBytes("aGVsbG8=")), Array.from(Buffer.from("hello")));
  // 无 padding 的合法 base64（长度非 4 的倍数）也应正确解码
  assert.deepEqual(Array.from(parseInputBytes("aGVsbG8")), Array.from(Buffer.from("hello")));
  assert.deepEqual(Array.from(parseInputBytes("hello")), Array.from(Buffer.from("hello", "utf8")));
});

test("inspectProtocol auto-decrypts x-encrypted BON data from hex", () => {
  const payload = { cmd: "role_getroleinfo", seq: 7, body: { level: 12 } };
  const plain = bonProtocol.encode(payload, false);
  const enc = XCrypto.encrypt(plain);
  const bytes = enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.length);
  const result = inspectProtocol(toHex(new Uint8Array(bytes)));
  assert.equal(result.scheme, "x");
  assert.equal(result.ok, true);
  assert.equal(result.data.cmd, "role_getroleinfo");
  assert.equal(result.data.body.level, 12);
});

test("inspectProtocol auto-decrypts lx-encrypted BON data", () => {
  const payload = { cmd: "activity_get", body: { id: 6 } };
  const plain = bonProtocol.encode(payload, false);
  const enc = LXCrypto.encrypt(plain);
  const bytes = enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.length);
  const result = inspectProtocol(toHex(new Uint8Array(bytes)));
  assert.equal(result.scheme, "lx");
  assert.equal(result.ok, true);
  assert.equal(result.data.body.id, 6);
});

test("inspectProtocol decodes plain BON", () => {
  const plain = bonProtocol.encode({ cmd: "test", n: 1 }, false);
  const result = inspectProtocol(toHex(new Uint8Array(plain)));
  assert.equal(result.scheme, "plain");
  assert.equal(result.ok, true);
  assert.equal(result.data.cmd, "test");
});

test("inspectProtocol reports errors for empty / bad input", () => {
  assert.equal(inspectProtocol("").ok, false);
  assert.equal(inspectProtocol("70 78").ok, false); // too short
});

test("formatInspectedData produces readable JSON with Uint8Array summary", () => {
  const text = formatInspectedData({ data: new Uint8Array([1, 2, 255]) });
  assert.ok(text.includes("Uint8Array"));
  assert.ok(text.includes("ff"));
});
