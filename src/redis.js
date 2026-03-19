let redis    = null;
let redisPub = null;
let redisSub = null;

const redisUrl = process.env.REDIS_URL;
if (redisUrl) {
  try {
    const Redis = require('ioredis');
    const opts = { maxRetriesPerRequest: 1, connectTimeout: 3000, enableOfflineQueue: false, retryStrategy: () => null };
    const redisClient = new Redis(redisUrl, opts);
    redisPub = new Redis(redisUrl, opts);
    redisSub = new Redis(redisUrl, opts);
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

module.exports = { redisPub, redisSub, queueMessage, flushQueue };
