# XBOST Option-Native Discovery — Final Report (RESEARCH_PRICE_MODEL)
run 20261002-085444-792ed5 | format=long | chain=['56500CE', '56500PE', '57000CE', '57000PE', '57500CE', '57500PE']
LIMITATION: One-month 1-minute option data is sufficient for discovery and structural research, but insufficient for strong long-horizon robustness claims.

## 1. DATA HEALTH
status=DATA_PARTIAL
rows=225927
timestamps=7895
days=21 2026-08-20 09:15:00..2026-09-18 15:39:00
missing=0 dup=0
completeness=0.6844 volcov=0.9994

## 2. CONTRACT / EXPIRY AUDIT
contracts_loaded = 6
  56500CE
  56500PE
  57000CE
  57000PE
  57500CE
  57500PE
EXPIRIES=1
  expiry 29SEP2026: rows=225927 expiry_loaded=1
MULTI_EXPIRY=NOT_AVAILABLE

## 3. DISCOVERY SEARCH SPACE
{"total_features_tested": 36, "total_relationships_tested": 41, "total_sequences_tested": 167, "total_states_tested": 125, "total_candidate_events": 27}

## 4. RAW PRICE DISCOVERIES
0 price candidates

## 5. VOLUME DISCOVERIES
volume_shock/confirmation/divergence tested; see candidates

## 6. CE/PE DISCOVERIES
cepe_ret_diff/ratio/vol/acc + 4 lead events tested

## 7. CROSS-STRIKE DISCOVERIES
spreads on ['56500CE', '56500PE', '57000CE', '57000PE', '57500CE', '57500PE']

## 8. LEAD/LAG DISCOVERIES
150 pair-lag tests k=1,2,3,5,10

## 9. SEQUENCE DISCOVERIES
12 seq patterns len<=3

## 10. STATE DISCOVERIES
6 states

## 11. INDICATOR BASELINES
BASELINE_RSI/BB/MA/ROC/VWAP/ATR kept separate as INDICATOR_BASELINE (VolRate pair = INDICATOR_BASELINE, not OPTION_CHAIN_DISCOVERY)

## 12. IS RESULTS
| candidate                  | discovery_family          | feature_definition   | timestamp_definition           | forward_label_definition   | type                    | contract   | direction   | timeframe   |   events |   clusters |   wins |   losses |   avg_winner |   avg_loser |   IS_expectancy |    IS_PF |   IS_TRADE_SHARPE |     IS_Sortino |   IS_MAE |   IS_MFE |   IS_DAILY_SHARPE |   IS_BOOTSTRAP_SHARPE |   IS_SURROGATE_SHARPE |   surrogate_p | surrogate_note                                                                                                                                         |   OOS_events |   OOS_expectancy |   OOS_WR | OOS_result        | METRIC_INTEGRITY   |       top5 |    rm_best3 |   perm_p | final_status   | failure_reason               |   perm_p_adj |
|:---------------------------|:--------------------------|:---------------------|:-------------------------------|:---------------------------|:------------------------|:-----------|:------------|:------------|---------:|-----------:|-------:|---------:|-------------:|------------:|----------------:|---------:|------------------:|---------------:|---------:|---------:|------------------:|----------------------:|----------------------:|--------------:|:-------------------------------------------------------------------------------------------------------------------------------------------------------|-------------:|-----------------:|---------:|:------------------|:-------------------|-----------:|------------:|---------:|:---------------|:-----------------------------|-------------:|
| EV:e_large_ret             | RAW_OPTION_PRICE          | e_large_ret          | signal bar close t (past-only) | fwd_ret_5m                 | OPTION_NATIVE_DISCOVERY | chain      | long        | 5m          |     1409 |        545 |    398 |     1011 |     0.993203 |   -0.499448 |     -0.0778193  | 0.782852 |        -4.34004   | -246.258       | 1.43972  | 1.49852  |        -11.0322   |             -4.32153  |            -4.34158   |      0.945274 | differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise |          556 |      -0.106115   | 0.26259  | OOS_REJECTED      | PASS               | -0.0456007 | -0.080119   | 0.945274 | ROBUST         | surrogate-fail;OOS_REJECTED  |            1 |
| EV:e_expansion             | RAW_OPTION_PRICE          | e_expansion          | signal bar close t (past-only) | fwd_ret_5m                 | OPTION_NATIVE_DISCOVERY | chain      | long        | 5m          |     2749 |       2023 |    886 |     1862 |     0.95445  |   -0.496468 |     -0.0286579  | 0.914779 |        -2.19154   |  -43.6108      | 1.08476  | 1.12074  |         -5.992    |             -2.28841  |            -2.19194   |      1        | differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise |          942 |      -0.0575557  | 0.296178 | OOS_REJECTED      | PASS               | -0.0634674 | -0.0297817  | 1        | ROBUST         | surrogate-fail;OOS_REJECTED  |            1 |
| EV:e_vol_shock             | OPTION_VOLUME             | e_vol_shock          | signal bar close t (past-only) | fwd_ret_5m                 | OPTION_NATIVE_DISCOVERY | chain      | long        | 5m          |     2991 |       1498 |    877 |     2113 |     0.969839 |   -0.497438 |     -0.0670472  | 0.809209 |        -5.44907   | -120.623       | 1.1938   | 1.17735  |        -13.3517   |             -5.45373  |            -5.44998   |      0.935323 | differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise |         1057 |      -0.0990814  | 0.267739 | OOS_REJECTED      | PASS               | -0.0249329 | -0.0681186  | 0.935323 | ROBUST         | surrogate-fail;OOS_REJECTED  |            1 |
| EV:ev_largeRet_volShock    | OPTION_VOLUME             | ev_largeRet_volShock | signal bar close t (past-only) | fwd_ret_5m                 | OPTION_NATIVE_DISCOVERY | chain      | long        | 5m          |      684 |        303 |    167 |      517 |     1        |   -0.499791 |     -0.133614   | 0.646305 |        -5.41969   | -734.822       | 1.61899  | 1.59303  |        -15.9072   |             -5.42436  |            -5.42366   |      1        | differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise |          287 |      -0.160279   | 0.226481 | OOS_REJECTED      | PASS               | -0.0547095 | -0.138608   | 1        | ROBUST         | surrogate-fail;OOS_REJECTED  |            1 |
| EV:ev_ce_leads_pe          | CE_PE_RELATIONSHIP        | ev_ce_leads_pe       | signal bar close t (past-only) | fwd_ret_5m                 | OPTION_NATIVE_DISCOVERY | chain      | long        | 5m          |      554 |        458 |    198 |      356 |     0.981817 |   -0.498615 |      0.0304925  | 1.09517  |         1.00609   |   34.7797      | 1.00776  | 1.00138  |          3.31381  |              0.971706 |             1.007     |      1        | differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise |          404 |       0.0175487  | 0.34901  | OOS_SURVIVED_MARK | PASS               |  0.295983  |  0.0252139  | 1        | ROBUST         | surrogate-fail               |            1 |
| EV:ev_pe_leads_ce          | CE_PE_RELATIONSHIP        | ev_pe_leads_ce       | signal bar close t (past-only) | fwd_ret_5m                 | OPTION_NATIVE_DISCOVERY | chain      | long        | 5m          |     1032 |        828 |    371 |      660 |     0.947738 |   -0.493479 |      0.0251115  | 1.07957  |         1.14932   |   17.5687      | 1.10579  | 1.07832  |          3.6781   |              1.11045  |             1.14988   |      1        | differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise |          224 |       0.0306426  | 0.357143 | OOS_SURVIVED_MARK | PASS               |  0.192938  |  0.0222693  | 1        | ROBUST         | surrogate-fail               |            1 |
| EV:ev_compress_expand      | CE_PE_RELATIONSHIP        | ev_compress_expand   | signal bar close t (past-only) | fwd_ret_5m                 | OPTION_NATIVE_DISCOVERY | chain      | long        | 5m          |      538 |        501 |    190 |      348 |     0.932706 |   -0.492845 |      0.0106023  | 1.03326  |         0.35469   |    4.99558     | 0.884014 | 1.00736  |          1.16418  |              0.376861 |             0.35502   |      1        | differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise |          180 |       0.00695387 | 0.338889 | OOS_SURVIVED_MARK | PASS               |  0.876576  |  0.00505423 | 1        | ROBUST         | concentration;surrogate-fail |            1 |
| EV:e_atm_move              | CROSS_STRIKE_RELATIONSHIP | e_atm_move           | signal bar close t (past-only) | fwd_ret_5m                 | OPTION_NATIVE_DISCOVERY | chain      | long        | 5m          |     2600 |       1049 |    782 |     1818 |     0.986929 |   -0.499273 |     -0.0522694  | 0.850277 |        -3.90013   | -177.873       | 1.29136  | 1.30781  |        -10.4767   |             -3.92501  |            -3.90088   |      1        | differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise |          974 |      -0.10729    | 0.261807 | OOS_REJECTED      | PASS               | -0.0367916 | -0.053485   | 1        | ROBUST         | surrogate-fail;OOS_REJECTED  |            1 |
| EV:ev_ret_vol_expand       | EVENT                     | ev_ret_vol_expand    | signal bar close t (past-only) | fwd_ret_5m                 | OPTION_NATIVE_DISCOVERY | chain      | long        | 5m          |      175 |        131 |     46 |      129 |     1        |   -0.5      |     -0.105714   | 0.713178 |        -2.11194   |   -1.82406e+14 | 1.7251   | 1.82286  |         -4.54979  |             -2.16279  |            -2.118     |      1        | differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise |           73 |      -0.0890411  | 0.273973 | OOS_REJECTED      | PASS               | -0.27027   | -0.125      | 1        | ROBUST         | surrogate-fail;OOS_REJECTED  |            1 |
| SEQ:seq2=weak_up|weak_down | SEQUENCE                  | weak_up|weak_down    | signal bar close t (past-only) | fwd_ret_5m                 | OPTION_NATIVE_DISCOVERY | chain      | long        | 5m          |     3274 |       2772 |   1117 |     2156 |     0.951207 |   -0.494319 |     -0.00099347 | 0.996948 |        -0.0818929 |   -1.24175     | 0.846269 | 0.862022 |         -0.293206 |             -0.054432 |            -0.0819054 |      1        | differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise |          900 |      -0.0109031  | 0.326667 | OOS_REJECTED      | PASS               | -1.53722   | -0.00191153 | 1        | RANKABLE       | surrogate-fail;OOS_REJECTED  |            1 |

## 13. OOS RESULTS
OOS gate applied; THIN_OOS if oos_n<20

## 14. WALK-FORWARD RESULTS
| train                                                                                                                                                                                                                            | test                                                                                 |
|:---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:-------------------------------------------------------------------------------------|
| [datetime.date(2026, 8, 20), datetime.date(2026, 8, 21), datetime.date(2026, 8, 24), datetime.date(2026, 8, 25), datetime.date(2026, 8, 26), datetime.date(2026, 8, 27), datetime.date(2026, 8, 28), datetime.date(2026, 8, 31)] | [datetime.date(2026, 9, 1), datetime.date(2026, 9, 2), datetime.date(2026, 9, 3)]    |
| [datetime.date(2026, 8, 25), datetime.date(2026, 8, 26), datetime.date(2026, 8, 27), datetime.date(2026, 8, 28), datetime.date(2026, 8, 31), datetime.date(2026, 9, 1), datetime.date(2026, 9, 2), datetime.date(2026, 9, 3)]    | [datetime.date(2026, 9, 4), datetime.date(2026, 9, 7), datetime.date(2026, 9, 8)]    |
| [datetime.date(2026, 8, 28), datetime.date(2026, 8, 31), datetime.date(2026, 9, 1), datetime.date(2026, 9, 2), datetime.date(2026, 9, 3), datetime.date(2026, 9, 4), datetime.date(2026, 9, 7), datetime.date(2026, 9, 8)]       | [datetime.date(2026, 9, 9), datetime.date(2026, 9, 10), datetime.date(2026, 9, 11)]  |
| [datetime.date(2026, 9, 2), datetime.date(2026, 9, 3), datetime.date(2026, 9, 4), datetime.date(2026, 9, 7), datetime.date(2026, 9, 8), datetime.date(2026, 9, 9), datetime.date(2026, 9, 10), datetime.date(2026, 9, 11)]       | [datetime.date(2026, 9, 15), datetime.date(2026, 9, 16), datetime.date(2026, 9, 17)] |

## 15. ROBUSTNESS
time/CE-PE/strike/perturb/best-removal/concentration/dependence in candidates.csv

## 16. MULTIPLE-TESTING
BH-adjusted; {"total_features_tested": 36, "total_relationships_tested": 41, "total_sequences_tested": 167, "total_states_tested": 125, "total_candidate_events": 27}

## 17. TOP SURVIVING PATTERNS
| candidate   | discovery_family   | feature_definition   | timestamp_definition   | forward_label_definition   | type   | contract   | direction   | timeframe   | events   | clusters   | wins   | losses   | avg_winner   | avg_loser   | IS_expectancy   | IS_PF   | IS_TRADE_SHARPE   | IS_Sortino   | IS_MAE   | IS_MFE   | IS_DAILY_SHARPE   | IS_BOOTSTRAP_SHARPE   | IS_SURROGATE_SHARPE   | surrogate_p   | surrogate_note   | OOS_events   | OOS_expectancy   | OOS_WR   | OOS_result   | METRIC_INTEGRITY   | top5   | rm_best3   | perm_p   | final_status   | failure_reason   | perm_p_adj   |
|-------------|--------------------|----------------------|------------------------|----------------------------|--------|------------|-------------|-------------|----------|------------|--------|----------|--------------|-------------|-----------------|---------|-------------------|--------------|----------|----------|-------------------|-----------------------|-----------------------|---------------|------------------|--------------|------------------|----------|--------------|--------------------|--------|------------|----------|----------------|------------------|--------------|

## 18. OPTION-NATIVE BACKTEST
RESEARCH_PRICE_MODEL only; fingerprint-verified; run only on survivors

## 19. PAPER ELIGIBILITY
PAPER_ELIGIBLE = NO

## 20. FAILURE REASONS
train/OOS disagreement; THIN_OOS; concentration>0.5; perm fail; see failure_reason col

NO_LOOKAHEAD_TEST=PASS
METRIC_DEFINITION_AUDIT=PASS