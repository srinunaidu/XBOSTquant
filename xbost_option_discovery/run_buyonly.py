"""CLI: run the Option Buy-Only engine end to end.

    python -m xbost_option_discovery.run_buyonly \
        --path "Data test/banknifty_options.csv" \
        --futures "Data test/banknifty_futures_1m.csv" \
        --outdir runs/buyonly --log-level debug --sensitivity

Writes `ledger.csv`, `summary.json`, `by_hypothesis.csv`, `buyonly-bundle.json`,
`report.md`, `logic_map.md`, `run_log.txt` and `audit.jsonl`.

The full run log goes to stdout as well, so it can be piped or streamed live; the
UI tab consumes it over SSE while the run is still going.
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
from .buyonly.audit import RunLogger
from .buyonly.bundle import build_bundle
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
    if "symbol" not in q.columns or q["symbol"].isna().all():
        q["symbol"] = ("UNKNOWN|" + q.get("expiry", "").astype(str) + "|"
                       + q["strike"].astype(str) + "|" + q["option_type"].astype(str))
    else:
        q["symbol"] = q["symbol"].astype(str)
    return q


def load_futures(path, logger=None):
    if not path:
        if logger:
            logger.data("no --futures supplied: ATM comes from put-call parity only")
        return None
    if not os.path.exists(path):
        if logger:
            logger.data("futures file not found; falling back to put-call parity",
                        path=path)
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
    if logger:
        logger.data("futures loaded", rows=len(f),
                    days=pd.to_datetime(f["timestamp"]).dt.normalize().nunique())
    return f


def main(argv=None):
    ap = argparse.ArgumentParser(description="Option buy-only backtester")
    ap.add_argument("--path", required=True, help="options CSV")
    ap.add_argument("--futures", default=None, help="index futures 1m CSV")
    ap.add_argument("--outdir", default="runs/buyonly")
    ap.add_argument("--emit-bundle", default=None,
                    help="also write the UI bundle to this exact path")
    ap.add_argument("--log-level", default="info",
                    choices=["quiet", "info", "debug", "trace"])
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
    ap.add_argument("--timing-perms", type=int, default=30,
                    help="re-timed signal permutations (0 = skip)")
    ap.add_argument("--sensitivity", action="store_true",
                    help="re-run across a small parameter grid and report the spread")
    ap.add_argument("--no-regime-restrict", action="store_true")
    ap.add_argument("--single-hypothesis", default=None)
    args = ap.parse_args(argv)

    t0 = time.time()
    os.makedirs(args.outdir, exist_ok=True)
    log = RunLogger(outdir=args.outdir, level=args.log_level)

    cfg = BuyOnlySettings(
        lot_size=args.lot_size, max_lots=args.max_lots,
        max_itm_steps=args.max_itm_steps, target_itm_steps=args.target_itm_steps,
        min_stop_points=args.min_stop_points, breakeven_points=args.breakeven_points,
        brokerage_per_order=args.brokerage_per_order, target_r=args.target_r,
        max_hold_bars=args.max_hold_bars,
        max_consecutive_losses=args.max_consecutive_losses)

    log.rule("OPTION BUY-ONLY ENGINE")
    log.run("configuration", fingerprint=cfg.fingerprint())
    log.run("derived economics", lot_size=cfg.lot_size,
            brokerage_points=round(cfg.brokerage_points(), 4),
            breakeven_points=cfg.breakeven_points,
            breakeven_trigger_points=round(cfg.breakeven_trigger_points(), 4),
            min_stop_points=cfg.min_stop_points, target_r=cfg.target_r,
            max_hold_bars=cfg.max_hold_bars, target_itm_steps=cfg.target_itm_steps,
            max_itm_steps=cfg.max_itm_steps)
    log.run("constraint check", long_only=True, universe="ATM+ITM",
            max_lots=cfg.max_lots, indicators="price action + volume + OI only",
            rsi=False, macd=False, ma_crossover=False)

    log.rule("DATA")
    q = load_quotes(args.path)
    fut = load_futures(args.futures, log)
    days = pd.to_datetime(q["timestamp"]).dt.normalize()
    dataset_info = {
        "path": os.path.abspath(args.path),
        "rows": int(len(q)),
        "contracts": int(q["symbol"].nunique()),
        "sessions": int(days.nunique()),
        "expiries": sorted(q["expiry"].astype(str).unique().tolist())[:10],
        "option_types": sorted(q["option_type"].unique().tolist()),
        "strikes": int(q["strike"].nunique()),
        "has_oi": bool("oi" in q.columns and q["oi"].notna().any()),
        "has_futures": bool(fut is not None),
        "first_bar": str(pd.to_datetime(q["timestamp"]).min()),
        "last_bar": str(pd.to_datetime(q["timestamp"]).max()),
    }
    log.data("options chain ingested", **{k: v for k, v in dataset_info.items()
                                          if k not in ("expiries", "option_types")})
    log.data("oi field", present=dataset_info["has_oi"],
             note=("open interest available" if dataset_info["has_oi"] else
                   "ABSENT - OI_VELOCITY cannot be evaluated and will report "
                   "NOT_AVAILABLE rather than substituting a volume proxy"))

    ref = build_reference(q, fut)
    mon = audit_moneyness(ref, q)
    log.data("moneyness audit", **mon)
    if mon.get("atm_above_ladder") or mon.get("atm_below_ladder"):
        log.data("ATM lies OUTSIDE the listed strike ladder on some bars",
                 pct=mon.get("outside_ladder_pct"),
                 note="every listed contract is ITM there; reported, not hidden")

    u = build_underlying(q, fut)
    log.feature("underlying built", bars=len(u),
                source=dict(u["underlying_source"].value_counts().to_dict()),
                note="futures preferred; straddle proxy where futures is absent")
    u = add_session_features(u, cfg.er_window)
    feat_cols = ["vwap", "vwap_z", "range_pct", "range_pctile", "atr_pct",
                 "vol_ratio", "vol_pctile", "eff_ratio", "swing_high", "swing_low"]
    for c in feat_cols:
        if c in u.columns:
            na = float(u[c].isna().mean())
            log.feature(f"feature {c}", nan_pct=round(na * 100, 2),
                        ok=(na < 0.5))
    log.feature("causality policy",
                note="every feature uses bars <= t only; session-grouped windows")

    u = classify_regimes(u, cfg)
    rs = regime_summary(u)
    log.regime("regime distribution", **rs)
    log.regime("regime -> authorised hypothesis",
               COMPRESSING="VOLATILITY_COIL", TRENDING="LIQUIDITY_FLUSH",
               CHOPPY="(none - hard shutdown)")

    log.rule("SIGNALS")
    sig, av = run_all(u, q, cfg)
    for k, v in av.items():
        log.signal(f"availability {k}", status=v)
    if args.single_hypothesis:
        sig = sig[sig["hypothesis"] == args.single_hypothesis]
        log.signal("restricted to a single hypothesis",
                   hypothesis=args.single_hypothesis)
    log.signal("signals generated", total=len(sig),
               by_hypothesis=dict(sig["hypothesis"].value_counts().to_dict())
               if len(sig) else {})
    if len(sig):
        for _, r in sig.iterrows():
            log.at(2, "SIGNAL", "signal", ts=str(r["timestamp"]),
                   hypothesis=r["hypothesis"], direction=r["direction"],
                   detail=r["detail"], trig_hi=round(float(r["trigger_high"]), 2),
                   trig_lo=round(float(r["trigger_low"]), 2),
                   trig_close=round(float(r["trigger_close"]), 2))

    log.rule("ADAPTIVE ENGINE + EXECUTION")
    ledger, audit = run_backtest(
        sig, u, q, cfg, restrict_to_regime=not args.no_regime_restrict,
        cost_model=OptionCostModel(brokerage_per_order=cfg.brokerage_per_order,
                                   lot_size=cfg.lot_size, use_spread=False),
        logger=log)

    summ = summarize(ledger, cfg, label="ALL")
    per_hyp = by_hypothesis(ledger, cfg)
    sigstat = significance(ledger)

    log.rule("STATISTICS")
    log.stat("bootstrap CI on mean net points", mean=_r(sigstat.get("mean")),
             lo=_r(sigstat.get("lo")), hi=_r(sigstat.get("hi")),
             n=sigstat.get("n"), excludes_zero=sigstat.get("excludes_zero"))
    log.stat("why no ledger permutation test",
             note="the mean of a permuted return series is invariant, so such a "
                  "null always equals the observation (measured p=1.0 regardless "
                  "of data); timing is tested by re-timing signals instead")

    timing = None
    if args.timing_perms > 0 and len(sig):
        timing = signal_permutation_test(
            u, q, cfg, sig, observed_net=summ["net_points"],
            n_perm=args.timing_perms, seed=7,
            restrict_to_regime=not args.no_regime_restrict)
        log.stat("entry-timing test (signal re-timing null)",
                 observed_net=_r(timing.get("observed_net")),
                 null_mean=_r(timing.get("null_mean")),
                 null_sd=_r(timing.get("null_sd")),
                 null_median=_r(timing.get("null_median")),
                 p=timing.get("p_value"), n_perm=timing.get("n_perm"),
                 status=timing.get("status"))

    sens = None
    if args.sensitivity:
        from .buyonly.report import sensitivity as _sens
        sens = _sens(u, q, cfg, restrict_to_regime=not args.no_regime_restrict)
        for r in sens["rows"]:
            log.sweep("sensitivity", param=r["param"], value=r["value"],
                      trades=r["trades"], win_rate=r["win_rate"],
                      profit_factor=r["profit_factor"], net_points=r["net_points"])
        log.sweep("sensitivity spread",
                  win_rate_min=sens["win_rate_min"], win_rate_max=sens["win_rate_max"],
                  net_min=sens["net_min"], net_max=sens["net_max"],
                  profitable=f"{sens['configs_profitable']}/{sens['configs_total']}",
                  note="if the sign flips across the grid, the best cell is a noise "
                       "pocket rather than an edge")

    # ---- verdict, stated honestly ------------------------------------
    log.rule("VERDICT")
    if summ["trades"] == 0:
        log.verdict("NO_TRADES - the adaptive engine blocked every signal")
    else:
        log.verdict("headline", trades=summ["trades"], win_rate=summ["win_rate"],
                    profit_factor=summ["profit_factor"],
                    max_dd_points=summ["max_dd_points"],
                    time_to_target_bars=summ["time_to_target_bars"],
                    time_to_target_reached=f"{summ['reached_target']}/{summ['trades']}",
                    net_points=summ["net_points"], rupee_pnl=summ["rupee_pnl"])
        if per_hyp:
            best = per_hyp[0]
            log.verdict("best hypothesis by win rate", hypothesis=best["label"],
                        trades=best["trades"], win_rate=best["win_rate"],
                        profit_factor=best["profit_factor"],
                        net_points=best["net_points"],
                        caveat="small sample; see the significance tests below")
        pf = summ["profit_factor"]
        pf_ok = isinstance(pf, (int, float)) and pf == pf and pf > 1.0
        ci_ok = bool(sigstat.get("excludes_zero"))
        tp = timing.get("p_value") if timing and timing.get("status") == "TESTED" else None
        t_ok = bool(tp is not None and tp < 0.05)
        if pf_ok and ci_ok and t_ok:
            log.verdict("VALIDATED_EDGE",
                        note="profit factor > 1, mean CI excludes zero and timing beats random")
        else:
            log.verdict("NO_VALIDATED_EDGE",
                        profit_factor_gt_1=bool(pf_ok), mean_ci_excludes_zero=ci_ok,
                        timing_p=tp, timing_significant=t_ok,
                        note="descriptive only; do not trade on this until the "
                             "gates pass on more data")

    # ---- artifacts ----------------------------------------------------
    if len(ledger):
        ledger.to_csv(os.path.join(args.outdir, "ledger.csv"), index=False)
    if per_hyp:
        pd.DataFrame(per_hyp).to_csv(os.path.join(args.outdir, "by_hypothesis.csv"),
                                     index=False)
    payload = {"summary": summ, "by_hypothesis": per_hyp, "significance": sigstat,
               "timing_test": timing, "audit": audit, "regimes": rs,
               "availability": av, "moneyness": mon,
               "underlying_source": u["underlying_source"].value_counts().to_dict(),
               "sensitivity": sens, "dataset": dataset_info,
               "config": cfg.to_dict(), "config_fingerprint": cfg.fingerprint(),
               "runtime_seconds": round(time.time() - t0, 2)}
    with open(os.path.join(args.outdir, "summary.json"), "w") as f:
        json.dump(payload, f, indent=1, default=str)
    with open(os.path.join(args.outdir, "report.md"), "w") as f:
        f.write(report_markdown(summ, per_hyp, sigstat, audit, cfg, av,
                                args.outdir, sens=sens, timing=timing))
    with open(os.path.join(args.outdir, "logic_map.md"), "w") as f:
        f.write(logic_map())

    bundle = build_bundle(cfg, summ, per_hyp, sigstat, timing, sens, audit, rs,
                          av, mon,
                          u["underlying_source"].value_counts().to_dict(),
                          sig, ledger, log.lines, log.run_id, dataset_info,
                          int((time.time() - t0) * 1000))
    bundle["log_counts"] = log.summary_counts()
    bundle["log_level"] = args.log_level
    bundle["log_text"] = log.lines
    bundle_paths = [os.path.join(args.outdir, "buyonly-bundle.json")]
    if args.emit_bundle:
        bundle_paths.append(args.emit_bundle)
    for p in bundle_paths:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(p)) or ".", exist_ok=True)
            with open(p, "w") as f:
                json.dump(bundle, f, default=str)
        except Exception as e:
            log.data("bundle write failed", path=p, error=str(e))

    log.data("artifacts written", outdir=os.path.abspath(args.outdir),
             files=sorted(os.listdir(args.outdir)),
             bundle=bundle_paths, log_events=log.summary_counts())
    return 0


def _r(v):
    try:
        f = float(v)
        return round(f, 4) if np.isfinite(f) else "NA"
    except (TypeError, ValueError):
        return "NA"


if __name__ == "__main__":
    raise SystemExit(main())