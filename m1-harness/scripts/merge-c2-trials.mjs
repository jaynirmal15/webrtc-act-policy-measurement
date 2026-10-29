#!/usr/bin/env node
/** Merge C2/C4 delayed-SR trials + rewrite-vs-verbatim comparison. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'out');
const files = process.argv.slice(2).filter(Boolean);
const outPath = process.env.C2_MERGE_OUT || join(OUT_DIR, 'c2-rewrite-delayed-sr.json');
const policy = process.env.C2_POLICY || 'stock_rewrite';

function load(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

if (!files.length) {
  console.error('usage: merge-c2-trials.mjs trial1.json ...');
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
    sr_hold_ms: j.sr_hold_ms ?? t.sr_hold_ms,
    early_window_ms: j.early_window_ms ?? t.early_window_ms,
    captureTimestamp_seen: t.captureTimestamp_seen ?? j.captureTimestamp_seen,
    time_to_first_captureTimestamp_ms:
      j.time_to_first_captureTimestamp_ms ?? t.ct_timeline?.time_to_first_ct_ms ?? null,
    fraction_ct_null_early: j.fraction_ct_null_early ?? t.ct_timeline?.fraction_ct_null_early ?? null,
    ct_timeline: t.ct_timeline || j.ct_timeline || null,
    bias_after_sr: t.bias_after_sr || j.bias_after_sr || null,
    median_bias_ms: j.median_bias_ms ?? t.metrics?.median_bias_ms,
    abs_median_bias_ms:
      t.bias_after_sr?.abs_median_bias_ms ?? j.abs_median_bias_ms ?? t.metrics?.abs_median_bias_ms,
    paired_n: t.bias_after_sr?.paired_n ?? t.metrics?.paired_n,
    publisher_sr_meta: t.publisher_sr_meta || j.publisher_sr_meta || null,
    compared_to_tau_b_10ms:
      t.bias_after_sr?.compared_to_tau_b_10ms ?? j.compared_to_tau_b_10ms ?? t.metrics?.compared_to_tau_b_10ms,
    verdict: j.verdict,
  });
}

const anyCt = trials.some((t) => t.captureTimestamp_seen);
const anyFail = trials.every((t) => String(t.verdict || '').includes('APPARATUS'));
let verdict = 'C2_INCONCLUSIVE';
if (anyFail && !anyCt) verdict = 'C2_APPARATUS_FAIL';
else if (trials.some((t) => String(t.verdict || '').includes('BIAS_EXCEEDS'))) verdict = 'C2_BIAS_EXCEEDS_TAU_B';
else if (trials.every((t) => String(t.verdict || '').includes('BIAS_WITHIN') || String(t.verdict || '').includes('CT_SEEN')))
  verdict = 'C2_OK_TIMELINE_MEASURED';
else if (anyCt) verdict = 'C2_OK_TIMELINE_MEASURED';

const merged = {
  schema: 'm1-c2-delayed-sr-merged/v1',
  policy,
  epsilon_ms: 40,
  tau_b_ms: 10,
  sr_delay_method: 'pion_rtcp_sender_report_hold',
  trials,
  verdict,
  finished_at: new Date().toISOString(),
};
writeFileSync(outPath, JSON.stringify(merged, null, 2));
console.log(JSON.stringify({ outPath, verdict, n: trials.length, anyCt }, null, 2));

const rw = join(OUT_DIR, 'c2-rewrite-delayed-sr.json');
const vb = join(OUT_DIR, 'c2-verbatim-delayed-sr.json');
if (existsSync(rw) && existsSync(vb) && (outPath === rw || outPath === vb)) {
  try {
    const a = load(rw);
    const b = load(vb);
    const rows = [];
    for (const tw of a.trials || []) {
      const tv = (b.trials || []).find((x) => x.delta_inject_ms === tw.delta_inject_ms);
      rows.push({
        delta_inject_ms: tw.delta_inject_ms,
        rewrite: {
          ttf_ct_ms: tw.time_to_first_captureTimestamp_ms,
          frac_ct_null_early: tw.fraction_ct_null_early,
          abs_median_bias_after_sr_ms: tw.abs_median_bias_ms,
          compared_to_tau_b: tw.compared_to_tau_b_10ms,
        },
        verbatim: tv
          ? {
              ttf_ct_ms: tv.time_to_first_captureTimestamp_ms,
              frac_ct_null_early: tv.fraction_ct_null_early,
              abs_median_bias_after_sr_ms: tv.abs_median_bias_ms,
              compared_to_tau_b: tv.compared_to_tau_b_10ms,
            }
          : null,
        divergence:
          tw.time_to_first_captureTimestamp_ms != null && tv?.time_to_first_captureTimestamp_ms != null
            ? {
                ttf_delta_ms: tw.time_to_first_captureTimestamp_ms - tv.time_to_first_captureTimestamp_ms,
                rewrite_later_ct:
                  tw.time_to_first_captureTimestamp_ms > tv.time_to_first_captureTimestamp_ms + 500,
              }
            : null,
      });
    }
    const tradeoff_lights =
      rows.some((r) => r.divergence?.rewrite_later_ct) ||
      rows.some((r) => r.rewrite?.compared_to_tau_b === false);
    const cmp = {
      schema: 'm1-c2-rewrite-vs-verbatim/v1',
      epsilon_ms: 40,
      tau_b_ms: 10,
      sr_hold_ms: (a.trials || [])[0]?.sr_hold_ms ?? null,
      sr_delay_method: 'pion_rtcp_sender_report_hold',
      rows,
      tradeoff_ct_timeline_divergence: tradeoff_lights,
      rewrite: a,
      verbatim: b,
      finished_at: new Date().toISOString(),
    };
    const cmpPath = join(OUT_DIR, 'c2-rewrite-vs-verbatim.json');
    writeFileSync(cmpPath, JSON.stringify(cmp, null, 2));
    console.log('wrote comparison', cmpPath, 'tradeoff_ct_timeline_divergence=', tradeoff_lights);
  } catch (e) {
    console.warn('comparison skip', e.message);
  }
}
