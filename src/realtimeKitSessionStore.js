const { getRedis } = require('./redis');

const SESSION_TTL_SECONDS = 2 * 60 * 60;
const sessions = new Map();
const creations = new Map();
const participantCreations = new Map();

const sessionKey = (sessionId) => `pulse:call:realtimekit:${sessionId}`;
const lockKey = (sessionId) => `pulse:call:realtimekit-lock:${sessionId}`;
const participantKey = (sessionId, uid) => `pulse:call:realtimekit:${sessionId}:participant:${uid}`;
const participantLockKey = (sessionId, uid) => `pulse:call:realtimekit-lock:${sessionId}:participant:${uid}`;

function parse(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function getRealtimeKitSession(sessionId) {
  const redis = getRedis();
  if (redis) return parse(await redis.get(sessionKey(sessionId)));
  return sessions.get(sessionId) || null;
}

async function saveRealtimeKitSession(session) {
  const redis = getRedis();
  if (redis) {
    await redis.set(sessionKey(session.sessionId), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
  } else {
    sessions.set(session.sessionId, session);
  }
  return session;
}

async function ensureRealtimeKitSession(sessionId, create) {
  const existing = await getRealtimeKitSession(sessionId);
  if (existing) return existing;

  const redis = getRedis();
  if (redis) {
    const lockValue = `${process.pid}:${Date.now()}:${Math.random()}`;
    const acquired = await redis.set(lockKey(sessionId), lockValue, 'EX', 15, 'NX');
    if (acquired === 'OK') {
      try {
        const afterLock = await getRealtimeKitSession(sessionId);
        if (afterLock) return afterLock;
        return await saveRealtimeKitSession(await create());
      } finally {
        await redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1,
          lockKey(sessionId),
          lockValue,
        );
      }
    }

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const created = await getRealtimeKitSession(sessionId);
      if (created) return created;
    }
    const error = new Error('RealtimeKit session creation timed out');
    error.code = 'realtimekit_session_timeout';
    throw error;
  }

  if (!creations.has(sessionId)) {
    creations.set(sessionId, Promise.resolve().then(create).then(saveRealtimeKitSession));
  }
  try {
    return await creations.get(sessionId);
  } finally {
    creations.delete(sessionId);
  }
}

async function getParticipant(sessionId, uid) {
  const redis = getRedis();
  if (redis) return parse(await redis.get(participantKey(sessionId, uid)));
  return sessions.get(sessionId)?.participants?.[uid] || null;
}

async function ensureParticipant(sessionId, uid, create) {
  const existing = await getParticipant(sessionId, uid);
  if (existing) return existing;

  const redis = getRedis();
  const creationKey = `${sessionId}:${uid}`;
  if (redis) {
    const lockValue = `${process.pid}:${Date.now()}:${Math.random()}`;
    const acquired = await redis.set(participantLockKey(sessionId, uid), lockValue, 'EX', 15, 'NX');
    if (acquired === 'OK') {
      try {
        const afterLock = await getParticipant(sessionId, uid);
        if (afterLock) return afterLock;
        const credentials = await create();
        await redis.set(participantKey(sessionId, uid), JSON.stringify(credentials), 'EX', SESSION_TTL_SECONDS);
        return credentials;
      } finally {
        await redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1,
          participantLockKey(sessionId, uid),
          lockValue,
        );
      }
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const created = await getParticipant(sessionId, uid);
      if (created) return created;
    }
    const error = new Error('RealtimeKit participant creation timed out');
    error.code = 'realtimekit_participant_timeout';
    throw error;
  }

  if (!participantCreations.has(creationKey)) {
    participantCreations.set(creationKey, Promise.resolve().then(create).then((credentials) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.participants = { ...(session.participants || {}), [uid]: credentials };
        sessions.set(sessionId, session);
      }
      return credentials;
    }));
  }
  try {
    return await participantCreations.get(creationKey);
  } finally {
    participantCreations.delete(creationKey);
  }
}

function clearRealtimeKitSessionStoreForTests() {
  sessions.clear();
  creations.clear();
  participantCreations.clear();
}

module.exports = {
  SESSION_TTL_SECONDS,
  ensureRealtimeKitSession,
  ensureParticipant,
  getRealtimeKitSession,
  clearRealtimeKitSessionStoreForTests,
};
