#!/usr/bin/env node
/** Merge C1/C3 A/V sync trials + optional rewrite-vs-verbatim comparison. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'out');
const files = process.argv.slice(2).filter(Boolean);
const outPath = process.env.C1_MERGE_OUT || join(OUT_DIR, 'c1-rewrite-av-sync.json');
const policy = process.env.C1_POLICY || 'stock_rewrite';

function load(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

if (!files.length) {
  console.error('usage: merge-c1-trials.mjs trial1.json ...');
  process.exit(2);
}

const trials = [];
for (const f of files) {
  if (!existsSync(f)) {
    console.warn('missing', f);
    continue;
  }
  const j = load(f);
  const t = (j.trials && j.trials[0]) || j;
  trials.push({
    source: f,
    cell_id: j.cell_id || t.cell_id,
    policy: j.policy || policy,
    delta_inject_ms: j.delta_inject_ms ?? t.delta_inject_ms,
    av_offset_ms: j.av_offset_ms ?? t.av_offset_ms,
    stagger_start_ms: j.stagger_start_ms ?? t.stagger_start_ms,
    captureTimestamp_seen: t.captureTimestamp_seen,
    captureTimestamp_audio_seen: t.captureTimestamp_audio_seen,
    captureTimestamp_video_seen: t.captureTimestamp_video_seen,
    ct_by_kind: t.ct_by_kind,
    inject_by_kind: t.inject_by_kind,
    median_bias_ms: j.median_bias_ms ?? t.metrics?.median_bias_ms,
    abs_median_bias_ms: j.abs_median_bias_ms ?? t.metrics?.abs_median_bias_ms,
    paired_n: t.metrics?.paired_n,
    sync_err_ms: j.sync_err_ms ?? t.metrics?.sync_err_ms,
    compared_to_tau_b_10ms: j.compared_to_tau_b_10ms ?? t.metrics?.compared_to_tau_b_10ms,
    compared_to_eps_40ms: j.compared_to_eps_40ms ?? t.metrics?.sync_err_ms?.compared_to_eps_40ms,
    verdict: j.verdict,
  });
}

const anyAudio = trials.some((t) => t.captureTimestamp_audio_seen && t.sync_err_ms?.available);
const anyFail = trials.every((t) => String(t.verdict || '').includes('APPARATUS'));
let verdict = 'C1_INCONCLUSIVE';
if (!anyAudio) verdict = 'C1_APPARATUS_PARTIAL_NO_AUDIO_ACT';
else if (trials.some((t) => t.verdict === 'C1_SYNC_EXCEEDS_EPS')) verdict = 'C1_SYNC_EXCEEDS_EPS';
else if (trials.every((t) => t.verdict === 'C1_SYNC_WITHIN_EPS')) verdict = 'C1_SYNC_WITHIN_EPS';
else if (anyFail) verdict = 'C1_APPARATUS_FAIL';

const merged = {
  schema: 'm1-c1-av-sync-merged/v1',
  policy,
  epsilon_ms: 40,
  tau_b_ms: 10,
  trials,
  verdict,
  finished_at: new Date().toISOString(),
};
writeFileSync(outPath, JSON.stringify(merged, null, 2));
console.log(JSON.stringify({ outPath, verdict, n: trials.length, anyAudio }, null, 2));

// If both rewrite and verbatim merged files exist, write comparison
const rw = join(OUT_DIR, 'c1-rewrite-av-sync.json');
const vb = join(OUT_DIR, 'c1-verbatim-av-sync.json');
if (existsSync(rw) && existsSync(vb) && (outPath === rw || outPath === vb)) {
  try {
    const a = load(rw);
    const b = load(vb);
    const cmp = {
      schema: 'm1-c1-rewrite-vs-verbatim/v1',
      epsilon_ms: 40,
      tau_b_ms: 10,
      rewrite: a,
      verbatim: b,
      finished_at: new Date().toISOString(),
    };
    const cmpPath = join(OUT_DIR, 'c1-rewrite-vs-verbatim.json');
    writeFileSync(cmpPath, JSON.stringify(cmp, null, 2));
    console.log('wrote comparison', cmpPath);
  } catch (e) {
    console.warn('comparison skip', e.message);
  }
}
