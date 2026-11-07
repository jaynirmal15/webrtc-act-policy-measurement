#!/usr/bin/env bash
# REGISTERED mid-session batch per midsession-prereg-addendum.md (7cdb4f9).
# Usage: midsession-reg-run-one.sh <ntp_m80|ntp_p80> <rewrite|verbatim> <run_k>
# ntp_m80 = NTP −80 = CLI SkewMs +80 (gating)
# ntp_p80 = NTP +80 = CLI SkewMs −80 (fast adoption)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; REPO="$(cd "$ROOT/.." && pwd)"
NTP_LABEL=${1:?ntp_m80|ntp_p80}; POL=${2:?rewrite|verbatim}; K=${3:?run}
ONSET_MS="${ONSET_MS:-20000}"
SAMPLE="${C0_SAMPLE_MS:-42000}"
DUR="${PUB_DURATION:-45s}"
OUT_ROOT="$REPO/results/midsession-reg-2026-11-05"
case $NTP_LABEL in
  ntp_m80) SKEW=80;  NTP_SHIFT=-80; CELL="ntp-m80";;  # NTP −80 → gating
  ntp_p80) SKEW=-80; NTP_SHIFT=80;  CELL="ntp-p80";;  # NTP +80 → fast adoption
  *) echo "need ntp_m80|ntp_p80"; exit 2;;
esac
# Same C3 pairing as rep-run-one.sh / deposit
case $POL in
  rewrite)  LKB=livekit-server-dsrpt;          CFG=livekit-dsrpt.yaml;           PolicyName=rewrite_dsrpt_midsession;  PR=false;;
  verbatim) LKB=livekit-server-verbatim-dsrpt; CFG=livekit-verbatim-dsrpt.yaml;  PolicyName=verbatim_dsrpt_midsession; PR=true;;
  *) echo "need rewrite|verbatim"; exit 2;;
esac
TAG="$CELL"
RUN_DIR="$OUT_ROOT/$TAG/$POL/d0/run-$K"
if [[ -e "$RUN_DIR" ]]; then echo "REFUSE: $RUN_DIR exists"; exit 3; fi
mkdir -p "$RUN_DIR"
ROOM="midsess-$CELL-$POL-r$K-$(date +%s)"
cp "$ROOT/$CFG" "$RUN_DIR/livekit-config.yaml"
"$ROOT/bin/$LKB" --version >"$RUN_DIR/livekit-version.txt" 2>&1 || true
{
  echo "{"
  echo "\"registered\":true,\"prereg_addendum\":\"midsession-prereg-addendum.md\","
  echo "\"prereg_commit\":\"7cdb4f905d901b0049e23c7649a9ceb0a8d71d3d\","
  echo "\"cell\":\"$CELL\",\"ntp_label\":\"$NTP_LABEL\",\"ntp_shift_ms\":$NTP_SHIFT,"
  echo "\"sr_ntp_skew_flag_ms\":$SKEW,\"sr_ntp_estimate_perturbation_ms\":$(( -SKEW )),"
  echo "\"policy\":\"$POL\",\"policy_name\":\"$PolicyName\",\"pr_4812_applied\":$PR,"
  echo "\"delta_inject_ms\":0,\"run\":$K,\"sr_ntp_skew_onset_ms\":$ONSET_MS,\"sr_hold_ms\":0,"
  echo "\"livekit_binary\":\"$LKB\",\"livekit_binary_sha256\":\"$(sha256sum "$ROOT/bin/$LKB"|cut -d' ' -f1)\","
  echo "\"publisher_binary_sha256\":\"$(sha256sum "$ROOT/bin/c3-pion-publisher"|cut -d' ' -f1)\","
  echo "\"config\":\"$CFG\",\"act_force_ext_id\":8,\"room\":\"$ROOM\",\"sample_ms\":$SAMPLE,\"duration\":\"$DUR\","
  echo "\"git_sha\":\"$(git -C "$REPO" rev-parse HEAD)\","
  echo "\"started_local\":\"$(date -Iseconds)\""
  echo "}"
} >"$RUN_DIR/config-snapshot.json"
git -C "$REPO" rev-parse HEAD >"$RUN_DIR/GIT_SHA"
echo "REGISTERED" >"$RUN_DIR/REGISTERED"
pkill -f "$ROOT/bin/livekit-server" 2>/dev/null || true
pkill -f "c3-pion-publisher" 2>/dev/null || true
sleep 1
"$ROOT/bin/$LKB" --config "$ROOT/$CFG" >"$RUN_DIR/livekit-server.log" 2>&1 & LKP=$!
for i in $(seq 1 40); do (echo >/dev/tcp/127.0.0.1/7880) >/dev/null 2>&1 && break; sleep 0.5; done
INJ="$RUN_DIR/inject.jsonl"
"$ROOT/bin/c3-pion-publisher" -host ws://127.0.0.1:7880 -api-key devkey -api-secret secret \
  -room "$ROOM" -identity "midsess-pub-d0" -delta-inject-ms 0 \
  -sr-ntp-skew-ms "$SKEW" -sr-ntp-skew-onset-ms "$ONSET_MS" \
  -video-only -video "$ROOT/media/c0-video.ivf" -duration "$DUR" -inject-log "$INJ" \
  >"$RUN_DIR/publisher.log" 2>&1 & PP=$!
for i in $(seq 1 50); do [[ -f "$INJ" && "$(wc -l <"$INJ")" -gt 3 ]] && break; sleep 0.5; done
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret LIVEKIT_ROOM="$ROOM" \
 M1_OUT_DIR="$RUN_DIR" C0_DELTA_MS=0 C0_SAMPLE_MS="$SAMPLE" C0_PUBLISHER=pion C0_INJECT_LOG="$INJ" \
 C0_ACT_FORCE_EXT_ID=8 C0_POLICY="$PolicyName" C0_PR_4812_APPLIED=$PR C0_OUT_PREFIX=run C0_TRIAL_PREFIX=trial \
 C0_OUT_JSON="$RUN_DIR/result.json" C0_PION_IDENTITY_PREFIX=midsess \
 timeout 180 node "$ROOT/src/c0-rewrite-sanity.mjs" >"$RUN_DIR/subscriber.log" 2>&1; RC=$?
kill $PP 2>/dev/null; wait $PP 2>/dev/null; kill $LKP 2>/dev/null; wait $LKP 2>/dev/null
echo "$RC" >"$RUN_DIR/subscriber.rc"
cp -f "$RUN_DIR/inject.meta.json" "$RUN_DIR/onset-meta.json" 2>/dev/null || true
# Classify apparatus failure
node -e "
const fs=require('fs');
let j=null, meta={}, apparatus=false, reason=null;
try { j=JSON.parse(fs.readFileSync('$RUN_DIR/result.json','utf8')); } catch(e) { apparatus=true; reason='no_result_json:'+e.message; }
try { meta=JSON.parse(fs.readFileSync('$RUN_DIR/inject.meta.json','utf8')); } catch(e) {}
const t=j && j.trials && j.trials[0];
if (!apparatus) {
  if (!t) { apparatus=true; reason='no_trial'; }
  else if (!t.captureTimestamp_seen) { apparatus=true; reason='no_captureTimestamp'; }
  else if (!t.metrics || !(t.metrics.paired_n>0)) { apparatus=true; reason='no_pairs'; }
}
const out={
  registered:true, cell:'$CELL', ntp_label:'$NTP_LABEL', ntp_shift_ms:$NTP_SHIFT,
  sr_ntp_skew_flag_ms:$SKEW, policy:'$POL', run:$K, rc:$RC,
  apparatus_failure:apparatus, failure_reason:reason,
  verdict:j&&j.verdict, captureTimestamp_seen:t&&t.captureTimestamp_seen,
  paired_n:t&&t.metrics&&t.metrics.paired_n,
  median_bias_ms_raw:t&&t.metrics&&t.metrics.median_bias_ms,
  first_frame_unix_ms:meta.first_frame_unix_ms||0,
  first_modified_sr_unix_ms:meta.sr_ntp_first_skew_unix_ms||0,
  onset_sr_index:meta.sr_ntp_onset_sr_index||0,
  skewed_count:meta.sr_ntp_skewed_count||0,
  unmodified_count:meta.sr_ntp_unmodified_count||0,
  sr_seen:meta.sr_ntp_sr_seen_count||0,
  onset_delay_ms:meta.sr_ntp_skew_onset_ms||0,
};
if(out.first_frame_unix_ms && out.first_modified_sr_unix_ms){
  out.onset_lag_ms = out.first_modified_sr_unix_ms - out.first_frame_unix_ms;
}
fs.writeFileSync('$RUN_DIR/onset-summary.json', JSON.stringify(out,null,2));
if (apparatus) {
  fs.writeFileSync('$RUN_DIR/APPARATUS_FAILURE', reason+'\n');
}
console.log(JSON.stringify(out));
" 2>&1 | tee -a "$OUT_ROOT/run-index.log"
