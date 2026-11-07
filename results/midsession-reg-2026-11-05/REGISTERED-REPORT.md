# Registered mid-session batch — report

**Prereg (public, registered):** [`midsession-prereg-addendum.md`](https://github.com/jaynirmal15/webrtc-act-policy-measurement/blob/b814592873b2c8b87f592364c23dda7f027336bb/midsession-prereg-addendum.md) @ [`b814592873b2c8b87f592364c23dda7f027336bb`](https://github.com/jaynirmal15/webrtc-act-policy-measurement/commit/b814592873b2c8b87f592364c23dda7f027336bb)  
**Local workspace note:** an earlier local-only copy of the addendum existed as commit `7cdb4f9` in the experiment environment; Design / Definitions / Decision rules 1–4 match the public file (Design differs only by a Unicode vs ASCII apostrophe in “publisher's”; public adds a Clarification paragraph after Thresholds). All rule evaluations used the registered rule text.  
**Results dir:** `results/midsession-reg-2026-11-05/`  
**America/New_York wall:** 2026-11-05 23:25–23:49  
**Dates:** directory names use US Eastern dates; timestamps in this report are UTC except where marked America/New_York or given with an explicit offset. The `explore-2026-11-05-onset` runs are 03:06–03:12Z on 2026-11-06.  
**Attempts / retained / apparatus failures:** **20 / 20 / 0**

## Registration margin

| event | UTC |
|---|---|
| Addendum **push** to GitHub (Jay-supplied) | **2026-11-06T04:22:25Z** |
| Addendum git author/committer date (GitHub API for `b814592`) | 2026-11-06T04:22:22Z (commit date ≠ push time) |
| Earliest registered-run **started_local** (`config-snapshot.json`) | 2026-11-05T23:25:47-05:00 = 2026-11-06T04:25:47Z (`ntp-m80/rewrite/d0/run-1`) |
| Earliest LiveKit server log line (same run) | 2026-11-06T04:25:48.849Z |
| Earliest **first_frame_unix_ms** (`inject.meta.json`, ms precision) | **1793939149387** = **2026-11-06T04:25:49.387Z** (`ntp-m80/rewrite/d0/run-1`) |

**Margin (first_frame − push):** **204.387 s** (3.41 min).  
No registered-run activity precedes the push time (batch script start, SFU start, and first frame are all after 2026-11-06T04:22:25Z).

## Apparatus

- C3 pairing from `rep-run-one.sh`: rewrite → `livekit-server-dsrpt` (`6d5fa7ae…`); verbatim → `livekit-server-verbatim-dsrpt` (`628ddfe1…`).
- Publisher: onset build from `c56e98e`; `-sr-ntp-skew-onset-ms=20000`; Δ=0; duration 45 s; `C0_SAMPLE_MS=42000`.
- Chromium 151.0.7922.34.
- Sign inversion: NTP −80 → CLI SkewMs **+80**; NTP +80 → CLI SkewMs **−80**.

## Data-based sign verification (rewrite) — OK, not inverted

| arm | expected | observed |
|---|---|---|
| ntp-m80 (flag +80) | gate ~10 s then step to −81 | [0,8) med=−1; move at 10–11 s; [15,end]=**−81** (all 5) |
| ntp-p80 (flag −80) | adopt in 1–2 s to +79 | move at 0 s; [3,8)=**79** (all 5) |

## Decision rules (rtp-match-v1; onset = first modified SR)

**Pooling:** for rules 1–2, the rule evaluation uses the **median of all rtp-matched observations pooled across the 5 runs** in the named window; per-run medians are shown alongside. Rule 3 uses the **median of the 5 per-run convergence times** per sign (same as calibration check).

| rule | result | numbers |
|---|---|---|
| **1 Gating** (NTP −80, rewrite) | **FIRES** | pooled pre=−1 (n=1508); [0,8)=−1 (\|Δ\|=0, n=1002); [15,end]=**−81** (n=952) |
| **2 Fast adoption** (NTP +80, rewrite) | **FIRES** | pooled [3,8)=**79** (n=628) |
| **3 Asymmetry** | **FIRES** | med conv NTP−80 = **11054 ms**; NTP+80 = **51 ms**; ratio **216.75 ≥ 5** |
| **4 Control** (verbatim both signs) | **HOLDS** under both interpretations below | max \|Δ\| ≤ 1 ms |

### Rule 4 ambiguity (flagged for Jay; not resolved silently)

Addendum: “verbatim median bias stays within 2 ms of its pre-onset median **throughout**.”  
- **A:** \|med[onset, end] − pre_med\| ≤ 2 per run and pooled → **HOLDS** (max \|Δ\|=1).  
- **B:** max \|window_med − pre_med\| over the rule-1/2 windows {[0,8),[3,8),[15,end]} ≤ 2 → **HOLDS** (max \|Δ\|=1).  
Primary report uses A; B agrees. “Throughout” is still under-specified (e.g. 1 s bins were not invented).

## Per-run table (rtp-match)

| cell | pol | run | flag | NTP | onset_lag_ms | pre | [0,8) | [3,8) | [15,end] | conv_ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ntp-m80 | rewrite | 1 | +80 | −80 | 20958 | −1 | −1 | −1 | −81 | 10081 |
| ntp-m80 | rewrite | 2 | +80 | −80 | 20961 | −1 | −1 | −1 | −81 | 11068 |
| ntp-m80 | rewrite | 3 | +80 | −80 | 20956 | −1 | −1 | −1 | −81 | 10071 |
| ntp-m80 | rewrite | 4 | +80 | −80 | 20961 | −1 | −1 | −1 | −81 | 11054 |
| ntp-m80 | rewrite | 5 | +80 | −80 | 20959 | −1 | −1 | −1 | −81 | 11080 |
| ntp-m80 | verbatim | 1 | +80 | −80 | 20961 | 0 | 0 | 0 | 0 | — |
| ntp-m80 | verbatim | 2 | +80 | −80 | 20963 | 0 | −0.5 | 0 | −1 | — |
| ntp-m80 | verbatim | 3 | +80 | −80 | 20961 | 0 | 0 | −0.5 | 0 | — |
| ntp-m80 | verbatim | 4 | +80 | −80 | 20959 | −1 | −1 | −1 | −1 | — |
| ntp-m80 | verbatim | 5 | +80 | −80 | 20961 | −1 | 0 | −1 | −1 | — |
| ntp-p80 | rewrite | 1 | −80 | +80 | 20954 | −1 | 79 | 79 | 79 | 57 |
| ntp-p80 | rewrite | 2 | −80 | +80 | 20960 | −1 | 79 | 79 | 79 | 52 |
| ntp-p80 | rewrite | 3 | −80 | +80 | 20959 | −1 | 79 | 79 | 79 | 47 |
| ntp-p80 | rewrite | 4 | −80 | +80 | 20961 | −1 | 79 | 79 | 79 | 39 |
| ntp-p80 | rewrite | 5 | −80 | +80 | 20956 | −1 | 79 | 79 | 79 | 51 |
| ntp-p80 | verbatim | 1 | −80 | +80 | 20959 | 0 | 0 | 0 | −1 | — |
| ntp-p80 | verbatim | 2 | −80 | +80 | 20963 | −1 | 0 | 0 | −1 | — |
| ntp-p80 | verbatim | 3 | −80 | +80 | 20960 | 0 | 0 | −0.5 | −1 | — |
| ntp-p80 | verbatim | 4 | −80 | +80 | 20956 | 0 | 0 | 0 | 0 | — |
| ntp-p80 | verbatim | 5 | −80 | +80 | 20960 | −1 | 0 | 0 | 0 | — |

Onset: all runs SR index **21**, lag **20.954–20.963 s**. Machine-readable: `analysis/midsession-reg-2026-11-05/REGISTERED-ANALYSIS.json`. Per-run raw API samples remain in each `result.json` / `inject.jsonl` (rtp-match keys).

## Summary

All four preregistered decision rules fire/hold. Sign assignment verified from data. No apparatus failures. Addendum and manuscript untouched. No zip.
