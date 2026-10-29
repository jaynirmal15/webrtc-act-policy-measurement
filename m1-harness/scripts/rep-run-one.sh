#!/usr/bin/env bash
# Replication 2026-10-15: ONE independent run = fresh SFU + publisher + subscriber.
# Usage: rep-run-one.sh <cell:c0|c2|c3> <policy:rewrite|verbatim> <delta_ms> <run_k> [perturb_ms for c3: m80|p80]
# Adapted from run-c0*.sh / run-c2*.sh / run-c3-skew-delay*.sh. Prereg FROZEN.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; REPO="$(cd "$ROOT/.." && pwd)"
CELL=$1; POL=$2; D=$3; K=$4; PERT=${5:-}
TAG="$CELL"; [[ -n "$PERT" ]] && TAG="$CELL-$PERT"
[[ "$CELL" == "c0dsrpt" ]] && TAG="c0-dsrpt"
RUN_DIR="$REPO/results/${REP_SET:-rep-2026-10-15b}/$TAG/$POL/d$D/run-$K"
if [[ -e "$RUN_DIR" ]]; then echo "REFUSE: $RUN_DIR exists (never overwrite)"; exit 3; fi
mkdir -p "$RUN_DIR"
SKEW=0; HOLD=0; SCRIPT=c0-rewrite-sanity.mjs; SAMPLE=16000; DUR=45s
case "$CELL/$POL" in
  c0/rewrite)  LKB=livekit-server;               CFG=livekit.yaml;                 PolicyName=stock_rewrite; PR=false;;
  c0/verbatim) LKB=livekit-server-verbatim;      CFG=livekit-verbatim.yaml;        PolicyName=verbatim; PR=true;;
  c0dsrpt/rewrite)  LKB=livekit-server-dsrpt;         CFG=livekit-dsrpt.yaml;           PolicyName=rewrite_dsrpt; PR=false;;
  c0dsrpt/verbatim) LKB=livekit-server-verbatim-dsrpt; CFG=livekit-verbatim-dsrpt.yaml; PolicyName=verbatim_dsrpt; PR=true;;
  c2/rewrite)  LKB=livekit-server;               CFG=livekit.yaml;                 PolicyName=stock_rewrite; PR=false;;
  c2/verbatim) LKB=livekit-server-verbatim;      CFG=livekit-verbatim.yaml;        PolicyName=verbatim; PR=true;;
  c3/rewrite)  LKB=livekit-server-dsrpt;         CFG=livekit-dsrpt.yaml;           PolicyName=rewrite_dsrpt_skew; PR=false;;
  c3/verbatim) LKB=livekit-server-verbatim-dsrpt; CFG=livekit-verbatim-dsrpt.yaml; PolicyName=verbatim_dsrpt_skew; PR=true;;
  *) echo bad; exit 2;;
esac
if [[ $CELL == c2 ]]; then HOLD=15000; SCRIPT=c2-delayed-sr.mjs; SAMPLE=23000; DUR=55s; fi
if [[ $CELL == c3 ]]; then case $PERT in m80) SKEW=80;; p80) SKEW=-80;; *) echo "need m80|p80"; exit 2;; esac; fi
ROOM="rep-$TAG-$POL-d$D-r$K-$(date +%s)"
# config snapshot + provenance
cp "$ROOT/$CFG" "$RUN_DIR/livekit-config.yaml"
"$ROOT/bin/$LKB" --version >"$RUN_DIR/livekit-version.txt" 2>&1 || true
{ echo "{"; echo "\"cell\":\"$CELL\",\"policy\":\"$POL\",\"policy_name\":\"$PolicyName\",\"pr_4812_applied\":$PR,";
  echo "\"delta_inject_ms\":$D,\"run\":$K,\"sr_ntp_skew_flag_ms\":$SKEW,\"sr_ntp_estimate_perturbation_ms\":$(( -SKEW )),";
  echo "\"sr_hold_ms\":$HOLD,\"livekit_binary\":\"$LKB\",\"livekit_binary_sha256\":\"$(sha256sum "$ROOT/bin/$LKB"|cut -d' ' -f1)\",";
  echo "\"publisher_binary_sha256\":\"$(sha256sum "$ROOT/bin/c3-pion-publisher"|cut -d' ' -f1)\",";
  echo "\"config\":\"$CFG\",\"act_force_ext_id\":8,\"room\":\"$ROOM\",\"sample_ms\":$SAMPLE,";
  echo "\"git_sha\":\"$(git -C "$REPO" rev-parse HEAD)\",\"git_dirty\":$( [[ -n "$(git -C "$REPO" status --porcelain -- m1-harness/src m1-harness/pion-publisher m1-harness/scripts)" ]] && echo true || echo false),";
  echo "\"started_local\":\"$(date -Iseconds)\""; echo "}"; } >"$RUN_DIR/config-snapshot.json"
git -C "$REPO" rev-parse HEAD >"$RUN_DIR/GIT_SHA"
# kill anything on 7880
pkill -f "$ROOT/bin/livekit-server" 2>/dev/null; pkill -f "c3-pion-publisher" 2>/dev/null; sleep 1
"$ROOT/bin/$LKB" --config "$ROOT/$CFG" >"$RUN_DIR/livekit-server.log" 2>&1 & LKP=$!
for i in $(seq 1 40); do (echo >/dev/tcp/127.0.0.1/7880) >/dev/null 2>&1 && break; sleep 0.5; done
INJ="$RUN_DIR/inject.jsonl"
"$ROOT/bin/c3-pion-publisher" -host ws://127.0.0.1:7880 -api-key devkey -api-secret secret \
  -room "$ROOM" -identity "$CELL-pion-pub-d$D" -delta-inject-ms "$D" -sr-hold-ms "$HOLD" -sr-ntp-skew-ms "$SKEW" \
  -video-only -video "$ROOT/media/c0-video.ivf" -duration "$DUR" -inject-log "$INJ" >"$RUN_DIR/publisher.log" 2>&1 & PP=$!
for i in $(seq 1 50); do [[ -f "$INJ" && "$(wc -l <"$INJ")" -gt 3 ]] && break; sleep 0.5; done
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret LIVEKIT_ROOM="$ROOM" \
 M1_OUT_DIR="$RUN_DIR" C0_DELTA_MS="$D" C0_SAMPLE_MS="$SAMPLE" C0_PUBLISHER=pion C0_INJECT_LOG="$INJ" \
 C0_ACT_FORCE_EXT_ID=8 C0_POLICY="$PolicyName" C0_PR_4812_APPLIED=$PR C0_OUT_PREFIX=run C0_TRIAL_PREFIX=trial \
 C0_OUT_JSON="$RUN_DIR/result.json" C0_PION_IDENTITY_PREFIX="$CELL-pion" \
 C2_SR_HOLD_MS="$HOLD" C2_EARLY_WINDOW_MS="$HOLD" C2_CELL_ID=$( [[ $POL == verbatim ]] && echo C4 || echo C2 ) \
 timeout 180 node "$ROOT/src/$SCRIPT" >"$RUN_DIR/subscriber.log" 2>&1; RC=$?
kill $PP 2>/dev/null; wait $PP 2>/dev/null; kill $LKP 2>/dev/null; wait $LKP 2>/dev/null
echo "$RC" >"$RUN_DIR/subscriber.rc"
node -e "const j=require('$RUN_DIR/result.json');const t=j.trials[0];console.log('$TAG/$POL/d$D/run-$K rc=$RC',j.verdict,'ct_seen',t.captureTimestamp_seen,'paired',t.metrics&&t.metrics.paired_n,'med',t.metrics&&t.metrics.median_bias_ms)" 2>&1 | tee -a "$REPO/results/${REP_SET:-rep-2026-10-15b}/run-index.log"
