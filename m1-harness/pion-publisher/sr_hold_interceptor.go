package main

import (
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
)

// SRHoldInterceptorFactory drops outbound RTCP Sender Reports for HoldMs
// after BindRTCPWriter, then forwards them. Used to stress LiveKit stock
// rewrite SR-gate (ACT stripped until first publisher SR) vs verbatim.
type SRHoldInterceptorFactory struct {
	HoldMs atomic.Int64
	// Wall times for meta (unix ms); 0 if never observed.
	FirstHeldUnixMs    atomic.Int64
	FirstReleasedUnixMs atomic.Int64
	HeldCount          atomic.Int64
	ReleasedCount      atomic.Int64
	startOnce          sync.Once
	startAt            time.Time
}

func (f *SRHoldInterceptorFactory) NewInterceptor(id string) (interceptor.Interceptor, error) {
	return &srHoldInterceptor{factory: f}, nil
}

func (f *SRHoldInterceptorFactory) ensureStart() time.Time {
	f.startOnce.Do(func() {
		f.startAt = time.Now()
		fmt.Fprintf(os.Stderr, "sr-hold: window started hold_ms=%d at %s\n",
			f.HoldMs.Load(), f.startAt.Format(time.RFC3339Nano))
	})
	return f.startAt
}

func (f *SRHoldInterceptorFactory) stillHolding() bool {
	hold := time.Duration(f.HoldMs.Load()) * time.Millisecond
	if hold <= 0 {
		return false
	}
	start := f.ensureStart()
	return time.Since(start) < hold
}

type srHoldInterceptor struct {
	factory *SRHoldInterceptorFactory
	interceptor.NoOp
}

func (s *srHoldInterceptor) BindRTCPWriter(writer interceptor.RTCPWriter) interceptor.RTCPWriter {
	// Hold clock starts on first outbound SenderReport (not PC bind), so the
	// subscriber sample window can overlap the delayed-SR stress.
	return interceptor.RTCPWriterFunc(func(pkts []rtcp.Packet, attributes interceptor.Attributes) (int, error) {
		// Arm clock on first SR batch so hold is relative to first SR attempt.
		for _, p := range pkts {
			if _, ok := p.(*rtcp.SenderReport); ok {
				s.factory.ensureStart()
				break
			}
		}
		if !s.factory.stillHolding() {
			// Count any SR we forward after hold for meta.
			for _, p := range pkts {
				if _, ok := p.(*rtcp.SenderReport); ok {
					if s.factory.FirstReleasedUnixMs.Load() == 0 {
						s.factory.FirstReleasedUnixMs.Store(time.Now().UnixMilli())
						fmt.Fprintf(os.Stderr, "sr-hold: first SR released after hold\n")
					}
					s.factory.ReleasedCount.Add(1)
				}
			}
			return writer.Write(pkts, attributes)
		}
		filtered := make([]rtcp.Packet, 0, len(pkts))
		for _, p := range pkts {
			if _, ok := p.(*rtcp.SenderReport); ok {
				if s.factory.FirstHeldUnixMs.Load() == 0 {
					s.factory.FirstHeldUnixMs.Store(time.Now().UnixMilli())
					fmt.Fprintf(os.Stderr, "sr-hold: holding first SR\n")
				}
				s.factory.HeldCount.Add(1)
				continue
			}
			filtered = append(filtered, p)
		}
		if len(filtered) == 0 {
			return 0, nil
		}
		return writer.Write(filtered, attributes)
	})
}
