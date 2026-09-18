# XBOST — Formula Reference (mirrors `engine.js` exactly)

This file documents every computation the terminal performs, so results can be
validated independently (e.g. in Python/pandas). Nothing here is approximate:
variable names map 1:1 to the code.

---

## 1. Data ingestion (`parseCSV`) — format auto-detect

The parser sniffs each file and adapts; no fixed template is assumed:

- **Headered files** (`date,open,high,low,close,volume`, also `datetime`,
  `settle/ltp`, `vol/qty`, `symbol/scrip` variants, any case): columns mapped
  by name. A lone `time` column holding full stamps is parsed as datetime.
- **Headerless positional files** (e.g. `SYMBOL,YYYYMMDD,HH:MM,O,H,L,C,VOLUME,OI`
  futures dumps): column roles inferred from the first 50 rows — leading text
  column = symbol, `YYYYMMDD` = date, `HH:MM[:SS]` = time, next 4 numerics =
  O/H/L/C, next numeric = volume. Anything else (expiry, OI, …) is ignored.
- **Timestamps**: epoch ms/s, ISO, `YYYY-MM-DD HH:MM:SS`, `YYYYMMDD`+`HH:MM`
  pairs — all normalised to browser-local ms. Bare `HH:MM` without a date is
  rejected. Unparseable rows are dropped; the rest are **sorted ascending**.
- **Symbol**: most frequent symbol-column value with `_F1`/`_FUT`-style suffixes
  stripped (`BANKNIFTY_F1` → `BANKNIFTY`); falls back to the file-name token.
  The detected layout string (e.g. `positional+SYM+D+T`) is shown under the data
  panel for confirmation. No synthetic data exists anywhere in the pipeline.

## 2. Resampling (`resample`, timeframe `tf` minutes)

- Bucket key: `b = floor(t / (tf · 60000))` (.call it "wall-clock grid", not session-anchored).
- Per bucket: `O = first open`, `H = max(high)`, `L = min(low)`,
  `C = last close`, `V = sum(volume)`; bar time = `b · tf · 60000`.
- `tf = 1` returns the input unchanged. Supported: 1, 2, 3, 4, 5, 7, 10, 15.

## 3. Indicators

`NaN` = warmup (no signal emitted from warmup bars). All sums/loops are causal
(only bars `≤ i`).

| # | Indicator | Formula |
|---|-----------|---------|
| 1 | SMA(p) | `sum(close[i-p+1..i]) / p` |
| 2 | EMA(p) | `k = 2/(p+1)`; seeded with SMA of first `p` closes, then `e = c·k + e_prev·(1-k)` |
| 3 | WMA(p) | O(n) rolling: `W[i] = W[i-1] + p·x[i] − S[i-1]`, `S` = rolling window sum, weights `1..p` oldest→newest, `/ (p(p+1)/2)` |
| 4 | HMA(p) | `diff = 2·WMA(p/2) − WMA(p)`; `HMA = WMA(diff, round(sqrt(p)))` |
| 5 | DEMA(p) | `2·EMA(p) − EMA(EMA(p))` |
| 6 | RSI(p) | Wilder: `g/l` smoothed with `(prev·(p-1)+x)/p`; `RSI = 100 − 100/(1+RS)` (`RS=100` if avg loss = 0) |
| 7 | ATR(p) | Wilder-smoothed True Range, `TR = max(h−l, \|h−c_prev\|, \|l−c_prev\|)` |
| 8 | MACD(f,s,g) | `line = EMA(f) − EMA(s)`; `signal = EMA(line, g)`; `hist = line − signal` |
| 9 | Bollinger(p,m) | `mid = SMA(p)`; band = `m · population-SD(p)` (divides by `p`, not `p−1`) |
| 10 | Keltner(eP,aP,m) | `mid = EMA(eP)`; band = `m · ATR(aP)` |
| 11 | Stochastic(k,d) | `%K = 100·(c − lowestLow_k)/(highestHigh_k − lowestLow_k)` (50 if range = 0); `%D = SMA(%K, d)` |
| 12 | SuperTrend(aP,m) | `basicUp = hl2 + m·ATR`, `basicLo = hl2 − m·ATR`, carried forward (never against trend); direction flips when close crosses the opposite line |
| 13 | ADX(p) + MA | Wilder-smoothed `+DM/−DM/TR` → `DX = 100·\|PDM−MDM\|/(PDM+MDM)` → ADX = Wilder average of DX |
| 14 | VWAP | Session cumulative `Σ(typical·vol)/Σvol`, `typical=(h+l+c)/3`; **resets every calendar day** |
| 15 | Chande-Kroll(p,m) | `longStop = highestHigh_p − m·ATR(p)`; `shortStop = lowestLow_p + m·ATR(p)` |
| 16 | POC(L) | Volume profile over trailing `L` bars in **24 price bins**; POC = centre of highest-volume bin (volume = bar volume, typical-price binned) |
| 17 | KAMA(er,f,s) ★ | Efficiency ratio `ER = \|c[i]−c[i−er]\| / Σ\|c[j]−c[j−1]\|` over `er` bars; `SC = (ER·(2/(f+1) − 2/(s+1)) + 2/(s+1))²`; `KAMA += SC·(c − KAMA)` |
| 18 | Fisher(p) ★ | Median price `hl2`; `v = clamp(2·((hl2−ll)/(hh−ll) − 0.5), ±0.999)` over trailing `p`; `F = 0.5·ln((1+v)/(1−v)) + 0.5·F_prev` |
| 19 | TTM Squeeze ★ | Squeeze ON when `BB(lo,up)` strictly inside `KC(lo,up)`; momentum = `close − SMA(hl2, kcP)`; FIRE on release bar |
| 20 | Connors RSI ★ | `CRSI = (RSI(rsiP) + RSI(up/down-streak, streakP) + PercentRank(ROC, rankP)) / 3`, PercentRank = % of last `rankP` ROCs below today's ROC × 100 |
| 21 | VWAP Bands ★ | Session VWAP ± `sd1·σ` / ± `sd2·σ`, `σ` = expanding session std of typical price |
| 22 | CVD ★ | Tick-rule delta `±volume` (sign of `close−open`), cumulated, **reset each session**; divergence vs trailing swing low/high over `lookback` |
| 23 | FVG ★ | Bull gap when `low[i] > high[i−2]`, zone `[high[i−2], low[i]]`; zones die on full mitigation or after `mitAge` bars (max `maxZones` live) |
| 24 | Regime gate ★ | Choppiness `100·log10(meanTR/range)/log10(p)`; trend EMA followed only when chop < `gate`, else flat (suppresses trend loops in ranges) |
| 25 | Choppiness filter | Same gate as Regime with independent `chopPeriod/gate/maPeriod` — standalone consolidation filter |
| 26 | Cyber Cycle ★ | Ehlers 2-pole Butterworth (`alpha`): smoothed high-pass recursion; zero-cross system for cyclical turns |
| 27 | VWMA | `Σ(price·vol)/Σvol` over `period`; price-vs-VWMA trend |
| 28 | CMO | `100·(Σup−Σdn)/(Σup+Σdn)` over `period`; RSI-style `oversold/overbought` holds |
| 29 | Aroon | `Up/Down = 100·(p−barsSince high/low)/p`; oscillator vs ±`level` with hold band |
| 30 | ★P SqueezeBreak | Squeeze release + volume spike (`vol > volMult·SMA20`) entries; **Chande-Kroll structural stops** (`period/ckMult` via exit bridge); TP stays live |
| 31 | ★P TrendRegime | Trades only when `chop < gate` AND SuperTrend bias AND MACD-hist sign agree; muted (flat) otherwise |
| 32 | ★P VWAPRev | Fades only the 1σ→2σ stretch (`sd1`–`sd2` band) when CMO shows exhaustion; holds otherwise |

★ = proprietary-style (rare in retail screeners).

## 4. Signal rules (`buildSignals` → position target per bar)

Flat (`0`) during indicator warmup; otherwise:

| Strategy | Long (+1) when | Short (−1) when | Else |
|----------|---------------|-----------------|------|
| EMA/SMA/HMA/DEMA/KAMA | close > MA | close < MA | — |
| Bollinger | close < lower | close > upper | hold previous |
| Keltner | close < lower | close > upper | hold previous |
| RSI / CRSI | value < oversold | value > overbought | hold previous |
| MACD | line > signal | line < signal | — |
| VWAP | close > VWAP | close < VWAP | — |
| SuperTrend | direction = +1 | direction = −1 | — |
| ADX | ADX ≥ threshold AND close > MA | ADX ≥ threshold AND close < MA | hold previous (weak trend) |
| Stochastic | %K < OS AND %K rising through %D | %K > OB AND %K falling through %D | hold previous |
| Chande-Kroll | close > shortStop | close < longStop | hold previous |
| POC | close > POC | close < POC | — |
| Fisher | F > 0 | F < 0 | — |
| Squeeze | squeeze releases with mom > 0 | squeeze releases with mom < 0 | hold last release direction |
| VWAPBands | close < −sd1 band | close > +sd1 band | hold previous |
| CVD | price undercuts trailing low while CVD holds higher (bullish divergence) | price exceeds trailing high while CVD holds lower | hold previous |
| FVG | low taps a live bull zone | high taps a live bear zone | flat (no touch) |
| Regime | chop < gate AND close > EMA | chop < gate AND close < EMA | flat when chop ≥ gate |
| Chop | chop < gate AND close > EMA | chop < gate AND close < EMA | flat when chop ≥ gate |
| Cyber | cycle > 0 | cycle < 0 | — |
| VWMA | close > VWMA | close < VWMA | — |
| CMO | CMO < oversold | CMO > overbought | hold previous |
| Aroon | osc > level | osc < −level | hold inside band |
| SqueezeBreak | squeeze release + volume spike, mom > 0 | release + spike, mom < 0 | hold last fire direction |
| TrendRegime | gate open + ST long + hist > 0 | gate open + ST short + hist < 0 | flat (muted) |
| VWAPRev | below −sd1 (above −sd2) + CMO exhausted | above +sd1 (below +sd2) + CMO exhausted | hold previous |

## 5. Trade execution (`backtest`) — hardened guards

- **G1 same-bar collision**: each bar precomputes `slTouch`/`tpTouch` from its
  High/Low; if both are touched the fill is strictly the stop (`SL`/`BE`),
  never the target — no optimistic TP-first bias. Verified by unit test.
- **G2 fill integrity**: signal trades fill at `close[i]` (`fill=close`) or
  exactly `open[i+1]` (`fill=next`); resting stops always fill intrabar at stop
  levels. Indicators only ever read bars `≤ i`.
- **G3 cash identity**: `finalCapital` is recomputed independently from the
  trade list; `strict` mode (default) **throws** on any discrepancy. Cost
  accounting is itemised: `totalCosts = n·cost`, `grossPreCost = net + costs`.
- **G4 ruin halt**: the moment live equity `≤ 0`, the tail is filled flat and
  the loop **breaks** (dead parameter sets cost O(1), not O(1M bars)).
- **G5 warmup quarantine**: `NaN` indicator outputs force target `0`; the L3
  audit asserts zero entries inside warmup.

## 5. Trade execution (`backtest`)

- **Entry**: market order at the **close of the signal bar** (`fill=close`, default,
  causal) or at the **next bar's open** (`fill=next`, stricter) — selectable in
  ⑥ Fill model. Resting stops always fill intrabar at stop levels; the final bar
  always closes at its close (no next open exists). No bar ever uses data past
  its fill point: indicators read bars `≤ i`, signals on `[i]` fill at `close[i]`
  or `open[i+1]`.
  Size = `qty × lotSize` shares. Direction filter: Long / Short / Both.
- **Entry gating** (`entry`):
  - `trigger` (default): a position opens ONLY on a fresh signal edge
    (target `0/∓1 → ±1`, or first computable bar) and never on an exit bar —
    after any exit the engine stands aside until the next new trigger. No
    flip-chains: an opposite signal closes to flat and is not re-entered.
  - `always`: classic always-in-the-market; flips re-enter immediately.
- **Warmup quarantine**: indicator outputs are `NaN` until warmed; signal targets
  stay `0` there, so no position can open on uncomputed values (asserted in T2b).
- **Session filter** (`buildSessionMask`, cached once per timeframe): bars outside
  `[sessionStart, sessionEnd]` force target `0` → positions are closed and none opened
  (intraday, no overnight).
- **Stop-loss** (`slPct` %): long exits if `low ≤ entry·(1−sl)`; short if `high ≥ entry·(1+sl)`.
  Fill assumed **exactly at the stop price**.
- **Target** (`tpPct` %): long exits if `high ≥ entry·(1+tp)`; short if `low ≤ entry·(1−tp)`.
- **Trailing** (`trailPct` %): tracks the favourable extreme, **armed only while the
  trade is profitable** (`ret > 0`); long exits if `low ≤ peak·(1−trail)`.
- **Exit mode** (`exit`, searched dimension):
  - `fixed`: SL / TP / trailing as above.
  - `breakeven`: once trade profit `ret ≥ beTrigger` (default = SL %, i.e. 1R),
    the stop floor locks to `entry·(1+beLock)` (default `beLock = 0` = flat);
    exits print reason `BE`. TP and trailing stay active.
  - `atr` (Chandelier): replaces the fixed SL with
    `longStop = highestHigh_since_entry − atrMult·ATR(atrP)` (mirror for shorts);
    exits print `ATR`. TP stays active; fixed SL and trailing are off.
- **Exit mode `ck`** (Chande-Kroll structural stop, searched dimension): replaces
  the fixed SL with `longStop = highestHigh − ckMult·ATR` trailing from entry
  (mirror for shorts, exits print `CK`); TP stays live. Preset legs carry their
  own `ckPeriod/ckMult` through `exitOptsFromParams`.
- **Session / carry** (`carry`, searched dimension): intraday (`carry=false`) uses
  the session mask (flat outside hours, no overnight); carry (`carry=true`)
  ignores the mask and holds positions across days. SL/TP/stops still apply.
- **Same-bar precedence: SL > TP > TRAIL** (conservative: if a 1-minute bar touches
  both stop and target, the stop is assumed hit first).
- **Signal flip**: close + immediate re-entry at the same close.
- **Costs**: `pnl = ±(exit − entry) · units − costPerTrade` (₹/trade, covers
  brokerage + taxes + slippage proxy). `%P&L` is quoted **pre-cost**.
- **Ruin guard**: live equity tracked per close; once `equity ≤ 0` no new positions
  are opened. Max drawdown is therefore bounded at ≈ −100% (the single trade
  that triggers ruin may overshoot by at most that trade's loss).

## 6. Performance metrics

- `Net P&L = finalCapital − capital`; `WinRate = 100·wins/trades`;
  `ProfitFactor = grossProfit/grossLoss` (`99.99` if no losers but profit, `0` if flat);
  `Expectancy = net/trades`.
- `MaxDD %`: deepest trough of the **mark-to-market** equity curve
  (open-position heat included every bar) vs running peak (ruin-guarded).
  Attributed with peak→trough timestamps; trade-log rows exiting inside that
  window carry a red edge so the drawdown's makers are visible — a cumulative
  slide needs no single culprit trade.
- `Sharpe / Sortino`: computed on **daily strategy returns**
  `r_d = ΣdayPnl / startingCapital` (all bar-days included, no-trade days = 0).
  Two deliberate choices: (1) the denominator is constant initial capital, never
  live equity — once equity goes negative, equity-based returns invert sign
  (`(−200+100)/−100 = +100%`) and fabricate ratios (this bug once printed
  Sortino 247 on a losing strategy); (2) daily aggregation keeps magnitudes
  comparable — per-trade annualisation explodes for 100+/day scalps.
  Annualised with `√252`; Sortino uses downside deviation vs 0
  (`99.99` if mean > 0 with no losing days, else `0`).
- `Trades/Day = trades / distinct UTC calendar days in the tested bars`.

## 7. Search

- **Stage 1 (grid)**: Cartesian product of timeframes × indicator params × SL × TP
  × exit-mode × intraday/carry
  (`expandRange` caps each axis at 25 values; whole grid capped by Max-Combos).
- **Stage 2 (refine)**: hill-climb on the top-20 rows — every param ±1 UI step
  plus SL/TP ±their steps (`paramNeighbors`) — repeated until the objective stops
  improving (max 4 passes, ≤600 candidates/pass). Refined rows are marked 🔁.
- **Ranking** (`rankResults` + `objectiveValue`): Sharpe (default), Sortino,
  WinRate, Trade count, or Drawdown (higher = closer to zero wins); ties break on
  Net P&L. Rows with **zero trades always rank below traded rows**, so a flat
  leg (e.g. a fully gated-out Regime) can never top a losing board. The
  Best-per-Indicator tab shows each strategy's champion under the active objective.

## 8. Known limitations (by design)

1. Stops/targets fill exactly at the trigger — no intrabar slippage modelling.
2. Same-bar SL+TP touch resolves to SL (conservative).
3. One position at a time, full-size entries, no pyramiding, no partial exits.
4. Corporate actions/splits are not adjusted — use split-adjusted data.
5. Timestamps are browser-local; session filter compares local clock HH:MM.
6. Backtests are historical simulations, not investment advice.
7. OHLCV only: the engine parses `date,open,high,low,close,volume` and nothing
   else. Volume is summed on resample; no open-interest, delivery, or
   quote-depth data is read or required.

## 9. Built-in validation (🛠 Developer panel → Debug & Validate)

Runs entirely on the LOADED live bars — zero synthetic data. Each run asserts:
- **L1 integrity**: timestamps strictly ascending, no duplicates, all OHLC finite.
- **L2 resample conservation**: 1m→5m preserves total volume exactly; bar counts
  and time bounds sane.
- **L3 warmup quarantine**: first non-zero EMA21 signal at bar ≥ 20 (no NaN-zone trades).
- **L4 identities with current sidebar settings**: `net == grossP − grossL` (costs
  live inside trade P&L); `final == capital + Σ traded P&L`; first 3 trades
  repriced tick-for-tick from their bars; next-open fills verified when ⑥ = next-open.
- **L5 exit legs engage live**: at least one `BE` and one `ATR` exit on the file.
- **L6 metrics finite**, drawdown within [−101, 0].
- **L7 session coverage %** and active fill/exit printed.
- Every validation and grid summary is appended to an in-memory session log,
  downloadable via **⬇ Download session log (.txt)**.
