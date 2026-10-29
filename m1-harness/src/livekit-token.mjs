/**
 * Mint LiveKit room JWTs for local Day-1 gate.
 * Keys match docker-compose / livekit.yaml: API key `devkey`, secret `secret`.
 */
import { AccessToken } from 'livekit-server-sdk';

export const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
export const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
export const ROOM_NAME = process.env.LIVEKIT_ROOM || 'm1-act-day1';
export const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';

/**
 * @param {string} identity
 * @param {{ canPublish?: boolean, canSubscribe?: boolean, room?: string }} [opts]
 */
export async function mintToken(identity, opts = {}) {
  const room = opts.room || ROOM_NAME;
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: '1h',
  });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: opts.canPublish !== false,
    canSubscribe: opts.canSubscribe !== false,
    canPublishData: true,
  });
  return at.toJwt();
}
