const CLOUDFLARE_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const DEFAULT_TTL_SECONDS = 7200;
const MAX_TTL_SECONDS = 172800;
const REQUEST_TIMEOUT_MS = 5000;

const STUN_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

function readTtlSeconds(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 60) return DEFAULT_TTL_SECONDS;
  return Math.min(parsed, MAX_TTL_SECONDS);
}

function normalizeCloudflareIceServer(payload) {
  const server = payload?.iceServers;
  if (!server || !Array.isArray(server.urls)) return null;

  const urls = server.urls.filter((url) => (
    typeof url === 'string'
    && /^turns?:/i.test(url)
    && !/:53(?:\?|$)/i.test(url)
  ));
  if (!urls.length || typeof server.username !== 'string' || typeof server.credential !== 'string') {
    return null;
  }

  return {
    urls,
    username: server.username,
    credential: server.credential,
  };
}

function readStaticTurnServer(env) {
  if (!env.TURN_URL || !env.TURN_USERNAME || !env.TURN_CREDENTIAL) return null;
  return {
    urls: env.TURN_URL,
    username: env.TURN_USERNAME,
    credential: env.TURN_CREDENTIAL,
  };
}

async function generateCloudflareTurnServer({ env = process.env, fetchImpl = global.fetch } = {}) {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID;
  const keySecret = env.CLOUDFLARE_TURN_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');

  const ttlSeconds = readTtlSeconds(env.CLOUDFLARE_TURN_TTL_SECONDS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `${CLOUDFLARE_TURN_API}/${encodeURIComponent(keyId)}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keySecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: ttlSeconds }),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`cloudflare_turn_http_${response.status}`);
    const turnServer = normalizeCloudflareIceServer(await response.json());
    if (!turnServer) throw new Error('cloudflare_turn_invalid_response');
    return { turnServer, ttlSeconds };
  } finally {
    clearTimeout(timeout);
  }
}

async function getTurnCredentials(options = {}) {
  const env = options.env || process.env;
  try {
    const cloudflare = await generateCloudflareTurnServer({ ...options, env });
    if (cloudflare) {
      return {
        iceServers: [...STUN_SERVERS, cloudflare.turnServer],
        hasTurn: true,
        source: 'cloudflare',
        expiresIn: cloudflare.ttlSeconds,
      };
    }
  } catch (error) {
    options.logger?.warn?.('Cloudflare TURN credentials ophalen mislukt; fallback actief', {
      error: error?.message || 'unknown',
    });
  }

  const staticTurnServer = readStaticTurnServer(env);
  return {
    iceServers: staticTurnServer ? [...STUN_SERVERS, staticTurnServer] : [...STUN_SERVERS],
    hasTurn: Boolean(staticTurnServer),
    source: staticTurnServer ? 'static' : 'stun-only',
    expiresIn: staticTurnServer ? 3600 : 0,
  };
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  STUN_SERVERS,
  generateCloudflareTurnServer,
  getTurnCredentials,
  normalizeCloudflareIceServer,
  readTtlSeconds,
};
