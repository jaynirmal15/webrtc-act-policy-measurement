# Registered mid-session batch — 2026-11-05 (America/New_York)

Prereg (public, registered): `midsession-prereg-addendum.md` @ `b814592873b2c8b87f592364c23dda7f027336bb`
(https://github.com/jaynirmal15/webrtc-act-policy-measurement/commit/b814592873b2c8b87f592364c23dda7f027336bb).

Local workspace note: runs were executed with experiment-environment HEAD `7cdb4f9` (local addendum copy). Design / Definitions / Decision rules 1–4 match the public file; see REGISTERED-REPORT.md for the apostrophe/Clarification diff and registration margin vs push `2026-11-06T04:22:25Z`.

Harness/onset build: `c56e98e` (publisher with `-sr-ntp-skew-onset-ms`).
C3 server pairing (from `rep-run-one.sh`): rewrite → `livekit-server-dsrpt`; verbatim → `livekit-server-verbatim-dsrpt`.
Chromium: 151.0.7922.34. Δ=0. Onset T=20000 ms. C0_SAMPLE_MS=42000. Publish ~45 s.

Sign inversion (CLI SkewMs opposite of NTP label):
- ntp-m80 / NTP −80 / gating → `-sr-ntp-skew-ms=80`
- ntp-p80 / NTP +80 / fast adoption → `-sr-ntp-skew-ms=-80`

Design: 2 signs × 2 policies × 5 runs = 20.
