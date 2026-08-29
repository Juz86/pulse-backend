const { getRedis } = require('./redis');
const { activeCallSessions, pendingCalls } = require('./state');

const PENDING_TTL_SECONDS = 90;
const ACTIVE_TTL_SECONDS = 75;
const ACTIVE_LEASE_MS = ACTIVE_TTL_SECONDS * 1000;
const MAX_CANDIDATES = 64;

const earlyCandidates = new Map();
const activeUsers = new Map();

const key = {
  pending: (sessionId) => `pulse:call:pending:${sessionId}`,
  callee: (uid) => `pulse:call:callee:${uid}`,
  candidates: (sessionId) => `pulse:call:candidates:${sessionId}`,
  claim: (sessionId) => `pulse:call:claim:${sessionId}`,
  active: (sessionId) => `pulse:call:active:${sessionId}`,
  user: (uid) => `pulse:call:user:${uid}`,
};

function parse(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function createPendingCall(call) {
  const redis = getRedis();
  if (!redis) {
    if (activeUsers.has(call.to)) return { created: false, reason: 'busy' };
    const duplicate = Object.values(pendingCalls).find((entry) => entry?.to === call.to);
    if (duplicate) return { created: false, existingSessionId: duplicate.sessionId };
    const candidates = earlyCandidates.get(call.sessionId) || [];
    earlyCandidates.delete(call.sessionId);
    pendingCalls[call.sessionId] = { ...call, callerCandidates: candidates };
    return { created: true, call: pendingCalls[call.sessionId] };
  }

  const script = `
    if redis.call('EXISTS', KEYS[2]) == 1 then
      local existing = redis.call('GET', KEYS[2])
      if redis.call('EXISTS', 'pulse:call:pending:' .. existing) == 1 then
        return {0, existing}
      end
      redis.call('DEL', KEYS[2])
    end
    if redis.call('EXISTS', KEYS[3]) == 1 then return {-1, redis.call('GET', KEYS[3])} end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
    return {1, ARGV[3]}
  `;
  const result = await redis.eval(
    script, 3, key.pending(call.sessionId), key.callee(call.to), key.user(call.to),
    JSON.stringify(call), PENDING_TTL_SECONDS, call.sessionId,
  );
  return Number(result?.[0]) === 1
    ? { created: true, call }
    : {
      created: false,
      reason: Number(result?.[0]) === -1 ? 'busy' : 'already_ringing',
      existingSessionId: result?.[1] || null,
    };
}

async function getPendingCall(sessionId) {
  if (!sessionId) return null;
  const redis = getRedis();
  if (!redis) return pendingCalls[sessionId] || null;
  const [rawCall, rawCandidates] = await Promise.all([
    redis.get(key.pending(sessionId)),
    redis.lrange(key.candidates(sessionId), 0, MAX_CANDIDATES - 1),
  ]);
  const call = parse(rawCall);
  if (!call) return null;
  return { ...call, callerCandidates: rawCandidates.map(parse).filter(Boolean) };
}

async function getPendingCallByCallee(uid) {
  const redis = getRedis();
  if (!redis) return Object.values(pendingCalls).find((call) => call?.to === uid) || null;
  return getPendingCall(await redis.get(key.callee(uid)));
}

async function addCallerCandidate(sessionId, from, to, candidate) {
  if (!sessionId || !candidate) return;
  const redis = getRedis();
  if (!redis) {
    const pending = pendingCalls[sessionId];
    if (pending?.from === from && pending?.to === to) {
      pending.callerCandidates = pending.callerCandidates || [];
      if (pending.callerCandidates.length < MAX_CANDIDATES) pending.callerCandidates.push(candidate);
      return;
    }
    const list = earlyCandidates.get(sessionId) || [];
    if (list.length < MAX_CANDIDATES) list.push(candidate);
    earlyCandidates.set(sessionId, list);
    return;
  }
  const script = `
    if redis.call('LLEN', KEYS[1]) < tonumber(ARGV[2]) then
      redis.call('RPUSH', KEYS[1], ARGV[1])
    end
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    return 1
  `;
  await redis.eval(
    script, 1, key.candidates(sessionId), JSON.stringify(candidate),
    MAX_CANDIDATES, PENDING_TTL_SECONDS,
  );
}

async function claimPendingCall(sessionId, calleeUid, callerUid, calleeSocketId, callerSocketId, answer) {
  const redis = getRedis();
  const existingActive = await getActiveCall(sessionId);
  if (existingActive) {
    return { claimed: false, reason: 'answered_elsewhere', active: existingActive };
  }
  const pending = await getPendingCall(sessionId);
  if (!pending || pending.to !== calleeUid || pending.from !== callerUid) {
    return { claimed: false, reason: 'not_found' };
  }
  const active = {
    sessionId,
    callerUid,
    callerSocketId: pending.callerSocketId || callerSocketId || null,
    calleeUid,
    calleeSocketId,
    answer: answer || null,
    heartbeatAt: Date.now(),
  };
  if (!redis) {
    const existing = activeCallSessions[sessionId];
    if (existing && existing.calleeSocketId !== calleeSocketId) {
      return { claimed: false, reason: 'answered_elsewhere', active: existing };
    }
    activeCallSessions[sessionId] = active;
    activeUsers.set(callerUid, sessionId);
    activeUsers.set(calleeUid, sessionId);
    delete pendingCalls[sessionId];
    return { claimed: true, pending, active };
  }
  const script = `
    if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
    if redis.call('EXISTS', KEYS[5]) == 0 then return -1 end
    if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[4]) == 1 then return -2 end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
    redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[2])
    redis.call('SET', KEYS[4], ARGV[4], 'EX', ARGV[2])
    redis.call('DEL', KEYS[5], KEYS[6], KEYS[7])
    return 1
  `;
  const claimed = await redis.eval(
    script, 7,
    key.claim(sessionId), key.active(sessionId), key.user(callerUid), key.user(calleeUid),
    key.pending(sessionId), key.callee(calleeUid), key.candidates(sessionId),
    calleeSocketId, ACTIVE_TTL_SECONDS, JSON.stringify(active), sessionId,
  );
  return Number(claimed) === 1
    ? { claimed: true, pending, active }
    : {
      claimed: false,
      reason: Number(claimed) === 0 ? 'answered_elsewhere' : 'not_found',
      active: await getActiveCall(sessionId),
    };
}

async function getActiveCall(sessionId) {
  if (!sessionId) return null;
  const redis = getRedis();
  if (!redis) return activeCallSessions[sessionId] || null;
  return parse(await redis.get(key.active(sessionId)));
}

async function isUserInCall(uid) {
  const redis = getRedis();
  const sessionId = redis ? await redis.get(key.user(uid)) : activeUsers.get(uid);
  if (!sessionId) return false;
  const active = await getActiveCall(sessionId);
  const heartbeatAt = Number(active?.heartbeatAt || 0);
  if (heartbeatAt > 0 && Date.now() - heartbeatAt <= ACTIVE_LEASE_MS) return true;
  if (active) {
    await clearActiveCall(sessionId);
  } else if (!redis) {
    activeUsers.delete(uid);
  } else {
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
      return 0
    `;
    await redis.eval(script, 1, key.user(uid), sessionId);
  }
  return false;
}

async function resumeActiveCall(sessionId, uid, socketId) {
  const active = await getActiveCall(sessionId);
  if (!active) return null;
  if (active.callerUid === uid) active.callerSocketId = socketId;
  else if (active.calleeUid === uid) active.calleeSocketId = socketId;
  else return null;
  active.heartbeatAt = Date.now();
  const redis = getRedis();
  if (!redis) {
    activeCallSessions[sessionId] = active;
    return active;
  }
  await redis.set(key.active(sessionId), JSON.stringify(active), 'EX', ACTIVE_TTL_SECONDS);
  await Promise.all([
    redis.expire(key.user(active.callerUid), ACTIVE_TTL_SECONDS),
    redis.expire(key.user(active.calleeUid), ACTIVE_TTL_SECONDS),
    redis.expire(key.claim(sessionId), ACTIVE_TTL_SECONDS),
  ]);
  return active;
}

async function touchActiveCall(sessionId, uid, socketId) {
  return resumeActiveCall(sessionId, uid, socketId);
}

async function deletePendingCall(sessionId) {
  const pending = await getPendingCall(sessionId);
  if (!pending) return null;
  const redis = getRedis();
  if (!redis) {
    delete pendingCalls[sessionId];
    earlyCandidates.delete(sessionId);
    return pending;
  }
  const script = `
    if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
    redis.call('DEL', KEYS[1], KEYS[3])
    return 1
  `;
  await redis.eval(
    script, 3, key.pending(sessionId), key.callee(pending.to), key.candidates(sessionId), sessionId,
  );
  return pending;
}

async function clearActiveCall(sessionId) {
  const active = await getActiveCall(sessionId);
  if (!active) return null;
  const redis = getRedis();
  if (!redis) {
    delete activeCallSessions[sessionId];
    activeUsers.delete(active.callerUid);
    activeUsers.delete(active.calleeUid);
    return active;
  }
  const script = `
    if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
    if redis.call('GET', KEYS[4]) == ARGV[1] then redis.call('DEL', KEYS[4]) end
    redis.call('DEL', KEYS[1], KEYS[2])
    return 1
  `;
  await redis.eval(
    script, 4, key.active(sessionId), key.claim(sessionId),
    key.user(active.callerUid), key.user(active.calleeUid), sessionId,
  );
  return active;
}

module.exports = {
  addCallerCandidate,
  claimPendingCall,
  clearActiveCall,
  createPendingCall,
  deletePendingCall,
  getActiveCall,
  getPendingCall,
  getPendingCallByCallee,
  isUserInCall,
  resumeActiveCall,
  touchActiveCall,
};
