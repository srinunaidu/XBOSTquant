/**
 * Encryption helper for Angel One Remember feature.
 * Uses Web Crypto PBKDF2-HMAC-SHA256 with salt b'angel-one-input' (100k iterations)
 * and AES-GCM (12-byte IV). Derived key is 32 bytes for AES-256.
 * Format: base64(json.dumps({iv, ciphertext, tag}))
 * Mirrors server/utils/encryption.js — strictly via SESSION_SECRET/APP_KEY on server.
 * No static fallback password: browser must use POST /api/angel/encrypt/decrypt.
 */

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

export async function deriveKey(appKey: string): Promise<CryptoKey> {
  if (!appKey) throw new Error("appKey must be non-empty for deriveKey");
  return getAesKey(appKey);
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

export async function encrypt(text: string): Promise<string> {
  const token = await fetchCsrfToken();
  const r = await fetch("/api/angel/encrypt", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { "X-CSRFToken": token } : {}) },
    body: JSON.stringify({ plaintext: text }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.blob) throw new Error(data.error || "encrypt_failed");
  return data.blob as string;
}

export async function decrypt(blob: string): Promise<string> {
  const token = await fetchCsrfToken();
  const r = await fetch("/api/angel/decrypt", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { "X-CSRFToken": token } : {}) },
    body: JSON.stringify({ blob }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.plaintext) throw new Error(data.error || "decrypt_failed");
  return data.plaintext as string;
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
