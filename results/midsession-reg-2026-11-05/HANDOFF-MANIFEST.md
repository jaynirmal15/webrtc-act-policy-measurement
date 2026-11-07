# Handoff manifest — mid-session package

Target artifact repo: https://github.com/jaynirmal15/webrtc-act-policy-measurement  
Public prereg commit: `b814592873b2c8b87f592364c23dda7f027336bb`  
(https://github.com/jaynirmal15/webrtc-act-policy-measurement/commit/b814592873b2c8b87f592364c23dda7f027336bb)

| Item in this zip | Destination in artifact repo | Status |
|---|---|---|
| `results/midsession-reg-2026-11-05/` | `results/midsession-reg-2026-11-05/` | **proposed** (new; mirrors existing `results/rep-*`) |
| `results/explore-2026-11-05-onset/` | `results/explore-2026-11-05-onset/` | **proposed** (path named in addendum; not yet in public tree) |
| `results/repro-2026-11-05/` | `results/repro-2026-11-05/` | **proposed** (new; mirrors `results/rep-*`) |
| `analysis/midsession-reg-2026-11-05/` | `analysis/midsession-reg-2026-11-05/` | **proposed** (alongside `analysis/rtp-match-v1/`) |
| `analysis/rtp-match-v1-repro-2026-11-05/` | `analysis/rtp-match-v1-repro-2026-11-05/` | **proposed** |
| `m1-harness/patches/pion-publisher/` | `m1-harness/patches/pion-publisher/` | **proposed** (new series after `server-sdk-go/` in README table) |
| `m1-harness/patches/analysis-rtp-match-v1/` | `m1-harness/patches/analysis-rtp-match-v1/` | **proposed** |
| `m1-harness/patches/README.md` | `m1-harness/patches/README.md` | replace existing |
| `m1-harness/scripts/midsession-reg-run-one.sh` | `m1-harness/scripts/midsession-reg-run-one.sh` | new file in existing `m1-harness/scripts/` |
| `m1-harness/scripts/explore-onset-run-one.sh` | `m1-harness/scripts/explore-onset-run-one.sh` | new file in existing `m1-harness/scripts/` |
| `HANDOFF-MANIFEST.md` | `results/midsession-reg-2026-11-05/HANDOFF-MANIFEST.md` (also at zip root) | **proposed** |

## Notes for the committer

- Do **not** rewrite per-run `config-snapshot.json` / `GIT_SHA`: they record experiment-environment HEAD `7cdb4f9…` at run time and the local addendum path used then. The **registered** public prereg is `b814592…`; rule text matches (see REGISTERED-REPORT.md).
- `midsession-prereg-addendum.md` is already on `main` at `b814592` — not re-shipped here.
- Excluded: `manuscript/`, October `results/rep-2026-10-15*`, binaries, `node_modules`, `.venv`, build artifacts.
- Patch apply (pion-publisher): on a checkout of the deposited `m1-harness/pion-publisher/` tree, `git am m1-harness/patches/pion-publisher/*.patch`. Default `-sr-ntp-skew-onset-ms=0` preserves constant-offset mode.
- Patch apply (rtp-match Δ=0): `git am` onto deposited `analysis/rtp-match-v1/rtp_rematch.py`.
- Harness scripts reference local `devkey`/`secret` LiveKit API keys (same as existing deposit scripts) — not production secrets.
