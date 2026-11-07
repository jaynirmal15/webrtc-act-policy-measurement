# rtp-match-v1 corrected results (post-review correction; existing data)

τ_b=10 ms, bootstrap 10000 resamples seed 20261015 (unchanged).

| condition | runs | n (per run) | per-run medians | pooled med | IQR | p5–p95 | min/max | 95% CI | superseded pooled / CI |
|---|---|---|---|---|---|---|---|---|---|
| c3-m80/rewrite/d0 | 5 | [217, 214, 216, 217, 212] | [-81.0, -81.0, -81.0, -81.0, -81.0] | -81.0 | [-81.0, -80.0] | [-81.0, -80.0] | [-81.0, -80.0] | [-81.0, -81.0] | -15.0 / [-15.0, -14.0] |
| c3-m80/verbatim/d0 | 5 | [227, 229, 229, 227, 227] | [0.0, -1.0, -1.0, -1.0, -1.0] | -1.0 | [-1.0, 0.0] | [-1.0, 0.0] | [-1.0, 0.0] | [-1.0, 0.0] | -1.0 / [-1.0, 0.0] |

## Per-run accounting

| run | eligible | unique | unmatched | ambiguous | distinct frames | repeated obs | old reproduces stored | shift(rtp−old idx) | med old | med new | latency rtp/old |
|---|---|---|---|---|---|---|---|---|---|---|---|
| c3-m80/rewrite/d0/run-1 | 217 | 217 | 0 | 0 | 131 | 86 | True | {-1: 217} | -15.0 | -81.0 | 22.0/-44.0 |
| c3-m80/rewrite/d0/run-2 | 214 | 214 | 0 | 0 | 129 | 85 | True | {-1: 214} | -15.0 | -81.0 | 22.0/-44.0 |
| c3-m80/rewrite/d0/run-3 | 216 | 216 | 0 | 0 | 130 | 86 | True | {-1: 216} | -15.0 | -81.0 | 22.5/-43.0 |
| c3-m80/rewrite/d0/run-4 | 217 | 217 | 0 | 0 | 131 | 86 | True | {-1: 217} | -15.0 | -81.0 | 21.0/-45.0 |
| c3-m80/rewrite/d0/run-5 | 212 | 212 | 0 | 0 | 128 | 84 | True | {-1: 212} | -14.0 | -81.0 | 22.0/-44.0 |
| c3-m80/verbatim/d0/run-1 | 227 | 227 | 0 | 0 | 137 | 90 | True | {0: 227} | 0.0 | 0.0 | 22.0/22.0 |
| c3-m80/verbatim/d0/run-2 | 229 | 229 | 0 | 0 | 138 | 91 | True | {0: 229} | -1.0 | -1.0 | 22.0/22.0 |
| c3-m80/verbatim/d0/run-3 | 229 | 229 | 0 | 0 | 138 | 91 | True | {0: 229} | -1.0 | -1.0 | 22.0/22.0 |
| c3-m80/verbatim/d0/run-4 | 227 | 227 | 0 | 0 | 137 | 90 | True | {0: 227} | -1.0 | -1.0 | 22.0/22.0 |
| c3-m80/verbatim/d0/run-5 | 227 | 227 | 0 | 0 | 137 | 90 | True | {0: 227} | -1.0 | -1.0 | 23.0/23.0 |

Decision (unchanged rule): per-Δ fires {'d0': True} → bias arm fires = True

Direction: {"d0": {"rewrite_m80": -81.0, "rewrite_p80": null, "opposite_signs": null, "cis_exclude_0": true, "note": "p80 not in this input set", "verbatim_abs_le_2": true, "supported": null}}

Conversion branches: {'c3-m80|rewrite|A:ct>wall+Y -> ct-NTP': 1076, 'c3-m80|verbatim|A:ct>wall+Y -> ct-NTP': 1139}