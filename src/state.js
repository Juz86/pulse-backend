// Gedeelde in-memory state — geëxporteerd als object zodat alle modules dezelfde referentie delen

const onlineUsers   = {};        // uid → Set<socketId>
const inactiveUsers = new Set(); // uid's die online maar inactief zijn
const activeSessions = {};       // uid → { sessionDocId, startTime, accumulated, pausedAt }

function getSocketId(uid) {
  const sockets = onlineUsers[uid];
  return sockets?.size ? sockets.values().next().value : null;
}

function getSocketIds(uid) {
  return Array.from(onlineUsers[uid] || []);
}

module.exports = {
  onlineUsers, inactiveUsers, activeSessions, getSocketId, getSocketIds,
};
