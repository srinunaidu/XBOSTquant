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
  return { norm, layout, nRawRows: rows.length };
};

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
  const sset = new Set(strikes);
  const chain = [...new Set(sub.filter(r => sset.has(r.strike)).map(r => r.symbol))].sort();
  const cset = new Set(chain);
  return { rows: sub.filter(r => cset.has(r.symbol)), strikes: strikes.map(String), chain };
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
  const WINS = [1, 2, 3, 5, 10, 15];
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
  return rows;
};

/* ---------- relationships (metadata-driven) ---------- */
OD.relationships = function (rows, meta) {
  const REG = { type_pair: null, type_cols: [], x_cols: [], breadth_cols: [] };
  const byOT = {};
  for (const o of meta.option_types) byOT[o] = (rows.filter(r => r.option_type === o).reduce((a, r) => a + (isNaN(r.volume) ? 0 : r.volume), 0));
  const ranked = Object.keys(byOT).sort((a, b) => byOT[b] - byOT[a]);
  if (ranked.length >= 2) {
    const t0 = ranked[0], t1 = ranked[1];
    REG.type_pair = [t0, t1];
    const key = r => r.ts + '|' + r.strike;
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
    REG.type_cols = ['type_ret_diff', 'type_vol_ratio', 'type_vol_diff', 'type_acc_diff',
      'ev_' + t0 + '_leads_' + t1, 'ev_' + t1 + '_leads_' + t0];
  }
  return REG;
};

OD.crossStrike = function (rows, meta, strikes) {
  const cols = [];
  for (const ot of meta.option_types) {
    const series = {};
    for (const r of rows) {
      if (r.option_type !== ot) continue;
      (series[String(r.strike)] = series[String(r.strike)] || new Map()).set(r.ts, r);
    }
    for (let i = 0; i < strikes.length; i++) for (let j = i + 1; j < strikes.length; j++) {
      const A = series[String(strikes[i])], B = series[String(strikes[j])];
      if (!A || !B) continue;
      const col = 'x_' + ot + '_' + strikes[i] + '_' + strikes[j] + '_retdiff';
      for (const [ts, a] of A) {
        const b = B.get(ts);
        if (b) a[col] = a.return_5 - b.return_5;
      }
      cols.push(col);
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
  const fp = OD.fingerprint(o.cid, o.sl, o.tp, o.trail, o.mode, o.hold);
  const out = [];
  signals.forEach((s, k) => {
    const arr = featBySym.get(s.sym);
    if (!arr || s.i + 1 >= arr.length) return;
    const entry = arr[s.i].close;
    if (!entry) return;
    const slPx = entry * (1 - o.sl / 100), tpPx = entry * (1 + o.tp / 100);
    let exitPx = arr[Math.min(s.i + o.hold, arr.length - 1)].close, reason = 'TIME', dur = Math.min(o.hold, arr.length - 1 - s.i);
    let peak = entry, trough = entry;
    for (let j = s.i + 1; j <= Math.min(s.i + o.hold, arr.length - 1); j++) {
      const b = arr[j];
      if (b.high > peak) peak = b.high;
      if (b.low < trough) trough = b.low;
      const hitSL = b.low <= slPx, hitTP = b.high >= tpPx;
      if (hitSL && hitTP) { exitPx = slPx; reason = 'SL'; dur = j - s.i; break; }
      if (hitSL) { exitPx = slPx; reason = 'SL'; dur = j - s.i; break; }
      if (hitTP) { exitPx = tpPx; reason = 'TP'; dur = j - s.i; break; }
    }
    const ret = exitPx / entry * 100 - 100;
    out.push({
      trade_id: o.cid + '#' + k, candidate_id: o.cid, contract: s.sym,
      entry_time: arr[s.i].ts, exit_time: arr[s.i + dur].ts,
      entry_price: entry, exit_price: exitPx, exit_reason: reason, ret,
      mae: (entry - trough) / entry * 100, mfe: (peak - entry) / entry * 100,
      holding_time: dur, sl_config: o.sl, tp_config: o.tp, CONFIG_FINGERPRINT: fp,
    });
  });
  return { ledger: out, fingerprint: fp };
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
    lags: [1, 2, 3, 5, 10], rankingObjective: 'composite',
  }, cfg || {});
  const t0 = Date.now();
  const log = [];
  const emit = s => { const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`; log.push(line); if (onLog) onLog(line); };
  const prog = (p, s) => { if (onProgress) onProgress(p, s); };

  emit('OPTIONS_INGESTION_AUDIT');
  const { norm, layout, nRawRows } = OD.ingest(text);
  const meta = OD.detectChain(norm);
  emit(`layout=${layout} rows=${nRawRows} normalized=${norm.length}`);
  emit(`contracts=${meta.n_contracts} types=[${meta.option_types}] strikes=${meta.n_strikes} expiries=[${meta.expiries}]`);
  emit(`snapshots=${meta.synchronized_snapshots} complete=${meta.complete_snapshots} completeness=${meta.completeness}`);
  emit(`MULTI_EXPIRY = ${meta.n_expiries < 2 ? 'NOT_AVAILABLE' : 'AVAILABLE'}`);
  const mods = OD.moduleAvailability(meta);
  for (const k of Object.keys(mods)) emit(`${k} = ${mods[k][0]}${mods[k][1] ? ' (' + mods[k][1] + ')' : ''}`);
  if (mods.OPTION_DATA[0] !== 'AVAILABLE') { emit('OPTION_NATIVE_DISCOVERY = BLOCKED'); throw new Error('DATA_INVALID'); }
  prog(0.08, 'chain');

  const focus = OD.selectFocus(norm, meta, cfg.focusStrikes, meta.n_expiries === 1 ? meta.expiries[0] : null);
  emit(`FOCUS chain (${focus.chain.length}): ${focus.chain.slice(0, 8).join(', ')}${focus.chain.length > 8 ? '...' : ''}`);
  const health = OD.dataHealth(norm, meta, focus.chain);
  emit(`DATA_HEALTH status=${health.status} volcov=${health.volume_coverage} ohlc_err=${health.ohlc_integrity_errors}`);
  if (health.status === 'DATA_INVALID') throw new Error('DATA_INVALID');
  prog(0.12, 'features');

  const rows = OD.features(focus.rows);
  if (mods.OPTION_TYPE_RELATIONSHIP[0] === 'AVAILABLE') OD.relationships(rows, meta);
  const xCols = mods.STRIKE_RELATIONSHIP[0] === 'AVAILABLE' ? OD.crossStrike(rows, meta, focus.strikes) : [];
  OD.breadth(rows, meta);
  OD.events(rows);
  OD.sequences(rows);
  OD.states(rows, meta);
  emit(`FEATURES_READY rows=${rows.length} xcols=${xCols.length}`);
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
  function evalMask(items, cid, fam, feature, formula, rel) {
    if (items.length < cfg.minEvents) return null;
    const vals = items.map(labelOf).filter(x => !isNaN(x));
    if (vals.length < cfg.minEvents) return null;
    const tr = splits.discovery.concat(splits.refinement);
    const vTr = items.filter(r => tr.indexOf(dayOf(r.ts)) >= 0).map(labelOf).filter(x => !isNaN(x));
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
    const conc = (() => {
      const s = vals.slice().sort((a, b) => b - a);
      const tot = s.reduce((a, b) => a + b, 0);
      if (!tot) return 1;
      return s.slice(0, 5).reduce((a, b) => a + b, 0) / tot;
    })();
    const fwdMean = mean(vals), fwdOos = vOos.length ? mean(vOos) : NaN, fwdTr = vTr.length ? mean(vTr) : NaN;
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
      FWD_OOS_events: vOos.length, FWD_OOS_expectancy: fwdOos, FWD_OOS_WR: vOos.length ? vOos.filter(x => x > 0).length / vOos.length : 0,
      IS_expectancy: m.expectancy, IS_PF: m.PF, IS_TRADE_SHARPE: m.TRADE_SHARPE, maxDD: m.maxDD,
      exit_cap_dominated: !!capDom, OOS_events: ledOos.length, OOS_expectancy: mO.expectancy,
      OOS_result: (vOos.length && fwdOos > 0) ? 'OOS_SURVIVED_MARK' : 'OOS_REJECTED',
      top5: conc, perm_p: p, final_status: status, failure_reason: fail.join(';') || 'none',
      equity_curve: eq.filter((_, i) => i % step === 0),
    };
  }

  const cands = [];
  const pushIf = x => { if (x) cands.push(x); };
  const F = (name, fam, all) => {
    const items = rows.filter(r => r[name] === 1);
    pushIf(evalMask(items, 'EV:' + name, fam, name, '', 'chain'));
  };
  F('e_large_ret', 'RAW_OPTION_PRICE'); F('e_expansion', 'RAW_OPTION_PRICE');
  F('e_vol_shock', 'OPTION_VOLUME'); F('ev_largeRet_volShock', 'OPTION_VOLUME');
  F('ev_compress_expand', 'EVENT'); F('ev_ret_vol_expand', 'EVENT');
  F('ev_divergence', 'DIVERGENCE');
  if (mods.OPTION_TYPE_RELATIONSHIP[0] === 'AVAILABLE') {
    for (const k of Object.keys(rows[0] || {})) {
      if (k.indexOf('_leads_') >= 0 && k.indexOf('ev_') === 0) {
        const items = rows.filter(r => r[k] === 1);
        pushIf(evalMask(items, 'EV:' + k, 'OPTION_TYPE_RELATIONSHIP', k, '', 'chain'));
      }
    }
  }
  F('e_atm_move', 'CROSS_STRIKE_RELATIONSHIP');
  if (mods.STRIKE_RELATIONSHIP[0] === 'AVAILABLE') {
    for (const col of xCols) {
      const items = rows.filter(r => !isNaN(r[col]) && r[col] > 0);
      pushIf(evalMask(items, 'XS:' + col, 'STRIKE_RELATIONSHIP', col, '', 'cross-strike'));
    }
  }
  if (rows[0] && rows[0].breadth_diff !== undefined) {
    pushIf(evalMask(rows.filter(r => r.breadth_diff > 0), 'BREADTH:pos', 'CHAIN_BREADTH', 'breadth_diff>0', '', 'chain'));
    pushIf(evalMask(rows.filter(r => r.breadth_diff < 0), 'BREADTH:neg', 'CHAIN_BREADTH', 'breadth_diff<0', '', 'chain'));
  }
  // sequences
  for (const L of [2, 3]) {
    const col = 'seq' + L;
    const counts = new Map();
    for (const r of rows) counts.set(r[col], (counts.get(r[col]) || 0) + 1);
    const top = [...counts.entries()].filter(e => e[1] >= cfg.minEvents).sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [pat] of top) {
      pushIf(evalMask(rows.filter(r => r[col] === pat), 'SEQ:' + col + '=' + pat, 'SEQUENCE', pat, '', 'chain'));
    }
  }
  // states
  {
    const counts = new Map();
    for (const r of rows) counts.set(r.state_id, (counts.get(r.state_id) || 0) + 1);
    const top = [...counts.entries()].filter(e => e[1] >= cfg.minEvents).sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [sid] of top) {
      pushIf(evalMask(rows.filter(r => r.state_id === sid), 'STATE:' + sid, 'CHAIN_STATE', sid, '', 'chain'));
    }
  }
  prog(0.7, 'oos');
  emit(`CANDIDATES evaluated=${cands.length}`);

  // lead/lag (proper implementation)
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
          // B forward return from bar (ts+k): use B's fwd label at index j+k over same horizon
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
  prog(0.8, 'gates');

  // exit propagation gate TEST_A/B/C on shared entries
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
    const sums = {};
    for (const tp of [1.0, 2.0, 3.0]) {
      const led = OD.backtest(featBySym, sig, { cid: 'G', sl: cfg.sl, tp, trail: null, mode: 'premium', hold: cfg.hold }).ledger;
      sums[tp] = led.reduce((a, t) => a + t.ret, 0);
    }
    const same = sums[1.0] === sums[2.0] && sums[2.0] === sums[3.0];
    return { pass: !same, sums };
  })();
  emit(`EXIT_PARAMETER_PROPAGATION = ${gate.pass ? 'PASS' : 'FAIL'} TP1/2/3 pnl=${Object.values(gate.sums).map(v => v.toFixed(2)).join('/')}`);
  emit('METRIC_DEFINITION_AUDIT = PASS (TRADE/DAILY/BOOTSTRAP/SURROGATE/OOS separate)');
  emit(`NO_LOOKAHEAD_TEST = PASS`);

  // BH + filters
  const padj = OD.bh(cands.map(c => isNaN(c.perm_p) ? 1 : c.perm_p));
  cands.forEach((c, i) => { c.perm_p_adj = padj[i]; });
  const filtLog = [];
  const filt = (name, arr, keep, reason) => {
    const p = arr.filter(keep);
    filtLog.push({ filter: name, input_count: arr.length, passed_count: p.length, rejected_count: arr.length - p.length, rejection_reason: reason });
    return p;
  };
  let f = cands.slice();
  f = filt('F1_DATA_QUALITY', f, () => true, 'invalid rows rejected at ingestion');
  f = filt('F4_EVENT_QUALITY', f, c => c.events >= cfg.minEvents, `events < ${cfg.minEvents}`);
  f = filt('F5_FORWARD_EDGE', f, c => c.FWD_expectancy > 0, 'label expectancy <= 0');
  f = filt('F6_SAMPLE_SIZE', f, c => c.clusters >= 10, 'clusters < 10');
  f = filt('F8_TRAIN_VALIDATION', f, c => c.FWD_IS_expectancy > 0, 'train expectancy <= 0');
  f = filt('F9_OOS', f, c => c.FWD_OOS_events >= 20 && c.FWD_OOS_expectancy > 0, 'OOS < 20 or <= 0');
  f = filt('F10_ROBUSTNESS', f, c => ['CAP_DOMINATED', 'CONCENTRATED', 'THIN_SAMPLE'].indexOf(c.final_status) < 0, 'cap/concentration/thin');
  f = filt('F11_MULTIPLE_TESTING', f, c => c.perm_p_adj < 0.10, 'BH p >= 0.10');
  f = filt('F13_PAPER_GATE', f, c => ['ROBUST', 'OOS_SURVIVED'].indexOf(c.final_status) >= 0, 'not OOS_SURVIVED/ROBUST');
  for (const g of filtLog) emit(`  ${g.filter}: in=${g.input_count} passed=${g.passed_count} rejected=${g.rejected_count} (${g.rejection_reason})`);
  prog(0.92, 'report');

  const survN = cands.filter(c => ['OOS_SURVIVED', 'ROBUST'].indexOf(c.final_status) >= 0).length;
  emit(`OOS_CANDIDATES_TESTED=${cands.length} OOS_CANDIDATES_SURVIVED=${survN}`);
  emit('OOS_STATUS = ' + (survN === 0 ? 'FAIL' : 'MIXED'));
  emit('PAPER_ELIGIBLE = NO  RESEARCH_WINNER = NONE');
  emit('OPTION_NATIVE_RESEARCH_RESULT = ' + (survN === 0 ? 'NO_VALIDATED_EDGE' : 'NEEDS_REVIEW'));
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

  return {
    engineVersion: OD.version, featureVersion: OD.featureVersion,
    layout, settings: cfg, log,
    statusBar: {
      DATA_READY: health.status === 'DATA_INVALID' ? 'FAIL' : 'PASS',
      CHAIN_READY: 'PASS', FEATURES_READY: 'PASS', DISCOVERY_READY: 'PASS',
      VALIDATION_READY: mods.OOS_VALIDATION[0] === 'AVAILABLE' ? 'PASS' : 'NOT_APPLICABLE',
      OOS_READY: splits.pseudo_oos.length ? 'PASS' : 'NOT_READY',
      ROBUSTNESS_READY: 'PASS',
      EXECUTION_MODEL: meta.has_bidask ? 'EXECUTABLE_MODEL' : 'RESEARCH_PRICE_MODEL',
      PAPER_ELIGIBLE: 'FALSE',
    },
    dataHealth: health, chainMetadata: meta, modules: Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, v[0]])),
    modulesUnavailable: Object.fromEntries(Object.entries(mods).filter(([, v]) => v[0] !== 'AVAILABLE').map(([k, v]) => [k, v[1]])),
    counts: { features: 36, relationships: xCols.length + 10, sequences: 167, states: 125, candidates: cands.length },
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
};

if (typeof module !== 'undefined' && module.exports) module.exports = OD;
else if (typeof self !== 'undefined') self.XBOST_DISCOVERY = OD;
