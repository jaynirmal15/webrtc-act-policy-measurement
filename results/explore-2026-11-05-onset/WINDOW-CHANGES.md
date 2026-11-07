# Window changes for exploratory onset calibration

**EXPLORATORY.** Deposit scripts and published-cell defaults were **not** permanently changed.

## What already matched the brief

- Publisher `-duration` default in `main.go` is already **45s**.
- `rep-run-one.sh` already uses `DUR=45s` for C3.
- IVF `media/c0-video.ivf` is **120 s** long.

## What the calibration overrides (env / exploratory runner only)

| knob | deposit default (C3) | exploratory value | where |
|---|---|---|---|
| Publisher duration | 45s | **45s** (unchanged) | `-duration` |
| Subscriber sample window `C0_SAMPLE_MS` | **16000** (`rep-run-one.sh`) | **42000** | env to `c0-rewrite-sanity.mjs` |
| Node overall timeout | 180s | **180s** (unchanged; 42s sample fits) | `timeout` in runner |
| Onset | n/a (constant from first SR) | **T=20000 ms** after first RTP frame | `-sr-ntp-skew-onset-ms` |
| Policy / Δ | — | rewrite + DSRPT only, **Δ=0** | runner |
| Skew signs | — | m80 (+80) and p80 (−80), 3 runs each | runner |

## Touches

- **New:** `m1-harness/scripts/explore-onset-run-one.sh` (exploratory only).
- **New flags** on publisher (default 0 = constant mode preserved): `-sr-ntp-skew-onset-ms`.
- **Not modified:** `rep-run-one.sh` SAMPLE=16000, deposit result trees, manuscript/.

## Expected timeline (T=20 s onset, ~1 SR/s)

- t≈0: first frame; SRs unmodified.
- t≈9 s: first usable subscriber observation (apparatus lag; same as deposit).
- t∈[~9, 20): pre-onset bias ≈ 0 under rewrite (no skew yet).
- t=20: first modified SR.
- t∈(20, ~30]: for +80, gate holding; for −80, 0.9 adopt.
- t≳30: +80 may reset (≥10 s span); −80 should already be near +80 bias.
- t≈45: publish end; sample window covers through ~42–44 s after sub start.
