# Artifact manifest (Paper 3 M1)

See manuscript Section VIII (Reproducibility and Data Availability) and D7.

- `m1-harness/scripts/` — run scripts (`run-*.sh`, `rep-run-one.sh`, `rep-batch-b.sh`, `rep-batch-c0-dsrpt.sh`).
- `m1-harness/src/` — subscriber/harness Node sources (`*.mjs`; `c0-rewrite-sanity.mjs` sets `C0_ACT_FORCE_EXT_ID=8` by default); with `m1-harness/package.json` and `package-lock.json`.
- `m1-harness/pion-publisher/` — Go publisher source only (`*.go`, `go.mod`, `go.sum`); no built binary. Needs `third_party/server-sdk-go` rebuilt from v2.12.8 + patch (see `m1-harness/patches/README.md`).
- `m1-harness/media/c0-video.ivf` — synthetic solid-red 320x240 VP8 fixture, 1800 frames, keyframe every 128; sha256 `fe6a7fdd267054a5405844bfd67db71d3a8dedff5f662427fc1d0f29dd7a8f09`.
- `m1-harness/media/make-c0-video.sh` — generator; reproduces the fixture byte-for-byte with ffmpeg 7.1.5-0+deb13u1 (Debian 13, libvpx); other ffmpeg/libvpx versions may differ (script prints sha256).
- `m1-harness/patches/` — LiveKit and server-sdk-go patch series with patch→binary→sha256 map (README).
- `analysis/rtp-match-v1/`, `analysis/rtp-match-v1-c0-dsrpt/` — post-review correction script and outputs.
- `results/rep-2026-10-15b/` — C0/C2/C3 replication raw data (83 attempts, 80 retained).
- `results/rep-2026-10-15-c0-dsrpt/` — C0-DSRPT raw data (21 attempts, 20 retained).
- `pilot-prereg.json`, `replication-prereg-addendum.md`, `c0-dsrpt-prereg-addendum.md` — pre-registration.
- Not included: binaries (`m1-harness/bin/`), `third_party/` sources (reconstructible from upstream + patches).

## Unrecoverable data
- The 95 per-run files from the first replication attempt under `results/rep-2026-10-15/` (per-run directories such as `c0/rewrite/d50/run-1/`, present in an Oct 15 11:12 snapshot) are **unrecoverable**; they were removed during the host wipe partway through that batch (see D7). Only `_aborted/`, `_prewipe/`, `batch.log`, and `run-index.log` remain in that directory. None of these runs contributes to any reported number.
- The original single-run data (lost Oct 8, 2026) are unrecoverable (D7).
