# Patches for the M1 binaries (Paper 3)

All LiveKit series apply with `git am` onto upstream **livekit/livekit v1.13.7, commit 8d11efdfcd4220092b6ac7b8a21af28526da5a6b**.
The server-sdk-go series applies onto upstream **livekit/server-sdk-go v2.12.8** (module release; base taken from the Go module cache, not a checkout).

| Series | Commits (local) | Binary | sha256 |
|---|---|---|---|
| (none, stock pin) | 8d11efdf | bin/livekit-server | 075b5fa17bad2f5d0dc16c2d60ee0053500b75a53c572991cf17a834a8b40863 |
| livekit-verbatim/ (1 patch; cherry-pick of PR #4812 flag commit 4a17f47f) | 19cb9888 | bin/livekit-server-verbatim | 17c8ba1a27f0628d52e5c506e2945e205f6dd5c1abdacde0d4ac749310d504b3 |
| livekit-dsrpt/ (2 patches) | 2ef6c86f, 669dc980 | bin/livekit-server-dsrpt | 6d5fa7aeb8ad167e58b7de6b24a0bb1713a52d485ec4862cb9f22e90a7436987 |
| livekit-verbatim-dsrpt/ (3 patches) | 19cb9888, aa834957, 0b8a0f99 | bin/livekit-server-verbatim-dsrpt | 628ddfe1c8e301e4da02c5bafea16bbdd9aca8002469669330d166ea30a13f86 |
| server-sdk-go/ (1 patch: readersampleprovider.go, transport.go, transport.go.patch-note) | — | bin/c3-pion-publisher (via go.mod replace => ../third_party/server-sdk-go) | 0491a4abba9f0e239e02aba46b0e355978bfba67c9e8e76dc6ddd1e1025a4c7e |

Binary hashes match the `livekit_binary_sha256` / `publisher_binary_sha256` recorded per run in `config-snapshot.json`.
Binaries carry no VCS stamp (`go version -m` shows "(devel)"), so the patch→binary mapping is by build record, not embedded metadata.

Verification (2026-10-16): each LiveKit series was applied with `git am` in a temporary detached worktree at 8d11efdf; all applied cleanly and the resulting tree hashes equal the source commits (19cb9888, 669dc980, 0b8a0f99). The server-sdk-go patch applied cleanly to v2.12.8 and reproduces third_party/server-sdk-go exactly. Temporary worktrees were removed.

Build (sketch): `git checkout 8d11efdf && git am <series>/*.patch && go build -o livekit-server-<variant> ./cmd/server`.

## Rebuilding pion-publisher from a fresh extraction
`pion-publisher/go.mod` has `replace github.com/livekit/server-sdk-go/v2 => ../third_party/server-sdk-go`, which is not shipped. Recreate it:
```
mkdir -p m1-harness/third_party
cp -r "$(go env GOMODCACHE)/github.com/livekit/server-sdk-go/v2@v2.12.8" m1-harness/third_party/server-sdk-go   # or: go mod download github.com/livekit/server-sdk-go/v2@v2.12.8
chmod -R u+w m1-harness/third_party/server-sdk-go
(cd m1-harness/third_party/server-sdk-go && git apply ../../patches/server-sdk-go/*.patch)
(cd m1-harness/pion-publisher && go build -o ../bin/c3-pion-publisher .)
```
Verified 2026-10-16 offline (GOPROXY=off, warm module cache) from a clean zip extraction: builds with Go 1.24.4. The resulting binary hash differs from the recorded one (no -trimpath / different build paths); the source tree is identical.
