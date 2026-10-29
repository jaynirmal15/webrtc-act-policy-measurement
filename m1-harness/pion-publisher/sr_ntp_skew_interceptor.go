package main

import (
	"fmt"
	"os"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
)

// SRNtpSkewInterceptorFactory subtracts SkewMs from the NTP timestamp of every
// outbound RTCP Sender Report (publisher clock appears behind SFU wall by SkewMs).
// ACT RTP stamps are left untouched (still wall_now − Δ_inject).
//
// Under LiveKit rewrite + DisableSenderReportPassThrough=true, Rewrite offset
// becomes ≈ AtAdjusted−Ntp ≈ estimated OWD ≈ SkewMs, so captureTimestamp shifts
// and latency bias b = L̂−L* should approach −SkewMs. Verbatim skips Rewrite,
// so bias should stay near 0 under the same skew.
type SRNtpSkewInterceptorFactory struct {
	SkewMs       atomic.Int64
	SkewedCount  atomic.Int64
	FirstSkewUnixMs atomic.Int64
	LastSkewMsApplied atomic.Int64
}

func (f *SRNtpSkewInterceptorFactory) NewInterceptor(id string) (interceptor.Interceptor, error) {
	return &srNtpSkewInterceptor{factory: f}, nil
}

type srNtpSkewInterceptor struct {
	factory *SRNtpSkewInterceptorFactory
	interceptor.NoOp
}

// ntpSubtractMs subtracts ms from an NTP 64-bit timestamp (2^32 units = 1 s).
// Replication 2026-10-15: negative ms ADDS |ms| (SR NTP estimate perturbation +|ms|).
func ntpSubtractMs(ntp uint64, ms int64) uint64 {
	if ms == 0 {
		return ntp
	}
	if ms < 0 {
		return ntp + uint64(-ms)*(uint64(1)<<32)/1000
	}
	delta := uint64(ms) * (uint64(1) << 32) / 1000
	if ntp < delta {
		return 0
	}
	return ntp - delta
}

func (s *srNtpSkewInterceptor) BindRTCPWriter(writer interceptor.RTCPWriter) interceptor.RTCPWriter {
	return interceptor.RTCPWriterFunc(func(pkts []rtcp.Packet, attributes interceptor.Attributes) (int, error) {
		skew := s.factory.SkewMs.Load()
		if skew == 0 {
			return writer.Write(pkts, attributes)
		}
		for _, p := range pkts {
			sr, ok := p.(*rtcp.SenderReport)
			if !ok {
				continue
			}
			before := sr.NTPTime
			sr.NTPTime = ntpSubtractMs(before, skew)
			n := s.factory.SkewedCount.Add(1)
			s.factory.LastSkewMsApplied.Store(skew)
			if s.factory.FirstSkewUnixMs.Load() == 0 {
				s.factory.FirstSkewUnixMs.Store(time.Now().UnixMilli())
				fmt.Fprintf(os.Stderr, "sr-ntp-skew: first SR NTP skewed by %d ms (before=0x%x after=0x%x)\n",
					skew, before, sr.NTPTime)
			}
			if n <= 3 || n%50 == 0 {
				fmt.Fprintf(os.Stderr, "sr-ntp-skew: count=%d skew_ms=%d ntp_before=0x%x ntp_after=0x%x\n",
					n, skew, before, sr.NTPTime)
			}
		}
		return writer.Write(pkts, attributes)
	})
}
