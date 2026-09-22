const { CALL_STATES } = require('./protocol');

const LIVE_SESSION_TTL_SECONDS = 2 * 60 * 60;
const TERMINAL_SESSION_TTL_SECONDS = 5 * 60;

const CREATE_SCRIPT = `
local existingSessionId = redis.call('GET', KEYS[4])
if existingSessionId then
  local existing = redis.call('GET', ARGV[5] .. existingSessionId)
  if existing then return cjson.encode({ status = 'IDEMPOTENT', session = existing }) end
  redis.call('DEL', KEYS[4])
end
local callerLease = redis.call('GET', KEYS[2])
local calleeLease = redis.call('GET', KEYS[3])
if callerLease or calleeLease then return cjson.encode({ status = 'BUSY' }) end
if redis.call('EXISTS', KEYS[1]) == 1 then return cjson.encode({ status = 'CONFLICT' }) end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[4], ARGV[2], 'EX', ARGV[4])
return cjson.encode({ status = 'CREATED', session = ARGV[1] })
`;

const COMMIT_SCRIPT = `
local currentJson = redis.call('GET', KEYS[1])
if not currentJson then return cjson.encode({ status = 'NOT_FOUND' }) end
if redis.call('EXISTS', KEYS[2]) == 1 then return cjson.encode({ status = 'DUPLICATE', session = currentJson }) end
local current = cjson.decode(currentJson)
if tonumber(current.revision) ~= tonumber(ARGV[1]) then return cjson.encode({ status = 'CONFLICT', session = currentJson }) end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
if ARGV[5] == '1' then
  if redis.call('GET', KEYS[3]) == ARGV[3] then redis.call('DEL', KEYS[3]) end
  if redis.call('GET', KEYS[4]) == ARGV[3] then redis.call('DEL', KEYS[4]) end
else
  redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
  redis.call('SET', KEYS[4], ARGV[3], 'EX', ARGV[4])
end
return cjson.encode({ status = 'APPLIED', session = ARGV[2] })
`;

function parseRedisResult(value) {
  const result = typeof value === 'string' ? JSON.parse(value) : value;
  if (result?.session && typeof result.session === 'string') result.session = JSON.parse(result.session);
  return result;
}

class RedisCallV2Store {
  constructor(getRedisClient) { this.getRedisClient = getRedisClient; }
  sessionKey(sessionId) { return `pulse:calling:v2:session:${sessionId}`; }
  userLeaseKey(uid) { return `pulse:calling:v2:user:${uid}`; }
  requestKey(callerUid, requestId) { return `pulse:calling:v2:request:${callerUid}:${requestId}`; }
  eventKey(sessionId, eventId) { return `pulse:calling:v2:event:${sessionId}:${eventId}`; }

  async create(session) {
    const redis = this.getRedisClient();
    if (!redis) return { status: 'UNAVAILABLE' };
    try {
      return parseRedisResult(await redis.eval(CREATE_SCRIPT, 4,
        this.sessionKey(session.sessionId), this.userLeaseKey(session.callerUid),
        this.userLeaseKey(session.calleeUid), this.requestKey(session.callerUid, session.requestId),
        JSON.stringify(session), session.sessionId, LIVE_SESSION_TTL_SECONDS,
        LIVE_SESSION_TTL_SECONDS, 'pulse:calling:v2:session:'));
    } catch (error) {
      console.warn('[Calling v2] Redis create mislukt:', error.message);
      return { status: 'UNAVAILABLE' };
    }
  }

  async get(sessionId) {
    const redis = this.getRedisClient();
    if (!redis) return { status: 'UNAVAILABLE' };
    try {
      const value = await redis.get(this.sessionKey(sessionId));
      return value ? { status: 'FOUND', session: JSON.parse(value) } : { status: 'NOT_FOUND' };
    } catch (error) {
      console.warn('[Calling v2] Redis get mislukt:', error.message);
      return { status: 'UNAVAILABLE' };
    }
  }

  async hasEvent(sessionId, eventId) {
    const redis = this.getRedisClient();
    if (!redis) return { status: 'UNAVAILABLE' };
    try {
      const exists = await redis.exists(this.eventKey(sessionId, eventId));
      return { status: exists === 1 ? 'FOUND' : 'NOT_FOUND' };
    } catch (error) {
      console.warn('[Calling v2] Redis eventcontrole mislukt:', error.message);
      return { status: 'UNAVAILABLE' };
    }
  }

  async commit({ currentRevision, nextSession, eventId }) {
    const redis = this.getRedisClient();
    if (!redis) return { status: 'UNAVAILABLE' };
    const terminal = nextSession.state === CALL_STATES.ENDED;
    const ttl = terminal ? TERMINAL_SESSION_TTL_SECONDS : LIVE_SESSION_TTL_SECONDS;
    try {
      return parseRedisResult(await redis.eval(COMMIT_SCRIPT, 4,
        this.sessionKey(nextSession.sessionId), this.eventKey(nextSession.sessionId, eventId),
        this.userLeaseKey(nextSession.callerUid), this.userLeaseKey(nextSession.calleeUid),
        currentRevision, JSON.stringify(nextSession), nextSession.sessionId, ttl, terminal ? '1' : '0'));
    } catch (error) {
      console.warn('[Calling v2] Redis commit mislukt:', error.message);
      return { status: 'UNAVAILABLE' };
    }
  }
}

module.exports = { LIVE_SESSION_TTL_SECONDS, TERMINAL_SESSION_TTL_SECONDS, RedisCallV2Store };
