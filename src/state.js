// Gedeelde in-memory state — geëxporteerd als object zodat alle modules dezelfde referentie delen

const onlineUsers   = {};        // uid → Set<socketId>
const activeCalls   = new Set(); // uid's in een actief gesprek
const inactiveUsers = new Set(); // uid's die online maar inactief zijn
const activeSessions = {};       // uid → { sessionDocId, startTime, accumulated, pausedAt }
const pendingCalls  = {};        // sessionId → { sessionId, from, to, offer, callerName, isVideo, createdAt }
const activeCallSessions = {};  // sessionId → geselecteerde caller/callee sockets

function getSocketId(uid) {
  const sockets = onlineUsers[uid];
  return sockets?.size ? sockets.values().next().value : null;
}

function getSocketIds(uid) {
  return Array.from(onlineUsers[uid] || []);
}

function getCallPeerSocketId(sessionId, fromUid, toUid) {
  const session = activeCallSessions[sessionId];
  if (!session) return null;
  if (session.callerUid === fromUid && session.calleeUid === toUid) return session.calleeSocketId;
  if (session.calleeUid === fromUid && session.callerUid === toUid) return session.callerSocketId;
  return null;
}

function clearCallSession(sessionId) {
  if (sessionId) delete activeCallSessions[sessionId];
}

module.exports = {
  onlineUsers, activeCalls, inactiveUsers, activeSessions, pendingCalls,
  activeCallSessions, getSocketId, getSocketIds, getCallPeerSocketId, clearCallSession,
};
