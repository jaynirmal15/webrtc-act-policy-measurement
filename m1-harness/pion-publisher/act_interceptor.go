package main

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

const actURI = "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time"

// ActStampInterceptorFactory stamps abs-capture-time on outbound RTP.
// Video: ACT = wall_now − Δ_inject
// Audio: ACT = wall_now − Δ_inject + av_offset_ms
// so expected sync_err = t_capture_audio − t_capture_video ≈ av_offset_ms
// when policies preserve relative ACT (prereg formula).
type ActStampInterceptorFactory struct {
	DeltaInjectMs atomic.Int64
	AVOffsetMs    atomic.Int64 // audio capture offset relative to video (ms)
	LogMu         sync.Mutex
	LogPath       string
	logFile       *injectLogger
	errCount      atomic.Int64
	okCount       atomic.Int64
}

func (f *ActStampInterceptorFactory) NewInterceptor(id string) (interceptor.Interceptor, error) {
	return &actStampInterceptor{factory: f}, nil
}

type actStampInterceptor struct {
	factory *ActStampInterceptorFactory
	interceptor.NoOp
}

func (a *actStampInterceptor) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	var actID uint8
	for _, ext := range info.RTPHeaderExtensions {
		if ext.URI == actURI {
			actID = uint8(ext.ID)
			break
		}
	}
	fmt.Fprintf(os.Stderr, "act-interceptor BindLocalStream ssrc=%d mime=%s actID=%d exts=%d av_offset_ms=%d\n",
		info.SSRC, info.MimeType, actID, len(info.RTPHeaderExtensions), a.factory.AVOffsetMs.Load())
	return &actStampWriter{
		factory: a.factory,
		writer:  writer,
		actID:   actID,
		ssrc:    info.SSRC,
		mime:    info.MimeType,
	}
}

type actStampWriter struct {
	factory *ActStampInterceptorFactory
	writer  interceptor.RTPWriter
	actID   uint8
	ssrc    uint32
	mime    string
}

func isAudioMime(mime string) bool {
	m := strings.ToLower(mime)
	return strings.Contains(m, "audio") || strings.Contains(m, "opus") || strings.Contains(m, "pcmu") || strings.Contains(m, "pcma")
}

func (w *actStampWriter) Write(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
	now := time.Now()
	delta := time.Duration(w.factory.DeltaInjectMs.Load()) * time.Millisecond
	avOff := time.Duration(0)
	if isAudioMime(w.mime) {
		avOff = time.Duration(w.factory.AVOffsetMs.Load()) * time.Millisecond
	}
	injectWallMs := now.UnixMilli()
	captureTime := now.Add(-delta).Add(avOff)
	setErr := ""

	if w.actID != 0 {
		ext := rtp.NewAbsCaptureTimeExtension(captureTime)
		data, err := ext.Marshal()
		if err != nil {
			setErr = "marshal:" + err.Error()
		} else {
			if err := header.SetExtension(w.actID, data); err != nil {
				setErr = err.Error()
				w.factory.errCount.Add(1)
				if w.factory.errCount.Load() <= 5 {
					fmt.Fprintf(os.Stderr, "act SetExtension fail id=%d: %v (header.ext=%v)\n", w.actID, err, header.Extension)
				}
			} else {
				w.factory.okCount.Add(1)
			}
		}
	} else {
		setErr = "actID=0"
	}

	if w.factory.logFile != nil {
		kind := "video"
		if isAudioMime(w.mime) {
			kind = "audio"
		}
		w.factory.logFile.Write(injectEvent{
			TInjectWallMs: injectWallMs,
			DeltaInjectMs: int(w.factory.DeltaInjectMs.Load()),
			AVOffsetMs:    int(w.factory.AVOffsetMs.Load()),
			TrackKind:     kind,
			RTPTimestamp:  header.Timestamp,
			SSRC:          w.ssrc,
			Mime:          w.mime,
			ActID:         w.actID,
			CaptureUnixMs: captureTime.UnixMilli(),
			SetError:      setErr,
		})
	}

	return w.writer.Write(header, payload, attributes)
}
