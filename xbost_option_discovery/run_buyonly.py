"""CLI: run the Option Buy-Only engine end to end.

    python -m xbost_option_discovery.run_buyonly \
        --path "Data test/banknifty_options.csv" \
        --futures "Data test/banknifty_futures_1m.csv" \
        --outdir runs/buyonly

Writes `ledger.csv`, `summary.json`, `by_hypothesis.csv`, `report.md` and
`logic_map.md`.
"""
import argparse
import json
import os
import time

import numpy as np
import pandas as pd

from .buyonly import (BuyOnlySettings, build_reference, build_underlying,
                      audit_moneyness, add_session_features, run_all,
                      availability, classify_regimes, regime_summary,
                      run_backtest, summarize, by_hypothesis, significance,
                      logic_map, report_markdown)
from .buyonly.report import sensitivity, signal_permutation_test
from .costs import OptionCostModel


def load_quotes(path):
    q = pd.read_csv(path)
    q.columns = [str(c).strip().lower() for c in q.columns]
    ren = {"date": "timestamp", "time": "timestamp", "datetime": "timestamp",
           "symbol": "symbol", "contract": "symbol", "strike": "strike",
           "otype": "option_type", "opt_type": "option_type", "type": "option_type",
           "expiry": "expiry", "open": "open", "high": "high", "low": "low",
           "close": "close", "volume": "volume", "vol": "volume",
           "oi": "oi", "open_interest": "oi", "openinterest": "oi"}
    q = q.rename(columns={k: v for k, v in ren.items() if k in q.columns})
    for c in ("open", "high", "low", "close", "volume", "strike"):
        if c in q.columns:
            q[c] = pd.to_numeric(q[c], errors="coerce")
    if "oi" in q.columns:
        q["oi"] = pd.to_numeric(q["oi"], errors="coerce")
    q["timestamp"] = pd.to_datetime(q["timestamp"])
    q["option_type"] = q["option_type"].astype(str).str.upper()
    # a stable per-contract identity
    if "symbol" not in q.columns or q["symbol"].isna().all():
        q["symbol"] = ("UNKNOWN|" + q.get("expiry", "").astype(str) + "|"
                       + q["strike"].astype(str) + "|" + q["option_type"].astype(str))
    else:
        q["symbol"] = q["symbol"].astype(str)
    return q


def load_futures(path):
    if not path:
        return None
    if not os.path.exists(path):
        print(f"FUTURES_MISSING {path} -> falling back to put-call parity ATM")
        return None
    f = pd.read_csv(path)
    f.columns = [str(c).strip().lower() for c in f.columns]
    f = f.rename(columns={"date": "timestamp", "time": "timestamp",
                          "datetime": "timestamp"})
    f["timestamp"] = pd.to_datetime(f["timestamp"])
    for c in ("open", "high", "low", "close", "volume"):
        if c not in f.columns:
            f[c] = np.nan
        f[c] = pd.to_numeric(f[c], errors="coerce")
    return f


def main(argv=None):
    ap = argparse.ArgumentParser(description="Option buy-only backtester")
    ap.add_argument("--path", required=True, help="options CSV")
    ap.add_argument("--futures", default=None, help="index futures 1m CSV (preferred ATM source)")
    ap.add_argument("--outdir", default="runs/buyonly")
    ap.add_argument("--lot-size", type=int, default=15)
    ap.add_argument("--max-lots", type=int, default=5)
    ap.add_argument("--max-itm-steps", type=int, default=2)
    ap.add_argument("--target-itm-steps", type=int, default=1)
    ap.add_argument("--min-stop-points", type=float, default=30.0)
    ap.add_argument("--breakeven-points", type=float, default=2.5)
    ap.add_argument("--brokerage-per-order", type=float, default=20.0)
    ap.add_argument("--target-r", type=float, default=2.0)
    ap.add_argument("--max-hold-bars", type=int, default=45)
    ap.add_argument("--max-consecutive-losses", type=int, default=2)
    ap.add_argument("--n-perm", type=int, default=200)
    ap.add_argument("--no-regime-restrict", action="store_true",
                    help="allow any hypothesis in any regime (diagnostic only)")
    ap.add_argument("--single-hypothesis", default=None,
                    help="restrict to one hypothesis (report comparison)")
    ap.add_argument("--sensitivity", action="store_true",
                    help="re-run across a small parameter grid and report the spread")
    ap.add_argument("--timing-perms", type=int, default=30,
                    help="re-timed signal permutations for the timing test (0=skip)")
    args = ap.parse_args(argv)

    t0 = time.time()
    cfg = BuyOnlySettings(
        lot_size=args.lot_size, max_lots=args.max_lots,
        max_itm_steps=args.max_itm_steps, target_itm_steps=args.target_itm_steps,
        min_stop_points=args.min_stop_points, breakeven_points=args.breakeven_points,
        brokerage_per_order=args.brokerage_per_order, target_r=args.target_r,
        max_hold_bars=args.max_hold_bars,
        max_consecutive_losses=args.max_consecutive_losses)

    print("=" * 72)
    print("OPTION BUY-ONLY ENGINE  (long options only, ATM/ITM only)")
    print("=" * 72)
    print(f"CONFIG {cfg.fingerprint()}")

    q = load_quotes(args.path)
    fut = load_futures(args.futures)
    print(f"DATA rows={len(q)} contracts={q['symbol'].nunique()} "
          f"expiries={sorted(q['expiry'].astype(str).unique())[:4]} "
          f"days={pd.to_datetime(q['timestamp']).dt.normalize().nunique()}")
    print(f"OI_FIELD={'present' if 'oi' in q.columns and q['oi'].notna().any() else 'ABSENT'}")

    ref = build_reference(q, fut)
    print("MONEYNESS_AUDIT", json.dumps(audit_moneyness(ref, q)))

    u = build_underlying(q, fut)
    u = add_session_features(u, cfg.er_window)
    u = classify_regimes(u, cfg)
    rs = regime_summary(u)
    print("REGIMES", json.dumps(rs))
    print("UNDERLYING_SOURCE", json.dumps(u["underlying_source"].value_counts().to_dict()))

    sig, av = run_all(u, q, cfg)
    if args.single_hypothesis:
        sig = sig[sig["hypothesis"] == args.single_hypothesis]
    print("HYPOTHESIS_AVAILABILITY", json.dumps(av))
    print(f"SIGNALS generated={len(sig)}")
    if len(sig):
        print("SIGNALS_BY_HYPOTHESIS", json.dumps(
            sig["hypothesis"].value_counts().to_dict()))

    ledger, audit = run_backtest(
        sig, u, q, cfg, restrict_to_regime=not args.no_regime_restrict,
        cost_model=OptionCostModel(brokerage_per_order=cfg.brokerage_per_order,
                                   lot_size=cfg.lot_size, use_spread=False))
    print(f"TRADES executed={len(ledger)}")
    print("BLOCKED", json.dumps(audit.get("blocked", {})))

    summ = summarize(ledger, cfg, label="ALL")
    per_hyp = by_hypothesis(ledger, cfg)
    sigstat = significance(ledger, n_perm=args.n_perm)

    if summ["trades"]:
        print("-" * 72)
        print(f"WIN_RATE          {summ['win_rate']}%")
        print(f"PROFIT_FACTOR     {summ['profit_factor']}")
        print(f"MAX_DRAWDOWN      {summ['max_dd_points']} pts")
        print(f"TIME_TO_TARGET    {summ['time_to_target_bars']} bars "
              f"({summ['reached_target']}/{summ['trades']} reached, "
              f"{summ['target_hit_rate']}%)")
        print(f"NET               {summ['net_points']} pts / Rs {summ['rupee_pnl']}")
    print(f"SIGNIFICANCE      mean={sigstat.get('mean')} "
          f"CI95=[{sigstat.get('lo')}, {sigstat.get('hi')}] "
          f"excludes_zero={sigstat.get('excludes_zero')} ({sigstat.get('status')})")
    print("-" * 72)
    print(f"{'hypothesis':<18}{'n':>4}{'WR%':>8}{'PF':>8}{'net':>10}{'dur':>7}")
    for r in per_hyp:
        print(f"{r['label']:<18}{r['trades']:>4}{r['win_rate']:>8}{r['profit_factor']:>8}"
              f"{r['net_points']:>10}{r['avg_duration_bars']:>7}")

    timing = None
    if args.timing_perms > 0 and len(sig):
        print("-" * 72)
        print(f"ENTRY TIMING TEST: re-running the engine on {args.timing_perms} "
              f"re-timed signal sets")
        timing = signal_permutation_test(
            u, q, cfg, sig, observed_net=summ["net_points"],
            n_perm=args.timing_perms, seed=7,
            restrict_to_regime=not args.no_regime_restrict)
        print(f"  observed net = {timing.get('observed_net')}")
        print(f"  null mean    = {timing.get('null_mean')} "
              f"(sd {timing.get('null_sd')}, median {timing.get('null_median')})")
        print(f"  p            = {timing.get('p_value')} ({timing.get('status')})")

    sens = None
    if args.sensitivity:
        print("-" * 72)
        print("SENSITIVITY sweep (spreads are the point, not the best cell)")
        sens = sensitivity(u, q, cfg, restrict_to_regime=not args.no_regime_restrict)
        for r in sens["rows"]:
            print(f"  {r['param']}={r['value']:<6} n={r['trades']:<4} "
                  f"WR={r['win_rate']:<7} PF={r['profit_factor']:<7} net={r['net_points']}")
        print(f"  WR range {sens['win_rate_min']}..{sens['win_rate_max']} | "
              f"net range {sens['net_min']}..{sens['net_max']} | "
              f"profitable {sens['configs_profitable']}/{sens['configs_total']}")

    os.makedirs(args.outdir, exist_ok=True)
    if len(ledger):
        ledger.to_csv(os.path.join(args.outdir, "ledger.csv"), index=False)
    if per_hyp:
        pd.DataFrame(per_hyp).to_csv(os.path.join(args.outdir, "by_hypothesis.csv"),
                                     index=False)
    payload = {"summary": summ, "by_hypothesis": per_hyp, "significance": sigstat,
               "audit": {k: v for k, v in audit.items()},
               "regimes": rs, "availability": av,
               "moneyness": audit_moneyness(ref, q),
               "underlying_source": u["underlying_source"].value_counts().to_dict(),
               "sensitivity": sens, "timing_test": timing,
               "config": cfg.to_dict(), "config_fingerprint": cfg.fingerprint(),
               "runtime_seconds": round(time.time() - t0, 2)}
    with open(os.path.join(args.outdir, "summary.json"), "w") as f:
        json.dump(payload, f, indent=1, default=str)
    with open(os.path.join(args.outdir, "report.md"), "w") as f:
        f.write(report_markdown(summ, per_hyp, sigstat, audit, cfg, av, args.outdir,
                                sens=sens, timing=timing))
    with open(os.path.join(args.outdir, "logic_map.md"), "w") as f:
        f.write(logic_map())
    print(f"ARTIFACTS written to {args.outdir}")
    print(f"RUNTIME {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())