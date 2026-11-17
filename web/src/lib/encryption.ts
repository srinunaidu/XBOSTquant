/**
 * Encryption helper for Angel One Remember feature.
 * Uses Web Crypto PBKDF2-HMAC-SHA256 with salt b'angel-one-input' (100k iterations)
 * and AES-GCM (12-byte IV). Derived key is 32 bytes for AES-256.
 * Format: base64(json.dumps({iv, ciphertext, tag}))
 * where each field is base64-encoded inner. Mirrors server/utils/encryption.js
 */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const FALLBACK_PASSWORD = "test-app-key-12345678901234567890-test-key-123456";

async function getAesKey(password: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const salt = enc.encode("angel-one-input");
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function deriveKey(_appKey: string): Promise<CryptoKey> {
  // _appKey is accepted for API parity; actual key comes from server or fallback.
  // For browser Remember we use server encrypt/decrypt, but local fallback uses FALLBACK_PASSWORD.
  return getAesKey(FALLBACK_PASSWORD);
}

export async function encrypt(text: string): Promise<string> {
  // Prefer server-side encrypt
  try {
    const token = await fetchCsrfToken();
    const r = await fetch("/api/angel/encrypt", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(token ? { "X-CSRFToken": token } : {}) },
      body: JSON.stringify({ plaintext: text }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.blob) {
      try {
        const inner = atob(data.blob);
        const p = JSON.parse(inner);
        if (p.iv && p.ciphertext && p.tag) return data.blob as string;
      } catch { /* fallthrough */ }
      return data.blob as string;
    }
  } catch { /* fallback */ }
  return localEncrypt(text);
}

export async function decrypt(blob: string): Promise<string> {
  try {
    const token = await fetchCsrfToken();
    const r = await fetch("/api/angel/decrypt", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(token ? { "X-CSRFToken": token } : {}) },
      body: JSON.stringify({ blob }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.plaintext) return data.plaintext as string;
  } catch { /* fallback */ }
  return localDecrypt(blob);
}

async function fetchCsrfToken(): Promise<string> {
  try {
    const r = await fetch("/auth/csrf-token", { credentials: "include" });
    const data = await r.json();
    return data.csrf_token || data.csrfToken || "";
  } catch {
    return "";
  }
}

async function localEncrypt(plaintext: string): Promise<string> {
  const key = await getAesKey(FALLBACK_PASSWORD);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ctAndTagBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, enc.encode(plaintext) as unknown as BufferSource);
  const ctAndTag = new Uint8Array(ctAndTagBuf);
  const tag = ctAndTag.slice(ctAndTag.length - 16);
  const ciphertext = ctAndTag.slice(0, ctAndTag.length - 16);
  const payload = { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext), tag: bytesToBase64(tag) };
  return btoa(JSON.stringify(payload));
}

async function localDecrypt(blob: string): Promise<string> {
  const json = atob(blob);
  const payload = JSON.parse(json) as { iv: string; ciphertext: string; tag: string };
  if (!payload.iv || !payload.ciphertext || !payload.tag) throw new Error("invalid_blob");
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);
  const tag = base64ToBytes(payload.tag);
  const ctAndTag = new Uint8Array([...ciphertext, ...tag]);
  const key = await getAesKey(FALLBACK_PASSWORD);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, ctAndTag as unknown as BufferSource);
  return new TextDecoder().decode(plainBuf);
}

export function isEncryptedBlob(s: string): boolean {
  try {
    const inner = atob(s);
    const p = JSON.parse(inner);
    return !!(p.iv && p.ciphertext && p.tag);
  } catch {
    return false;
  }
}
