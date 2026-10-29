#!/usr/bin/env bash
# Regenerates m1-harness/media/c0-video.ivf (solid red, synthetic; no third-party content).
# Verified 2026-10-16: with ffmpeg 7.1.5-0+deb13u1 (Debian 13, libvpx) this command reproduces the
# committed fixture byte-for-byte: sha256 fe6a7fdd267054a5405844bfd67db71d3a8dedff5f662427fc1d0f29dd7a8f09
# (320x240, VP8, header 15/1 fps, 1800 frames, libvpx default keyframe interval 128).
# Other ffmpeg/libvpx versions may produce different bytes; check the sha256.
# Does NOT overwrite by default: writes to ${1:-c0-video.regen.ivf}.
set -euo pipefail
OUT="${1:-c0-video.regen.ivf}"
ffmpeg -v error -y -f lavfi -i color=c=red:s=320x240:r=15 -t 120 -c:v libvpx -b:v 300k -f ivf "$OUT"
sha256sum "$OUT"
