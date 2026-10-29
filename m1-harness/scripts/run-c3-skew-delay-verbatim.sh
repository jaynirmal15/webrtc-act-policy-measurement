#!/usr/bin/env bash
# C3 skew/delay cell — VERBATIM (#4812 historical flag) + DSRPT=true + same SR NTP skew.
# Expect bias stays near 0 (verbatim skips Rewrite); compare to rewrite arm.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT_DIR="$ROOT/out"
LIVEKIT_TAG="v1.13.7"
LIVEKIT_SHA="8d11efdfcd4220092b6ac7b8a21af28526da5a6b"
LK_BIN="$ROOT/bin/livekit-server-verbatim-dsrpt"
LK_CFG="$ROOT/livekit-verbatim-dsrpt.yaml"
LK_PID=""
DELTAS="${C0_DELTA_MS_LIST:-0,50}"
SKEW_MS="${C3_SR_NTP_SKEW_MS:-80}"
ROOM="${LIVEKIT_ROOM:-m1-act-c3-skew-verbatim}"
PUBLISHER_MODE="${C0_PUBLISHER:-pion}"
PREFIX="c3-skew-verbatim"

cleanup() {
  if [[ -f "$OUT_DIR/${PREFIX}-pub.pid" ]]; then
    kill "$(cat "$OUT_DIR/${PREFIX}-pub.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/${PREFIX}-pub.pid"
  fi
  if [[ -n "${LK_PID}" ]] && kill -0 "$LK_PID" 2>/dev/null; then
    echo "[run-c3-skew-verbatim] stopping livekit pid=$LK_PID"
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
    echo "[run-c3-skew-verbatim] stopping existing livekit on :7880: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
}

echo "============================================"
echo " M1 C3 skew/delay VERBATIM (Claude rec b)"
echo " LiveKit pin: $LIVEKIT_TAG ($LIVEKIT_SHA)"
echo " Binary: $LK_BIN"
echo " Config: $LK_CFG (verbatim=true, DSRPT=true)"
echo " SR NTP skew: ${SKEW_MS} ms (same inject as rewrite arm)"
echo " Δ_inject levels: $DELTAS"
echo " Room: $ROOM"
echo "============================================"

mkdir -p "$OUT_DIR" "$ROOT/media"

if [[ ! -x "$LK_BIN" ]]; then
  echo "[run-c3-skew-verbatim] BLOCKER: missing $LK_BIN" >&2
  exit 2
fi
if [[ ! -f "$LK_CFG" ]]; then
  echo "[run-c3-skew-verbatim] BLOCKER: missing $LK_CFG" >&2
  exit 2
fi

stop_existing_livekit
"$LK_BIN" --version 2>&1 | tee "$OUT_DIR/livekit-version-${PREFIX}.txt" || true
"$LK_BIN" --config "$LK_CFG" >"$OUT_DIR/livekit-server-${PREFIX}.log" 2>&1 &
LK_PID=$!
echo "$LK_PID" >"$OUT_DIR/livekit-${PREFIX}.pid"
if ! wait_for_livekit; then
  echo "[run-c3-skew-verbatim] BLOCKER: LiveKit not ready" >&2
  tail -50 "$OUT_DIR/livekit-server-${PREFIX}.log" || true
  exit 2
fi

echo "[run-c3-skew-verbatim] ensure media + publisher binary"
if [[ ! -f "$ROOT/media/c0-video.ivf" ]]; then
  ffmpeg -y -f lavfi -i color=c=red:s=320x240:r=15 -t 45 -c:v libvpx -b:v 200k "$ROOT/media/c0-video.ivf" >/dev/null 2>&1
fi
if [[ ! -x "$ROOT/bin/c3-pion-publisher" ]]; then
  (cd "$ROOT/pion-publisher" && go build -o "$ROOT/bin/c3-pion-publisher" .)
fi

export LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
export LIVEKIT_ROOM="$ROOM"
export C0_PUBLISHER="$PUBLISHER_MODE"
export C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID:-8}"

IFS=',' read -r -a DELTA_ARR <<<"$DELTAS"
TRIAL_FILES=()

for d in "${DELTA_ARR[@]}"; do
  d="$(echo "$d" | tr -d '[:space:]')"
  [[ -z "$d" ]] && continue
  echo "[run-c3-skew-verbatim] === Δ_inject=${d} ms skew=${SKEW_MS} ms policy=verbatim_dsrpt_skew ==="
  INJECT_LOG="$OUT_DIR/${PREFIX}-inject-d${d}.jsonl"
  rm -f "$INJECT_LOG" "$OUT_DIR/${PREFIX}-trial-d${d}.json"

  "$ROOT/bin/c3-pion-publisher" \
    -host "$LIVEKIT_URL" -api-key "$LIVEKIT_API_KEY" -api-secret "$LIVEKIT_API_SECRET" \
    -room "$ROOM" -identity "c3-pion-pub-d${d}" -delta-inject-ms "$d" \
    -sr-ntp-skew-ms "$SKEW_MS" -video-only \
    -video "$ROOT/media/c0-video.ivf" -duration 45s -inject-log "$INJECT_LOG" \
    >"$OUT_DIR/${PREFIX}-publisher-d${d}.log" 2>&1 &
  echo $! >"$OUT_DIR/${PREFIX}-pub.pid"
  for i in $(seq 1 40); do
    if [[ -f "$INJECT_LOG" ]] && [[ "$(wc -l <"$INJECT_LOG" | tr -d ' ')" -gt 3 ]]; then break; fi
    sleep 0.5
  done

  set +e
  C0_DELTA_MS="$d" C0_SAMPLE_MS="${C0_SAMPLE_MS:-16000}" C0_PUBLISHER=pion \
    C0_INJECT_LOG="$INJECT_LOG" C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID}" \
    C0_POLICY=verbatim_dsrpt_skew C0_PR_4812_APPLIED=true \
    C0_OUT_PREFIX="$PREFIX" C0_TRIAL_PREFIX="${PREFIX}-trial" \
    C0_OUT_JSON="$OUT_DIR/${PREFIX}-sanity.json" \
    C0_PION_IDENTITY_PREFIX=c3-pion \
    node "$ROOT/src/c0-rewrite-sanity.mjs"
  set -e

  if [[ -f "$OUT_DIR/${PREFIX}-trial-d${d}.json" ]]; then
    TRIAL_FILES+=("$OUT_DIR/${PREFIX}-trial-d${d}.json")
  fi

  if [[ -f "$OUT_DIR/${PREFIX}-pub.pid" ]]; then
    kill "$(cat "$OUT_DIR/${PREFIX}-pub.pid")" 2>/dev/null || true
    wait "$(cat "$OUT_DIR/${PREFIX}-pub.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/${PREFIX}-pub.pid"
  fi
  sleep 1
done

echo "[run-c3-skew-verbatim] merging trials"
if [[ ${#TRIAL_FILES[@]} -eq 0 ]]; then
  echo "[run-c3-skew-verbatim] BLOCKER: no trial files" >&2
  exit 2
fi
C0_MERGE_OUT="$OUT_DIR/${PREFIX}-sanity.json" C0_POLICY=verbatim_dsrpt_skew C0_PR_4812_APPLIED=true \
  node "$ROOT/scripts/merge-c0-trials.mjs" "${TRIAL_FILES[@]}"
node -e "
const fs=require('fs');
const p='$OUT_DIR/${PREFIX}-sanity.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.sr_ntp_skew_ms=$SKEW_MS;
j.method='publisher_sr_ntp_skew';
j.disable_sender_report_pass_through=true;
j.forward_abs_capture_time_verbatim=true;
j.sync_err='N/A (video-only)';
fs.writeFileSync(p, JSON.stringify(j,null,2));
console.log(JSON.stringify({verdict:j.verdict,abs_median_bias_ms:j.abs_median_bias_ms,compared_to_tau_b_10ms:j.compared_to_tau_b_10ms,sr_ntp_skew_ms:j.sr_ntp_skew_ms,trials:(j.trials||[]).length},null,2));
"
exit 0
