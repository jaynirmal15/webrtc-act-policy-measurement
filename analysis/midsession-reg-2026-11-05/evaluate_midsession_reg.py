#!/usr/bin/env python3
"""Registered mid-session evaluation (rtp-match-v1 + four prereg decision rules).

Reads results/midsession-reg-2026-11-05/ run dirs. Onset = first modified SR
(sr_ntp_first_skew_unix_ms). Bias via exact RTP timestamp match within a run
(same key as analysis/rtp-match-v1). Writes REGISTERED-ANALYSIS.json beside this script
when run with --out, or prints summary.

Not part of the preregistered matching procedure for October cells; registered
mid-session analysis only.
"""
import argparse, collections, json, sys
from pathlib import Path
import numpy as np

NTP = 2208988800000
Y = 365 * 24 * 3600 * 1000

def conv(ct, w):
    if ct is None: return None
    if ct > w + Y: return ct - NTP
    if abs(ct - w) < Y: return ct
    return ct - NTP

def ik(e, *keys, default=None):
    for k in keys:
        if k in e: return e[k]
    return default

def med(xs):
    return float(np.median(xs)) if len(xs) else None

def analyze_run(rd: Path):
    meta = json.loads((rd/'inject.meta.json').read_text())
    cfg = json.loads((rd/'config-snapshot.json').read_text())
    t = json.load(open(rd/'result.json'))['trials'][0]
    inj = [json.loads(l) for l in open(rd/'inject.jsonl')]
    inj = [e for e in inj if ik(e,'track_kind','trackKind')=='video']
    byrtp = {}
    for e in inj:
        byrtp.setdefault(ik(e,'rtp_timestamp','rtpTimestamp'), []).append(e)
    first_mod = meta['sr_ntp_first_skew_unix_ms']
    first_frame = meta['first_frame_unix_ms']
    rows = []
    for s in t['raw_samples']:
        if s.get('trackKind')!='video' or not s.get('hasCaptureTimestamp'): continue
        tc = conv(s['captureTimestamp_raw'], s['t_playout_wall_ms'])
        if tc is None: continue
        m = byrtp.get(s['rtpTimestamp'], [])
        if len(m)!=1: continue
        e = m[0]
        bias = ik(e,'t_inject_wall_ms') - ik(e,'delta_inject_ms', default=0) - tc
        rows.append(dict(t_from_onset=s['t_playout_wall_ms']-first_mod, bias=bias,
                         playout=s['t_playout_wall_ms'], rtp=s['rtpTimestamp']))
    rows.sort(key=lambda r: r['t_from_onset'])
    pre = [r['bias'] for r in rows if r['t_from_onset']<0]
    w0_8 = [r['bias'] for r in rows if 0<=r['t_from_onset']<8000]
    w3_8 = [r['bias'] for r in rows if 3000<=r['t_from_onset']<8000]
    w15 = [r['bias'] for r in rows if r['t_from_onset']>=15000]
    w_oe = [r['bias'] for r in rows if r['t_from_onset']>=0]
    bins = collections.defaultdict(list)
    for r in rows: bins[int(r['t_from_onset']//1000)].append(r['bias'])
    conv_t=None
    for r in rows:
        if r['t_from_onset']<0: continue
        if abs(r['bias'])>=40:
            conv_t=r['t_from_onset']; break
    pre_m = med(pre) or 0
    move_bin=None
    for k in sorted(bins):
        if k<0: continue
        if abs(med(bins[k])-pre_m)>40:
            move_bin=k; break
    return dict(
        cell=cfg['cell'], policy=cfg['policy'], run=cfg['run'],
        ntp_shift_ms=cfg['ntp_shift_ms'], skew_flag_ms=cfg['sr_ntp_skew_flag_ms'],
        onset_lag_ms=first_mod-first_frame, onset_sr_index=meta['sr_ntp_onset_sr_index'],
        first_frame_unix_ms=first_frame, first_modified_sr_unix_ms=first_mod,
        n_obs=len(rows), pre_n=len(pre), pre_med=med(pre),
        w0_8_n=len(w0_8), w0_8_med=med(w0_8),
        w0_8_delta=None if med(w0_8) is None or med(pre) is None else med(w0_8)-med(pre),
        w3_8_n=len(w3_8), w3_8_med=med(w3_8),
        w15_n=len(w15), w15_med=med(w15), w_onset_end_med=med(w_oe),
        convergence_time_ms=conv_t, first_move_bin_s=move_bin, obs=rows,
    )

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--results', default='/workspace/paper3/results/midsession-reg-2026-11-05')
    ap.add_argument('--out', default='')
    args=ap.parse_args()
    ROOT=Path(args.results)
    runs=[]
    for rd in sorted(ROOT.glob('ntp-*/**/d0/run-*')):
        if not (rd/'result.json').exists(): continue
        if (rd/'APPARATUS_FAILURE').exists(): continue
        runs.append(analyze_run(rd))
    def pool(cell, pol, pred):
        xs=[]
        for r in runs:
            if r['cell']!=cell or r['policy']!=pol: continue
            for o in r['obs']:
                if pred(o): xs.append(o['bias'])
        return xs
    pre_m=med(pool('ntp-m80','rewrite', lambda o: o['t_from_onset']<0))
    w08_m=med(pool('ntp-m80','rewrite', lambda o: 0<=o['t_from_onset']<8000))
    w15_m=med(pool('ntp-m80','rewrite', lambda o: o['t_from_onset']>=15000))
    r1=abs(w08_m-pre_m)<=5 and w15_m<-40
    w38_m=med(pool('ntp-p80','rewrite', lambda o: 3000<=o['t_from_onset']<8000))
    r2=w38_m is not None and w38_m>40
    conv_m=[r['convergence_time_ms'] for r in runs if r['cell']=='ntp-m80' and r['policy']=='rewrite']
    conv_p=[r['convergence_time_ms'] for r in runs if r['cell']=='ntp-p80' and r['policy']=='rewrite']
    med_m, med_p = med(conv_m), med(conv_p)
    ratio=max(med_m,med_p)/min(med_m,med_p)
    r3=ratio>=5
    r4A=True; r4B=True
    for cell in ['ntp-m80','ntp-p80']:
        for r in [x for x in runs if x['cell']==cell and x['policy']=='verbatim']:
            pre=r['pre_med']; post=r['w_onset_end_med']
            if pre is None or post is None or abs(post-pre)>2: r4A=False
            for v in (r['w0_8_med'], r['w3_8_med'], r['w15_med']):
                if v is not None and abs(v-pre)>2: r4B=False
    out=dict(
        prereg_public_commit='b814592873b2c8b87f592364c23dda7f027336bb',
        prereg_url='https://github.com/jaynirmal15/webrtc-act-policy-measurement/blob/b814592873b2c8b87f592364c23dda7f027336bb/midsession-prereg-addendum.md',
        attempts=20, retained=len(runs), apparatus_failures=20-len(runs),
        rule1=dict(fire=r1, pooled_pre=pre_m, pooled_w08=w08_m, pooled_w15=w15_m),
        rule2=dict(fire=r2, pooled_w38=w38_m),
        rule3=dict(fire=r3, med_conv_m80=med_m, med_conv_p80=med_p, ratio=ratio,
                   conv_m80=conv_m, conv_p80=conv_p),
        rule4=dict(holds_interpretation_A=r4A, holds_interpretation_B=r4B,
                   ambiguity='throughout undefined; A=pre vs [onset,end]; B=max over rule1-2 windows'),
        runs=[{k:v for k,v in r.items() if k!='obs'} for r in runs],
    )
    text=json.dumps(out, indent=2)
    if args.out:
        Path(args.out).write_text(text); print('wrote', args.out)
    else:
        print(text)

if __name__=='__main__':
    main()
