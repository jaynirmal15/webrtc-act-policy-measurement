# Patches for the M1 binaries (Paper 3)

All LiveKit series apply with `git am` onto upstream **livekit/livekit v1.13.7, commit 8d11efdfcd4220092b6ac7b8a21af28526da5a6b**.
The server-sdk-go series applies onto upstream **livekit/server-sdk-go v2.12.8** (module release; base taken from the Go module cache, not a checkout).

| Series | Tree after `git am` | Binary | sha256 (binary used in the runs) |
|---|---|---|---|
| (none, stock pin) | cfc24a6b9c21c9467c9efaa57c04b4b97280f54a | bin/livekit-server | 075b5fa17bad2f5d0dc16c2d60ee0053500b75a53c572991cf17a834a8b40863 |
| livekit-verbatim/ (1 patch; cherry-pick of PR #4812 flag commit 4a17f47f) | 406045f0bd3a846305d5d82add2e8860fe379da0 | bin/livekit-server-verbatim | 17c8ba1a27f0628d52e5c506e2945e205f6dd5c1abdacde0d4ac749310d504b3 |
| livekit-dsrpt/ (2 patches) | 7f6896eeba00e4678035aec89c8e0f0bc2d3d4bb | bin/livekit-server-dsrpt | 6d5fa7aeb8ad167e58b7de6b24a0bb1713a52d485ec4862cb9f22e90a7436987 |
| livekit-verbatim-dsrpt/ (3 patches) | 72a6766d624ccdad0304f06eef586d568013d527 | bin/livekit-server-verbatim-dsrpt | 628ddfe1c8e301e4da02c5bafea16bbdd9aca8002469669330d166ea30a13f86 |
| server-sdk-go/ (1 patch: readersampleprovider.go, transport.go, transport.go.patch-note) | — | bin/c3-pion-publisher (via go.mod replace => ../third_party/server-sdk-go) | 0491a4abba9f0e239e02aba46b0e355978bfba67c9e8e76dc6ddd1e1025a4c7e |
| pion-publisher/ (1 patch: act_interceptor.go, main.go, sr_ntp_skew_interceptor.go) | — | bin/c3-pion-publisher (onset; default -sr-ntp-skew-onset-ms=0 = constant mode) | rebuild from deposited source + this series |

Binary hashes match the `livekit_binary_sha256` / `publisher_binary_sha256` recorded per run in `config-snapshot.json`.
Binaries carry no VCS stamp (`go version -m` shows "(devel)"), so the patch→binary mapping is by build record, not embedded metadata. A rebuilt binary has a different hash (the original build used no `-trimpath`); the source tree is what can be verified.

## Verifying the LiveKit series

The tree hash is the verifiable value. Commit hashes after `git am` depend on the committer's name, email and time, so they differ on every machine; the tree hash depends only on the file contents. (`git am` needs a committer identity: set `git config user.name` and `user.email` in the checkout first, or it stops with "unable to auto-detect email address".)

From a clone of livekit/livekit:

```
git checkout -B livekit-verbatim 8d11efdfcd4220092b6ac7b8a21af28526da5a6b
git am /path/to/m1-harness/patches/livekit-verbatim/*.patch
git rev-parse HEAD^{tree}    # expect 406045f0bd3a846305d5d82add2e8860fe379da0
```

Repeat for `livekit-dsrpt/` (expect 7f6896eeba00e4678035aec89c8e0f0bc2d3d4bb) and `livekit-verbatim-dsrpt/` (expect 72a6766d624ccdad0304f06eef586d568013d527), each from a fresh branch at the pin. The stock pin's tree is `git rev-parse 8d11efdf^{tree}` = cfc24a6b9c21c9467c9efaa57c04b4b97280f54a. These values were measured on 2026-11-05 from a clean clone of the v1.0.0 deposit; all three series applied cleanly.

Build: `go build -o livekit-server-<variant> ./cmd/server` (Go 1.26.0; LiveKit's `go.mod` requires it).

## Rebuilding pion-publisher from a fresh extraction

`pion-publisher/go.mod` has `replace github.com/livekit/server-sdk-go/v2 => ../third_party/server-sdk-go`, which is not shipped. Recreate it, running every command from the repository root:

```
go mod download github.com/livekit/server-sdk-go/v2@v2.12.8
mkdir -p m1-harness/third_party
cp -r "$(go env GOMODCACHE)/github.com/livekit/server-sdk-go/v2@v2.12.8" m1-harness/third_party/server-sdk-go
chmod -R u+w m1-harness/third_party/server-sdk-go
git apply --directory=m1-harness/third_party/server-sdk-go m1-harness/patches/server-sdk-go/*.patch
test -f m1-harness/third_party/server-sdk-go/transport.go.patch-note && echo "server-sdk-go patch applied"
(cd m1-harness/pion-publisher && go build -o ../bin/c3-pion-publisher .)
```

The check for `transport.go.patch-note` is required. The form documented before this revision, `(cd m1-harness/third_party/server-sdk-go && git apply ../../patches/server-sdk-go/*.patch)`, exits 0 and applies nothing: `third_party/` lies inside this repository's git working tree (and is gitignored), so `git apply` resolves the patch paths against the repository root and skips them silently. The unpatched publisher then builds without error.

Builds with Go 1.24.4. The resulting binary hash differs from the recorded one (no -trimpath / different build paths); the source tree is identical.

## pion-publisher mid-session onset (2026-11-05)

Series `pion-publisher/` applies onto the **deposited** `m1-harness/pion-publisher/` tree. Its paths are bare filenames (`a/main.go`, not `a/m1-harness/pion-publisher/main.go`), so run it from the repository root with `--directory`:

```
git am --directory=m1-harness/pion-publisher m1-harness/patches/pion-publisher/*.patch
```

(`git apply --directory=m1-harness/pion-publisher ...` works the same without creating a commit.) Without `--directory` it fails with "act_interceptor.go: No such file or directory".

- Patch: `0001-paper3-add-time-gated-SR-NTP-skew-onset-to-pion-publisher.patch`
- Adds `-sr-ntp-skew-onset-ms` (default **0**): constant-offset mode unchanged when unset/0; when >0, SRs are unmodified until T ms after the first RTP frame, then skewed.
- Build as above, after the server-sdk-go step.

## analysis/rtp-match-v1 Δ=0-only decision block (repro)

Series `analysis-rtp-match-v1/` applies onto the deposited `analysis/rtp-match-v1/rtp_rematch.py`. Its path is a bare filename (`a/rtp_rematch.py`), so run it from the repository root with `--directory`:

```
git apply --directory=analysis/rtp-match-v1 m1-harness/patches/analysis-rtp-match-v1/*.patch
```

The patched copy is shipped as `analysis/rtp-match-v1-repro-2026-11-05/rtp_rematch.py`.

- Tolerates a Δ=0-only input set (as in `results/repro-2026-11-05/`) without requiring d50 or c3-p80 keys in the decision block. Where c3-p80 is present, `direction.per_delta.<Δ>.supported` is computed exactly as before; it is `null` only when c3-p80 is absent. The overall `direction.supported` is `null` when any per-Δ value is `null` (not evaluated) and otherwise the conjunction as before; in the repro subset both are `null`, not `false`.
- Does not change the bias algorithm. Verified: on `results/rep-2026-10-15b/` and on the combined C0-DSRPT view described in the top-level README, the patched script reproduces `summary.json` (apart from its recorded `source` path), `summary.md`, `per_run.json`, `observations.json` and `run_output.txt` byte-identically.
- The script reads `<input>/_failed/`. `results/repro-2026-11-05/` had no failed runs, and git does not store an empty directory, so create it before re-running: `mkdir -p results/repro-2026-11-05/_failed`.
