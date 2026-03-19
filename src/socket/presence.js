const { admin, db } = require('../firebase');
const { flushQueue } = require('../redis');
const { inactiveUsers, activeSessions } = require('../state');

module.exports = function registerPresence(io, socket, uid) {
  // ── User registreren als online ──
  socket.on('user:online', async () => {
    const { onlineUsers } = require('../state');
    if (!onlineUsers[uid]) onlineUsers[uid] = new Set();
    onlineUsers[uid].add(socket.id);
    socket.data.uid = uid;
    inactiveUsers.delete(uid); // Actief bij verbinding

    // Direct broadcasten — geen wachten op Firestore
    io.emit('user:status', { uid, online: true, inactive: false });
    socket.emit('users:online', Object.keys(onlineUsers));
    socket.emit('users:inactive', [...inactiveUsers]);

    // Firestore asynchroon bijwerken op de achtergrond
    db.collection('users').doc(uid).update({ online: true, inactive: false, lastSeen: admin.firestore.FieldValue.serverTimestamp() }).catch(e => console.warn('Online-update mislukt:', e.message));

    const userSnap = await db.collection('users').doc(uid).get().catch(() => null);
    if (userSnap?.exists) {
      const pf = userSnap.data()?.pausedFeatures;
      const legacyPaused = userSnap.data()?.paused;
      const features = pf || (legacyPaused ? { chat: true, call: true, video: true } : null);
      if (features && (features.chat || features.call || features.video)) socket.emit('account:paused', { features });

      // Sessie bijhouden voor kinderen
      const parentId = userSnap.data()?.parentId;
      if (parentId && !activeSessions[uid]) {
        const sessionRef = db.collection('userSessions').doc();
        activeSessions[uid] = { sessionDocId: sessionRef.id, startTime: Date.now(), accumulated: 0, pausedAt: null };
        sessionRef.set({
          uid, parentId,
          startTime: admin.firestore.FieldValue.serverTimestamp(),
          endTime: null, duration: null,
        }).catch(e => console.warn('Session start opslaan mislukt:', e.message));
      }
    }

    // ── Bezorg wachtende berichten uit Redis wachtrij ──
    const queued = await flushQueue(uid);
    if (queued.length > 0) {
      // Bezorg in chronologische volgorde
      for (const msg of queued) {
        socket.emit('message:received', msg);
      }
      // Markeer als bezorgd in Firestore (per gesprek, gegroepeerd voor efficiëntie)
      const byConv = {};
      queued.forEach(msg => {
        if (msg.convId && msg.id) {
          if (!byConv[msg.convId]) byConv[msg.convId] = [];
          byConv[msg.convId].push(msg);
        }
      });
      for (const [convId, msgs] of Object.entries(byConv)) {
        const batch = db.batch();
        msgs.forEach(msg => {
          const ref = db.collection('conversations').doc(convId).collection('messages').doc(msg.id);
          batch.update(ref, { status: 'bezorgd' });
        });
        batch.commit().catch(e => console.warn('Batch bezorgd-update mislukt:', e.message));
        // Notificeer verzenders dat berichten nu bezorgd zijn
        msgs.forEach(msg => {
          const senderSockets = onlineUsers[msg.senderId];
          if (senderSockets) {
            senderSockets.forEach(sid => io.to(sid).emit('message:status', { convId, msgId: msg.id, status: 'bezorgd' }));
          }
        });
      }
    }

    console.log(`👤 Online: ${uid}`);
  });

  // ── Stuur actuele online lijst op verzoek ──
  socket.on('users:online:request', () => {
    const { onlineUsers } = require('../state');
    socket.emit('users:online', Object.keys(onlineUsers));
    socket.emit('users:inactive', [...inactiveUsers]);
  });

  // ── Inactiviteit detectie ──
  socket.on('user:inactive', async () => {
    inactiveUsers.add(uid);
    await db.collection('users').doc(uid).update({ inactive: true }).catch(e => console.warn('Inactief-update mislukt:', e.message));
    io.emit('user:status', { uid, online: true, inactive: true });
    // Pauzeer sessietimer bij inactiviteit
    if (activeSessions[uid] && !activeSessions[uid].pausedAt) {
      activeSessions[uid].accumulated += Math.round((Date.now() - activeSessions[uid].startTime) / 1000);
      activeSessions[uid].pausedAt = Date.now();
    }
  });

  socket.on('user:active', async () => {
    inactiveUsers.delete(uid);
    await db.collection('users').doc(uid).update({ inactive: false }).catch(e => console.warn('Actief-update mislukt:', e.message));
    io.emit('user:status', { uid, online: true, inactive: false });
    // Hervat sessietimer
    if (activeSessions[uid] && activeSessions[uid].pausedAt) {
      activeSessions[uid].startTime = Date.now();
      activeSessions[uid].pausedAt = null;
    }
  });

  // ── Profielupdate broadcasten naar alle verbonden clients ──
  socket.on('user:updated', ({ displayName, photoURL }) => {
    socket.broadcast.emit('user:updated', { uid: socket.userId, displayName, photoURL });
  });
};
