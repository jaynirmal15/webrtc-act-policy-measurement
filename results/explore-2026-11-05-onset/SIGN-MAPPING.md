# Sign mapping — derived from source (before onset code)

**EXPLORATORY.** Not a preregistered claim. Quotes from trees present on this host.

## Sources

1. SFU estimator (what rewrite actually calls):  
   `mediatransportutil/.../pkg/latency/owd_estimator.go` — byte-identical Update() to the harness copy below.  
   Wired from `rtpstats_receiver.go:759–775` → `AtAdjusted = senderClockTime + estimatedPropagationDelay`.  
   ACT rewrite offset = `RTCPSenderReportPropagationDelay` ≈ AtAdjusted−Ntp (`downtrack.go:1109–1113`).
2. Harness copy (line numbers the brief cites):  
   `m1-harness/third_party/server-sdk-go/pkg/synchronizer/owd_estimator.go`
3. Publisher interceptor:  
   `m1-harness/pion-publisher/sr_ntp_skew_interceptor.go`

## How SkewMs moves the OWD sample

Interceptor (lines 13–14, 37–50):

```
// subtracts SkewMs from the NTP timestamp of every outbound RTCP Sender Report
// (publisher clock appears behind SFU wall by SkewMs).
func ntpSubtractMs(ntp uint64, ms int64) uint64 {
	if ms < 0 {
		return ntp + uint64(-ms)*(uint64(1)<<32)/1000   // negative ms ADDS |ms|
	}
	...
	return ntp - delta   // positive ms SUBTRACTS
}
```

Estimator sample (owd_estimator.go:45 comment and :119):

```
// propagation_delay = time_of_report_reception - ntp_timestamp_in_report
o.lastPropagationDelayNs = receiverClockTimeNs - senderClockTimeNs
```

Therefore:

| flag (rep-run-one) | SkewMs | NTP change | senderClockTime | OWD sample | jump sign |
|---|---:|---|---|---|---|
| **m80** | **+80** | −80 ms | earlier | **higher** by ~80 ms | **positive** |
| **p80** | **−80** | +80 ms | later | **lower** by ~80 ms | **negative** |

## Gate vs 0.9 adopt (owd_estimator.go)

Delta vs estimate (:128):

```
o.lastDeltaPropagationDelayNs = o.lastPropagationDelayNs - o.estimatedPropagationDelayNs
```

**Positive jump (SkewMs=+80 / m80)** — lines 129–146:

```
if o.lastDeltaPropagationDelayNs > ...ThresholdMin... {  // > 10 ms
    if o.longTermDeltaPropagationDelayNs != 0 &&
       o.lastDeltaPropagationDelayNs > o.longTermDeltaPropagationDelayNs*...MaxFactor {
        o.propagationDelayDeltaHighCount++
        ...
        if count >= PropagationDelayDeltaHighResetNumReports  // 2
           && time.Since(start) >= PropagationDelayDeltaHighResetWait {  // 10 s
            stepChange = true
            initPropagationDelay(o.propagationDelaySpikeNs)  // reset
        }
    } else {
        resetDelta()   // no EMA update while gating / not yet in high-delta
    }
}
```

Defaults (:64–67): ThresholdMin=10ms, MaxFactor=2, ResetNumReports=2, ResetWait=10s.  
So a mid-session **+80** OWD jump is **withheld** until ≥2 high-delta SRs spanning ≥10 s; SFU logs `"propagation delay step change"` on reset (`rtpstats_receiver.go:763–768`).

**Negative jump (SkewMs=−80 / p80)** — lines 150–157:

```
} else {
    resetDelta()
    factor := o.params.PropagationDelayFallFactor   // 0.9
    if o.lastPropagationDelayNs > o.estimatedPropagationDelayNs {
        factor = o.params.PropagationDelayRiseFactor  // 0.1
    }
    o.estimatedPropagationDelayNs += int64(factor * float64(o.lastPropagationDelayNs-o.estimatedPropagationDelayNs))
}
```

A **−80** OWD jump has delta ≪ 0, so it takes the else branch with **FallFactor 0.9** — adopted at 0.9 per SR (not gated).

## Manuscript prediction ↔ code

> “a positive jump is withheld by the outlier gate until a reset requiring ≥2 SRs spanning ≥10 s, while a negative jump is adopted at 0.9 per SR”

| manuscript | SkewMs | OWD | code path |
|---|---:|---|---|
| positive jump | **+80** (m80) | ↑ | gate :129–146; reset after ≥2 SRs / ≥10 s |
| negative jump | **−80** (p80) | ↓ | EMA FallFactor **0.9** :150–157 |

Bias under rewrite ≈ −SkewMs (interceptor comment lines 17–19): m80 → bias ≈ −80; after a gated reset to the new OWD, same. p80 → estimator falls quickly → bias ≈ +80.

## Prerequisite for the gate

`:131` requires `longTermDeltaPropagationDelayNs != 0`. That field is filled only for deltas < 50 ms (`:160–168`). After ~10–20 s of unperturbed SRs (our onset T=20 s), long-term delta is non-zero and a subsequent +80 jump can enter the high-delta path. If long-term were still 0, a positive jump would hit `:147–148` (resetDelta, no EMA, no count) — still withheld, but **without** progressing toward a 10 s reset. Calibration must confirm long-term is live before onset.
