"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const KEY_BYTES = 32;

function loadOrCreateKey(traceHome) {
  if (process.env.TRACE_KEY) {
    const decoded = Buffer.from(process.env.TRACE_KEY, "base64");
    if (decoded.length !== KEY_BYTES) {
      throw new Error("TRACE_KEY must be a base64-encoded 32 byte key.");
    }
    return decoded;
  }

  const keyPath = path.join(traceHome, "key");
  fs.mkdirSync(traceHome, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(traceHome, 0o700);
  } catch {
    // Best-effort hardening for existing stores; read/write errors still surface below.
  }
  if (fs.existsSync(keyPath)) {
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Best-effort hardening for existing key files.
    }
    const decoded = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
    if (decoded.length !== KEY_BYTES) {
      throw new Error(`Invalid encryption key at ${keyPath}`);
    }
    return decoded;
  }

  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(keyPath, key.toString("base64") + "\n", { mode: 0o600 });
  return key;
}

function encryptJson(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64")
  };
}

function decryptJson(key, box) {
  if (!box || box.v !== 1 || box.alg !== "aes-256-gcm" || !box.iv || !box.tag || !box.data) {
    throw new Error("Invalid encrypted blob format.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(box.data, "base64")),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

module.exports = {
  loadOrCreateKey,
  encryptJson,
  decryptJson
};
