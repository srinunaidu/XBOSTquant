# XBOST Option-Native Discovery — Final Report (RESEARCH_PRICE_MODEL)
run 20261002-075713-b8f4b5 | format=long | chain=['56500CE', '56500PE', '57000CE', '57000PE', '57500CE', '57500PE']
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
{"total_features_tested": 36, "total_relationships_tested": 41, "total_sequences_tested": 167, "total_states_tested": 125, "total_candidate_events": 37}

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
0 seq patterns len<=3

## 10. STATE DISCOVERIES
0 states

## 11. INDICATOR BASELINES
BASELINE_RSI/BB/MA/ROC/VWAP/ATR kept separate as INDICATOR_BASELINE (VolRate pair = INDICATOR_BASELINE, not OPTION_CHAIN_DISCOVERY)

## 12. IS RESULTS
| candidate                  | type                   | contract   | direction   | timeframe   |   events |   clusters |    IS_WR |   IS_expectancy |    IS_PF |   IS_raw_trade_sharpe |   IS_daily_sharpe |   IS_bootstrap_sharpe |   IS_surrogate_sharpe |   OOS_events |   OOS_WR |   OOS_expectancy |   OOS_PF |   OOS_sharpe_oos | param_stability                                                   | time_stability                                                                                                                                          |       top1 |      top5 |      top10 |   rm_best3 |   rm_bestday1 |   perm_p | final_status   | failure_reason          |   perm_p_adj |
|:---------------------------|:-----------------------|:-----------|:------------|:------------|---------:|-----------:|---------:|----------------:|---------:|----------------------:|------------------:|----------------------:|----------------------:|-------------:|---------:|-----------------:|---------:|-----------------:|:------------------------------------------------------------------|:--------------------------------------------------------------------------------------------------------------------------------------------------------|-----------:|----------:|-----------:|-----------:|--------------:|---------:|:---------------|:------------------------|-------------:|
| EV:e_large_ret             | OPTION_CHAIN_DISCOVERY | chain      | long        | 5m          |     1409 |        545 | 0.518808 |       0.248403  | 1.19191  |             2.33589   |         5.42018   |             2.33712   |             2.33672   |          556 | 0.566547 |        0.530225  | 1.39035  |        2.77375   | {'base': 0.24840255205939918, 'shifted': 0.4424215262446851}      | {'09:15-10:00': 0.5233541373555467, '10:00-12:00': 0.012312172652570846, '12:00-14:00': 0.07507072649775585, '14:00-15:15': -0.02186316974228453}       |  0.0884156 |  0.308881 |   0.482934 |  0.194448  |     0.132889  | 0.308458 | ROBUST         | perm-fail               |            1 |
| EV:e_vol_shock             | OPTION_CHAIN_DISCOVERY | chain      | long        | 5m          |     2991 |       1498 | 0.486125 |       0.0016219 | 1.00134  |             0.0231135 |         0.0789077 |             0.0340928 |             0.0231173 |         1057 | 0.492904 |        0.0463503 | 1.03307  |        0.344161  | {'base': 0.0016219035064344225, 'shifted': 0.09956791378181995}   | {'09:15-10:00': 0.05219882746186701, '10:00-12:00': 0.02459099983299707, '12:00-14:00': 0.04778501508288722, '14:00-15:15': -0.1828660703535526}        | 10.8278    | 27.7858   |  44.5236   | -0.0305826 |    -0.0289037 | 0.427861 | RANKABLE       | concentration;perm-fail |            1 |
| EV:e_compression           | OPTION_CHAIN_DISCOVERY | chain      | long        | 5m          |     6354 |       3066 | 0.480957 |      -0.0091648 | 0.988881 |            -0.250098  |        -0.910916  |            -0.291996  |            -0.250118  |         1865 | 0.49437  |        0.0766451 | 1.07323  |        0.932794  | {'base': -0.009164798621316696, 'shifted': -0.026579701733278047} | {'09:15-10:00': -0.16581575326705633, '10:00-12:00': -0.0054988320725615865, '12:00-14:00': 0.017767357617533012, '14:00-15:15': 0.04338836121789717}   | -0.613842  | -2.86667  |  -5.06818  | -0.0257907 |    -0.0313344 | 0.970149 | RANKABLE       | perm-fail               |            1 |
| EV:e_expansion             | OPTION_CHAIN_DISCOVERY | chain      | long        | 5m          |     2749 |       2023 | 0.517643 |       0.121147  | 1.12756  |             2.04885   |         6.40028   |             2.04923   |             2.04922   |          942 | 0.519108 |        0.10352   | 1.07946  |        0.826029  | {'base': 0.1211473743339187, 'shifted': 0.14219186223155703}      | {'09:15-10:00': 0.14372524820599886, '10:00-12:00': 0.05337014277299576, '12:00-14:00': 0.18467353907184128, '14:00-15:15': 0.018675197198441986}       |  0.127485  |  0.41037  |   0.633563 |  0.0862691 |     0.0857267 | 0.995025 | ROBUST         | perm-fail               |            1 |
| EV:ev_largeRet_volShock    | OPTION_CHAIN_DISCOVERY | chain      | long        | 5m          |      684 |        303 | 0.49269  |      -0.046595  | 0.969677 |            -0.300457  |        -0.934572  |            -0.280259  |            -0.300677  |          287 | 0.54007  |        0.247926  | 1.17545  |        1.08374   | {'base': -0.04659501072631928, 'shifted': 0.29130507659891763}    | {'09:15-10:00': -0.0016313053305158356, '10:00-12:00': -0.17515096103999822, '12:00-14:00': -0.030414486280884053, '14:00-15:15': -0.17637579230209777} | -0.429099  | -1.87371  |  -3.42809  | -0.10295   |    -0.131866  | 0.716418 | RANKABLE       | perm-fail               |            1 |
| EV:ev_compress_expand      | OPTION_CHAIN_DISCOVERY | chain      | long        | 5m          |      538 |        501 | 0.535316 |       0.205902  | 1.26874  |             1.73865   |         6.78118   |             1.76505   |             1.74027   |          180 | 0.544444 |        0.136415  | 1.11749  |        0.539964  | {'base': 0.20590226241751874, 'shifted': 0.3076048004075609}      | {'09:15-10:00': 0.48893579751959493, '10:00-12:00': 0.048657288684144415, '12:00-14:00': 0.23971872141473682, '14:00-15:15': 0.5142838230366367}        |  0.197276  |  0.624639 |   0.979797 |  0.114947  |     0.160178  | 0.99005  | ROBUST         | concentration;perm-fail |            1 |
| EV:ev_ret_vol_expand       | OPTION_CHAIN_DISCOVERY | chain      | long        | 5m          |      175 |        131 | 0.457143 |      -0.314483  | 0.806766 |            -0.985204  |        -3.84034   |            -0.990306  |            -0.988031  |           73 | 0.438356 |       -0.185854  | 0.878725 |       -0.424668  | {'base': -0.31448333362272757, 'shifted': 0.6691059504488557}     | {'09:15-10:00': -0.32977342562223905, '10:00-12:00': -1.4971043904666264, '12:00-14:00': -0.16229371598190637, '14:00-15:15': -0.1926910892107342}      | -0.223398  | -0.880698 |  -1.47716  | -0.507728  |    -0.469571  | 0.139303 | ROBUST         | perm-fail               |            1 |
| EV:ev_ce_leads_pe          | OPTION_CHAIN_DISCOVERY | chain      | long        | 5m          |      554 |        458 | 0.49639  |      -0.0206954 | 0.981553 |            -0.132794  |        -1.11196   |            -0.159809  |            -0.132914  |          404 | 0.492574 |        0.0259021 | 1.02239  |        0.140454  | {'base': -0.020695398286880905, 'shifted': -0.11767545221782076}  | {'09:15-10:00': -0.23556924504906132, '10:00-12:00': 0.10660598290050094, '12:00-14:00': 0.07264799361880919, '14:00-15:15': -0.08632671403196282}      | -2.06815   | -8.00602  | -12.7346   | -0.13009   |    -0.0587193 | 1        | RANKABLE       | perm-fail               |            1 |
| EV:ev_pe_leads_ce          | OPTION_CHAIN_DISCOVERY | chain      | long        | 5m          |     1032 |        828 | 0.491279 |       0.191043  | 1.16302  |             1.16028   |         3.60991   |             1.14574   |             1.16084   |          224 | 0.486607 |        0.0196365 | 1.01343  |        0.0510285 | {'base': 0.19104313596675895, 'shifted': 0.15992041438617569}     | {'09:15-10:00': -0.12994253833677144, '10:00-12:00': -0.013691230500277587, '12:00-14:00': -0.004962027631201058, '14:00-15:15': 0.04152362588522634}   |  0.264189  |  0.987135 |   1.76867  |  0.0695909 |     0.0268064 | 0.706468 | ROBUST         | concentration;perm-fail |            1 |
| SEQ:seq2=weak_up|weak_down | OPTION_CHAIN_DISCOVERY | chain      | long        | 5m          |     3271 |       2772 | 0.493121 |       0.015689  | 1.01842  |             0.285329  |         0.921148  |             0.237452  |             0.285373  |          897 | 0.490524 |       -0.0267864 | 0.977666 |       -0.189563  | {'base': 0.01568896977656728, 'shifted': -0.012614267321174004}   | {'09:15-10:00': 0.10142380241178012, '10:00-12:00': -0.0005563392234915468, '12:00-14:00': -0.11130422488684127, '14:00-15:15': -0.11408511619706178}   |  1.01496   |  3.65853  |   6.14766  | -0.0241648 |    -0.0161363 | 0.910448 | RANKABLE       | concentration;perm-fail |            1 |

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
BH-adjusted; {"total_features_tested": 36, "total_relationships_tested": 41, "total_sequences_tested": 167, "total_states_tested": 125, "total_candidate_events": 37}

## 17. TOP SURVIVING PATTERNS
| candidate   | type   | contract   | direction   | timeframe   | events   | clusters   | IS_WR   | IS_expectancy   | IS_PF   | IS_raw_trade_sharpe   | IS_daily_sharpe   | IS_bootstrap_sharpe   | IS_surrogate_sharpe   | OOS_events   | OOS_WR   | OOS_expectancy   | OOS_PF   | OOS_sharpe_oos   | param_stability   | time_stability   | top1   | top5   | top10   | rm_best3   | rm_bestday1   | perm_p   | final_status   | failure_reason   | perm_p_adj   |
|-------------|--------|------------|-------------|-------------|----------|------------|---------|-----------------|---------|-----------------------|-------------------|-----------------------|-----------------------|--------------|----------|------------------|----------|------------------|-------------------|------------------|--------|--------|---------|------------|---------------|----------|----------------|------------------|--------------|

## 18. OPTION-NATIVE BACKTEST
RESEARCH_PRICE_MODEL only; fingerprint-verified; run only on survivors

## 19. PAPER ELIGIBILITY
PAPER_ELIGIBLE = NO

## 20. FAILURE REASONS
train/OOS disagreement; THIN_OOS; concentration>0.5; perm fail; see failure_reason col

NO_LOOKAHEAD_TEST=PASS
METRIC_DEFINITION_AUDIT=PASS