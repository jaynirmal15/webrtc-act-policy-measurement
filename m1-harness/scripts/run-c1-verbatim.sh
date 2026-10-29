#!/usr/bin/env bash
# C3 staggered A/V sync_err — verbatim ACT (ε arm). Same inject as C1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT_DIR="$ROOT/out"
LIVEKIT_TAG="v1.13.7"
LIVEKIT_SHA="8d11efdfcd4220092b6ac7b8a21af28526da5a6b"
LK_BIN="$ROOT/bin/livekit-server-verbatim"
LK_CFG="$ROOT/livekit-verbatim.yaml"
LK_PID=""
DELTAS="${C0_DELTA_MS_LIST:-0}"
AV_OFFSETS="${C1_AV_OFFSET_MS_LIST:-80,0}"
STAGGER_START="${C1_STAGGER_START_MS:-500}"
ROOM="${LIVEKIT_ROOM:-m1-act-c1-verbatim}"
PUBLISHER_MODE="${C0_PUBLISHER:-pion}"

cleanup() {
  if [[ -f "$OUT_DIR/c1-verbatim-pub.pid" ]]; then
    kill "$(cat "$OUT_DIR/c1-verbatim-pub.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/c1-verbatim-pub.pid"
  fi
  if [[ -n "${LK_PID}" ]] && kill -0 "$LK_PID" 2>/dev/null; then
    echo "[run-c1-verbatim] stopping verbatim pid=$LK_PID"
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
    echo "[run-c1-verbatim] stopping existing livekit on :7880: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
}

echo "============================================"
echo " M1 C3 staggered A/V sync_err (verbatim)"
echo " LiveKit pin: $LIVEKIT_TAG ($LIVEKIT_SHA)"
echo " Binary: $LK_BIN"
echo " Δ_inject: $DELTAS  av_offset_ms: $AV_OFFSETS  stagger_start_ms: $STAGGER_START"
echo " Room: $ROOM"
echo " ε=40 τ_b=10 LOCKED"
echo "============================================"

mkdir -p "$OUT_DIR" "$ROOT/media"
if [[ ! -x "$LK_BIN" ]]; then echo "BLOCKER: missing $LK_BIN" >&2; exit 2; fi
if [[ ! -f "$LK_CFG" ]]; then echo "BLOCKER: missing $LK_CFG" >&2; exit 2; fi

stop_existing_livekit
"$LK_BIN" --version 2>&1 | tee "$OUT_DIR/livekit-version-c1-verbatim.txt" || true
"$LK_BIN" --config "$LK_CFG" >"$OUT_DIR/livekit-server-c1-verbatim.log" 2>&1 &
LK_PID=$!
echo "$LK_PID" >"$OUT_DIR/livekit-c1-verbatim.pid"
if ! wait_for_livekit; then
  echo "[run-c1-verbatim] BLOCKER: not ready" >&2
  tail -40 "$OUT_DIR/livekit-server-c1-verbatim.log" || true
  exit 2
fi

npm install --no-fund --no-audit >/dev/null
npx playwright install chromium >/dev/null
[[ -f "$ROOT/media/c1-video.ivf" ]] || ffmpeg -y -f lavfi -i color=c=blue:s=320x240:r=15 -t 45 -c:v libvpx -b:v 200k -an "$ROOT/media/c1-video.ivf" >/dev/null 2>&1
[[ -f "$ROOT/media/c1-audio.ogg" ]] || ffmpeg -y -f lavfi -i sine=frequency=440:sample_rate=48000 -t 45 -c:a libopus -b:a 32k -ac 1 "$ROOT/media/c1-audio.ogg" >/dev/null 2>&1
(cd "$ROOT/pion-publisher" && go build -o "$ROOT/bin/c1-pion-publisher" .)

export LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
export LIVEKIT_ROOM="$ROOM"
export C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID:-8}"
export C0_PION_IDENTITY_PREFIX=c1-pion
export C1_CELL_ID=C3
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
    ROOM="m1-act-c1-verbatim-d${d}-av${av}"
    export LIVEKIT_ROOM="$ROOM"
    echo "[run-c1-verbatim] === Δ=${d} ms av_offset=${av} ms policy=verbatim ==="
    INJECT_LOG="$OUT_DIR/c1-verbatim-inject-d${d}-av${av}.jsonl"
    TRIAL_JSON="$OUT_DIR/c1-verbatim-trial-d${d}-av${av}.json"
    rm -f "$INJECT_LOG" "$TRIAL_JSON"

    "$ROOT/bin/c1-pion-publisher" \
      -host "$LIVEKIT_URL" -api-key "$LIVEKIT_API_KEY" -api-secret "$LIVEKIT_API_SECRET" \
      -room "$ROOM" -identity "c1-pion-pub-d${d}-av${av}" \
      -delta-inject-ms "$d" -av-offset-ms "$av" -stagger-start-ms "$STAGGER_START" \
      -video "$ROOT/media/c1-video.ivf" -audio "$ROOT/media/c1-audio.ogg" \
      -duration 50s -inject-log "$INJECT_LOG" \
      >"$OUT_DIR/c1-verbatim-publisher-d${d}-av${av}.log" 2>&1 &
    echo $! >"$OUT_DIR/c1-verbatim-pub.pid"
    for i in $(seq 1 50); do
      if [[ -f "$INJECT_LOG" ]] && [[ "$(wc -l <"$INJECT_LOG" | tr -d ' ')" -gt 5 ]]; then break; fi
      sleep 0.5
    done
    sleep 2

    set +e
    C0_DELTA_MS="$d" C0_SAMPLE_MS="${C0_SAMPLE_MS:-18000}" C0_PUBLISHER=pion \
      C0_INJECT_LOG="$INJECT_LOG" C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID}" \
      C0_POLICY=verbatim C0_PR_4812_APPLIED=true \
      C0_OUT_PREFIX=c1-verbatim C0_TRIAL_PREFIX=c1-verbatim-trial \
      C0_OUT_JSON="$OUT_DIR/c1-verbatim-av-sync.json" \
      C0_PION_IDENTITY_PREFIX=c1-pion \
      C1_AV_OFFSET_MS="$av" C1_STAGGER_START_MS="$STAGGER_START" C1_CELL_ID=C3 \
      node "$ROOT/src/c1-av-sync.mjs"
    rc=$?
    set -e

    if [[ -f "$OUT_DIR/c1-verbatim-trial-d${d}.json" ]]; then
      mv -f "$OUT_DIR/c1-verbatim-trial-d${d}.json" "$TRIAL_JSON"
    fi
    if [[ -f "$TRIAL_JSON" ]]; then
      TRIAL_FILES+=("$TRIAL_JSON")
    fi

    if [[ -f "$OUT_DIR/c1-verbatim-pub.pid" ]]; then
      kill "$(cat "$OUT_DIR/c1-verbatim-pub.pid")" 2>/dev/null || true
      rm -f "$OUT_DIR/c1-verbatim-pub.pid"
    fi
    sleep 1
    echo "[run-c1-verbatim] trial rc=$rc file=$TRIAL_JSON"
  done
done

echo "[run-c1-verbatim] merging"
C1_MERGE_OUT="$OUT_DIR/c1-verbatim-av-sync.json" C1_POLICY=verbatim \
  node "$ROOT/scripts/merge-c1-trials.mjs" "${TRIAL_FILES[@]:-}"
exit 0
