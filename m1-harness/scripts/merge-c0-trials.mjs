#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = process.env.C0_MERGE_OUT
  ? (process.env.C0_MERGE_OUT.startsWith('/') ? process.env.C0_MERGE_OUT : join(ROOT, process.env.C0_MERGE_OUT))
  : join(ROOT, 'out', 'c0-rewrite-sanity.json');
const TAU_B = 10;
const POLICY = (process.env.C0_POLICY || '').toLowerCase();
const PR_4812 = process.env.C0_PR_4812_APPLIED;
const files = process.argv.slice(2).filter((f) => f && existsSync(f));

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

if (!files.length) {
  // try discover
  for (const d of [0, 50, 100]) {
    const f = join(ROOT, 'out', `c0-trial-d${d}.json`);
    if (existsSync(f)) files.push(f);
  }
}

if (!files.length) {
  console.error('no trial files to merge');
  process.exit(2);
}

const docs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const trials = docs.flatMap((d) => d.trials || []);
const allBias = trials.flatMap((t) => t.metrics?.biases_ms || []);
const medB = median(allBias);
const meanB = mean(allBias);
const absMed = medB == null ? null : Math.abs(medB);

function decide(trials) {
  const usable = trials.filter((t) => t.metrics?.paired_n > 0);
  if (!usable.length) {
    const anyAct = trials.some((t) => t.captureTimestamp_seen);
    return anyAct ? 'C0_INCONCLUSIVE' : 'C0_APPARATUS_FAIL';
  }
  const primary = usable.find((t) => t.delta_inject_ms > 0) || usable[usable.length - 1];
  const a = primary.metrics.abs_median_bias_ms;
  if (a == null) return 'C0_INCONCLUSIVE';
  return a <= TAU_B ? 'C0_BIAS_WITHIN_TAU_B' : 'C0_BIAS_EXCEEDS_TAU_B';
}

const base = docs[docs.length - 1];
const merged = {
  ...base,
  schema: 'm1-c0-rewrite-sanity/v1',
  finished_at: new Date().toISOString(),
  delta_inject_ms_levels: [...new Set(trials.map((t) => t.delta_inject_ms))],
  trials,
  median_bias_ms: medB,
  mean_bias_ms: meanB,
  abs_median_bias_ms: absMed,
  compared_to_tau_b_10ms: absMed == null ? null : absMed <= TAU_B,
  verdict: decide(trials),
  merged_from: files,
  interpretation:
    POLICY === 'verbatim'
      ? 'C0-style merged trials under verbatim ACT (PR #4812 flag). |bias| vs τ_b=10ms is the observability check for this policy.'
      : 'C0 is a sanity / apparatus cell on stock rewrite only. Success means the metrics pipeline works and bias is honestly measured; |bias|≤τ_b=10ms is NOT required under rewrite (SFU rewrite may destroy inject correlation). τ_b remains the later policy decision threshold.',
};
if (POLICY) merged.policy = POLICY;
if (PR_4812 != null && PR_4812 !== '') merged.pr_4812_applied = String(PR_4812).toLowerCase() === 'true';

writeFileSync(OUT, JSON.stringify(merged, null, 2));
console.log(`merged ${files.length} docs → ${OUT} verdict=${merged.verdict}`);
