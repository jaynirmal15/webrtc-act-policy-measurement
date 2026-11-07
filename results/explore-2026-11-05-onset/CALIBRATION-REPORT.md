# EXPLORATORY — time-gated onset calibration (2026-11-05 America/New_York)

**Not a preregistered batch. Not for manuscript insertion as-is.**

## 1. Sign mapping (from source, before code)

See `SIGN-MAPPING.md`. Summary tied to SkewMs:

| SkewMs | OWD sample | Estimator path |
|---:|---|---|
| **+80** (m80) | ↑ ~80 ms (positive jump) | Outlier gate (`owd_estimator.go:129–146`); reset after ≥2 SRs spanning ≥10 s |
| **−80** (p80) | ↓ ~80 ms (negative jump) | EMA FallFactor **0.9** (`:150–157`) |

Quotes and line cites are in the memo. SFU uses the identical `mediatransportutil` copy; rewrite offset = AtAdjusted−Ntp.

## 2. Onset feature

- Flag: `-sr-ntp-skew-onset-ms` (default **0** = constant-offset from first SR — published mode unchanged).
- When >0: SRs unmodified until `first_RTP_frame + T`, then skew from next SR.
- Shared `FirstFrameUnixMs` from ACT interceptor → SR skew factory.
- Meta / logs: `first_frame_unix_ms`, `sr_ntp_first_skew_unix_ms`, `sr_ntp_onset_sr_index`, unmodified/skewed counts.

## 3. Onset landing (all 6 runs)

| run | skew | first_frame → first_modified lag | SR index | unmodified / skewed |
|---|---:|---:|---:|---|
| m80/1–3 | +80 | **20958–20962 ms** | **21** | 20 / 23–24 |
| p80/1–3 | −80 | **20893–20960 ms** | **21** | 20 / 23 |

T=20000 ms; first modified SR is the first SR with wall time ≥ first_frame+T (~0.96 s after the gate opens at the ~1 Hz SR cadence). Onset landed where claimed.

## 4. Window changes

See `WINDOW-CHANGES.md`. Deposit defaults untouched. Exploratory only: `C0_SAMPLE_MS=42000`, `-sr-ntp-skew-onset-ms=20000`, rewrite/Δ=0.

## 5. Bias vs time (rtp-timestamp match, same corrected matcher)

Medians of uniquely RTP-matched video observations, relative to first frame:

### +80 / m80 (positive OWD jump — expect gate, then reset)

| run | before | 0–2 s after | 2–10 s | ≥10 s after | first \|Δ\|>40 |
|---|---:|---:|---:|---:|---|
| 1 | −1 | −1 | −1 | **−81** | **31 s** (~10 s post-onset) |
| 2 | −1 | −1 | −1 | **−81** | **31 s** |
| 3 | −1 | −1 | −1 | **−81** | **32 s** |

Estimator **does not move** for ~10 s after onset (bias stays −1). Then snaps to **−81** — the deposit rewrite constant-skew level. Reset fired inside the window. SFU `"propagation delay step change"` is `Debugw` and did not appear at default log level; the bias step is the observable.

### −80 / p80 (negative OWD jump — expect 0.9 adopt)

| run | before | 0–2 s after | 2–10 s | ≥10 s after | first \|Δ\|>40 |
|---|---:|---:|---:|---:|---|
| 1 | −1 | **75** | **79** | **79** | **21 s** (onset second) |
| 2 | −1 | **75** | **79** | **79** | **21 s** |
| 3 | −1 | **75** | **79** | **79** | **21 s** |

Estimator moves **immediately** at onset: ~71→79 within ~1–2 s (0.9/SR toward +80 bias under rewrite). No gate. No reset needed.

Full per-second sparklines: `CALIBRATION-ANALYSIS.json`.

## 6. Go / no-go

**GO for mid-session onset behaving as predicted from the estimator source.**

- Positive jump (+80 SkewMs): withheld ~10 s, then reset to −81 bias.
- Negative jump (−80 SkewMs): adopted within 1–2 SRs to ~+79 bias.
- Onset timing verified by logs (not assumed).
- Constant-offset mode: onset flag default 0; apply path unchanged when onset_ms=0 (not re-run this step; prior repro-2026-11-05 remains the constant-mode GO).

## 7. Not done (per brief)

No verbatim, no Δ=50, no prereg, no manuscript edits, no registered batch.
