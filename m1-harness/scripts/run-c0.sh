#!/usr/bin/env bash
# C0 rewrite sanity — stock LiveKit rewrite (NO PR #4812).
# Default publisher: Playwright Chromium canvas + Δ_inject (Day-1 ACT path).
# Optional: C0_PUBLISHER=pion for Go ACT stamp (wall_now − Δ_inject).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT_DIR="$ROOT/out"
OUT_JSON="$OUT_DIR/c0-rewrite-sanity.json"
LIVEKIT_TAG="v1.13.7"
LIVEKIT_SHA="8d11efdfcd4220092b6ac7b8a21af28526da5a6b"
BIN_DIR="$ROOT/bin"
LK_BIN="$BIN_DIR/livekit-server"
LK_PID=""
COMPOSE_UP=0
DELTAS="${C0_DELTA_MS_LIST:-0,50}"
ROOM="${LIVEKIT_ROOM:-m1-act-c0}"
PUBLISHER_MODE="${C0_PUBLISHER:-chrome}"

cleanup() {
  if [[ -f "$OUT_DIR/c0-pub.pid" ]]; then
    kill "$(cat "$OUT_DIR/c0-pub.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/c0-pub.pid"
  fi
  if [[ -n "${LK_PID}" ]] && kill -0 "$LK_PID" 2>/dev/null; then
    echo "[run-c0] stopping livekit-server pid=$LK_PID"
    kill "$LK_PID" 2>/dev/null || true
    wait "$LK_PID" 2>/dev/null || true
  fi
  if [[ "$COMPOSE_UP" -eq 1 ]] && command -v docker >/dev/null 2>&1; then
    docker compose -f "$ROOT/docker-compose.yml" down >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

have_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

wait_for_livekit() {
  local i
  for i in $(seq 1 40); do
    if (echo >/dev/tcp/127.0.0.1/7880) >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

start_via_binary() {
  mkdir -p "$BIN_DIR"
  if [[ ! -x "$LK_BIN" ]]; then
    local arch tarname url
    arch="$(uname -m)"
    case "$arch" in
      x86_64|amd64) tarname="livekit_${LIVEKIT_TAG#v}_linux_amd64.tar.gz" ;;
      aarch64|arm64) tarname="livekit_${LIVEKIT_TAG#v}_linux_arm64.tar.gz" ;;
      *) echo "unsupported arch"; return 1 ;;
    esac
    url="https://github.com/livekit/livekit/releases/download/${LIVEKIT_TAG}/${tarname}"
    curl -fsSL -o "$BIN_DIR/$tarname" "$url"
    tar -xzf "$BIN_DIR/$tarname" -C "$BIN_DIR"
    chmod +x "$LK_BIN"
  fi
  "$LK_BIN" --version 2>&1 | tee "$OUT_DIR/livekit-version-c0.txt" || true
  "$LK_BIN" --config "$ROOT/livekit.yaml" >"$OUT_DIR/livekit-server-c0.log" 2>&1 &
  LK_PID=$!
}

echo "============================================"
echo " M1 C0 rewrite sanity"
echo " LiveKit pin: $LIVEKIT_TAG ($LIVEKIT_SHA)"
echo " Policy: stock rewrite (NO PR #4812)"
echo " Publisher: $PUBLISHER_MODE"
echo " Δ_inject levels: $DELTAS"
echo " Room: $ROOM"
echo "============================================"

mkdir -p "$OUT_DIR" "$ROOT/media"

if ! (echo >/dev/tcp/127.0.0.1/7880) >/dev/null 2>&1; then
  if have_docker; then
    docker compose -f "$ROOT/docker-compose.yml" up -d
    COMPOSE_UP=1
  else
    echo "[run-c0] Docker unavailable — binary fallback"
    start_via_binary
  fi
  if ! wait_for_livekit; then
    echo "[run-c0] BLOCKER: LiveKit not ready" >&2
    echo '{"schema":"m1-c0-rewrite-sanity/v1","verdict":"C0_APPARATUS_FAIL","notes":["LiveKit not ready"]}' >"$OUT_JSON"
    exit 2
  fi
else
  echo "[run-c0] reusing LiveKit on :7880"
fi

echo "[run-c0] npm install + chromium"
npm install --no-fund --no-audit
npx playwright install chromium

if [[ "$PUBLISHER_MODE" == "pion" ]]; then
  if [[ ! -f "$ROOT/media/c0-video.ivf" ]]; then
    ffmpeg -y -f lavfi -i color=c=red:s=320x240:r=15 -t 45 -c:v libvpx -b:v 200k "$ROOT/media/c0-video.ivf" >/dev/null 2>&1
  fi
  echo "[run-c0] build pion publisher"
  (cd "$ROOT/pion-publisher" && go mod tidy && go build -o "$ROOT/bin/c0-pion-publisher" .)
fi

export LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
export LIVEKIT_ROOM="$ROOM"
export C0_PUBLISHER="$PUBLISHER_MODE"

IFS=',' read -r -a DELTA_ARR <<<"$DELTAS"
TRIAL_FILES=()

for d in "${DELTA_ARR[@]}"; do
  d="$(echo "$d" | tr -d '[:space:]')"
  [[ -z "$d" ]] && continue
  echo "[run-c0] === Δ_inject=${d} ms publisher=$PUBLISHER_MODE ==="
  INJECT_LOG="$OUT_DIR/c0-inject-d${d}.jsonl"
  rm -f "$INJECT_LOG" "$OUT_DIR/c0-trial-d${d}.json"

  if [[ "$PUBLISHER_MODE" == "pion" ]]; then
    "$ROOT/bin/c0-pion-publisher" \
      -host "$LIVEKIT_URL" -api-key "$LIVEKIT_API_KEY" -api-secret "$LIVEKIT_API_SECRET" \
      -room "$ROOM" -identity "c0-pion-pub-d${d}" -delta-inject-ms "$d" \
      -video "$ROOT/media/c0-video.ivf" -duration 45s -inject-log "$INJECT_LOG" \
      >"$OUT_DIR/c0-publisher-d${d}.log" 2>&1 &
    echo $! >"$OUT_DIR/c0-pub.pid"
    # wait for inject lines
    for i in $(seq 1 40); do
      if [[ -f "$INJECT_LOG" ]] && [[ "$(wc -l <"$INJECT_LOG" | tr -d ' ')" -gt 3 ]]; then break; fi
      sleep 0.5
    done
  fi

  set +e
  SAMPLE_DEFAULT=12000
  if [[ "$PUBLISHER_MODE" == "pion" ]]; then SAMPLE_DEFAULT=16000; fi
  C0_DELTA_MS="$d" C0_SAMPLE_MS="${C0_SAMPLE_MS:-$SAMPLE_DEFAULT}" C0_PUBLISHER="$PUBLISHER_MODE" \
    C0_INJECT_LOG="$INJECT_LOG" C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID:-8}" \
    node "$ROOT/src/c0-rewrite-sanity.mjs"
  set -e

  if [[ -f "$OUT_DIR/c0-trial-d${d}.json" ]]; then
    TRIAL_FILES+=("$OUT_DIR/c0-trial-d${d}.json")
  fi

  if [[ -f "$OUT_DIR/c0-pub.pid" ]]; then
    kill "$(cat "$OUT_DIR/c0-pub.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/c0-pub.pid"
  fi
  sleep 1
done

echo "[run-c0] merging trials"
node "$ROOT/scripts/merge-c0-trials.mjs" "${TRIAL_FILES[@]:-}"
if [[ -f "$OUT_JSON" ]]; then
  node -e "const j=require('$OUT_JSON'); console.log(JSON.stringify({verdict:j.verdict,publisher_mode:j.publisher_mode,abs_median_bias_ms:j.abs_median_bias_ms,compared_to_tau_b_10ms:j.compared_to_tau_b_10ms,trials:(j.trials||[]).length},null,2))"
fi
exit 0
