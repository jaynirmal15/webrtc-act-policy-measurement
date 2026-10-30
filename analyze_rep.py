import json,glob,os,random,statistics as st
import numpy as np
R='/workspace/paper3/results/rep-2026-10-15b'
SEED=20261015;B=10000
def boot(meds):
    rng=np.random.default_rng(SEED);a=np.array(meds,float)
    m=np.median(a[rng.integers(0,len(a),(B,len(a)))],axis=1)
    return [float(np.percentile(m,2.5)),float(np.percentile(m,97.5))]
def stats(per_run_vals,pooled):
    p=np.array(pooled,float);meds=[float(np.median(v)) if isinstance(v,list) else float(v) for v in per_run_vals]
    return dict(per_run_medians=meds,pooled_median=float(np.median(p)),pooled_n=len(p),
      IQR=[float(np.percentile(p,25)),float(np.percentile(p,75))],p5_p95=[float(np.percentile(p,5)),float(np.percentile(p,95))],
      min_max=[float(p.min()),float(p.max())],boot95_CI_median_of_run_medians=boot(meds))
out={'source':R,'addendum':'replication-prereg-addendum.md','tau_b_ms':10,'bootstrap':{'resamples':B,'seed':SEED,'type':'percentile, runs resampled with replacement'},'conditions':{},'failed_runs':sorted(os.listdir(R+'/_failed'))}
for cell in ['c0','c2','c3-m80','c3-p80']:
  for pol in ['rewrite','verbatim']:
    for d in ['d0','d50']:
      runs=sorted(glob.glob(f'{R}/{cell}/{pol}/{d}/run-*'))
      bs=[];ttf=[];fn=[]
      for r in runs:
        t=json.load(open(glob.glob(r+'/trial-*.json')[0]))
        bs.append(t['trials'][0]['metrics']['biases_ms'])
        if cell=='c2': ttf.append(t['time_to_first_captureTimestamp_ms']);fn.append(t['fraction_ct_null_early'])
      c={'runs':len(runs),'bias_ms':stats(bs,[x for b in bs for x in b])}
      if cell=='c2': c['time_to_first_ct_ms']=stats(ttf,ttf);c['frac_ct_null_early']=stats(fn,fn)
      out['conditions'][f'{cell}/{pol}/{d}']=c
C=out['conditions']
def fires(k):
    b=C[k]['bias_ms'];lo,hi=b['boot95_CI_median_of_run_medians']
    return abs(b['pooled_median'])>10 and (lo>10 or hi<-10)
fd={d:fires(f'c3-m80/rewrite/{d}') for d in ['d0','d50']}
out['decision']={'per_delta_fires':fd,'bias_arm_fires':all(fd.values()),
 'outcome':'BIAS ARM FIRES' if all(fd.values()) else 'BIAS ARM DOES NOT FIRE -> fallback: C2 CT-availability primary'}
def excl0(k):lo,hi=C[k]['bias_ms']['boot95_CI_median_of_run_medians'];return lo>0 or hi<0
dr={}
for d in ['d0','d50']:
    m=C[f'c3-m80/rewrite/{d}']['bias_ms']['pooled_median'];p=C[f'c3-p80/rewrite/{d}']['bias_ms']['pooled_median']
    v=[abs(C[f'c3-{s}/verbatim/{d}']['bias_ms']['pooled_median']) for s in ['m80','p80']]
    dr[d]=dict(rewrite_m80=m,rewrite_p80=p,opposite_signs=m*p<0,cis_exclude_0=excl0(f'c3-m80/rewrite/{d}') and excl0(f'c3-p80/rewrite/{d}'),verbatim_abs_le_2=all(x<=2 for x in v))
    dr[d]['supported']=dr[d]['opposite_signs'] and dr[d]['cis_exclude_0'] and dr[d]['verbatim_abs_le_2']
out['direction']={'per_delta':dr,'supported':all(x['supported'] for x in dr.values())}
json.dump(out,open(R+'/summary.json','w'),indent=1)
L=['# Replication summary — rep-2026-10-15b','',f"Rule per replication-prereg-addendum.md (frozen; τ_b=10 ms). Bootstrap: {B} resamples, seed {SEED}.",'',
 '| condition | runs | per-run medians | pooled med | IQR | p5–p95 | min/max | 95% CI (med of run meds) |','|---|---|---|---|---|---|---|---|']
for k,c in C.items():
    b=c['bias_ms'];L.append(f"| {k} bias | {c['runs']} | {b['per_run_medians']} | {b['pooled_median']} | {b['IQR']} | {b['p5_p95']} | {b['min_max']} | {[round(x,2) for x in b['boot95_CI_median_of_run_medians']]} |")
L+=['','## C2 CT availability','','| condition | metric | per-run | pooled med | IQR | p5–p95 | min/max | 95% CI |','|---|---|---|---|---|---|---|---|']
for k,c in C.items():
  if k.startswith('c2'):
    for m in ['time_to_first_ct_ms','frac_ct_null_early']:
      b=c[m];L.append(f"| {k} | {m} | {[round(x,3) for x in b['per_run_medians']]} | {round(b['pooled_median'],3)} | {[round(x,3) for x in b['IQR']]} | {[round(x,3) for x in b['p5_p95']]} | {[round(x,3) for x in b['min_max']]} | {[round(x,3) for x in b['boot95_CI_median_of_run_medians']]} |")
L+=['','## Decision',f"Per Δ fires: {fd}. **{out['decision']['outcome']}**",'','## Direction (addendum §d)',json.dumps(dr,indent=1),f"Supported: **{out['direction']['supported']}**",'',f"Failed (apparatus) runs, reported not pooled: {out['failed_runs']}"]
open(R+'/summary.md','w').write('\n'.join(L))
