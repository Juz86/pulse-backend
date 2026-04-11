const { admin, db } = require('../firebase');
const { sendPush } = require('../push');
const { activeCalls, pendingCalls, getSocketId } = require('../state');

function emitCallLogOutsideConversation(io, convId, members, senderId, payload, onlineUsers) {
  const roomSockets = io.sockets.adapter.rooms.get(convId) || new Set();

  members.forEach(memberUid => {
    if (memberUid === senderId) return;
    const sockets = onlineUsers[memberUid];
    if (!sockets) return;
    sockets.forEach(sid => {
      if (roomSockets.has(sid)) return;
      io.to(sid).emit('message:received', payload);
    });
  });
}

module.exports = function registerCalls(io, socket, uid) {
  // ── Video upgrade doorsturen naar de andere kant ──
  socket.on('call:video-upgrade', ({ to }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:video-upgrade');
  });

  // ── Oproep opslaan als bericht in gesprek ──
  socket.on('call:log', async ({ convId, isVideo, direction, duration }) => {
    try {
      const { onlineUsers } = require('../state');
      if (!convId || !direction) return;
      const senderId = uid; // gebruik verified socket.userId
      const safeDuration = (typeof duration === 'number' && isFinite(duration) && duration >= 0) ? Math.round(duration) : 0;
      const userDoc = await db.collection('users').doc(senderId).get();
      const senderName = userDoc.exists ? (userDoc.data().displayName || '') : '';
      const msgRef = await db.collection('conversations').doc(convId)
        .collection('messages').add({
          type: 'call', isVideo: !!isVideo, direction, duration: safeDuration,
          senderId, senderName,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      const dur = safeDuration > 0
        ? (safeDuration >= 60 ? `${Math.floor(safeDuration / 60)} min` : `${safeDuration} sec`)
        : '';
      const label = direction === 'completed'
        ? (isVideo ? 'Video-oproep' : 'Spraakoproep') + (dur ? ` · ${dur}` : '')
        : direction === 'declined'
          ? (isVideo ? 'Video-oproep geweigerd' : 'Oproep geweigerd')
          : (isVideo ? 'Gemiste video-oproep' : 'Gemiste oproep');
      await db.collection('conversations').doc(convId).update({
        lastMessage:       label,
        lastMessageAt:     admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
        lastCallSenderId:  senderId,
        lastCallDirection: direction,
        lastCallIsVideo:   !!isVideo,
      });
      const savedMsg = { id: msgRef.id, convId, type: 'call', isVideo: !!isVideo, direction, duration: safeDuration, senderId, senderName };
      // Stuur naar iedereen in de room (als ze de chat open hebben)
      io.to(convId).emit('message:received', savedMsg);
      // Stuur ook rechtstreeks naar elk lid — ook als ze de chat niet open hebben
      const convDoc = await db.collection('conversations').doc(convId).get();
      const members = convDoc.exists ? (convDoc.data().members || []) : [];
      emitCallLogOutsideConversation(io, convId, members, senderId, savedMsg, onlineUsers);
    } catch (e) {
      console.error('call:log fout:', e);
    }
  });

  // ── WebRTC Signaling: Bellen ──
  socket.on('call:offer', async ({ to, from, offer, isVideo, callerName }) => {
    // Blokkeer check
    const [callerDoc, targetCallDoc] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(to).get(),
    ]);
    const targetBlocked = targetCallDoc.data()?.blockedUsers || [];
    const callerBlocked = callerDoc.data()?.blockedUsers || [];
    if (targetBlocked.includes(uid) || callerBlocked.includes(to)) {
      socket.emit('call:unavailable', { to });
      return;
    }

    const targetSocket = getSocketId(to);
    if (targetSocket) {
      // Controleer of ontvanger al in een actief gesprek zit
      if (activeCalls.has(to)) {
        socket.emit('call:busy', { to });
        return;
      }
      // Voorkom dubbele inkomende oproep notificaties voor hetzelfde gesprek
      if (pendingCalls[to]) return;
      io.to(targetSocket).emit('call:incoming', { from, offer, isVideo, callerName });
      // Bijhouden dat deze oproep uitstaat (nog niet beantwoord)
      pendingCalls[to] = { from, callerName, isVideo };
    } else {
      socket.emit('call:unavailable', { to });
      // Gebruiker is offline → gemiste oproep notificatie
      sendPush(to,
        { title: '📞 Gemiste oproep', body: `${callerName} heeft je ${isVideo ? 'geprobeerd te videobellen' : 'gebeld'}.` },
        { type: 'missed_call' }
      );
    }
  });

  socket.on('call:answer', ({ to, answer }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:answer', { answer });
    // Oproep beantwoord → beide users zijn nu in een actief gesprek
    activeCalls.add(socket.data.uid);
    activeCalls.add(to);
    delete pendingCalls[socket.data.uid];
    delete pendingCalls[to];
  });

  socket.on('call:ice-candidate', ({ to, candidate }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:ice-candidate', { candidate });
  });

  socket.on('call:end', async ({ to }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:ended');
    // Beide users zijn niet meer in een actief gesprek
    activeCalls.delete(socket.data.uid);
    activeCalls.delete(to);
    // Als oproep nog uitstond (niet beantwoord) → gemiste oproep notificatie
    if (pendingCalls[to]) {
      const { callerName, isVideo } = pendingCalls[to];
      delete pendingCalls[to];
      sendPush(to,
        { title: '📞 Gemiste oproep', body: `${callerName} heeft je ${isVideo ? 'geprobeerd te videobellen' : 'gebeld'}.` },
        { type: 'missed_call' }
      );
    }
  });

  socket.on('call:decline', ({ to }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:declined');
    // Bewust geweigerd → geen gemiste oproep
    activeCalls.delete(socket.data.uid);
    activeCalls.delete(to);
    delete pendingCalls[socket.data.uid];
    delete pendingCalls[to];
  });

  socket.on('call:renegotiate', ({ to, signal }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:renegotiate', { signal });
  });
};
