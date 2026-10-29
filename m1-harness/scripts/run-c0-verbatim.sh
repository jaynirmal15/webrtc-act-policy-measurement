#!/usr/bin/env bash
# C0-style VERBATIM cell — LiveKit v1.13.7 pin + PR #4812 historical flag cherry-pick.
# Requires bin/livekit-server-verbatim and livekit-verbatim.yaml.
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
ROOM="${LIVEKIT_ROOM:-m1-act-c0-verbatim}"
PUBLISHER_MODE="${C0_PUBLISHER:-pion}"

cleanup() {
  if [[ -f "$OUT_DIR/c0-verbatim-pub.pid" ]]; then
    kill "$(cat "$OUT_DIR/c0-verbatim-pub.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/c0-verbatim-pub.pid"
  fi
  if [[ -n "${LK_PID}" ]] && kill -0 "$LK_PID" 2>/dev/null; then
    echo "[run-c0-verbatim] stopping livekit-server-verbatim pid=$LK_PID"
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
  # Stop anything bound to :7880 (stock or prior verbatim) so we own the port.
  # Do NOT pgrep -f 'livekit-server' — that matches parent shells whose argv
  # merely mentions the string (agent wrappers) and kills the harness.
  local pids
  pids="$(ss -ltnp 2>/dev/null | awk '/:7880/ {print}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)"
  if [[ -z "$pids" ]]; then
    pids="$(pgrep -f '/workspace/paper3/m1-harness/bin/livekit-server' || true)"
  fi
  # Filter out our own PID / PPID just in case
  local filtered="" me=$$ pp=$PPID
  for p in $pids; do
    [[ "$p" == "$me" || "$p" == "$pp" ]] && continue
    filtered="$filtered $p"
  done
  pids="$(echo $filtered | xargs)"
  if [[ -n "$pids" ]]; then
    echo "[run-c0-verbatim] stopping existing livekit on :7880: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
  if [[ -f "$OUT_DIR/livekit.pid" ]]; then
    kill "$(cat "$OUT_DIR/livekit.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/livekit.pid"
  fi
}

echo "============================================"
echo " M1 C0 VERBATIM (PR #4812 on pin)"
echo " LiveKit pin: $LIVEKIT_TAG ($LIVEKIT_SHA)"
echo " Binary: $LK_BIN"
echo " Config: $LK_CFG (forward_abs_capture_time_verbatim: true)"
echo " Publisher: $PUBLISHER_MODE"
echo " Δ_inject levels: $DELTAS"
echo " Room: $ROOM"
echo "============================================"

mkdir -p "$OUT_DIR" "$ROOT/media"

if [[ ! -x "$LK_BIN" ]]; then
  echo "[run-c0-verbatim] BLOCKER: missing $LK_BIN" >&2
  exit 2
fi
if [[ ! -f "$LK_CFG" ]]; then
  echo "[run-c0-verbatim] BLOCKER: missing $LK_CFG" >&2
  exit 2
fi

stop_existing_livekit
"$LK_BIN" --version 2>&1 | tee "$OUT_DIR/livekit-version-c0-verbatim.txt" || true
"$LK_BIN" --config "$LK_CFG" >"$OUT_DIR/livekit-server-c0-verbatim.log" 2>&1 &
LK_PID=$!
echo "$LK_PID" >"$OUT_DIR/livekit-verbatim.pid"
if ! wait_for_livekit; then
  echo "[run-c0-verbatim] BLOCKER: LiveKit verbatim not ready" >&2
  tail -50 "$OUT_DIR/livekit-server-c0-verbatim.log" || true
  echo '{"schema":"m1-c0-verbatim/v1","verdict":"C0_APPARATUS_FAIL","notes":["LiveKit verbatim not ready"]}' >"$OUT_DIR/c0-verbatim-sanity.json"
  exit 2
fi
# Confirm flag was accepted (config parse) — look for boot without yaml error
if rg -q "unknown field|unmarshal|forward_abs" "$OUT_DIR/livekit-server-c0-verbatim.log"; then
  echo "[run-c0-verbatim] WARNING: config log mentions forward_abs / unmarshal — check log"
  rg -n "unknown field|unmarshal|forward_abs|error" "$OUT_DIR/livekit-server-c0-verbatim.log" | head -20 || true
fi

echo "[run-c0-verbatim] npm install + chromium"
npm install --no-fund --no-audit
npx playwright install chromium

if [[ "$PUBLISHER_MODE" == "pion" ]]; then
  if [[ ! -f "$ROOT/media/c0-video.ivf" ]]; then
    ffmpeg -y -f lavfi -i color=c=red:s=320x240:r=15 -t 45 -c:v libvpx -b:v 200k "$ROOT/media/c0-video.ivf" >/dev/null 2>&1
  fi
  if [[ ! -x "$ROOT/bin/c0-pion-publisher" ]]; then
    echo "[run-c0-verbatim] build pion publisher"
    (cd "$ROOT/pion-publisher" && go mod tidy && go build -o "$ROOT/bin/c0-pion-publisher" .)
  fi
fi

export LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
export LIVEKIT_ROOM="$ROOM"
export C0_PUBLISHER="$PUBLISHER_MODE"
export C0_POLICY=verbatim
export C0_PR_4812_APPLIED=true
export C0_OUT_PREFIX=c0-verbatim
export C0_TRIAL_PREFIX=c0-verbatim-trial
export C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID:-8}"

IFS=',' read -r -a DELTA_ARR <<<"$DELTAS"
TRIAL_FILES=()

for d in "${DELTA_ARR[@]}"; do
  d="$(echo "$d" | tr -d '[:space:]')"
  [[ -z "$d" ]] && continue
  echo "[run-c0-verbatim] === Δ_inject=${d} ms publisher=$PUBLISHER_MODE policy=verbatim ==="
  INJECT_LOG="$OUT_DIR/c0-verbatim-inject-d${d}.jsonl"
  rm -f "$INJECT_LOG" "$OUT_DIR/c0-verbatim-trial-d${d}.json"

  if [[ "$PUBLISHER_MODE" == "pion" ]]; then
    "$ROOT/bin/c0-pion-publisher" \
      -host "$LIVEKIT_URL" -api-key "$LIVEKIT_API_KEY" -api-secret "$LIVEKIT_API_SECRET" \
      -room "$ROOM" -identity "c0-pion-pub-d${d}" -delta-inject-ms "$d" \
      -video "$ROOT/media/c0-video.ivf" -duration 45s -inject-log "$INJECT_LOG" \
      >"$OUT_DIR/c0-verbatim-publisher-d${d}.log" 2>&1 &
    echo $! >"$OUT_DIR/c0-verbatim-pub.pid"
    for i in $(seq 1 40); do
      if [[ -f "$INJECT_LOG" ]] && [[ "$(wc -l <"$INJECT_LOG" | tr -d ' ')" -gt 3 ]]; then break; fi
      sleep 0.5
    done
  fi

  set +e
  SAMPLE_DEFAULT=12000
  if [[ "$PUBLISHER_MODE" == "pion" ]]; then SAMPLE_DEFAULT=16000; fi
  C0_DELTA_MS="$d" C0_SAMPLE_MS="${C0_SAMPLE_MS:-$SAMPLE_DEFAULT}" C0_PUBLISHER="$PUBLISHER_MODE" \
    C0_INJECT_LOG="$INJECT_LOG" C0_ACT_FORCE_EXT_ID="${C0_ACT_FORCE_EXT_ID}" \
    C0_POLICY=verbatim C0_PR_4812_APPLIED=true \
    C0_OUT_PREFIX=c0-verbatim C0_TRIAL_PREFIX=c0-verbatim-trial \
    C0_OUT_JSON="$OUT_DIR/c0-verbatim-sanity.json" \
    node "$ROOT/src/c0-rewrite-sanity.mjs"
  set -e

  if [[ -f "$OUT_DIR/c0-verbatim-trial-d${d}.json" ]]; then
    TRIAL_FILES+=("$OUT_DIR/c0-verbatim-trial-d${d}.json")
  fi

  if [[ -f "$OUT_DIR/c0-verbatim-pub.pid" ]]; then
    kill "$(cat "$OUT_DIR/c0-verbatim-pub.pid")" 2>/dev/null || true
    rm -f "$OUT_DIR/c0-verbatim-pub.pid"
  fi
  sleep 1
done

echo "[run-c0-verbatim] merging trials"
C0_MERGE_OUT="$OUT_DIR/c0-verbatim-sanity.json" C0_POLICY=verbatim C0_PR_4812_APPLIED=true \
  node "$ROOT/scripts/merge-c0-trials.mjs" "${TRIAL_FILES[@]:-}"
if [[ -f "$OUT_DIR/c0-verbatim-sanity.json" ]]; then
  node -e "const j=require('$OUT_DIR/c0-verbatim-sanity.json'); console.log(JSON.stringify({verdict:j.verdict,policy:j.policy,pr_4812_applied:j.pr_4812_applied,publisher_mode:j.publisher_mode,abs_median_bias_ms:j.abs_median_bias_ms,compared_to_tau_b_10ms:j.compared_to_tau_b_10ms,trials:(j.trials||[]).length},null,2))"
fi
exit 0
