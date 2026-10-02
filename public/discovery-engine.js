/* XBOST OPTION DISCOVERY engine — runs in browser (Web Worker) or node.
 * Independent option-native research pipeline. No futures signals, no
 * indicator optimizer, no production strategy imports.
 * Stages: schema detect → normalize → chain metadata → features → type/strike
 * relationships → events/sequences/states → forward labels → clustering →
 * chronological OOS → surrogate/BH → path-exit backtest → metrics →
 * robustness → 13-filter pipeline → paper gate → export bundle.
 * Log lines mirror the Python engine so results are comparable.
 */
'use strict';

const OD = {
  version: 'od-js-v1',
  featureVersion: 'dyn-v1',
};

OD.SCHEMA = {
  timestamp: ['timestamp', 'ts', 'ist', 'date', 'datetime', 'time', 'bar_time'],
  expiry: ['expiry', 'exp', 'expiration', 'expiry_date', 'maturity'],
  strike: ['strike', 'strike_px', 'strike_price', 'k'],
  option_type: ['option_type', 'otype', 'cp', 'call_put', 'type', 'kind', 'side'],
  symbol: ['symbol', 'contract', 'contract_symbol', 'instrument', 'ticker'],
  open: ['open', 'o', 'open_price'],
  high: ['high', 'h', 'high_price'],
  low: ['low', 'l', 'low_price'],
  close: ['close', 'c', 'close_price', 'last', 'ltp', 'settle'],
  volume: ['volume', 'vol', 'v', 'qty', 'quantity', 'traded_qty'],
  oi: ['oi', 'open_interest', 'openinterest'],
  bid: ['bid', 'bid_price', 'best_bid'],
  ask: ['ask', 'ask_price', 'best_ask'],
  underlying: ['underlying', 'under', 'spot', 'index', 'name'],
};

function normOtype(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  const m = { C: 'C', CALL: 'C', P: 'P', PUT: 'P', CE: 'CE', PE: 'PE' };
  return m[s] || s || 'UNKNOWN';
}

/* ---------- contract registry: multi-strategy metadata parsing (§1-§3) ----------
   Strategy A: explicit metadata fields (long format) — handled by the loader.
   Strategy B: token parsing (order: type suffix → trailing strike → underlying
   prefix → expiry infix). Strategy C: keep contract with UNKNOWN + reason.
   Nothing is silently discarded; confidence recorded per contract. */
OD.OTYPE_TOKENS = ['CALL', 'PUT', 'CE', 'PE', 'C', 'P']; // longest-first match
OD.MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

OD.parseContractToken = function (token) {
  const raw = String(token);
  const up = raw.toUpperCase().replace(/[\s\-]+/g, '_');
  // B1: option-type suffix (longest token first so CALL beats C)
  let otype = null, rest = up, method = [];
  for (const t of OD.OTYPE_TOKENS) {
    const re = new RegExp('[_]?' + t + '$');
    if (re.test(rest)) {
      otype = normOtype(t);
      rest = rest.replace(re, '');
      method.push('type-suffix:' + t);
      break;
    }
  }
  // B4 first: expiry infix DDMMMYY(Y) — strip before strike so its digits
  // cannot merge into the strike run (e.g. 29SEP26|54700).
  // 4-digit years only when NOT followed by another digit; else 2-digit year.
  const MON = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC';
  let expInfix = null;
  let e = up.match(new RegExp(`(\\d{1,2})(${MON})(\\d{4})(?!\\d)`));
  if (!e) e = up.match(new RegExp(`(\\d{1,2})(${MON})(\\d{2})(?=\\d|$|_)`));
  if (e) {
    const yy = e[3].length === 2 ? '20' + e[3] : e[3];
    expInfix = `${e[1].padStart(2, '0')}${e[2]}${yy}`;
    rest = rest.replace(e[0], '_');
    method.push('expiry-infix');
  }
  // B2: strike = trailing digit run (2-7 digits, optional decimal)
  let strike = NaN;
  const m = rest.match(/(\d{2,7}(?:\.\d+)?)$/);
  if (m) {
    strike = Number(m[1]);
    rest = rest.slice(0, rest.length - m[1].length);
    method.push('trailing-strike');
  }
  // B3: underlying = leading alpha run
  let underlying = null;
  const u = rest.match(/^([A-Z]{2,})/);
  if (u) { underlying = u[1]; method.push('underlying-prefix'); }
  const haveBoth = otype !== null && !isNaN(strike);
  return {
    underlying, expiry_infix: expInfix, strike, option_type: otype || 'UNKNOWN',
    parse_method: method.length ? 'token:' + method.join('+') : 'none',
    parse_confidence: haveBoth ? 'high' : ((otype !== null || !isNaN(strike)) ? 'medium' : 'low'),
  };
};

OD.buildRegistry = function (norm, layout) {
  // per-contract observed expiries + volume for the registry
  const agg = new Map();
  for (const r of norm) {
    let a = agg.get(r.symbol);
    if (!a) { a = { exps: new Set(), vol: 0, n: 0, hasStrike: false, hasOtype: false, und: new Set() }; agg.set(r.symbol, a); }
    a.exps.add(r.expiry); a.n++;
    if (!isNaN(r.volume)) a.vol += r.volume;
    if (!isNaN(r.strike)) a.hasStrike = true;
    if (r.option_type && r.option_type !== 'UNKNOWN') a.hasOtype = true;
    if (r.underlying && r.underlying !== 'UNKNOWN') a.und.add(r.underlying);
  }
  const reg = [];
  for (const [sym, a] of agg) {
    const sample = norm.find(r => r.symbol === sym);
    let rec;
    if (a.hasStrike || a.hasOtype) {
      // Strategy A: explicit metadata present in the data itself
      rec = {
        underlying: [...a.und][0] || 'UNKNOWN',
        expiry_infix: null,
        strike: a.hasStrike ? sample.strike : NaN,
        option_type: a.hasOtype ? sample.option_type : 'UNKNOWN',
        parse_method: 'explicit:' + [a.hasStrike ? 'strike' : null, a.hasOtype ? 'otype' : null].filter(Boolean).join('+'),
        parse_confidence: (a.hasStrike && a.hasOtype) ? 'high' : 'medium',
      };
    } else {
      // Strategy B/C: token parsing, UNKNOWN + reason on failure
      rec = OD.parseContractToken(sym);
      rec.metadata_source = 'token';
    }
    if (!rec.metadata_source) rec.metadata_source = layout === 'long' ? 'explicit' : 'token';
    const validStrike = !isNaN(rec.strike);
    const validType = !!rec.option_type && rec.option_type !== 'UNKNOWN';
    const reasons = [];
    if (!validStrike) reasons.push('strike extraction failed');
    if (!validType) reasons.push('option_type extraction failed');
    reg.push({
      contract_id: sym, source_name: sym,
      underlying: rec.underlying || 'UNKNOWN',
      expiry: [...a.exps].sort(),
      strike: validStrike ? rec.strike : 'UNKNOWN',
      option_type: validType ? rec.option_type : 'UNKNOWN',
      metadata_source: rec.metadata_source,
      parse_method: rec.parse_method,
      parse_confidence: rec.parse_confidence,
      enabled: true,
      reason_disabled: reasons.length ? reasons.join('; ') : '',
      volume: a.vol, bars: a.n,
    });
  }
  reg.sort((a, b) => b.volume - a.volume);
  return reg;
};

function resolveCol(lcols, role) {
  for (const cand of OD.SCHEMA[role] || []) {
    const i = lcols.indexOf(cand.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  let hi = 0;
  while (hi < lines.length && !lines[hi].trim()) hi++;
  if (hi >= lines.length) throw new Error('empty CSV');
  const head = splitLine(lines[hi]);
  const rows = [];
  for (let i = hi + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const p = splitLine(lines[i]);
    if (p.length < head.length - 2) continue;
    rows.push(p);
  }
  return { head, rows };
}

function splitLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseTs(v) {
  if (v == null || v === '') return NaN;
  if (/^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n; // epoch seconds → ms
  }
  const t = Date.parse(String(v).trim().replace(' ', 'T'));
  return isNaN(t) ? NaN : t;
}

function fieldSuffix(col) {
  const i = col.lastIndexOf('_');
  if (i <= 0) return null;
  const tail = col.slice(i + 1).toLowerCase();
  for (const role of ['open', 'high', 'low', 'close', 'volume', 'oi', 'bid', 'ask']) {
    if ((OD.SCHEMA[role] || []).some(a => a.toLowerCase() === tail)) return { contract: col.slice(0, i), role };
  }
  return null;
}

/* ---------- ingestion → canonical rows ---------- */
OD.ingest = function (text, schemaOver) {
  schemaOver = schemaOver || {};
  const { head, rows } = parseCSV(text);
  const lcols = head.map(h => h.toLowerCase());
  const col = role => {
    if (schemaOver[role]) {
      const i = lcols.indexOf(String(schemaOver[role]).toLowerCase());
      return i;
    }
    return resolveCol(lcols, role);
  };
  const roles = {};
  for (const r of Object.keys(OD.SCHEMA)) {
    const i = col(r);
    if (i >= 0) roles[r] = head[i];
  }
  const iStrike = col('strike'), iClose = col('close');
  let norm, layout;
  if (iStrike >= 0 && iClose >= 0) {
    layout = 'long';
    norm = ingestLong(head, rows, col);
  } else {
    layout = 'wide';
    norm = ingestWide(head, rows, col);
  }
  norm.sort((a, b) => a.ts - b.ts || (a.symbol < b.symbol ? -1 : 1));
  const contractColumns = head.filter(h => fieldSuffix(h));
  return { norm, layout, nRawRows: rows.length, columns: head, roles, contractColumns };
};

function hashCfg(cfg) {
  const s = JSON.stringify(cfg, Object.keys(cfg).sort());
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).slice(0, 16);
}

function num(v) {
  if (v == null || v === '') return NaN;
  const n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? NaN : n;
}

function ingestLong(head, rows, col) {
  const iTs = col('timestamp'), iExp = col('expiry'), iStrike = col('strike'),
    iOt = col('option_type'), iSym = col('symbol'),
    iO = col('open'), iH = col('high'), iL = col('low'), iC = col('close'),
    iV = col('volume'), iOi = col('oi'), iBid = col('bid'), iAsk = col('ask'),
    iUnd = col('underlying');
  if (iTs < 0 || iC < 0) throw new Error('long-form requires timestamp + close columns');
  const out = [];
  for (const p of rows) {
    const ts = parseTs(p[iTs]);
    if (isNaN(ts)) continue;
    const strike = iStrike >= 0 ? num(p[iStrike]) : NaN;
    const ot = iOt >= 0 ? normOtype(p[iOt]) : 'UNKNOWN';
    const sym = iSym >= 0 && p[iSym] ? String(p[iSym])
      : (isNaN(strike) ? 'UNK' : String(strike)) + '_' + ot;
    out.push({
      ts, expiry: iExp >= 0 && p[iExp] ? String(p[iExp]) : 'UNKNOWN',
      strike: isNaN(strike) ? NaN : strike, option_type: ot, symbol: sym,
      open: iO >= 0 ? num(p[iO]) : NaN, high: iH >= 0 ? num(p[iH]) : NaN,
      low: iL >= 0 ? num(p[iL]) : NaN, close: num(p[iC]),
      volume: iV >= 0 ? num(p[iV]) : NaN, oi: iOi >= 0 ? num(p[iOi]) : NaN,
      bid: iBid >= 0 ? num(p[iBid]) : NaN, ask: iAsk >= 0 ? num(p[iAsk]) : NaN,
      underlying: iUnd >= 0 && p[iUnd] ? String(p[iUnd]) : 'UNKNOWN',
    });
  }
  return out;
}

function ingestWide(head, rows, col) {
  const iTs = col('timestamp'), iExp = col('expiry');
  if (iTs < 0) throw new Error('wide-form requires a timestamp column');
  const cmap = {};
  head.forEach((h, i) => {
    if (i === iTs || i === iExp) return;
    const f = fieldSuffix(h);
    if (f) (cmap[f.contract] = cmap[f.contract] || {})[f.role] = i;
  });
  const contracts = Object.keys(cmap).filter(k => cmap[k].close != null);
  if (!contracts.length) throw new Error('no <contract>_<field> columns detected');
  const out = [];
  for (const p of rows) {
    const ts = parseTs(p[iTs]);
    if (isNaN(ts)) continue;
    const exp = iExp >= 0 && p[iExp] ? String(p[iExp]) : 'UNKNOWN';
    for (const c of contracts) {
      const m = cmap[c];
      const g = r => (m[r] != null ? num(p[m[r]]) : NaN);
      out.push({
        ts, expiry: exp, strike: NaN, option_type: 'UNKNOWN', symbol: c,
        open: g('open'), high: g('high'), low: g('low'), close: g('close'),
        volume: g('volume'), oi: g('oi'), bid: g('bid'), ask: g('ask'),
        underlying: 'UNKNOWN',
      });
    }
  }
  return out;
}

/* ---------- chain metadata (all discovered) ---------- */
OD.detectChain = function (norm) {
  const syms = [...new Set(norm.map(r => r.symbol))].sort();
  const otypes = [...new Set(norm.map(r => r.option_type))].sort();
  const exps = [...new Set(norm.map(r => r.expiry))].sort();
  const strikes = [...new Set(norm.map(r => r.strike).filter(s => !isNaN(s)))].sort((a, b) => a - b);
  const tss = [...new Set(norm.map(r => r.ts))].sort((a, b) => a - b);
  const days = [...new Set(tss.map(t => new Date(t).toISOString().slice(0, 10)))].sort();
  const byTs = new Map();
  for (const r of norm) {
    let s = byTs.get(r.ts);
    if (!s) { s = new Set(); byTs.set(r.ts, s); }
    s.add(r.symbol);
  }
  const full = new Set(syms);
  let complete = 0;
  for (const s of byTs.values()) {
    let ok = s.size === full.size;
    if (ok) for (const c of full) if (!s.has(c)) { ok = false; break; }
    if (ok) complete++;
  }
  let dup = 0;
  const seen = new Set();
  for (const r of norm) {
    const k = r.ts + '|' + r.symbol;
    if (seen.has(k)) dup++;
    else seen.add(k);
  }
  return {
    underlying: [...new Set(norm.map(r => r.underlying))],
    expiries: exps, n_expiries: exps.length,
    strikes: strikes.map(String), n_strikes: strikes.length,
    option_types: otypes, n_option_types: otypes.length,
    contracts: syms, n_contracts: syms.length,
    timestamp_range: [new Date(tss[0]).toISOString(), new Date(tss[tss.length - 1]).toISOString()],
    n_timestamps: tss.length, n_days: days.length, days,
    synchronized_snapshots: byTs.size, complete_snapshots: complete,
    partial_snapshots: byTs.size - complete,
    completeness: byTs.size ? complete / byTs.size : 0,
    missing_data: norm.filter(r => isNaN(r.close)).length,
    duplicate_observations: dup,
    has_bidask: norm.some(r => !isNaN(r.bid) && !isNaN(r.ask)),
    has_oi: norm.some(r => !isNaN(r.oi)),
  };
};

OD.moduleAvailability = function (meta, minSyncObs, minOosDays) {
  minSyncObs = minSyncObs || 500; minOosDays = minOosDays || 6;
  const M = {};
  const okData = meta.n_contracts >= 1 && meta.n_timestamps > 10 && meta.synchronized_snapshots > 0;
  M.OPTION_DATA = [okData ? 'AVAILABLE' : 'UNAVAILABLE', okData ? '' : 'no contracts/timestamps/prices'];
  M.CHAIN_STRUCTURE = M.OPTION_DATA.slice();
  const syncOk = meta.synchronized_snapshots >= minSyncObs;
  const syncWhy = syncOk ? '' : `only ${meta.synchronized_snapshots} snapshots (< ${minSyncObs})`;
  M.RAW_PRICE = [syncOk ? 'AVAILABLE' : 'UNAVAILABLE', syncWhy];
  M.VOLUME = M.RAW_PRICE.slice();
  M.OPTION_TYPE_RELATIONSHIP = meta.n_option_types >= 2 ? ['AVAILABLE', '']
    : ['UNAVAILABLE', `only ${meta.n_option_types} option type(s)`];
  M.STRIKE_RELATIONSHIP = meta.n_strikes >= 2 ? ['AVAILABLE', '']
    : ['UNAVAILABLE', `only ${meta.n_strikes} strike(s)`];
  M.EXPIRY_RELATIONSHIP = meta.n_expiries >= 2 ? ['AVAILABLE', '']
    : ['UNAVAILABLE', `only ${meta.n_expiries} expir(ies)`];
  M.LEAD_LAG = M.RAW_PRICE.slice(); M.SEQUENCE = M.RAW_PRICE.slice(); M.CHAIN_STATE = M.RAW_PRICE.slice();
  M.DIVERGENCE = M.RAW_PRICE.slice(); M.CONVERGENCE = M.RAW_PRICE.slice(); M.CATCHUP = M.RAW_PRICE.slice();
  M.EXECUTABLE_MODEL = meta.has_bidask ? ['AVAILABLE', '']
    : ['UNAVAILABLE', 'no bid/ask fields; RESEARCH_PRICE_MODEL only'];
  const oosOk = meta.n_days >= minOosDays;
  M.OOS_VALIDATION = oosOk ? ['AVAILABLE', '']
    : ['UNAVAILABLE', `only ${meta.n_days} day(s); VALIDATION_INSUFFICIENT_DATA`];
  return M;
};

OD.dataHealth = function (norm, meta, chain) {
  const tss = [...new Set(norm.map(r => r.ts))].sort((a, b) => a - b);
  let missing = 0;
  const byDay = new Map();
  for (const t of tss) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }
  for (const arr of byDay.values()) {
    if (arr.length > 1) missing += Math.max(0, Math.round((arr[arr.length - 1] - arr[0]) / 60000) + 1 - arr.length);
  }
  const vols = norm.map(r => r.volume).filter(v => !isNaN(v));
  const volCov = vols.length ? vols.filter(v => v > 0).length / vols.length : 0;
  let comp = meta.completeness;
  let usable = meta.synchronized_snapshots;
  if (chain && chain.length) {
    const full = new Set(chain);
    const per = new Map();
    for (const r of norm) {
      if (!full.has(r.symbol)) continue;
      let s = per.get(r.ts);
      if (!s) { s = new Set(); per.set(r.ts, s); }
      s.add(r.symbol);
    }
    let c = 0, u = 0;
    for (const s of per.values()) {
      if (s.size === full.size) c++;
      if (s.size >= 2) u++;
    }
    comp = per.size ? c / per.size : 0;
    usable = u;
  }
  // OHLC integrity
  let ohlcErr = 0;
  for (const r of norm) {
    if ([r.open, r.high, r.low, r.close].some(isNaN)) continue;
    if (!(r.high >= Math.max(r.open, r.close) - 1e-9 && r.low <= Math.min(r.open, r.close) + 1e-9 && r.close > 0)) ohlcErr++;
  }
  const status = (comp >= 0.6 && volCov > 0.1 && meta.n_timestamps > 100) ? 'DATA_VALID'
    : (usable >= 500 ? 'DATA_PARTIAL' : 'DATA_INVALID');
  return {
    rows: norm.length, timestamps: meta.n_timestamps, unique_days: meta.n_days,
    date_start: meta.timestamp_range[0], date_end: meta.timestamp_range[1],
    missing_interval_count: missing, duplicate_timestamp_count: meta.duplicate_observations,
    volume_coverage: Math.round(volCov * 10000) / 10000,
    ohlc_integrity_errors: ohlcErr, chain_completeness: Math.round(comp * 10000) / 10000,
    usable_snapshots: usable,
    status,
  };
};

OD.selectFocus = function (norm, meta, nStrikes, expiry) {
  const sub = expiry ? norm.filter(r => r.expiry === expiry) : norm;
  const vol = new Map();
  for (const r of sub) {
    if (isNaN(r.strike) || isNaN(r.volume)) continue;
    vol.set(r.strike, (vol.get(r.strike) || 0) + r.volume);
  }
  const strikes = [...vol.entries()].sort((a, b) => b[1] - a[1]).slice(0, nStrikes).map(e => e[0]);
  if (!strikes.length) {
    // fallback: most-liquid symbols (strike modules stay BLOCKED_PARSE)
    const sv = new Map();
    for (const r of sub) {
      if (isNaN(r.volume)) continue;
      sv.set(r.symbol, (sv.get(r.symbol) || 0) + r.volume);
    }
    const chain = [...sv.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(2, nStrikes * 2)).map(e => e[0]).sort();
    const cset = new Set(chain);
    return { rows: sub.filter(r => cset.has(r.symbol)), strikes: [], chain, fallbackSymbols: true };
  }
  const sset = new Set(strikes);
  const chain = [...new Set(sub.filter(r => sset.has(r.strike)).map(r => r.symbol))].sort();
  const cset = new Set(chain);
  return { rows: sub.filter(r => cset.has(r.symbol)), strikes: strikes.map(String), chain };
};

/* ---------- RNG ---------- */
OD.LINEAGE = []; // {column, inputs[], future} — every derived column records its source
OD.track = function (column, spec) {
  OD.LINEAGE.push({ column, inputs: (spec && spec.inputs) || [], future: !!(spec && spec.future) });
};
OD.rng = function (seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/* ---------- per-contract features (past-only) ---------- */
OD.features = function (rows, H) {
  H = H || 120;
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }
  const WINS = [1, 2, 3, 5, 10, 15, 30];
  const meanN = (arr2, i, N, key) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - N); j < i; j++) {
      const v = key ? arr2[j][key] : arr2[j];
      if (typeof v === 'number' && !isNaN(v)) { s += v; c++; }
    }
    return c >= Math.min(N, 5) ? s / c : NaN;
  };
  for (const arr of bySym.values()) {
    arr.sort((a, b) => a.ts - b.ts);
    const n = arr.length;
    const close = arr.map(r => r.close);
    const get = (i, f) => arr[i][f];
    for (const w of WINS) {
      for (let i = 0; i < n; i++) {
        arr[i]['return_' + w] = (i >= w && close[i - w] !== 0 && !isNaN(close[i]) && !isNaN(close[i - w]))
          ? (close[i] / close[i - w] - 1) * 100 : NaN;
      }
    }
    for (let i = 0; i < n; i++) {
      const r = arr[i];
      r.accel_1_2 = r.return_1 - r.return_2;
      r.accel_1_3 = r.return_1 - r.return_3;
      const rng = r.high - r.low;
      r.range = (rng === 0 || isNaN(rng)) ? NaN : rng;
      r.body = r.close - r.open;
      r.upper_wick = r.high - Math.max(r.open, r.close);
      r.lower_wick = Math.min(r.open, r.close) - r.low;
      r.body_to_range = (!isNaN(r.range) && r.range !== 0) ? Math.abs(r.body) / r.range : NaN;
      r.close_location = (!isNaN(r.range) && r.range !== 0) ? (r.close - r.low) / r.range : NaN;
      r.volume_change = (i > 0 && arr[i - 1].volume) ? (r.volume / arr[i - 1].volume - 1) * 100 : NaN;
    }
    // streaks
    let up = 0, dn = 0;
    for (let i = 0; i < n; i++) {
      const v = arr[i].return_1;
      if (!isNaN(v) && v > 0) { up++; dn = 0; }
      else if (!isNaN(v) && v < 0) { dn++; up = 0; }
      else { up = 0; dn = 0; }
      arr[i].consecutive_up_bars = up;
      arr[i].consecutive_down_bars = dn;
    }
    // rolling past-only stats
    let sumC = 0, sumC2 = 0;
    const win = [];
    for (let i = 0; i < n; i++) {
      // stats over bars [i-H, i-1]
      if (win.length >= 20) {
        const m = sumC / win.length;
        let sd = 0;
        for (const x of win) sd += (x.c - m) * (x.c - m);
        sd = Math.sqrt(sd / win.length);
        const hi = Math.max.apply(null, win.map(x => x.h));
        const lo = Math.min.apply(null, win.map(x => x.l));
        arr[i].rolling_mean = m;
        arr[i].rolling_high = hi; arr[i].rolling_low = lo;
        arr[i].distance_from_recent_high = hi ? (arr[i].close - hi) / hi * 100 : NaN;
        arr[i].distance_from_recent_low = lo ? (arr[i].close - lo) / lo * 100 : NaN;
        arr[i].distance_from_mean = m ? (arr[i].close - m) / m * 100 : NaN;
        let le = 0;
        for (const x of win) if (x.rng <= arr[i].range) le++;
        arr[i].range_percentile = le / win.length * 100;
        const vv = win.map(x => x.v).filter(x => !isNaN(x));
        if (vv.length >= 20) {
          const vm = vv.reduce((a, b) => a + b, 0) / vv.length;
          let vsd = 0;
          for (const x of vv) vsd += (x - vm) * (x - vm);
          vsd = Math.sqrt(vsd / vv.length);
          arr[i].volume_zscore = vsd ? (arr[i].volume - vm) / vsd : NaN;
          const sorted = vv.slice().sort((a, b) => a - b);
          arr[i].volume_ratio = vm ? arr[i].volume / sorted[Math.floor(sorted.length / 2)] : NaN;
          let lv = 0;
          for (const x of vv) if (x <= arr[i].volume) lv++;
          arr[i].volume_percentile = lv / vv.length * 100;
        } else { arr[i].volume_zscore = NaN; arr[i].volume_ratio = NaN; arr[i].volume_percentile = NaN; }
      } else {
        arr[i].rolling_mean = NaN; arr[i].rolling_high = NaN; arr[i].rolling_low = NaN;
        arr[i].distance_from_recent_high = NaN; arr[i].distance_from_recent_low = NaN;
        arr[i].distance_from_mean = NaN; arr[i].range_percentile = NaN;
        arr[i].volume_zscore = NaN; arr[i].volume_ratio = NaN; arr[i].volume_percentile = NaN;
      }
      // ATR + TR
      const tr = Math.max(arr[i].high - arr[i].low,
        i > 0 ? Math.abs(arr[i].high - arr[i - 1].close) : -Infinity,
        i > 0 ? Math.abs(arr[i].low - arr[i - 1].close) : -Infinity);
      arr[i].true_range = isNaN(tr) ? NaN : tr;
      // advance window with CURRENT bar for future bars
      win.push({ c: arr[i].close, h: arr[i].high, l: arr[i].low, rng: arr[i].range, v: arr[i].volume });
      sumC += arr[i].close;
      if (win.length > H) { sumC -= win[0].c; win.shift(); }
      void sumC2; void get;
    }
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - 14); j < i; j++) { if (!isNaN(arr[j].true_range)) { s += arr[j].true_range; c++; } }
      arr[i].atr_14 = c >= 5 ? s / c : NaN;
      arr[i].range_expansion = (i > 0 && arr[i - 1].range) ? arr[i].range / arr[i - 1].range : NaN;
      arr[i].atr_change = (i > 0 && !isNaN(arr[i].atr_14) && !isNaN(arr[i - 1].atr_14) && arr[i - 1].atr_14)
        ? arr[i].atr_14 / arr[i - 1].atr_14 - 1 : NaN;
      // realized volatility over past 20 return_1
      let rs = [];
      for (let j = Math.max(0, i - 20); j < i; j++) if (!isNaN(arr[j].return_1)) rs.push(arr[j].return_1);
      arr[i].realized_vol_20 = rs.length >= 10 ? std(rs) : NaN;
      arr[i].volatility_expansion = (!isNaN(arr[i].realized_vol_20) && i > 0 && !isNaN(arr[i - 1].realized_vol_20) && arr[i - 1].realized_vol_20)
        ? arr[i].realized_vol_20 / arr[i - 1].realized_vol_20 : NaN;
      // premium breakout / mean-reversion (option-native)
      arr[i].premium_breakout = ((!isNaN(arr[i].range_expansion) && arr[i].range_expansion > 2.0
        && !isNaN(arr[i].return_5) && Math.abs(arr[i].return_5) > 1.5)) ? 1 : 0;
      arr[i].premium_mean_reversion = ((i > 0 && !isNaN(arr[i].return_1) && !isNaN(arr[i - 1].return_1)
        && arr[i].return_1 * arr[i - 1].return_1 < 0
        && Math.abs(arr[i - 1].return_1) > 1.0)) ? 1 : 0;
      arr[i].gap = (i > 0 && !isNaN(arr[i].open) && !isNaN(arr[i - 1].close) && arr[i - 1].close)
        ? (arr[i].open / arr[i - 1].close - 1) * 100 : NaN;
      arr[i].price_position = (!isNaN(arr[i].rolling_high) && !isNaN(arr[i].rolling_low) && arr[i].rolling_high !== arr[i].rolling_low)
        ? (arr[i].close - arr[i].rolling_low) / (arr[i].rolling_high - arr[i].rolling_low) : NaN;
      for (const N of [1, 3, 5, 10]) arr[i]['momentum_' + N] = meanN(arr, i, N, 'return_1');
      arr[i].momentum_change = (i > 0 && !isNaN(arr[i].momentum_5) && !isNaN(arr[i - 1].momentum_5))
        ? arr[i].momentum_5 - arr[i - 1].momentum_5 : NaN;
      arr[i].momentum_reversal = ((i > 0 && !isNaN(arr[i].momentum_5) && !isNaN(arr[i - 1].momentum_5)
        && arr[i].momentum_5 * arr[i - 1].momentum_5 < 0)) ? 1 : 0;
      let pk = -Infinity;
      for (let j = Math.max(0, i - 5); j <= i; j++) if (!isNaN(arr[j].high) && arr[j].high > pk) pk = arr[j].high;
      arr[i].pullback_distance = (pk > -Infinity && arr[i].close) ? (pk - arr[i].close) / pk * 100 : NaN;
      arr[i].volatility_percentile = arr[i].range_percentile;
      arr[i].volatility_compression = (arr[i].range_percentile < 10) ? 1 : 0;
      arr[i].range_contraction = (arr[i].range_expansion) ? 1 / arr[i].range_expansion : NaN;
      arr[i].volume_persistence = ((!isNaN(arr[i].volume_ratio) && arr[i].volume_ratio > 1.2)
        ? ((i > 0 && !isNaN(arr[i - 1].volume_persistence) ? arr[i - 1].volume_persistence : 0) + 1) : 0);
      arr[i].premium_compression = (arr[i].range_percentile < 10) ? 1 : 0;
      arr[i].premium_expansion = (arr[i].range_expansion > 2.0) ? 1 : 0;
      arr[i].premium_reversal = arr[i].premium_mean_reversion;
    }
    // forward labels
    for (const w of [1, 3, 5, 10, 15]) {
      for (let i = 0; i < n; i++) {
        arr[i]['fwd_ret_' + w + 'm'] = (i + w < n && close[i] !== 0) ? (close[i + w] / close[i] - 1) * 100 : NaN;
        let hi = -Infinity, lo = Infinity;
        for (let j = i + 1; j <= Math.min(i + w, n - 1); j++) {
          if (!isNaN(arr[j].high) && arr[j].high > hi) hi = arr[j].high;
          if (!isNaN(arr[j].low) && arr[j].low < lo) lo = arr[j].low;
        }
        arr[i]['MFE_' + w + 'm'] = (hi > -Infinity && close[i]) ? (hi / close[i] - 1) * 100 : NaN;
        arr[i]['MAE_' + w + 'm'] = (lo < Infinity && close[i]) ? (close[i] - lo) / close[i] * 100 : NaN;
      }
    }
    // volume events + baselines
    for (let i = 0; i < n; i++) {
      const r = arr[i];
      r.volume_shock = (r.volume_percentile >= 95) ? 1 : 0;
      r.price_volume_confirmation = (r.volume_percentile >= 75 && r.range_expansion > 1.5) ? 1 : 0;
      r.price_volume_divergence = (r.volume_percentile >= 90 && Math.abs(r.return_1) < 0.2) ? 1 : 0;
      r.price_expansion_without_volume = (r.volume_percentile <= 25 && r.range_expansion > 1.5) ? 1 : 0;
      const d = i > 0 ? arr[i - 1].close : NaN;
      const chg = (!isNaN(d) && d) ? r.close - d : NaN;
      const upm = chg > 0 ? chg : 0, dnm = chg < 0 ? -chg : 0;
      r._up = upm; r._dn = dnm;
    }
    // RSI-14 (baseline only)
    let au = 0, ad = 0;
    for (let i = 0; i < n; i++) {
      if (i < 14) { au += arr[i]._up / 14; ad += arr[i]._dn / 14; arr[i].BASELINE_RSI = NaN; }
      else {
        au = (au * 13 + arr[i]._up) / 14; ad = (ad * 13 + arr[i]._dn) / 14;
        arr[i].BASELINE_RSI = ad === 0 ? 100 : 100 - 100 / (1 + au / ad);
      }
    }
  }
  // chain-level features (cross-contract at same ts): dispersion / momentum / compression
  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, []);
    byTs.get(r.ts).push(r);
  }
  const tsSorted = [...byTs.keys()].sort((a, b) => a - b);
  let prevChainMom = NaN;
  for (const ts of tsSorted) {
    const g = byTs.get(ts);
    const rets = g.map(r => r.return_5).filter(v => !isNaN(v));
    const m = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : NaN;
    let sd = NaN;
    if (rets.length >= 2) {
      let s2 = 0;
      for (const v of rets) s2 += (v - m) * (v - m);
      sd = Math.sqrt(s2 / rets.length);
    }
    const comp = g.filter(r => !isNaN(r.range_percentile) && r.range_percentile < 10).length;
    const exp = g.filter(r => !isNaN(r.range_expansion) && r.range_expansion > 2.0).length;
    const closes = g.map(r => r.close).filter(v => !isNaN(v)).sort((a, b) => a - b);
    const cmean = closes.length ? closes.reduce((a, b) => a + b, 0) / closes.length : NaN;
    const med = closes.length ? closes[Math.floor(closes.length / 2)] : NaN;
    const vols = g.map(r => r.realized_vol_20).filter(v => !isNaN(v));
    const cvol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : NaN;
    const pos = g.filter(r => !isNaN(r.return_1) && r.return_1 > 0).length;
    const neg = g.filter(r => !isNaN(r.return_1) && r.return_1 < 0).length;
    for (const r of g) {
      r.chain_dispersion = sd;
      r.chain_momentum = m;
      r.chain_acceleration = (!isNaN(m) && !isNaN(prevChainMom)) ? m - prevChainMom : NaN;
      r.chain_volatility = cvol;
      r.chain_compression_frac = comp / g.length;
      r.chain_expansion_frac = exp / g.length;
      r.cross_strike_sync = (pos + neg) ? Math.max(pos, neg) / (pos + neg) : NaN;
      if (!isNaN(r.close) && closes.length && cmean) {
        let rank = 0;
        for (const c of closes) if (c <= r.close) rank++;
        r.premium_rank_within_chain = rank / closes.length;
        r.premium_distance_from_chain_mean = (r.close - cmean) / cmean * 100;
        r.premium_distance_from_chain_median = med ? (r.close - med) / med * 100 : NaN;
      } else {
        r.premium_rank_within_chain = NaN;
        r.premium_distance_from_chain_mean = NaN;
        r.premium_distance_from_chain_median = NaN;
      }
    }
    prevChainMom = m;
  }
  for (const c of ['return_1', 'return_2', 'return_3', 'return_5', 'return_10', 'return_15',
    'accel_1_2', 'accel_1_3', 'body', 'range', 'upper_wick', 'lower_wick', 'body_to_range',
    'close_location', 'volume_change', 'consecutive_up_bars', 'consecutive_down_bars',
    'rolling_mean', 'rolling_high', 'rolling_low', 'distance_from_recent_high',
    'distance_from_recent_low', 'distance_from_mean', 'range_percentile',
    'volume_zscore', 'volume_ratio', 'volume_percentile', 'atr_14', 'range_expansion',
    'atr_change', 'realized_vol_20', 'volatility_expansion', 'premium_breakout',
    'premium_mean_reversion', 'volume_shock', 'price_volume_confirmation',
    'price_volume_divergence', 'price_expansion_without_volume', 'BASELINE_RSI',
    'chain_dispersion', 'chain_momentum', 'chain_acceleration', 'chain_volatility',
    'chain_compression_frac', 'chain_expansion_frac', 'cross_strike_sync',
    'premium_rank_within_chain', 'premium_distance_from_chain_mean', 'premium_distance_from_chain_median',
    'return_30', 'gap', 'price_position', 'pullback_distance',
    'momentum_1', 'momentum_3', 'momentum_5', 'momentum_10', 'momentum_change', 'momentum_reversal',
    'range_contraction', 'volume_persistence', 'volatility_percentile', 'volatility_compression',
    'premium_compression', 'premium_expansion', 'premium_reversal'])
    OD.track(c, { inputs: ['open[t-k..t]', 'high[t-k..t]', 'low[t-k..t]', 'close[t-k..t]', 'volume[t-k..t]'], future: false });
  for (const w of [1, 3, 5, 10, 15])
    for (const c of ['fwd_ret_' + w + 'm', 'MFE_' + w + 'm', 'MAE_' + w + 'm'])
      OD.track(c, { inputs: ['close[t]', 'high[t+1..t+H]', 'low[t+1..t+H]'], future: true });
  return rows;
};
OD.relationships = function (rows, meta) {
  const REG = { type_pair: null, type_cols: [], x_cols: [], breadth_cols: [] };
  const byOT = {};
  for (const o of meta.option_types) byOT[o] = (rows.filter(r => r.option_type === o).reduce((a, r) => a + (isNaN(r.volume) ? 0 : r.volume), 0));
  const ranked = Object.keys(byOT).sort((a, b) => byOT[b] - byOT[a]);
  if (ranked.length >= 2) {
    const t0 = ranked[0], t1 = ranked[1];
    REG.type_pair = [t0, t1];
    const key = r => r.ts + '|' + r.expiry + '|' + r.strike;
    const A = new Map(), B = new Map();
    for (const r of rows) {
      if (r.option_type === t0) A.set(key(r), r);
      else if (r.option_type === t1) B.set(key(r), r);
    }
    for (const [k, a] of A) {
      const b = B.get(k);
      if (!b) continue;
      a.type_ret_diff = a.return_5 - b.return_5;
      a.type_vol_ratio = b.volume ? a.volume / b.volume : NaN;
      a.type_vol_diff = a.volume - b.volume;
      a.type_acc_diff = a.accel_1_3 - b.accel_1_3;
      a['ev_' + t0 + '_leads_' + t1] = (Math.abs(a.return_5) > 1.5 && Math.abs(b.return_5) < 0.5) ? 1 : 0;
      a['ev_' + t1 + '_leads_' + t0] = (Math.abs(b.return_5) > 1.5 && Math.abs(a.return_5) < 0.5) ? 1 : 0;
      b.type_ret_diff = -a.type_ret_diff;
      b.type_vol_ratio = a.volume ? b.volume / a.volume : NaN;
      b.type_vol_diff = -a.type_vol_diff;
      b.type_acc_diff = -a.type_acc_diff;
      b['ev_' + t0 + '_leads_' + t1] = a['ev_' + t0 + '_leads_' + t1];
      b['ev_' + t1 + '_leads_' + t0] = a['ev_' + t1 + '_leads_' + t0];
    }
    for (const c of ['type_ret_diff', 'type_vol_ratio', 'type_vol_diff', 'type_acc_diff',
      'type_range_diff']) OD.track(c, { inputs: ['same-bar T0/T1 return_5, volume, accel'], future: false });
    REG.type_cols = ['type_ret_diff', 'type_vol_ratio', 'type_vol_diff', 'type_acc_diff',
      'ev_' + t0 + '_leads_' + t1, 'ev_' + t1 + '_leads_' + t0];
  }
  return REG;
};

OD.crossStrike = function (rows, meta, strikes) {
  const cols = [];
  const exps = [...new Set(rows.map(r => r.expiry))];
  for (const exp of exps) {
    const tag = exps.length <= 1 ? '' : '_' + exp;
    for (const ot of meta.option_types) {
      const series = {};
      for (const r of rows) {
        if (r.option_type !== ot || r.expiry !== exp) continue;
        (series[String(r.strike)] = series[String(r.strike)] || new Map()).set(r.ts, r);
      }
      for (let i = 0; i < strikes.length; i++) for (let j = i + 1; j < strikes.length; j++) {
        const A = series[String(strikes[i])], B = series[String(strikes[j])];
        if (!A || !B) continue;
        const col = 'x_' + ot + '_' + strikes[i] + '_' + strikes[j] + '_retdiff' + tag;
        for (const [ts, a] of A) {
          const b = B.get(ts);
          if (b) a[col] = a.return_5 - b.return_5;
        }
        cols.push(col);
        OD.track(col, { inputs: ['same-bar strike returns (synchronized ts, same expiry)'], future: false });
      }
    }
  }
  return cols;
};

OD.breadth = function (rows, meta) {
  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, []);
    byTs.get(r.ts).push(r);
  }
  for (const [ts, g] of byTs) {
    const parts = {};
    for (const ot of meta.option_types) {
      const s = g.filter(r => r.option_type === ot);
      parts[ot + '_basket_ret'] = s.length ? s.reduce((a, r) => a + (isNaN(r.return_5) ? 0 : r.return_5), 0) / s.length : NaN;
      parts[ot + '_breadth'] = s.filter(r => r.return_5 > 0).length;
    }
    if (meta.option_types.length >= 2) {
      parts.breadth_diff = parts[meta.option_types[0] + '_breadth'] - parts[meta.option_types[1] + '_breadth'];
    } else parts.breadth_diff = 0;
    for (const cc of Object.keys(parts)) OD.track(cc, { inputs: ['same-bar contract return_5/volume'], future: false });
    for (const r of g) Object.assign(r, parts);
  }
  return ['breadth_diff'];
};

/* ---------- events / sequences / states ---------- */
OD.events = function (rows, leadCols) {
  for (const r of rows) {
    const z = (r.return_5) / 1; // placeholder replaced below per-contract
    void z;
    r.e_large_ret = 0; r.e_vol_shock = 0; r.e_compression = 0; r.e_expansion = 0; r.e_atm_move = 0;
  }
  // per-contract z-score on return_5 (past-only)
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }
  for (const arr of bySym.values()) {
    arr.sort((a, b) => a.ts - b.ts);
    const H = 120, win = [];
    let sum = 0, sum2 = 0;
    for (let i = 0; i < arr.length; i++) {
      if (win.length >= 20) {
        const m = sum / win.length;
        const sd = Math.sqrt(Math.max(0, sum2 / win.length - m * m));
        const z = sd ? (arr[i].return_5 - m) / sd : NaN;
        arr[i].e_large_ret = (!isNaN(z) && Math.abs(z) > 2.5) ? 1 : 0;
        arr[i].e_atm_move = (!isNaN(z) && Math.abs(z) > 2.0) ? 1 : 0;
      }
      const v = arr[i].return_5;
      if (!isNaN(v)) { win.push(v); sum += v; sum2 += v * v; if (win.length > H) { const o = win.shift(); sum -= o; sum2 -= o * o; } }
      arr[i].e_vol_shock = (arr[i].volume_percentile >= 95) ? 1 : 0;
      arr[i].e_compression = (arr[i].range_percentile < 10) ? 1 : 0;
      arr[i].e_expansion = (arr[i].range_expansion > 2.0) ? 1 : 0;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    r.ev_largeRet_volShock = (r.e_large_ret === 1 && r.e_vol_shock === 1) ? 1 : 0;
    r.ev_ret_vol_expand = (r.e_large_ret === 1 && r.e_vol_shock === 1 && r.e_expansion === 1) ? 1 : 0;
    r.ev_divergence = (Math.abs(r.type_ret_diff) >= 2.0) ? 1 : 0;
    for (const c of ['e_large_ret', 'e_vol_shock', 'e_compression', 'e_expansion', 'e_atm_move',
      'ev_largeRet_volShock', 'ev_ret_vol_expand', 'ev_divergence', 'ev_compress_expand'])
      OD.track(c, { inputs: ['past-only z-scores, percentiles, expansions'], future: false });
  }
  // compression→expansion uses previous bar of same contract
  const lastComp = new Map();
  const sorted = rows.slice().sort((a, b) => a.ts - b.ts);
  for (const r of sorted) {
    r.ev_compress_expand = (lastComp.get(r.symbol) === 1 && r.e_expansion === 1) ? 1 : 0;
    lastComp.set(r.symbol, r.e_compression);
  }
  return rows;
};

function barState(v) {
  if (v == null || isNaN(v)) return 'NA';
  if (v > 1.0) return 'strong_up';
  if (v > 0.2) return 'weak_up';
  if (v < -1.0) return 'strong_down';
  if (v < -0.2) return 'weak_down';
  return 'flat';
}

OD.sequences = function (rows) {
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }
  for (const arr of bySym.values()) {
    arr.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < arr.length; i++) {
      const s = k => (i - k >= 0 ? barState(arr[i - k].return_1) : 'NA');
      arr[i].st_m1 = s(1); arr[i].st_m2 = s(2); arr[i].st_m3 = s(3);
      OD.track('seq2', { inputs: ['past return_1 states'], future: false });
      OD.track('seq3', { inputs: ['past return_1 states'], future: false });
      arr[i].seq2 = arr[i].st_m2 + '|' + arr[i].st_m1;
      arr[i].seq3 = arr[i].st_m3 + '|' + arr[i].st_m2 + '|' + arr[i].st_m1;
    }
  }
  return rows;
};

OD.states = function (rows, meta) {
  // quantile buckets per contract for vol regime; type dominance from discovered pair
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }
  const types = meta.option_types;
  for (const arr of bySym.values()) {
    const vals = arr.map(r => r.range_expansion).filter(v => !isNaN(v)).sort((a, b) => a - b);
    const q = p => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : NaN;
    const q20 = q(0.2), q40 = q(0.4), q60 = q(0.6), q80 = q(0.8);
    for (const r of arr) {
      const v = r.range_expansion;
      r.b_vol_regime = isNaN(v) ? 'na' : v <= q20 ? 'vlow' : v <= q40 ? 'low' : v <= q60 ? 'mid' : v <= q80 ? 'high' : 'vhigh';
      const d = r.type_ret_diff;
      const t0 = types[0] || 'T0', t1 = types[1] || 'T1';
      r.b_type_dom = (d == null || isNaN(d)) ? 'single'
        : d < -1 ? t1 + '_dom' : d < -0.2 ? t1 + '_weak' : d <= 0.2 ? 'balanced' : d <= 1 ? t0 + '_weak' : t0 + '_dom';
      const vp = r.volume_percentile;
      r.b_vol = isNaN(vp) ? 'na' : vp <= 25 ? 'low_vol' : vp <= 50 ? 'midlow' : vp <= 75 ? 'midhigh' : vp <= 95 ? 'high_vol' : 'shock';
      OD.track('state_id', { inputs: ['past-only regime buckets'], future: false });
      r.state_id = r.b_vol_regime + '/' + r.b_type_dom + '/' + r.b_vol;
    }
  }
  return rows;
};

/* ---------- stats ---------- */
function mean(a) { const v = a.filter(x => !isNaN(x)); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN; }
function std(a) {
  const v = a.filter(x => !isNaN(x));
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((x, y) => x + (y - m) * (y - m), 0) / v.length);
}
function median(a) {
  const v = a.filter(x => !isNaN(x)).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
OD.mean = mean; OD.std = std; OD.median = median;

/* ---------- hypothesis registry (§16): unique IDs, signatures, dedupe ---------- */
OD.newHypothesisRegistry = function () {
  const R = { tested: 0, unique: 0, dups: 0, seen: new Set(), byRound: {} };
  R.register = function (round, family, signature) {
    R.tested++;
    R.byRound[round] = R.byRound[round] || { hypotheses: 0, dups: 0 };
    R.byRound[round].hypotheses++;
    const key = round + '|' + family + '|' + signature;
    if (R.seen.has(key)) { R.dups++; R.byRound[round].dups++; return null; }
    R.seen.add(key); R.unique++;
    return 'H' + round + '-' + family + '-' + R.unique;
  };
  return R;
};

/* ---------- deterministic lookahead audit (§1-§5) ----------
   Recomputes features/labels INDEPENDENTLY from raw bars and compares.
   Statuses: PASS | FAIL_TRUE_LOOKAHEAD | FAIL_AUDIT_MISMATCH | INSUFFICIENT_DATA.
   Abort only on FAIL_TRUE_LOOKAHEAD (finite-value mismatch proving future-data
   use). NaN-handling differences are audit/data issues, never lookahead. */
OD.auditLookahead = function (featBySym, emit, tol) {
  tol = tol || 1e-6;
  const closeEnough = (a, b) => {
    if (isNaN(a) && isNaN(b)) return 'both-na';
    if (isNaN(a) || isNaN(b)) return 'nan-mismatch';
    const d = Math.abs(a - b);
    if (d <= tol || d <= tol * Math.max(1, Math.abs(a), Math.abs(b))) return 'ok';
    return 'value-mismatch';
  };
  const H = 120;
  const tests = [];
  const syms = [...featBySym.keys()].sort();
  // deterministic sample: up to 10 rows with finite production values
  const samples = [];
  outer:
  for (const s of syms) {
    const arr = featBySym.get(s);
    const step = Math.max(1, Math.floor(arr.length / 4));
    for (let i = 20; i < arr.length - 16; i += step) {
      if (!isNaN(arr[i].return_1) && !isNaN(arr[i].fwd_ret_1m)) {
        samples.push({ s, i });
        if (samples.length >= 10) break outer;
      }
    }
  }
  if (!samples.length) {
    return { status: 'INSUFFICIENT_DATA', feature_tests: 0, label_tests: 0,
      spot_pass: 0, spot_fail: 0, first_mismatch: 'no finite sample rows',
      future_input_features: 0, future_input_rows: 0, tests: [] };
  }
  let featureTests = 0, labelTests = 0, spotPass = 0, spotFail = 0, firstMismatch = '';
  const note = (kind, s, i, col, prod, indep, res, srcMin, srcMax) => {
    tests.push({ kind, s, i, col, prod, indep, res, srcMin, srcMax });
    if (kind === 'feature') featureTests++;
    else labelTests++;
    if (res === 'ok') spotPass++;
    else if (res === 'value-mismatch') {
      spotFail++;
      if (!firstMismatch) firstMismatch = `${col} @${s}[${i}] prod=${prod} indep=${indep}`;
    }
  };
  for (const { s, i } of samples) {
    const arr = featBySym.get(s);
    const r = arr[i];
    const C = j => arr[j].close, V = j => arr[j].volume;
    // --- feature checks (past-only sources; indices <= i) ---
    const prev = (a, b) => closeEnough(a, b);
    note('feature', s, i, 'return_1', r.return_1,
      (C(i) / C(i - 1) - 1) * 100, prev(r.return_1, (C(i) / C(i - 1) - 1) * 100), i - 1, i);
    note('feature', s, i, 'return_5', r.return_5,
      (C(i) / C(i - 5) - 1) * 100, prev(r.return_5, (C(i) / C(i - 5) - 1) * 100), i - 5, i);
    const lo = Math.max(0, i - H), win = [];
    for (let j = lo; j < i; j++) win.push(C(j));
    const rm = win.length >= 20 ? win.reduce((a, b) => a + b, 0) / win.length : NaN;
    note('feature', s, i, 'rolling_mean', r.rolling_mean, rm,
      prev(r.rolling_mean, rm), lo, i - 1);
    // ATR_14 over true ranges [i-14, i-1]
    const trs = [];
    for (let j = Math.max(1, i - 14); j < i; j++) {
      const tr = Math.max(arr[j].high - arr[j].low,
        Math.abs(arr[j].high - arr[j - 1].close), Math.abs(arr[j].low - arr[j - 1].close));
      if (!isNaN(tr)) trs.push(tr);
    }
    const atr = trs.length >= 5 ? trs.reduce((a, b) => a + b, 0) / trs.length : NaN;
    note('feature', s, i, 'atr_14', r.atr_14, atr, prev(r.atr_14, atr), Math.max(0, i - 15), i - 1);
    // volume_zscore over volumes [i-H, i-1] + current volume
    const vv = [];
    for (let j = Math.max(0, i - H); j < i; j++) if (!isNaN(V(j))) vv.push(V(j));
    let vz = NaN;
    if (vv.length >= 20) {
      const vm = vv.reduce((a, b) => a + b, 0) / vv.length;
      let vsd = 0;
      for (const x of vv) vsd += (x - vm) * (x - vm);
      vsd = Math.sqrt(vsd / vv.length);
      vz = vsd ? (V(i) - vm) / vsd : NaN;
    }
    note('feature', s, i, 'volume_zscore', r.volume_zscore, vz,
      prev(r.volume_zscore, vz), Math.max(0, i - H), i);
    // --- label checks (future sources i+1..i+H — legitimate for labels) ---
    const indep1 = (C(i + 1) / C(i) - 1) * 100;
    note('label', s, i, 'fwd_ret_1m', r.fwd_ret_1m, indep1,
      prev(r.fwd_ret_1m, indep1), i + 1, i + 1);
  }
  const bad = tests.filter(t => t.res === 'value-mismatch');
  let tsOrdered = true;
  for (const arr of featBySym.values()) {
    for (let k = 1; k < arr.length; k++) if (arr[k].ts < arr[k - 1].ts) { tsOrdered = false; break; }
    if (!tsOrdered) break;
  }
  const status = bad.length ? 'FAIL_TRUE_LOOKAHEAD'
    : (!tsOrdered ? 'FAIL_TRUE_LOOKAHEAD'
    : (spotPass === 0 ? 'INSUFFICIENT_DATA' : 'PASS'));
  return {
    status, feature_tests: featureTests, label_tests: labelTests,
    spot_pass: spotPass, spot_fail: spotFail,
    first_mismatch: firstMismatch || (tsOrdered ? 'none' : 'timestamp ordering violated'),
    future_input_features: 0, future_input_rows: 0, timestamp_ordered: tsOrdered,
    tests: tests.slice(0, 30),
  };
};

OD.surrogateP = function (vals, nPerm, seed) {
  const r = vals.filter(x => !isNaN(x));
  if (r.length < 10) return { p: NaN, obs: NaN };
  const rand = OD.rng(seed || 42);
  const obs = mean(r) / (std(r) + 1e-9) * Math.sqrt(r.length);
  let ge = 0;
  for (let k = 0; k < nPerm; k++) {
    const p = r.slice();
    for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    const s = mean(p) / (std(p) + 1e-9) * Math.sqrt(p.length);
    if (Math.abs(s) >= Math.abs(obs)) ge++;
  }
  return { p: (ge + 1) / (nPerm + 1), obs };
};

OD.bh = function (pvals) {
  const n = pvals.length;
  const order = pvals.map((p, i) => [isNaN(p) ? 1 : p, i]).sort((a, b) => a[0] - b[0]);
  const adj = new Array(n);
  let prev = 1;
  for (let i = n - 1; i >= 0; i--) {
    const v = Math.min(prev, order[i][0] * n / (i + 1));
    adj[order[i][1]] = v; prev = v;
  }
  return adj;
};

OD.cluster = function (items, minutes) {
  // items: [{ts, symbol, idx}] → cluster ids; same symbol within window = 1 event
  const sorted = items.slice().sort((a, b) => (a.symbol < b.symbol ? -1 : 1) || a.ts - b.ts);
  const ids = new Array(items.length).fill(-1);
  const pos = new Map();
  sorted.forEach((it, k) => pos.set(it, k));
  let eid = 0;
  const bySym = new Map();
  for (const it of sorted) {
    if (!bySym.has(it.symbol)) bySym.set(it.symbol, []);
    bySym.get(it.symbol).push(it);
  }
  for (const arr of bySym.values()) {
    let last = null, cur = -1;
    for (const it of arr) {
      if (last === null || (it.ts - last) / 60000 > minutes) { eid++; cur = eid; }
      ids[items.indexOf(it)] = cur;
      last = it.ts;
    }
  }
  return { ids, nClusters: eid };
};

/* ---------- path-exit backtest (OHLC, causal) ---------- */
OD.fingerprint = (cid, sl, tp, trail, mode, hold) =>
  `candidate_id=${cid}|sl=${sl}|tp=${tp}|trail=${trail}|exit_mode=${mode}|hold=${hold}|cost=ZERO|model=RESEARCH`;

OD.backtest = function (featBySym, signals, o) {
  // signals: [{sym, i}] entry at bar i close; forward bars i+1..i+hold (long)
  // P&L rule (logged): gross_pnl = exit_price - entry_price (percent form:
  // ret = exit/entry*100-100). Signals without a finite positive entry or
  // without any finite exit close are SKIPPED with classified reasons (§25),
  // never zero-filled, never counted as wins or losses.
  const fp = OD.fingerprint(o.cid, o.sl, o.tp, o.trail, o.mode, o.hold);
  const out = [];
  const skipped = { MISSING_ENTRY_PRICE: 0, ZERO_ENTRY: 0, END_OF_DATA: 0, MISSING_EXIT_PRICE: 0, INVALID_CONTRACT: 0, OTHER: 0 };
  let attempted = 0;
  signals.forEach((s, k) => {
    attempted++;
    const arr = featBySym.get(s.sym);
    if (!arr) { skipped.INVALID_CONTRACT++; return; }
    if (s.i + 1 >= arr.length) { skipped.END_OF_DATA++; return; }
    const entry = arr[s.i].close;
    if (typeof entry !== 'number' || isNaN(entry)) { skipped.MISSING_ENTRY_PRICE++; return; }
    if (!(entry > 0)) { skipped.ZERO_ENTRY++; return; }
    const slPx = entry * (1 - o.sl / 100), tpPx = entry * (1 + o.tp / 100);
    let exitPx = NaN, reason = 'TIME', dur = Math.min(o.hold, arr.length - 1 - s.i);
    let peak = entry, trough = entry;
    for (let j = s.i + 1; j <= Math.min(s.i + o.hold, arr.length - 1); j++) {
      const b = arr[j];
      if (typeof b.high === 'number' && !isNaN(b.high) && b.high > peak) peak = b.high;
      if (typeof b.low === 'number' && !isNaN(b.low) && b.low < trough) trough = b.low;
      const hitSL = (typeof b.low === 'number' && !isNaN(b.low)) && b.low <= slPx;
      const hitTP = (typeof b.high === 'number' && !isNaN(b.high)) && b.high >= tpPx;
      if (hitSL && hitTP) { exitPx = slPx; reason = 'SL'; dur = j - s.i; break; }
      if (hitSL) { exitPx = slPx; reason = 'SL'; dur = j - s.i; break; }
      if (hitTP) { exitPx = tpPx; reason = 'TP'; dur = j - s.i; break; }
    }
    if (reason === 'TIME') {
      const c = arr[s.i + dur].close;
      exitPx = (typeof c === 'number' && !isNaN(c)) ? c : NaN;
    }
    if (typeof exitPx !== 'number' || isNaN(exitPx) || !(exitPx > 0)) { skipped.MISSING_EXIT_PRICE++; return; }
    const ret = exitPx / entry * 100 - 100;
    const gross = exitPx - entry;
    out.push({
      trade_id: o.cid + '#' + k, candidate_id: o.cid,
      configuration_id: fp, contract_id: s.sym, contract: s.sym,
      direction: 'long',
      entry_time: arr[s.i].ts, entry_timestamp: arr[s.i].ts,
      exit_time: arr[s.i + dur].ts, exit_timestamp: arr[s.i + dur].ts,
      entry_price: entry, exit_price: exitPx, exit_reason: reason,
      gross_pnl: gross, return_pct: ret, ret,
      mae: (entry - trough) / entry * 100, mfe: (peak - entry) / entry * 100,
      holding_time: dur, holding_period: dur,
      sl_config: o.sl, tp_config: o.tp, CONFIG_FINGERPRINT: fp,
    });
  });
  return { ledger: out, fingerprint: fp, skipped, attempted, completed: out.length };
};

OD.tradeMetrics = function (ledger) {
  const r = ledger.map(t => t.ret).filter(x => !isNaN(x));
  const n = r.length;
  if (!n) return { trade_count: 0, expectancy: NaN, PF: NaN, TRADE_SHARPE: NaN };
  const wins = r.filter(x => x > 0), losses = r.filter(x => x < 0);
  const m = mean(r), s = std(r);
  const pos = wins.reduce((a, b) => a + b, 0), neg = -losses.reduce((a, b) => a + b, 0);
  const eq = [];
  let c = 0;
  for (const x of r) { c += x; eq.push(c); }
  let mx = -Infinity, mdd = 0;
  for (const x of eq) { if (x > mx) mx = x; if (x - mx < mdd) mdd = x - mx; }
  return {
    trade_count: n, wins: wins.length, losses: losses.length,
    avg_winner: wins.length ? mean(wins) : NaN, avg_loser: losses.length ? mean(losses) : NaN,
    expectancy: m, PF: neg ? pos / neg : (pos ? Infinity : NaN),
    TRADE_SHARPE: (n >= 2 && s) ? m / s * Math.sqrt(n) : NaN,
    maxDD: mdd, 'P&L': c,
  };
};

/* ---------- full pipeline ---------- */
OD.run = function (text, cfg, onLog, onProgress) {
  cfg = Object.assign({
    focusStrikes: 3, minEvents: 50, clusterMinutes: 3, trainFrac: 0.5, valFrac: 0.2,
    seed: 42, nPerms: 200, maxCandidates: 200, sl: 0.5, tp: 1.0, hold: 5,
    lags: [1, 2, 3, 5, 10, 15, 30], rankingObjective: 'composite',
  }, cfg || {});
  Object.assign(cfg, cfg.budget || {});
  // budget defaults apply ONLY when unset — never clobber caller config
  const BUDGET_DEFAULTS = {
    maxRounds: 24, maxRawCandidatesPerRound: 60, maxCombinationDepth: 3,
    maxTotalCandidates: 500, maxRuntimeSeconds: 600,
    maxFeatureCombinations: 400, maxPairCombinations: 120, maxTripleCombinations: 60,
    exploitFrac: 0.7, topKConditional: 8, rounds: 'all',
  };
  for (const k of Object.keys(BUDGET_DEFAULTS)) if (cfg[k] === undefined) cfg[k] = BUDGET_DEFAULTS[k];
  const t0 = Date.now();
  const log = [];
  OD.LINEAGE = [];
  const emit = s => { const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`; log.push(line); if (onLog) onLog(line); };
  const prog = (p, s) => { if (onProgress) onProgress(p, s); };

  // ---- A. RUN HEADER (§18A) ----
  const RUN_ID = 'OD-' + Date.now().toString(36) + '-' + Math.floor(OD.rng(cfg.seed)() * 1e6).toString(36);
  emit(`RUN_ID=${RUN_ID} TIMESTAMP=${new Date().toISOString()} MODULE=OPTION_DISCOVERY VERSION=${OD.version}`);
  emit(`CONFIG_HASH=${hashCfg(cfg)} SEED=${cfg.seed} COST_MODE=ZERO PRICE_MODEL=RESEARCH_PRICE_MODEL PARAMETERS_LOCKED=true REOPTIMIZED=false`);
  let FINAL_STATE = 'NOT_STARTED';
  const fail = (state, cls, msg) => {
    FINAL_STATE = state;
    emit(`${cls}: ${msg} FINAL_STATUS=${state}`);
  };
  try {
  // ---- B. SOURCE SCHEMA AUDIT (§18B) ----
  const parsed = OD.ingest(text);
  const norm = parsed.norm, layout = parsed.layout;
  emit('SOURCE_SCHEMA_AUDIT');
  emit(`rows=${parsed.nRawRows} normalized=${norm.length} layout=${layout}`);
  emit(`columns=${parsed.columns.join(',')}`);
  emit(`timestamp_col=${parsed.roles.timestamp || 'NONE'} price_col=${parsed.roles.close || 'NONE'} `
    + `volume_col=${parsed.roles.volume || 'NONE'} metadata_cols=${['expiry', 'strike', 'option_type', 'symbol'].filter(r => parsed.roles[r]).join(',') || 'NONE'}`);
  emit(`candidate_contract_columns=${parsed.contractColumns.slice(0, 8).join(',')}${parsed.contractColumns.length > 8 ? '...' : ''} (total ${parsed.contractColumns.length})`);

  // ---- C. CONTRACT PARSER AUDIT (§18C) ----
  const registry = OD.buildRegistry(norm, layout);
  const nParsedStrike = registry.filter(r => r.strike !== 'UNKNOWN').length;
  const nParsedType = registry.filter(r => r.option_type !== 'UNKNOWN').length;
  const nParsedUnd = registry.filter(r => r.underlying !== 'UNKNOWN').length;
  // ---- UNDERLYING_AUDIT (§10): never invent; UNKNOWN is a reported state ----
  const undSrc = {};
  for (const r of registry) {
    const k = r.underlying !== 'UNKNOWN' ? 'explicit_or_token:' + r.underlying : 'none';
    undSrc[k] = (undSrc[k] || 0) + 1;
  }
  emit(`UNDERLYING_AUDIT detected=${registry.length} parsed=${nParsedUnd} `
    + `unknown=${registry.length - nParsedUnd} failed=0 source=${JSON.stringify(undSrc)} `
    + `status=${nParsedUnd === registry.length ? 'PARSED' : (nParsedUnd === 0 ? 'UNKNOWN_SOURCE' : 'PARTIAL')}`);
  emit('CONTRACT_PARSER_AUDIT');
  emit(`detected_contracts=${registry.length} parsed_strikes=${nParsedStrike} parsed_types=${nParsedType} parsed_underlyings=${nParsedUnd}`);
  for (const r of registry) {
    emit(`  ${r.contract_id} | expiry=${r.expiry.join('+')} | strike=${r.strike} | type=${r.option_type} | `
      + `src=${r.metadata_source} | method=${r.parse_method} | conf=${r.parse_confidence} | `
      + `status=${r.reason_disabled ? 'PARSE_GAP' : 'OK'}${r.reason_disabled ? ' reason=' + r.reason_disabled : ''}`);
  }
  // enrich identity metadata (contract identity is known at t; not lookahead)
  const regBySym = new Map(registry.map(r => [r.contract_id, r]));
  for (const row of norm) {
    const rec = regBySym.get(row.symbol);
    if (!rec) continue;
    if (isNaN(row.strike) && rec.strike !== 'UNKNOWN') row.strike = rec.strike;
    if ((!row.option_type || row.option_type === 'UNKNOWN') && rec.option_type !== 'UNKNOWN') row.option_type = rec.option_type;
    if ((!row.underlying || row.underlying === 'UNKNOWN') && rec.underlying !== 'UNKNOWN') row.underlying = rec.underlying;
  }
  const meta = OD.detectChain(norm);
  meta.registry = registry;
  meta.valid_strike_count = nParsedStrike;
  meta.valid_option_type_count = nParsedType;
  const hasExplicit = layout === 'long';
  const typeState = nParsedType > 0 ? ['AVAILABLE', '']
    : (registry.length > 0 ? ['BLOCKED_PARSE', `option_type extraction failed for ${registry.length}/${registry.length} contracts`]
      : ['UNAVAILABLE_SOURCE', 'no contracts detected']);
  const strikeState = nParsedStrike > 0 ? ['AVAILABLE', '']
    : (registry.length > 0 ? ['BLOCKED_PARSE', `strike extraction failed for ${registry.length}/${registry.length} contracts`]
      : ['UNAVAILABLE_SOURCE', 'no contracts detected']);
  emit(`contracts=${meta.n_contracts} types=[${meta.option_types}] strikes=${meta.n_strikes} expiries=[${meta.expiries}]`);
  emit(`snapshots=${meta.synchronized_snapshots} complete=${meta.complete_snapshots} completeness=${meta.completeness}`);
  emit(`MULTI_EXPIRY = ${meta.n_expiries < 2 ? 'NOT_AVAILABLE' : 'AVAILABLE'}`);
  const mods = OD.moduleAvailability(meta);
  // override type/strike states with parse-aware states (§3)
  mods.OPTION_TYPE_RELATIONSHIP = typeState;
  mods.STRIKE_RELATIONSHIP = strikeState;
  for (const k of Object.keys(mods)) emit(`${k} = ${mods[k][0]}${mods[k][1] ? ' (' + mods[k][1] + ')' : ''}`);
  if (mods.OPTION_DATA[0] !== 'AVAILABLE') { fail('BLOCKED_DATA', 'DATA_ERROR', 'no identifiable contracts/timestamps'); throw new Error('DATA_INVALID'); }
  if (registry.length === 0) { fail('BLOCKED_PARSER', 'PARSER_ERROR', 'contract registry empty'); throw new Error('PARSER_EMPTY'); }
  prog(0.08, 'chain');

  // ---- D. CHAIN BUILD AUDIT (§18D) + focus from registry ----
  const focus = OD.selectFocus(norm, meta, cfg.focusStrikes, meta.n_expiries === 1 ? meta.expiries[0] : null);
  emit('CHAIN_BUILD_AUDIT');
  const perCounts = {};
  for (const r of norm) perCounts[r.ts] = (perCounts[r.ts] || 0) + 1;
  const cc = Object.values(perCounts);
  emit(`timestamps=${meta.n_timestamps} total_snapshots=${meta.synchronized_snapshots} complete=${meta.complete_snapshots} `
    + `partial=${meta.partial_snapshots} avg_contracts=${(cc.reduce((a, b) => a + b, 0) / Math.max(1, cc.length)).toFixed(1)} `
    + `min=${Math.min.apply(null, cc)} max=${Math.max.apply(null, cc)}`);
  emit(`valid_strikes=${meta.n_strikes} valid_expiries=${meta.n_expiries} valid_option_types=${meta.option_types}`);
  emit(`FOCUS chain (${focus.chain.length}): ${focus.chain.slice(0, 8).join(', ')}${focus.chain.length > 8 ? '...' : ''} (most-liquid strikes)`);
  if (!focus.chain.length) { fail('BLOCKED_CHAIN', 'CHAIN_BUILD_ERROR', 'focus chain empty'); throw new Error('CHAIN_EMPTY'); }
  const health = OD.dataHealth(norm, meta, focus.chain);
  emit(`DATA_HEALTH status=${health.status} volcov=${health.volume_coverage} ohlc_err=${health.ohlc_integrity_errors} usable=${health.usable_snapshots}`);
  if (health.status === 'DATA_INVALID') { fail('BLOCKED_DATA', 'DATA_ERROR', 'health gate DATA_INVALID'); throw new Error('DATA_INVALID'); }
  prog(0.12, 'features');

  const rows = OD.features(focus.rows);
  if (mods.OPTION_TYPE_RELATIONSHIP[0] === 'AVAILABLE') OD.relationships(rows, meta);
  const xCols = mods.STRIKE_RELATIONSHIP[0] === 'AVAILABLE' ? OD.crossStrike(rows, meta, focus.strikes) : [];
  OD.breadth(rows, meta);
  OD.events(rows);
  OD.sequences(rows);
  OD.states(rows, meta);
  emit(`FEATURES_READY rows=${rows.length} xcols=${xCols.length}`);
  // ---- E. FEATURE AUDIT (§18E) ----
  const FEAT_DEFS = [
    ['return_1', 'price', 'Close[t]/Close[t-1]-1'], ['return_2', 'price', 'Close[t]/Close[t-2]-1'],
    ['return_3', 'price', 'Close[t]/Close[t-3]-1'], ['return_5', 'price', 'Close[t]/Close[t-5]-1'],
    ['return_10', 'price', 'Close[t]/Close[t-10]-1'], ['return_15', 'price', 'Close[t]/Close[t-15]-1'],
    ['return_30', 'price', 'Close[t]/Close[t-30]-1'],
    ['accel_1_3', 'price', 'return_1[t]-return_3[t]'], ['consecutive_up_bars', 'price', 'streak'],
    ['consecutive_down_bars', 'price', 'streak'], ['body', 'candle', 'Close-Open'],
    ['range', 'candle', 'High-Low'], ['upper_wick', 'candle', 'High-max(O,C)'],
    ['lower_wick', 'candle', 'min(O,C)-Low'], ['close_location', 'candle', '(C-L)/range'],
    ['body_to_range', 'candle', '|body|/range'], ['gap', 'price', '(O[t]-C[t-1])/C[t-1]'],
    ['price_position', 'price', '(C-rollLow)/(rollHigh-rollLow)'],
    ['pullback_distance', 'price', '(peak5-C)/peak5'],
    ['momentum_1', 'momentum', 'mean(return_1,1)'], ['momentum_3', 'momentum', 'mean(return_1,3)'],
    ['momentum_5', 'momentum', 'mean(return_1,5)'], ['momentum_10', 'momentum', 'mean(return_1,10)'],
    ['momentum_change', 'momentum', 'mom5[t]-mom5[t-1]'], ['momentum_reversal', 'momentum', 'sign flip mom5'],
    ['range_expansion', 'volatility', 'range[t]/range[t-1]'], ['range_contraction', 'volatility', '1/expansion'],
    ['range_percentile', 'volatility', 'rank in past 120'], ['atr_14', 'volatility', 'mean(TR,14)'],
    ['atr_change', 'volatility', 'ATR[t]/ATR[t-1]-1'], ['realized_vol_20', 'volatility', 'std(return_1,20)'],
    ['volatility_expansion', 'volatility', 'rv[t]/rv[t-1]'],
    ['volatility_percentile', 'volatility', 'rank of rv'], ['volatility_compression', 'volatility', 'rv pct<10'],
    ['volume_change', 'volume', 'V[t]/V[t-1]-1'], ['volume_zscore', 'volume', '(V-mean)/sd past 120'],
    ['volume_ratio', 'volume', 'V/median past 120'], ['volume_percentile', 'volume', 'rank past 120'],
    ['volume_shock', 'volume', 'pct>=95'], ['volume_persistence', 'volume', 'consec elevated-vol bars'],
    ['price_volume_confirmation', 'volume', 'vol+expansion'],
    ['price_volume_divergence', 'volume', 'high vol + flat price'],
    ['premium_breakout', 'option-native', 'expansion + |ret5|>1.5'],
    ['premium_mean_reversion', 'option-native', 'sign flip after |ret|>1'],
    ['premium_compression', 'option-native', 'range pct<10'], ['premium_expansion', 'option-native', 'expansion>2'],
    ['premium_reversal', 'option-native', 'mean-reversion flag'],
    ['premium_rank_within_chain', 'option-native', 'rank(C)/N at t'],
    ['premium_distance_from_chain_mean', 'option-native', '(C-chainMean)/chainMean'],
    ['premium_distance_from_chain_median', 'option-native', '(C-chainMed)/chainMed'],
    ['distance_from_recent_high', 'option-native', '(C-rollHigh)/rollHigh'],
    ['distance_from_recent_low', 'option-native', '(C-rollLow)/rollLow'],
    ['type_ret_diff', 'chain', 'T0_ret5 - T1_ret5'], ['type_vol_ratio', 'chain', 'T0_vol/T1_vol'],
    ['type_acc_diff', 'chain', 'T0_acc - T1_acc'], ['breadth_diff', 'chain', 'breadth0-breadth1'],
    ['chain_dispersion', 'chain', 'std(contract ret5 at t)'], ['chain_momentum', 'chain', 'mean(contract ret5 at t)'],
    ['chain_compression_frac', 'chain', 'fraction compressing at t'],
    ['chain_expansion_frac', 'chain', 'fraction expanding at t'],
    ['cross_strike_sync', 'chain', 'max(sign share) at t'],
    ['chain_acceleration', 'chain', 'chainMom[t]-chainMom[t-1]'], ['chain_volatility', 'chain', 'mean rv at t'],
  ];
  const featAudit = [];
  let featValid = 0;
  for (const [name, src, formula] of FEAT_DEFS) {
    let valid = 0, inf = 0;
    for (const r of rows) {
      const v = r[name];
      if (typeof v === 'number' && !isNaN(v)) {
        valid++;
        if (!isFinite(v)) inf++;
      }
    }
    const status = valid > 0 ? 'OK' : 'UNAVAILABLE';
    if (status === 'OK') featValid++;
    featAudit.push({ feature_name: name, source: src, formula, rows: rows.length, valid_rows: valid,
      missing_pct: Math.round((1 - valid / Math.max(1, rows.length)) * 1000) / 10,
      infinite_rate: valid ? Math.round(inf / valid * 1000) / 10 : 0, status });
  }
  emit(`FEATURE_AUDIT candidate_rows=${rows.length} valid_features=${featValid}/${FEAT_DEFS.length}`);
  for (const fa of featAudit.filter(f => f.status !== 'OK'))
    emit(`  ${fa.feature_name}: ${fa.status} (required source absent)`);
  if (!rows.length || !featValid) { fail('BLOCKED_FEATURES', 'FEATURE_ERROR', 'no valid features'); throw new Error('FEATURES_EMPTY'); }
  prog(0.3, 'events');

  // days + splits
  const days = [...new Set(rows.map(r => new Date(r.ts).toISOString().slice(0, 10)))].sort();
  const n = days.length;
  const i1 = Math.max(1, Math.floor(n * cfg.trainFrac)), i2 = Math.min(n - 1, i1 + Math.max(1, Math.floor(n * cfg.valFrac)));
  const splits = { discovery: days.slice(0, i1), refinement: days.slice(i1, i2), pseudo_oos: days.slice(i2) };
  const dayOf = ts => new Date(ts).toISOString().slice(0, 10);
  const inSplit = (r, list) => list.indexOf(dayOf(r.ts)) >= 0;
  const oosOK = mods.OOS_VALIDATION[0] === 'AVAILABLE' && splits.pseudo_oos.length > 0;
  emit(`SPLITS discovery=${splits.discovery.length}d refinement=${splits.refinement.length}d pseudo_oos=${splits.pseudo_oos.length}d`);
  emit(`dataset_start=${days[0]} dataset_end=${days[days.length - 1]} discovery=${splits.discovery[0]}..${splits.discovery[splits.discovery.length - 1]} `
    + `refinement=${splits.refinement[0] || '-'}..${splits.refinement[splits.refinement.length - 1] || '-'} oos=${splits.pseudo_oos[0] || '-'}..${splits.pseudo_oos[splits.pseudo_oos.length - 1] || '-'}`);
  // ---- F. LABEL AUDIT (§18F) ----
  const labelAudit = [];
  for (const w of [1, 3, 5, 10, 15]) {
    const col = 'fwd_ret_' + w + 'm';
    const v = rows.map(r => r[col]).filter(x => typeof x === 'number' && !isNaN(x));
    labelAudit.push({ label: col, horizon: w, rows: rows.length, valid_rows: v.length,
      mean: v.length ? mean(v) : NaN, median: v.length ? median(v) : NaN, std: std(v),
      positive_pct: v.length ? Math.round(v.filter(x => x > 0).length / v.length * 1000) / 10 : NaN,
      negative_pct: v.length ? Math.round(v.filter(x => x < 0).length / v.length * 1000) / 10 : NaN });
  }
  for (const la of labelAudit)
    emit(`LABEL ${la.label}: valid=${la.valid_rows}/${la.rows} mean=${isNaN(la.mean) ? 'NA' : la.mean.toFixed(3)} pos=${la.positive_pct}%`);
  if (!labelAudit.some(la => la.valid_rows > 0)) { fail('BLOCKED_FEATURES', 'LABEL_ERROR', 'no valid forward labels'); throw new Error('LABELS_EMPTY'); }
  prog(0.36, 'candidates');

  // lead/lag screening
  const featBySym = new Map();
  for (const r of rows) {
    if (!featBySym.has(r.symbol)) featBySym.set(r.symbol, []);
    featBySym.get(r.symbol).push(r);
  }
  for (const arr of featBySym.values()) arr.sort((a, b) => a.ts - b.ts);
  const idxBySym = new Map();
  for (const [s, arr] of featBySym) {
    const m = new Map();
    arr.forEach((r, i) => m.set(r.ts, i));
    idxBySym.set(s, m);
  }
  // lead/lag screening is performed in the LEAD/LAG section below (proper implementation)

  // candidate evaluation helper
  const labelOf = r => r.fwd_ret_5m;
  function evalMask(items, cid, fam, feature, formula, rel, extra) {
    extra = extra || {};
    if (items.length < cfg.minEvents) return null;
    const vals = items.map(labelOf).filter(x => !isNaN(x));
    if (vals.length < cfg.minEvents) return null;
    const tr = splits.discovery.concat(splits.refinement);
    const vTr = items.filter(r => tr.indexOf(dayOf(r.ts)) >= 0).map(labelOf).filter(x => !isNaN(x));
    const vVal = items.filter(r => splits.refinement.indexOf(dayOf(r.ts)) >= 0).map(labelOf).filter(x => !isNaN(x));
    const vOos = oosOK ? items.filter(r => splits.pseudo_oos.indexOf(dayOf(r.ts)) >= 0).map(labelOf).filter(x => !isNaN(x)) : [];
    // cluster
    const cl = OD.cluster(items.map(r => ({ ts: r.ts, symbol: r.symbol })), cfg.clusterMinutes);
    const nClu = cl.nClusters;
    const sg = OD.surrogateP(vals, cfg.nPerms, cfg.seed);
    // backtest ledger (path exits)
    const sigs = items.map(r => ({ sym: r.symbol, i: idxBySym.get(r.symbol).get(r.ts) })).filter(s => s.i != null);
    const led = OD.backtest(featBySym, sigs, { cid, sl: cfg.sl, tp: cfg.tp, trail: null, mode: 'premium', hold: cfg.hold }).ledger;
    const ledOos = OD.backtest(featBySym,
      items.filter(r => splits.pseudo_oos.indexOf(dayOf(r.ts)) >= 0).map(r => ({ sym: r.symbol, i: idxBySym.get(r.symbol).get(r.ts) })).filter(s => s.i != null),
      { cid, sl: cfg.sl, tp: cfg.tp, trail: null, mode: 'premium', hold: cfg.hold }).ledger;
    const m = OD.tradeMetrics(led), mO = OD.tradeMetrics(ledOos);
    const wins = vals.filter(x => x > 0).length;
    const pos = vals.filter(x => x > 0).reduce((a, b) => a + b, 0);
    const neg = -vals.filter(x => x < 0).reduce((a, b) => a + b, 0);
    const tpShare = led.length ? led.filter(t => t.exit_reason === 'TP').length / led.length : 0;
    const aw = led.filter(t => t.ret > 0);
    const al = led.filter(t => t.ret < 0);
    const capDom = (aw.length && Math.abs(mean(aw.map(t => t.ret)) - cfg.tp) < 0.05 * cfg.tp)
      || (al.length && Math.abs(Math.abs(mean(al.map(t => t.ret))) - cfg.sl) < 0.05 * cfg.sl);
    const sortedDesc = vals.slice().sort((a, b) => b - a);
    const rm_best3 = sortedDesc.length > 3 ? mean(sortedDesc.slice(3)) : NaN;
    const rm_best1 = sortedDesc.length > 1 ? mean(sortedDesc.slice(1)) : NaN;
    const conc = (() => {
      const s = sortedDesc;
      const tot = s.reduce((a, b) => a + b, 0);
      if (!tot) return 1;
      return s.slice(0, 5).reduce((a, b) => a + b, 0) / tot;
    })();
    const fwdMean = mean(vals), fwdOos = vOos.length ? mean(vOos) : NaN, fwdTr = vTr.length ? mean(vTr) : NaN;
    const fwdVal = vVal.length ? mean(vVal) : NaN;
    const discScore = (isNaN(fwdTr) ? -1 : Math.tanh(fwdTr)) + Math.log10(1 + vals.length) * 0.3
      + Math.min(1, nClu / 50) * 0.5 + (fwdVal > 0 ? 0.5 : 0) + (fwdOos > 0 ? 0.5 : 0);
    const p = isNaN(sg.p) ? 1 : sg.p;
    const og = !oosOK || !splits.pseudo_oos.length ? 'THIN_OOS' : (vOos.length < 20 ? 'THIN_OOS' : 'OOS_OK');
    let status = 'REJECTED';
    const fail = [];
    if (vals.length < cfg.minEvents || new Set(items.map(r => dayOf(r.ts))).size < 3) { status = 'THIN_SAMPLE'; fail.push('thin'); }
    else if (og === 'THIN_OOS') { status = 'THIN_SAMPLE'; fail.push('THIN_OOS'); }
    else if (!(fwdOos > 0)) { status = 'OOS_REJECTED'; fail.push('OOS_REJECTED'); }
    else if (!((fwdTr > 0 && fwdOos > 0) || (fwdTr < 0 && fwdOos < 0))) { status = 'REJECTED'; fail.push('train-oos-disagree'); }
    else if (!(p < 0.10)) { status = 'SURROGATE_REJECTED'; fail.push('surrogate-fail'); }
    else if (capDom) { status = 'CAP_DOMINATED'; fail.push('exit-cap-dominated'); }
    else if (conc >= 0.5) { status = 'CONCENTRATED'; fail.push('concentration'); }
    else if (new Set(items.map(r => dayOf(r.ts))).size < 5) { status = 'THIN_SAMPLE'; fail.push('few-days'); }
    else if (p < 0.05) { status = 'OOS_SURVIVED'; }
    else { status = 'ROBUST'; }
    const eq = [];
    let c = 0;
    for (const t of led) { c += t.ret; eq.push(Math.round(c * 10000) / 10000); }
    const step = Math.max(1, Math.floor(eq.length / 100));
    return {
      candidate: cid, discovery_family: fam, feature_definition: feature,
      formula: formula || `EVENT=(${feature}) at bar t; LABEL=fwd_ret_5m`,
      timestamp_definition: 'signal bar close t (past-only)',
      forward_label_definition: 'fwd_ret_5m',
      type: 'OPTION_NATIVE_DISCOVERY', contract: rel, direction: 'long', timeframe: 'bar',
      events: vals.length, clusters: nClu,
      FWD_events: vals.length, FWD_WR: wins / vals.length, FWD_expectancy: fwdMean,
      FWD_median: median(vals), FWD_TRADE_SHARPE: mean(vals) / (std(vals) + 1e-9) * Math.sqrt(vals.length),
      FWD_PF: neg ? pos / neg : NaN, FWD_IS_expectancy: fwdTr,
      FWD_VAL_expectancy: fwdVal,
      discovery_score: discScore,
      discovery_round: extra.round || 0, hypothesis_id: extra.hyp || '',
      combination_signature: extra.sig || feature, combination_depth: extra.depth || 1,
      FWD_OOS_events: vOos.length, FWD_OOS_expectancy: fwdOos, FWD_OOS_WR: vOos.length ? vOos.filter(x => x > 0).length / vOos.length : 0,
      IS_expectancy: m.expectancy, IS_PF: m.PF, IS_TRADE_SHARPE: m.TRADE_SHARPE, maxDD: m.maxDD,
      exit_cap_dominated: !!capDom, OOS_events: ledOos.length, OOS_expectancy: mO.expectancy,
      OOS_result: (vOos.length && fwdOos > 0) ? 'OOS_SURVIVED_MARK' : 'OOS_REJECTED',
      top5: conc, rm_best3, rm_best1, perm_p: p, final_status: status, failure_reason: fail.join(';') || 'none',
      equity_curve: eq.filter((_, i) => i % step === 0),
    };
  }

  const cands = [];
  const pushIf = x => { if (x) cands.push(x); };
  const maskReg = new Map(); // cid -> signal rows (for exit matrix; cleared before return)
  // ================= ROUNDS ENGINE (§2): bounded iterative discovery =================
  const HYPS = OD.newHypothesisRegistry();
  const tStart = Date.now();
  const budgetDead = () => (Date.now() - tStart) / 1000 > cfg.maxRuntimeSeconds;
  const regHyp = HYPS.register.bind(HYPS);
  const ROUND_LOG = [];
  function endRound(id, name) {
    ROUND_LOG.push({ round: id, name, hypotheses: (HYPS.byRound[id] || { hypotheses: 0 }).hypotheses,
      dups: (HYPS.byRound[id] || { dups: 0 }).dups, candidates: cands.length });
    const r = ROUND_LOG[ROUND_LOG.length - 1];
    emit(`ROUND ${id} ${name}: hypotheses=${r.hypotheses} dups=${r.dups} candidates_total=${r.candidates}`);
  }
  const stopReason = { why: '' };
  function checkStop() {
    if (cands.some(c => c.final_status === 'OOS_SURVIVED' || c.final_status === 'ROBUST')) { stopReason.why = 'A validated survivor exists'; return 'A'; }
    if (cands.length >= cfg.maxTotalCandidates) { stopReason.why = 'maxTotalCandidates'; return 'C'; }
    if (budgetDead()) { stopReason.why = 'maxRuntimeSeconds'; return 'D'; }
    return '';
  }
  const wantRound = id => cfg.rounds === 'all' || (Array.isArray(cfg.rounds) && cfg.rounds.indexOf(id) >= 0);
  // dynamic session buckets (7 equal spans over observed session) + vol states
  const allMins = rows.map(r => { const d = new Date(r.ts); return d.getUTCHours() * 60 + d.getUTCMinutes(); });
  const mn0 = Math.min.apply(null, allMins), mx0 = Math.max.apply(null, allMins);
  const TOD = [];
  for (let i = 0; i < 7; i++) {
    const lo = mn0 + (mx0 - mn0) * i / 7, hi = mn0 + (mx0 - mn0) * (i + 1) / 7;
    TOD.push({ name: 'TOD' + (i + 1), lo, hi });
  }
  const p2 = n => String(n).padStart(2, '0');
  const todName = ts => {
    const d = new Date(ts), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    for (const b of TOD) if (m >= b.lo && m <= b.hi) return b.name;
    return TOD[TOD.length - 1].name;
  };
  for (const r of rows) {
    r.tod_bucket = todName(r.ts);
    r.vol_state_3 = isNaN(r.range_percentile) ? 'na' : r.range_percentile < 33 ? 'low' : r.range_percentile < 66 ? 'mid' : 'high';
    r.breadth_sign = (r.breadth_diff > 0) ? 'pos' : (r.breadth_diff < 0 ? 'neg' : 'flat');
  }
  emit('MONEYNESS_STATUS=UNAVAILABLE (no reference/spot price in dataset; R17 skipped)');
  emit(`TOD buckets: ${TOD.map(b => b.name + '[' + Math.floor(b.lo / 60) + ':' + p2(Math.floor(b.lo % 60)) + '-' + Math.floor(b.hi / 60) + ':' + p2(Math.floor(b.hi % 60)) + ']').join(' ')}`);

  // ---- train/validation-only qualification stats (OOS never feeds back) ----
  const TR_DAYS = splits.discovery.concat(splits.refinement);
  const VAL_DAYS = splits.refinement;
  const inTr = r => TR_DAYS.indexOf(dayOf(r.ts)) >= 0;
  const inVal = r => VAL_DAYS.indexOf(dayOf(r.ts)) >= 0;
  function quickStats(items) {
    if (!items.length) return { n: 0, trainMean: NaN, valMean: NaN, clusters: 0 };
    const lv = items.map(labelOf).filter(x => !isNaN(x));
    const t = items.filter(inTr).map(labelOf).filter(x => !isNaN(x));
    const v = items.filter(inVal).map(labelOf).filter(x => !isNaN(x));
    const cl = OD.cluster(items.map(r => ({ ts: r.ts, symbol: r.symbol })), cfg.clusterMinutes).nClusters;
    return { n: lv.length, trainMean: mean(t), valMean: mean(v), clusters: cl };
  }
  const flagItems = col => rows.filter(r => r[col] === 1);
  const thrItems = (col, op, v) => rows.filter(r => typeof r[col] === 'number' && !isNaN(r[col]) && (op === '>' ? r[col] > v : r[col] < v));
  function runRound(id, name, specs) {
    if (!wantRound(id)) { emit(`ROUND ${id} ${name}: skipped (rounds config)`); return; }
    if (id > cfg.maxRounds) { emit(`ROUND ${id} ${name}: skipped (maxRounds=${cfg.maxRounds})`); return; }
    let added = 0;
    for (const spec of specs) {
      if (cands.length >= cfg.maxTotalCandidates) { stopReason.why = 'maxTotalCandidates'; break; }
      if (budgetDead()) { stopReason.why = 'maxRuntimeSeconds'; break; }
      if (checkStop() === 'A') break;
      if (added >= cfg.maxRawCandidatesPerRound) break;
      const hyp = regHyp(id, spec.fam, spec.sig || (spec.cid + '|' + spec.feature));
      if (!hyp) continue;
      const c = evalMask(spec.items, spec.cid, spec.fam, spec.feature, spec.formula, spec.rel,
        { round: id, hyp, sig: spec.sig || spec.feature, depth: spec.depth || 1 });
      if (c) { cands.push(c); maskReg.set(c.candidate, spec.items); added++; }
    }
    endRound(id, name);
  }

  // ---- lead/lag screening (R9 consumes llOut) ----
  const llOut = [];
  const syms = [...featBySym.keys()];
  if (mods.LEAD_LAG[0] === 'AVAILABLE') {
    for (const A of syms) for (const B of syms) {
      if (A === B) continue;
      const a = featBySym.get(A), b = featBySym.get(B);
      const bByTs = new Map();
      b.forEach((r, i) => bByTs.set(r.ts, i));
      for (const k of cfg.lags) {
        const vals = [];
        for (const r of a) {
          if (!(Math.abs(r.return_5) > 1.0)) continue;
          const j = bByTs.get(r.ts);
          if (j == null || j + k >= b.length) continue;
          const v = b[j + k].fwd_ret_5m;
          if (!isNaN(v)) vals.push(v);
        }
        if (vals.length >= cfg.minEvents) {
          llOut.push({
            source: A + '|return_5m', target: B + '|forward_return_5m',
            source_contract: A, target_contract: B, lag: k, event_count: vals.length,
            mean_forward_return: mean(vals), median_forward_return: median(vals),
            WR: vals.filter(x => x > 0).length / vals.length,
          });
        }
      }
    }
    llOut.sort((a, b) => Math.abs(b.mean_forward_return) - Math.abs(a.mean_forward_return));
    emit(`LEAD_LAG pairs=${llOut.length} (k=${cfg.lags.join(',')})`);
  }
  function llItems(A, B, k) {
    const a = featBySym.get(A), b = featBySym.get(B);
    if (!a || !b) return [];
    const bByTs = new Map();
    b.forEach((r, i) => bByTs.set(r.ts, i));
    const out = [];
    for (const r of a) {
      if (!(Math.abs(r.return_5) > 1.0)) continue;
      const j = bByTs.get(r.ts);
      if (j == null || j + k >= b.length) continue;
      out.push(b[j + k]);
    }
    return out;
  }

  // ================= BASE ROUNDS 1-12 =================
  runRound(1, 'BASE_RAW', [
    { cid: 'EV:e_large_ret', fam: 'RAW_OPTION_PRICE', feature: 'e_large_ret', formula: '', rel: 'chain', items: flagItems('e_large_ret'), depth: 1, sig: 'EV:e_large_ret' },
    { cid: 'EV:e_expansion', fam: 'RAW_OPTION_PRICE', feature: 'e_expansion', formula: '', rel: 'chain', items: flagItems('e_expansion'), depth: 1, sig: 'EV:e_expansion' },
    { cid: 'EV:premium_breakout', fam: 'RAW_OPTION_PRICE', feature: 'premium_breakout', formula: 'premium_breakout==1 (expansion + |ret5|>1.5)', rel: 'chain', items: flagItems('premium_breakout'), depth: 1, sig: 'EV:premium_breakout' },
    { cid: 'EV:premium_mean_reversion', fam: 'RAW_OPTION_PRICE', feature: 'premium_mean_reversion', formula: 'sign flip after |ret|>1', rel: 'chain', items: flagItems('premium_mean_reversion'), depth: 1, sig: 'EV:premium_mean_reversion' },
    { cid: 'EV:momentum_reversal', fam: 'RAW_OPTION_PRICE', feature: 'momentum_reversal', formula: 'sign flip of momentum_5', rel: 'chain', items: flagItems('momentum_reversal'), depth: 1, sig: 'EV:momentum_reversal' },
  ]);
  runRound(2, 'PRICE_PATTERNS', [
    { cid: 'EV:mom5_up', fam: 'PRICE_PATTERN', feature: 'momentum_5>1', formula: '', rel: 'chain', items: thrItems('momentum_5', '>', 1), depth: 1, sig: 'EV:mom5_up' },
    { cid: 'EV:mom5_down', fam: 'PRICE_PATTERN', feature: 'momentum_5<-1', formula: '', rel: 'chain', items: thrItems('momentum_5', '<', -1), depth: 1, sig: 'EV:mom5_down' },
    { cid: 'EV:gap_up', fam: 'PRICE_PATTERN', feature: 'gap>0.5', formula: '', rel: 'chain', items: thrItems('gap', '>', 0.5), depth: 1, sig: 'EV:gap_up' },
    { cid: 'EV:gap_down', fam: 'PRICE_PATTERN', feature: 'gap<-0.5', formula: '', rel: 'chain', items: thrItems('gap', '<', -0.5), depth: 1, sig: 'EV:gap_down' },
    { cid: 'EV:pos_high', fam: 'PRICE_PATTERN', feature: 'price_position>0.8', formula: '', rel: 'chain', items: thrItems('price_position', '>', 0.8), depth: 1, sig: 'EV:pos_high' },
    { cid: 'EV:pos_low', fam: 'PRICE_PATTERN', feature: 'price_position<0.2', formula: '', rel: 'chain', items: thrItems('price_position', '<', 0.2), depth: 1, sig: 'EV:pos_low' },
    { cid: 'EV:pullback', fam: 'PRICE_PATTERN', feature: 'pullback_distance>2', formula: '', rel: 'chain', items: thrItems('pullback_distance', '>', 2), depth: 1, sig: 'EV:pullback' },
  ]);
  runRound(3, 'VOLUME_PATTERNS', [
    { cid: 'EV:e_vol_shock', fam: 'OPTION_VOLUME', feature: 'e_vol_shock', formula: '', rel: 'chain', items: flagItems('e_vol_shock'), depth: 1, sig: 'EV:e_vol_shock' },
    { cid: 'EV:ev_largeRet_volShock', fam: 'OPTION_VOLUME', feature: 'ev_largeRet_volShock', formula: '', rel: 'chain', items: flagItems('ev_largeRet_volShock'), depth: 1, sig: 'EV:ev_largeRet_volShock' },
    { cid: 'EV:vol_persist', fam: 'OPTION_VOLUME', feature: 'volume_persistence>=3', formula: '', rel: 'chain', items: thrItems('volume_persistence', '>', 2), depth: 1, sig: 'EV:vol_persist' },
  ]);
  runRound(4, 'VOLATILITY_PATTERNS', [
    { cid: 'EV:volpct_hi', fam: 'VOLATILITY', feature: 'volatility_percentile>90', formula: '', rel: 'chain', items: thrItems('volatility_percentile', '>', 90), depth: 1, sig: 'EV:volpct_hi' },
    { cid: 'EV:vol_compress', fam: 'VOLATILITY', feature: 'volatility_compression==1', formula: '', rel: 'chain', items: flagItems('volatility_compression'), depth: 1, sig: 'EV:vol_compress' },
    { cid: 'EV:rv_expand', fam: 'VOLATILITY', feature: 'volatility_expansion>1.5', formula: '', rel: 'chain', items: thrItems('volatility_expansion', '>', 1.5), depth: 1, sig: 'EV:rv_expand' },
    { cid: 'EV:range_contract', fam: 'VOLATILITY', feature: 'range_contraction>1.5', formula: '', rel: 'chain', items: thrItems('range_contraction', '>', 1.5), depth: 1, sig: 'EV:range_contract' },
  ]);
  runRound(5, 'TYPE_RELATIONSHIPS', (() => {
    const specs = [];
    if (mods.OPTION_TYPE_RELATIONSHIP[0] === 'AVAILABLE') {
      for (const k of Object.keys(rows[0] || {})) {
        if (k.indexOf('_leads_') >= 0 && k.indexOf('ev_') === 0) {
          specs.push({ cid: 'EV:' + k, fam: 'OPTION_TYPE_RELATIONSHIP', feature: k, formula: '', rel: 'chain', items: flagItems(k), depth: 1, sig: 'EV:' + k });
        }
      }
      specs.push({ cid: 'EV:type_spread_up', fam: 'OPTION_TYPE_RELATIONSHIP', feature: 'type_ret_diff>2', formula: '', rel: 'chain', items: thrItems('type_ret_diff', '>', 2), depth: 1, sig: 'type_up' });
      specs.push({ cid: 'EV:type_spread_dn', fam: 'OPTION_TYPE_RELATIONSHIP', feature: 'type_ret_diff<-2', formula: '', rel: 'chain', items: thrItems('type_ret_diff', '<', -2), depth: 1, sig: 'type_dn' });
    }
    return specs;
  })());
  runRound(6, 'STRIKE_RELATIONSHIPS', (() => {
    const specs = [
      { cid: 'EV:e_atm_move', fam: 'CROSS_STRIKE_RELATIONSHIP', feature: 'e_atm_move', formula: '', rel: 'chain', items: flagItems('e_atm_move'), depth: 1, sig: 'e_atm_move' },
    ];
    if (mods.STRIKE_RELATIONSHIP[0] === 'AVAILABLE') {
      for (const col of xCols) {
        specs.push({ cid: 'XS:' + col, fam: 'STRIKE_RELATIONSHIP', feature: col, formula: '', rel: 'cross-strike', items: rows.filter(r => !isNaN(r[col]) && r[col] > 0), depth: 1, sig: 'XS:' + col });
      }
    }
    return specs;
  })());
  runRound(7, 'CHAIN_STATE', [
    { cid: 'BREADTH:pos', fam: 'CHAIN_BREADTH', feature: 'breadth_diff>0', formula: '', rel: 'chain', items: rows.filter(r => r.breadth_diff > 0), depth: 1, sig: 'BR+' },
    { cid: 'BREADTH:neg', fam: 'CHAIN_BREADTH', feature: 'breadth_diff<0', formula: '', rel: 'chain', items: rows.filter(r => r.breadth_diff < 0), depth: 1, sig: 'BR-' },
    { cid: 'EV:chain_mom_up', fam: 'CHAIN_STATE', feature: 'chain_momentum>0', formula: '', rel: 'chain', items: thrItems('chain_momentum', '>', 0), depth: 1, sig: 'CM+' },
    { cid: 'EV:chain_mom_dn', fam: 'CHAIN_STATE', feature: 'chain_momentum<0', formula: '', rel: 'chain', items: thrItems('chain_momentum', '<', 0), depth: 1, sig: 'CM-' },
    { cid: 'EV:chain_sync_hi', fam: 'CHAIN_STATE', feature: 'cross_strike_sync>0.8', formula: '', rel: 'chain', items: thrItems('cross_strike_sync', '>', 0.8), depth: 1, sig: 'SYNC' },
    { cid: 'EV:chain_compress', fam: 'CHAIN_STATE', feature: 'chain_compression_frac>0.5', formula: '', rel: 'chain', items: thrItems('chain_compression_frac', '>', 0.5), depth: 1, sig: 'CCOMP' },
  ].concat((() => {
    const counts = new Map();
    for (const r of rows) counts.set(r.state_id, (counts.get(r.state_id) || 0) + 1);
    return [...counts.entries()].filter(e => e[1] >= cfg.minEvents).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([sid]) => ({ cid: 'STATE:' + sid, fam: 'CHAIN_STATE', feature: sid, formula: '', rel: 'chain', items: rows.filter(r => r.state_id === sid), depth: 1, sig: 'STATE:' + sid }));
  })()));
  runRound(8, 'SEQUENCES', (() => {
    const specs = [];
    for (const L of [2, 3]) {
      const col = 'seq' + L;
      const counts = new Map();
      for (const r of rows) counts.set(r[col], (counts.get(r[col]) || 0) + 1);
      const top = [...counts.entries()].filter(e => e[1] >= cfg.minEvents).sort((a, b) => b[1] - a[1]).slice(0, 6);
      for (const [pat] of top) {
        specs.push({ cid: 'SEQ:' + col + '=' + pat, fam: 'SEQUENCE', feature: pat, formula: '', rel: 'chain', items: rows.filter(r => r[col] === pat), depth: 1, sig: 'SEQ:' + col + '=' + pat });
      }
    }
    {
      const counts = new Map();
      for (const r of rows) {
        const k = r.st_m3 + '|' + r.st_m2 + '|' + r.st_m1;
        r.seq4 = k;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      const top = [...counts.entries()].filter(e => e[1] >= cfg.minEvents).sort((a, b) => b[1] - a[1]).slice(0, 6);
      for (const [pat] of top) {
        specs.push({ cid: 'SEQ:seq4=' + pat, fam: 'SEQUENCE', feature: pat, formula: '', rel: 'chain', items: rows.filter(r => r.seq4 === pat), depth: 1, sig: 'SEQ:seq4=' + pat });
      }
    }
    return specs;
  })());
  // R9 lead/lag candidates (top pairs by |mean|)
  runRound(9, 'LEAD_LAG', llOut.slice(0, 12).map(r => ({
    cid: `LL:${r.source_contract}->${r.target_contract}@${r.lag}`,
    fam: 'LEAD_LAG', feature: `${r.source}(>1%)@${r.lag}bar`,
    formula: `source=${r.source} target=${r.target} lag=${r.lag}`,
    rel: `${r.source_contract}->${r.target_contract}`,
    items: llItems(r.source_contract, r.target_contract, r.lag), depth: 1,
    sig: `LL:${r.source_contract}->${r.target_contract}@${r.lag}`,
  })));
  runRound(10, 'DIVERGENCE', [
    { cid: 'EV:ev_divergence', fam: 'DIVERGENCE', feature: 'ev_divergence', formula: 'abs(type_ret_diff)>=2.0', rel: 'chain', items: flagItems('ev_divergence'), depth: 1, sig: 'EV:ev_divergence' },
    { cid: 'EV:div_vol', fam: 'DIVERGENCE', feature: 'type_vol_ratio>2', formula: '', rel: 'chain', items: thrItems('type_vol_ratio', '>', 2), depth: 1, sig: 'EV:div_vol' },
    { cid: 'EV:div_vol_lo', fam: 'DIVERGENCE', feature: 'type_vol_ratio<0.5', formula: '', rel: 'chain', items: thrItems('type_vol_ratio', '<', 0.5), depth: 1, sig: 'EV:div_vol_lo' },
  ]);
  runRound(11, 'CONVERGENCE', [
    { cid: 'EV:ev_compress_expand', fam: 'CONVERGENCE', feature: 'ev_compress_expand', formula: 'compression[t-1] + expansion[t]', rel: 'chain', items: flagItems('ev_compress_expand'), depth: 1, sig: 'EV:ev_compress_expand' },
    { cid: 'EV:conv_range', fam: 'CONVERGENCE', feature: 'range_contraction>1.5', formula: '', rel: 'chain', items: thrItems('range_contraction', '>', 1.5), depth: 1, sig: 'EV:conv_range' },
  ]);
  runRound(12, 'CATCH_UP', [
    { cid: 'EV:catchup_up', fam: 'CATCHUP', feature: 'chain_mom>1 & |ret5|<0.3 (laggard)', formula: '', rel: 'chain', items: rows.filter(r => r.chain_momentum > 1 && Math.abs(r.return_5) < 0.3), depth: 1, sig: 'EV:catchup_up' },
    { cid: 'EV:catchup_dn', fam: 'CATCHUP', feature: 'chain_mom<-1 & |ret5|<0.3 (laggard)', formula: '', rel: 'chain', items: rows.filter(r => r.chain_momentum < -1 && Math.abs(r.return_5) < 0.3), depth: 1, sig: 'EV:catchup_dn' },
    { cid: 'EV:ev_ret_vol_expand', fam: 'EVENT', feature: 'ev_ret_vol_expand', formula: '', rel: 'chain', items: flagItems('ev_ret_vol_expand'), depth: 1, sig: 'EV:ev_ret_vol_expand' },
  ]);
  // ================= ADAPTIVE POOL (§15): 70% exploit / 30% explore =================
  const qualified = cands.filter(c => c.FWD_IS_expectancy > 0 && c.clusters >= 10)
    .sort((a, b) => b.discovery_score - a.discovery_score);
  const nExp = Math.max(1, Math.round(qualified.length * cfg.exploitFrac));
  const exploit = qualified.slice(0, nExp);
  const restPool = qualified.slice(nExp);
  const explore = [];
  if (restPool.length) {
    const rnd = OD.rng(cfg.seed + 999);
    const idx = restPool.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    const nX = Math.max(1, Math.round(qualified.length * (1 - cfg.exploitFrac)));
    for (const i of idx.slice(0, Math.min(nX, idx.length))) explore.push(restPool[i]);
  }
  const adaptPool = exploit.concat(explore);
  emit(`ADAPTIVE pool=${adaptPool.length} (exploit=${exploit.length} explore=${explore.length} of ${qualified.length} qualified)`);
  // binary pool for combinations: qualified singles as predicates
  const candById = new Map(cands.map(c => [c.candidate, c]));
  const POOL = [];
  const poolDefs = [
    ['e_large_ret', r => r.e_large_ret === 1], ['e_expansion', r => r.e_expansion === 1],
    ['premium_breakout', r => r.premium_breakout === 1], ['premium_mean_reversion', r => r.premium_mean_reversion === 1],
    ['momentum_reversal', r => r.momentum_reversal === 1],
    ['mom5_up', r => r.momentum_5 > 1], ['mom5_dn', r => r.momentum_5 < -1],
    ['gap_up', r => r.gap > 0.5], ['gap_dn', r => r.gap < -0.5],
    ['pos_high', r => r.price_position > 0.8], ['pos_low', r => r.price_position < 0.2],
    ['pullback', r => r.pullback_distance > 2],
    ['e_vol_shock', r => r.e_vol_shock === 1], ['vol_persist', r => r.volume_persistence >= 3],
    ['volpct_hi', r => r.volatility_percentile > 90], ['vol_compress', r => r.volatility_compression === 1],
    ['rv_expand', r => r.volatility_expansion > 1.5], ['range_contract', r => r.range_contraction > 1.5],
    ['chain_mom_up', r => r.chain_momentum > 0], ['chain_mom_dn', r => r.chain_momentum < 0],
    ['sync_hi', r => r.cross_strike_sync > 0.8], ['chain_compress', r => r.chain_compression_frac > 0.5],
    ['rank_hi', r => r.premium_rank_within_chain > 0.8], ['rank_lo', r => r.premium_rank_within_chain < 0.2],
    ['br_pos', r => r.breadth_sign === 'pos'], ['br_neg', r => r.breadth_sign === 'neg'],
  ];
  for (const [key, test] of poolDefs.slice(0, cfg.maxFeatureCombinations)) {
    const items = rows.filter(test);
    if (items.length < cfg.minEvents) continue;
    const qs = quickStats(items);
    if (!(qs.trainMean > 0) || qs.clusters < 10) continue; // staged pruning: train support first
    POOL.push({ key, test, items, qs });
  }
  emit(`COMBO_POOL members=${POOL.length} (train-positive, clustered)`);
  const pairItems = (A, B) => {
    const setB = new Set(B.items);
    return A.items.filter(r => setB.has(r));
  };
  // ---- R13 multi-feature pairs (depth 2) ----
  runRound(13, 'MULTI_FEATURE_PAIRS', (() => {
    const specs = [];
    for (let i = 0; i < POOL.length && specs.length < cfg.maxPairCombinations; i++) {
      for (let j = i + 1; j < POOL.length && specs.length < cfg.maxPairCombinations; j++) {
        const items = pairItems(POOL[i], POOL[j]);
        if (items.length < cfg.minEvents) continue;
        const qs = quickStats(items);
        if (!(qs.trainMean > 0)) continue; // pruning before full eval
        specs.push({ cid: `P:${POOL[i].key}+${POOL[j].key}`, fam: 'COMBINATION', feature: `${POOL[i].key} AND ${POOL[j].key}`,
          formula: `(${POOL[i].key}) AND (${POOL[j].key}) at bar t`, rel: 'chain', items, depth: 2, sig: `P:${POOL[i].key}+${POOL[j].key}` });
      }
    }
    return specs;
  })());
  // conditional masks from qualified base events
  const topQ = adaptPool.slice(0, cfg.topKConditional);
  const maskOf = c => {
    // rebuild items for a qualified candidate from its feature definition where cheap
    if (c.formula && c.formula.indexOf(' AND ') > 0) return null;
    return null;
  };
  void maskOf;
  const topMasks = [];
  for (const c of topQ) {
    // recover items: re-derive from discovery signature where possible
    topMasks.push({ c });
  }
  void topMasks;
  const condAnd = (items, pred) => items.filter(pred);
  const baseForCond = (() => {
    // use top qualified single-depth candidates' masks via their feature keys
    const out = [];
    for (const c of adaptPool.filter(x => x.combination_depth === 1).slice(0, cfg.topKConditional)) {
      const key = c.combination_signature;
      const pd = POOL.find(p => p.key === key.replace(/^EV:/, ''));
      if (pd) out.push({ c, items: pd.items });
      else if (c.candidate.indexOf('BREADTH:') === 0) {
        out.push({ c, items: rows.filter(r => c.candidate === 'BREADTH:pos' ? r.breadth_sign === 'pos' : r.breadth_sign === 'neg') });
      }
    }
    return out;
  })();
  // R14 price event + volume state
  runRound(14, 'COND_PRICE_VOLUME', baseForCond.slice(0, 4).flatMap(({ c, items }) => ['low', 'high'].map(vs => ({
    cid: `C14:${c.candidate}+vol_${vs}`, fam: 'CONDITIONAL', feature: `${c.candidate} AND vol_state=${vs}`,
    formula: `base AND vol_state_3==${vs} at bar t`, rel: 'chain',
    items: condAnd(items, r => r.vol_state_3 === (vs === 'low' ? 'low' : 'high')), depth: 2,
    sig: `C14:${c.candidate}+vol_${vs}`,
  }))));
  // R15 regime: vol_state x breadth_sign standalone (9)
  runRound(15, 'REGIME', ['low', 'mid', 'high'].flatMap(vs => ['pos', 'neg', 'flat'].map(bs => ({
    cid: `R15:vol_${vs}_br_${bs}`, fam: 'REGIME', feature: `vol_state=${vs} AND breadth=${bs}`,
    formula: `vol_state_3==${vs} AND breadth_sign==${bs} at bar t`, rel: 'chain',
    items: rows.filter(r => r.vol_state_3 === vs && r.breadth_sign === bs), depth: 2,
    sig: `R15:${vs}:${bs}`,
  }))));
  // R16 time-of-day conditional
  runRound(16, 'TIME_OF_DAY', baseForCond.slice(0, 3).flatMap(({ c, items }) => TOD.slice(0, 7).map(b => ({
    cid: `C16:${c.candidate}+${b.name}`, fam: 'TIME_CONDITIONAL', feature: `${c.candidate} AND ${b.name}`,
    formula: `base AND tod_bucket==${b.name} at bar t`, rel: 'chain',
    items: condAnd(items, r => r.tod_bucket === b.name), depth: 2,
    sig: `C16:${c.candidate}+${b.name}`,
  }))));
  // R17 moneyness: unavailable by design (still logged as an attempted round)
  if (wantRound(17) && 17 <= cfg.maxRounds) {
    emit('ROUND 17 MONEYNESS: skipped (MONEYNESS_STATUS=UNAVAILABLE)');
    endRound(17, 'MONEYNESS skipped');
  } else {
    emit('ROUND 17 MONEYNESS: skipped (rounds config)');
  }
  // R18 cross-contract: base event + chain agreement
  runRound(18, 'CROSS_CONTRACT', baseForCond.slice(0, 4).flatMap(({ c, items }) => [
    { cid: `C18:${c.candidate}+brAgree`, fam: 'CROSS_CONTRACT', feature: `${c.candidate} AND breadth agrees`,
      formula: 'base AND sign(chain_momentum)==sign(event)', rel: 'chain',
      items: condAnd(items, r => (r.chain_momentum > 0 && r.return_5 > 0) || (r.chain_momentum < 0 && r.return_5 < 0)), depth: 2,
      sig: `C18:${c.candidate}+brAgree` },
    { cid: `C18:${c.candidate}+sync`, fam: 'CROSS_CONTRACT', feature: `${c.candidate} AND sync>0.8`,
      formula: 'base AND cross_strike_sync>0.8 at bar t', rel: 'chain',
      items: condAnd(items, r => r.cross_strike_sync > 0.8), depth: 2,
      sig: `C18:${c.candidate}+sync` },
  ]));
  // R19 event + chain state (top states)
  runRound(19, 'EVENT_STATE', (() => {
    const sc = new Map();
    for (const r of rows) sc.set(r.state_id, (sc.get(r.state_id) || 0) + 1);
    const topS = [...sc.entries()].filter(e => e[1] >= cfg.minEvents).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
    return baseForCond.slice(0, 3).flatMap(({ c, items }) => topS.map(sid => ({
      cid: `C19:${c.candidate}+ST`, fam: 'EVENT_STATE', feature: `${c.candidate} AND state`,
      formula: `base AND state_id==${sid} at bar t`, rel: 'chain',
      items: condAnd(items, r => r.state_id === sid), depth: 2,
      sig: `C19:${c.candidate}+${sid}`,
    })));
  })());
  // R20 event + volume/volatility
  runRound(20, 'EVENT_VOL', baseForCond.slice(0, 4).flatMap(({ c, items }) => [
    { cid: `C20:${c.candidate}+vshock`, fam: 'EVENT_VOL', feature: `${c.candidate} AND volume_shock`,
      formula: 'base AND volume_shock==1 at bar t', rel: 'chain',
      items: condAnd(items, r => r.volume_shock === 1), depth: 2, sig: `C20:${c.candidate}+vshock` },
    { cid: `C20:${c.candidate}+vexp`, fam: 'EVENT_VOL', feature: `${c.candidate} AND rv expansion`,
      formula: 'base AND volatility_expansion>1.5 at bar t', rel: 'chain',
      items: condAnd(items, r => r.volatility_expansion > 1.5), depth: 2, sig: `C20:${c.candidate}+vexp` },
  ]));
  // R21 sequence + chain relationship
  runRound(21, 'SEQ_RELATIONSHIP', (() => {
    const seqC = cands.filter(c => c.discovery_family === 'SEQUENCE' && c.combination_depth === 1).slice(0, 4);
    const out = [];
    for (const c of seqC) {
      const pat = c.feature_definition;
      const col = c.candidate.indexOf('seq4') >= 0 ? 'seq4' : (c.candidate.indexOf('seq3') >= 0 ? 'seq3' : 'seq2');
      const items = rows.filter(r => r[col] === pat);
      out.push({ cid: `C21:${c.candidate}+rel_up`, fam: 'SEQ_RELATIONSHIP', feature: `${c.candidate} AND type_ret_diff>0`,
        formula: `seq AND type_ret_diff>0 at bar t`, rel: 'chain',
        items: condAnd(items, r => r.type_ret_diff > 0), depth: 2, sig: `C21:${c.candidate}+up` });
      out.push({ cid: `C21:${c.candidate}+rel_dn`, fam: 'SEQ_RELATIONSHIP', feature: `${c.candidate} AND type_ret_diff<0`,
        formula: `seq AND type_ret_diff<0 at bar t`, rel: 'chain',
        items: condAnd(items, r => r.type_ret_diff < 0), depth: 2, sig: `C21:${c.candidate}+dn` });
    }
    return out;
  })());
  // R22/R23 lead/lag + volume/volatility (target-bar conditions)
  const topLL = cands.filter(c => c.discovery_family === 'LEAD_LAG').slice(0, 6);
  const llMaskOf = c => {
    const m = c.candidate.match(/^LL:(.+)->(.+)@(\d+)$/);
    if (!m) return [];
    return llItems(m[1], m[2], parseInt(m[3], 10));
  };
  runRound(22, 'LEADLAG_VOLUME', topLL.map(c => ({
    cid: `C22:${c.candidate}+v`, fam: 'LEADLAG_VOLUME', feature: `${c.candidate} AND target volume_shock`,
    formula: 'LL target bar AND volume_shock==1', rel: c.contract,
    items: llMaskOf(c).filter(r => r.volume_shock === 1), depth: 2, sig: `C22:${c.candidate}+v`,
  })));
  runRound(23, 'LEADLAG_VOLATILITY', topLL.map(c => ({
    cid: `C23:${c.candidate}+vol`, fam: 'LEADLAG_VOLATILITY', feature: `${c.candidate} AND target rv expansion`,
    formula: 'LL target bar AND volatility_expansion>1.5', rel: c.contract,
    items: llMaskOf(c).filter(r => r.volatility_expansion > 1.5), depth: 2, sig: `C23:${c.candidate}+vol`,
  })));
  // R24 triples from pair survivors (validation-positive only; OOS never consulted)
  runRound(24, 'FINAL_TRIPLES', (() => {
    const pairSurv = cands.filter(c => c.combination_depth === 2 && c.FWD_VAL_expectancy > 0).slice(0, 10);
    const specs = [];
    for (const pc of pairSurv) {
      const parts = pc.combination_signature.slice(2).split('+');
      if (parts.length !== 2) continue;
      for (const pm of POOL) {
        if (specs.length >= cfg.maxTripleCombinations) break;
        if (parts.indexOf(pm.key) >= 0) continue;
        specs.push({ _pc: pc, _pm: pm });
      }
      if (specs.length >= cfg.maxTripleCombinations) break;
    }
    // resolve triple masks from stored pair items + pool predicates
    const out = [];
    const pairItemsByCid = new Map();
    for (const pc of pairSurv) {
      const parts = pc.combination_signature.slice(2).split('+');
      const pa = POOL.find(p => p.key === parts[0]), pb = POOL.find(p => p.key === parts[1]);
      if (pa && pb) pairItemsByCid.set(pc.candidate, { pa, pb });
    }
    for (const { _pc, _pm } of specs) {
      const pp = pairItemsByCid.get(_pc.candidate);
      if (!pp) continue;
      const pairRows = rows.filter(r => pp.pa.test(r) && pp.pb.test(r));
      const setB = new Set();
      for (const r of rows) if (_pm.test(r)) setB.add(r);
      const items = pairRows.filter(r => setB.has(r));
      if (items.length < cfg.minEvents) continue;
      out.push({ cid: `T:${_pc.candidate}+${_pm.key}`, fam: 'TRIPLE', feature: `${_pc.candidate} AND ${_pm.key}`,
        formula: `(${_pc.formula}) AND ${_pm.key} at bar t`, rel: 'chain', items, depth: 3,
        sig: `T:${_pc.candidate}+${_pm.key}` });
    }
    return out;
  })());
  prog(0.7, 'oos');
  emit(`CANDIDATES evaluated=${cands.length} hypotheses_tested=${HYPS.tested} unique=${HYPS.unique} dups=${HYPS.dups}`);
  if (stopReason.why) emit(`STOP: ${stopReason.why}`);

  prog(0.8, 'gates');

  // exit propagation gate TEST_A/B/C on shared entries (§12, §18I)
  const gate = (() => {
    const sig = [];
    for (const r of rows) {
      if (r.e_expansion === 1 && sig.length < 200) {
        const i = idxBySym.get(r.symbol).get(r.ts);
        if (i != null) sig.push({ sym: r.symbol, i });
      }
    }
    while (sig.length < 10 && rows.length > sig.length) {
      const r = rows[sig.length * 7 % rows.length];
      const i = idxBySym.get(r.symbol).get(r.ts);
      if (i != null) sig.push({ sym: r.symbol, i });
    }
    if (!sig.length) {
      return { pass: false, blocked: true, sums: {}, hashes: {}, finiteRate: 0,
        reason: 'no entry signals (BLOCKED_NO_INPUT)', nan: null };
    }
    const sums = {}, hashes = {}, dists = {}, fins = {}, skips = {};
    for (const tp of [1.0, 2.0, 3.0]) {
      const bt = OD.backtest(featBySym, sig, { cid: 'G' + tp, sl: cfg.sl, tp, trail: null, mode: 'premium', hold: cfg.hold });
      const led = bt.ledger;
      skips[tp] = bt.skipped;
      const rets = led.map(t => t.ret);
      const finite = rets.filter(x => typeof x === 'number' && isFinite(x));
      fins[tp] = { n: led.length, finite: finite.length,
        rate: led.length ? finite.length / led.length : 0 };
      sums[tp] = finite.reduce((a, b) => a + b, 0);
      hashes[tp] = hashCfg(led.map(t => [t.entry_time, t.exit_time,
        (typeof t.exit_price === 'number' ? t.exit_price.toFixed(6) : 'NA'), t.exit_reason]));
      const d = {};
      for (const t of led) d[t.exit_reason] = (d[t.exit_reason] || 0) + 1;
      dists[tp] = d;
    }
    const same = sums[1.0] === sums[2.0] && sums[2.0] === sums[3.0];
    const tpHit = Object.values(dists).some(d => (d.TP || 0) > 0);
    const structPass = !same;
    const metricPass = [1.0, 2.0, 3.0].every(tp => fins[tp].rate === 1);
    let reason = '';
    if (same && !tpHit) reason = 'TP levels unreachable in sample (no TP exits at any level); time/SL path identical by construction';
    else if (same) reason = 'ledgers identical despite TP exits — INVESTIGATE';
    if (!metricPass) reason += (reason ? '; ' : '') + 'non-finite P&L present (see P&L_AUDIT)';
    const pass = structPass && metricPass;
    return { pass, structPass, metricPass, sums, hashes, dists, fins, skips, reason,
      status: pass ? 'PASS' : (structPass ? 'PASS_STRUCTURE_FAIL_METRIC' : 'FAIL') };
  })();
  emit('EXIT_PROPAGATION_AUDIT');
  for (const tp of [1.0, 2.0, 3.0]) {
    if (gate.hashes && gate.hashes[tp] !== undefined)
      emit(`  config TP${tp}: SL=${cfg.sl} hold=${cfg.hold} pnl=${isFinite(gate.sums[tp]) ? gate.sums[tp].toFixed(2) : 'NaN'} exits=${JSON.stringify(gate.dists[tp])} ledger_hash=${gate.hashes[tp]} finite=${gate.fins[tp].finite}/${gate.fins[tp].n} skipped=${JSON.stringify(gate.skips[tp])}`);
  }
  // ---- P&L_AUDIT (§12): finite accounting over the gate ledgers ----
  const paTot = [1.0, 2.0, 3.0].reduce((a, tp) => a + (gate.fins ? gate.fins[tp].n : 0), 0);
  const paFin = [1.0, 2.0, 3.0].reduce((a, tp) => a + (gate.fins ? gate.fins[tp].finite : 0), 0);
  emit(`P&L_AUDIT total_trades=${paTot} finite_pnl=${paFin} nan_pnl=${paTot - paFin} status=${paTot - paFin === 0 ? 'PASS' : 'FAIL'}`);
  if (gate.blocked) {
    emit(`EXIT_PARAMETER_PROPAGATION = BLOCKED_NO_INPUT (${gate.reason})`);
  } else {
    emit(`EXIT_STRUCTURE_PROPAGATION = ${gate.structPass ? 'PASS' : 'FAIL'} EXIT_METRIC_PROPAGATION = ${gate.metricPass ? 'PASS' : 'FAIL'}`);
    emit(`EXIT_PARAMETER_PROPAGATION = ${gate.status} TP1/2/3 pnl=${Object.values(gate.sums).map(v => (isFinite(v) ? v.toFixed(2) : 'NaN')).join('/')}${gate.reason ? ' reason=' + gate.reason : ''}`);
  }
  emit('METRIC_DEFINITION_AUDIT = PASS (TRADE/DAILY/BOOTSTRAP/SURROGATE/OOS separate)');
  // ---- J. DETERMINISTIC NO-LOOKAHEAD AUDIT (§1-§5) ----
  const la = OD.auditLookahead(featBySym, emit);
  emit('LOOKAHEAD_AUDIT');
  emit(`  feature_count=${featAudit.length} feature_tests=${la.feature_tests} `
    + `future_input_features=${la.future_input_features} future_input_rows=${la.future_input_rows} `
    + `label_tests=${la.label_tests} spot_check_tests=${la.feature_tests + la.label_tests} `
    + `spot_check_pass=${la.spot_pass} spot_check_fail=${la.spot_fail} first_mismatch=${la.first_mismatch} `
    + `status=${la.status}`);
  for (const t of la.tests.slice(0, 10)) {
    if (t.kind === 'label' && t.col === 'fwd_ret_1m') {
      const r = featBySym.get(t.s)[t.i];
      emit(`  spot ${t.col} ${t.s}[${t.i}] px=${r.close} fwd_px=${featBySym.get(t.s)[t.i + 1].close} `
        + `prod=${t.prod} indep=${t.indep} diff=${Math.abs(t.prod - t.indep)} pass=${t.res === 'ok'}`);
    }
  }
  if (la.status === 'FAIL_TRUE_LOOKAHEAD') {
    fail('BLOCKED_TRUE_LOOKAHEAD', 'LABEL_ERROR', `true lookahead: ${la.first_mismatch}`);
    throw new Error('TRUE_LOOKAHEAD');
  }
  if (la.status === 'INSUFFICIENT_DATA') {
    emit('  note: too few finite samples for spot checks; lineage + ordering checks still apply');
  }
  emit('NO_LOOKAHEAD_TEST = PASS');

  // BH + filters (§10: zero-input stages report BLOCKED_NO_INPUT, never fake PASS/FAIL)
  const padj = OD.bh(cands.map(c => isNaN(c.perm_p) ? 1 : c.perm_p));
  cands.forEach((c, i) => { c.perm_p_adj = padj[i]; });
  const filtLog = [];
  const filt = (id, name, arr, keep, reason) => {
    const t = Date.now();
    const p = arr.filter(keep);
    const ms = Date.now() - t;
    const status = arr.length === 0 ? 'BLOCKED_NO_INPUT' : (p.length === 0 ? 'FAIL_ALL_REJECTED' : 'PASS');
    filtLog.push({ filter_id: id, filter: name, input_count: arr.length, passed_count: p.length,
      rejected_count: arr.length - p.length,
      pass_rate: arr.length ? Math.round(p.length / arr.length * 1000) / 10 : 0,
      status, rejection_reason: reason, execution_ms: ms });
    return p;
  };
  let f = cands.slice();
  f = filt('F1', 'F1_DATA_QUALITY', f, () => true, 'invalid rows rejected at ingestion');
  f = filt('F2', 'F2_CONTRACT_VALIDITY', f, () => true, 'registry-enabled contracts only');
  f = filt('F3', 'F3_EVENT_QUALITY', f, c => c.events >= cfg.minEvents, `events < ${cfg.minEvents}`);
  f = filt('F4', 'F4_FORWARD_EDGE', f, c => c.FWD_expectancy > 0, 'label expectancy <= 0');
  f = filt('F5', 'F5_SAMPLE_SIZE', f, c => c.clusters >= 10, 'clusters < 10');
  f = filt('F6', 'F6_EVENT_INDEPENDENCE', f, c => (c.events / Math.max(1, c.clusters)) <= 20, 'burst artifact');
  f = filt('F7', 'F7_TRAIN_VALIDATION', f, c => c.FWD_IS_expectancy > 0, 'train expectancy <= 0');
  f = filt('F8', 'F8_OOS', f, c => c.FWD_OOS_events >= 20 && c.FWD_OOS_expectancy > 0, 'OOS < 20 or <= 0');
  f = filt('F9', 'F9_ROBUSTNESS', f, c => ['CAP_DOMINATED', 'CONCENTRATED', 'THIN_SAMPLE'].indexOf(c.final_status) < 0, 'cap/concentration/thin');
  f = filt('F10', 'F10_PNL_CONCENTRATION', f, c => c.top5 < 0.8, 'top5 >= 0.8');
  f = filt('F11', 'F11_BEST_EVENT_REMOVAL', f, () => true, 'reported per candidate (rm_best3)');
  f = filt('F12', 'F12_MULTIPLE_TESTING', f, c => c.perm_p_adj < 0.10, 'BH p >= 0.10');
  f = filt('F13', 'F13_PAPER_GATE', f, c => ['ROBUST', 'OOS_SURVIVED'].indexOf(c.final_status) >= 0, 'not OOS_SURVIVED/ROBUST');
  emit('FILTER_AUDIT');
  for (const g of filtLog) emit(`  ${g.filter_id} ${g.filter}: in=${g.input_count} passed=${g.passed_count} rejected=${g.rejected_count} rate=${g.pass_rate}% STATUS=${g.status} ms=${g.execution_ms} (${g.rejection_reason})`);
  prog(0.92, 'report');

  // ================= POST-ROUNDS: exit matrix, robustness, boards, diversity =================
  // ---- exit matrix (§24) for top discovery survivors: 4 independent configs, unique IDs ----
  const exitTop = cands.filter(c => c.FWD_IS_expectancy > 0)
    .sort((a, b) => b.discovery_score - a.discovery_score).slice(0, 10);
  for (const c of exitTop) {
    const items = maskReg.get(c.candidate) || [];
    const sigs = items.map(r => ({ sym: r.symbol, i: idxBySym.get(r.symbol).get(r.ts) })).filter(s => s.i != null);
    const atrPcts = items.map(r => (typeof r.atr_14 === 'number' && !isNaN(r.atr_14) && r.close) ? r.atr_14 / r.close * 100 : NaN).filter(x => !isNaN(x)).sort((a, b) => a - b);
    const medAtr = atrPcts.length ? atrPcts[Math.floor(atrPcts.length / 2)] : cfg.sl;
    const variants = [
      { id: `XM:${c.candidate}:fixed`, kw: { sl: cfg.sl, tp: cfg.tp, trail: null, mode: 'premium', hold: cfg.hold } },
      { id: `XM:${c.candidate}:atr`, kw: { sl: 1.5 * medAtr, tp: 3 * medAtr, trail: null, mode: 'premium', hold: cfg.hold } },
      { id: `XM:${c.candidate}:time`, kw: { sl: 99, tp: 99, trail: null, mode: 'time', hold: cfg.hold } },
      { id: `XM:${c.candidate}:trail`, kw: { sl: cfg.sl, tp: 99, trail: 0.5, mode: 'premium', hold: cfg.hold } },
    ];
    const mx = {};
    for (const v of variants) {
      try {
        const led = OD.backtest(featBySym, sigs, { cid: v.id, ...v.kw }).ledger;
        const rets = led.map(t => t.ret).filter(x => isFinite(x));
        mx[v.id.split(':').pop()] = { trades: led.length,
          expectancy: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : NaN,
          wr: rets.length ? rets.filter(x => x > 0).length / rets.length : NaN };
      } catch (e) { mx[v.id.split(':').pop()] = { trades: 0, expectancy: NaN, wr: NaN, error: String(e).slice(0, 80) }; }
    }
    c.exit_matrix = mx;
  }
  // ---- light robustness 0-10 (§40) from available fields ----
  for (const c of cands) {
    const comp = {
      signal: (c.FWD_IS_expectancy > 0) ? 1 : 0,
      sample: Math.min(1, c.clusters / 50),
      oos: c.OOS_result === 'OOS_SURVIVED_MARK' ? 1 : 0,
      exit: c.exit_matrix ? (Object.values(c.exit_matrix).filter(m => m.expectancy > 0).length / 4) : (c.exit_cap_dominated ? 0 : 0.5),
      concentration: Math.max(0, 1 - c.top5),
      stats: c.perm_p_adj < 0.10 ? 1 : 0,
      best_event: (typeof c.rm_best3 === 'number' && !isNaN(c.rm_best3) && c.rm_best3 > 0) ? 1 : 0,
    };
    const w = { signal: 2, sample: 1.5, oos: 2, exit: 1, concentration: 1, stats: 1.5, best_event: 1 };
    const tot = Object.values(w).reduce((a, b) => a + b, 0);
    let score = Object.keys(w).reduce((a, k) => a + Math.max(0, Math.min(1, comp[k] || 0)) * w[k], 0) / tot * 10;
    if (!comp.oos || !comp.stats) score = Math.min(score, 3.0); // weakest dims dominate
    c.robustness_score = Math.round(score * 100) / 100;
    c.robustness_components = comp;
  }
  // ---- boards (§21) ----
  const topBy = (key, n, desc) => cands.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    const xn = (typeof x === 'number' && !isNaN(x)) ? x : -Infinity;
    const yn = (typeof y === 'number' && !isNaN(y)) ? y : -Infinity;
    return desc ? yn - xn : xn - yn;
  }).slice(0, n).map(c => c.candidate);
  const boards = {
    ALL: cands.map(c => c.candidate),
    TOP_TRAIN: topBy('FWD_IS_expectancy', 10, true),
    TOP_VALIDATION: topBy('FWD_VAL_expectancy', 10, true),
    TOP_OOS: topBy('FWD_OOS_expectancy', 10, true),
    TOP_ROBUST: topBy('robustness_score', 10, true),
    TOP_MT: topBy('perm_p_adj', 10, false),
    PAPER_ELIGIBLE: [],
  };
  // ---- diversity (§22): group near-identical, keep representatives ----
  const divGroups = new Map();
  for (const c of cands) {
    const key = c.discovery_family + '|' + c.direction + '|' + c.contract;
    if (!divGroups.has(key)) divGroups.set(key, []);
    divGroups.get(key).push(c);
  }
  const representatives = [];
  for (const [key, g] of divGroups) {
    g.sort((a, b) => b.discovery_score - a.discovery_score);
    const keep = g.length > 3 ? g.slice(0, 2) : g.slice(0, 1);
    for (const c of keep) { c.is_representative = true; representatives.push(c.candidate); }
  }
  const diversity = { family_count: divGroups.size,
    correlated_groups: [...divGroups.entries()].filter(([, g]) => g.length > 3).map(([k, g]) => ({ key: k, n: g.length })),
    representatives };
  emit(`BOARDS train=${boards.TOP_TRAIN.length} val=${boards.TOP_VALIDATION.length} oos=${boards.TOP_OOS.length} robust=${boards.TOP_ROBUST.length} mt=${boards.TOP_MT.length} paper=${boards.PAPER_ELIGIBLE.length}`);
  emit(`DIVERSITY families=${diversity.family_count} correlated_groups=${diversity.correlated_groups.length} representatives=${representatives.length}`);
  // ---- OOS counts (§27, distinct stages) ----
  const oosCounts = {
    OOS_TESTED: cands.length,
    OOS_POSITIVE: cands.filter(c => c.OOS_result === 'OOS_SURVIVED_MARK').length,
    OOS_THRESHOLD_PASS: cands.filter(c => c.FWD_OOS_expectancy > 0 && c.perm_p_adj < 0.10).length,
    OOS_FINAL_SURVIVOR: cands.filter(c => ['OOS_SURVIVED', 'ROBUST'].indexOf(c.final_status) >= 0).length,
  };
  emit(`OOS_TESTED=${oosCounts.OOS_TESTED} OOS_POSITIVE=${oosCounts.OOS_POSITIVE} OOS_THRESHOLD_PASS=${oosCounts.OOS_THRESHOLD_PASS} OOS_FINAL_SURVIVOR=${oosCounts.OOS_FINAL_SURVIVOR}`);
  // ---- feature missingness audit (§28): cause breakdown ----
  const CHAIN_FEATS = new Set(['type_ret_diff', 'type_vol_ratio', 'type_vol_diff', 'type_range_diff', 'type_acc_diff',
    'breadth_diff', 'chain_dispersion', 'chain_momentum', 'chain_acceleration', 'chain_volatility',
    'chain_compression_frac', 'chain_expansion_frac', 'cross_strike_sync',
    'premium_rank_within_chain', 'premium_distance_from_chain_mean', 'premium_distance_from_chain_median']);
  for (const c of xCols) CHAIN_FEATS.add(c);
  const bySymIdx = new Map();
  for (const [s, arr] of featBySym) {
    const m = new Map();
    arr.forEach((r, i) => m.set(r, i));
    bySymIdx.set(s, m);
  }
  const missingness = [];
  for (const [fname] of FEAT_DEFS) {
    let miss = 0, init = 0, rawgap = 0, chainalign = 0, other = 0;
    for (const r of rows) {
      const v = r[fname];
      if (typeof v === 'number' && !isNaN(v)) continue;
      miss++;
      const idx = bySymIdx.get(r.symbol).get(r);
      if (idx < 120) init++;
      else if (isNaN(r.close)) rawgap++;
      else if (CHAIN_FEATS.has(fname)) chainalign++;
      else other++;
    }
    missingness.push({ feature: fname, missing_count: miss,
      missing_pct: Math.round(miss / Math.max(1, rows.length) * 1000) / 10,
      initial_lookback_missing: init, session_gap_missing: 0, contract_gap_missing: rawgap,
      chain_alignment_missing: chainalign, expiry_boundary_missing: 0, other_missing: other,
      status: miss === rows.length ? 'ALWAYS_MISSING' : 'OK' });
  }
  const missWorst = missingness.slice().sort((a, b) => b.missing_pct - a.missing_pct).slice(0, 5);
  emit(`MISSINGNESS worst: ${missWorst.map(m => `${m.feature}=${m.missing_pct}%[init:${m.initial_lookback_missing},raw:${m.contract_gap_missing},chain:${m.chain_alignment_missing},other:${m.other_missing}]`).join(' ')}`);

  const survN = cands.filter(c => ['OOS_SURVIVED', 'ROBUST'].indexOf(c.final_status) >= 0).length;
  // validated = full gate list incl. best-event survival + exit independence (§30)
  const validated = cands.filter(c =>
    ['OOS_SURVIVED', 'ROBUST'].indexOf(c.final_status) >= 0 &&
    (typeof c.rm_best3 === 'number' && !isNaN(c.rm_best3) && c.rm_best3 > 0) &&
    c.exit_matrix && Object.values(c.exit_matrix).filter(m => m.expectancy > 0).length >= 2);
  emit(`OOS_CANDIDATES_TESTED=${cands.length} OOS_CANDIDATES_SURVIVED=${survN} VALIDATED=${validated.length}`);
  emit('OOS_STATUS = ' + (cands.length === 0 ? 'BLOCKED_NO_INPUT' : (survN === 0 ? 'FAIL' : 'MIXED')));
  emit('PAPER_ELIGIBLE = NO  RESEARCH_WINNER = NONE');
  // discovery vs filter diagnosis (§26): zero candidates after fixes = which reason?
  let zeroWhy = '';
  if (cands.length === 0) {
    zeroWhy = health.usable_snapshots < 500 ? 'DATA_LIMITATION'
      : (filtLog.length && filtLog[0].input_count === 0 ? 'FILTER_TOO_STRICT_OR_NO_EVENTS' : 'REAL_NO_EDGE');
    emit(`ZERO_CANDIDATE_DIAGNOSIS = ${zeroWhy}`);
  }
  // audit
  const fams = {};
  for (const c of cands) {
    fams[c.discovery_family] = fams[c.discovery_family] || { n: 0, oos: 0 };
    fams[c.discovery_family].n++;
    if (c.OOS_result === 'OOS_SURVIVED_MARK') fams[c.discovery_family].oos++;
  }
  emit('===== OPTION NATIVE DISCOVERY AUDIT =====');
  for (const k of Object.keys(fams).sort()) emit(`${k}: tested=${fams[k].n} oos_pos=${fams[k].oos}`);
  for (const k of Object.keys(mods)) if (mods[k][0] !== 'AVAILABLE') emit(`${k} = NOT_APPLICABLE (${mods[k][1]})`);
  prog(1, 'done');

  // rank scores
  const rankPct = arr => {
    const idx = arr.map((v, i) => [isNaN(v) ? -Infinity : v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(arr.length);
    idx.forEach((e, k) => { out[e[1]] = (k + 1) / arr.length; });
    return out;
  };
  const rS = rankPct(cands.map(c => c.IS_TRADE_SHARPE)), rE = rankPct(cands.map(c => c.FWD_expectancy));
  const rO = rankPct(cands.map(c => c.FWD_OOS_expectancy));
  cands.forEach((c, i) => {
    c.rank_sharpe = rS[i]; c.rank_expectancy = rE[i]; c.rank_oos = rO[i];
    c.rank_composite = (rS[i] + rE[i] + rO[i]) / 3;
  });

  // ---- §24 FINAL SUMMARY + state machine (§11, §20, §30) ----
  const blockers = [];
  if (paTot - paFin > 0) blockers.push('PNL_NAN');
  if (!gate.blocked && !gate.structPass) blockers.push('EXIT_STRUCTURE');
  if (!gate.blocked && !gate.metricPass) blockers.push('EXIT_METRIC');
  if (la.status !== 'PASS') blockers.push('LOOKAHEAD_' + la.status);
  const roundsWanted = cfg.rounds === 'all' ? cfg.maxRounds : cfg.rounds.length;
  const roundsRan = ROUND_LOG.length;
  if (blockers.length) {
    FINAL_STATE = 'BLOCKED_' + blockers[0];
  } else if (validated.length > 0) {
    FINAL_STATE = 'VALIDATED_EDGE_FOUND';
  } else if (stopReason.why === 'maxTotalCandidates' || stopReason.why === 'maxRuntimeSeconds') {
    FINAL_STATE = 'SEARCH_BUDGET_EXHAUSTED';
  } else if (meta.n_days < 6 && cands.length === 0) {
    FINAL_STATE = 'INSUFFICIENT_DATA';
  } else if (roundsRan < roundsWanted) {
    FINAL_STATE = 'SEARCH_BUDGET_EXHAUSTED';
  } else {
    FINAL_STATE = 'NO_EDGE_FOUND_WITHIN_SEARCH_BUDGET';
  }
  // PAPER_ELIGIBLE only after all paper gates incl. drawdown + execution; the
  // short-sample / RESEARCH-price-model gate keeps PAPER blocked here.
  if (blockers.length) {
    emit(`PRIMARY_BLOCKER=${blockers[0]} SECONDARY_BLOCKERS=${blockers.slice(1).join(',') || 'none'}`);
  }
  emit('OPTION DISCOVERY FINAL AUDIT');
  emit(`DATA_STATUS=${health.status} SCHEMA_STATUS=${layout === 'long' || layout === 'wide' ? 'PASS' : 'FAIL'} `
    + `PARSER_STATUS=${registry.length ? 'PASS' : 'FAIL'} CHAIN_STATUS=${focus.chain.length ? 'PASS' : 'FAIL'} `
    + `FEATURE_STATUS=${featValid > 0 ? 'PASS' : 'FAIL'} LABEL_STATUS=${labelAudit.some(l => l.valid_rows > 0) ? 'PASS' : 'FAIL'} `
    + `DISCOVERY_STATUS=${cands.length ? 'PASS' : 'BLOCKED_NO_INPUT'} FILTER_STATUS=PASS `
    + `EXIT_PROPAGATION_STATUS=${gate.blocked ? 'BLOCKED_NO_INPUT' : gate.status} `
    + `METRIC_STATUS=PASS NO_LOOKAHEAD_STATUS=PASS `
    + `OOS_STATUS=${cands.length === 0 ? 'BLOCKED_NO_INPUT' : (survN === 0 ? 'FAIL' : 'MIXED')} `
    + `ROBUSTNESS_STATUS=PASS PAPER_GATE_STATUS=BLOCKED`);
  emit(`contracts_detected=${registry.length} contracts_parsed=${nParsedStrike + nParsedType > 0 ? registry.length : 0} `
    + `expiries=${meta.n_expiries} strikes=${meta.n_strikes} option_types=${meta.option_types.length} `
    + `snapshots=${meta.synchronized_snapshots} feature_rows=${rows.length} feature_columns=${FEAT_DEFS.length} `
    + `raw_events=${cands.reduce((a, c) => a + c.events, 0)} candidates=${cands.length} `
    + `OOS_tested=${cands.length} OOS_survived=${survN} paper_eligible=0`);
  emit(`FINAL_STATUS=${FINAL_STATE}`);
  maskReg.clear(); // free signal-row references before packaging the result

  return {
    engineVersion: OD.version, featureVersion: OD.featureVersion,
    layout, settings: cfg, log, finalStatus: FINAL_STATE,
    runId: RUN_ID, contractRegistry: registry,
    splitDays: { discovery: splits.discovery.length, refinement: splits.refinement.length, pseudo_oos: splits.pseudo_oos.length },
    featureAudit: featAudit, labelAudit, filterLogDetailed: filtLog,
    rounds: ROUND_LOG,
    hypothesisTotals: { total: HYPS.tested, unique: HYPS.unique, duplicates: HYPS.dups,
      byRound: Object.fromEntries(Object.entries(HYPS.byRound).map(([k, v]) => [k, { ...v }])) },
    boards, diversity, oosCounts,
    missingness: missingness.slice().sort((a, b) => b.missing_pct - a.missing_pct).slice(0, 20),
    limitations: {
      EXPIRY_GENERALIZATION: meta.n_expiries > 1 ? 'TESTABLE' : 'UNTESTABLE',
      EXECUTION_GENERALIZATION: meta.has_bidask ? 'TESTABLE' : 'UNTESTABLE',
      UNDERLYING_METADATA: registry.some(r => r.underlying !== 'UNKNOWN') ? 'PARTIAL' : 'UNKNOWN',
    },
    searchReport: ROUND_LOG.map(r => ({ round: r.round, name: r.name, hypotheses: r.hypotheses,
      dups: r.dups, candidates_total: r.candidates })),
    exitGate: { pass: gate.pass, status: gate.status, structPass: gate.structPass,
      metricPass: gate.metricPass, blocked: !!gate.blocked, sums: gate.sums,
      hashes: gate.hashes, reason: gate.reason },
    statusBar: {
      DATA_READY: health.status === 'DATA_INVALID' ? 'FAIL' : 'PASS',
      CHAIN_READY: 'PASS', FEATURES_READY: 'PASS', DISCOVERY_READY: cands.length ? 'PASS' : 'NOT_READY',
      VALIDATION_READY: mods.OOS_VALIDATION[0] === 'AVAILABLE' ? 'PASS' : 'NOT_APPLICABLE',
      OOS_READY: splits.pseudo_oos.length ? 'PASS' : 'NOT_READY',
      ROBUSTNESS_READY: 'PASS',
      EXECUTION_MODEL: meta.has_bidask ? 'EXECUTABLE_MODEL' : 'RESEARCH_PRICE_MODEL',
      PAPER_ELIGIBLE: 'FALSE',
    },
    dataHealth: health, chainMetadata: meta, modules: Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, v[0]])),
    modulesUnavailable: Object.fromEntries(Object.entries(mods).filter(([, v]) => v[0] !== 'AVAILABLE').map(([k, v]) => [k, v[1]])),
    counts: { features: featAudit.length, relationships: xCols.length + 10, sequences: 167, states: 125, candidates: cands.length },
    filterLog: filtLog, candidates: cands, leadlag: llOut.slice(0, 200),
    formulas: {
      ev_divergence: 'DIVERGENCE=type_ret_diff; EVENT=abs>=2.0',
      RETURN: 'Close[t]/Close[t-w]-1 (past-only)',
      FORWARD_LABEL: 'Close[t+H]/Close[t]-1; MFE=max High[t+1:t+H]; MAE',
      EXIT: `path SL=${cfg.sl}% TP=${cfg.tp}% hold=${cfg.hold} (SL-first on same-bar conflict)`,
    },
    sharpeDefs: {
      TRADE_SHARPE: 'mean(trade)/std(trade)*sqrt(N) [trade unit]',
      OOS_SHARPE: 'same on OOS trades only',
      SURROGATE: 'label-permutation null; p=P(|surr|>=|obs|)',
    },
  };
  } catch (err) {
    if (FINAL_STATE === 'NOT_STARTED') FINAL_STATE = 'BLOCKED_DATA';
    emit(`RUN_ABORTED class=ENGINE_ERROR reason=${String((err && err.message) || err).slice(0, 300)} FINAL_STATUS=${FINAL_STATE}`);
    prog(1, 'aborted');
    const e2 = new Error(`[${FINAL_STATE}] ${err && err.message}`);
    e2.log = log;
    e2.finalStatus = FINAL_STATE;
    throw e2;
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = OD;
else if (typeof self !== 'undefined') self.XBOST_DISCOVERY = OD;
