#!/usr/bin/env bash
# C4 delayed first SR — verbatim (#4812 flag). Same SR-hold inject as C2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT_DIR="$ROOT/out"
LIVEKIT_TAG="v1.13.7"
LIVEKIT_SHA="8d11efdfcd4220092b6ac7b8a21af28526da5a6b"
LK_BIN="$ROOT/bin/livekit-server-verbatim"
LK_CFG="$ROOT/livekit-verbatim.yaml"
LK_PID=""
DELTAS="${C0_DELTA_MS_LIST:-0,50}"
SR_HOLD_MS="${C2_SR_HOLD_MS:-15000}"
ROOM_BASE="${LIVEKIT_ROOM:-m1-act-c2-verbatim}"

cleanup() {
  if [[ -f "$OUT_DIR/c2-verbatim-pub.pid" ]]; then
    kill "$(cat "$OUT_DIR/c2-verbatim-pub.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/c2-verbatim-pub.pid"
  fi
  if [[ -n "${LK_PID}" ]] && kill -0 "$LK_PID" 2>/dev/null; then
    echo "[run-c2-verbatim] stopping verbatim pid=$LK_PID"
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
    echo "[run-c2-verbatim] stopping existing livekit on :7880: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
}

echo "============================================"
echo " M1 C4 delayed first SR (verbatim)"
echo " LiveKit pin: $LIVEKIT_TAG ($LIVEKIT_SHA)"
echo " Binary: $LK_BIN"
echo " SR hold: ${SR_HOLD_MS} ms"
echo " Δ_inject: $DELTAS  video-only"
echo " ε=40 τ_b=10 LOCKED"
echo "============================================"

mkdir -p "$OUT_DIR" "$ROOT/media"
if [[ ! -x "$LK_BIN" ]]; then echo "BLOCKER: missing $LK_BIN" >&2; exit 2; fi
if [[ ! -f "$LK_CFG" ]]; then echo "BLOCKER: missing $LK_CFG" >&2; exit 2; fi

stop_existing_livekit
"$LK_BIN" --version 2>&1 | tee "$OUT_DIR/livekit-version-c2-verbatim.txt" || true
"$LK_BIN" --config "$LK_CFG" >"$OUT_DIR/livekit-server-c2-verbatim.log" 2>&1 &
LK_PID=$!
echo "$LK_PID" >"$OUT_DIR/livekit-c2-verbatim.pid"
if ! wait_for_livekit; then
  echo "[run-c2-verbatim] BLOCKER: not ready" >&2
  tail -40 "$OUT_DIR/livekit-server-c2-verbatim.log" || true
  exit 2
fi

npm install --no-fund --no-audit >/dev/null
npx playwright install chromium >/dev/null
[[ -f "$ROOT/media/c0-video.ivf" ]] || ffmpeg -y -f lavfi -i color=c=red:s=320x240:r=15 -t 45 -c:v libvpx -b:v 200k -an "$ROOT/media/c0-video.ivf" >/dev/null 2>&1
(cd "$ROOT/pion-publisher" && go build -o "$ROOT/bin/c2-pion-publisher" .)

export LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
export C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID:-8}"
export C0_PION_IDENTITY_PREFIX=c2-pion
export C2_SR_HOLD_MS="$SR_HOLD_MS"
export C2_EARLY_WINDOW_MS="${C2_EARLY_WINDOW_MS:-$SR_HOLD_MS}"
export C2_CELL_ID=C4

SAMPLE_DEFAULT=$((SR_HOLD_MS + 8000))

IFS=',' read -r -a DELTA_ARR <<<"$DELTAS"
TRIAL_FILES=()

for d in "${DELTA_ARR[@]}"; do
  d="$(echo "$d" | tr -d '[:space:]')"
  [[ -z "$d" ]] && continue
  ROOM="${ROOM_BASE}-d${d}"
  export LIVEKIT_ROOM="$ROOM"
  echo "[run-c2-verbatim] === Δ=${d} ms sr_hold=${SR_HOLD_MS} ms policy=verbatim ==="
  INJECT_LOG="$OUT_DIR/c2-verbatim-inject-d${d}.jsonl"
  TRIAL_JSON="$OUT_DIR/c2-verbatim-trial-d${d}.json"
  rm -f "$INJECT_LOG" "$TRIAL_JSON" "${INJECT_LOG%.jsonl}.meta.json"

  "$ROOT/bin/c2-pion-publisher" \
    -host "$LIVEKIT_URL" -api-key "$LIVEKIT_API_KEY" -api-secret "$LIVEKIT_API_SECRET" \
    -room "$ROOM" -identity "c2-pion-pub-d${d}" \
    -delta-inject-ms "$d" -sr-hold-ms "$SR_HOLD_MS" \
    -video-only -video "$ROOT/media/c0-video.ivf" \
    -duration 55s -inject-log "$INJECT_LOG" \
    >"$OUT_DIR/c2-verbatim-publisher-d${d}.log" 2>&1 &
  echo $! >"$OUT_DIR/c2-verbatim-pub.pid"
  for i in $(seq 1 50); do
    if [[ -f "$INJECT_LOG" ]] && [[ "$(wc -l <"$INJECT_LOG" | tr -d ' ')" -gt 3 ]]; then break; fi
    sleep 0.5
  done
  sleep 0.2

  set +e
  C0_DELTA_MS="$d" C0_SAMPLE_MS="${C0_SAMPLE_MS:-$SAMPLE_DEFAULT}" C0_PUBLISHER=pion \
    C0_INJECT_LOG="$INJECT_LOG" C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID}" \
    C0_POLICY=verbatim C0_PR_4812_APPLIED=true \
    C0_OUT_PREFIX=c2-verbatim C0_TRIAL_PREFIX=c2-verbatim-trial \
    C0_OUT_JSON="$OUT_DIR/c2-verbatim-delayed-sr.json" \
    C0_PION_IDENTITY_PREFIX=c2-pion \
    C2_SR_HOLD_MS="$SR_HOLD_MS" C2_EARLY_WINDOW_MS="${C2_EARLY_WINDOW_MS}" C2_CELL_ID=C4 \
    LIVEKIT_ROOM="$ROOM" \
    node "$ROOT/src/c2-delayed-sr.mjs"
  rc=$?
  set -e

  if [[ -f "$OUT_DIR/c2-verbatim-trial-d${d}.json" ]]; then
    TRIAL_FILES+=("$OUT_DIR/c2-verbatim-trial-d${d}.json")
  fi

  if [[ -f "$OUT_DIR/c2-verbatim-pub.pid" ]]; then
    kill "$(cat "$OUT_DIR/c2-verbatim-pub.pid")" 2>/dev/null || true
    wait "$(cat "$OUT_DIR/c2-verbatim-pub.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/c2-verbatim-pub.pid"
  fi
  sleep 0.5
  # Refresh trial with final publisher SR-hold meta (written on publisher exit)
  if [[ -f "$TRIAL_JSON" && -f "${INJECT_LOG%.jsonl}.meta.json" ]]; then
    node -e "
      const fs=require('fs');
      const trialPath=process.argv[1], metaPath=process.argv[2];
      const j=JSON.parse(fs.readFileSync(trialPath,'utf8'));
      const meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));
      const t=(j.trials&&j.trials[0])||j;
      t.publisher_sr_meta=meta; j.publisher_sr_meta=meta;
      if (t.ct_timeline && meta.sr_first_held_unix_ms && t.ct_timeline.t0_wall_ms) {
        t.ct_timeline.sample_t0_minus_sr_first_held_ms = t.ct_timeline.t0_wall_ms - meta.sr_first_held_unix_ms;
        t.ct_timeline.hold_overlap_note =
          (t.ct_timeline.t0_wall_ms - meta.sr_first_held_unix_ms) < (meta.sr_hold_ms||0)
            ? 'sample_started_during_hold' : 'sample_started_after_hold_ended';
      }
      if (t.ct_timeline && meta.sr_first_released_unix_ms && t.ct_timeline.first_ct_wall_ms) {
        t.ct_timeline.ct_minus_sr_released_ms = t.ct_timeline.first_ct_wall_ms - meta.sr_first_released_unix_ms;
      }
      fs.writeFileSync(trialPath, JSON.stringify(j,null,2));
    " "$TRIAL_JSON" "${INJECT_LOG%.jsonl}.meta.json" || true
  fi
  sleep 1
  echo "[run-c2-verbatim] trial rc=$rc"
done

echo "[run-c2-verbatim] merging"
C2_MERGE_OUT="$OUT_DIR/c2-verbatim-delayed-sr.json" C2_POLICY=verbatim \
  node "$ROOT/scripts/merge-c2-trials.mjs" "${TRIAL_FILES[@]:-}"
exit 0
