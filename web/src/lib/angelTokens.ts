/** Angel One symbol → token lookup. Spot indices fixed, custom numeric token passthrough. */
export const SYMBOL_TOKENS: Record<string, string> = {
  NIFTY: "99926000",
  BANKNIFTY: "99926009",
  SENSEX: "99919000",
  FINNIFTY: "99926037",
  MIDCPNIFTY: "99926074",
  NIFTYNXT50: "99926012",
};

const TOKEN_RE = /^\d{4,10}$/;

/**
 * Resolve a symbol name or numeric token to Angel symboltoken.
 * Throws "unknown_symbol" for invalid.
 */
export function resolveSymbol(symbol: string, _exchange: string = "NSE"): string {
  if (symbol == null) throw new Error("unknown_symbol");
  const s = String(symbol).trim();
  if (!s) throw new Error("unknown_symbol");
  if (TOKEN_RE.test(s)) return s;
  const key = s.toUpperCase();
  if (SYMBOL_TOKENS[key]) return SYMBOL_TOKENS[key];
  throw new Error("unknown_symbol");
}

export function isValidToken(token: string): boolean {
  return token ? TOKEN_RE.test(String(token).trim()) : false;
}
