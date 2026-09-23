const CLOUDFLARE_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const DEFAULT_TTL_SECONDS = 7200;
const MAX_TTL_SECONDS = 172800;
const REQUEST_TIMEOUT_MS = 5000;

function readTtlSeconds(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 60) return DEFAULT_TTL_SECONDS;
  return Math.min(parsed, MAX_TTL_SECONDS);
}

function isAllowedIceUrl(value) {
  return typeof value === 'string'
    && /^(stun|turn|turns):/i.test(value)
    && !/:53(?:\?|$)/i.test(value);
}

function normalizeIceServers(payload) {
  const input = Array.isArray(payload?.iceServers)
    ? payload.iceServers
    : [payload?.iceServers].filter(Boolean);
  const output = [];
  let hasTurn = false;

  for (const server of input) {
    const sourceUrls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    const urls = sourceUrls.filter(isAllowedIceUrl);
    if (!urls.length) continue;

    const containsTurn = urls.some((url) => /^turns?:/i.test(url));
    const hasValidCredentials = typeof server.username === 'string'
      && server.username.trim().length > 0
      && typeof server.credential === 'string'
      && server.credential.trim().length > 0;
    if (containsTurn && !hasValidCredentials) {
      continue;
    }
    hasTurn ||= containsTurn;
    output.push({
      urls,
      ...(containsTurn ? { username: server.username, credential: server.credential } : {}),
    });
  }

  if (!hasTurn) throw new Error('cloudflare_turn_missing_relay');
  return output;
}

function createCloudflareTurnCredentialsProvider({
  env = process.env,
  fetchImpl = global.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID;
  const keySecret = env.CLOUDFLARE_TURN_KEY_SECRET;
  const ttlSeconds = readTtlSeconds(env.CLOUDFLARE_TURN_TTL_SECONDS);

  return async function getCloudflareTurnCredentials() {
    if (!keyId || !keySecret) throw new Error('cloudflare_turn_not_configured');
    if (typeof fetchImpl !== 'function') throw new Error('cloudflare_turn_fetch_unavailable');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `${CLOUDFLARE_TURN_API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
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
      return {
        iceServers: normalizeIceServers(await response.json()),
        expiresInSeconds: ttlSeconds,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  createCloudflareTurnCredentialsProvider,
  normalizeIceServers,
  readTtlSeconds,
};
