#!/usr/bin/env node
/**
 * M1 Day-1 ACT negotiation gate.
 *
 * Boots two Playwright Chromium peers (publisher + subscriber) against a local
 * LiveKit server (stock rewrite policy — no PR #4812), tries to negotiate ACT
 * via setHeaderExtensionsToNegotiate on LiveKit's underlying PCTransport
 * transceivers, polls RTCRtpReceiver.getSynchronizationSources() for
 * captureTimestamp, and writes out/day1-gate.json.
 *
 * Does NOT invent measurement results. Apparatus failures → APPARATUS_ERROR.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  ACT_URI,
  enableActOnTransceiversSource,
  sdpHasAct,
  decideVerdict,
} from './act.mjs';
import { mintToken, LIVEKIT_URL, ROOM_NAME } from './livekit-token.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'out');
const OUT_JSON = join(OUT_DIR, 'day1-gate.json');
const SAMPLE_MS = Number(process.env.DAY1_SAMPLE_MS || 15000);
const CONNECT_TIMEOUT_MS = Number(process.env.DAY1_CONNECT_TIMEOUT_MS || 30000);

const LIVEKIT_PIN = {
  tag: 'v1.13.7',
  sha: '8d11efdfcd4220092b6ac7b8a21af28526da5a6b',
  image: 'livekit/livekit-server:v1.13.7',
  image_manifest_digest:
    'sha256:6fd3b7088874c4d119160dd688798dfec852bc014786d392caad15f6f63912a3',
  image_amd64_digest:
    'sha256:5d3dcc475d064536d9948ebe4eeab8e3b24d6f07a46f6d71a3415a2901bbdc52',
};

function pkgVersion(name) {
  try {
    const p = JSON.parse(
      readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'),
    );
    return p.version;
  } catch {
    return null;
  }
}

function startStaticServer() {
  const umdCandidates = [
    join(ROOT, 'node_modules/livekit-client/dist/livekit-client.umd.js'),
    join(ROOT, 'node_modules/livekit-client/dist/livekit-client.umd.cjs'),
    join(ROOT, 'node_modules/livekit-client/dist/livekit-client.min.js'),
  ];
  const umdPath = umdCandidates.find((p) => existsSync(p));
  if (!umdPath) {
    throw new Error(
      'livekit-client UMD bundle not found under node_modules — run npm install',
    );
  }
  const umd = readFileSync(umdPath);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>m1-act-day1</title></head>
<body>
<script src="/livekit-client.umd.js"></script>
<script>
  window.__M1 = { Room: null, rooms: {}, logs: [] };
  window.__m1Log = function(msg, extra) {
    const line = { t: Date.now(), msg: String(msg), extra: extra || null };
    window.__M1.logs.push(line);
    console.log('[m1]', msg, extra || '');
  };
  (function() {
    const g = window.LivekitClient || window.livekit || window.LiveKit;
    if (!g || !g.Room) {
      window.__m1Log('livekit-client global missing', Object.keys(window).filter(k => /live/i.test(k)));
      return;
    }
    window.__M1.Room = g.Room;
    window.__M1.RoomEvent = g.RoomEvent;
    window.__M1.createLocalTracks = g.createLocalTracks;
    window.__M1.Track = g.Track;
    window.__m1Log('livekit-client ready', { version: g.version || null });
  })();
</script>
</body></html>`;

  const server = createServer((req, res) => {
    if (req.url === '/livekit-client.umd.js') {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
      });
      res.end(umd);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function probeLiveKit(url) {
  const httpUrl = url.replace(/^ws/, 'http');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(httpUrl, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    return { ok: !!(r && (r.ok || r.status === 200 || r.status === 404 || r.status === 401)), status: r?.status ?? null };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Page helpers injected via evaluate — keep serializable.
 */
async function connectPeer(page, { role, url, token, roomName }) {
  return page.evaluate(
    async ({ role, url, token, roomName }) => {
      const Room = window.__M1.Room;
      if (!Room) throw new Error('LiveKit Room constructor missing');
      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
        // Prefer single PC when available so pub+sub share one connection.
      });
      window.__M1.rooms[role] = room;
      await room.connect(url, token);
      window.__m1Log(`${role} connected`, {
        room: room.name,
        sid: room.localParticipant?.sid,
        serverVersion: room.engine?.serverVersion || null,
      });
      return {
        roomName: room.name,
        identity: room.localParticipant?.identity,
        serverVersion: room.engine?.serverVersion || null,
      };
    },
    { role, url, token, roomName },
  );
}

async function publishFakeMedia(page, videoOnly = false) {
  return page.evaluate(async (videoOnly) => {
    const room = window.__M1.rooms.publisher;
    const createLocalTracks = window.__M1.createLocalTracks;
    if (!room || !createLocalTracks) throw new Error('publisher room not ready');
    const tracks = await createLocalTracks({
      audio: !videoOnly,
      video: { resolution: { width: 640, height: 360, frameRate: 15 } },
    });
    const pubs = [];
    for (const t of tracks) {
      const pub = await room.localParticipant.publishTrack(t);
      pubs.push({
        kind: t.kind,
        sid: pub?.trackSid || null,
        source: t.source,
      });
    }
    window.__m1Log('published tracks', pubs);
    return pubs;
  }, videoOnly);
}

async function tryEnableAct(page, role) {
  const enableFn = enableActOnTransceiversSource();
  return page.evaluate(
    async ({ role, actUri, enableFnSource }) => {
      // eslint-disable-next-line no-new-func
      const enableActOnTransceivers = new Function(
        'return (' + enableFnSource + ')',
      )();
      const room = window.__M1.rooms[role];
      if (!room) return { error: 'room missing' };
      const engine = room.engine;
      const pcm = engine?.pcManager;
      const publisher = pcm?.publisher;
      const subscriber = pcm?.subscriber;
      const out = {
        hasEngine: !!engine,
        hasPcManager: !!pcm,
        hasPublisherTransport: !!publisher,
        hasSubscriberTransport: !!subscriber,
        publisher: null,
        subscriber: null,
        localSdpHasAct: false,
        remoteSdpHasAct: false,
        notes: [],
      };
      if (publisher) {
        out.publisher = enableActOnTransceivers(publisher, actUri);
        try {
          const local = publisher.getLocalDescription?.()?.sdp || '';
          const remote = publisher.getRemoteDescription?.()?.sdp || '';
          out.localSdpHasAct = local.includes(actUri);
          out.remoteSdpHasAct = remote.includes(actUri);
        } catch (e) {
          out.notes.push('publisher SDP read: ' + String(e));
        }
      } else {
        out.notes.push('publisher PCTransport not exposed via room.engine.pcManager');
      }
      if (subscriber) {
        out.subscriber = enableActOnTransceivers(subscriber, actUri);
        try {
          const local = subscriber.getLocalDescription?.()?.sdp || '';
          const remote = subscriber.getRemoteDescription?.()?.sdp || '';
          out.localSdpHasAct =
            out.localSdpHasAct || local.includes(actUri);
          out.remoteSdpHasAct =
            out.remoteSdpHasAct || remote.includes(actUri);
        } catch (e) {
          out.notes.push('subscriber SDP read: ' + String(e));
        }
      }
      // Also try renegotiate after setting desired extensions (best-effort).
      try {
        if (engine?.negotiate) {
          await engine.negotiate();
          out.notes.push('engine.negotiate() after ACT desire set');
        }
      } catch (e) {
        out.notes.push('negotiate after ACT: ' + String(e && e.message ? e.message : e));
      }
      // Re-read negotiated after renegotiation attempt.
      if (publisher) {
        out.publisherAfter = enableActOnTransceivers(publisher, actUri);
      }
      if (subscriber) {
        out.subscriberAfter = enableActOnTransceivers(subscriber, actUri);
      }
      return out;
    },
    { role, actUri: ACT_URI, enableFnSource: enableFn },
  );
}

async function waitForRemoteTrack(page, timeoutMs) {
  return page.evaluate(async (timeoutMs) => {
    const room = window.__M1.rooms.subscriber;
    if (!room) throw new Error('subscriber room missing');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.isSubscribed && pub.track && pub.track.kind === 'video') {
            return {
              kind: pub.track.kind,
              sid: pub.trackSid,
              participant: p.identity,
            };
          }
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // fallback: any audio
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.isSubscribed && pub.track) {
          return {
            kind: pub.track.kind,
            sid: pub.trackSid,
            participant: p.identity,
          };
        }
      }
    }
    return null;
  }, timeoutMs);
}

async function sampleCaptureTimestamps(page, durationMs) {
  return page.evaluate(async (durationMs) => {
    const room = window.__M1.rooms.subscriber;
    const samples = [];
    const notes = [];
    const deadline = Date.now() + durationMs;
    let rttMs = null;

    const collectOnce = () => {
      const engine = room?.engine;
      const transports = [engine?.pcManager?.subscriber, engine?.pcManager?.publisher].filter(
        Boolean,
      );
      // Prefer receivers on tracks we know about.
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          const track = pub.track;
          if (!track) continue;
          // LiveKit RemoteTrack may expose mediaStreamTrack; receiver via engine.
          let receiver = null;
          try {
            // Walk PCTransport receivers matching track id.
            for (const transport of transports) {
              const pcs = transport;
              const receivers =
                typeof pcs.getReceivers === 'function'
                  ? pcs.getReceivers()
                  : pcs._pc?.getReceivers?.() || [];
              // PCTransport does not expose getReceivers publicly — dig via getTransceivers.
              const trx =
                typeof pcs.getTransceivers === 'function'
                  ? pcs.getTransceivers()
                  : [];
              for (const t of trx) {
                const r = t.receiver;
                if (
                  r &&
                  r.track &&
                  track.mediaStreamTrack &&
                  r.track.id === track.mediaStreamTrack.id
                ) {
                  receiver = r;
                  break;
                }
              }
              if (receiver) break;
            }
          } catch (e) {
            notes.push('receiver walk: ' + String(e));
          }
          if (!receiver || typeof receiver.getSynchronizationSources !== 'function') {
            continue;
          }
          const sources = receiver.getSynchronizationSources() || [];
          for (const s of sources) {
            samples.push({
              t_wall_ms: Date.now(),
              trackKind: track.kind,
              trackSid: pub.trackSid,
              source: s.source,
              rtpTimestamp: s.rtpTimestamp,
              timestamp: s.timestamp,
              captureTimestamp:
                s.captureTimestamp !== undefined ? s.captureTimestamp : null,
              senderCaptureTimeOffset:
                s.senderCaptureTimeOffset !== undefined
                  ? s.senderCaptureTimeOffset
                  : null,
              hasCaptureTimestamp:
                s.captureTimestamp !== undefined && s.captureTimestamp !== null,
            });
          }
        }
      }
    };

    // Optional negative-control RTT via getStats (not used for verdict).
    try {
      const transport =
        room.engine?.pcManager?.subscriber || room.engine?.pcManager?.publisher;
      const stats = await transport?.getStats?.();
      if (stats) {
        stats.forEach((v) => {
          if (v.type === 'candidate-pair' && (v.nominated || v.selected) && v.currentRoundTripTime != null) {
            rttMs = Math.round(v.currentRoundTripTime * 1000);
          }
        });
      }
    } catch (e) {
      notes.push('rtt getStats: ' + String(e));
    }

    while (Date.now() < deadline) {
      collectOnce();
      await new Promise((r) => setTimeout(r, 250));
    }
    collectOnce();
    return {
      samples,
      notes,
      rtt_ms_negative_control: rttMs,
      captureTimestamp_seen: samples.some((s) => s.hasCaptureTimestamp),
    };
  }, durationMs);
}

function negotiatedFromActReport(report) {
  if (!report) return false;
  const blocks = [report.publisher, report.subscriber, report.publisherAfter, report.subscriberAfter].filter(
    Boolean,
  );
  for (const b of blocks) {
    for (const r of b.results || []) {
      if (r.actNegotiated === true) return true;
      if (r.negotiated?.some((e) => e.uri === ACT_URI)) return true;
    }
  }
  if (report.localSdpHasAct || report.remoteSdpHasAct) return true;
  return false;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const notes = [];
  const startedAt = new Date().toISOString();
  let verdict = 'APPARATUS_ERROR';
  let browserVersion = null;
  let livekitVersion = LIVEKIT_PIN.tag;
  let negotiatedPublisher = false;
  let negotiatedSubscriber = false;
  let captureTimestampSeen = false;
  let samples = [];
  let apparatusError = null;
  let pubAct = null;
  let subAct = null;
  let rttMs = null;
  let serverProbe = null;

  const resultBase = () => ({
    schema: 'm1-day1-gate/v1',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    livekit_version: livekitVersion,
    livekit_pin_sha: LIVEKIT_PIN.sha,
    livekit_image: LIVEKIT_PIN.image,
    livekit_image_manifest_digest: LIVEKIT_PIN.image_manifest_digest,
    browser_version: browserVersion,
    playwright_version: pkgVersion('playwright'),
    livekit_client_version: pkgVersion('livekit-client'),
    act_uri: ACT_URI,
    room: ROOM_NAME,
    livekit_url: LIVEKIT_URL,
    policy: 'stock_rewrite',
    pr_4812_applied: false,
    negotiated_publisher: negotiatedPublisher,
    negotiated_subscriber: negotiatedSubscriber,
    captureTimestamp_seen: captureTimestampSeen,
    samples,
    rtt_ms_negative_control: rttMs,
    c0_stub: {
      status: 'placeholder',
      note: 'C0 rewrite sanity metrics (bias/sync) not collected on Day-1 gate',
    },
    pcap_hook_stub: {
      status: 'stub',
      note: 'Optional: tcpdump -i lo -w out/day1.pcap port 7881 or udp portrange 50000-50100',
    },
    act_reports: { publisher: pubAct, subscriber: subAct },
    server_probe: serverProbe,
    verdict,
    notes,
  });

  const writeOut = () => {
    const payload = resultBase();
    writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
    return payload;
  };

  try {
    serverProbe = await probeLiveKit(LIVEKIT_URL);
    if (!serverProbe.ok) {
      apparatusError = `LiveKit not reachable at ${LIVEKIT_URL} (probe=${JSON.stringify(serverProbe)}). Start via scripts/run-day1.sh or docker compose / bin/livekit-server.`;
      notes.push(apparatusError);
      verdict = 'APPARATUS_ERROR';
      const out = writeOut();
      console.log(JSON.stringify({ verdict: out.verdict, out: OUT_JSON, notes }, null, 2));
      process.exitCode = 2;
      return;
    }
    notes.push(`LiveKit probe ok at ${LIVEKIT_URL}`);

    const { server, origin } = await startStaticServer();
    notes.push(`static harness at ${origin}`);

    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
          '--disable-features=WebRtcHideLocalIpsWithMdns',
        ],
      });
      browserVersion = browser.version();
      notes.push(`Chromium ${browserVersion}`);

      const context = await browser.newContext();
      const pubPage = await context.newPage();
      const subPage = await context.newPage();
      const redact = (s) =>
        String(s)
          .replace(/access_token=[^&\s]+/gi, 'access_token=%3Credacted%3E')
          .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt-redacted>');
      pubPage.on('console', (m) => {
        const t = redact(m.text());
        if (t.length > 500) notes.push(`[pub] ${t.slice(0, 500)}…`);
        else notes.push(`[pub] ${t}`);
      });
      subPage.on('console', (m) => {
        const t = redact(m.text());
        if (t.length > 500) notes.push(`[sub] ${t.slice(0, 500)}…`);
        else notes.push(`[sub] ${t}`);
      });

      await pubPage.goto(origin, { waitUntil: 'domcontentloaded' });
      await subPage.goto(origin, { waitUntil: 'domcontentloaded' });

      const pubToken = await mintToken('day1-publisher', {
        canPublish: true,
        canSubscribe: true,
      });
      const subToken = await mintToken('day1-subscriber', {
        canPublish: false,
        canSubscribe: true,
      });

      const pubInfo = await connectPeer(pubPage, {
        role: 'publisher',
        url: LIVEKIT_URL,
        token: pubToken,
        roomName: ROOM_NAME,
      });
      const subInfo = await connectPeer(subPage, {
        role: 'subscriber',
        url: LIVEKIT_URL,
        token: subToken,
        roomName: ROOM_NAME,
      });
      if (pubInfo.serverVersion) livekitVersion = pubInfo.serverVersion;
      notes.push(`publisher joined serverVersion=${pubInfo.serverVersion}`);
      notes.push(`subscriber joined serverVersion=${subInfo.serverVersion}`);

      // Enable ACT desire before publish (and again after).
      pubAct = await tryEnableAct(pubPage, 'publisher');
      subAct = await tryEnableAct(subPage, 'subscriber');

      const pubs = await publishFakeMedia(pubPage, process.env.DAY1_VIDEO_ONLY === '1');
      notes.push(`published: ${JSON.stringify(pubs)}`);

      // Re-enable after publish so sendonly transceiver exists.
      const pubAct2 = await tryEnableAct(pubPage, 'publisher');
      pubAct = { first: pubAct, afterPublish: pubAct2 };

      const remote = await waitForRemoteTrack(subPage, CONNECT_TIMEOUT_MS);
      if (!remote) {
        notes.push('WARNING: no remote track subscribed within timeout — continuing SSSRC poll');
      } else {
        notes.push(`subscribed remote track: ${JSON.stringify(remote)}`);
      }

      const subAct2 = await tryEnableAct(subPage, 'subscriber');
      subAct = { first: subAct, afterSubscribe: subAct2 };

      negotiatedPublisher =
        negotiatedFromActReport(pubAct2) ||
        negotiatedFromActReport(pubAct.first) ||
        sdpHasAct(JSON.stringify(pubAct));
      negotiatedSubscriber =
        negotiatedFromActReport(subAct2) ||
        negotiatedFromActReport(subAct.first);

      // Heuristic: LiveKit server advertises ACT in config — SDP extmap presence counts.
      if (!negotiatedPublisher && pubAct2?.localSdpHasAct) negotiatedPublisher = true;
      if (!negotiatedPublisher && pubAct2?.remoteSdpHasAct) negotiatedPublisher = true;
      if (!negotiatedSubscriber && subAct2?.localSdpHasAct) negotiatedSubscriber = true;
      if (!negotiatedSubscriber && subAct2?.remoteSdpHasAct) negotiatedSubscriber = true;

      notes.push(
        `negotiated_publisher=${negotiatedPublisher} negotiated_subscriber=${negotiatedSubscriber}`,
      );
      notes.push(`sampling captureTimestamp for ${SAMPLE_MS}ms`);

      const sampleResult = await sampleCaptureTimestamps(subPage, SAMPLE_MS);
      samples = (sampleResult.samples || []).slice(0, 50);
      captureTimestampSeen = !!sampleResult.captureTimestamp_seen;
      rttMs = sampleResult.rtt_ms_negative_control;
      if (sampleResult.notes?.length) notes.push(...sampleResult.notes.map((n) => `sample: ${n}`));

      verdict = decideVerdict({
        negotiatedPublisher,
        negotiatedSubscriber,
        captureTimestampSeen,
        apparatusError: null,
      });
    } finally {
      try {
        await browser?.close();
      } catch {}
      try {
        server.close();
      } catch {}
    }
  } catch (e) {
    apparatusError = String(e && e.stack ? e.stack : e);
    notes.push('FATAL: ' + apparatusError);
    verdict = 'APPARATUS_ERROR';
  }

  const out = writeOut();
  console.log('--- Day-1 gate ---');
  console.log(`verdict: ${out.verdict}`);
  console.log(`livekit_version: ${out.livekit_version}`);
  console.log(`browser_version: ${out.browser_version}`);
  console.log(`negotiated_publisher: ${out.negotiated_publisher}`);
  console.log(`negotiated_subscriber: ${out.negotiated_subscriber}`);
  console.log(`captureTimestamp_seen: ${out.captureTimestamp_seen}`);
  console.log(`samples: ${out.samples.length}`);
  console.log(`wrote: ${OUT_JSON}`);
  if (verdict === 'PASS_ACT_EXPOSED') process.exitCode = 0;
  else if (verdict === 'APPARATUS_ERROR') process.exitCode = 2;
  else process.exitCode = 1;
}

main();
