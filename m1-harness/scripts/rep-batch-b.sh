#!/usr/bin/env bash
# Post-wipe restart batch. Strictly sequential, flock-guarded. Calls backup hook after each cell.
exec 9>/tmp/m1-rep-batch.lock; flock -n 9 || { echo "another batch running"; exit 1; }
cd /workspace/paper3; export REP_SET=rep-2026-10-15b; RS=results/$REP_SET; mkdir -p $RS/_failed
R=m1-harness/scripts/rep-run-one.sh
valid(){ node -e "const j=require('./$1/result.json');const t=j.trials[0];process.exit(t.captureTimestamp_seen&&t.metrics&&t.metrics.paired_n>0?0:1)" 2>/dev/null; }
for cell in c3m80 c3p80 c2 c0; do
  case $cell in c3m80) t=c3-m80; ex="c3";a=m80;; c3p80) t=c3-p80; ex=c3;a=p80;; *) t=$cell; ex=$cell;a="";; esac
  for pol in rewrite verbatim; do for d in 0 50; do
    k=1; tries=0
    while (( k<=5 && tries<9 )); do
      tries=$((tries+1)); dir=$RS/$t/$pol/d$d/run-$k
      $R $ex $pol $d $k $a
      if valid $dir || [[ $cell == c2 && -f $dir/result.json ]]; then k=$((k+1)); else mv $dir $RS/_failed/$t-$pol-d$d-run-$k-try$tries; echo "FAILED $t/$pol/d$d run-$k try $tries" | tee -a $RS/run-index.log; fi
    done
  done; done
  git add -A results m1-harness/scripts && git commit -qm "Replication 15b: cell $t done" ; echo "CELL_DONE $t $(date +%T)"
  touch /tmp/cell-done-$t
done
echo BATCH_DONE
