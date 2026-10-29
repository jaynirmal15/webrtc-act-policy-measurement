#!/usr/bin/env bash
# One-shot Day-1 ACT gate: bring up LiveKit v1.13.7, npm i, run gate, print verdict.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT_JSON="$ROOT/out/day1-gate.json"
LIVEKIT_TAG="v1.13.7"
LIVEKIT_SHA="8d11efdfcd4220092b6ac7b8a21af28526da5a6b"
LIVEKIT_IMAGE="livekit/livekit-server:v1.13.7"
LIVEKIT_MANIFEST_DIGEST="sha256:6fd3b7088874c4d119160dd688798dfec852bc014786d392caad15f6f63912a3"
BIN_DIR="$ROOT/bin"
LK_BIN="$BIN_DIR/livekit-server"
LK_PID=""
COMPOSE_UP=0

cleanup() {
  if [[ -n "${LK_PID}" ]] && kill -0 "$LK_PID" 2>/dev/null; then
    echo "[run-day1] stopping livekit-server pid=$LK_PID"
    kill "$LK_PID" 2>/dev/null || true
    wait "$LK_PID" 2>/dev/null || true
  fi
  if [[ "$COMPOSE_UP" -eq 1 ]]; then
    if command -v docker >/dev/null 2>&1; then
      docker compose -f "$ROOT/docker-compose.yml" down >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

have_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

wait_for_livekit() {
  local i
  for i in $(seq 1 40); do
    if curl -sf -o /dev/null "http://127.0.0.1:7880/" || curl -sf -o /dev/null "http://127.0.0.1:7880"; then
      return 0
    fi
    # LiveKit may return 404/401 on / — treat any TCP accept as up via bash /dev/tcp
    if (echo >/dev/tcp/127.0.0.1/7880) >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

start_via_compose() {
  echo "[run-day1] starting LiveKit via docker compose ($LIVEKIT_IMAGE)"
  docker compose -f "$ROOT/docker-compose.yml" pull
  docker compose -f "$ROOT/docker-compose.yml" up -d
  COMPOSE_UP=1
  if docker image inspect "$LIVEKIT_IMAGE" >/dev/null 2>&1; then
    echo "[run-day1] image digests:"
    docker image inspect "$LIVEKIT_IMAGE" --format '{{json .RepoDigests}}' || true
    docker image inspect "$LIVEKIT_IMAGE" --format 'Id={{.Id}}' || true
  fi
}

start_via_binary() {
  mkdir -p "$BIN_DIR"
  local arch tarname url
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) tarname="livekit_${LIVEKIT_TAG#v}_linux_amd64.tar.gz" ;;
    aarch64|arm64) tarname="livekit_${LIVEKIT_TAG#v}_linux_arm64.tar.gz" ;;
    *)
      echo "[run-day1] unsupported arch=$arch for release binary fallback" >&2
      return 1
      ;;
  esac
  url="https://github.com/livekit/livekit/releases/download/${LIVEKIT_TAG}/${tarname}"
  if [[ ! -x "$LK_BIN" ]]; then
    echo "[run-day1] downloading official release binary $url"
    curl -fsSL -o "$BIN_DIR/$tarname" "$url"
    tar -xzf "$BIN_DIR/$tarname" -C "$BIN_DIR"
    # tarball contains livekit-server
    if [[ ! -x "$LK_BIN" ]]; then
      # sometimes extracted name differs
      local found
      found="$(find "$BIN_DIR" -maxdepth 2 -type f -name 'livekit-server' | head -1)"
      if [[ -n "$found" ]]; then
        mv "$found" "$LK_BIN"
      fi
    fi
    chmod +x "$LK_BIN"
  fi
  echo "[run-day1] starting $LK_BIN --config livekit.yaml (pin $LIVEKIT_TAG / $LIVEKIT_SHA)"
  "$LK_BIN" --version 2>&1 | tee "$ROOT/out/livekit-version.txt" || true
  "$LK_BIN" --config "$ROOT/livekit.yaml" >"$ROOT/out/livekit-server.log" 2>&1 &
  LK_PID=$!
  echo "[run-day1] livekit-server pid=$LK_PID log=$ROOT/out/livekit-server.log"
}

echo "============================================"
echo " M1 Day-1 ACT gate"
echo " LiveKit pin: $LIVEKIT_TAG ($LIVEKIT_SHA)"
echo " Image: $LIVEKIT_IMAGE"
echo " Manifest digest (Hub): $LIVEKIT_MANIFEST_DIGEST"
echo " Policy: stock rewrite (NO PR #4812)"
echo " Room: m1-act-day1"
echo "============================================"

mkdir -p "$ROOT/out"

# Prefer docker; fall back to official GitHub release binary (same tag).
if have_docker; then
  start_via_compose
else
  echo "[run-day1] WARNING: Docker unavailable or daemon not reachable — falling back to official livekit-server ${LIVEKIT_TAG} binary"
  echo "[run-day1] docker-compose.yml remains the preferred pin path when Docker is present."
  start_via_binary
fi

if ! wait_for_livekit; then
  echo "[run-day1] BLOCKER: LiveKit did not become ready on 127.0.0.1:7880" >&2
  if [[ -f "$ROOT/out/livekit-server.log" ]]; then
    echo "---- livekit-server.log (tail) ----" >&2
    tail -n 40 "$ROOT/out/livekit-server.log" >&2 || true
  fi
  cat >"$OUT_JSON" <<JSON
{
  "schema": "m1-day1-gate/v1",
  "livekit_version": "$LIVEKIT_TAG",
  "livekit_pin_sha": "$LIVEKIT_SHA",
  "browser_version": null,
  "act_uri": "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time",
  "negotiated_publisher": false,
  "negotiated_subscriber": false,
  "captureTimestamp_seen": false,
  "samples": [],
  "verdict": "APPARATUS_ERROR",
  "notes": ["LiveKit failed to become ready on 127.0.0.1:7880 — see out/livekit-server.log"]
}
JSON
  echo "[run-day1] wrote $OUT_JSON (APPARATUS_ERROR)"
  exit 2
fi

echo "[run-day1] npm install (pinned playwright 1.62.1)"
npm install --no-fund --no-audit

echo "[run-day1] playwright install chromium"
npx playwright install chromium

export LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
export LIVEKIT_ROOM="${LIVEKIT_ROOM:-m1-act-day1}"

echo "[run-day1] running node src/day1-gate.mjs"
set +e
node "$ROOT/src/day1-gate.mjs"
GATE_EC=$?
set -e

if [[ -f "$OUT_JSON" ]]; then
  echo "---- day1-gate.json (verdict) ----"
  node -e "const j=require('$OUT_JSON'); console.log(JSON.stringify({verdict:j.verdict,livekit_version:j.livekit_version,browser_version:j.browser_version,negotiated_publisher:j.negotiated_publisher,negotiated_subscriber:j.negotiated_subscriber,captureTimestamp_seen:j.captureTimestamp_seen,samples:j.samples?.length},null,2))"
else
  echo "[run-day1] ERROR: $OUT_JSON missing" >&2
  exit 2
fi

exit "$GATE_EC"
