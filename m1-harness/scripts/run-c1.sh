#!/usr/bin/env bash
# C1 staggered A/V sync_err — stock LiveKit rewrite (ε arm). DSRPT=false by default.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT_DIR="$ROOT/out"
LIVEKIT_TAG="v1.13.7"
LIVEKIT_SHA="8d11efdfcd4220092b6ac7b8a21af28526da5a6b"
BIN_DIR="$ROOT/bin"
LK_BIN="$BIN_DIR/livekit-server"
LK_PID=""
DELTAS="${C0_DELTA_MS_LIST:-0}"
AV_OFFSETS="${C1_AV_OFFSET_MS_LIST:-0,80}"
STAGGER_START="${C1_STAGGER_START_MS:-500}"
ROOM="${LIVEKIT_ROOM:-m1-act-c1}"
PUBLISHER_MODE="${C0_PUBLISHER:-pion}"

cleanup() {
  if [[ -f "$OUT_DIR/c1-pub.pid" ]]; then
    kill "$(cat "$OUT_DIR/c1-pub.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/c1-pub.pid"
  fi
  if [[ -n "${LK_PID}" ]] && kill -0 "$LK_PID" 2>/dev/null; then
    echo "[run-c1] stopping livekit-server pid=$LK_PID"
    kill "$LK_PID" 2>/dev/null || true
    wait "$LK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_for_livekit() {
  local i
  for i in $(seq 1 40); do
    if (echo >/dev/tcp/127.0.0.1/7880) >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

stop_existing_livekit() {
  local pids
  pids="$(ss -ltnp 2>/dev/null | awk '/:7880/ {print}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)"
  if [[ -z "$pids" ]]; then
    pids="$(pgrep -f '/workspace/paper3/m1-harness/bin/livekit-server' || true)"
  fi
  local filtered="" me=$$ pp=$PPID
  for p in $pids; do
    [[ "$p" == "$me" || "$p" == "$pp" ]] && continue
    filtered="$filtered $p"
  done
  pids="$(echo $filtered | xargs)"
  if [[ -n "$pids" ]]; then
    echo "[run-c1] stopping existing livekit on :7880: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
}

echo "============================================"
echo " M1 C1 staggered A/V sync_err (stock rewrite)"
echo " LiveKit pin: $LIVEKIT_TAG ($LIVEKIT_SHA)"
echo " Policy: stock rewrite DSRPT=false"
echo " Publisher: $PUBLISHER_MODE"
echo " Δ_inject: $DELTAS  av_offset_ms: $AV_OFFSETS  stagger_start_ms: $STAGGER_START"
echo " Room: $ROOM"
echo " ε=40 τ_b=10 LOCKED"
echo "============================================"

mkdir -p "$OUT_DIR" "$ROOT/media"

stop_existing_livekit
if [[ ! -x "$LK_BIN" ]]; then
  echo "[run-c1] BLOCKER: missing $LK_BIN" >&2
  exit 2
fi
"$LK_BIN" --version 2>&1 | tee "$OUT_DIR/livekit-version-c1.txt" || true
"$LK_BIN" --config "$ROOT/livekit.yaml" >"$OUT_DIR/livekit-server-c1.log" 2>&1 &
LK_PID=$!
echo "$LK_PID" >"$OUT_DIR/livekit-c1.pid"
if ! wait_for_livekit; then
  echo "[run-c1] BLOCKER: LiveKit not ready" >&2
  tail -40 "$OUT_DIR/livekit-server-c1.log" || true
  exit 2
fi

echo "[run-c1] npm + chromium"
npm install --no-fund --no-audit >/dev/null
npx playwright install chromium >/dev/null

if [[ ! -f "$ROOT/media/c1-video.ivf" ]]; then
  ffmpeg -y -f lavfi -i color=c=blue:s=320x240:r=15 -t 45 -c:v libvpx -b:v 200k -an "$ROOT/media/c1-video.ivf" >/dev/null 2>&1
fi
if [[ ! -f "$ROOT/media/c1-audio.ogg" ]]; then
  ffmpeg -y -f lavfi -i sine=frequency=440:sample_rate=48000 -t 45 -c:a libopus -b:a 32k -ac 1 "$ROOT/media/c1-audio.ogg" >/dev/null 2>&1
fi
echo "[run-c1] build pion publisher"
(cd "$ROOT/pion-publisher" && go build -o "$ROOT/bin/c1-pion-publisher" .)

export LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
export LIVEKIT_ROOM="$ROOM"
export C0_PUBLISHER="$PUBLISHER_MODE"
export C0_POLICY=stock_rewrite
export C0_PR_4812_APPLIED=false
export C0_OUT_PREFIX=c1-rewrite
export C0_TRIAL_PREFIX=c1-trial
export C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID:-8}"
export C0_PION_IDENTITY_PREFIX=c1-pion
export C1_CELL_ID=C1
export C1_STAGGER_START_MS="$STAGGER_START"

IFS=',' read -r -a DELTA_ARR <<<"$DELTAS"
IFS=',' read -r -a AV_ARR <<<"$AV_OFFSETS"
TRIAL_FILES=()

for d in "${DELTA_ARR[@]}"; do
  d="$(echo "$d" | tr -d '[:space:]')"
  [[ -z "$d" ]] && continue
  for av in "${AV_ARR[@]}"; do
    av="$(echo "$av" | tr -d '[:space:]')"
    [[ -z "$av" ]] && continue
    ROOM="m1-act-c1-d${d}-av${av}"
    export LIVEKIT_ROOM="$ROOM"
    echo "[run-c1] === Δ=${d} ms av_offset=${av} ms policy=rewrite ==="
    INJECT_LOG="$OUT_DIR/c1-inject-d${d}-av${av}.jsonl"
    TRIAL_JSON="$OUT_DIR/c1-trial-d${d}-av${av}.json"
    rm -f "$INJECT_LOG" "$TRIAL_JSON"

    "$ROOT/bin/c1-pion-publisher" \
      -host "$LIVEKIT_URL" -api-key "$LIVEKIT_API_KEY" -api-secret "$LIVEKIT_API_SECRET" \
      -room "$ROOM" -identity "c1-pion-pub-d${d}-av${av}" \
      -delta-inject-ms "$d" -av-offset-ms "$av" -stagger-start-ms "$STAGGER_START" \
      -video "$ROOT/media/c1-video.ivf" -audio "$ROOT/media/c1-audio.ogg" \
      -duration 50s -inject-log "$INJECT_LOG" \
      >"$OUT_DIR/c1-publisher-d${d}-av${av}.log" 2>&1 &
    echo $! >"$OUT_DIR/c1-pub.pid"
    for i in $(seq 1 50); do
      if [[ -f "$INJECT_LOG" ]] && [[ "$(wc -l <"$INJECT_LOG" | tr -d ' ')" -gt 5 ]]; then break; fi
      sleep 0.5
    done
    # ensure both audio+video inject lines exist when possible
    sleep 2

    set +e
    C0_DELTA_MS="$d" C0_SAMPLE_MS="${C0_SAMPLE_MS:-18000}" C0_PUBLISHER=pion \
      C0_INJECT_LOG="$INJECT_LOG" C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID}" \
      C0_POLICY=stock_rewrite C0_PR_4812_APPLIED=false \
      C0_OUT_PREFIX=c1-rewrite C0_TRIAL_PREFIX=c1-trial \
      C0_OUT_JSON="$OUT_DIR/c1-rewrite-av-sync.json" \
      C0_PION_IDENTITY_PREFIX=c1-pion \
      C1_AV_OFFSET_MS="$av" C1_STAGGER_START_MS="$STAGGER_START" C1_CELL_ID=C1 \
      node "$ROOT/src/c1-av-sync.mjs"
    rc=$?
    set -e

    # Rename per-cell trial if generic written
    if [[ -f "$OUT_DIR/c1-trial-d${d}.json" ]]; then
      mv -f "$OUT_DIR/c1-trial-d${d}.json" "$TRIAL_JSON"
    fi
    if [[ -f "$TRIAL_JSON" ]]; then
      TRIAL_FILES+=("$TRIAL_JSON")
    fi

    if [[ -f "$OUT_DIR/c1-pub.pid" ]]; then
      kill "$(cat "$OUT_DIR/c1-pub.pid")" 2>/dev/null || true
      rm -f "$OUT_DIR/c1-pub.pid"
    fi
    sleep 1
    echo "[run-c1] trial rc=$rc file=$TRIAL_JSON"
  done
done

echo "[run-c1] merging"
C1_MERGE_OUT="$OUT_DIR/c1-rewrite-av-sync.json" C1_POLICY=stock_rewrite \
  node "$ROOT/scripts/merge-c1-trials.mjs" "${TRIAL_FILES[@]:-}"
exit 0
