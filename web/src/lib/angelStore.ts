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
    // Strictly via server; no static fallback
    const blob = await encryptViaServer(plaintext)
    localStorage.setItem(REMEMBER_KEY, blob)
  } catch (e) {
    // Server encrypt failed: disable Remember and surface error, no fallback
    try { localStorage.removeItem(REMEMBER_KEY) } catch {}
    const msg = e instanceof Error ? e.message : "encrypt_failed"
    try {
      useAngelStore.setState({ remember: false, status: "error", error: msg })
      // keep sessionStorage in sync: remember false
      try {
        const raw = sessionStorage.getItem(SESSION_KEY)
        if (raw) {
          const data = JSON.parse(raw)
          data.remember = false
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(data))
        }
      } catch {}
    } catch {}
  }
}

async function decryptBlob(blob: string): Promise<string | null> {
  try {
    const text = await decryptViaServer(blob)
    return text
  } catch {
    return null
  }
}

function clearAllStorage() {
  if (!isBrowser()) return
  try { sessionStorage.removeItem(SESSION_KEY) } catch {}
  try { localStorage.removeItem(REMEMBER_KEY) } catch {}
}

function isSessionValid(): boolean {
  if (!isBrowser()) return false
  try {
    const raw = localStorage.getItem("xbost-auth") || sessionStorage.getItem("xbost-auth")
    // Also check cookie session via fetch? For now presence of xbost-auth
    // If no auth marker, session is invalid
    if (!raw) return false
    return true
  } catch {
    return false
  }
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
      // if enabling remember fails, persistToLocal will reset remember to false and set error
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
    // If session invalid, clear angel state (logout/expiry)
    if (!isSessionValid()) {
      // Do not auto-restore from localStorage when session invalid
      clearAllStorage()
      // reset without triggering storage write loop
      try { useAngelStore.setState({ creds: { ...initialCreds }, remember: false, jwt: null, status: "idle", error: null }) } catch {}
      return
    }
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
          // also sync to sessionStorage
          try {
            const ns = { creds, exchange: useAngelStore.getState().exchange, symbol: useAngelStore.getState().symbol, interval: useAngelStore.getState().interval, fromDate: useAngelStore.getState().fromDate, toDate: useAngelStore.getState().toDate, remember: true } as AngelState
            persistToSession(ns)
          } catch {}
        } else {
          // decrypt failed: disable Remember
          try { localStorage.removeItem(REMEMBER_KEY) } catch {}
          set({ remember: false, error: "decrypt_failed", status: "error" })
        }
      }
    } catch {}
  },
}))

if (isBrowser()) {
  void useAngelStore.getState().hydratate()
  window.addEventListener("beforeunload", () => {
    try {
      const remember = useAngelStore.getState().remember
      // Only clear sessionStorage when Remember is off (session-only mode)
      // When Remember is on, keep session for fast restore until explicit logout
      if (!remember) sessionStorage.removeItem(SESSION_KEY)
    } catch {
      try { sessionStorage.removeItem(SESSION_KEY) } catch {}
    }
  })
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (!isSessionValid()) {
        try { useAngelStore.getState().reset() } catch {}
        return
      }
      try { void useAngelStore.getState().hydratate() } catch {}
      // Probe server session as well
      try {
        fetch("/api/me", { credentials: "include" }).then((r) => {
          if (!r.ok) {
            try { useAngelStore.getState().reset() } catch {}
          }
        }).catch(() => {})
      } catch {}
    }
  })
  // Listen for explicit logout via storage or custom event
  window.addEventListener("storage", (e) => {
    if (e.key === "xbost-auth" && !e.newValue) {
      try { useAngelStore.getState().reset() } catch {}
    }
  })
}

export function clearAngelStorage() {
  clearAllStorage()
}
export function is_session_valid(): boolean {
  return isSessionValid()
}
