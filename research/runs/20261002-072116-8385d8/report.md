# XBOST Option Discovery — First Run Report (RESEARCH_PRICE_MODEL)

run_id: 20261002-072116-8385d8 | dataset: Data test/banknifty_options.csv (long) | hash: 0b39c93ed9cc9804
code_version: v2.0-first-run | feature_version: raw-v1 | seed: 42
train: 2026-08-20..2026-09-08 | test: 2026-09-09..2026-09-18
tests: features=25 events=12 pairs=120 seqs=2938 states=440

## Dataset
- total_rows: 225927
- unique_timestamps: 7895
- duplicate_rows: 0
- median_interval: 0 days 00:01:00
- mode_interval: 0 days 00:01:00
- maximum_gap: 3 days 17:46:00
- missing_expected_intervals: 0
- trading_days: 21
- session_start: 09:15:00
- session_end: 15:39:00
- n_contracts: 42
- expiries: ['29SEP2026']
- ts_min: 2026-08-20 09:15:00
- ts_max: 2026-09-18 15:39:00
- is_1m: True
- contracts: 55500CE, 55500PE, 55600CE, 55600PE, 55700CE, 55700PE, 55800CE, 55800PE, 55900CE, 55900PE, 56000CE, 56000PE...
- focus_strikes: ['57500', '57000', '56500']
- splits: {'discovery': ['2026-08-20', '2026-08-21', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02'], 'refinement': ['2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08'], 'pseudo_oos': ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-15'], 'holdout': ['2026-09-16', '2026-09-17', '2026-09-18']}

## Top discovered structures (ranked by OOS expectancy, stability, permutation)
| candidate_id                                                  |   n |   n_indep |   indep_days |   mean_train |   mean_oos |   median_all |   win_rate |   top3_conc |    perm_p |   perm_p_adj | status             | description                                                            |
|:--------------------------------------------------------------|----:|----------:|-------------:|-------------:|-----------:|-------------:|-----------:|------------:|----------:|-------------:|:-------------------|:-----------------------------------------------------------------------|
| STATE:low/mid/vhigh/pe_weak                                   |  53 |        51 |           20 |   -0.350994  |    9.41886 |    0.222863  |   0.603774 |   1.27475   | 1         |            1 | RESEARCH_CANDIDATE | state low/mid/vhigh/pe_weak forward 5m                                 |
| SEQ:seq_5=strong_down|weak_down|weak_up|weak_up|strong_down   |  77 |        77 |           20 |    0.962099  |    7.56333 |    0.712115  |   0.636364 |   0.755724  | 1         |            1 | RESEARCH_CANDIDATE | pattern strong_down|weak_down|weak_up|weak_up|strong_down forward 5m   |
| SEQ:seq_5=weak_down|flat|strong_down|weak_up|weak_up          |  74 |        74 |           19 |    1.67815   |    6.49221 |    0.676799  |   0.648649 |   0.69601   | 0.845771  |            1 | RESEARCH_CANDIDATE | pattern weak_down|flat|strong_down|weak_up|weak_up forward 5m          |
| STATE:low/high/high/ce_weak                                   |  67 |        64 |           16 |    0.532527  |    6.12174 |    0.763954  |   0.597015 |   0.724416  | 1         |            1 | RESEARCH_CANDIDATE | state low/high/high/ce_weak forward 5m                                 |
| SEQ:seq_5=strong_up|strong_up|strong_up|strong_up|strong_down | 196 |       196 |           18 |    0.550725  |    4.54719 |    2.25269   |   0.693878 |   0.0919214 | 0.875622  |            1 | RESEARCH_CANDIDATE | pattern strong_up|strong_up|strong_up|strong_up|strong_down forward 5m |
| SEQ:seq_5=weak_down|weak_down|strong_up|strong_up|strong_up   |  66 |        66 |           14 |   -0.126928  |    5.63982 |    0.155812  |   0.515152 |   0.299011  | 0.995025  |            1 | RESEARCH_CANDIDATE | pattern weak_down|weak_down|strong_up|strong_up|strong_up forward 5m   |
| SEQ:seq_5=weak_down|strong_up|strong_up|strong_up|weak_down   |  51 |        51 |           16 |    0.870744  |    4.40089 |    1.75      |   0.686275 |   0.459831  | 0.960199  |            1 | RESEARCH_CANDIDATE | pattern weak_down|strong_up|strong_up|strong_up|weak_down forward 5m   |
| STATE:low/mid/mid/ce_weak                                     | 177 |       175 |           21 |   -0.0513483 |    4.98114 |    0.430194  |   0.59322  |   0.66993   | 0.950249  |            1 | RESEARCH_CANDIDATE | state low/mid/mid/ce_weak forward 5m                                   |
| SEQ:seq_5=strong_down|strong_up|strong_up|strong_up|strong_up | 152 |       152 |           16 |   -0.093393  |    3.39805 |    1.7206    |   0.638158 |   0.0948371 | 0.268657  |            1 | RESEARCH_CANDIDATE | pattern strong_down|strong_up|strong_up|strong_up|strong_up forward 5m |
| STATE:low/mid/vhigh/ce_weak                                   |  72 |        72 |           20 |    0.0895761 |    4.1099  |    0.837749  |   0.694444 |   0.656602  | 1         |            1 | RESEARCH_CANDIDATE | state low/mid/vhigh/ce_weak forward 5m                                 |
| STATE:low/high/low/ce_weak                                    |  79 |        73 |           15 |    0.415364  |    4.69205 |    0.0812274 |   0.518987 |   1.09561   | 1         |            1 | RESEARCH_CANDIDATE | state low/high/low/ce_weak forward 5m                                  |
| STATE:vlow/high/high/ce_lead                                  |  83 |        69 |           12 |    0.513519  |    3.27699 |    1.22097   |   0.698795 |   0.281272  | 0.970149  |            1 | RESEARCH_CANDIDATE | state vlow/high/high/ce_lead forward 5m                                |
| SEQ:seq_5=strong_down|weak_up|weak_down|weak_down|strong_up   |  93 |        93 |           20 |    1.0182    |    2.97931 |    1.10789   |   0.677419 |   0.243213  | 0.935323  |            1 | RESEARCH_CANDIDATE | pattern strong_down|weak_up|weak_down|weak_down|strong_up forward 5m   |
| STATE:low/high/mid/ce_weak                                    | 108 |       102 |           19 |   -0.0873858 |    3.67362 |    0.0900807 |   0.537037 |   0.752553  | 0.995025  |            1 | RESEARCH_CANDIDATE | state low/high/mid/ce_weak forward 5m                                  |
| SEQ:seq_4=flat|flat|weak_down|strong_down                     | 262 |       262 |           21 |    0.483392  |    3.00623 |    0.379523  |   0.591603 |   0.689841  | 0.746269  |            1 | RESEARCH_CANDIDATE | pattern flat|flat|weak_down|strong_down forward 5m                     |
| SEQ:seq_5=weak_up|weak_down|weak_down|strong_up|strong_up     |  90 |        90 |           18 |    1.82136   |    1.76806 |    2.01467   |   0.7      |   0.260211  | 0.701493  |            1 | RESEARCH_CANDIDATE | pattern weak_up|weak_down|weak_down|strong_up|strong_up forward 5m     |
| SEQ:seq_4=weak_down|weak_down|strong_up|strong_up             | 350 |       350 |           21 |    0.552794  |    2.33571 |    0.238661  |   0.531429 |   0.428721  | 0.875622  |            1 | RESEARCH_CANDIDATE | pattern weak_down|weak_down|strong_up|strong_up forward 5m             |
| SEQ:seq_5=weak_down|weak_down|strong_up|strong_up|weak_up     |  64 |        64 |           18 |    1.2442    |    2.00348 |    0.78881   |   0.640625 |   0.334741  | 1         |            1 | RESEARCH_CANDIDATE | pattern weak_down|weak_down|strong_up|strong_up|weak_up forward 5m     |
| STATE:vlow/low/high/neutral                                   | 449 |       417 |           21 |    0.92132   |    1.79028 |    0.482733  |   0.576837 |   0.352134  | 0.676617  |            1 | RESEARCH_CANDIDATE | state vlow/low/high/neutral forward 5m                                 |
| SEQ:seq_4=flat|strong_up|strong_up|flat                       | 121 |       119 |           20 |    1.04589   |    1.73498 |    0.208768  |   0.53719  |   0.614743  | 0.0348259 |            1 | RESEARCH_CANDIDATE | pattern flat|strong_up|strong_up|flat forward 5m                       |

## Lead/Lag leaderboard
| source   | target   |   lag |    n |   mean_fwd5 |   median_fwd5 |   win_rate | kind   |
|:---------|:---------|------:|-----:|------------:|--------------:|-----------:|:-------|
| 57500CE  | 57500PE  |     1 | 4144 |  0.0449343  |     0.031219  |   0.506998 | CE->PE |
| 57500CE  | 57500PE  |     2 | 4143 |  0.0640868  |     0.0528018 |   0.510741 | CE->PE |
| 57500CE  | 57500PE  |     3 | 4142 |  0.0650528  |     0.0347057 |   0.507726 | CE->PE |
| 57500CE  | 57500PE  |     5 | 4140 |  0.0785627  |     0.0153008 |   0.502174 | CE->PE |
| 57500CE  | 57000CE  |     1 | 4241 | -0.0205202  |    -0.0690369 |   0.481726 | CE->CE |
| 57500CE  | 57000CE  |     2 | 4240 | -0.0407513  |    -0.0943875 |   0.478774 | CE->CE |
| 57500CE  | 57000CE  |     3 | 4239 | -0.0524719  |    -0.0761421 |   0.481481 | CE->CE |
| 57500CE  | 57000CE  |     5 | 4237 | -0.0684553  |    -0.0771699 |   0.480529 | CE->CE |
| 57500CE  | 57000PE  |     1 | 4269 |  0.0337613  |     0.0368902 |   0.505271 | CE->PE |
| 57500CE  | 57000PE  |     2 | 4268 |  0.0486477  |     0.0429341 |   0.507498 | CE->PE |
| 57500CE  | 57000PE  |     3 | 4267 |  0.0561896  |     0.0112271 |   0.501289 | CE->PE |
| 57500CE  | 57000PE  |     5 | 4265 |  0.0795269  |     0.015647  |   0.502696 | CE->PE |
| 57500CE  | 56500CE  |     1 | 3540 |  0.00555806 |    -0.0370754 |   0.49096  | CE->CE |
| 57500CE  | 56500CE  |     2 | 3539 | -0.0238334  |    -0.0730337 |   0.486013 | CE->CE |
| 57500CE  | 56500CE  |     3 | 3538 | -0.0339017  |    -0.0866245 |   0.483324 | CE->CE |

## State leaderboard
| state_id                |   n |   mean_fwd5 |   median_fwd5 |   days |
|:------------------------|----:|------------:|--------------:|-------:|
| vlow/high/vhigh/ce_lead | 120 |    1.96708  |     1.30951   |     13 |
| vlow/high/high/ce_lead  |  83 |    1.46667  |     1.22097   |     12 |
| low/high/high/ce_weak   |  67 |    1.37685  |     0.763954  |     16 |
| high/vlow/mid/ce_lead   | 106 |    1.2989   |     0.478198  |     16 |
| vhigh/mid/low/neutral   | 103 |    1.26725  |     0.617716  |     17 |
| vlow/mid/vlow/neutral   |  80 |    1.18577  |     0.903841  |     20 |
| low/mid/mid/ce_weak     | 177 |    1.16809  |     0.430194  |     21 |
| low/high/low/ce_weak    |  79 |    1.11778  |     0.0812274 |     15 |
| vlow/high/high/pe_lead  | 106 |    1.10491  |     1.19627   |     14 |
| high/vlow/low/ce_lead   |  58 |    1.09358  |     0.900031  |     13 |
| low/mid/vhigh/ce_weak   |  72 |    1.05593  |     0.837749  |     20 |
| low/mid/vhigh/pe_weak   |  53 |    1.0297   |     0.222863  |     20 |
| low/high/mid/ce_weak    | 108 |    1.02041  |     0.0900807 |     19 |
| vlow/low/high/neutral   | 449 |    0.946182 |     0.482733  |     21 |
| high/vlow/high/neutral  |  61 |    0.918705 |    -0.349127  |     13 |

## Sequence leaderboard
| pattern                                   |   length |    n |   mean_fwd5 |   median_fwd5 |
|:------------------------------------------|---------:|-----:|------------:|--------------:|
| strong_up|strong_up|strong_up             |        3 | 1874 |    0.798854 |     0.0921784 |
| weak_down|weak_up|strong_down             |        3 | 1999 |    0.433257 |     0.209524  |
| strong_up|strong_up|flat                  |        3 |  943 |    0.416886 |     0.0981354 |
| strong_up|strong_up|weak_up               |        3 | 1386 |    0.370429 |     0.0645348 |
| weak_down|strong_up|strong_up             |        3 | 1575 |    0.357004 |    -0.0427679 |
| weak_up|strong_up|weak_up                 |        3 | 1730 |    0.286125 |     0         |
| weak_down|strong_up|weak_up               |        3 | 1984 |    0.259979 |     0         |
| strong_down|weak_up|strong_down           |        3 | 1755 |    0.250148 |     0.147153  |
| strong_down|strong_down|strong_up         |        3 | 2621 |    0.2458   |     0.261097  |
| strong_down|weak_up|weak_down             |        3 | 2056 |    0.245391 |     0.0559773 |
| strong_up|strong_up|strong_up|strong_up   |        4 |  439 |    1.18034  |     0.472016  |
| weak_down|weak_down|strong_up|strong_up   |        4 |  350 |    1.09472  |     0.238661  |
| weak_down|strong_up|strong_up|weak_up     |        4 |  268 |    1.06337  |     0.671142  |
| flat|strong_up|strong_up|flat             |        4 |  121 |    1.05073  |     0.208768  |
| strong_down|strong_up|strong_up|strong_up |        4 |  528 |    1.01296  |     0.147031  |

> Research-only. RESEARCH_PRICE_MODEL (close-to-close). No bid/ask claimed. Not a profitable strategy.

## First-run answers (§37, no P&L optimization)
1. Timestamp frequency? median=0 days 00:01:00, mode=0 days 00:01:00, is_1m=True, max_gap=3 days 17:46:00, missing=0.
2. Trading days? 21 (2026-08-20 09:15:00..2026-09-18 15:39:00), session 09:15:00..15:39:00.
3. Contracts? 42 (55500CE, 55500PE, 55600CE, 55600PE, 55700CE, 55700PE, 55800CE, 55800PE...), expiries=['29SEP2026']. Spec wide-format 54700/54800/54900 NOT present; adapter used focus ['57500', '57000', '56500'].
4. Recurring price-path patterns? 30 seq patterns >=min-occ; top mean_fwd5=3.02% but train/OOS unstable, perm_adj=1.0.
5. Volume events? ev_volume_shock/confirmation/divergence tested; no perm-significant survivor (see candidates).
6. CE/PE divergences forward info? ce_lead/pe_lead/simul all perm_adj~1.0, no robust effect.
7. Cross-strike info? ev_xstrike_div included; pairwise retdiff/accdiff/volratio computed for focus ['57500', '57000', '56500']; no perm-significant candidate.
8. Lead/lag evidence? 120 pair-lag tests; |mean_fwd5|~0.02-0.09%, negligible vs option noise; no OOS-stable leader.
9. Unusual states? 20 states >=min-occ; top OOS inflated vs train~0, fails consistency + permutation.
10. Chronological pseudo-OOS survival? train~0% vs OOS 3-9% magnitude gap = instability; 0 candidates with train/OOS sign+magnitude agreement and perm_adj<0.1.
11. Best-event/day removal? top3 concentration often >0.5; rm_best3 frequently flips sign or collapses (see candidates.csv).
12. Multiple-testing survival? BH-adjusted perm p=1.0 for all top; 0 survivors. Verdict: NO_ROBUST_DISCOVERY — do not force strategy (§38).