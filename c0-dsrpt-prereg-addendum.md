# M1 C0-DSRPT pre-registration addendum

**Written and committed:** 2026-10-15 23:09 EDT — BEFORE any C0-DSRPT replication run.
**Parent prereg (FROZEN, unchanged):** `pilot-prereg.json` — ε = 40 ms, τ_b = 10 ms,
OR = (|bias_rewrite| > τ_b) OR (|sync_err_verbatim| > ε). No thresholds are retuned here.
**Prior replication addendum (unchanged):** `replication-prereg-addendum.md` — C0/C2/C3 design and
decision rule remain as written. This document adds one new arm only.

## (a) Why this exists

The replicated C0 arm in `results/rep-2026-10-15b/c0/` uses **DSRPT=false**
(`disable_sender_report_pass_through` unset / false). Under that configuration the rewrite
offset is forced to zero by construction. The C3 arm uses **DSRPT=true**. Those two arms
therefore differ in two variables (DSRPT setting and SR-NTP estimate perturbation). This
addendum registers a **C0-DSRPT** arm that holds DSRPT=true with **zero** SR-NTP estimate
perturbation, so C0 and C3 can be compared on a single differing factor.

## (b) Design — cells to run

- **Cell:** C0-DSRPT (loopback; same inject/playout apparatus as C0).
- **DSRPT:** `rtc.disable_sender_report_pass_through: true` on both policies.
- **Policies (2):**
  - **rewrite** — binary `livekit-server-dsrpt`, config `livekit-dsrpt.yaml`
    (DSRPT=true; no verbatim flag).
  - **verbatim** — binary `livekit-server-verbatim-dsrpt`, config `livekit-verbatim-dsrpt.yaml`
    (DSRPT=true + `forward_abs_capture_time_verbatim: true`).
- **Δ_inject ∈ {0, 50} ms.** `C0_ACT_FORCE_EXT_ID=8` for both arms (identical apparatus workaround).
- **SR-NTP estimate perturbation:** **0 ms** (`-sr-ntp-skew-ms 0`). No hold (`sr_hold_ms=0`).
- **Runs:** **5 independent runs** per (policy × Δ) → **5 × 2 × 2 = 20 runs**.
  Each run = fresh LiveKit SFU process + fresh Pion publisher + fresh Playwright subscriber,
  unique room name.
- **Output:** `results/rep-2026-10-15-c0-dsrpt/c0-dsrpt/<policy>/d<delta>/run-<k>/`
  (raw JSON, inject jsonl, logs, config snapshot, git SHA). Never overwritten.
- **Go invocations:** any `go test` used while preparing this arm uses `-count=1` (no cache).
  Cell execution itself runs prebuilt binaries (same practice as `rep-2026-10-15b`).
- **Order:** fixed sequential under flock — rewrite/d0 → rewrite/d50 → verbatim/d0 → verbatim/d50,
  runs 1..5 within each condition. **Not randomized** (see note below).

## (c) Frozen decision rules (unchanged)

- τ_b = **10 ms**, ε = **40 ms** (from `pilot-prereg.json`).
- Bias-arm firing rule and direction claim remain those in `replication-prereg-addendum.md`
  and apply to **C3**, not to this arm.
- This arm is a **confound control**. It does not retune τ_b or ε, does not change exclusions,
  and does not alter the C3 decision rule after seeing data.
- Runs that fail as apparatus (no captureTimestamp, no pairs) are reported, not silently
  dropped; they do not count toward the ≥ 5; failed runs may be repeated to reach 5 valid runs.

## (d) Matching procedure (specified before runs)

- **Primary matcher for NEW C0-DSRPT cells:** exact **run-scoped RTP timestamp** pairing
  (same procedure as `analysis/rtp-match-v1/`: match subscriber frames to publisher inject
  records by RTP timestamp within the run; count ambiguity rather than silently resolving
  by nearest wall-clock / ACT).
- **Existing C0/C2/C3 cells** in `rep-2026-10-15b`: `analysis/rtp-match-v1` remains a
  **post-review analysis correction** applied to existing data (not part of the 2026-10-15
  replication pre-registration). This addendum does not re-register that correction as
  pre-registered for those cells.
- Nearest-ACT / nearest-timestamp matching is **not** the primary procedure for these new runs.
- Do not write “RTP+SSRC” as the key; the key is the exact RTP timestamp scoped to a run.

## (e) Expected direction (stated before runs)

Under DSRPT=true and **zero** SR-NTP estimate perturbation, both rewrite and verbatim are
expected to show **|pooled median bias| ≤ τ_b (10 ms)** at each Δ ∈ {0, 50}, with verbatim
|pooled median| also near zero (same class as existing C0). This arm is **not** expected to
fire the bias arm by itself. Its purpose is to show whether DSRPT=true alone (without the
C3 clock-estimate perturbation) produces rewrite bias; if rewrite stays within τ_b here,
C3 rewrite bias is attributable to the perturbation rather than to the DSRPT confound.

No general 1:1 response law is claimed from this arm. No attenuation interpretation is
registered here.

## (f) Randomized run order — status of EXISTING pre-registration

**NO.** Neither `pilot-prereg.json` nor `replication-prereg-addendum.md` specifies randomized
run order. The replication addendum states a fixed sequential order (C3 −80, C3 +80, C2, C0).
This addendum likewise uses fixed sequential order and does **not** retrofit randomization
onto prior prereg documents.

## Provenance

- LiveKit pin: v1.13.7 (`8d11efdf`); DSRPT binaries from local branches
  `dsrpt-wiring-on-pin` / `verbatim-dsrpt-on-pin` (same rebuild provenance as rep-2026-10-15b).
- Publisher: `m1-harness/bin/c3-pion-publisher` with `-sr-ntp-skew-ms 0`.
