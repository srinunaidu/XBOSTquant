# XBOST — Formula Reference (mirrors `engine.js` exactly)

This file documents every computation the terminal performs, so results can be
validated independently (e.g. in Python/pandas). Nothing here is approximate:
variable names map 1:1 to the code.

---

## 1. Data ingestion (`parseCSV`)

- Expected columns: `date,open,high,low,close,volume` (header names matched
  case-insensitively; falls back to positional `0..5`).
- Timestamp: `Date.parse(date.replace(' ', 'T'))` → **browser-local time**.
  `2015-02-02 09:15:00` is treated as 09:15 in whatever timezone the browser runs in.
- Rows with any non-finite OHLC/timestamp are dropped; remaining bars are
  **sorted ascending by time**. No synthetic data exists anywhere in the pipeline.

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

## 5. Trade execution (`backtest`)

- **Entry**: market order at the **close of the signal bar** (no lookahead).
  Size = `qty × lotSize` shares. Direction filter: Long / Short / Both.
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
- `MaxDD %`: deepest trough of the account curve vs running peak (ruin-guarded).
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
  Net P&L. The Best-per-Indicator tab shows each strategy's champion under the
  active objective.

## 8. Known limitations (by design)

1. Stops/targets fill exactly at the trigger — no intrabar slippage modelling.
2. Same-bar SL+TP touch resolves to SL (conservative).
3. One position at a time, full-size entries, no pyramiding, no partial exits.
4. Corporate actions/splits are not adjusted — use split-adjusted data.
5. Timestamps are browser-local; session filter compares local clock HH:MM.
6. Backtests are historical simulations, not investment advice.
