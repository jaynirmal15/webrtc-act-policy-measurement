# Mid-session onset — pre-registration addendum

Status. Addendum to pilot-prereg.json and replication-prereg-addendum.md. Written and committed before any registered run.

Prior prediction. The predicted behaviour was stated in the manuscript submitted to IEEE Access as Access-2026-56921 on 2026-11-02. Section VI states: "Under a mid-session onset the same code behaves differently: a positive jump is withheld by the outlier gate until a reset requiring at least 2 SRs spanning at least 10 s, while a negative jump is adopted at 0.9 per SR." The same prediction appears in Section III-B, D4 and Section VII. It was derived from owd_estimator.go:129-149 and :150-158 before any mid-session data existed.

Sign mapping, from source. OWD is receiver − sender (owd_estimator.go:119); the interceptor subtracts a positive SkewMs from the SR NTP field. An NTP shift of −80 ms raises the OWD sample (positive jump → gate); +80 ms lowers it (negative jump → fall factor 0.9).

Exploratory runs disclosed. Six calibration runs on 2026-11-05 (explore-2026-11-05-onset/, rewrite only, Δ=0, three per sign) established the onset time and the thresholds below. They are exploratory and are not reported as results. They exist in the experiment environment and will be deposited together with the registered batch.

Design. 2 signs (NTP −80, +80) × 2 policies (rewrite, verbatim) × 5 runs = 20 runs. Δ=0 only: Δ is injected capture-to-send latency, orthogonal to SR timing, and the constant-offset cells showed no Δ dependence. Onset T = 20 s after the publisher's first frame, fixed. Window C0_SAMPLE_MS=42000, ~45 s publish.

Definitions. Pre-onset median: median bias over observations before the first modified SR. Convergence time: the first observation after onset at which |bias| ≥ 40 ms, measured from the first modified SR.

Decision rules, fixed in advance.

1. Gating (NTP −80, rewrite) fires if the median bias over [onset, onset+8 s] is within 5 ms of the pre-onset median, and the median over [onset+15 s, end] is beyond −40 ms.
2. Fast adoption (NTP +80, rewrite) fires if the median bias over [onset+3 s, onset+8 s] is beyond +40 ms.
3. Asymmetry fires if median convergence time differs between signs by a factor ≥ 5.
4. Control holds if verbatim median bias stays within 2 ms of its pre-onset median throughout, at both signs.

Thresholds were set from the calibration runs and are not retuned. Exclusions follow pilot-prereg.json unchanged.

Clarification, before any registered run. pilot-prereg.json defines stop_conditions and an apparatus_failure outcome rather than an exclusions key. The sentence above means that this addendum introduces no new exclusion or stop rules, and that apparatus failures are reported rather than silently dropped, as in replication-prereg-addendum.md.
