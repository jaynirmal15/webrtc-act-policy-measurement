# M1 replication pre-registration addendum

**Written and committed:** 2026-10-15 10:16 EDT — BEFORE any replication run.
**Parent prereg (FROZEN, unchanged):** `pilot-prereg.json` — ε = 40 ms, τ_b = 10 ms,
OR = (|bias_rewrite| > τ_b) OR (|sync_err_verbatim| > ε). No thresholds are retuned here.

## (a) Why this exists
The original raw results directory `m1-harness/out/` (all C0–C3 trial JSON, inject logs, cell memos)
was lost when the harness was restored on 2026-10-08 without its results. Surviving numbers are summaries
only (n = 1 run per condition, first 300 bias samples retained). This is a **replication of EXISTING cells
(C0, C2, C3)**, not new cells. Its purpose is dispersion and provenance.

## (b) Design
- Cells: **C0** (loopback, DSRPT=false; stock binary vs #4812-verbatim binary), **C2** (15 s first-SR hold,
  DSRPT=false; rewrite vs verbatim — verbatim arm is the historical "C4"), **C3** (DSRPT=true, publisher SR-NTP
  estimate perturbation; rewrite vs verbatim).
- C3 perturbations: **−80 ms** (the original C3: SR NTP shifted earlier by 80 ms) and **+80 ms** (the same C3
  at the opposite sign). The +80 ms point is not a new cell; Claude explicitly revised the change-3 ruling
  because the re-run makes it near-free. Implementation: minimal interceptor change — `-sr-ntp-skew-ms N`
  subtracts N ms; N < 0 now adds |N|. Perturbation = −N (so −80 ms ⇔ N=80, +80 ms ⇔ N=−80).
  Naming: this perturbs the SFU's clock **estimate**, not the network path (no CAP_NET_ADMIN).
- Δ_inject ∈ {0, 50} ms. `C0_ACT_FORCE_EXT_ID=8` for both arms (identical apparatus workaround).
- **≥ 5 independent runs per condition**; each run = fresh LiveKit SFU process + fresh Pion publisher + fresh
  Playwright subscriber, unique room name.
- Every sample saved: `biases_ms.slice(0,300)` cap removed in src/*.mjs; full paired rows and raw subscriber
  samples written per run.
- Output: `results/rep-2026-10-15/<cell>/<policy>/<delta>/run-<k>/` (raw JSON, inject jsonl, logs, config
  snapshot, git SHA). Never overwritten. Commit after each cell.

## (c) Decision rule (fixed before seeing data)
Statistic per run: median of that run's per-frame bias b = L̂ − L*. Per condition: **pooled median** = median
of all per-frame biases across runs; **95% bootstrap CI** = percentile CI of the median of per-run medians
(10 000 resamples of runs with replacement, fixed seed 20261015).

The **bias arm FIRES** only if, for the C3 rewrite condition at the **−80 ms** perturbation (the original
firing condition), at **each** Δ ∈ {0, 50}: |pooled median bias| > 10 ms **AND** the 95% bootstrap CI of
|bias| lies entirely above 10 ms (i.e. CI entirely > 10 or entirely < −10).
If the CI straddles ±10 (or the pooled median is ≤ 10) at either Δ, the bias arm **does NOT fire**, and the
paper falls back to the **C2 CT-availability differential** (time to first captureTimestamp / fraction null,
rewrite vs verbatim) as primary — weaker but real. The sync arm remains N/A (video-only cells).
Runs that fail as apparatus (no captureTimestamp, no pairs) are reported, not silently dropped; they do not
count toward the ≥ 5, and failed runs may be repeated to reach 5 valid runs.

## (d) Direction claim
Supported only if the C3 rewrite pooled median bias has **opposite signs** at −80 vs +80 ms (with both
bootstrap CIs excluding 0), at each Δ, **and** the verbatim |pooled median| stays ≤ 2 ms at both perturbations.
Otherwise the outline states the single-sign observation only.

## Provenance note (appended 2026-10-15 ~11:20 EDT; text above unchanged)
- The box was wiped ~11:05 EDT mid-batch. Repo restored from Jay's zip snapshot (10:26 EDT); original git
  history lost; first commit of the new repo records this.
- All binaries rebuilt from source at 11:15 EDT (go toolchain auto, go 1.26) from the local livekit-src
  branches: `pin-v1.13.7` (8d11efdf, stock), `verbatim-on-pin` (19cb9888 = #4812 flag cherry-pick),
  `dsrpt-wiring-on-pin`, `verbatim-dsrpt-on-pin`; Pion publisher with signed `-sr-ntp-skew-ms`.
- Pre-wipe runs (built from different binaries) moved to `results/rep-2026-10-15/_prewipe/`, NOT pooled.
- Restart writes to `results/rep-2026-10-15b/` (only output-path change; design and decision rule unchanged).
  Order: C3 −80, C3 +80, C2, C0. Strictly sequential under flock. Backup (commit + zip + Mac copy) after each cell.
