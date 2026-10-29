#!/usr/bin/env python3
"""rtp-match-v1: POST-REVIEW analysis correction on existing rep-2026-10-15b records.
Not part of the preregistered matching procedure. Reads raw records read-only; writes only here.
Key = exact RTP timestamp within a run (single video SSRC per run; subscriber SSRC not recorded).
No ACT, wall-clock proximity or expected sign is used to select/disambiguate the key."""
import json,glob,os,collections,sys
import numpy as np
R=os.environ.get('RTP_MATCH_INPUT_DIR', sys.argv[1] if len(sys.argv)>1 else '/workspace/paper3/results/rep-2026-10-15b'); OUT=os.path.dirname(os.path.abspath(__file__))
NTP=2208988800000; Y=365*24*3600*1000; SEED=20261015; B=10000; TAU=10
def conv(ct,w):  # verbatim port of captureTsToUnixMs (src/c0-rewrite-sanity.mjs / c2-delayed-sr.mjs)
    if ct is None: return None,'null'
    if ct>w+Y: return ct-NTP,'A:ct>wall+Y -> ct-NTP'
    if abs(ct-w)<Y: return ct,'B:|ct-wall|<Y -> ct'
    return ct-NTP,'C:fallback -> ct-NTP'
def boot(meds):
    rng=np.random.default_rng(SEED);a=np.array(meds,float)
    m=np.median(a[rng.integers(0,len(a),(B,len(a)))],axis=1)
    return [float(np.percentile(m,2.5)),float(np.percentile(m,97.5))]
def stats(per_run,pooled):
    p=np.array(pooled,float);meds=[float(np.median(v)) for v in per_run]
    return dict(per_run_medians=meds,per_run_n=[len(v) for v in per_run],pooled_median=float(np.median(p)),pooled_n=len(p),
      IQR=[float(np.percentile(p,25)),float(np.percentile(p,75))],p5_p95=[float(np.percentile(p,5)),float(np.percentile(p,95))],
      min_max=[float(p.min()),float(p.max())],boot95_CI_median_of_run_medians=boot(meds))
runs_out=[];cond=collections.defaultdict(lambda:{'old':[],'new':[],'lat_new':[],'lat_old':[]});examples={}
branches=collections.Counter()
for rd in sorted(glob.glob(f'{R}/*/*/d*/run-*')):
    cell,pol,d,run=rd[len(R)+1:].split('/')
    if cell.startswith('_'): continue
    t=json.load(open(rd+'/result.json'))['trials'][0]
    inj=[json.loads(l) for l in open(rd+'/inject.jsonl')]; inj=[e for e in inj if e.get('track_kind')=='video']
    for i,e in enumerate(inj): e['idx']=i
    ssrcs=sorted({e['ssrc'] for e in inj})
    keyc=collections.Counter(e['rtp_timestamp'] for e in inj)
    byrtp={k:[e for e in inj if e['rtp_timestamp']==k] for k in keyc}
    rt=[e['rtp_timestamp'] for e in inj]; incs=collections.Counter((b-a)%2**32 for a,b in zip(rt,rt[1:]))
    wraps=sum(1 for a,b in zip(rt,rt[1:]) if b<a)
    cap=[e['capture_unix_ms'] for e in inj]; wall=[e['t_inject_wall_ms'] for e in inj]
    dcap=np.diff(cap); dwall=np.diff(wall)
    stored=t['metrics']['biases_ms']
    old=[];new=[];eligible=0;unmatched=0;ambig=0;obs_per_frame=collections.Counter();shift=collections.Counter();lat_n=[];lat_o=[]
    tracks={s['trackSid'] for s in t['raw_samples'] if s['trackKind']=='video'}
    first=None; dedup=[]
    for s in t['raw_samples']:
        if not s.get('hasCaptureTimestamp'): continue
        tc,br=conv(s['captureTimestamp_raw'],s['t_playout_wall_ms']); branches[(cell,pol,br)]+=1
        if tc is None: continue
        eligible+=1
        o=min(inj,key=lambda e:abs(e['capture_unix_ms']-tc))   # superseded matcher, reproduced
        bo=o['t_inject_wall_ms']-o['delta_inject_ms']-tc; old.append(bo)
        m=byrtp.get(s['rtpTimestamp'],[])
        if not m: unmatched+=1; continue
        if len(m)>1: ambig+=1; continue
        e=m[0]; bn=e['t_inject_wall_ms']-e['delta_inject_ms']-tc; new.append(bn)
        if e['idx'] not in obs_per_frame: dedup.append(bn)
        obs_per_frame[e['idx']]+=1; shift[e['idx']-o['idx']]+=1
        lat_n.append(s['t_playout_wall_ms']-e['t_inject_wall_ms']); lat_o.append(s['t_playout_wall_ms']-o['t_inject_wall_ms'])
        if first is None and e['idx']!=o['idx']:
            first=dict(run=f'{cell}/{pol}/{d}/{run}',sample_source=s['source_mark'],t_playout_wall_ms=s['t_playout_wall_ms'],
              sub_rtpTimestamp=s['rtpTimestamp'],sub_captureTimestamp_raw=s['captureTimestamp_raw'],ACT_unix_ms=tc,conv_branch=br,
              rtp_record=dict(line=e['idx']+1,rtp=e['rtp_timestamp'],t_inject_wall_ms=e['t_inject_wall_ms'],capture_unix_ms=e['capture_unix_ms'],bias=bn),
              old_record=dict(line=o['idx']+1,rtp=o['rtp_timestamp'],t_inject_wall_ms=o['t_inject_wall_ms'],capture_unix_ms=o['capture_unix_ms'],bias=bo),
              old_minus_rtp_capture_ms=o['capture_unix_ms']-e['capture_unix_ms'])
    rep=sum(n-1 for n in obs_per_frame.values())
    r=dict(run=f'{cell}/{pol}/{d}/{run}',video_ssrcs=ssrcs,subscriber_video_trackSids=sorted(tracks),inject_frames=len(inj),
      duplicate_rtp_keys=sum(1 for n in keyc.values() if n>1),rtp_increments=dict(incs),rtp_wraps=wraps,
      eligible=eligible,uniquely_matched=len(new),unmatched=unmatched,ambiguous=ambig,distinct_frames_observed=len(obs_per_frame),
      repeated_observations=rep,max_obs_per_frame=max(obs_per_frame.values()) if obs_per_frame else 0,
      old_reproduces_stored_biases=(old==stored),frame_shift_rtp_minus_old=dict(shift),
      median_old=float(np.median(old)),median_new_dedup_first_obs=float(np.median(dedup)) if dedup else None,median_new=float(np.median(new)) if new else None,
      cadence=dict(capture_diff_mean=float(dcap.mean()),capture_diff_counts=dict(collections.Counter(map(int,dcap))),wall_diff_mean=float(dwall.mean())),
      latency_rtp_med=float(np.median(lat_n)) if lat_n else None,latency_old_med=float(np.median(lat_o)))
    runs_out.append(r)
    c=cond[f'{cell}/{pol}/{d}']; c['old'].append(old); c['new'].append(new); c['lat_new']+=lat_n; c['lat_old']+=lat_o
    if first and cell.startswith('c3') and pol=='rewrite' and cell not in examples: examples[cell]=first
C={}
for k,c in sorted(cond.items()):
    C[k]=dict(runs=len(c['new']),bias_rtp_match_v1=stats(c['new'],sum(c['new'],[])),bias_superseded_act_nearest=stats(c['old'],sum(c['old'],[])),
      latency_playout_minus_inject_rtp_med=float(np.median(c['lat_new'])),latency_old_med=float(np.median(c['lat_old'])))
def fires(k):
    b=C[k]['bias_rtp_match_v1'];lo,hi=b['boot95_CI_median_of_run_medians']; return abs(b['pooled_median'])>TAU and (lo>TAU or hi<-TAU)
fd={d:fires(f'c3-m80/rewrite/{d}') for d in ['d0','d50']}
def ex0(k): lo,hi=C[k]['bias_rtp_match_v1']['boot95_CI_median_of_run_medians']; return lo>0 or hi<0
dr={}
for d in ['d0','d50']:
    m=C[f'c3-m80/rewrite/{d}']['bias_rtp_match_v1']['pooled_median'];p=C[f'c3-p80/rewrite/{d}']['bias_rtp_match_v1']['pooled_median']
    v=[abs(C[f'c3-{s}/verbatim/{d}']['bias_rtp_match_v1']['pooled_median']) for s in ['m80','p80']]
    dr[d]=dict(rewrite_m80=m,rewrite_p80=p,opposite_signs=m*p<0,cis_exclude_0=ex0(f'c3-m80/rewrite/{d}') and ex0(f'c3-p80/rewrite/{d}'),verbatim_abs_le_2=all(x<=2 for x in v))
    dr[d]['supported']=all([dr[d]['opposite_signs'],dr[d]['cis_exclude_0'],dr[d]['verbatim_abs_le_2']])
out=dict(analysis_version='rtp-match-v1',status='post-review analysis correction applied to existing data; NOT the preregistered matcher',
  source=R,tau_b_ms=TAU,bootstrap=dict(resamples=B,seed=SEED),conditions=C,
  decision=dict(per_delta_fires=fd,bias_arm_fires=all(fd.values())),direction=dict(per_delta=dr,supported=all(x['supported'] for x in dr.values())),
  conversion_branches={'|'.join(k):v for k,v in sorted(branches.items())},examples=examples,failed_runs_not_pooled=sorted(os.listdir(R+'/_failed')))
json.dump(out,open(OUT+'/summary.json','w'),indent=1); json.dump(runs_out,open(OUT+'/per_run.json','w'),indent=1)
json.dump({k:{'rtp_match_v1':c['new'],'superseded_act_nearest':c['old']} for k,c in sorted(cond.items())},open(OUT+'/observations.json','w'))  # per-run per-API-observation biases (for figures)
L=['# rtp-match-v1 corrected results (post-review correction; existing data)','',f'τ_b={TAU} ms, bootstrap {B} resamples seed {SEED} (unchanged).','',
 '| condition | runs | n (per run) | per-run medians | pooled med | IQR | p5–p95 | min/max | 95% CI | superseded pooled / CI |','|---|---|---|---|---|---|---|---|---|---|']
for k,c in C.items():
    b=c['bias_rtp_match_v1'];o=c['bias_superseded_act_nearest']
    L.append(f"| {k} | {c['runs']} | {b['per_run_n']} | {b['per_run_medians']} | {b['pooled_median']} | {b['IQR']} | {b['p5_p95']} | {b['min_max']} | {[round(x,2) for x in b['boot95_CI_median_of_run_medians']]} | {o['pooled_median']} / {[round(x,2) for x in o['boot95_CI_median_of_run_medians']]} |")
L+=['','## Per-run accounting','','| run | eligible | unique | unmatched | ambiguous | distinct frames | repeated obs | old reproduces stored | shift(rtp−old idx) | med old | med new | latency rtp/old |','|---|---|---|---|---|---|---|---|---|---|---|---|']
for r in runs_out:
    L.append(f"| {r['run']} | {r['eligible']} | {r['uniquely_matched']} | {r['unmatched']} | {r['ambiguous']} | {r['distinct_frames_observed']} | {r['repeated_observations']} | {r['old_reproduces_stored_biases']} | {r['frame_shift_rtp_minus_old']} | {r['median_old']} | {r['median_new']} | {r['latency_rtp_med']}/{r['latency_old_med']} |")
L+=['',f'Decision (unchanged rule): per-Δ fires {fd} → bias arm fires = {all(fd.values())}','',f'Direction: {json.dumps(dr)}','',f"Conversion branches: {out['conversion_branches']}"]
open(OUT+'/summary.md','w').write('\n'.join(L)); print('\n'.join(L)); print(json.dumps(examples,indent=1))
