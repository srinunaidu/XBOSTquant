# XBOST Option-Native Discovery — Final Report (RESEARCH_PRICE_MODEL)
run 20261002-102733-0d5bba | layout=long | contracts=42
LIMITATION: short-horizon option data is sufficient for discovery and structural research, but insufficient for strong long-horizon robustness claims.

## 1. DATASET STRUCTURE
layout=long
underlying=['UNKNOWN']
contracts=42 types=['CE', 'PE'] strikes=21 expiries=['29SEP2026']

## 2. DATA HEALTH
status=DATA_INVALID
rows=225927
timestamps=7895 days=21 2026-08-20 09:15:00..2026-09-18 15:39:00
missing=0 dup=0 volcov=0.9994

## 3. DISCOVERED CHAIN DIMENSIONS
{"n_contracts": 42, "n_strikes": 21, "n_option_types": 2, "n_expiries": 1, "synchronized_snapshots": 7895, "complete_snapshots": 153, "completeness": 0.0194}

## 4. AVAILABLE DISCOVERY MODULES
OPTION_DATA=AVAILABLE, CHAIN_STRUCTURE=AVAILABLE, RAW_PRICE=AVAILABLE, VOLUME=AVAILABLE, OPTION_TYPE_RELATIONSHIP=AVAILABLE, STRIKE_RELATIONSHIP=AVAILABLE, EXPIRY_RELATIONSHIP=UNAVAILABLE, LEAD_LAG=AVAILABLE, SEQUENCE=AVAILABLE, CHAIN_STATE=AVAILABLE, EXECUTABLE_MODEL=UNAVAILABLE, OOS_VALIDATION=AVAILABLE

## 5. SKIPPED/UNAVAILABLE MODULES
{"EXPIRY_RELATIONSHIP": "only 1 expir(ies)", "EXECUTABLE_MODEL": "no bid/ask fields; RESEARCH_PRICE_MODEL only"}

## 6. DISCOVERY SEARCH SPACE
{"total_features_tested": 36, "total_relationships_tested": 19, "total_sequences_tested": 167, "total_states_tested": 125, "total_candidate_events": 35}

## 7. EVENTS DISCOVERED
35 candidates across families: SEQUENCE=12, CHAIN_STATE=6, LEAD_LAG=6, RAW_OPTION_PRICE=2, OPTION_VOLUME=2, EVENT=2, OPTION_TYPE_RELATIONSHIP=2, CHAIN_BREADTH=2, CROSS_STRIKE_RELATIONSHIP=1

## 8. RELATIONSHIPS DISCOVERED
150 lead/lag pair-tests; type/strike/breadth columns in candidates.csv

## 9. FORWARD-RETURN RESULTS (DISCOVERY, label-based)
| candidate                    | discovery_family          |   FWD_expectancy |   FWD_OOS_expectancy |   perm_p | final_status       |
|:-----------------------------|:--------------------------|-----------------:|---------------------:|---------:|:-------------------|
| EV:e_large_ret               | RAW_OPTION_PRICE          |       0.248403   |           0.530225   | 0.293532 | SURROGATE_REJECTED |
| EV:e_expansion               | RAW_OPTION_PRICE          |       0.121147   |           0.10352    | 1        | SURROGATE_REJECTED |
| EV:e_vol_shock               | OPTION_VOLUME             |       0.0016219  |           0.0463503  | 0.422886 | REJECTED           |
| EV:ev_largeRet_volShock      | OPTION_VOLUME             |      -0.046595   |           0.247926   | 0.731343 | REJECTED           |
| EV:ev_compress_expand        | EVENT                     |       0.205902   |           0.136415   | 0.9801   | SURROGATE_REJECTED |
| EV:ev_ret_vol_expand         | EVENT                     |      -0.314483   |          -0.185854   | 0.159204 | OOS_REJECTED       |
| EV:e_atm_move                | CROSS_STRIKE_RELATIONSHIP |       0.0959616  |           0.265771   | 0.308458 | REJECTED           |
| EV:ev_CE_leads_PE            | OPTION_TYPE_RELATIONSHIP  |      -0.0206954  |           0.0259021  | 1        | REJECTED           |
| EV:ev_PE_leads_CE            | OPTION_TYPE_RELATIONSHIP  |       0.191043   |           0.0196365  | 0.706468 | SURROGATE_REJECTED |
| BREADTH:pos                  | CHAIN_BREADTH             |       0.0164424  |          -0.00132305 | 0.631841 | OOS_REJECTED       |
| BREADTH:neg                  | CHAIN_BREADTH             |      -0.00931047 |          -0.0134251  | 0.537313 | OOS_REJECTED       |
| SEQ:seq2=weak_up|weak_down   | SEQUENCE                  |       0.015689   |          -0.0267864  | 0.925373 | OOS_REJECTED       |
| SEQ:seq2=weak_down|weak_up   | SEQUENCE                  |      -0.132826   |          -0.358552   | 1        | OOS_REJECTED       |
| SEQ:seq2=weak_up|weak_up     | SEQUENCE                  |      -0.0317878  |           0.164013   | 0.268657 | REJECTED           |
| SEQ:seq2=weak_down|weak_down | SEQUENCE                  |       0.026479   |          -0.135472   | 0.905473 | OOS_REJECTED       |

## 10. TRADING CANDIDATES (path-exit, secondary)
| candidate               |   events |   IS_expectancy |   IS_TRADE_SHARPE | exit_cap_dominated   |
|:------------------------|---------:|----------------:|------------------:|:---------------------|
| EV:e_large_ret          |     1409 |      -0.0778193 |          -4.34004 | True                 |
| EV:e_expansion          |     2749 |      -0.0286579 |          -2.19154 | True                 |
| EV:e_vol_shock          |     2991 |      -0.0670472 |          -5.44907 | True                 |
| EV:ev_largeRet_volShock |      684 |      -0.133614  |          -5.41969 | True                 |
| EV:ev_compress_expand   |      538 |       0.0106023 |           0.35469 | True                 |
| EV:ev_ret_vol_expand    |      175 |      -0.105714  |          -2.11194 | True                 |
| EV:e_atm_move           |     2600 |      -0.0522694 |          -3.90013 | True                 |
| EV:ev_CE_leads_PE       |      554 |       0.0304925 |           1.00609 | True                 |
| EV:ev_PE_leads_CE       |     1032 |       0.0251115 |           1.14932 | True                 |
| BREADTH:pos             |    19784 |      -0.0147098 |          -2.98516 | True                 |

## 11. OOS RESULTS
OOS gate: THIN_OOS if oos_n<20; 21 positive-OOS-label candidates; 0 DISCOVERY-or-better

## 12. WALK-FORWARD RESULTS
| train                                                                                                                                                                                                                            | test                                                                                 |
|:---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:-------------------------------------------------------------------------------------|
| [datetime.date(2026, 8, 20), datetime.date(2026, 8, 21), datetime.date(2026, 8, 24), datetime.date(2026, 8, 25), datetime.date(2026, 8, 26), datetime.date(2026, 8, 27), datetime.date(2026, 8, 28), datetime.date(2026, 8, 31)] | [datetime.date(2026, 9, 1), datetime.date(2026, 9, 2), datetime.date(2026, 9, 3)]    |
| [datetime.date(2026, 8, 25), datetime.date(2026, 8, 26), datetime.date(2026, 8, 27), datetime.date(2026, 8, 28), datetime.date(2026, 8, 31), datetime.date(2026, 9, 1), datetime.date(2026, 9, 2), datetime.date(2026, 9, 3)]    | [datetime.date(2026, 9, 4), datetime.date(2026, 9, 7), datetime.date(2026, 9, 8)]    |
| [datetime.date(2026, 8, 28), datetime.date(2026, 8, 31), datetime.date(2026, 9, 1), datetime.date(2026, 9, 2), datetime.date(2026, 9, 3), datetime.date(2026, 9, 4), datetime.date(2026, 9, 7), datetime.date(2026, 9, 8)]       | [datetime.date(2026, 9, 9), datetime.date(2026, 9, 10), datetime.date(2026, 9, 11)]  |
| [datetime.date(2026, 9, 2), datetime.date(2026, 9, 3), datetime.date(2026, 9, 4), datetime.date(2026, 9, 7), datetime.date(2026, 9, 8), datetime.date(2026, 9, 9), datetime.date(2026, 9, 10), datetime.date(2026, 9, 11)]       | [datetime.date(2026, 9, 15), datetime.date(2026, 9, 16), datetime.date(2026, 9, 17)] |

## 13. ROBUSTNESS RESULTS
time/type/strike/perturb/best-removal/concentration in candidates.csv

## 14. MULTIPLE-TESTING RESULTS
BH-adjusted perm p; {"total_features_tested": 36, "total_relationships_tested": 19, "total_sequences_tested": 167, "total_states_tested": 125, "total_candidate_events": 35}

## 15. PAPER ELIGIBILITY
PAPER_ELIGIBLE = NO

## 16. RESULT STRATA
DISCOVERY RESULT: 35 candidates measured
VALIDATED RESULT: 0 surviving discovery gates
OOS RESULT: 21 positive-OOS-label
PAPER-ELIGIBLE RESULT: 0 (short-sample gate)

NO_LOOKAHEAD_TEST=PASS
METRIC_DEFINITION_AUDIT=PASS