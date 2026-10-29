package main

import (
	"encoding/json"
	"os"
	"sync"
)

type injectEvent struct {
	TInjectWallMs int64  `json:"t_inject_wall_ms"`
	DeltaInjectMs int    `json:"delta_inject_ms"`
	AVOffsetMs    int    `json:"av_offset_ms,omitempty"`
	TrackKind     string `json:"track_kind,omitempty"`
	RTPTimestamp  uint32 `json:"rtp_timestamp"`
	SSRC          uint32 `json:"ssrc"`
	Mime          string `json:"mime"`
	ActID         uint8  `json:"act_id"`
	CaptureUnixMs int64  `json:"capture_unix_ms"`
	SetError      string `json:"set_error,omitempty"`
}

type injectLogger struct {
	mu   sync.Mutex
	path string
	f    *os.File
}

func newInjectLogger(path string) (*injectLogger, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	return &injectLogger{path: path, f: f}, nil
}

func (l *injectLogger) Write(ev injectEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	_, _ = l.f.Write(append(b, '\n'))
}

func (l *injectLogger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		_ = l.f.Close()
	}
}
