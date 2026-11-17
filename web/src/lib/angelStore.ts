import { create } from "zustand"

export interface AngelCreds {
  apiKey: string
  clientCode: string
  password: string
  totpSecret: string
}

interface AngelState {
  creds: AngelCreds
  exchange: "NSE" | "BSE" | "MCX" | "NFO"
  symbol: string
  interval: "ONE_MINUTE"
  fromDate: string
  toDate: string
  remember: boolean
  jwt: string | null
  status: "idle" | "success" | "error"
  error: string | null

  setCreds: (creds: Partial<AngelCreds>) => void
  setExchange: (ex: AngelState["exchange"]) => void
  setSymbol: (s: string) => void
  setInterval: (i: AngelState["interval"]) => void
  setDates: (fromDate: string, toDate: string) => void
  setRemember: (v: boolean) => void
  setJwt: (jwt: string | null) => void
  setStatus: (s: AngelState["status"], error?: string | null) => void
  reset: () => void
  hydratate: () => Promise<void>
}

const SESSION_KEY = "angel:creds:session"
const REMEMBER_KEY = "angel:creds:remember"

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined"
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function fetchCsrfToken(): Promise<string> {
  try {
    const r = await fetch("/auth/csrf-token", { credentials: "include" })
    const data = await r.json()
    return data.csrf_token || data.csrfToken || ""
  } catch {
    return ""
  }
}

async function encryptViaServer(plaintext: string): Promise<string> {
  const token = await fetchCsrfToken()
  const r = await fetch("/api/angel/encrypt", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { "X-CSRFToken": token } : {}) },
    body: JSON.stringify({ plaintext }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok || !data.blob) throw new Error(data.error || "encrypt_failed")
  return data.blob as string
}

async function decryptViaServer(blob: string): Promise<string> {
  const token = await fetchCsrfToken()
  const r = await fetch("/api/angel/decrypt", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { "X-CSRFToken": token } : {}) },
    body: JSON.stringify({ blob }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok || !data.plaintext) throw new Error(data.error || "decrypt_failed")
  return data.plaintext as string
}

const FALLBACK_PASSWORD = "test-app-key-12345678901234567890-test-key-123456"

async function getAesKey(password: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const salt = enc.encode("angel-one-input")
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

async function localEncrypt(plaintext: string): Promise<string> {
  const key = await getAesKey(FALLBACK_PASSWORD)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const ctAndTagBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, enc.encode(plaintext) as unknown as BufferSource)
  const ctAndTag = new Uint8Array(ctAndTagBuf)
  const tag = ctAndTag.slice(ctAndTag.length - 16)
  const ciphertext = ctAndTag.slice(0, ctAndTag.length - 16)
  const payload = { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext), tag: bytesToBase64(tag) }
  return btoa(JSON.stringify(payload))
}

async function localDecrypt(blob: string): Promise<string> {
  const json = atob(blob)
  const payload = JSON.parse(json) as { iv: string; ciphertext: string; tag: string }
  if (!payload.iv || !payload.ciphertext || !payload.tag) throw new Error("invalid_blob")
  const iv = base64ToBytes(payload.iv)
  const ciphertext = base64ToBytes(payload.ciphertext)
  const tag = base64ToBytes(payload.tag)
  const ctAndTag = new Uint8Array([...ciphertext, ...tag])
  const key = await getAesKey(FALLBACK_PASSWORD)
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, ctAndTag as unknown as BufferSource)
  return new TextDecoder().decode(plainBuf)
}

async function encryptBlob(plaintext: string): Promise<string> {
  try {
    const blob = await encryptViaServer(plaintext)
    try {
      const inner = atob(blob)
      const p = JSON.parse(inner)
      if (p.iv && p.ciphertext && p.tag) return blob
    } catch { /* fallthrough */ }
    return blob
  } catch {
    return localEncrypt(plaintext)
  }
}

async function decryptBlob(blob: string): Promise<string | null> {
  try {
    const text = await decryptViaServer(blob)
    return text
  } catch {
    try {
      const text = await localDecrypt(blob)
      return text
    } catch {
      return null
    }
  }
}

function persistToSession(state: AngelState) {
  if (!isBrowser()) return
  try {
    const data = {
      creds: state.creds,
      exchange: state.exchange,
      symbol: state.symbol,
      interval: state.interval,
      fromDate: state.fromDate,
      toDate: state.toDate,
      remember: state.remember,
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data))
  } catch { /* ignore quota */ }
}

async function persistToLocal(state: AngelState) {
  if (!isBrowser()) return
  try {
    if (!state.remember) {
      localStorage.removeItem(REMEMBER_KEY)
      return
    }
    const plaintext = JSON.stringify(state.creds)
    const blob = await encryptBlob(plaintext)
    localStorage.setItem(REMEMBER_KEY, blob)
  } catch { /* ignore */ }
}

function clearAllStorage() {
  if (!isBrowser()) return
  try { sessionStorage.removeItem(SESSION_KEY) } catch {}
  try { localStorage.removeItem(REMEMBER_KEY) } catch {}
}

const initialCreds: AngelCreds = { apiKey: "", clientCode: "", password: "", totpSecret: "" }

export const useAngelStore = create<AngelState>()((set) => ({
  creds: { ...initialCreds },
  exchange: "NSE",
  symbol: "NIFTY",
  interval: "ONE_MINUTE",
  fromDate: "",
  toDate: "",
  remember: false,
  jwt: null,
  status: "idle",
  error: null,

  setCreds: (next) =>
    set((s) => {
      const creds = { ...s.creds, ...next }
      const ns = { ...s, creds } as AngelState
      persistToSession(ns)
      void persistToLocal(ns)
      return { creds }
    }),

  setExchange: (exchange) =>
    set((s) => {
      const ns = { ...s, exchange } as AngelState
      persistToSession(ns)
      return { exchange }
    }),

  setSymbol: (symbol) =>
    set((s) => {
      const ns = { ...s, symbol } as AngelState
      persistToSession(ns)
      return { symbol }
    }),

  setInterval: (interval) =>
    set((s) => {
      const ns = { ...s, interval } as AngelState
      persistToSession(ns)
      return { interval }
    }),

  setDates: (fromDate, toDate) =>
    set((s) => {
      const ns = { ...s, fromDate, toDate } as AngelState
      persistToSession(ns)
      return { fromDate, toDate }
    }),

  setRemember: (remember) =>
    set((s) => {
      const ns = { ...s, remember } as AngelState
      persistToSession(ns)
      void persistToLocal(ns)
      return { remember }
    }),

  setJwt: (jwt) => set({ jwt }),

  setStatus: (status, error = null) => set({ status, error }),

  reset: () => {
    clearAllStorage()
    set({
      creds: { ...initialCreds },
      exchange: "NSE",
      symbol: "NIFTY",
      interval: "ONE_MINUTE",
      fromDate: "",
      toDate: "",
      remember: false,
      jwt: null,
      status: "idle",
      error: null,
    })
  },

  hydratate: async () => {
    if (!isBrowser()) return
    try {
      const raw = sessionStorage.getItem(SESSION_KEY)
      if (raw) {
        const data = JSON.parse(raw)
        if (data.creds) {
          set({
            creds: data.creds,
            exchange: data.exchange || "NSE",
            symbol: data.symbol || "NIFTY",
            interval: data.interval || "ONE_MINUTE",
            fromDate: data.fromDate || "",
            toDate: data.toDate || "",
            remember: data.remember || false,
          })
          return
        }
      }
    } catch {}
    try {
      const blob = localStorage.getItem(REMEMBER_KEY)
      if (blob) {
        const decrypted = await decryptBlob(blob)
        if (decrypted) {
          const creds = JSON.parse(decrypted)
          set({ creds, remember: true })
        }
      }
    } catch {}
  },
}))

if (isBrowser()) {
  void useAngelStore.getState().hydratate()
  window.addEventListener("beforeunload", () => {
    try { sessionStorage.removeItem(SESSION_KEY) } catch {}
  })
  const checkExpiry = () => {
    try {
      const raw = localStorage.getItem("xbost-auth") || sessionStorage.getItem("xbost-auth")
      if (!raw) return
    } catch {}
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      try { void useAngelStore.getState().hydratate() } catch {}
    }
  })
}

export function clearAngelStorage() {
  clearAllStorage()
}
