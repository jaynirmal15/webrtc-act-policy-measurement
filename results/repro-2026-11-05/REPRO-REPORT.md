# C3 −80 ms Δ=0 reproduction — 2026-11-05 (America/New_York)

## Toolchain restore
- Go 1.24.4: `/home/box/go-1.24.4/bin/go` (`go1.24.4` via `/home/box/bin`). System `/usr/local/go` remains go1.27.3. Existing SFU binaries not rebuilt.
- `npm ci` → playwright **1.62.1**. Chromium: `/home/box/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` → **Google Chrome for Testing 151.0.7922.34**. Harness `chromium.launch()` (no `channel`) resolves this path; system Chrome 156 and npx 1.65.0 cache unused.
- Cleanup: deleted empty `m1-harness/out/c1-inject.jsonl`.

## Clock stability (300 samples @ 1 s)
- Largest consecutive gap above 1 s: realtime **14.309 ms**, monotonic **14.311 ms** (both clocks move together → scheduling jitter, not a step).
- realtime−monotonic drift over window: **0.005 ms** (range 0.046 ms).
- Flagged >10 ms consecutive gaps per instruction; no evidence of a clock step.

## Binaries (unchanged)
- livekit-server{,-verbatim,-dsrpt,-verbatim-dsrpt} all report `livekit-server version 1.13.7`.
- C3 uses dsrpt / verbatim-dsrpt (sha256 `6d5fa7ae…` / `628ddfe1…` as deposited).
- `c3-pion-publisher` starts and prints usage.

## Runs
- Output: `results/repro-2026-11-05/c3-m80/{rewrite,verbatim}/d0/run-{1..5}/`
- 10/10 valid (captureTimestamp seen, paired_n>0). No failures moved to `_failed/`.
- Raw (superseded ACT-nearest) medians: rewrite ≈ −15/−14; verbatim 0/−1 (matches October raw summary shape).

## rtp-match-v1 rematch vs deposit
| condition | per-run medians | pooled | deposit target |
|---|---|---|---|
| c3-m80/rewrite/d0 | [−81, −81, −81, −81, −81] | **−81.0** | −81 → **MATCH** |
| c3-m80/verbatim/d0 | [0, −1, −1, −1, −1] | **−1.0** | within 1 ms → **MATCH** |

Analysis dir: `analysis/rtp-match-v1-repro-2026-11-05/` (matcher algorithm identical; decision block patched only to tolerate Δ=0-only input).

## Go / no-go
**GO for environment fidelity on this cell.** Chromium pin exact; rematch numbers reproduce the published C3 −80 Δ=0 rewrite −81 / verbatim ~0 pattern.
