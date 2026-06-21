const { admin, db } = require('../firebase');
const { sendPush } = require('../push');
const { activeCalls, pendingCalls, getSocketId } = require('../state');
const { cleanupCommunicationsForUser, resolveConversationHistoryRules } = require('../cleanup');

function buildSessionId() {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getPendingCallByCallee(calleeUid) {
  return Object.values(pendingCalls).find((call) => call?.to === calleeUid) || null;
}

function getPendingCallByCaller(callerUid) {
  return Object.values(pendingCalls).find((call) => call?.from === callerUid) || null;
}

function deletePendingCallBySession(sessionId) {
  if (!sessionId) return;
  delete pendingCalls[sessionId];
}

function deletePendingCallsForUser(uid) {
  Object.entries(pendingCalls).forEach(([sessionId, call]) => {
    if (call?.from === uid || call?.to === uid) delete pendingCalls[sessionId];
  });
}

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
      const convDoc = await db.collection('conversations').doc(convId).get();
      const members = convDoc.exists ? (convDoc.data().members || []) : [];
      const savedMsg = { id: msgRef.id, convId, type: 'call', isVideo: !!isVideo, direction, duration: safeDuration, senderId, senderName };
      const historyRules = await resolveConversationHistoryRules(members);
      const retentionKey = isVideo ? 'videoRetentionDays' : 'callRetentionDays';
      const shouldDeleteImmediately = Number(historyRules?.[retentionKey] ?? 30) === 0;
      // Stuur naar iedereen in de room (als ze de chat open hebben)
      io.to(convId).emit('message:received', savedMsg);
      // Stuur ook rechtstreeks naar elk lid — ook als ze de chat niet open hebben
      emitCallLogOutsideConversation(io, convId, members, senderId, savedMsg, onlineUsers);
      if (shouldDeleteImmediately) {
        await msgRef.delete();
        await cleanupCommunicationsForUser(senderId);
      }
    } catch (e) {
      console.error('call:log fout:', e);
    }
  });

  // ── WebRTC Signaling: Bellen ──
  socket.on('call:offer', async ({ to, from, offer, isVideo, callerName, sessionId }) => {
    // Blokkeer check
    const [callerDoc, targetCallDoc] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(to).get(),
    ]);
    const targetBlocked = targetCallDoc.data()?.blockedUsers || [];
    const callerBlocked = callerDoc.data()?.blockedUsers || [];
    if (targetBlocked.includes(uid) || callerBlocked.includes(to)) {
      socket.emit('call:unavailable', { to, sessionId: sessionId || null });
      return;
    }

    const effectiveSessionId = sessionId || buildSessionId();
    const targetSocket = getSocketId(to);
    if (targetSocket) {
      // Controleer of ontvanger al in een actief gesprek zit
      if (activeCalls.has(to)) {
        socket.emit('call:busy', { to, sessionId: effectiveSessionId });
        return;
      }
      // Voorkom dubbele inkomende oproep notificaties voor hetzelfde gesprek
      if (getPendingCallByCallee(to)) return;
      io.to(targetSocket).emit('call:offer', { from, fromUid: from, offer, isVideo, callerName, sessionId: effectiveSessionId });
      // Bijhouden dat deze oproep uitstaat (nog niet beantwoord)
      pendingCalls[effectiveSessionId] = {
        sessionId: effectiveSessionId,
        from,
        to,
        offer,
        callerName,
        isVideo: !!isVideo,
        createdAt: Date.now(),
      };
    } else {
      socket.emit('call:unavailable', { to, sessionId: effectiveSessionId });
      // Gebruiker is offline → gemiste oproep notificatie
      sendPush(to,
        { title: '📞 Gemiste oproep', body: `${callerName} heeft je ${isVideo ? 'geprobeerd te videobellen' : 'gebeld'}.` },
        { type: 'missed_call' }
      );
    }
  });

  socket.on('call:answer', ({ to, answer, sessionId }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:answer', { answer, fromUid: uid, sessionId: sessionId || null });
    // Oproep beantwoord → beide users zijn nu in een actief gesprek
    activeCalls.add(socket.data.uid);
    activeCalls.add(to);
    if (sessionId) deletePendingCallBySession(sessionId);
    else {
      deletePendingCallsForUser(socket.data.uid);
      deletePendingCallsForUser(to);
    }
  });

  socket.on('call:ice-candidate', ({ to, candidate, sessionId }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:ice-candidate', { candidate, fromUid: uid, sessionId: sessionId || null });
  });

  socket.on('call:end', async ({ to, sessionId }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:ended', { sessionId: sessionId || null });
    // Beide users zijn niet meer in een actief gesprek
    activeCalls.delete(socket.data.uid);
    activeCalls.delete(to);
    // Als oproep nog uitstond (niet beantwoord) → gemiste oproep notificatie
    const pendingCall = sessionId ? pendingCalls[sessionId] : getPendingCallByCallee(to);
    if (pendingCall) {
      const { callerName, isVideo, sessionId: pendingSessionId } = pendingCall;
      deletePendingCallBySession(pendingSessionId);
      sendPush(to,
        { title: '📞 Gemiste oproep', body: `${callerName} heeft je ${isVideo ? 'geprobeerd te videobellen' : 'gebeld'}.` },
        { type: 'missed_call' }
      );
    }
  });

  socket.on('call:decline', ({ to, sessionId }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:declined', { sessionId: sessionId || null });
    // Bewust geweigerd → geen gemiste oproep
    activeCalls.delete(socket.data.uid);
    activeCalls.delete(to);
    if (sessionId) deletePendingCallBySession(sessionId);
    else {
      deletePendingCallsForUser(socket.data.uid);
      deletePendingCallsForUser(to);
    }
  });

  socket.on('call:busy', ({ to, sessionId }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:busy', { fromUid: uid, sessionId: sessionId || null });
    if (sessionId) deletePendingCallBySession(sessionId);
  });

  socket.on('call:renegotiate', ({ to, signal, sessionId }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:renegotiate', { signal, sessionId: sessionId || null });
  });

  socket.on('disconnect', () => {
    deletePendingCallsForUser(uid);
    activeCalls.delete(uid);
  });
};
