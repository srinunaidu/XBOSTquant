/** Thin client for Angel One proxy — CSRF + dedupe + 429 handling. */

export interface AngelCredsInput {
  apiKey: string
  clientCode: string
  password: string
  totpSecret: string
}

export interface CandleParams {
  exchange: "NSE" | "BSE" | "MCX" | "NFO"
  symbol: string
  interval: "ONE_MINUTE"
  fromDate: string
  toDate: string
}

export interface AngelCandle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

async function fetchCSRFToken(): Promise<string> {
  try {
    const r = await fetch("/auth/csrf-token", { credentials: "include" });
    const data = await r.json().catch(() => ({}));
    return data.csrf_token || data.csrfToken || "";
  } catch {
    return "";
  }
}

async function fetchWithCsrf(url: string, body: unknown): Promise<Response> {
  const token = await fetchCSRFToken();
  return fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-CSRFToken": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

// Dedupe: single in-flight promise per endpoint
let loginInFlight: Promise<unknown> | null = null
let candlesInFlight: Promise<unknown> | null = null

export async function testConnection(creds: AngelCredsInput): Promise<{ ok: boolean; clientCode?: string; error?: string }> {
  if (loginInFlight) return loginInFlight as Promise<{ ok: boolean; clientCode?: string; error?: string }>
  const p = (async () => {
    const resp = await fetchWithCsrf("/api/angel/login", creds)
    if (resp.status === 429) {
      const retry = resp.headers.get("Retry-After") || "60"
      throw new Error(`Rate limited, retry after ${retry}s`)
    }
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      throw new Error(data.error || "auth_failed")
    }
    return data
  })()
  loginInFlight = p
  try {
    const res = await p
    return res as { ok: boolean; clientCode?: string; error?: string }
  } finally {
    loginInFlight = null
  }
}

export async function fetchCandles(params: CandleParams): Promise<{ data: AngelCandle[]; cached: boolean }> {
  if (candlesInFlight) return candlesInFlight as Promise<{ data: AngelCandle[]; cached: boolean }>
  const body = {
    exchange: params.exchange,
    symbol: params.symbol,
    interval: params.interval,
    fromDate: params.fromDate,
    toDate: params.toDate,
  }
  const p = (async () => {
    const resp = await fetchWithCsrf("/api/angel/candles", body)
    if (resp.status === 429) {
      const retry = resp.headers.get("Retry-After") || "60"
      throw new Error(`Rate limited, retry after ${retry}s`)
    }
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      throw new Error(data.error || "fetch_failed")
    }
    return data
  })()
  candlesInFlight = p
  try {
    const res = await p
    return res as { data: AngelCandle[]; cached: boolean }
  } finally {
    candlesInFlight = null
  }
}

// For testing: allow clearing in-flight
export function _resetInFlight() {
  loginInFlight = null
  candlesInFlight = null
}
