#!/usr/bin/env bash
# C0-DSRPT confound-control batch. Prereg: c0-dsrpt-prereg-addendum.md (committed BEFORE runs).
# Strictly sequential, flock-guarded. 5 runs × 2 policies × 2 Δ = 20 valid runs.
exec 9>/tmp/m1-rep-c0-dsrpt.lock; flock -n 9 || { echo "another c0-dsrpt batch running"; exit 1; }
cd /workspace/paper3
export REP_SET=rep-2026-10-15-c0-dsrpt
RS=results/$REP_SET
mkdir -p "$RS/_failed"
R=m1-harness/scripts/rep-run-one.sh
START_TS=$(date -Iseconds)
echo "BATCH_START $START_TS" | tee -a "$RS/run-index.log"
valid(){ node -e "const j=require('./$1/result.json');const t=j.trials[0];process.exit(t.captureTimestamp_seen&&t.metrics&&t.metrics.paired_n>0?0:1)" 2>/dev/null; }
for pol in rewrite verbatim; do
  for d in 0 50; do
    k=1; tries=0
    while (( k<=5 && tries<9 )); do
      tries=$((tries+1))
      dir=$RS/c0-dsrpt/$pol/d$d/run-$k
      echo "=== START c0-dsrpt/$pol/d$d/run-$k try=$tries $(date -Iseconds) ===" | tee -a "$RS/run-index.log"
      T0=$(date +%s)
      $R c0dsrpt $pol $d $k
      T1=$(date +%s)
      echo "=== ELAPSED $((T1-T0))s c0-dsrpt/$pol/d$d/run-$k ===" | tee -a "$RS/run-index.log"
      if valid "$dir"; then
        k=$((k+1))
      else
        if [[ -d "$dir" ]]; then
          mv "$dir" "$RS/_failed/c0-dsrpt-$pol-d$d-run-$k-try$tries"
        fi
        echo "FAILED c0-dsrpt/$pol/d$d run-$k try $tries" | tee -a "$RS/run-index.log"
      fi
    done
    if (( k<=5 )); then
      echo "BLOCKER: could not collect 5 valid runs for c0-dsrpt/$pol/d$d (got $((k-1)))" | tee -a "$RS/run-index.log"
      echo BATCH_INCOMPLETE
      exit 2
    fi
  done
done
END_TS=$(date -Iseconds)
echo "BATCH_DONE start=$START_TS end=$END_TS" | tee -a "$RS/run-index.log"
