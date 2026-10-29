#!/usr/bin/env node
/**
 * C1/C3 staggered A/V sync_err (epsilon arm).
 * Pion A+V: video ACT=wall_now-delta; audio ACT=wall_now-delta+av_offset_ms.
 * Chrome subscriber SSSRC captureTimestamp + RVFC; C0_ACT_FORCE_EXT_ID=8.
 * Prereg epsilon=40 / tau_b=10 LOCKED.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ACT_URI, enableActOnTransceiversSource } from './act.mjs';
import { mintToken, LIVEKIT_URL } from './livekit-token.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = process.env.M1_OUT_DIR || join(ROOT, 'out');
const SAMPLE_MS = Number(process.env.C0_SAMPLE_MS || 12000);
const CONNECT_TIMEOUT_MS = Number(process.env.C0_CONNECT_TIMEOUT_MS || 30000);
const ROOM_NAME = process.env.LIVEKIT_ROOM || 'm1-act-c1';
const TAU_B_MS = 10;
const EPS_MS = 40;
const NTP_EPOCH_OFFSET_MS = 2208988800000;
const PUBLISHER_MODE = (process.env.C0_PUBLISHER || 'pion').toLowerCase();
const DELTA_MS = process.env.C0_DELTA_MS != null ? Number(process.env.C0_DELTA_MS) : 0;
const INJECT_LOG_PATH = process.env.C0_INJECT_LOG || join(OUT_DIR, `c0-inject-d${Number.isFinite(DELTA_MS) ? DELTA_MS : 0}.jsonl`);
/** Force Chrome ACT extmap id (pion path). LiveKit downtrack uses GetParameters id≈8. */
const ACT_FORCE_EXT_ID = process.env.C0_ACT_FORCE_EXT_ID != null ? Number(process.env.C0_ACT_FORCE_EXT_ID) : 8;
const PION_IDENTITY_PREFIX = process.env.C0_PION_IDENTITY_PREFIX || 'c1-pion';
/** Policy label for JSON: stock_rewrite | verbatim */
const POLICY = (process.env.C0_POLICY || 'stock_rewrite').toLowerCase();
const PR_4812_APPLIED = String(process.env.C0_PR_4812_APPLIED || 'false').toLowerCase() === 'true';
const AV_OFFSET_MS = process.env.C1_AV_OFFSET_MS != null ? Number(process.env.C1_AV_OFFSET_MS) : 0;
const STAGGER_START_MS = process.env.C1_STAGGER_START_MS != null ? Number(process.env.C1_STAGGER_START_MS) : 0;
const CELL_ID = process.env.C1_CELL_ID || (POLICY === 'verbatim' ? 'C3' : 'C1');
const OUT_PREFIX = process.env.C0_OUT_PREFIX || (POLICY === 'verbatim' ? 'c1-verbatim' : 'c1-rewrite');
const TRIAL_PREFIX = process.env.C0_TRIAL_PREFIX || (POLICY === 'verbatim' ? 'c1-verbatim-trial' : 'c1-trial');
function resolveOutPath(envVal, defaultName) {
  if (!envVal) return join(OUT_DIR, defaultName);
  // Absolute path as-is; relative names land under out/
  if (envVal.startsWith('/')) return envVal;
  return join(OUT_DIR, envVal);
}
const OUT_JSON = resolveOutPath(process.env.C0_OUT_JSON, `${OUT_PREFIX}-av-sync.json`);

const LIVEKIT_PIN = {
  tag: 'v1.13.7',
  sha: '8d11efdfcd4220092b6ac7b8a21af28526da5a6b',
  image: 'livekit/livekit-server:v1.13.7',
};

function pkgVersion(name) {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

function captureTsToUnixMs(ct, wallNowMs) {
  if (ct == null || !Number.isFinite(ct)) return null;
  if (ct > wallNowMs + 365 * 24 * 3600 * 1000) return ct - NTP_EPOCH_OFFSET_MS;
  if (Math.abs(ct - wallNowMs) < 365 * 24 * 3600 * 1000) return ct;
  return ct - NTP_EPOCH_OFFSET_MS;
}

function startStaticServer() {
  const umdCandidates = [
    join(ROOT, 'node_modules/livekit-client/dist/livekit-client.umd.js'),
    join(ROOT, 'node_modules/livekit-client/dist/livekit-client.umd.cjs'),
  ];
  const umdPath = umdCandidates.find((p) => existsSync(p));
  if (!umdPath) throw new Error('livekit-client UMD missing');
  const umd = readFileSync(umdPath);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>m1-act-c1</title></head>
<body>
<video id="v" autoplay playsinline muted></video>
<audio id="a" autoplay></audio>
<script src="/livekit-client.umd.js"></script>
<script>
  window.__M1 = { Room: null, rooms: {}, logs: [], injectLog: [] };
  window.__m1Log = function(msg, extra) {
    window.__M1.logs.push({ t: Date.now(), msg: String(msg), extra: extra || null });
    console.log('[m1-c1]', msg, extra || '');
  };
  // Pion-path apparatus: force ACT extmap id so Chrome matches SFU GetParameters/wire id.
  window.__M1.installActIdMunge = function(actUri, forceId) {
    const munge = (sdp) => {
      if (!sdp || typeof sdp !== 'string') return sdp;
      const nl = sdp.includes('\\r\\n') ? '\\r\\n' : '\\n';
      return sdp.split(/\\r?\\n/).map((line) => {
        if (line.includes('extmap:') && line.includes(actUri)) {
          return line.replace(/extmap:\\d+/, 'extmap:' + forceId);
        }
        return line;
      }).join(nl);
    };
    const wrap = (orig) => async function(desc) {
      if (desc && desc.sdp) {
        const sdp = munge(desc.sdp);
        desc = desc instanceof RTCSessionDescription
          ? new RTCSessionDescription({ type: desc.type, sdp })
          : { ...desc, sdp };
      }
      return orig.apply(this, [desc]);
    };
    const P = RTCPeerConnection.prototype;
    if (!P.__m1ActMunge) {
      P.setLocalDescription = wrap(P.setLocalDescription);
      P.setRemoteDescription = wrap(P.setRemoteDescription);
      P.__m1ActMunge = true;
      window.__m1Log('ACT extmap id munge installed', { forceId, actUri });
    }
  };
  (function() {
    const g = window.LivekitClient || window.livekit || window.LiveKit;
    if (!g || !g.Room) return;
    window.__M1.Room = g.Room;
    window.__M1.RoomEvent = g.RoomEvent;
    window.__M1.createLocalTracks = g.createLocalTracks;
    window.__m1Log('ready', { version: g.version || null });
  })();
</script>
</body></html>`;
  const server = createServer((req, res) => {
    if (req.url === '/livekit-client.umd.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(umd);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
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
    return { ok: !!(r && (r.ok || [200, 401, 404].includes(r.status))) };
  } catch {
    return { ok: false };
  }
}

async function connectPeer(page, { role, url, token }) {
  return page.evaluate(
    async ({ role, url, token }) => {
      const Room = window.__M1.Room;
      const room = new Room({ adaptiveStream: false, dynacast: false });
      window.__M1.rooms[role] = room;
      await room.connect(url, token);
      window.__m1Log(`${role} connected`, {
        room: room.name,
        sid: room.localParticipant?.sid,
        serverVersion: room.engine?.serverVersion || null,
      });
      return { serverVersion: room.engine?.serverVersion || null };
    },
    { role, url, token },
  );
}

async function publishWithInject(page, deltaInjectMs) {
  return page.evaluate(async (deltaInjectMs) => {
    const room = window.__M1.rooms.publisher;
    const createLocalTracks = window.__M1.createLocalTracks;
    const tracks = await createLocalTracks({
      audio: true,
      video: { resolution: { width: 640, height: 360, frameRate: 15 } },
    });
    window.__M1.injectLog = [];
    window.__M1.deltaInjectMs = deltaInjectMs;
    // Wall-clock inject marks: t_inject_wall = now + Δ_inject so
    // (t_inject_wall − Δ_inject) = now ≈ true capture wall (Chrome ACT stamp).
    window.__M1._injectTimer = setInterval(() => {
      const tCaptureTrue = Date.now();
      window.__M1.injectLog.push({
        t_capture_true_ms: tCaptureTrue,
        t_inject_wall_ms: tCaptureTrue + deltaInjectMs,
        delta_inject_ms: deltaInjectMs,
      });
      if (window.__M1.injectLog.length > 4000) window.__M1.injectLog.splice(0, 1000);
    }, 50);
    const pubs = [];
    for (const t of tracks) {
      const pub = await room.localParticipant.publishTrack(t);
      pubs.push({ kind: t.kind, sid: pub?.trackSid || null });
    }
    window.__m1Log('published', { pubs, deltaInjectMs });
    return pubs;
  }, deltaInjectMs);
}

async function tryEnableAct(page, role) {
  const enableFn = enableActOnTransceiversSource();
  return page.evaluate(
    async ({ role, actUri, enableFnSource }) => {
      const enableActOnTransceivers = new Function('return (' + enableFnSource + ')')();
      const room = window.__M1.rooms[role];
      const engine = room.engine;
      const pcm = engine?.pcManager;
      const out = {
        hasPcManager: !!pcm,
        hasPublisherTransport: !!pcm?.publisher,
        hasSubscriberTransport: !!pcm?.subscriber,
        publisher: null,
        subscriber: null,
        localSdpHasAct: false,
        remoteSdpHasAct: false,
        notes: [],
      };
      for (const [name, transport] of [
        ['publisher', pcm?.publisher],
        ['subscriber', pcm?.subscriber],
      ]) {
        if (!transport) continue;
        out[name] = enableActOnTransceivers(transport, actUri);
        try {
          const local = transport.getLocalDescription?.()?.sdp || '';
          const remote = transport.getRemoteDescription?.()?.sdp || '';
          out.localSdpHasAct = out.localSdpHasAct || local.includes(actUri);
          out.remoteSdpHasAct = out.remoteSdpHasAct || remote.includes(actUri);
        } catch (e) {
          out.notes.push(name + ' sdp: ' + String(e));
        }
      }
      try {
        if (engine?.negotiate) {
          await engine.negotiate();
          out.notes.push('negotiate ok');
        }
      } catch (e) {
        out.notes.push('negotiate: ' + String(e && e.message ? e.message : e));
      }
      if (pcm?.publisher) out.publisherAfter = enableActOnTransceivers(pcm.publisher, actUri);
      if (pcm?.subscriber) out.subscriberAfter = enableActOnTransceivers(pcm.subscriber, actUri);
      return out;
    },
    { role, actUri: ACT_URI, enableFnSource: enableFn },
  );
}

async function waitForRemoteAV(page, timeoutMs, identityPrefix = null) {
  return page.evaluate(
    async ({ timeoutMs, identityPrefix }) => {
      const room = window.__M1.rooms.subscriber;
      const deadline = Date.now() + timeoutMs;
      const found = { video: null, audio: null };
      while (Date.now() < deadline) {
        for (const p of room.remoteParticipants.values()) {
          if (identityPrefix && !String(p.identity || '').includes(identityPrefix)) continue;
          for (const pub of p.trackPublications.values()) {
            if (!(pub.isSubscribed && pub.track)) continue;
            if (pub.track.kind === 'video' && !found.video) {
              const el = document.getElementById('v');
              if (el) pub.track.attach(el);
              found.video = { kind: 'video', sid: pub.trackSid, participant: p.identity };
            }
            if (pub.track.kind === 'audio' && !found.audio) {
              const el = document.getElementById('a');
              if (el) pub.track.attach(el);
              found.audio = { kind: 'audio', sid: pub.trackSid, participant: p.identity };
            }
          }
        }
        if (found.video && found.audio) return found;
        await new Promise((r) => setTimeout(r, 200));
      }
      return found;
    },
    { timeoutMs, identityPrefix },
  );
}

function loadPionInjectEvents(path, deltaInjectMs) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      out.push({
        t_inject_wall_ms: e.t_inject_wall_ms,
        delta_inject_ms: e.delta_inject_ms ?? deltaInjectMs,
        av_offset_ms: e.av_offset_ms ?? null,
        track_kind: e.track_kind || null,
        // Pairing uses t_capture_true ~ stamped ACT capture.
        t_capture_true_ms: e.capture_unix_ms ?? null,
        capture_unix_ms: e.capture_unix_ms ?? null,
        rtp_timestamp: e.rtp_timestamp,
        ssrc: e.ssrc,
        act_id: e.act_id,
        set_error: e.set_error || null,
      });
    } catch {}
  }
  return out;
}

async function sampleBiasWindow(page, durationMs) {
  return page.evaluate(async (durationMs) => {
    const room = window.__M1.rooms.subscriber;
    const videoEl = document.getElementById('v');
    const samples = [];
    const notes = [];
    let rttMs = null;
    const deadline = Date.now() + durationMs;

    const findReceiver = (track) => {
      const transports = [room.engine?.pcManager?.subscriber, room.engine?.pcManager?.publisher].filter(Boolean);
      for (const transport of transports) {
        for (const t of transport.getTransceivers?.() || []) {
          const r = t.receiver;
          if (r?.track && track?.mediaStreamTrack && r.track.id === track.mediaStreamTrack.id) return r;
        }
      }
      return null;
    };

    try {
      const transport = room.engine?.pcManager?.subscriber || room.engine?.pcManager?.publisher;
      const stats = await transport?.getStats?.();
      if (stats) {
        stats.forEach((v) => {
          if (v.type === 'candidate-pair' && (v.nominated || v.selected) && v.currentRoundTripTime != null) {
            rttMs = Math.round(v.currentRoundTripTime * 1000);
          }
        });
      }
    } catch (e) {
      notes.push('rtt: ' + String(e));
    }

    const poll = (tPlayout, source) => {
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          const track = pub.track;
          if (!track) continue;
          const receiver = findReceiver(track);
          if (!receiver?.getSynchronizationSources) continue;
          for (const s of receiver.getSynchronizationSources() || []) {
            samples.push({
              source_mark: source,
              t_playout_wall_ms: tPlayout,
              trackKind: track.kind,
              trackSid: pub.trackSid,
              rtpTimestamp: s.rtpTimestamp,
              captureTimestamp_raw: s.captureTimestamp ?? null,
              hasCaptureTimestamp: s.captureTimestamp != null,
            });
          }
        }
      }
    };

    let rvfcCount = 0;
    const rvfcSupported = typeof videoEl?.requestVideoFrameCallback === 'function';
    let stopped = false;
    if (rvfcSupported) {
      const onFrame = () => {
        if (stopped || Date.now() >= deadline) return;
        poll(Date.now(), 'rvfc');
        rvfcCount++;
        try {
          videoEl.requestVideoFrameCallback(onFrame);
        } catch {}
      };
      videoEl.requestVideoFrameCallback(onFrame);
    }

    while (Date.now() < deadline) {
      poll(Date.now(), 'timer');
      await new Promise((r) => setTimeout(r, 100));
    }
    stopped = true;
    const ctByKind = { audio: 0, video: 0, other: 0 };
    const sampleByKind = { audio: 0, video: 0, other: 0 };
    for (const s of samples) {
      const k = s.trackKind === 'audio' || s.trackKind === 'video' ? s.trackKind : 'other';
      sampleByKind[k]++;
      if (s.hasCaptureTimestamp) ctByKind[k]++;
    }
    return {
      samples,
      notes,
      rtt_ms_negative_control: rttMs,
      rvfc_supported: rvfcSupported,
      rvfc_count: rvfcCount,
      captureTimestamp_seen: samples.some((s) => s.hasCaptureTimestamp),
      captureTimestamp_audio_seen: ctByKind.audio > 0,
      captureTimestamp_video_seen: ctByKind.video > 0,
      ct_by_kind: ctByKind,
      sample_by_kind: sampleByKind,
    };
  }, durationMs);
}

async function dumpInject(page) {
  return page.evaluate(() => (window.__M1.injectLog || []).slice());
}

function computeBias(collect, injectEvents, deltaInjectMs) {
  const biases = [];
  const paired = [];
  const syncErrs = [];
  const byKind = { audio: [], video: [] };
  const wallRef = Date.now();

  for (const s of collect.samples || []) {
    if (!s.hasCaptureTimestamp) continue;
    const tCap = captureTsToUnixMs(s.captureTimestamp_raw, s.t_playout_wall_ms || wallRef);
    if (tCap == null) continue;

    // Nearest inject mark by capture_true ≈ ACT capture (same host / chrome stamp).
    let best = null;
    let bestDist = Infinity;
    for (const ev of injectEvents) {
      const truth = ev.t_capture_true_ms;
      if (truth == null) continue;
      const d = Math.abs(truth - tCap);
      if (d < bestDist) {
        bestDist = d;
        best = ev;
      }
    }
    if (!best) {
      // Fallback: nearest playout to inject wall
      for (const ev of injectEvents) {
        const d = Math.abs((ev.t_inject_wall_ms || 0) - s.t_playout_wall_ms);
        if (d < bestDist) {
          bestDist = d;
          best = ev;
        }
      }
    }
    if (!best) continue;

    const tInjectWall = best.t_inject_wall_ms;
    const dInj = best.delta_inject_ms ?? deltaInjectMs;
    const tPlayout = s.t_playout_wall_ms;
    const Lhat = tPlayout - tCap;
    const Lstar = tPlayout - (tInjectWall - dInj);
    const b = Lhat - Lstar;
    const row = {
      trackKind: s.trackKind,
      t_playout_wall_ms: tPlayout,
      t_capture_from_ACT_unix_ms: tCap,
      captureTimestamp_raw: s.captureTimestamp_raw,
      t_inject_wall_ms: tInjectWall,
      delta_inject_ms: dInj,
      match_dist_ms: bestDist,
      Lhat_ms: Lhat,
      Lstar_ms: Lstar,
      bias_ms: b,
      source_mark: s.source_mark,
    };
    paired.push(row);
    biases.push(b);
    if (byKind[s.trackKind]) byKind[s.trackKind].push(row);
  }

  // sync_err from raw ACT samples (does not require inject pairing)
  const rawAV = { audio: [], video: [] };
  for (const s of collect.samples || []) {
    if (!s.hasCaptureTimestamp) continue;
    const tCap = captureTsToUnixMs(s.captureTimestamp_raw, s.t_playout_wall_ms || wallRef);
    if (tCap == null) continue;
    if (s.trackKind === 'audio' || s.trackKind === 'video') {
      rawAV[s.trackKind].push({ t_playout_wall_ms: s.t_playout_wall_ms, t_cap: tCap });
    }
  }
  if (rawAV.audio.length && rawAV.video.length) {
    for (const v of rawAV.video) {
      let bestA = null;
      let bestDt = Infinity;
      for (const a of rawAV.audio) {
        const dt = Math.abs(a.t_playout_wall_ms - v.t_playout_wall_ms);
        if (dt < bestDt) {
          bestDt = dt;
          bestA = a;
        }
      }
      if (bestA && bestDt <= 40) {
        syncErrs.push(bestA.t_cap - v.t_cap);
      }
    }
  }

  const medB = median(biases);
  const absMed = medB == null ? null : Math.abs(medB);
  const medSync = median(syncErrs);
  return {
    paired_n: paired.length,
    biases_ms: biases, // replication 2026-10-15: cap removed, every sample saved
    paired_preview: paired.slice(0, 5),
    paired_all: paired,
    median_bias_ms: medB,
    mean_bias_ms: mean(biases),
    abs_median_bias_ms: absMed,
    sync_err_ms: {
      available: syncErrs.length > 0,
      n: syncErrs.length,
      median: medSync,
      mean: mean(syncErrs),
      compared_to_eps_40ms: medSync == null ? null : Math.abs(medSync) <= EPS_MS,
      note: syncErrs.length ? null : 'insufficient A+V matched playout marks',
    },
    compared_to_tau_b_10ms: absMed == null ? null : absMed <= TAU_B_MS,
  };
}

function decideC1(trial) {
  const sync = trial?.metrics?.sync_err_ms;
  const ctA = !!trial?.captureTimestamp_audio_seen;
  const ctV = !!trial?.captureTimestamp_video_seen || !!trial?.captureTimestamp_seen;
  if (!ctV) return 'C1_APPARATUS_FAIL';
  if (!ctA || !sync?.available) {
    return 'C1_APPARATUS_PARTIAL_NO_AUDIO_ACT';
  }
  const absSync = sync.median == null ? null : Math.abs(sync.median);
  const absBias = trial?.metrics?.abs_median_bias_ms;
  const syncOk = absSync != null && absSync <= EPS_MS;
  const biasOk = absBias != null && absBias <= TAU_B_MS;
  if (absSync == null) return 'C1_INCONCLUSIVE';
  if (syncOk && (absBias == null || biasOk)) return 'C1_SYNC_WITHIN_EPS';
  if (!syncOk) return 'C1_SYNC_EXCEEDS_EPS';
  if (absBias != null && !biasOk) return 'C1_BIAS_EXCEEDS_TAU_B';
  return 'C1_INCONCLUSIVE';
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const notes = [];
  const startedAt = new Date().toISOString();
  const deltaInjectMs = Number.isFinite(DELTA_MS) ? DELTA_MS : 0;

  if (PUBLISHER_MODE === 'pion') {
    notes.push(`C0_PUBLISHER=pion — Chrome subscriber-only; inject log ${INJECT_LOG_PATH}; ACT extmap force id=${ACT_FORCE_EXT_ID}`);
  }

  const probe = await probeLiveKit(LIVEKIT_URL);
  if (!probe.ok) {
    const payload = {
      schema: 'm1-c1-av-sync/v1',
      verdict: 'C1_APPARATUS_FAIL',
      pr_4812_applied: PR_4812_APPLIED,
      policy: POLICY,
      notes: [`LiveKit unreachable at ${LIVEKIT_URL}`],
    };
    writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
    process.exitCode = 2;
    return;
  }

  const { server, origin } = await startStaticServer();
  let browser;
  let browserVersion = null;
  let livekitVersion = LIVEKIT_PIN.tag;
  let trial = {
    delta_inject_ms: deltaInjectMs,
    publisher_mode: PUBLISHER_MODE,
    captureTimestamp_seen: false,
    notes: [],
  };

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
    const redact = (s) =>
      String(s)
        .replace(/access_token=[^&\s]+/gi, 'access_token=REDACTED')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>');
    const subPage = await context.newPage();
    subPage.on('console', (m) => {
      const t = redact(m.text());
      if (t.length < 400) notes.push(`[sub] ${t}`);
    });
    await subPage.goto(origin, { waitUntil: 'domcontentloaded' });

    let injectEvents = [];
    let collect;

    if (PUBLISHER_MODE === 'pion') {
      // Wait for page bootstrap (__M1 + ACT munge helper), then install before connect.
      await subPage.waitForFunction(() => !!(window.__M1 && window.__M1.installActIdMunge), null, {
        timeout: 10000,
      });
      await subPage.evaluate(
        ({ actUri, forceId }) => {
          window.__M1.installActIdMunge(actUri, forceId);
        },
        { actUri: ACT_URI, forceId: ACT_FORCE_EXT_ID },
      );
      notes.push(`pion ACT extmap force id=${ACT_FORCE_EXT_ID}`);

      const subTok = await mintToken('c1-subscriber', {
        canPublish: false,
        canSubscribe: true,
        room: ROOM_NAME,
      });
      const subInfo = await connectPeer(subPage, { role: 'subscriber', url: LIVEKIT_URL, token: subTok });
      if (subInfo.serverVersion) livekitVersion = subInfo.serverVersion;
      notes.push(`subscriber serverVersion=${subInfo.serverVersion}`);

      // Single ACT enable+negotiate (avoid further renegotiate that desyncs SFU GetParameters).
      const actInfo = await tryEnableAct(subPage, 'subscriber');
      notes.push(`act_enable ${JSON.stringify({ localSdpHasAct: actInfo.localSdpHasAct, remoteSdpHasAct: actInfo.remoteSdpHasAct, notes: actInfo.notes })}`);

      const remote = await waitForRemoteAV(subPage, CONNECT_TIMEOUT_MS, PION_IDENTITY_PREFIX);
      notes.push(remote ? `subscribed AV ${JSON.stringify(remote)}` : 'WARNING: no remote pion A/V');
      if (!remote?.audio) notes.push('WARNING: audio track not subscribed — sync_err will be unavailable');
      if (!remote?.video) notes.push('WARNING: video track not subscribed');

      // Allow SFU SR-gate + ACT attach before sampling (rewrite path).
      await subPage.waitForTimeout(2500);
      notes.push(`sampling ${SAMPLE_MS}ms Δ_inject=${deltaInjectMs} publisher=pion (post-SR settle 2.5s)`);
      collect = await sampleBiasWindow(subPage, SAMPLE_MS);
      injectEvents = loadPionInjectEvents(INJECT_LOG_PATH, deltaInjectMs);
      notes.push(`pion inject events loaded n=${injectEvents.length} from ${INJECT_LOG_PATH}`);
      trial.act_force_ext_id = ACT_FORCE_EXT_ID;
      trial.inject_log_path = INJECT_LOG_PATH;
    } else {
      const pubPage = await context.newPage();
      pubPage.on('console', (m) => {
        const t = redact(m.text());
        if (t.length < 400) notes.push(`[pub] ${t}`);
      });
      await pubPage.goto(origin, { waitUntil: 'domcontentloaded' });

      const pubTok = await mintToken('c1-publisher', {
        canPublish: true,
        canSubscribe: true,
        room: ROOM_NAME,
      });
      const subTok = await mintToken('c1-subscriber', {
        canPublish: false,
        canSubscribe: true,
        room: ROOM_NAME,
      });

      const pubInfo = await connectPeer(pubPage, { role: 'publisher', url: LIVEKIT_URL, token: pubTok });
      const subInfo = await connectPeer(subPage, { role: 'subscriber', url: LIVEKIT_URL, token: subTok });
      if (pubInfo.serverVersion) livekitVersion = pubInfo.serverVersion;
      notes.push(`publisher serverVersion=${pubInfo.serverVersion}`);
      notes.push(`subscriber serverVersion=${subInfo.serverVersion}`);

      await tryEnableAct(pubPage, 'publisher');
      await tryEnableAct(subPage, 'subscriber');
      const pubs = await publishWithInject(pubPage, deltaInjectMs);
      notes.push(`published ${JSON.stringify(pubs)}`);
      await tryEnableAct(pubPage, 'publisher');

      const remote = await waitForRemoteAV(subPage, CONNECT_TIMEOUT_MS);
      notes.push(remote ? `subscribed AV ${JSON.stringify(remote)}` : 'WARNING: no remote A/V');
      await tryEnableAct(subPage, 'subscriber');

      notes.push(`sampling ${SAMPLE_MS}ms Δ_inject=${deltaInjectMs}`);
      collect = await sampleBiasWindow(subPage, SAMPLE_MS);
      injectEvents = await dumpInject(pubPage);
      writeFileSync(
        join(OUT_DIR, `c0-inject-d${deltaInjectMs}.jsonl`),
        injectEvents.map((e) => JSON.stringify(e)).join('\n') + (injectEvents.length ? '\n' : ''),
      );
    }

    trial.captureTimestamp_seen = !!collect.captureTimestamp_seen;
    trial.captureTimestamp_audio_seen = !!collect.captureTimestamp_audio_seen;
    trial.captureTimestamp_video_seen = !!collect.captureTimestamp_video_seen;
    trial.ct_by_kind = collect.ct_by_kind || null;
    trial.sample_by_kind = collect.sample_by_kind || null;
    trial.av_offset_ms = AV_OFFSET_MS;
    trial.stagger_start_ms = STAGGER_START_MS;
    trial.cell_id = CELL_ID;
    trial.rtt_ms_negative_control = collect.rtt_ms_negative_control;
    trial.rvfc = { supported: collect.rvfc_supported, count: collect.rvfc_count };
    trial.sample_n = (collect.samples || []).length;
    trial.ct_sample_n = (collect.samples || []).filter((s) => s.hasCaptureTimestamp).length;
    trial.inject_event_n = injectEvents.length;
    trial.raw_samples = collect.samples || [];
    trial.inject_by_kind = (() => {
      const c = { audio: 0, video: 0, other: 0 };
      for (const e of injectEvents) {
        const k = e.track_kind === 'audio' || e.track_kind === 'video' ? e.track_kind : 'other';
        c[k]++;
      }
      return c;
    })();
    trial.sample_preview = (collect.samples || []).filter((s) => s.hasCaptureTimestamp).slice(0, 3);
    if (!trial.sample_preview.length) trial.sample_preview = (collect.samples || []).slice(0, 3);
    trial.metrics = computeBias(collect, injectEvents, deltaInjectMs);
    // Primary bias for tau_b: VIDEO-only (audio ACT carries intentional av_offset → bias=-offset).
    const videoOnly = {
      ...collect,
      samples: (collect.samples || []).filter((s) => s.trackKind === 'video'),
    };
    const videoInject = injectEvents.filter((e) => !e.track_kind || e.track_kind === 'video');
    const videoBias = computeBias(videoOnly, videoInject.length ? videoInject : injectEvents, deltaInjectMs);
    trial.metrics.bias_all_tracks = {
      median_bias_ms: trial.metrics.median_bias_ms,
      abs_median_bias_ms: trial.metrics.abs_median_bias_ms,
      paired_n: trial.metrics.paired_n,
      compared_to_tau_b_10ms: trial.metrics.compared_to_tau_b_10ms,
    };
    trial.metrics.median_bias_ms = videoBias.median_bias_ms;
    trial.metrics.mean_bias_ms = videoBias.mean_bias_ms;
    trial.metrics.abs_median_bias_ms = videoBias.abs_median_bias_ms;
    trial.metrics.paired_n_video = videoBias.paired_n;
    trial.metrics.compared_to_tau_b_10ms =
      videoBias.abs_median_bias_ms == null ? null : videoBias.abs_median_bias_ms <= TAU_B_MS;
    trial.metrics.bias_track_scope = 'video_only_primary';
    if (trial.metrics?.sync_err_ms) {
      trial.metrics.sync_err_ms.expected_av_offset_ms = AV_OFFSET_MS;
      trial.metrics.sync_err_ms.residual_vs_expected_ms =
        trial.metrics.sync_err_ms.median == null || !Number.isFinite(AV_OFFSET_MS)
          ? null
          : trial.metrics.sync_err_ms.median - AV_OFFSET_MS;
    }
    trial.notes = notes.slice();
    notes.push(...(collect.notes || []));

    await context.close();
  } catch (e) {
    notes.push('FATAL: ' + String(e && e.stack ? e.stack : e));
  } finally {
    try {
      await browser?.close();
    } catch {}
    try {
      server.close();
    } catch {}
  }

  const verdict = notes.some((n) => n.startsWith('FATAL')) && !trial.captureTimestamp_seen
    ? 'C1_APPARATUS_FAIL'
    : decideC1(trial);

  const payload = {
    schema: 'm1-c1-av-sync/v1',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    pins: {
      livekit_version: livekitVersion,
      livekit_pin_sha: LIVEKIT_PIN.sha,
      livekit_image: LIVEKIT_PIN.image,
      browser_version: browserVersion,
      playwright_version: pkgVersion('playwright'),
      livekit_client_version: pkgVersion('livekit-client'),
      act_uri: ACT_URI,
    },
    policy: POLICY,
    pr_4812_applied: PR_4812_APPLIED,
    publisher_mode: PUBLISHER_MODE,
    room: ROOM_NAME,
    livekit_url: LIVEKIT_URL,
    epsilon_ms: EPS_MS,
    tau_b_ms: TAU_B_MS,
    cell_id: CELL_ID,
    delta_inject_ms: deltaInjectMs,
    av_offset_ms: AV_OFFSET_MS,
    stagger_start_ms: STAGGER_START_MS,
    delta_inject_ms_levels: [deltaInjectMs],
    inject_method:
      PUBLISHER_MODE === 'pion'
        ? {
            name: 'pion_av_act_stagger',
            description:
              `Go Pion A+V ACT: video=wall_now-delta; audio=wall_now-delta+av_offset_ms. cell=${CELL_ID} policy=${POLICY} av_offset_ms=${AV_OFFSET_MS}.`,
            act_force_ext_id: ACT_FORCE_EXT_ID,
            inject_log: INJECT_LOG_PATH,
            av_offset_ms: AV_OFFSET_MS,
            stagger_start_ms: STAGGER_START_MS,
          }
        : {
            name: 'chrome_fake_device_wallclock_delta_mapping',
            description:
              `Chrome fake-device A+V; delta via wall-clock mapping. policy=${POLICY}.`,
          },
    formulas: {
      Lhat_ms: 't_playout_wall − t_capture_from_ACT',
      Lstar_ms: 't_playout_wall − (t_inject_wall − Δ_inject)',
      bias_b_ms: 'Lhat − Lstar',
      sync_err_ms: 't_capture_audio − t_capture_video at matched playout marks',
    },
    trials: [trial],
    median_bias_ms: trial.metrics?.median_bias_ms ?? null,
    mean_bias_ms: trial.metrics?.mean_bias_ms ?? null,
    abs_median_bias_ms: trial.metrics?.abs_median_bias_ms ?? null,
    sync_err_ms: trial.metrics?.sync_err_ms ?? null,
    rtt_ms_neg_control: trial.rtt_ms_negative_control,
    compared_to_tau_b_10ms: trial.metrics?.compared_to_tau_b_10ms ?? null,
    compared_to_eps_40ms: trial.metrics?.sync_err_ms?.compared_to_eps_40ms ?? null,
    verdict,
    interpretation:
      'C1/C3 staggered A/V epsilon arm. Primary: |sync_err| vs eps=40ms with known av_offset. Secondary: |bias| vs tau_b=10ms. Honest apparatus_partial if audio ACT missing. Prereg LOCKED.',
    notes,
  };

  writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  writeFileSync(join(OUT_DIR, `${TRIAL_PREFIX}-d${deltaInjectMs}.json`), JSON.stringify(payload, null, 2));
  console.log(`--- C1/C3 AV sync ${POLICY} cell=${CELL_ID} ---`);
  console.log(`verdict: ${verdict}`);
  console.log(`delta_inject_ms: ${deltaInjectMs}`);
  console.log(`captureTimestamp_seen: ${trial.captureTimestamp_seen} audio=${trial.captureTimestamp_audio_seen} video=${trial.captureTimestamp_video_seen}`);
  console.log(`ct_by_kind: ${JSON.stringify(trial.ct_by_kind)}`);
  console.log(`av_offset_ms: ${AV_OFFSET_MS}`);
  console.log(`paired_n: ${trial.metrics?.paired_n}`);
  console.log(`median_bias_ms: ${payload.median_bias_ms}`);
  console.log(`abs_median_bias_ms: ${payload.abs_median_bias_ms}`);
  console.log(`sync_err: ${JSON.stringify(payload.sync_err_ms)}`);
  console.log(`compared_to_tau_b_10ms: ${payload.compared_to_tau_b_10ms}`);
  console.log(`compared_to_eps_40ms: ${payload.compared_to_eps_40ms}`);
  console.log(`wrote: ${OUT_JSON}`);
  process.exitCode = (verdict === 'C1_APPARATUS_FAIL' || verdict === 'C1_APPARATUS_PARTIAL_NO_AUDIO_ACT') ? 2 : 0;
}

main();
