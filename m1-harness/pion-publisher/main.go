// C1/C2/C3 Pion publisher: LiveKit A+V with ACT = wall_now − Δ_inject (+ av_offset on audio).
// Optional -sr-hold-ms suppresses outbound RTCP Sender Reports for N ms (C2/C4 delayed-SR).
// Optional -sr-ntp-skew-ms subtracts N ms from outbound SR NTP (C3 skew/delay bias cell).
package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/pion/interceptor"

	lksdk "github.com/livekit/server-sdk-go/v2"
)

func main() {
	var (
		host         = flag.String("host", "ws://127.0.0.1:7880", "LiveKit URL")
		apiKey       = flag.String("api-key", "devkey", "API key")
		apiSecret    = flag.String("api-secret", "secret", "API secret")
		roomName     = flag.String("room", "m1-act-c1", "room name")
		identity     = flag.String("identity", "c1-pion-publisher", "identity")
		deltaMs      = flag.Int("delta-inject-ms", 0, "Δ_inject ms: base ACT = wall_now − Δ_inject")
		avOffsetMs   = flag.Int("av-offset-ms", 0, "intentional audio ACT offset vs video (ms); expected sync_err ≈ this")
		staggerStart = flag.Int("stagger-start-ms", 0, "delay after video publish before starting audio (ms)")
		srHoldMs     = flag.Int("sr-hold-ms", 0, "hold/suppress outbound RTCP Sender Reports for N ms (C2 delayed first SR)")
		srNtpSkewMs  = flag.Int("sr-ntp-skew-ms", 0, "subtract N ms from outbound SR NTP (N<0 adds |N|; C3 estimate perturbation = -N)")
		videoPath    = flag.String("video", "", "path to .ivf VP8 file")
		audioPath    = flag.String("audio", "", "path to .ogg Opus file (empty / - = video-only)")
		videoOnly    = flag.Bool("video-only", false, "force video-only (no audio publish)")
		duration     = flag.Duration("duration", 45*time.Second, "how long to publish")
		injectLog    = flag.String("inject-log", "", "JSONL path for inject events")
	)
	flag.Parse()

	root, _ := filepath.Abs(filepath.Join(filepath.Dir(os.Args[0]), ".."))
	if *videoPath == "" {
		*videoPath = filepath.Join(root, "media", "c1-video.ivf")
		if _, err := os.Stat(*videoPath); err != nil {
			*videoPath = filepath.Join(root, "media", "c0-video.ivf")
		}
	}
	if _, err := os.Stat(*videoPath); err != nil {
		alt := filepath.Join("..", "media", "c1-video.ivf")
		if _, err2 := os.Stat(alt); err2 == nil {
			*videoPath = alt
		} else {
			fmt.Fprintf(os.Stderr, "video file missing: %s (%v)\n", *videoPath, err)
			os.Exit(2)
		}
	}
	publishAudio := !*videoOnly && *audioPath != "-"
	if publishAudio && *audioPath == "" {
		cand := filepath.Join(root, "media", "c1-audio.ogg")
		if _, err := os.Stat(cand); err == nil {
			*audioPath = cand
		} else {
			alt := filepath.Join("..", "media", "c1-audio.ogg")
			if _, err2 := os.Stat(alt); err2 == nil {
				*audioPath = alt
			} else {
				publishAudio = false
				fmt.Println("WARNING: no audio file — video-only (sync_err unavailable)")
			}
		}
	}
	if *videoOnly {
		publishAudio = false
		*audioPath = ""
	}
	if *injectLog == "" {
		*injectLog = filepath.Join(root, "out", "c1-inject.jsonl")
		if dir := filepath.Dir(*injectLog); dir != "" {
			_ = os.MkdirAll(dir, 0o755)
		}
	}

	logger, err := newInjectLogger(*injectLog)
	if err != nil {
		fmt.Fprintf(os.Stderr, "inject log: %v\n", err)
		os.Exit(2)
	}
	defer logger.Close()

	factory := &ActStampInterceptorFactory{LogPath: *injectLog, logFile: logger}
	factory.DeltaInjectMs.Store(int64(*deltaMs))
	factory.AVOffsetMs.Store(int64(*avOffsetMs))

	srHold := &SRHoldInterceptorFactory{}
	srHold.HoldMs.Store(int64(*srHoldMs))

	srSkew := &SRNtpSkewInterceptorFactory{}
	srSkew.SkewMs.Store(int64(*srNtpSkewMs))

	interceptors := []interceptor.Factory{factory}
	if *srHoldMs > 0 {
		interceptors = append(interceptors, srHold)
	}
	if *srNtpSkewMs != 0 {
		interceptors = append(interceptors, srSkew)
	}

	fmt.Printf("pion-publisher host=%s room=%s delta_inject_ms=%d av_offset_ms=%d stagger_start_ms=%d sr_hold_ms=%d sr_ntp_skew_ms=%d video=%s audio=%s inject_log=%s\n",
		*host, *roomName, *deltaMs, *avOffsetMs, *staggerStart, *srHoldMs, *srNtpSkewMs, *videoPath, *audioPath, *injectLog)

	room, err := lksdk.ConnectToRoom(*host, lksdk.ConnectInfo{
		APIKey:              *apiKey,
		APISecret:           *apiSecret,
		RoomName:            *roomName,
		ParticipantIdentity: *identity,
	}, &lksdk.RoomCallback{},
		lksdk.WithAutoSubscribe(false),
		lksdk.WithInterceptors(interceptors),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect: %v\n", err)
		os.Exit(2)
	}
	defer room.Disconnect()

	vtrack, err := lksdk.NewLocalFileTrack(*videoPath,
		lksdk.ReaderTrackWithFrameDuration(66*time.Millisecond),
		lksdk.ReaderTrackWithOnWriteComplete(func() {
			fmt.Println("video file pass complete")
		}),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "NewLocalFileTrack video: %v\n", err)
		os.Exit(2)
	}
	if _, err = room.LocalParticipant.PublishTrack(vtrack, &lksdk.TrackPublicationOptions{
		Name:        "c2-video",
		VideoWidth:  320,
		VideoHeight: 240,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "PublishTrack video: %v\n", err)
		os.Exit(2)
	}
	fmt.Println("published video track")

	audioPublished := false
	if publishAudio && *audioPath != "" {
		if *staggerStart > 0 {
			fmt.Printf("stagger-start: waiting %d ms before audio publish\n", *staggerStart)
			time.Sleep(time.Duration(*staggerStart) * time.Millisecond)
		}
		atrack, err := lksdk.NewLocalFileTrack(*audioPath,
			lksdk.ReaderTrackWithOnWriteComplete(func() {
				fmt.Println("audio file pass complete")
			}),
		)
		if err != nil {
			fmt.Fprintf(os.Stderr, "NewLocalFileTrack audio: %v\n", err)
			os.Exit(2)
		}
		if _, err = room.LocalParticipant.PublishTrack(atrack, &lksdk.TrackPublicationOptions{
			Name: "c2-audio",
		}); err != nil {
			fmt.Fprintf(os.Stderr, "PublishTrack audio: %v\n", err)
			os.Exit(2)
		}
		audioPublished = true
		fmt.Println("published audio track")
	}

	time.Sleep(2 * time.Second)
	pc := room.LocalParticipant.GetPublisherPeerConnection()
	actNegotiated := false
	actAudio := false
	actVideo := false
	if pc != nil {
		for _, s := range pc.GetSenders() {
			params := s.GetParameters()
			kind := "unknown"
			if t := s.Track(); t != nil {
				kind = t.Kind().String()
			}
			for _, ext := range params.HeaderExtensions {
				if ext.URI == actURI {
					actNegotiated = true
					fmt.Printf("ACT negotiated on sender kind=%s id=%d uri=%s\n", kind, ext.ID, ext.URI)
					if kind == "audio" {
						actAudio = true
					}
					if kind == "video" {
						actVideo = true
					}
				}
			}
		}
		if sd := pc.LocalDescription(); sd != nil && strings.Contains(sd.SDP, actURI) {
			fmt.Println("local SDP contains ACT URI")
			actNegotiated = true
		}
	}
	if !actNegotiated {
		fmt.Println("WARNING: ACT extension not visible on senders — check MediaEngine patch")
	}

	metaPath := strings.TrimSuffix(*injectLog, filepath.Ext(*injectLog)) + ".meta.json"
	writeMeta := func() {
		_ = os.WriteFile(metaPath, []byte(fmt.Sprintf(
			`{"delta_inject_ms":%d,"av_offset_ms":%d,"stagger_start_ms":%d,"sr_hold_ms":%d,"sr_ntp_skew_ms":%d,"sr_ntp_skewed_count":%d,"sr_ntp_first_skew_unix_ms":%d,"sr_first_held_unix_ms":%d,"sr_first_released_unix_ms":%d,"sr_held_count":%d,"sr_released_count":%d,"act_negotiated":%v,"act_audio":%v,"act_video":%v,"audio_published":%v,"video":%q,"audio":%q,"started_unix_ms":%d}`+"\n",
			*deltaMs, *avOffsetMs, *staggerStart, *srHoldMs, *srNtpSkewMs,
			srSkew.SkewedCount.Load(), srSkew.FirstSkewUnixMs.Load(),
			srHold.FirstHeldUnixMs.Load(), srHold.FirstReleasedUnixMs.Load(),
			srHold.HeldCount.Load(), srHold.ReleasedCount.Load(),
			actNegotiated, actAudio, actVideo, audioPublished, *videoPath, *audioPath, time.Now().UnixMilli(),
		)), 0o644)
	}
	writeMeta()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sig:
	case <-time.After(*duration):
	}
	writeMeta()
	fmt.Printf("publisher done sr_held=%d sr_released=%d first_held=%d first_released=%d sr_ntp_skew_ms=%d sr_ntp_skewed=%d\n",
		srHold.HeldCount.Load(), srHold.ReleasedCount.Load(),
		srHold.FirstHeldUnixMs.Load(), srHold.FirstReleasedUnixMs.Load(),
		*srNtpSkewMs, srSkew.SkewedCount.Load())
}
