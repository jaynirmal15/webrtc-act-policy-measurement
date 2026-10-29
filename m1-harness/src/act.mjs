/**
 * Absolute Capture Time (ACT) helpers for Day-1 gate.
 * URI matches LiveKit pkg/sfu/rtpextension/abscapturetime AbsCaptureTimeURI @ v1.13.7
 * and https://webrtc.googlesource.com/src/+/main/docs/native-code/rtp-hdrext/abs-capture-time/
 */

export const ACT_URI =
  'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';

/**
 * Browser-side snippet: enable ACT on all transceivers of a PeerConnection-like
 * object that exposes getTransceivers() (LiveKit PCTransport or RTCPeerConnection).
 * Returns a summary of before/after negotiation capability lists.
 */
export function enableActOnTransceiversSource() {
  // Serialized into page.evaluate — must be self-contained.
  return String(function enableActOnTransceivers(pcOrTransport, actUri) {
    const uri = actUri || 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';
    const transceivers =
      typeof pcOrTransport?.getTransceivers === 'function'
        ? pcOrTransport.getTransceivers()
        : [];
    const results = [];
    for (const t of transceivers) {
      const before =
        typeof t.getHeaderExtensionsToNegotiate === 'function'
          ? t.getHeaderExtensionsToNegotiate().map((e) => ({
              uri: e.uri,
              direction: e.direction,
            }))
          : null;
      let setOk = false;
      let setError = null;
      if (typeof t.setHeaderExtensionsToNegotiate === 'function') {
        try {
          const caps =
            typeof t.getHeaderExtensionsToNegotiate === 'function'
              ? t.getHeaderExtensionsToNegotiate().map((e) => ({ ...e }))
              : [];
          let found = false;
          for (const c of caps) {
            if (c.uri === uri) {
              c.direction = 'sendrecv';
              found = true;
            }
          }
          if (!found) {
            caps.push({ uri, direction: 'sendrecv' });
          }
          t.setHeaderExtensionsToNegotiate(caps);
          setOk = true;
        } catch (e) {
          setError = String(e && e.message ? e.message : e);
        }
      } else {
        setError = 'setHeaderExtensionsToNegotiate unavailable';
      }
      const after =
        typeof t.getHeaderExtensionsToNegotiate === 'function'
          ? t.getHeaderExtensionsToNegotiate().map((e) => ({
              uri: e.uri,
              direction: e.direction,
            }))
          : null;
      const negotiated =
        typeof t.getNegotiatedHeaderExtensions === 'function'
          ? t.getNegotiatedHeaderExtensions().map((e) => ({
              uri: e.uri,
              id: e.id,
              encrypted: e.encrypted,
            }))
          : null;
      results.push({
        mid: t.mid,
        direction: t.direction,
        kind: t.sender?.track?.kind || t.receiver?.track?.kind || null,
        setOk,
        setError,
        before,
        after,
        negotiated,
        actDesired:
          after?.some((e) => e.uri === uri && e.direction && e.direction !== 'stopped') ??
          null,
        actNegotiated: negotiated?.some((e) => e.uri === uri) ?? null,
      });
    }
    return {
      apiAvailable: typeof RTCRtpTransceiver !== 'undefined',
      setApi:
        transceivers.length > 0 &&
        typeof transceivers[0].setHeaderExtensionsToNegotiate === 'function',
      count: transceivers.length,
      results,
    };
  });
}

/**
 * Parse SDP a=extmap lines for ACT URI presence.
 */
export function sdpHasAct(sdp, uri = ACT_URI) {
  if (!sdp || typeof sdp !== 'string') return false;
  return sdp.split('\n').some((line) => line.includes('extmap:') && line.includes(uri));
}

/**
 * Collect captureTimestamp samples from RTCRtpReceiver.getSynchronizationSources().
 */
export function collectCaptureTimestampSamples(receiver, maxSamples = 20) {
  if (!receiver || typeof receiver.getSynchronizationSources !== 'function') {
    return { samples: [], error: 'getSynchronizationSources unavailable' };
  }
  const sources = receiver.getSynchronizationSources();
  const samples = [];
  for (const s of sources) {
    samples.push({
      timestamp: s.timestamp,
      source: s.source,
      rtpTimestamp: s.rtpTimestamp,
      captureTimestamp: s.captureTimestamp ?? null,
      senderCaptureTimeOffset: s.senderCaptureTimeOffset ?? null,
      hasCaptureTimestamp:
        s.captureTimestamp !== undefined && s.captureTimestamp !== null,
    });
    if (samples.length >= maxSamples) break;
  }
  return { samples, error: null };
}

/**
 * Decide Day-1 verdict from negotiation + captureTimestamp observations.
 */
export function decideVerdict({
  negotiatedPublisher,
  negotiatedSubscriber,
  captureTimestampSeen,
  apparatusError,
}) {
  if (apparatusError) {
    return 'APPARATUS_ERROR';
  }
  if (!negotiatedPublisher && !negotiatedSubscriber) {
    return 'FAIL_NOT_NEGOTIATED';
  }
  if ((negotiatedPublisher || negotiatedSubscriber) && !captureTimestampSeen) {
    return 'FAIL_NEGOTIATED_BUT_UNREADABLE';
  }
  if ((negotiatedPublisher || negotiatedSubscriber) && captureTimestampSeen) {
    return 'PASS_ACT_EXPOSED';
  }
  return 'APPARATUS_ERROR';
}
