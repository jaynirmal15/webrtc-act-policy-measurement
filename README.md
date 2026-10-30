# Absolute Capture Time policies in a WebRTC SFU: artifact

Jay Suresh Nirmal
ORCID: [0009-0003-0886-4663](https://orcid.org/0009-0003-0886-4663)

This is the measurement artifact for *Absolute Capture Time Policies in a WebRTC SFU: Measurement Bias and Timestamp Availability under a Wrong Clock Estimate* (Jay Suresh Nirmal). It contains the harness, the patch series for the SFU binaries, the pre-registration, the raw replication data, and the post-review analysis. The manuscript is not included.

The study compares two ways a LiveKit SFU can handle the RTP Absolute Capture Time (ACT) header extension:

- **rewrite** (stock): the SFU translates the capture timestamp into its own clock domain.
- **verbatim** (opt-in flag, upstream PR #4812): the SFU forwards the publisher's timestamp unchanged.

It measures capture-time bias and timestamp availability under clean and deliberately wrong clock estimates (SR-NTP perturbation).

## What it reproduces

| Cell | Question | Raw data | Analysis |
|---|---|---|---|
| C0 | Bias with a clean clock estimate | `results/rep-2026-10-15b/c0/` | `analysis/rtp-match-v1/` |
| C2 | Timestamp availability before the first Sender Report | `results/rep-2026-10-15b/c2/` | `analysis/rtp-match-v1/` |
| C3 (±80 ms) | Bias under an SR-NTP skew of −80 / +80 ms | `results/rep-2026-10-15b/c3-m80/`, `c3-p80/` | `analysis/rtp-match-v1/` |
| C0-DSRPT | C0 with sender-report pass-through disabled | `results/rep-2026-10-15-c0-dsrpt/` | `analysis/rtp-match-v1-c0-dsrpt/` |

Each cell has 5 independent runs per policy and per delay (`d0`, `d50`). Every attempt is kept: failed attempts are under `_failed/`, and each `run-index.log` lists them all (83 attempts for 80 retained runs in `rep-2026-10-15b`; 21 for 20 in `rep-2026-10-15-c0-dsrpt`). C1 (A/V sync) exists only as a historical single-run summary and has no raw data here. See `MANIFEST.md` for the full inventory and for data that cannot be recovered.

The pre-registration is `pilot-prereg.json`, `replication-prereg-addendum.md` and `c0-dsrpt-prereg-addendum.md`.

### Re-running the analysis (no SFU needed)

Requires Python 3 with NumPy. Pass the input directory explicitly; the built-in default is a path on the original lab host.

```bash
python3 analysis/rtp-match-v1/rtp_rematch.py results/rep-2026-10-15b
```

The C0-DSRPT copy of the script is byte-identical to the main one. It runs on a combined view of both result sets, because its summary also checks the C3 cells. Build that view with symlinks, then run it:

```bash
V=allcells; mkdir -p "$V/_failed"
for c in c0 c2 c3-m80 c3-p80; do ln -s "$PWD/results/rep-2026-10-15b/$c" "$V/$c"; done
ln -s "$PWD/results/rep-2026-10-15-c0-dsrpt/c0-dsrpt" "$V/c0-dsrpt"
for f in results/rep-2026-10-15b/_failed/* results/rep-2026-10-15-c0-dsrpt/_failed/*; do ln -s "$PWD/$f" "$V/_failed/"; done
python3 analysis/rtp-match-v1-c0-dsrpt/rtp_rematch.py allcells
```

These recompute per-run and pooled bias with the corrected RTP-timestamp matcher. They also reproduce the superseded nearest-ACT matcher alongside for comparison. Each script writes into its own directory and overwrites the shipped outputs, so use `git diff` afterwards to compare. Both runs were checked from a clean copy of this tree: `summary.md`, `per_run.json` and `observations.json` came out byte-identical, and `summary.json` differed only in its recorded `source` path. `results/rep-2026-10-15b/summary.{json,md}` hold the original (superseded) replication summary. `analyze_rep.py` produced them. Its input path is hardcoded to `/workspace/paper3/results/rep-2026-10-15b`, so edit `R` before re-running it; `summary.md` then reproduces byte-for-byte, and `summary.json` differs only in its `source` field.

## Dependencies

The binaries and browser are not shipped. These are the versions used:

| Component | Version |
|---|---|
| Node.js | 20.19.2 (`package.json` requires ≥ 18) |
| Playwright | 1.62.1 |
| Chromium (Playwright bundle) | 151.0.7922.34 |
| livekit-client / livekit-server-sdk (npm) | 2.22.3 / 2.13.3 (locked in `package-lock.json`) |
| Go for `pion-publisher` | 1.24.4 |
| Go for LiveKit | 1.26.0 |
| LiveKit server | v1.13.7, commit `8d11efdfcd4220092b6ac7b8a21af28526da5a6b` |
| livekit/server-sdk-go | v2.12.8 plus `m1-harness/patches/server-sdk-go/` |
| pion/webrtc (via server-sdk-go) | v4.1.6 |
| OS | Linux, kernel 6.12, with all components on the same host |

### 1. Harness (Node + Chromium)

```bash
cd m1-harness
npm ci
npx playwright install chromium
```

### 2. LiveKit binaries (four variants)

Each series applies with `git am` onto the pinned upstream commit:

```bash
git clone https://github.com/livekit/livekit.git livekit-src
cd livekit-src
git checkout 8d11efdfcd4220092b6ac7b8a21af28526da5a6b

# stock (rewrite) binary: no patches
go build -o ../m1-harness/bin/livekit-server ./cmd/server

# one patched variant per series, each from a clean checkout of the pin
for v in livekit-verbatim livekit-dsrpt livekit-verbatim-dsrpt; do
  git checkout -B "$v" 8d11efdfcd4220092b6ac7b8a21af28526da5a6b
  git am ../m1-harness/patches/$v/*.patch
  go build -o ../m1-harness/bin/livekit-server-${v#livekit-} ./cmd/server
done
```

| Series | Output binary |
|---|---|
| (none) | `bin/livekit-server` |
| `livekit-verbatim/` | `bin/livekit-server-verbatim` |
| `livekit-dsrpt/` | `bin/livekit-server-dsrpt` |
| `livekit-verbatim-dsrpt/` | `bin/livekit-server-verbatim-dsrpt` |

`m1-harness/patches/README.md` lists the sha256 of each binary used in the runs. Each run's `config-snapshot.json` records the same hashes. A rebuilt binary has the same source tree, but its hash will differ because the original build used no `-trimpath`.

### 3. Pion publisher (patched server-sdk-go)

`pion-publisher/go.mod` points at a local copy of server-sdk-go with `replace github.com/livekit/server-sdk-go/v2 => ../third_party/server-sdk-go`. That copy is not shipped. server-sdk-go comes from the Go module cache rather than a git checkout, so its patch is applied with `git apply`:

```bash
cd m1-harness
go mod download github.com/livekit/server-sdk-go/v2@v2.12.8
mkdir -p third_party
cp -r "$(go env GOMODCACHE)/github.com/livekit/server-sdk-go/v2@v2.12.8" third_party/server-sdk-go
chmod -R u+w third_party/server-sdk-go
(cd third_party/server-sdk-go && git apply ../../patches/server-sdk-go/*.patch)
(cd pion-publisher && go build -o ../bin/c3-pion-publisher .)
```

### 4. Video fixture

`m1-harness/media/c0-video.ivf` is shipped: synthetic solid red, 320×240 VP8, 1800 frames, sha256 `fe6a7fdd267054a5405844bfd67db71d3a8dedff5f662427fc1d0f29dd7a8f09`. Running `make-c0-video.sh` regenerates it byte-for-byte with ffmpeg 7.1.5-0+deb13u1 (Debian 13). Other ffmpeg or libvpx builds may produce a different file; the script prints the sha256.

## Running

One replication run (a fresh SFU, publisher and subscriber):

```bash
m1-harness/scripts/rep-run-one.sh <c0|c2|c3|c0dsrpt> <rewrite|verbatim> <delta_ms> <run_k> [m80|p80]
```

The batch drivers are `rep-batch-b.sh` (C0/C2/C3) and `rep-batch-c0-dsrpt.sh`. `run-*.sh` are the original per-cell pilot scripts. The script refuses to overwrite an existing run directory. Set `REP_SET` to write runs to a new results directory instead of `rep-2026-10-15b`. The subscriber applies the ACT extension-ID workaround with `C0_ACT_FORCE_EXT_ID=8`, which is the default in `c0-rewrite-sanity.mjs`.

## What the scripts need that is not in this repository

Every path the scripts reference was checked: shell scripts, JS sources, Go sources, Python, YAML and `docker-compose.yml`. Everything not listed below is in the repository. The scripts create `m1-harness/out/` and per-run output directories themselves, and write files into them.

| Script(s) | Needs | How to obtain it |
|---|---|---|
| `rep-run-one.sh`, `run-c0*.sh`, `run-c1*.sh`, `run-c2*.sh`, `run-c3-*.sh`, `run-day1.sh` | `m1-harness/bin/livekit-server`, `-verbatim`, `-dsrpt`, `-verbatim-dsrpt` | Build from the patch series (Dependencies, step 2). `run-c0.sh` and `run-day1.sh` can also fetch the stock `livekit-server` v1.13.7 release tarball, or start it through `docker-compose.yml` if Docker is available. |
| `rep-run-one.sh`, `run-c3-skew-delay*.sh` | `m1-harness/bin/c3-pion-publisher` | Build from `pion-publisher/` against the patched server-sdk-go (Dependencies, step 3). |
| `run-c0*.sh`, `run-c1*.sh`, `run-c2*.sh` | `m1-harness/bin/c0-`, `c1-`, `c2-pion-publisher` | The scripts build these themselves from `pion-publisher/` with `go mod tidy && go build`. They need `m1-harness/third_party/server-sdk-go` set up first (Dependencies, step 3). `go mod tidy` contacts the Go module proxy and may rewrite `go.mod`/`go.sum`. |
| All harness JS (`src/*.mjs`) | `m1-harness/node_modules/` (livekit-client UMD bundle, livekit-server-sdk, playwright) and Playwright's Chromium | `npm ci` and `npx playwright install chromium` (Dependencies, step 1). |
| `rep-batch-b.sh`, `rep-batch-c0-dsrpt.sh` | Repository root at `/workspace/paper3` (hardcoded `cd`) | Edit the `cd` line to point at your clone, or check the repository out at that path. `rep-batch-b.sh` also runs `git commit` in the repository after each cell. |
| `run-c0-dsrpt.sh`, `run-c0-verbatim*.sh`, `run-c1*.sh`, `run-c2*.sh`, `run-c3-*.sh` | `/workspace/paper3/m1-harness/bin/livekit-server` (hardcoded) | Used only as a fallback `pgrep` pattern when `ss` cannot find the process on port 7880. It is harmless elsewhere. |
| `rep-run-one.sh`, batch scripts | Linux userland: `sha256sum`, `flock`, `timeout`, `ss`, bash `/dev/tcp` | Standard on Debian/Ubuntu. The data were collected on Linux (kernel 6.12). |
| `analysis/*/rtp_rematch.py` | NumPy | `pip install numpy` |

## Licenses

- Code (harness, scripts, analysis scripts): Apache-2.0, see `LICENSE`.
- Data (`results/`, and the non-code outputs in `analysis/`): CC BY 4.0, see `LICENSE-DATA`.
- `m1-harness/patches/`: derived from LiveKit and inherit Apache-2.0, see `m1-harness/patches/LICENSE`.
