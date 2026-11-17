/** Angel One symbol → token lookup. Spot indices fixed, custom numeric token passthrough. */
"use strict";

const SYMBOL_TOKENS = {
  NIFTY: "99926000",
  BANKNIFTY: "99926009",
  SENSEX: "99919000",
  FINNIFTY: "99926037",
  MIDCPNIFTY: "99926074",
  NIFTYNXT50: "99926012",
};

const TOKEN_RE = /^\d{4,10}$/;

function resolveSymbol(symbol, exchange = "NSE") {
  if (symbol == null) throw Object.assign(new Error("unknown_symbol"), { code: "unknown_symbol" });
  const s = String(symbol).trim();
  if (!s) throw Object.assign(new Error("unknown_symbol"), { code: "unknown_symbol" });
  if (TOKEN_RE.test(s)) return s;
  const key = s.toUpperCase();
  if (SYMBOL_TOKENS[key]) return SYMBOL_TOKENS[key];
  throw Object.assign(new Error("unknown_symbol"), { code: "unknown_symbol" });
}

function isValidToken(token) {
  return token ? TOKEN_RE.test(String(token).trim()) : false;
}

module.exports = { SYMBOL_TOKENS, resolveSymbol, isValidToken, TOKEN_RE };
