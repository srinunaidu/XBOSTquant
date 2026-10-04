/**
 * Deterministic stand-in for the Python engine, used only when BUYONLY_FAKE=1.
 * Emits the same stdout shape and writes the same bundle path, so the SSE
 * contract can be tested without a Python process or a long run.
 */
'use strict';
const fs = require('fs');
const { EventEmitter } = require('events');

function fakeBundle(csv, flags) {
  const get = (name, dflt) => {
    const i = flags.indexOf(name);
    return i >= 0 && i + 1 < flags.length ? flags[i + 1] : dflt;
  };
  const lotSize = Number(get('--lot-size', 15));
  const maxLots = Number(get('--max-lots', 5));
  const broker = Number(get('--brokerage-per-order', 20));
  const bePts = Number(get('--breakeven-points', 2.5));
  const brokeragePts = (broker * 2) / lotSize;
  const rows = Math.max(1, csv.split('\n').length - 1);
  const log = [];
  const push = (kind, msg) => log.push(`[+   0.00s] ${kind.padEnd(8)} ${msg}`);
  push('RUN', `configuration lots=${maxLots} lot=${lotSize}`);
  push('DATA', `options chain ingested rows=${rows} contracts=1`);
  push('DATA', 'oi field present=false');
  push('FEATURE', 'feature vwap nan_pct=0.00 ok=True');
  push('REGIME', 'regime distribution COMPRESSING=1 CHOPPY=0 TRENDING=0 UNKNOWN=0');
  push('SIGNAL', 'availability OI_VELOCITY NOT_AVAILABLE (no open_interest field in dataset)');
  push('SIGNAL', 'signals generated total=1');
  push('GATE', 'engine armed restrict_to_regime=True');
  push('TRADE', 'trade closed trade_id=1 net=1.000 cost=0.500');
  push('STAT', 'bootstrap CI on mean net points mean=1.000 lo=0.500 hi=1.500 n=1 excludes_zero=False');
  push('VERDICT', 'headline trades=1 win_rate=100.0 profit_factor=1.5');
  push('VERDICT', 'NO_VALIDATED_EDGE');

  const ledger = [{
    trade_id: 1, timestamp: '2026-01-05T09:16:00', entry_time: '2026-01-05T09:17:00',
    exit_time: '2026-01-05T09:20:00', hypothesis: 'VOLATILITY_COIL',
    regime: 'COMPRESSING', direction: 'CE', symbol: 'X55100CE', strike: 55100,
    expiry: 'E', moneyness: 'ATM', entry_price: 100, exit_price: 101.5,
    exit_reason: 'TARGET', duration_bars: 4, gross_points: 1.5, cost_points: 0.5,
    net_points: 1.0, net_pct: 1.0, risk_points: 30, mfe_points: 2, mae_points: -1,
    lots: maxLots, rupee_pnl: 1.0 * lotSize * maxLots, be_moved: true,
    profit_locked: true, first_target_bar: 2, time_to_target_bars: 2, blocked_reason: '',
  }];

  return {
    run_id: 'BO-FAKE', wall_ms: 5,
    dataset: { rows, contracts: 1, sessions: 1, has_oi: false, has_futures: false },
    settings: { max_lots: maxLots, lot_size: lotSize },
    config_fingerprint: 'FAKE',
    constraints: {
      long_only: true, universe: 'ATM and ITM only', max_lots: maxLots,
      lot_size: lotSize, breakeven_points: bePts,
      brokerage_points: Number(brokeragePts.toFixed(4)),
      breakeven_trigger_points: Number((brokeragePts + bePts).toFixed(4)),
      no_indicators: 'no RSI, no MACD, no moving-average crossover',
      costs_charged: true,
    },
    regimes: { TRENDING: 0, COMPRESSING: rows, CHOPPY: 0, UNKNOWN: 0 },
    availability: {
      VOLATILITY_COIL: 'AVAILABLE',
      OI_VELOCITY: 'NOT_AVAILABLE (no open_interest field in dataset)',
      LIQUIDITY_FLUSH: 'AVAILABLE', VWAP_SNAP_BACK: 'AVAILABLE',
    },
    moneyness: { atm_inside_ladder: rows },
    underlying_source: { straddle_proxy: rows },
    summary: {
      label: 'ALL', trades: 1, win_rate: 100.0, profit_factor: 1.5,
      max_dd_points: 0.0, net_points: 1.0, avg_net_points: 1.0,
      expectancy_points: 1.0, gross_profit: 1.0, gross_loss: 0.0,
      rupee_pnl: 1.0 * lotSize * maxLots, time_to_target_bars: 2,
      time_to_target_min: 2, reached_target: 1, target_hit_rate: 100.0,
      avg_duration_bars: 4, avg_risk_points: 30, be_armed_rate: 100.0,
      profit_locked_rate: 100.0, avg_mfe_points: 2, avg_mae_points: -1,
      status: 'MEASURED',
    },
    by_hypothesis: [{
      label: 'VOLATILITY_COIL', trades: 1, win_rate: 100.0, profit_factor: 1.5,
      net_points: 1.0, avg_duration_bars: 4, reached_target: 1,
    }],
    significance: { mean: 1.0, lo: 0.5, hi: 1.5, n: 1, excludes_zero: false, status: 'TESTED' },
    timing_test: null,
    sensitivity: null,
    audit: { signals_in: 1, trades: 1, blocked: {}, engine: {} },
    signals: [], ledger,
    logic_map: 'FAKE LOGIC MAP',
    log, log_text: log, log_counts: { RUN: 1, DATA: 2, FEATURE: 1, REGIME: 1, SIGNAL: 2, GATE: 1, TRADE: 1, STAT: 1, VERDICT: 2 },
    log_level: 'info',
  };
}

function fakeRun(csv, flags, bundlePath) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setImmediate(() => child.emit('close', 0)); };
  const bundle = fakeBundle(csv, flags);
  try { fs.writeFileSync(bundlePath, JSON.stringify(bundle)); } catch { /* ignore */ }
  const lines = bundle.log_text.concat(
    `[+   0.00s] RUN      artifacts written bundle=${bundlePath}`);
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(lines.join('\n') + '\n'));
    setImmediate(() => child.emit('close', 0));
  });
  return child;
}

module.exports = { fakeRun, fakeBundle };