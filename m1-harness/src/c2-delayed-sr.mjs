#!/usr/bin/env node
/**
 * C2/C4 delayed-first-SR cell — rewrite vs verbatim CT timeline.
 *
 * Publisher (Pion) holds outbound RTCP Sender Reports for C2_SR_HOLD_MS so stock
 * rewrite SR-gates ACT (null captureTimestamp) while verbatim forwards pre-SR.
 * Video-only preferred; same ACT force-ext-id=8 apparatus as C0.
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
const ROOM_NAME = process.env.LIVEKIT_ROOM || 'm1-act-c0';
const TAU_B_MS = 10;
const EPS_MS = 40;
const NTP_EPOCH_OFFSET_MS = 2208988800000;
const PUBLISHER_MODE = (process.env.C0_PUBLISHER || 'chrome').toLowerCase();
const DELTA_MS = process.env.C0_DELTA_MS != null ? Number(process.env.C0_DELTA_MS) : 0;
const INJECT_LOG_PATH = process.env.C0_INJECT_LOG || join(OUT_DIR, `c0-inject-d${Number.isFinite(DELTA_MS) ? DELTA_MS : 0}.jsonl`);
/** Force Chrome ACT extmap id (pion path). LiveKit downtrack uses GetParameters id≈8. */
const ACT_FORCE_EXT_ID = process.env.C0_ACT_FORCE_EXT_ID != null ? Number(process.env.C0_ACT_FORCE_EXT_ID) : 8;
const PION_IDENTITY_PREFIX = process.env.C0_PION_IDENTITY_PREFIX || 'c0-pion';
/** Policy label for JSON: stock_rewrite | verbatim */
const POLICY = (process.env.C0_POLICY || 'stock_rewrite').toLowerCase();
const PR_4812_APPLIED = String(process.env.C0_PR_4812_APPLIED || 'false').toLowerCase() === 'true';
const OUT_PREFIX = process.env.C0_OUT_PREFIX || (POLICY === 'verbatim' ? 'c0-verbatim' : 'c0-rewrite');
const TRIAL_PREFIX = process.env.C0_TRIAL_PREFIX || (POLICY === 'verbatim' ? 'c0-verbatim-trial' : 'c0-trial');
function resolveOutPath(envVal, defaultName) {
  if (!envVal) return join(OUT_DIR, defaultName);
  // Absolute path as-is; relative names land under out/
  if (envVal.startsWith('/')) return envVal;
  return join(OUT_DIR, envVal);
}
const OUT_JSON = resolveOutPath(process.env.C0_OUT_JSON, `${OUT_PREFIX}-sanity.json`);
const SR_HOLD_MS = Number(process.env.C2_SR_HOLD_MS || 0);
const CELL_ID = process.env.C2_CELL_ID || (PR_4812_APPLIED ? 'C4' : 'C2');
const EARLY_WINDOW_MS = Number(process.env.C2_EARLY_WINDOW_MS || (SR_HOLD_MS > 0 ? SR_HOLD_MS : 5000));

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
<html><head><meta charset="utf-8"/><title>m1-act-c0</title></head>
<body>
<video id="v" autoplay playsinline muted></video>
<script src="/livekit-client.umd.js"></script>
<script>
  window.__M1 = { Room: null, rooms: {}, logs: [], injectLog: [] };
  window.__m1Log = function(msg, extra) {
    window.__M1.logs.push({ t: Date.now(), msg: String(msg), extra: extra || null });
    console.log('[m1-c0]', msg, extra || '');
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

async function waitForRemoteTrack(page, timeoutMs, identityPrefix = null) {
  return page.evaluate(
    async ({ timeoutMs, identityPrefix }) => {
      const room = window.__M1.rooms.subscriber;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const p of room.remoteParticipants.values()) {
          if (identityPrefix && !String(p.identity || '').includes(identityPrefix)) continue;
          for (const pub of p.trackPublications.values()) {
            if (pub.isSubscribed && pub.track && pub.track.kind === 'video') {
              const el = document.getElementById('v');
              if (el) pub.track.attach(el);
              return { kind: 'video', sid: pub.trackSid, participant: p.identity };
            }
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
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
        // Pairing uses t_capture_true ≈ stamped ACT capture (wall_now − Δ).
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
    return {
      samples,
      notes,
      rtt_ms_negative_control: rttMs,
      rvfc_supported: rvfcSupported,
      rvfc_count: rvfcCount,
      captureTimestamp_seen: samples.some((s) => s.hasCaptureTimestamp),
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


function computeCtTimeline(collect, earlyWindowMs, srHoldMs) {
  const samples = (collect?.samples || []).slice().sort((a, b) => (a.t_playout_wall_ms || 0) - (b.t_playout_wall_ms || 0));
  if (!samples.length) {
    return {
      sample_n: 0,
      time_to_first_ct_ms: null,
      first_ct_wall_ms: null,
      t0_wall_ms: null,
      early_window_ms: earlyWindowMs,
      sr_hold_ms: srHoldMs,
      early_sample_n: 0,
      early_ct_null_n: 0,
      early_ct_present_n: 0,
      fraction_ct_null_early: null,
      post_sr_sample_n: 0,
      post_sr_ct_n: 0,
      ct_seen_in_early_window: false,
      buckets_1s: [],
    };
  }
  const t0 = samples[0].t_playout_wall_ms;
  let firstCtRel = null;
  let firstCtWall = null;
  let earlyN = 0, earlyNull = 0, earlyCt = 0;
  let postN = 0, postCt = 0;
  const bucketMap = new Map();
  for (const s of samples) {
    const rel = (s.t_playout_wall_ms || 0) - t0;
    const sec = Math.max(0, Math.floor(rel / 1000));
    if (!bucketMap.has(sec)) bucketMap.set(sec, { sec, n: 0, ct: 0, null_n: 0 });
    const b = bucketMap.get(sec);
    b.n++;
    if (s.hasCaptureTimestamp) {
      b.ct++;
      if (firstCtRel == null) {
        firstCtRel = rel;
        firstCtWall = s.t_playout_wall_ms;
      }
    } else {
      b.null_n++;
    }
    if (rel <= earlyWindowMs) {
      earlyN++;
      if (s.hasCaptureTimestamp) earlyCt++;
      else earlyNull++;
    } else {
      postN++;
      if (s.hasCaptureTimestamp) postCt++;
    }
  }
  const buckets = [...bucketMap.values()].sort((a, b) => a.sec - b.sec);
  return {
    sample_n: samples.length,
    time_to_first_ct_ms: firstCtRel,
    first_ct_wall_ms: firstCtWall,
    t0_wall_ms: t0,
    early_window_ms: earlyWindowMs,
    sr_hold_ms: srHoldMs,
    early_sample_n: earlyN,
    early_ct_null_n: earlyNull,
    early_ct_present_n: earlyCt,
    fraction_ct_null_early: earlyN ? earlyNull / earlyN : null,
    post_sr_sample_n: postN,
    post_sr_ct_n: postCt,
    ct_seen_in_early_window: earlyCt > 0,
    buckets_1s: buckets,
  };
}

function biasAfterFirstCt(collect, injectEvents, deltaInjectMs, firstCtWallMs) {
  if (firstCtWallMs == null) {
    return { available: false, note: 'no captureTimestamp observed' };
  }
  const filtered = {
    ...collect,
    samples: (collect.samples || []).filter((s) => s.hasCaptureTimestamp && (s.t_playout_wall_ms || 0) >= firstCtWallMs),
  };
  const m = computeBias(filtered, injectEvents, deltaInjectMs);
  return {
    available: (m.paired_n || 0) > 0,
    window: 'from_first_ct_inclusive',
    ...m,
  };
}


function decideC2(trial) {
  const tl = trial?.ct_timeline;
  if (!tl || tl.sample_n <= 0) return 'C2_APPARATUS_FAIL';
  // Apparatus OK if we got samples; CT may be delayed under rewrite.
  if (trial.captureTimestamp_seen) {
    const abs = trial.bias_after_sr?.abs_median_bias_ms ?? trial.metrics?.abs_median_bias_ms;
    if (abs == null) return 'C2_CT_SEEN_BIAS_INCONCLUSIVE';
    return abs <= TAU_B_MS ? 'C2_CT_SEEN_BIAS_WITHIN_TAU_B' : 'C2_CT_SEEN_BIAS_EXCEEDS_TAU_B';
  }
  // No CT at all across full window — rewrite strip may dominate if hold ≥ sample.
  return 'C2_CT_NEVER_SEEN';
}

function decideC0(trial) {
  if (!trial?.captureTimestamp_seen) return 'C0_APPARATUS_FAIL';
  if (!trial?.metrics || trial.metrics.paired_n <= 0) return 'C0_INCONCLUSIVE';
  const a = trial.metrics.abs_median_bias_ms;
  if (a == null) return 'C0_INCONCLUSIVE';
  return a <= TAU_B_MS ? 'C0_BIAS_WITHIN_TAU_B' : 'C0_BIAS_EXCEEDS_TAU_B';
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
      schema: 'm1-c2-delayed-sr/v1',
      verdict: 'C0_APPARATUS_FAIL',
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

      const subTok = await mintToken('c0-subscriber', {
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

      const remote = await waitForRemoteTrack(subPage, CONNECT_TIMEOUT_MS, PION_IDENTITY_PREFIX);
      notes.push(remote ? `subscribed ${JSON.stringify(remote)}` : 'WARNING: no remote pion video');

      notes.push(`sampling ${SAMPLE_MS}ms Δ_inject=${deltaInjectMs} publisher=pion`);
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

      const pubTok = await mintToken('c0-publisher', {
        canPublish: true,
        canSubscribe: true,
        room: ROOM_NAME,
      });
      const subTok = await mintToken('c0-subscriber', {
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

      const remote = await waitForRemoteTrack(subPage, CONNECT_TIMEOUT_MS);
      notes.push(remote ? `subscribed ${JSON.stringify(remote)}` : 'WARNING: no remote video');
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
    trial.rtt_ms_negative_control = collect.rtt_ms_negative_control;
    trial.rvfc = { supported: collect.rvfc_supported, count: collect.rvfc_count };
    trial.sample_n = (collect.samples || []).length;
    trial.ct_sample_n = (collect.samples || []).filter((s) => s.hasCaptureTimestamp).length;
    trial.inject_event_n = injectEvents.length;
    trial.raw_samples = collect.samples || [];
    trial.sample_preview = (collect.samples || []).filter((s) => s.hasCaptureTimestamp).slice(0, 3);
    if (!trial.sample_preview.length) trial.sample_preview = (collect.samples || []).slice(0, 3);
    trial.metrics = computeBias(collect, injectEvents, deltaInjectMs);
    trial.cell_id = CELL_ID;
    trial.sr_hold_ms = SR_HOLD_MS;
    trial.early_window_ms = EARLY_WINDOW_MS;
    trial.ct_timeline = computeCtTimeline(collect, EARLY_WINDOW_MS, SR_HOLD_MS);
    trial.bias_after_sr = biasAfterFirstCt(
      collect,
      injectEvents,
      deltaInjectMs,
      trial.ct_timeline?.first_ct_wall_ms ?? null,
    );
    // Load publisher SR-hold meta if present
    try {
      const metaPath = INJECT_LOG_PATH.replace(/\.jsonl$/, '.meta.json');
      if (existsSync(metaPath)) {
        trial.publisher_sr_meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        const m = trial.publisher_sr_meta;
        const t0 = trial.ct_timeline?.t0_wall_ms;
        if (m && t0 != null && m.sr_first_held_unix_ms) {
          trial.ct_timeline.sample_t0_minus_sr_first_held_ms = t0 - m.sr_first_held_unix_ms;
          trial.ct_timeline.hold_overlap_note =
            t0 - m.sr_first_held_unix_ms < (m.sr_hold_ms || SR_HOLD_MS)
              ? 'sample_started_during_hold'
              : 'sample_started_after_hold_ended';
        }
        if (m && trial.ct_timeline?.first_ct_wall_ms && m.sr_first_released_unix_ms) {
          trial.ct_timeline.ct_minus_sr_released_ms =
            trial.ct_timeline.first_ct_wall_ms - m.sr_first_released_unix_ms;
        }
      }
    } catch (e) {
      notes.push('sr_meta: ' + String(e));
    }
    trial.notes = notes.slice();
    notes.push(...(collect.notes || []));
    notes.push(
      `ct_timeline ttf_ct_ms=${trial.ct_timeline?.time_to_first_ct_ms} frac_null_early=${trial.ct_timeline?.fraction_ct_null_early}`,
    );

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

  const verdict = notes.some((n) => n.startsWith('FATAL')) && !(trial.sample_n > 0)
    ? (CELL_ID.startsWith('C2') || CELL_ID.startsWith('C4') ? 'C2_APPARATUS_FAIL' : 'C0_APPARATUS_FAIL')
    : (CELL_ID.startsWith('C2') || CELL_ID.startsWith('C4') ? decideC2(trial) : decideC0(trial));

  const payload = {
    schema: 'm1-c2-delayed-sr/v1',
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
    delta_inject_ms: deltaInjectMs,
    delta_inject_ms_levels: [deltaInjectMs],
    inject_method:
      PUBLISHER_MODE === 'pion'
        ? {
            name: 'pion_act_wall_now_minus_delta',
            description:
              `Go Pion publisher stamps ACT = wall_now − Δ_inject via interceptor (MediaEngine ACT registration + WithInterceptors). Inject JSONL: t_inject_wall_ms, capture_unix_ms. Chromium Playwright subscriber enables ACT once and SDP-mungees ACT extmap id to match LiveKit/Pion SFU GetParameters id (apparatus workaround for GetParameters≠SDP id desync). policy=${POLICY}; pr_4812_applied=${PR_4812_APPLIED}.`,
            act_force_ext_id: ACT_FORCE_EXT_ID,
            inject_log: INJECT_LOG_PATH,
          }
        : {
            name: 'chrome_fake_device_wallclock_delta_mapping',
            description:
              `Day-1 Playwright Chromium createLocalTracks (fake device) publisher stamps ACT natively. Δ_inject via t_inject_wall = t_capture_true_wall + Δ_inject. Subscriber: captureTimestamp + RVFC. policy=${POLICY}; pr_4812_applied=${PR_4812_APPLIED}.`,
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
    compared_to_tau_b_10ms: trial.bias_after_sr?.compared_to_tau_b_10ms ?? trial.metrics?.compared_to_tau_b_10ms ?? null,
    compared_to_eps_40ms: trial.metrics?.sync_err_ms?.compared_to_eps_40ms ?? null,
    cell_id: CELL_ID,
    sr_hold_ms: SR_HOLD_MS,
    early_window_ms: EARLY_WINDOW_MS,
    ct_timeline: trial.ct_timeline ?? null,
    bias_after_sr: trial.bias_after_sr ?? null,
    publisher_sr_meta: trial.publisher_sr_meta ?? null,
    time_to_first_captureTimestamp_ms: trial.ct_timeline?.time_to_first_ct_ms ?? null,
    fraction_ct_null_early: trial.ct_timeline?.fraction_ct_null_early ?? null,
    verdict,
    interpretation:
      POLICY === 'verbatim'
        ? 'C0-style cell under verbatim ACT forwarding (PR #4812 historical flag). Bias vs τ_b=10ms is the policy observability check; ε=40ms applies to sync_err when A+V available.'
        : 'C0 is a sanity/apparatus cell on stock rewrite — Success means the metrics pipeline works and bias is honestly measured. |bias|≤τ_b=10ms is NOT required under rewrite; τ_b remains the later policy decision threshold. ε=40ms applies to sync_err when A+V available.',
    notes,
  };

  writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  writeFileSync(join(OUT_DIR, `${TRIAL_PREFIX}-d${deltaInjectMs}.json`), JSON.stringify(payload, null, 2));
  console.log(`--- C0 ${POLICY} ---`);
  console.log(`verdict: ${verdict}`);
  console.log(`delta_inject_ms: ${deltaInjectMs}`);
  console.log(`captureTimestamp_seen: ${trial.captureTimestamp_seen}`);
  console.log(`cell=${CELL_ID} sr_hold_ms=${SR_HOLD_MS} ttf_ct_ms=${payload.time_to_first_captureTimestamp_ms} frac_null_early=${payload.fraction_ct_null_early}`);
  console.log(`paired_n: ${trial.metrics?.paired_n}`);
  console.log(`median_bias_ms: ${payload.median_bias_ms}`);
  console.log(`abs_median_bias_ms: ${payload.abs_median_bias_ms}`);
  console.log(`compared_to_tau_b_10ms: ${payload.compared_to_tau_b_10ms}`);
  console.log(`wrote: ${OUT_JSON}`);
  process.exitCode = verdict === 'C0_APPARATUS_FAIL' ? 2 : 0;
}

main();
