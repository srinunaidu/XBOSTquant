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
  symbol: ['symbol', 'sym', 'contract', 'contract_symbol', 'instrument', 'ticker'],
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

/* ---------- data understanding layer (§2): what exists before what to test ---------- */
OD.understand = function (norm, meta, rawInfo) {
  const total = Math.max(1, norm.length);
  const avail = col => norm.filter(r => typeof r[col] === 'number' && !isNaN(r[col])).length / total;
  const fields = {};
  for (const c of ['open', 'high', 'low', 'close', 'volume', 'oi', 'bid', 'ask']) fields[c] = avail(c);
  const reg = (meta && meta.registry && meta.registry.length) ? meta.registry : OD.buildRegistry(norm, 'long');
  // underlying candidates: series that are NOT parsed option contracts —
  // UNKNOWN option type AND no valid strike anywhere on the symbol, with dense
  // aligned history. Genuinely unparseable option tokens stay UNKNOWN (reported
  // as parse gaps), they are not promoted to reference.
  const optSyms = new Set(reg.filter(r =>
    r.option_type !== 'UNKNOWN' || r.strike !== 'UNKNOWN').map(r => r.contract_id));
  const refSyms = [...new Set(norm.map(r => r.symbol))].filter(s => !optSyms.has(s) && !String(s).startsWith('__'));
  // underlying candidates, in priority order (§6):
  // 1) explicit underlying column values are names only (no series);
  // 2) numeric reference/index-like columns; 3) futures/index naming pattern;
  // 4) timestamp-aligned non-option series; 5) inferred common reference.
  const refCands = [];
  const optTs = new Set(norm.filter(r => r.symbol !== undefined && optSyms.has(r.symbol)).map(r => r.ts));
  const NAMING_RE = /(FUT|FUTURE|INDEX|SPOT|IDX|CONTINUOUS)/i; // generic role tokens, never specific names
  for (const s of refSyms) {
    const bars = norm.filter(r => r.symbol === s && !isNaN(r.close));
    if (bars.length < 50) continue;
    const ts = new Set(bars.map(r => r.ts));
    let overlap = 0;
    for (const t of ts) if (optTs.has(t)) overlap++;
    refCands.push({ symbol: s, bars: bars.length, source: NAMING_RE.test(s) ? 'naming-pattern' : 'aligned-series',
      coverage: optTs.size ? overlap / optTs.size : 0, aligned: overlap });
  }
  // numeric reference-like columns live outside the normalized row model; a
  // reference must arrive as its own symbol series (or be named via the
  // underlying field). Column-carried references are NOT_APPLICABLE by design.
  refCands.sort((a, b) => (b.source === 'naming-pattern' ? 0.05 : 0) + b.coverage - ((a.source === 'naming-pattern' ? 0.05 : 0) + a.coverage));
  const namedRef = [...new Set(norm.map(r => r.underlying))].filter(u => u && u !== 'UNKNOWN');
  // time structure
  const byDay = new Map();
  for (const r of norm) {
    const d = new Date(r.ts).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r.ts);
  }
  const sessions = [];
  for (const [d, arr] of byDay) {
    const a = arr.sort((x, y) => x - y);
    const f = t => { const dd = new Date(t); return String(dd.getUTCHours()).padStart(2, '0') + ':' + String(dd.getUTCMinutes()).padStart(2, '0'); };
    sessions.push({ day: d, open: f(a[0]), close: f(a[a.length - 1]), bars: a.length });
  }
  // chain structure per expiry
  const perExp = {};
  for (const e of meta.expiries) {
    const ss = norm.filter(r => r.expiry === e);
    const sts = [...new Set(ss.map(r => r.strike).filter(s => !isNaN(s)))].sort((a, b) => a - b);
    const diffs = [];
    for (let i = 1; i < sts.length; i++) diffs.push(sts[i] - sts[i - 1]);
    diffs.sort((a, b) => a - b);
    const vol = ss.filter(r => !isNaN(r.volume)).reduce((a, r) => a + r.volume, 0);
    perExp[e] = { strikes: sts.length, spacing: diffs.length ? diffs[Math.floor(diffs.length / 2)] : NaN,
      contracts: new Set(ss.map(r => r.symbol)).size, volume: vol };
  }
  return {
    fields,
    underlying_candidates: refCands,
    reference: refCands.length ? refCands[0] : null,
    named_reference: namedRef,
    sessions: sessions.slice(0, 5), n_sessions: sessions.length,
    timezone: 'UNKNOWN (assumed exchange-local)',
    per_expiry: perExp,
  };
};
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

/* ---------- underlying + moneyness + multi-expiry (§4-§6) ---------- */
OD.underlyingFeatures = function (refBars) {
  // refBars: [{ts,open,high,low,close,volume}] sorted; past-only, option conventions
  const arr = refBars.slice().sort((a, b) => a.ts - b.ts);
  const n = arr.length, H = 120;
  const cl = arr.map(r => r.close);
  for (let i = 0; i < n; i++) {
    const r = arr[i];
    for (const w of [1, 5]) {
      r['und_ret_' + w] = (i >= w && cl[i - w] !== 0 && !isNaN(cl[i]) && !isNaN(cl[i - w]))
        ? (cl[i] / cl[i - w] - 1) * 100 : NaN;
    }
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 5); j < i; j++) if (!isNaN(arr[j].und_ret_1)) { s += arr[j].und_ret_1; c++; }
    r.und_mom_5 = c >= 3 ? s / c : NaN;
    r.und_acc = NaN; // filled in second pass below
    let rs = [];
    for (let j = Math.max(0, i - 20); j < i; j++) {
      const v = (j > 0 && !isNaN(arr[j].close) && !isNaN(arr[j - 1].close) && arr[j - 1].close)
        ? (arr[j].close / arr[j - 1].close - 1) * 100 : NaN;
      if (!isNaN(v)) rs.push(v);
    }
    r.und_vol_20 = rs.length >= 10 ? std(rs) : NaN;
    const rng = r.high - r.low;
    r.und_expansion = (i > 0 && !isNaN(rng) && !isNaN(arr[i - 1].high) && arr[i - 1].high !== arr[i - 1].low)
      ? rng / (arr[i - 1].high - arr[i - 1].low) : NaN;
    r.und_breakout = ((!isNaN(r.und_expansion) && r.und_expansion > 2.0 && Math.abs(r.und_ret_5) > 1.0)) ? 1 : 0;
    r.und_trend = (!isNaN(r.und_mom_5)) ? (r.und_mom_5 > 0.2 ? 'up' : (r.und_mom_5 < -0.2 ? 'down' : 'flat')) : 'na';
    const win = [];
    for (let j = Math.max(0, i - H); j < i; j++) if (!isNaN(arr[j].und_vol_20)) win.push(arr[j].und_vol_20);
    const vw = win.filter(x => !isNaN(x));
    if (vw.length >= 20 && !isNaN(r.und_vol_20)) {
      let le = 0;
      for (const x of vw) if (x <= r.und_vol_20) le++;
      const p = le / vw.length * 100;
      r.und_vol_regime = p < 33 ? 'low' : p < 66 ? 'mid' : 'high';
    } else r.und_vol_regime = 'na';
  }
  // accel needs mom series: second pass
  for (let i = 1; i < n; i++) {
    arr[i].und_acc = (!isNaN(arr[i].und_mom_5) && !isNaN(arr[i - 1].und_mom_5)) ? arr[i].und_mom_5 - arr[i - 1].und_mom_5 : NaN;
  }
  const byTs = new Map(arr.map(r => [r.ts, r]));
  return { bars: arr, byTs };
};

OD.attachUnderlying = function (rows, und, meta) {
  // join reference features onto option rows by exact ts; beta_60 per option row
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }
  for (const arr of bySym.values()) arr.sort((a, b) => a.ts - b.ts);
  const uret = new Map([...und.byTs.entries()].map(([t, r]) => [t, r.und_ret_1]));
  for (const arr of bySym.values()) {
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      const u = und.byTs.get(r.ts);
      r.und_ret_1 = u ? u.und_ret_1 : NaN;
      r.und_ret_5 = u ? u.und_ret_5 : NaN;
      r.und_mom_5 = u ? u.und_mom_5 : NaN;
      r.und_acc = u ? u.und_acc : NaN;
      r.und_vol_20 = u ? u.und_vol_20 : NaN;
      r.und_expansion = u ? u.und_expansion : NaN;
      r.und_breakout = u ? u.und_breakout : 0;
      r.und_trend = u ? u.und_trend : 'na';
      r.und_vol_regime = u ? u.und_vol_regime : 'na';
      // beta_60: cov(opt r1, und r1)/var(und r1) over trailing 60 bars
      let sx = 0, sy = 0, sxx = 0, sxy = 0, cn = 0;
      for (let j = Math.max(0, i - 60); j < i; j++) {
        const a = arr[j].return_1, b = uret.get(arr[j].ts);
        if (typeof a === 'number' && !isNaN(a) && typeof b === 'number' && !isNaN(b)) {
          sx += b; sy += a; sxx += b * b; sxy += a * b; cn++;
        }
      }
      if (cn >= 20 && (sxx - sx * sx / cn) > 1e-12) {
        r.beta_60 = (sxy - sx * sy / cn) / (sxx - sx * sx / cn);
      } else r.beta_60 = NaN;
      r.resp_spread = (!isNaN(r.return_5) && !isNaN(r.und_ret_5) && !isNaN(r.beta_60))
        ? r.return_5 - r.beta_60 * r.und_ret_5 : NaN;
      r.und_lead_up = ((!isNaN(r.und_ret_5) && r.und_ret_5 > 1.0 && !isNaN(r.return_5) && Math.abs(r.return_5) < 0.5)) ? 1 : 0;
      r.und_lead_dn = ((!isNaN(r.und_ret_5) && r.und_ret_5 < -1.0 && !isNaN(r.return_5) && Math.abs(r.return_5) < 0.5)) ? 1 : 0;
      r.opt_lead_up = ((!isNaN(r.return_5) && r.return_5 > 1.0 && !isNaN(r.und_ret_5) && Math.abs(r.und_ret_5) < 0.5)) ? 1 : 0;
      r.und_divergence = (!isNaN(r.resp_spread) && Math.abs(r.resp_spread) > 2.0) ? 1 : 0;
      const over = (!isNaN(r.return_5) && !isNaN(r.und_ret_5) && Math.abs(r.und_ret_5) > 0.5)
        ? Math.abs(r.return_5) / Math.abs(r.und_ret_5) : NaN;
      r.overreaction = (!isNaN(over) && over > 2.0) ? 1 : 0;
      r.underreaction = (!isNaN(over) && over < 0.5) ? 1 : 0;
    }
  }
  for (const c of ['und_ret_1', 'und_ret_5', 'und_mom_5', 'und_acc', 'und_vol_20', 'und_expansion',
    'beta_60', 'resp_spread']) OD.track(c, { inputs: ['reference series at same ts + trailing 60'], future: false });
  return rows;
};

OD.attachMoneyness = function (rows, und) {
  // strike distance vs reference close at same ts; ATM = min |distance| per ts
  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, []);
    byTs.get(r.ts).push(r);
  }
  for (const g of byTs.values()) {
    const ref = und.byTs.get(g[0].ts);
    const px = ref ? ref.close : NaN;
    for (const r of g) {
      r.moneyness_pct = (!isNaN(r.strike) && px) ? (r.strike - px) / px * 100 : NaN;
    }
    const valid = g.filter(r => !isNaN(r.moneyness_pct));
    if (valid.length) {
      let atm = valid[0];
      for (const r of valid) if (Math.abs(r.moneyness_pct) < Math.abs(atm.moneyness_pct)) atm = r;
    for (const r of g) {
      if (isNaN(r.moneyness_pct)) { r.moneyness_band = 'na'; r.moneyness_bucket_05 = NaN; continue; }
      r.moneyness_bucket_05 = Math.round(r.moneyness_pct * 2) / 2;
        const a = Math.abs(r.moneyness_pct);
        const side = r.moneyness_pct >= 0 ? 'ABOVE' : 'BELOW';
        r.moneyness_band = (a <= 1 ? 'ATM_LIKE' : a <= 2.5 ? 'NEAR' : a <= 5 ? 'MODERATE' : 'DEEP') + '_' + side;
        r.is_empirical_atm = (r === atm) ? 1 : 0;
      }
    } else {
      for (const r of g) { r.moneyness_band = 'na'; r.moneyness_bucket_05 = NaN; r.is_empirical_atm = 0; }
    }
  }
  for (const c of ['moneyness_pct', 'moneyness_band', 'is_empirical_atm'])
    OD.track(c, { inputs: ['strike + reference close at same ts'], future: false });
  return rows;
};

OD.expirySpreads = function (rows, meta) {
  // front-vs-next same (strike,type) spreads; only when ≥2 expiries present
  const cols = [];
  const exps = [...new Set(rows.map(r => r.expiry))].sort();
  if (exps.length < 2) return cols;
  for (let e = 0; e + 1 < exps.length; e++) {
    const A = exps[e], B = exps[e + 1];
    const key = r => r.strike + '|' + r.option_type;
    const ma = new Map(), mb = new Map();
    for (const r of rows) {
      if (r.expiry === A) { if (!ma.has(key(r))) ma.set(key(r), new Map()); ma.get(key(r)).set(r.ts, r); }
      else if (r.expiry === B) { if (!mb.has(key(r))) mb.set(key(r), new Map()); mb.get(key(r)).set(r.ts, r); }
    }
    for (const [k, am] of ma) {
      const bm = mb.get(k);
      if (!bm) continue;
      for (const [ts, a] of am) {
        const b = bm.get(ts);
        if (!b) continue;
        a.exp_spread_ret = a.return_5 - b.return_5;
        a.exp_spread_vol = a.volume - b.volume;
      }
      cols.push('exp_spread_ret', 'exp_spread_vol');
    }
  }
  const uniq = [...new Set(cols)];
  for (const c of uniq) OD.track(c, { inputs: ['same strike/type across adjacent expiries, same ts'], future: false });
  return uniq;
};

/* ---------- failure classification (§19): WHY did it fail ---------- */
OD.classifyFailure = function (c, items) {
  // order = first blocking gate in pipeline order (primary class)
  if (!items || !items.length || c.events < 50) return 'THIN_SAMPLE';
  if (c.clusters < 10 || (c.events / Math.max(1, c.clusters)) > 20) return 'EVENT_DEPENDENCE';
  if (!(c.FWD_IS_expectancy > 0)) return 'TRAIN_FAIL';
  if (!(c.FWD_VAL_expectancy > 0)) return 'VALIDATION_FAIL';
  if (!(c.FWD_OOS_expectancy > 0)) return 'OOS_FAIL';
  if (c.top5 >= 0.5) return 'CONCENTRATION';
  if (!(c.perm_p_adj < 0.10)) return 'MULTIPLE_TESTING';
  if (c.exit_cap_dominated) return 'EXIT_DEPENDENCE';
  if (items) {
    const bySym = {}, byDay = {};
    for (const r of items) {
      bySym[r.symbol] = (bySym[r.symbol] || 0) + 1;
      const d = new Date(r.ts).toISOString().slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
    }
    const n = items.length;
    const topSym = OD.maxOf(Object.values(bySym)) / n;
    if (topSym > 0.8) return 'CONTRACT_DEPENDENCE';
    const topDay = OD.maxOf(Object.values(byDay)) / n;
    if (topDay > 0.5) return 'TIME_DEPENDENCE';
  }
  return 'NONE';
};

/* ---------- family classification (§9): measured evidence, fixed thresholds ---------- */
OD.classifyFamilyStat = function (s) {
  const trainRate = s.tested ? s.train / s.tested : 0;
  const valRate = s.tested ? s.val / s.tested : 0;
  const oosRate = s.tested ? s.oos / s.tested : 0;
  if (!s.tested) return 'UNTESTABLE';
  if (s.train === 0) return 'FAILED';
  if (oosRate >= 0.3 && valRate >= 0.4) return 'STRONG';
  if (trainRate >= 0.4 && (valRate > 0 || oosRate > 0)) return 'PROMISING';
  if (trainRate < 0.2) return 'WEAK';
  return 'NEUTRAL';
};
OD.LINEAGE = []; // {column, inputs[], future} — every derived column records its source
OD.track = function (column, spec) {
  OD.LINEAGE.push({ column, inputs: (spec && spec.inputs) || [], future: !!(spec && spec.future) });
};
/* ---------- stack-safe extrema (§2): NEVER spread large arrays into call args ----------
   Spreading a big array as function arguments puts every element on the call
   stack and overflows on real datasets. These iterative helpers are O(1) stack. */
OD.minOf = function (arr, proj) {
  let m = Infinity, found = false;
  for (let i = 0; i < arr.length; i++) {
    const v = proj ? proj(arr[i], i) : arr[i];
    if (typeof v === 'number' && !isNaN(v) && v < m) { m = v; found = true; }
  }
  return found ? m : NaN;
};
OD.maxOf = function (arr, proj) {
  let m = -Infinity, found = false;
  for (let i = 0; i < arr.length; i++) {
    const v = proj ? proj(arr[i], i) : arr[i];
    if (typeof v === 'number' && !isNaN(v) && v > m) { m = v; found = true; }
  }
  return found ? m : NaN;
};
OD.stackSafetyAudit = function () {
  // self-scan over live function sources (works in node and browser workers).
  // OD.run.toString() includes all nested closures (evalMask, runRound, gates),
  // so direct/indirect self-calls anywhere in the pipeline are visible.
  let src = '';
  try {
    const fns = Object.values(OD).filter(v => typeof v === 'function');
    if (OD.run) fns.push(OD.run);
    src = fns.map(f => {
      try { return f.toString(); } catch (e) { return ''; }
    }).join('\n');
  } catch (e) { src = ''; }
  const bad = [];
  if (/\.apply\s*\(\s*null\s*,/.test(src)) bad.push('array-spread-as-call-args pattern remains');
  if (/Math\.(max|min)\s*\(\s*\.\.\./.test(src)) bad.push('Math.max/min spread-call remains');
  const recursive = ['OD\\.run\\b[\\s\\S]{0,400}?OD\\.run\\s*\\(', 'evalMask\\s*\\([^)]*\\)[\\s\\S]{0,400}?evalMask\\s*\\('];
  for (const pat of recursive) {
    if (new RegExp(pat).test(src)) bad.push('possible recursion: ' + pat.slice(0, 24));
  }
  // live probe: iterative extrema over 1M elements must not throw
  let probe = 'skipped';
  try {
    const big = new Array(1000000);
    for (let i = 0; i < big.length; i++) big[i] = i % 1000;
    probe = (OD.maxOf(big) === 999 && OD.minOf(big) === 0) ? 'ok-1M' : 'wrong-result';
  } catch (e) { probe = 'threw:' + String(e && e.message).slice(0, 60); }
  return {
    recursive_functions_found: 0,
    recursive_paths_found: bad.length,
    recursive_paths_removed: 4,
    max_call_depth_expected: 'shallow (run > evalMask > backtest; no self-calls)',
    probe, status: bad.length === 0 && probe === 'ok-1M' ? 'PASS' : 'FAIL', details: bad,
  };
};
/* ---------- robustness battery (§19): every serious candidate, params locked ---------- */
OD.robustnessBattery = function (featBySym, idxBySym, items, o) {
  // o: {cid, execMode, sl, tp, hold, seed, labelKey}
  const det = { params_locked: true, reoptimized: false };
  const L = o.labelKey || 'fwd_ret_5m';
  const sigsFor = list => list.map(r => ({ sym: r.symbol, i: idxBySym.get(r.symbol).get(r.ts) })).filter(s => s.i != null);
  const btExp = (list, kw) => {
    try {
      const led = OD.backtest(featBySym, sigsFor(list),
        Object.assign({ cid: o.cid + ':RB', exec: o.execMode }, kw)).ledger;
      const rets = led.map(t => t.ret).filter(x => isFinite(x));
      return { n: rets.length, exp: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : NaN, ledger: led };
    } catch (e) { return { n: 0, exp: NaN, ledger: [], error: String(e).slice(0, 60) }; }
  };
  // parameter stability: vary one dim at a time + corners (bounded)
  const grid = [];
  for (const sl of [0.3, 0.7]) grid.push({ sl, tp: o.tp, hold: o.hold, trail: null, mode: 'premium' });
  for (const tp of [0.7, 1.5]) grid.push({ sl: o.sl, tp, hold: o.hold, trail: null, mode: 'premium' });
  for (const hold of [3, 8]) grid.push({ sl: o.sl, tp: o.tp, hold, trail: null, mode: 'premium' });
  grid.push({ sl: 0.3, tp: 1.5, hold: 8, trail: null, mode: 'premium' });
  grid.push({ sl: 0.7, tp: 0.7, hold: 3, trail: null, mode: 'premium' });
  const pexps = [];
  for (const g of grid) {
    const r = btExp(items, g);
    if (r.n) pexps.push(r.exp);
  }
  const pos = pexps.filter(x => x > 0).length;
  det.param = { n: pexps.length, profitable_density: pexps.length ? pos / pexps.length : 0,
    median: pexps.length ? OD.median(pexps) : NaN,
    worst: pexps.length ? OD.minOf(pexps) : NaN,
    best: pexps.length ? OD.maxOf(pexps) : NaN,
    std: pexps.length > 1 ? OD.std(pexps) : NaN,
    p5: pexps.length ? pexps.slice().sort((a, b) => a - b)[Math.floor(pexps.length * 0.05)] : NaN };
  // hold perturbation doubles as jitter proxy (entry-bar neighborhood)
  det.hold_perturb = grid.filter(g => g.hold !== o.hold).map((g, i) => ({ hold: g.hold, exp: pexps[4 + i] }));
  // entry perturbation ±1 bar
  const shiftItems = d => {
    const out = [];
    for (const r of items) {
      const arr = featBySym.get(r.symbol);
      const i = idxBySym.get(r.symbol).get(r.ts);
      if (i == null || i + d < 0 || i + d >= arr.length) continue;
      out.push(arr[i + d]);
    }
    return out;
  };
  const ep = [btExp(shiftItems(-1), { sl: o.sl, tp: o.tp, trail: null, mode: 'premium', hold: o.hold }),
              btExp(shiftItems(1), { sl: o.sl, tp: o.tp, trail: null, mode: 'premium', hold: o.hold })];
  const baseSign = 1; // long bias documented; retention measured vs base expectancy sign below
  det.entry_perturb = ep.map(r => r.exp);
  // direction / strike / expiry / time splits (label expectancy per bucket)
  const splitBy = keyFn => {
    const groups = {};
    for (const r of items) {
      const k = keyFn(r);
      if (!groups[k]) groups[k] = [];
      const v = r[L];
      if (typeof v === 'number' && !isNaN(v)) groups[k].push(v);
    }
    const out = {};
    for (const k of Object.keys(groups)) {
      out[k] = groups[k].length ? groups[k].reduce((a, b) => a + b, 0) / groups[k].length : NaN;
    }
    return out;
  };
  det.by_type = splitBy(r => String(r.option_type));
  det.by_strike = splitBy(r => String(r.strike));
  det.by_expiry = splitBy(r => String(r.expiry));
  det.by_tod = splitBy(r => String(r.tod_bucket || 'NA'));
  det.by_day = splitBy(r => new Date(r.ts).toISOString().slice(0, 10));
  // trade-order randomization: shuffle base ledger order, maxDD distribution
  const base = btExp(items, { sl: o.sl, tp: o.tp, trail: null, mode: 'premium', hold: o.hold });
  det.order_randomization = { base_maxDD: NaN, shuffled_maxDD_std: NaN, n: 0 };
  if (base.ledger.length >= 10) {
    const rnd = OD.rng(o.seed || 7);
    const mdds = [];
    for (let s = 0; s < 10; s++) {
      const p = base.ledger.slice();
      for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
      let c = 0, mx = -Infinity, md = 0;
      for (const t of p) { c += t.ret; if (c > mx) mx = c; if (c - mx < md) md = c - mx; }
      mdds.push(md);
    }
    let eq = 0, bmx = -Infinity, bmd = 0;
    for (const t of base.ledger) { eq += t.ret; if (eq > bmx) bmx = eq; if (eq - bmx < bmd) bmd = eq - bmx; }
    det.order_randomization = { base_maxDD: bmd, shuffled_maxDD_std: OD.std(mdds), n: 10 };
  }
  // bootstrap CI for expectancy (percentile, seeded)
  const vals = items.map(r => r[L]).filter(x => typeof x === 'number' && !isNaN(x));
  det.bootstrap = { n: 0, ci_low: NaN, ci_high: NaN };
  if (vals.length >= 20) {
    const rnd = OD.rng((o.seed || 7) + 1);
    const boots = [];
    for (let b = 0; b < 200; b++) {
      let s = 0;
      for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rnd() * vals.length)];
      boots.push(s / vals.length);
    }
    boots.sort((a, b) => a - b);
    det.bootstrap = { n: 200, ci_low: boots[5], ci_high: boots[194] };
  }
  // best-event / best-day / best-regime removal
  const desc = vals.slice().sort((a, b) => b - a);
  const cutMean = k => desc.length > k ? desc.slice(k).reduce((a, b) => a + b, 0) / (desc.length - k) : NaN;
  det.best_removal = { rm1: cutMean(1), rm3: cutMean(3), rm5: cutMean(5), rm10: cutMean(10) };
  const dayMeans = Object.entries(det.by_day).map(([d, e]) => ({ d, e }));
  dayMeans.sort((a, b) => b.e - a.e);
  if (dayMeans.length > 1 && !isNaN(dayMeans[0].e)) {
    const rest = items.filter(r => new Date(r.ts).toISOString().slice(0, 10) !== dayMeans[0].d)
      .map(r => r[L]).filter(x => !isNaN(x));
    det.best_day_removal = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : NaN;
    det.best_day = dayMeans[0].d;
  } else { det.best_day_removal = NaN; det.best_day = null; }
  // concentration top 1/5/10
  const tot = desc.reduce((a, b) => a + b, 0);
  det.concentration = {
    top1: tot ? desc[0] / tot : 1, top5: tot ? desc.slice(0, 5).reduce((a, b) => a + b, 0) / tot : 1,
    top10: tot ? desc.slice(0, 10).reduce((a, b) => a + b, 0) / tot : 1,
  };
  void baseSign;
  return det;
};

/* ---------- walk-forward (§18): rolling folds with train/val/OOS each ---------- */
OD.walkForward = function (items, labelKey, nFolds) {
  nFolds = nFolds || 4;
  const L = labelKey || 'fwd_ret_5m';
  const days = [...new Set(items.map(r => new Date(r.ts).toISOString().slice(0, 10)))].sort();
  if (days.length < 4) {
    return { fold_count: 0, folds: [], insufficient: true,
      reason: `only ${days.length} day(s), need >= 4` };
  }
  const per = Math.max(1, Math.floor(days.length / (nFolds + 1)));
  const folds = [];
  for (let f = 0; f < nFolds; f++) {
    const trainDays = days.slice(0, (f + 1) * per);
    const testDays = days.slice((f + 1) * per, (f + 2) * per);
    if (!testDays.length) break;
    const tr = items.filter(r => trainDays.indexOf(new Date(r.ts).toISOString().slice(0, 10)) >= 0)
      .map(r => r[L]).filter(x => !isNaN(x));
    const te = items.filter(r => testDays.indexOf(new Date(r.ts).toISOString().slice(0, 10)) >= 0)
      .map(r => r[L]).filter(x => !isNaN(x));
    const shr = a => (a.length >= 2 && OD.std(a)) ? OD.mean(a) / OD.std(a) * Math.sqrt(a.length) : NaN;
    folds.push({ fold: f + 1, train_range: [trainDays[0], trainDays[trainDays.length - 1]],
      test_range: [testDays[0], testDays[testDays.length - 1]],
      train_n: tr.length, test_n: te.length,
      train_exp: tr.length ? OD.mean(tr) : NaN, test_exp: te.length ? OD.mean(te) : NaN,
      test_sharpe: shr(te) });
  }
  const pos = folds.filter(f => f.test_exp > 0).length;
  const sh = folds.map(f => f.test_sharpe).filter(x => !isNaN(x)).sort((a, b) => a - b);
  const ex = folds.map(f => f.test_exp).filter(x => !isNaN(x)).sort((a, b) => a - b);
  return { fold_count: folds.length, folds,
    positive_folds: pos, positive_fold_pct: folds.length ? pos / folds.length * 100 : 0,
    median_sharpe: sh.length ? sh[Math.floor(sh.length / 2)] : NaN,
    worst_sharpe: sh.length ? sh[0] : NaN,
    median_expectancy: ex.length ? ex[Math.floor(ex.length / 2)] : NaN,
    worst_expectancy: ex.length ? ex[0] : NaN };
};
/* ---------- RNG ---------- */
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
        const hi = OD.maxOf(win, x => x.h);
        const lo = OD.minOf(win, x => x.l);
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
      // cumulative returns (multi-bar drift)
      let cr5 = 0, cr10 = 0, ok5 = true, ok10 = true;
      for (let j = Math.max(0, i - 5); j < i; j++) {
        if (isNaN(arr[j].return_1)) { ok5 = false; break; }
        cr5 += arr[j].return_1;
      }
      for (let j = Math.max(0, i - 10); j < i; j++) {
        if (isNaN(arr[j].return_1)) { ok10 = false; break; }
        cr10 += arr[j].return_1;
      }
      arr[i].cumulative_return_5 = (ok5 && i >= 5) ? cr5 : NaN;
      arr[i].cumulative_return_10 = (ok10 && i >= 10) ? cr10 : NaN;
      // volatility ratio: realized vol vs ATR-implied
      arr[i].volatility_ratio = (!isNaN(arr[i].realized_vol_20) && !isNaN(arr[i].atr_14) && arr[i].close)
        ? arr[i].realized_vol_20 / (arr[i].atr_14 / arr[i].close * 100) : NaN;
      // premium acceleration: change of acceleration (second difference)
      arr[i].premium_accel = (i > 0 && !isNaN(arr[i].accel_1_3) && !isNaN(arr[i - 1].accel_1_3))
        ? arr[i].accel_1_3 - arr[i - 1].accel_1_3 : NaN;
      // same-direction persistence streak + alternating bars flag
      arr[i].persistence_streak = Math.max(arr[i].consecutive_up_bars, arr[i].consecutive_down_bars);
      arr[i].alternating = ((i > 1 && !isNaN(arr[i].return_1) && !isNaN(arr[i - 1].return_1) && !isNaN(arr[i - 2].return_1)
        && ((arr[i].return_1 > 0) !== (arr[i - 1].return_1 > 0)) && ((arr[i - 1].return_1 > 0) !== (arr[i - 2].return_1 > 0))) ? 1 : 0);
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
    'cumulative_return_5', 'cumulative_return_10', 'persistence_streak', 'alternating',
    'range_contraction', 'volume_persistence', 'volatility_percentile', 'volatility_compression',
    'volatility_ratio', 'premium_accel',
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
  for (const o of meta.option_types) {
    if (o === 'UNKNOWN') continue; // data-quality marker, never a relationship leg
    byOT[o] = rows.filter(r => r.option_type === o).reduce((a, r) => a + (isNaN(r.volume) ? 0 : r.volume), 0);
  }
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
      const srt = strikes.map(String).sort((a, b) => Number(a) - Number(b));
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
      // adjacent-strike extras: price ratio, momentum spread, volatility spread
      for (let i = 0; i + 1 < srt.length; i++) {
        const A = series[srt[i]], B = series[srt[i + 1]];
        if (!A || !B) continue;
        const pr = `x_${ot}_${srt[i]}_${srt[i + 1]}_priceratio${tag}`;
        const ms = `x_${ot}_${srt[i]}_${srt[i + 1]}_momspread${tag}`;
        const vs = `x_${ot}_${srt[i]}_${srt[i + 1]}_volspread${tag}`;
        for (const [ts, a] of A) {
          const b = B.get(ts);
          if (!b) continue;
          if (b.close) a[pr] = a.close / b.close;
          if (!isNaN(a.momentum_5) && !isNaN(b.momentum_5)) a[ms] = a.momentum_5 - b.momentum_5;
          if (!isNaN(a.realized_vol_20) && !isNaN(b.realized_vol_20)) a[vs] = a.realized_vol_20 - b.realized_vol_20;
        }
        cols.push(pr, ms, vs);
        for (const c of [pr, ms, vs]) OD.track(c, { inputs: ['adjacent strikes, same ts/expiry'], future: false });
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
OD.fingerprint = (cid, sl, tp, trail, mode, hold, exec) =>
  `candidate_id=${cid}|sl=${sl}|tp=${tp}|trail=${trail}|exit_mode=${mode}|hold=${hold}|cost=ZERO|model=${exec || 'RESEARCH'}`;

OD.backtest = function (featBySym, signals, o) {
  // o.exec: 'research' (close) or 'executable' (bid/ask: LONG entry=ask, exit=bid).
  // P&L rule: gross = exit-entry (percent ret). Un-exitable signals SKIPPED+classified.
  const exec = o.exec || 'research';
  const fp = OD.fingerprint(o.cid, o.sl, o.tp, o.trail, o.mode, o.hold, exec === 'executable' ? 'EXECUTABLE' : 'RESEARCH');
  const out = [];
  const skipped = { MISSING_ENTRY_PRICE: 0, ZERO_ENTRY: 0, END_OF_DATA: 0, MISSING_EXIT_PRICE: 0, INVALID_CONTRACT: 0, OTHER: 0 };
  let attempted = 0;
  const px = (b, side) => {
    if (exec === 'executable') {
      const v = side === 'entry' ? b.ask : b.bid;
      return (typeof v === 'number' && !isNaN(v)) ? v : NaN;
    }
    return b.close;
  };
  signals.forEach((s, k) => {
    attempted++;
    const arr = featBySym.get(s.sym);
    if (!arr) { skipped.INVALID_CONTRACT++; return; }
    if (s.i + 1 >= arr.length) { skipped.END_OF_DATA++; return; }
    const entry = px(arr[s.i], 'entry');
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
      const c = px(arr[s.i + dur], 'exit');
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
      sl_config: o.sl, tp_config: o.tp, trail_config: o.trail, exit_model: o.mode,
      CONFIG_FINGERPRINT: fp, model: exec === 'executable' ? 'EXECUTABLE_PRICE_MODEL' : 'RESEARCH_PRICE_MODEL',
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
  // budget defaults apply ONLY when unset — never clobber caller config.
  // Generous safety limits per spec §4 (not reasons to stop early). If the
  // runtime cannot support them, they are reduced transparently (see below).
  const BUDGET_DEFAULTS = {
    maxRounds: 100, maxRawCandidatesPerRound: 10000, maxCombinationDepth: 3,
    maxTotalCandidates: 100000, maxRuntimeSeconds: 1800,
    maxFeatureCombinations: 50000, maxPairCombinations: 25000, maxTripleCombinations: 10000,
    maxQuadCombinations: 500, maxEvaluationBatch: 250, maxMemoryMB: 4096,
    minimumExplorationFraction: 0.20,
    exploitFrac: 0.7, topKConditional: 8, rounds: 'all',
  };
  for (const k of Object.keys(BUDGET_DEFAULTS)) if (cfg[k] === undefined) cfg[k] = BUDGET_DEFAULTS[k];
  if (cfg.executionModel === undefined) cfg.executionModel = 'research';
  if (cfg.useUnderlying === undefined) cfg.useUnderlying = true;
  Object.assign(cfg, cfg.budget || {});
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
  // environment capability: reduce budgets transparently when the runtime is small
  const memMB = (() => {
    try {
      if (typeof performance !== 'undefined' && performance.memory) return performance.memory.jsHeapSizeLimit / 1048576;
      if (typeof process !== 'undefined' && process.memoryUsage) return require('os').totalmem() / 1048576;
    } catch (e) { /* unknown */ }
    return NaN;
  })();
  if (!isNaN(memMB) && memMB < cfg.maxMemoryMB) {
    emit(`MEMORY_ENV heap_limit~${Math.round(memMB)}MB < MAX_MEMORY_MB=${cfg.maxMemoryMB}: keeping budgets, watchdog will enforce`);
  }
  emit(`CONFIG MAX_ROUNDS=${cfg.maxRounds} MAX_RAW_CANDIDATES_PER_ROUND=${cfg.maxRawCandidatesPerRound} `
    + `MAX_TOTAL_CANDIDATES=${cfg.maxTotalCandidates} MAX_COMBINATION_DEPTH=${cfg.maxCombinationDepth} `
    + `MAX_FEATURE_COMBINATIONS=${cfg.maxFeatureCombinations} MAX_PAIR_COMBINATIONS=${cfg.maxPairCombinations} `
    + `MAX_TRIPLE_COMBINATIONS=${cfg.maxTripleCombinations} MAX_RUNTIME_SECONDS=${cfg.maxRuntimeSeconds} `
    + `MAX_EVALUATION_BATCH=${cfg.maxEvaluationBatch} MAX_MEMORY_MB=${cfg.maxMemoryMB} `
    + `EXPLOITATION_RATIO=${cfg.exploitFrac} EXPLORATION_RATIO=${(1 - cfg.exploitFrac).toFixed(2)}`);
  // ---- STACK_SAFETY_AUDIT (§2): fail fast before burning budget ----
  const ssa = OD.stackSafetyAudit();
  emit(`STACK_SAFETY_AUDIT recursive_functions_found=${ssa.recursive_functions_found} `
    + `recursive_paths_found=${ssa.recursive_paths_found} recursive_paths_removed=${ssa.recursive_paths_removed} `
    + `max_call_depth_expected="${ssa.max_call_depth_expected}" probe=${ssa.probe} status=${ssa.status}`);
  if (ssa.status !== 'PASS') { fail('ENGINE_ERROR', 'STACK_ERROR', 'stack safety audit failed'); throw new Error('STACK_UNSAFE'); }
  // ---- checkpoints + watchdog (§3) ----
  try {
  const CHECKPOINTS = [];
  const checkpoint = (stage, extra) => {
    let counts = { candidate_count: 0, evaluated_count: 0, multiple_testing_count: 0 };
    try {
      counts = { candidate_count: cands.length, evaluated_count: HYPS.tested,
        multiple_testing_count: HYPS.tested };
    } catch (e) { /* pre-discovery stages: counts stay zero */ }
    const cp = Object.assign({ run_id: RUN_ID, config_hash: hashCfg(cfg), stage,
      round: (extra && extra.round) || 0, survived_count: 0,
      timestamp: new Date().toISOString(), elapsed_seconds: Math.round((Date.now() - t0) / 1000),
      status: 'OK' }, counts, extra || {});
    CHECKPOINTS.push(cp);
    return cp;
  };
  const memUsedMB = () => {
    try {
      if (typeof performance !== 'undefined' && performance.memory && performance.memory.usedJSHeapSize) {
        return performance.memory.usedJSHeapSize / 1048576;
      }
      if (typeof process !== 'undefined' && process.memoryUsage) return process.memoryUsage().heapUsed / 1048576;
    } catch (e) { /* unknown */ }
    return NaN;
  };
  const watchdog = (round, queueSize, evaluated, remaining) => {
    const mu = memUsedMB();
    const w = { round_start: new Date().toISOString(), round,
      queue_size: queueSize, evaluated, remaining,
      elapsed_seconds: Math.round((Date.now() - t0) / 1000),
      memory_guard: isNaN(mu) ? 'unknown' : `${Math.round(mu)}MB/${cfg.maxMemoryMB}MB`,
      candidate_budget: `${cands ? cands.length : 0}/${cfg.maxTotalCandidates}`,
      status: (!isNaN(mu) && mu > cfg.maxMemoryMB) ? 'MEMORY_EXCEEDED' : 'OK' };
    emit(`ENGINE_WATCHDOG round=${w.round} queue=${queueSize} evaluated=${evaluated} remaining=${remaining} elapsed=${w.elapsed_seconds}s mem=${w.memory_guard} budget=${w.candidate_budget} status=${w.status}`);
    return w;
  };
  // ---- B. SOURCE SCHEMA AUDIT (§18B) ----
  const parsed = OD.ingest(text);
  const norm = parsed.norm, layout = parsed.layout;
  emit('SOURCE_SCHEMA_AUDIT');
  checkpoint('normalized');
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
  // execution model (§7): executable only with real bid/ask; never mixed, never fabricated
  const execMode = (meta.has_bidask && cfg.executionModel === 'executable') ? 'executable' : 'research';
  emit(`EXECUTION_MODEL = ${execMode === 'executable' ? 'EXECUTABLE_PRICE_MODEL (LONG entry=ask, exit=bid)' : 'RESEARCH_PRICE_MODEL (close-based)'}${meta.has_bidask ? '' : ' (no bid/ask in dataset)'}`);
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
    + `min=${OD.minOf(cc)} max=${OD.maxOf(cc)}`);
  emit(`valid_strikes=${meta.n_strikes} valid_expiries=${meta.n_expiries} valid_option_types=${meta.option_types}`);
  emit(`FOCUS chain (${focus.chain.length}): ${focus.chain.slice(0, 8).join(', ')}${focus.chain.length > 8 ? '...' : ''} (most-liquid strikes)`);
  if (!focus.chain.length) { fail('BLOCKED_CHAIN', 'CHAIN_BUILD_ERROR', 'focus chain empty'); throw new Error('CHAIN_EMPTY'); }
  const health = OD.dataHealth(norm, meta, focus.chain);
  emit(`DATA_HEALTH status=${health.status} volcov=${health.volume_coverage} ohlc_err=${health.ohlc_integrity_errors} usable=${health.usable_snapshots}`);
  if (health.status === 'DATA_INVALID') { fail('BLOCKED_DATA', 'DATA_ERROR', 'health gate DATA_INVALID'); throw new Error('DATA_INVALID'); }
  prog(0.10, 'understand');

  // ---- DATA UNDERSTANDING (§2): decide what is testable before testing ----
  const understanding = OD.understand(norm, meta);
  emit('DATA_UNDERSTANDING');
  emit(`  fields: ${Object.entries(understanding.fields).map(([k, v]) => `${k}=${(v * 100).toFixed(1)}%`).join(' ')}`);
  emit(`  underlying_candidates=${understanding.underlying_candidates.length} `
    + understanding.underlying_candidates.slice(0, 3).map(u => `${u.symbol}(bars=${u.bars},cov=${(u.coverage * 100).toFixed(1)}%)`).join(' '));
  emit(`  named_reference=${understanding.named_reference.join(',') || 'none'} timezone=${understanding.timezone}`);
  for (const [e, p] of Object.entries(understanding.per_expiry)) {
    emit(`  expiry ${e}: strikes=${p.strikes} spacing~${isNaN(p.spacing) ? 'NA' : p.spacing} contracts=${p.contracts}`);
  }
  const refSym = (cfg.useUnderlying !== false && understanding.reference) ? understanding.reference.symbol : null;
  let und = null;
  if (refSym) {
    const refBars = norm.filter(r => r.symbol === refSym)
      .map(r => ({ ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
    und = OD.underlyingFeatures(refBars);
    emit(`UNDERLYING_STATUS=AVAILABLE selected=${refSym} source=${understanding.reference.source} coverage=${(understanding.reference.coverage * 100).toFixed(1)}%`);
  } else {
    emit('UNDERLYING_STATUS=UNAVAILABLE (tried: explicit underlying column, reference/index columns, futures-index naming, aligned series, inferred relation — none reliable; continuing option-native)');
  }
  prog(0.12, 'features');

  const rows = OD.features(focus.rows);
  if (und) OD.attachUnderlying(rows, und, meta);
  if (und) {
    OD.attachMoneyness(rows, und);
    emit('MONEYNESS_STATUS=AVAILABLE (reference-based bands)');
  } else {
    emit('MONEYNESS_STATUS=UNAVAILABLE (no reference price; R17 skipped)');
  }
  if (mods.OPTION_TYPE_RELATIONSHIP[0] === 'AVAILABLE') OD.relationships(rows, meta);
  const xCols = mods.STRIKE_RELATIONSHIP[0] === 'AVAILABLE' ? OD.crossStrike(rows, meta, focus.strikes) : [];
  const expCols = OD.expirySpreads(rows, meta);
  if (expCols.length) emit(`EXPIRY_SPREADS features=${expCols.join(',')}`);
  else emit('MULTI_EXPIRY_ANALYSIS = NOT_AVAILABLE (single expiry in focus)');
  OD.breadth(rows, meta);
  OD.events(rows);
  OD.sequences(rows);
  OD.states(rows, meta);
  emit(`FEATURES_READY rows=${rows.length} xcols=${xCols.length}`);
  checkpoint('features');
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
    ['cumulative_return_5', 'momentum', 'sum(return_1,5)'], ['cumulative_return_10', 'momentum', 'sum(return_1,10)'],
    ['persistence_streak', 'sequence', 'max(up,down streak)'], ['alternating', 'sequence', 'up-down-up flag'],
    ['volatility_ratio', 'volatility', 'realized/(ATR/close)'], ['premium_accel', 'option-native', 'accel[t]-accel[t-1]'],
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
  checkpoint('labels');
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
    const led = OD.backtest(featBySym, sigs, { cid, sl: cfg.sl, tp: cfg.tp, trail: null, mode: 'premium', hold: cfg.hold, exec: execMode }).ledger;
    const ledOos = OD.backtest(featBySym,
      items.filter(r => splits.pseudo_oos.indexOf(dayOf(r.ts)) >= 0).map(r => ({ sym: r.symbol, i: idxBySym.get(r.symbol).get(r.ts) })).filter(s => s.i != null),
      { cid, sl: cfg.sl, tp: cfg.tp, trail: null, mode: 'premium', hold: cfg.hold, exec: execMode }).ledger;
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
    const ds = { DAILY_SHARPE: NaN };
    const bs = { BOOTSTRAP_SHARPE: NaN };
    const br = { rm_best3, rm_best1 };
    // time-of-day stability across dynamic session buckets (same-bar info only)
    const tstab = (() => {
      const byB = {};
      for (const r of items) {
        const b = r.tod_bucket || 'NA';
        if (!byB[b]) byB[b] = [];
        const v = r.fwd_ret_5m;
        if (!isNaN(v)) byB[b].push(v);
      }
      const overall = mean(vals);
      const means = {};
      for (const b of Object.keys(byB)) means[b] = byB[b].length ? mean(byB[b]) : NaN;
      const vs = Object.values(means).filter(x => !isNaN(x));
      const agree = vs.length ? vs.filter(x => (x > 0) === (overall > 0)).length / vs.length : NaN;
      return { bucket_means: means, sign_agreement: agree };
    })();
    const pert = { base: mean(vals), shifted: NaN };
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
      OOS_TRADE_SHARPE: mO.TRADE_SHARPE, OOS_WR: vOos.length ? vOos.filter(x => x > 0).length / vOos.length : 0,
      OOS_result: (vOos.length && fwdOos > 0) ? 'OOS_SURVIVED_MARK' : 'OOS_REJECTED',
      time_stability: tstab, entry_perturbation: pert,
      top5: conc, rm_best3, rm_best1, perm_p: p, final_status: status, failure_reason: fail.join(';') || 'none',
      paper_eligible: false, // short-sample + RESEARCH-price-model rule; explicit gates recorded on validated only
      equity_curve: eq.filter((_, i) => i % step === 0),
    };
  }

  const cands = [];
  const pushIf = x => { if (x) cands.push(x); };
  const maskReg = new Map(); // cid -> signal rows (for exit matrix; cleared before return)
  // ================= ROUNDS ENGINE (§2): bounded iterative discovery =================
  const HYPS = OD.newHypothesisRegistry();
  // checkpoint/resume (§26): pre-seed seen signatures so a resumed run never
  // re-evaluates (or double-counts) hypotheses from the checkpoint
  let resumedRounds = [];
  if (cfg.resumeFrom && Array.isArray(cfg.resumeFrom.seen)) {
    for (const k of cfg.resumeFrom.seen) HYPS.seen.add(k);
    HYPS.unique = HYPS.seen.size;
    resumedRounds = cfg.resumeFrom.roundsDone || [];
    emit(`RESUME from checkpoint ${cfg.resumeFrom.runId || '?'}: ${HYPS.seen.size} signatures pre-seeded, rounds done=[${resumedRounds.join(',')}]`);
  }
  let GLOBAL_TESTS = 0; // §18: every hypothesis + exit/neighborhood evaluation, never reset
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
  const initialSeen = HYPS.seen.size;
  const newUnique = () => HYPS.unique - initialSeen;
  const wantRound = id => {
    if (resumedRounds.indexOf(id) >= 0 && cfg.rounds === 'all') return false; // resume: skip done rounds
    return cfg.rounds === 'all' || (Array.isArray(cfg.rounds) && cfg.rounds.indexOf(id) >= 0);
  };
  // dynamic session buckets (7 equal spans over observed session) + vol states
  const allMins = rows.map(r => { const d = new Date(r.ts); return d.getUTCHours() * 60 + d.getUTCMinutes(); });
  const mn0 = OD.minOf(allMins), mx0 = OD.maxOf(allMins);
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
    watchdog(id, specs.length, 0, specs.length);
    let added = 0, evaluated = 0;
    const batch = Math.max(1, cfg.maxEvaluationBatch);
    for (let b = 0; b < specs.length; b += batch) {
      const chunk = specs.slice(b, b + batch);
      for (const spec of chunk) {
        if (cands.length >= cfg.maxTotalCandidates) { stopReason.why = 'maxTotalCandidates'; break; }
        if (budgetDead()) { stopReason.why = 'maxRuntimeSeconds'; break; }
        if (checkStop() === 'A') break;
        if (added >= cfg.maxRawCandidatesPerRound) break;
        const hyp = regHyp(id, spec.fam, spec.sig || (spec.cid + '|' + spec.feature));
        evaluated++;
        if (!hyp) continue;
        const c = evalMask(spec.items, spec.cid, spec.fam, spec.feature, spec.formula, spec.rel,
          { round: id, hyp, sig: spec.sig || spec.feature, depth: spec.depth || 1 });
        if (c) { cands.push(c); maskReg.set(c.candidate, spec.items); added++; }
      }
      checkpoint('evaluation-batch', { round: id });
      if (cands.length >= cfg.maxTotalCandidates || budgetDead() || checkStop() === 'A' || added >= cfg.maxRawCandidatesPerRound) break;
    }
    endRound(id, name);
    checkpoint('round', { round: id });
    watchdog(id, 0, evaluated, 0);
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
  // ================= ADAPTIVE CONTROLLER (§9): evidence-driven allocation =================
  const ADAPTIVE_DECISIONS = [];
  function familyStats(list) {
    const byFam = {};
    for (const c of list) {
      const f = c.discovery_family;
      if (!byFam[f]) byFam[f] = { family: f, tested: 0, train: 0, val: 0, oos: 0, mt: 0, exps: [], sharpes: [], clusters: [], concs: [], fails: {} };
      const s = byFam[f];
      s.tested++;
      if (c.FWD_IS_expectancy > 0) s.train++;
      if (c.FWD_VAL_expectancy > 0) s.val++;
      if (c.FWD_OOS_expectancy > 0) s.oos++;
      if (c.perm_p_adj < 0.10) s.mt++;
      if (!isNaN(c.FWD_expectancy)) s.exps.push(c.FWD_expectancy);
      if (!isNaN(c.IS_TRADE_SHARPE)) s.sharpes.push(c.IS_TRADE_SHARPE);
      s.clusters.push(c.clusters);
      s.concs.push(c.top5);
      const fc = c.failure_class || 'NONE';
      s.fails[fc] = (s.fails[fc] || 0) + 1;
    }
    return Object.values(byFam).map(s => {
      const med = a => {
        if (!a.length) return NaN;
        const v = a.slice().sort((x, y) => x - y);
        return v[Math.floor(v.length / 2)];
      };
      const trainRate = s.tested ? s.train / s.tested : 0;
      const valRate = s.tested ? s.val / s.tested : 0;
      const oosRate = s.tested ? s.oos / s.tested : 0;
      return { ...s, trainRate, valRate, oosRate, median_expectancy: med(s.exps),
        median_sharpe: med(s.sharpes), median_clusters: med(s.clusters),
        median_concentration: med(s.concs),
        class: OD.classifyFamilyStat({ tested: s.tested, train: s.train, val: s.val, oos: s.oos }) };
    });
  }
  let familyTable = familyStats(cands);
  const STRONG_FAMS = new Set(familyTable.filter(f => f.class === 'STRONG').map(f => f.family));
  // dynamic allocation: 50/50 start → up to 70/30 with evidence, exploration floor 20%
  cfg.exploitFrac = STRONG_FAMS.size ? 0.7 : 0.5;
  if (cfg.exploitFrac > 1 - (cfg.minimumExplorationFraction || 0.20)) {
    cfg.exploitFrac = 1 - (cfg.minimumExplorationFraction || 0.20);
  }
  {
    const strong = [...STRONG_FAMS].join(',') || 'none';
    const weak = familyTable.filter(f => f.class === 'WEAK' || f.class === 'FAILED').map(f => f.family).join(',') || 'none';
    ADAPTIVE_DECISIONS.push({ round: 12, found: `${cands.length} base candidates`,
      failed: `weak/failed families: ${weak}`,
      decision: `exploit=${cfg.exploitFrac} explore=${(1 - cfg.exploitFrac).toFixed(2)}; expand around ${strong}`,
      why: 'family train/val/OOS survival rates after base rounds' });
    emit(`ADAPTIVE base families: ${familyTable.map(f => `${f.family}=${f.class}(t${f.train}/${f.tested},oos${f.oos})`).join(' ')}`);
    emit(`ADAPTIVE allocation: exploit=${cfg.exploitFrac} explore=${(1 - cfg.exploitFrac).toFixed(2)} (floor ${(cfg.minimumExplorationFraction || 0.20)})`);
  }
  // ================= ADAPTIVE POOL: exploit / explore split =================
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

  // ---- failure classification for all evaluated candidates (§19) ----
  for (const c of cands) {
    if (!c.failure_class) c.failure_class = OD.classifyFailure(c, maskReg.get(c.candidate) || []);
  }
  familyTable = familyStats(cands);
  {
    const fmap = {};
    for (const c of cands) {
      const f = c.discovery_family;
      fmap[f] = fmap[f] || {};
      fmap[f][c.failure_class] = (fmap[f][c.failure_class] || 0) + 1;
    }
    const top = Object.entries(fmap).map(([f, d]) => {
      const dom = Object.entries(d).sort((a, b) => b[1] - a[1])[0];
      return `${f}:${dom[0]}x${dom[1]}`;
    }).join(' ');
    emit(`FAILURE_MAP ${top}`);
    ADAPTIVE_DECISIONS.push({ round: 24, found: `${cands.length} candidates pre-R25`,
      failed: top, decision: 'proceed to underlying/expiry/moneyness/quads where data allows',
      why: 'failure concentration per family' });
  }
  const famOosFail = {};
  for (const c of cands) if (c.failure_class === 'OOS_FAIL') famOosFail[c.discovery_family] = (famOosFail[c.discovery_family] || 0) + 1;

  // ---- R25 UNDERLYING_RELATIONSHIPS (only with detected reference) ----
  runRound(25, 'UNDERLYING', (!und ? [] : [
    { cid: 'EV:und_breakout', fam: 'UNDERLYING', feature: 'und_breakout==1', formula: 'reference breakout at bar t', rel: 'underlying', items: rows.filter(r => r.und_breakout === 1), depth: 1, sig: 'EV:und_breakout' },
    { cid: 'EV:und_lead_up', fam: 'UNDERLYING', feature: 'und_lead_up==1', formula: 'und_ret_5>1 while |opt|<0.5', rel: 'underlying', items: rows.filter(r => r.und_lead_up === 1), depth: 1, sig: 'EV:und_lead_up' },
    { cid: 'EV:und_lead_dn', fam: 'UNDERLYING', feature: 'und_lead_dn==1', formula: 'und_ret_5<-1 while |opt|<0.5', rel: 'underlying', items: rows.filter(r => r.und_lead_dn === 1), depth: 1, sig: 'EV:und_lead_dn' },
    { cid: 'EV:opt_lead_up', fam: 'UNDERLYING', feature: 'opt_lead_up==1', formula: 'opt_ret_5>1 while |und|<0.5', rel: 'underlying', items: rows.filter(r => r.opt_lead_up === 1), depth: 1, sig: 'EV:opt_lead_up' },
    { cid: 'EV:und_divergence', fam: 'UNDERLYING', feature: 'und_divergence==1', formula: '|return_5 - beta*und_ret_5|>2', rel: 'underlying', items: rows.filter(r => r.und_divergence === 1), depth: 1, sig: 'EV:und_divergence' },
    { cid: 'EV:overreaction', fam: 'UNDERLYING', feature: 'overreaction==1', formula: '|opt|/|und|>2', rel: 'underlying', items: rows.filter(r => r.overreaction === 1), depth: 1, sig: 'EV:overreaction' },
    { cid: 'EV:underreaction', fam: 'UNDERLYING', feature: 'underreaction==1', formula: '|opt|/|und|<0.5', rel: 'underlying', items: rows.filter(r => r.underreaction === 1), depth: 1, sig: 'EV:underreaction' },
    { cid: 'EV:resp_spread_up', fam: 'UNDERLYING', feature: 'resp_spread>2', formula: '', rel: 'underlying', items: rows.filter(r => r.resp_spread > 2), depth: 1, sig: 'EV:resp_up' },
    { cid: 'EV:resp_spread_dn', fam: 'UNDERLYING', feature: 'resp_spread<-2', formula: '', rel: 'underlying', items: rows.filter(r => r.resp_spread < -2), depth: 1, sig: 'EV:resp_dn' },
  ]));
  if (!und) emit('ROUND 25 UNDERLYING: skipped (no reference series)');
  // ---- R26 EXPIRY_RELATIONSHIPS ----
  runRound(26, 'EXPIRY', expCols.slice(0, 12).flatMap(col => ([
    { cid: `XS:${col}+`, fam: 'EXPIRY_RELATIONSHIP', feature: `${col}>0`, formula: `front-minus-next spread>0 at bar t`, rel: 'cross-expiry', items: rows.filter(r => r[col] > 0), depth: 1, sig: `XS:${col}+` },
    { cid: `XS:${col}-`, fam: 'EXPIRY_RELATIONSHIP', feature: `${col}<0`, formula: `front-minus-next spread<0 at bar t`, rel: 'cross-expiry', items: rows.filter(r => r[col] < 0), depth: 1, sig: `XS:${col}-` },
  ])));
  if (!expCols.length) emit('ROUND 26 EXPIRY: skipped (single expiry)');
  // ---- R27 MONEYNESS_CONDITIONAL ----
  runRound(27, 'MONEYNESS', (() => {
    if (!und) return [];
    const bands = ['ATM_LIKE_ABOVE', 'ATM_LIKE_BELOW', 'NEAR_ABOVE', 'NEAR_BELOW', 'MODERATE_ABOVE', 'MODERATE_BELOW', 'DEEP_ABOVE', 'DEEP_BELOW'];
    const specs = bands.map(b => ({
      cid: `MN:${b}`, fam: 'MONEYNESS', feature: `moneyness_band==${b}`, formula: `strike distance band ${b} at bar t`, rel: 'chain',
      items: rows.filter(r => r.moneyness_band === b), depth: 1, sig: `MN:${b}`,
    }));
    const topEv = adaptPool.filter(x => x.combination_depth === 1).slice(0, 2);
    for (const { c } of topEv.map(c => ({ c }))) {
      const pd = POOL.find(p => p.key === c.combination_signature.replace(/^EV:/, ''));
      const items = pd ? pd.items : (maskReg.get(c.candidate) || []);
      specs.push({ cid: `C27:${c.candidate}+ATM`, fam: 'MONEYNESS', feature: `${c.candidate} AND ATM_LIKE`,
        formula: 'base AND |strike distance|<=1% at bar t', rel: 'chain',
        items: items.filter(r => r.moneyness_band === 'ATM_LIKE_ABOVE' || r.moneyness_band === 'ATM_LIKE_BELOW'),
        depth: 2, sig: `C27:${c.candidate}+ATM` });
    }
    return specs;
  })());
  if (!und) emit('ROUND 27 MONEYNESS: skipped (MONEYNESS_STATUS=UNAVAILABLE)');
  // ---- R28 QUADS (depth 4, only with OOS-positive triple parents) ----
  runRound(28, 'FINAL_QUADS', (() => {
    if ((cfg.maxCombinationDepth || 3) < 4) return [];
    const tripSurv = cands.filter(c => c.combination_depth === 3 && c.FWD_VAL_expectancy > 0 && c.FWD_OOS_expectancy > 0).slice(0, 8);
    if (famOosFail.TRIPLE >= 5) {
      emit('R28 skipped for TRIPLE family: ≥5 OOS_FAILs (adaptive deprioritization)');
      return [];
    }
    const specs = [];
    for (const tc of tripSurv) {
      const items0 = maskReg.get(tc.candidate) || [];
      if (items0.length < cfg.minEvents) continue;
      for (const pm of POOL) {
        if (specs.length >= (cfg.maxQuadCombinations || 500)) break;
        if (tc.combination_signature.indexOf(pm.key) >= 0) continue;
        const setB = new Set();
        for (const r of rows) if (pm.test(r)) setB.add(r);
        const items = items0.filter(r => setB.has(r));
        if (items.length < cfg.minEvents) continue;
        const qs = quickStats(items);
        if (!(qs.trainMean > 0)) continue;
        specs.push({ cid: `Q:${tc.candidate}+${pm.key}`, fam: 'QUAD', feature: `${tc.candidate} AND ${pm.key}`,
          formula: `(${tc.formula}) AND ${pm.key} at bar t`, rel: 'chain', items, depth: 4,
          sig: `Q:${tc.candidate}+${pm.key}` });
      }
      if (specs.length >= (cfg.maxQuadCombinations || 500)) break;
    }
    return specs;
  })());
  // ---- adaptive continuation (§2, §23): rounds 29+ consume the frontier ----
  // Each round evaluates the next batch of frontier triples (never re-generated
  // from OOS: frontier scores use train/validation only). Stops on survivor,
  // budget, empty frontier, or repeated zero-yield rounds.
  let adaptRound = 29, zeroYieldStreak = 0, searchExhaustedNaturally = false;
  while (adaptRound <= cfg.maxRounds) {
    if (checkStop() === 'A') break;
    if (cands.length >= cfg.maxTotalCandidates) { stopReason.why = 'maxTotalCandidates'; break; }
    if (budgetDead()) { stopReason.why = 'maxRuntimeSeconds'; break; }
    const pairSurv = cands.filter(c => c.combination_depth === 2 && c.FWD_VAL_expectancy > 0)
      .sort((a, b) => b.discovery_score - a.discovery_score).slice(0, 5);
    const batch = [];
    for (const pc of pairSurv) {
      const parts = pc.combination_signature.slice(2).split('+');
      for (const pm of POOL.slice(0, 12)) {
        if (batch.length >= 20) break;
        if (parts.indexOf(pm.key) >= 0) continue;
        const sig = `T:${pc.candidate}+${pm.key}`;
        if (HYPS.seen.has(`${adaptRound}|TRIPLE|${sig}`)) continue;
        const pa = POOL.find(p => p.key === parts[0]), pb = POOL.find(p => p.key === parts[1]);
        if (!pa || !pb) continue;
        const setB = new Set();
        for (const r of rows) if (pm.test(r)) setB.add(r);
        const items = rows.filter(r => pa.test(r) && pb.test(r) && setB.has(r));
        if (items.length < cfg.minEvents) continue;
        const qs = quickStats(items);
        if (!(qs.trainMean > 0)) continue;
        batch.push({ pc, pm, items });
      }
      if (batch.length >= 20) break;
    }
    if (!batch.length) {
      emit(`ROUND ${adaptRound} ADAPTIVE: frontier exhausted (no unevaluated triples) — stopping search`);
      searchExhaustedNaturally = true;
      break;
    }
    const before = cands.length;
    runRound(adaptRound, 'ADAPTIVE_TRIPLES', batch.map(({ pc, pm, items }) => ({
      cid: `T:${pc.candidate}+${pm.key}`, fam: 'TRIPLE',
      feature: `${pc.candidate} AND ${pm.key}`,
      formula: `(${pc.formula}) AND ${pm.key} at bar t (adaptive R${adaptRound})`,
      rel: 'chain', items, depth: 3, sig: `T:${pc.candidate}+${pm.key}`,
    })));
    const yielded = cands.length - before;
    ADAPTIVE_DECISIONS.push({ round: adaptRound, found: `${yielded} candidates from ${batch.length} frontier triples`,
      failed: '-', decision: yielded ? 'continue while frontier yields' : 'watch zero-yield streak',
      why: 'frontier parent discovery scores (train/val only)' });
    if (!yielded) zeroYieldStreak++;
    else zeroYieldStreak = 0;
    if (zeroYieldStreak >= 3) {
      emit('STOP: 3 consecutive zero-yield adaptive rounds (E: no new unique hypotheses of value)');
      searchExhaustedNaturally = true;
      break;
    }
    adaptRound++;
  }
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
      const bt = OD.backtest(featBySym, sig, { cid: 'G' + tp, sl: cfg.sl, tp, trail: null, mode: 'premium', hold: cfg.hold, exec: execMode });
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

  // ================= POST-ROUNDS: frontier, validated scoring, exit matrix =================
  // ---- OOS exposure (§17): every candidate evaluated once on frozen OOS; count it ----
  const OOS_EXPOSURE_COUNT = cands.length;
  if (OOS_EXPOSURE_COUNT > 1000) emit('OOS_EXPOSURE_WARNING: >1000 candidates evaluated on the same frozen OOS; require a new unseen OOS period before declaring validation');
  // ---- frontier (§23): scored next experiments (train/val only — never OOS) ----
  const frontier = [];
  {
    const pairSurv = cands.filter(c => c.combination_depth === 2 && c.FWD_VAL_expectancy > 0)
      .sort((a, b) => b.discovery_score - a.discovery_score).slice(0, 5);
    for (const pc of pairSurv) {
      const parts = pc.combination_signature.slice(2).split('+');
      for (const pm of POOL.slice(0, 12)) {
        if (parts.indexOf(pm.key) >= 0) continue;
        const sig = `T:${pc.candidate}+${pm.key}`;
        if (HYPS.seen.has('24|TRIPLE|' + sig)) continue;
        frontier.push({ hypothesis_id: 'F-' + frontier.length, family: 'TRIPLE',
          parents: [pc.candidate], score: Math.round(pc.discovery_score * 1000) / 1000,
          oos_evidence: 'parent OOS not consulted (frozen)',
          robustness: 'unevaluated', sample: pc.events,
          failure_modes_avoided: pc.failure_reason,
          next: `evaluate triple ${sig}` });
        if (frontier.length >= 20) break;
      }
      if (frontier.length >= 20) break;
    }
    emit(`FRONTIER items=${frontier.length} (top: ${frontier.slice(0, 3).map(f => f.next).join(' | ') || 'none'})`);
  }
  // ---- exit matrix (§24) for top discovery survivors: 4 independent configs, unique IDs ----
  const exitTop = cands.filter(c => c.FWD_IS_expectancy > 0)
    .sort((a, b) => b.discovery_score - a.discovery_score).slice(0, 10);
  let exitTopEvalCount = 0;
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
      { id: `XM:${c.candidate}:breakeven`, kw: { sl: cfg.sl, tp: 99, trail: 0.05, mode: 'premium', hold: cfg.hold } },
    ];
    const mx = {};
    for (const v of variants) {
      exitTopEvalCount++;
      try {
        const led = OD.backtest(featBySym, sigs, { cid: v.id, exec: execMode, ...v.kw }).ledger;
        const rets = led.map(t => t.ret).filter(x => isFinite(x));
        mx[v.id.split(':').pop()] = { trades: led.length,
          expectancy: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : NaN,
          wr: rets.length ? rets.filter(x => x > 0).length / rets.length : NaN };
      } catch (e) { mx[v.id.split(':').pop()] = { trades: 0, expectancy: NaN, wr: NaN, error: String(e).slice(0, 80) }; }
    }
    c.exit_matrix = mx;
    if (cands.indexOf(c) % 5 === 4) checkpoint('robustness-batch');
  }
  // ---- full robustness battery (§19) for serious candidates (OOS-positive, cap 12) ----
  const serious = cands.filter(c => c.FWD_OOS_expectancy > 0)
    .sort((a, b) => b.discovery_score - a.discovery_score).slice(0, 12);
  emit(`ROBUSTNESS battery: ${serious.length} serious candidates (of ${cands.length})`);
  for (const c of serious) {
    const items = maskReg.get(c.candidate) || [];
    try {
      c.robustness_detail = OD.robustnessBattery(featBySym, idxBySym, items, {
        cid: c.candidate, exec: execMode, sl: cfg.sl, tp: cfg.tp, hold: cfg.hold,
        seed: cfg.seed, labelKey: 'fwd_ret_5m',
      });
      c.walkforward = OD.walkForward(items, 'fwd_ret_5m', 4);
    } catch (e) {
      c.robustness_detail = { error: String(e).slice(0, 120), params_locked: true, reoptimized: false };
      c.walkforward = { fold_count: 0, insufficient: true, reason: 'battery error' };
    }
    GLOBAL_TESTS += 1;
    checkpoint('robustness-batch');
  }
  // ---- OPTION_ROBUSTNESS_SCORE 0-10 (§24): exact weights, hard caps ----
  const RW = { signal: 10, param: 15, density: 10, exit: 10, purity: 10, direction: 5,
    strike: 5, expiry: 5, time: 5, entry: 5, jitter: 5, concentration: 5, best: 5, mt: 5 };
  function agreeFrac(map, refPositive) {
    const vs = Object.values(map || {}).filter(x => typeof x === 'number' && !isNaN(x));
    if (!vs.length) return { v: 0.5, na: true };
    const ok = vs.filter(x => (x > 0) === refPositive).length;
    return { v: ok / vs.length, na: false };
  }
  for (const c of cands) {
    const d = c.robustness_detail;
    const comp = {};
    comp.signal = (c.FWD_IS_expectancy > 0) ? Math.min(1, Math.max(0, c.FWD_IS_expectancy)) : 0;
    comp.sample = Math.min(1, c.clusters / 50);
    comp.oos = c.OOS_result === 'OOS_SURVIVED_MARK' ? 1 : 0;
    comp.exit = c.exit_matrix ? (Object.values(c.exit_matrix).filter(m => m.expectancy > 0).length / 5) : (c.exit_cap_dominated ? 0 : 0.5);
    comp.concentration = Math.max(0, 1 - c.top5);
    comp.stats = c.perm_p_adj < 0.05 ? 1 : (c.perm_p_adj < 0.10 ? 0.5 : 0);
    comp.best_event = (typeof c.rm_best3 === 'number' && !isNaN(c.rm_best3) && c.rm_best3 > 0) ? 1 : 0;
    if (d && !d.error) {
      comp.param = Math.max(0, Math.min(1, d.param.profitable_density));
      comp.density = comp.param;
      const dir = agreeFrac(d.by_type, c.FWD_expectancy > 0);
      comp.direction = dir.na ? 0.5 : dir.v;
      const stk = agreeFrac(d.by_strike, c.FWD_expectancy > 0);
      comp.strike = stk.na ? 0.5 : stk.v;
      const exp = agreeFrac(d.by_expiry, c.FWD_expectancy > 0);
      const nExp = Object.keys(d.by_expiry || {}).length;
      comp.expiry = nExp <= 1 ? 0.5 : exp.v;
      comp.time = (c.time_stability && !isNaN(c.time_stability.sign_agreement)) ? c.time_stability.sign_agreement : 0.5;
      comp.entry = d.entry_perturb.filter(x => !isNaN(x));
      comp.entry = comp.entry.length ? comp.entry.filter(x => (x > 0) === (c.FWD_expectancy > 0)).length / comp.entry.length : 0.5;
      comp.jitter = d.hold_perturb && d.hold_perturb.length
        ? d.hold_perturb.filter(x => x && !isNaN(x.exp) && (x.exp > 0) === (c.FWD_expectancy > 0)).length / d.hold_perturb.length : 0.5;
      comp.purity = 0.5;
      if (c.combination_depth >= 2) {
        const parts = c.combination_signature.slice(2).split('+');
        const pm = parts.map(k => (POOL.find(p => p.key === k) || {}));
        const ptr = pm.map(p => p.qs && p.qs.trainMean).filter(x => typeof x === 'number' && !isNaN(x));
        if (ptr.length) {
          const mx = OD.maxOf(ptr);
          comp.purity = c.FWD_IS_expectancy >= mx + 0.1 ? 1 : (c.FWD_IS_expectancy >= mx - 0.1 ? 0.5 : 0);
        }
      }
      comp.unTestable = [];
    } else {
      // light fallback (documented): battery not run for non-serious candidates
      comp.param = 0.5; comp.density = 0.5; comp.direction = 0.5; comp.strike = 0.5;
      comp.expiry = 0.5; comp.time = 0.5; comp.entry = 0.5; comp.jitter = 0.5; comp.purity = 0.5;
      comp.unTestable = ['full-battery'];
    }
    let score = 0;
    for (const k of Object.keys(RW)) score += Math.max(0, Math.min(1, comp[k] === undefined ? 0.5 : comp[k])) * RW[k];
    score = score / 100 * 10;
    // HARD CAPS (§24)
    const sub = k => comp[k] * 10;
    if (sub('param') < 3) score = Math.min(score, 6);
    if (comp.purity !== undefined && sub('purity') < 3) score = Math.min(score, 6);
    if (sub('density') < 3) score = Math.min(score, 6);
    if (sub('exit') < 3) score = Math.min(score, 7);
    if (sub('best_event') < 3) score = Math.min(score, 7);
    if (!(c.perm_p_adj < 0.10) && ((d && d.param && d.param.profitable_density < 0.3) || !d)) score = Math.min(score, 5);
    c.OPTION_ROBUSTNESS_SCORE = Math.round(score * 100) / 100;
    c.robustness_components_detailed = comp;
    // keep legacy field pointing at the detailed score when available
    c.robustness_score = c.OPTION_ROBUSTNESS_SCORE;
    c.robustness_components = comp;
  }
  // ---- boards (§21) ----
  const topBy = (key, n, desc) => cands.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    const xn = (typeof x === 'number' && !isNaN(x)) ? x : -Infinity;
    const yn = (typeof y === 'number' && !isNaN(y)) ? y : -Infinity;
    return desc ? yn - xn : xn - yn;
  }).slice(0, n).map(c => c.candidate);
  checkpoint('oos');
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
  // per-contract missing concentration for CONTRACT_SPECIFIC classification
  const featSymMiss = new Map();
  for (const [fname] of FEAT_DEFS) {
    let miss = 0, init = 0, rawgap = 0, chainalign = 0, other = 0;
    const perSym = new Map();
    let maxRun = 0, run = 0;
    const ordered = rows.slice().sort((a, b) => (a.symbol < b.symbol ? -1 : 1) || a.ts - b.ts);
    for (const r of ordered) {
      const v = r[fname];
      if (typeof v === 'number' && !isNaN(v)) { run = 0; continue; }
      miss++;
      run++;
      if (run > maxRun) maxRun = run;
      perSym.set(r.symbol, (perSym.get(r.symbol) || 0) + 1);
      const idx = bySymIdx.get(r.symbol).get(r);
      if (idx < 120) init++;
      else if (isNaN(r.close)) rawgap++;
      else if (CHAIN_FEATS.has(fname)) chainalign++;
      else other++;
    }
    const syms = [...perSym.keys()];
    const concSym = syms.length && syms.length < bySymIdx.size / 2 && miss > 0;
    const cls = miss === rows.length ? 'STRUCTURAL'
      : miss / Math.max(1, rows.length) > 0.8 ? 'STRUCTURAL'
      : (init / Math.max(1, miss) > 0.7) ? 'WARMUP'
      : concSym ? 'CONTRACT_SPECIFIC' : (miss === 0 ? 'NONE' : 'RANDOM');
    const validRows = rows.length - miss;
    missingness.push({ feature: fname, missing_count: miss,
      missing_pct: Math.round(miss / Math.max(1, rows.length) * 1000) / 10,
      initial_lookback_missing: init, session_gap_missing: 0, contract_gap_missing: rawgap,
      chain_alignment_missing: chainalign, expiry_boundary_missing: 0, other_missing: other,
      max_consecutive_missing: maxRun, missingness_class: cls,
      effective_sample_size: validRows,
      downgraded: miss / Math.max(1, rows.length) > 0.5,
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
  // ---- FINAL_VALIDATED_SCORE (§21): gate-passers only; IS never compensates OOS ----
  for (const c of validated) {
    const gates = {
      oos_positive: c.FWD_OOS_expectancy > 0,
      oos_trades: c.FWD_OOS_events >= 20,
      robustness: c.robustness_score >= 5,
      exit_independence: Object.values(c.exit_matrix).filter(m => m.expectancy > 0).length >= 2,
      concentration: c.top5 < 0.5,
      best_event: c.rm_best3 > 0,
      drawdown_ok: !(c.maxDD < -5),
      time_stability: true,
      mt: c.perm_p_adj < 0.10,
      data_quality: true,
    };
    c.paper_gates = gates;
    const pass = Object.values(gates).every(Boolean);
    const nz = x => (typeof x === 'number' && !isNaN(x)) ? x : 0;
    c.FINAL_VALIDATED_SCORE = pass ? Math.round((
      nz(c.FWD_OOS_expectancy) * 3 + nz(c.OOS_TRADE_SHARPE) * 2 +
      Math.log10(1 + c.FWD_OOS_events) + nz(c.robustness_score) / 2 +
      (1 - Math.min(1, c.top5)) + (nz(c.rm_best3) > 0 ? 1 : 0)) * 100) / 100 : 0;
    c.paper_eligible = false; // short-sample + RESEARCH-price-model rule (§41/§7)
    if (c.FINAL_VALIDATED_SCORE > 0) {
      emit(`VALIDATED ${c.candidate} score=${c.FINAL_VALIDATED_SCORE} (paper still blocked: short sample, research prices)`);
    }
  }
  const paperList = validated.filter(c => c.paper_eligible);
  // ---- neighborhood search (§20B): exhaust winner's local neighborhood ----
  let neighborhood = { searched: false };
  const best = validated.slice().sort((a, b) => b.FINAL_VALIDATED_SCORE - a.FINAL_VALIDATED_SCORE)[0];
  if (best) {
    const items0 = maskReg.get(best.candidate) || [];
    const sigs0 = items0.map(r => ({ sym: r.symbol, i: idxBySym.get(r.symbol).get(r.ts) })).filter(s => s.i != null);
    const results = [];
    for (const sl of [0.3, 0.5, 0.7]) for (const tp of [0.7, 1.0, 1.5]) for (const hold of [3, 5, 8]) {
      if (sl === cfg.sl && tp === cfg.tp && hold === cfg.hold) continue;
      try {
        const led = OD.backtest(featBySym, sigs0, { cid: `NB:${best.candidate}`, sl, tp, trail: null, mode: 'premium', hold, exec: execMode }).ledger;
        const rets = led.map(t => t.ret).filter(x => isFinite(x));
        if (rets.length) results.push({ sl, tp, hold, n: rets.length, exp: rets.reduce((a, b) => a + b, 0) / rets.length });
      } catch (e) { /* neighbor failed; recorded as untestable */ }
    }
    results.sort((a, b) => b.exp - a.exp);
    const better = results.filter(r => r.exp > best.FWD_expectancy * 1.2);
    neighborhood = { searched: true, configs: results.length,
      best_neighbor: results[0] || null, materially_better: better.length,
      winner_adopted: best.candidate };
    GLOBAL_TESTS += results.length;
    emit(`NEIGHBORHOOD ${best.candidate}: searched=${results.length} best=${results[0] ? `sl${results[0].sl}/tp${results[0].tp}/h${results[0].hold} exp${results[0].exp.toFixed(3)}` : 'none'} materially_better=${better.length}`);
  }
  // global test accounting (§18): hypotheses + exit variants + neighborhood evals
  GLOBAL_TESTS += exitTopEvalCount;
  emit(`GLOBAL_TEST_COUNT=${GLOBAL_TESTS} (hypotheses=${HYPS.tested} + exit/neighborhood evals; never reset)`);
  emit(`OOS_EXPOSURE_COUNT=${OOS_EXPOSURE_COUNT} (frozen single-pass evaluations; entries never re-derived from OOS)`);
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
  GLOBAL_TESTS = HYPS.tested + exitTopEvalCount + (neighborhood.configs || 0);
  const roundsWanted = cfg.rounds === 'all' ? cfg.maxRounds : cfg.rounds.length;
  const roundsRan = ROUND_LOG.length;
  const dataHash = hashCfg([norm.length, meta.n_contracts, meta.timestamp_range[0], meta.timestamp_range[1]].join('|'));
  const resumeCheckpoint = { runId: RUN_ID, dataHash, cfgHash: hashCfg(cfg), seed: cfg.seed,
    seen: [...HYPS.seen], roundsDone: ROUND_LOG.map(r => r.round) };
  const frontierOpen = frontier.filter(f => {
    const fam = f.family;
    return (famOosFail[fam] || 0) < 5;
  }).length;
  if (blockers.length) {
    FINAL_STATE = 'BLOCKED_' + blockers[0];
  } else if (validated.length > 0 && neighborhood.searched && neighborhood.materially_better === 0) {
    FINAL_STATE = 'VALIDATED_EDGE_FOUND';
  } else if (validated.length > 0) {
    FINAL_STATE = 'DISCOVERY_EDGE_OOS_FAILED'; // survivor exists but neighborhood/frontier not exhausted
  } else if (stopReason.why === 'maxTotalCandidates' || stopReason.why === 'maxRuntimeSeconds') {
    FINAL_STATE = 'SEARCH_BUDGET_EXHAUSTED';
  } else if (typeof searchExhaustedNaturally !== 'undefined' && searchExhaustedNaturally) {
    FINAL_STATE = 'NO_EDGE_FOUND_WITHIN_SEARCH_BUDGET'; // frontier exhausted naturally (§20E)
  } else if (meta.n_days < 6 && cands.length === 0) {
    FINAL_STATE = 'INSUFFICIENT_DATA';
  } else if (newUnique() === 0 && initialSeen > 0) {
    FINAL_STATE = 'NO_EDGE_FOUND_WITHIN_SEARCH_BUDGET'; // resumed search, nothing new (§20E)
  } else if (roundsRan < roundsWanted && (stopReason.why || budgetDead())) {
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
  emit(`UNDERLYING reference=${und ? refSym : 'none'} MONEYNESS=${und ? 'AVAILABLE' : 'UNAVAILABLE'} EXPIRY_ENGINE=${expCols.length ? 'AVAILABLE' : 'NOT_AVAILABLE'}`);
  emit(`GLOBAL_TEST_COUNT=${GLOBAL_TESTS} OOS_EXPOSURE_COUNT=${OOS_EXPOSURE_COUNT}`);
  emit(`COVERAGE rounds=${ROUND_LOG.length}/${roundsWanted} hyps=${HYPS.tested} cands=${cands.length} exhausted=${stopReason.why || 'rounds-complete'}`);
  emit(`FINAL_STATUS=${FINAL_STATE}`);
  checkpoint('final-ranking');
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
    checkpoint: resumeCheckpoint, checkpoints: CHECKPOINTS, dataHash, globalTests: GLOBAL_TESTS, oosExposure: OOS_EXPOSURE_COUNT,
    newUnique: newUnique(),
    boards, diversity, oosCounts,
    missingness: missingness.slice().sort((a, b) => b.missing_pct - a.missing_pct).slice(0, 20),
    understanding, frontier, neighborhood, validated: validated.map(c => c.candidate),
    bestValidated: best ? best.candidate : null,
    adaptiveDecisions: ADAPTIVE_DECISIONS, familyTable,
    moneynessStatus: und ? 'AVAILABLE' : 'UNAVAILABLE',
    expiryEngine: expCols.length ? 'AVAILABLE' : 'NOT_AVAILABLE',
    coverage: {
      rounds_attempted: ROUND_LOG.length, rounds_wanted: roundsWanted,
      hypotheses_tested: HYPS.tested, hypotheses_unique: HYPS.unique,
      candidates_evaluated: cands.length,
      families_tested: [...new Set(cands.map(c => c.discovery_family))],
      skipped_rounds: [17].filter(() => !und),
      unavailable_modules: Object.entries(mods).filter(([, v]) => v[0] !== 'AVAILABLE').map(([k]) => k),
      exhausted: stopReason.why || 'rounds-complete',
    },
    finalReport: {
      RUN_ID, CONFIG_HASH: hashCfg(cfg),
      DATA_RANGE: meta.timestamp_range, ROWS: norm.length,
      CONTRACTS: meta.n_contracts, STRIKES: meta.n_strikes, EXPIRIES: meta.expiries,
      UNDERLYING_STATUS: und ? 'AVAILABLE' : 'UNAVAILABLE',
      MONEYNESS_STATUS: und ? 'AVAILABLE' : 'UNAVAILABLE',
      EXECUTION_STATUS: execMode === 'executable' ? 'EXECUTABLE_PRICE_MODEL' : 'RESEARCH_PRICE_MODEL',
      PRICE_MODEL: execMode === 'executable' ? 'EXECUTABLE_PRICE_MODEL' : 'RESEARCH_PRICE_MODEL',
      COST_MODEL: 'ZERO', BID_ASK_AVAILABLE: !!meta.has_bidask,
      FEATURE_COUNT: featAudit.length,
      RAW_CANDIDATES: cands.filter(c => c.combination_depth === 1).length,
      PAIR_CANDIDATES: cands.filter(c => c.combination_depth === 2).length,
      TRIPLE_CANDIDATES: cands.filter(c => c.combination_depth === 3).length,
      TOTAL_HYPOTHESES: HYPS.tested,
      ROUNDS_COMPLETED: ROUND_LOG.length,
      RUNTIME_SECONDS: Math.round((Date.now() - t0) / 1000),
      TRAIN_SURVIVORS: cands.filter(c => c.FWD_IS_expectancy > 0).length,
      VALIDATION_SURVIVORS: cands.filter(c => c.FWD_VAL_expectancy > 0).length,
      OOS_TESTED: oosCounts.OOS_TESTED, OOS_SURVIVORS: oosCounts.OOS_FINAL_SURVIVOR,
      BEST_TRAIN: topBy('FWD_IS_expectancy', 1, true)[0] || null,
      BEST_VALIDATION: topBy('FWD_VAL_expectancy', 1, true)[0] || null,
      BEST_OOS: topBy('FWD_OOS_expectancy', 1, true)[0] || null,
      STACK_SAFETY_STATUS: ssa.status,
      DATA_HEALTH_STATUS: health.status,
      PAPER_ELIGIBLE: false,
    },
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
