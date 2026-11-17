/** Encryption helper for Angel One Remember feature.
 * Uses PBKDF2-HMAC-SHA256 with salt b'angel-one-input' 100k, AES-GCM 12-byte IV.
 * Format: base64(json.dumps({iv, ciphertext, tag}))
 */
"use strict";
const crypto = require("crypto");

function deriveKey(appKey) {
  if (!appKey) throw new Error("app_key must be non-empty");
  return crypto.pbkdf2Sync(appKey, Buffer.from("angel-one-input"), 100000, 32, "sha256");
}

function encryptForStorage(plaintext, key) {
  if (!Buffer.isBuffer(key) || ![16,24,32].includes(key.length)) throw new Error("key must be 16/24/32 bytes");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = {
    iv: iv.toString("base64"),
    ciphertext: enc.toString("base64"),
    tag: tag.toString("base64"),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function decryptForStorage(blob, key) {
  if (!Buffer.isBuffer(key) || ![16,24,32].includes(key.length)) throw new Error("key must be 16/24/32 bytes");
  try {
    const jsonStr = Buffer.from(blob, "base64").toString("utf8");
    const payload = JSON.parse(jsonStr);
    const iv = Buffer.from(payload.iv, "base64");
    const ciphertext = Buffer.from(payload.ciphertext, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return dec.toString("utf8");
  } catch (e) {
    throw new Error(`decrypt failed: ${e.message}`);
  }
}

function encrypt(text) {
  const appKey = process.env.APP_KEY || process.env.SESSION_SECRET || "";
  if (!appKey) throw new Error("APP_KEY not set for encryption");
  return encryptForStorage(text, deriveKey(appKey));
}

function decrypt(blob) {
  const appKey = process.env.APP_KEY || process.env.SESSION_SECRET || "";
  if (!appKey) throw new Error("APP_KEY not set for decryption");
  return decryptForStorage(blob, deriveKey(appKey));
}

module.exports = { deriveKey, encryptForStorage, decryptForStorage, encrypt, decrypt };
