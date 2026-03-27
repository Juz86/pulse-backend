let redis    = null;
let redisPub = null;
let redisSub = null;

const redisUrl = process.env.REDIS_URL;
if (redisUrl) {
  try {
    const Redis = require('ioredis');
    const queueOpts  = { maxRetriesPerRequest: 1, connectTimeout: 3000, enableOfflineQueue: false, retryStrategy: () => null };
    const adapterOpts = { connectTimeout: 5000, retryStrategy: (t) => Math.min(t * 100, 3000) };
    const redisClient = new Redis(redisUrl, queueOpts);
    redisPub = new Redis(redisUrl, adapterOpts);
    redisSub = new Redis(redisUrl, adapterOpts);
    redisClient.on('ready', () => { redis = redisClient; console.log('✅ Redis verbonden'); });
    redisClient.on('error', (e) => { console.warn('⚠️ Redis queue niet beschikbaar:', e.message); redis = null; });
    redisPub.on('error', (e) => console.warn('⚠️ Redis pub fout:', e.message));
    redisSub.on('error', (e) => console.warn('⚠️ Redis sub fout:', e.message));
  } catch (e) {
    console.warn('⚠️ ioredis laden mislukt:', e.message);
  }
} else {
  console.log('ℹ️ Geen REDIS_URL — Redis uitgeschakeld');
}

async function queueMessage(receiverUid, msg) {
  if (!redis) return;
  try {
    const key = `queue:${receiverUid}`;
    const len = await redis.llen(key);
    if (len >= 100) return; // max 100 berichten in wachtrij per gebruiker
    await redis.rpush(key, JSON.stringify(msg));
    await redis.expire(key, 7 * 24 * 60 * 60);
  } catch (e) { console.warn('Redis queueMessage mislukt:', e.message); }
}

async function flushQueue(receiverUid) {
  if (!redis) return [];
  try {
    const key = `queue:${receiverUid}`;
    const items = await redis.lrange(key, 0, -1);
    if (items.length) await redis.del(key);
    return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
  } catch (e) { console.warn('Redis flushQueue mislukt:', e.message); return []; }
}

function getRedis() { return redis; }

// ─── Gedistribueerde rate limiting (cross-instance) ───────────────────────────
// Gebruikt Redis INCR + EXPIRE per (uid, event, tijdsvenster).
// Geeft true terug als het verzoek is toegestaan, false als de limiet bereikt is.
// Valt terug op true (toestaan) als Redis niet beschikbaar is — in-memory limiters
// in server.js blijven dan als eerste verdedigingslinie actief.
async function checkRateLimit(uid, event, max, windowMs) {
  const r = getRedis();
  if (!r) return true;
  const bucket = Math.floor(Date.now() / windowMs);
  const key    = `rl:${uid}:${event}:${bucket}`;
  try {
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, Math.ceil(windowMs / 1000) + 1);
    return count <= max;
  } catch { return true; }
}

module.exports = { redisPub, redisSub, queueMessage, flushQueue, getRedis, checkRateLimit };
