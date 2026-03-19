// Gedeelde in-memory state — geëxporteerd als object zodat alle modules dezelfde referentie delen

const onlineUsers   = {};        // uid → Set<socketId>
const activeCalls   = new Set(); // uid's in een actief gesprek
const inactiveUsers = new Set(); // uid's die online maar inactief zijn
const activeSessions = {};       // uid → { sessionDocId, startTime, accumulated, pausedAt }
const pendingCalls  = {};        // calleeUid → { from, callerName, isVideo }

function getSocketId(uid) {
  const sockets = onlineUsers[uid];
  return sockets?.size ? sockets.values().next().value : null;
}

module.exports = { onlineUsers, activeCalls, inactiveUsers, activeSessions, pendingCalls, getSocketId };
