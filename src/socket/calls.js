const { admin, db } = require('../firebase');
const { sendPush } = require('../push');
const {
  activeCalls,
  activeCallSessions,
  pendingCalls,
  clearCallSession,
  getCallPeerSocketId,
  getSocketId,
  getSocketIds,
} = require('../state');
const { cleanupCommunicationsForUser, resolveConversationHistoryRules } = require('../cleanup');

function buildSessionId() {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getPendingCallByCallee(calleeUid) {
  return Object.values(pendingCalls).find((call) => call?.to === calleeUid) || null;
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

function deletePendingCallsStartedByUser(uid) {
  Object.entries(pendingCalls).forEach(([sessionId, call]) => {
    if (call?.from === uid) delete pendingCalls[sessionId];
  });
}

function getPendingCallForAnswer(sessionId, calleeUid, callerUid) {
  if (sessionId) return pendingCalls[sessionId] || null;
  return Object.values(pendingCalls).find((call) => call?.to === calleeUid && call?.from === callerUid) || null;
}

function emitToSocketIds(io, socketIds, event, payload, excludedSocketId = null) {
  socketIds.forEach((socketId) => {
    if (socketId && socketId !== excludedSocketId) io.to(socketId).emit(event, payload);
  });
}

function resolvePeerSocketId(sessionId, fromUid, toUid) {
  return getCallPeerSocketId(sessionId, fromUid, toUid) || getSocketId(toUid);
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
  socket.on('call:video-upgrade', ({ to, sessionId }) => {
    const targetSocket = resolvePeerSocketId(sessionId, uid, to);
    if (targetSocket) io.to(targetSocket).emit('call:video-upgrade', { sessionId: sessionId || null });
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
  socket.on('call:offer', async ({ to, offer, isVideo, callerName, sessionId }) => {
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
    const targetSocketIds = getSocketIds(to);
    if (targetSocketIds.length > 0) {
      // Controleer of ontvanger al in een actief gesprek zit
      if (activeCalls.has(to)) {
        socket.emit('call:busy', { to, sessionId: effectiveSessionId });
        return;
      }
      // Voorkom dubbele inkomende oproep notificaties voor hetzelfde gesprek
      if (getPendingCallByCallee(to)) return;
      // Bijhouden dat deze oproep uitstaat (nog niet beantwoord)
      pendingCalls[effectiveSessionId] = {
        sessionId: effectiveSessionId,
        from: uid,
        to,
        offer,
        callerName,
        isVideo: !!isVideo,
        callerSocketId: socket.id,
        recipientSocketIds: targetSocketIds,
        createdAt: Date.now(),
      };
      // Eén gebruiker kan op telefoon, tablet en web ingelogd zijn. Alle
      // apparaten rinkelen; het eerste antwoord claimt de call hieronder.
      emitToSocketIds(io, targetSocketIds, 'call:offer', {
        from: uid, fromUid: uid, offer, isVideo, callerName, sessionId: effectiveSessionId,
      });
      // Een actieve socket betekent niet dat Android de WebView nog uitvoert:
      // op de achtergrond wordt die vaak gepauzeerd. Stuur daarom ook een
      // hoog-prioritaire callpush; op de voorgrond blijft de socket-overlay de
      // primaire UI en op de achtergrond opent de push de antwoord/weiger-flow.
      sendPush(to,
        {
          title: isVideo ? '📹 Inkomend videogesprek' : '📞 Inkomende oproep',
          body: `${callerName || 'Iemand'} belt je via Pulse.`,
        },
        {
          type: 'incoming_call',
          callSessionId: effectiveSessionId,
          fromUid: uid,
          callerName: callerName || 'Iemand',
          isVideo: !!isVideo,
        }
      );
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
    const existingSession = sessionId ? activeCallSessions[sessionId] : null;
    if (existingSession && existingSession.calleeUid === uid && existingSession.calleeSocketId !== socket.id) {
      socket.emit('call:ended', { sessionId, reason: 'answered_elsewhere' });
      return;
    }
    const pendingCall = getPendingCallForAnswer(sessionId, uid, to);
    if (pendingCall && pendingCall.to === uid && pendingCall.from === to) {
      const acceptedSessionId = pendingCall.sessionId;
      activeCallSessions[acceptedSessionId] = {
        callerUid: pendingCall.from,
        callerSocketId: pendingCall.callerSocketId || getSocketId(to),
        calleeUid: uid,
        calleeSocketId: socket.id,
      };
      deletePendingCallBySession(acceptedSessionId);
      emitToSocketIds(io, pendingCall.recipientSocketIds || [], 'call:ended', {
        sessionId: acceptedSessionId,
        reason: 'answered_elsewhere',
      }, socket.id);
    }
    const targetSocket = resolvePeerSocketId(sessionId, uid, to);
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
    const targetSocket = resolvePeerSocketId(sessionId, uid, to);
    if (targetSocket) io.to(targetSocket).emit('call:ice-candidate', { candidate, fromUid: uid, sessionId: sessionId || null });
  });

  socket.on('call:end', async ({ to, sessionId }) => {
    const pendingCall = sessionId ? pendingCalls[sessionId] : getPendingCallByCallee(to);
    if (pendingCall?.from === uid) {
      emitToSocketIds(io, pendingCall.recipientSocketIds || getSocketIds(to), 'call:ended', { sessionId: pendingCall.sessionId });
    } else {
      const targetSocket = resolvePeerSocketId(sessionId, uid, to);
      if (targetSocket) io.to(targetSocket).emit('call:ended', { sessionId: sessionId || null });
    }
    // Beide users zijn niet meer in een actief gesprek
    activeCalls.delete(socket.data.uid);
    activeCalls.delete(to);
    // Als oproep nog uitstond (niet beantwoord) → gemiste oproep notificatie
    if (pendingCall) {
      const { callerName, isVideo, sessionId: pendingSessionId } = pendingCall;
      deletePendingCallBySession(pendingSessionId);
      sendPush(to,
        { title: '📞 Gemiste oproep', body: `${callerName} heeft je ${isVideo ? 'geprobeerd te videobellen' : 'gebeld'}.` },
        { type: 'missed_call' }
      );
    }
    clearCallSession(sessionId);
  });

  socket.on('call:decline', ({ to, sessionId }) => {
    const targetSocket = resolvePeerSocketId(sessionId, uid, to);
    if (targetSocket) io.to(targetSocket).emit('call:declined', { sessionId: sessionId || null });
    // Bewust geweigerd → geen gemiste oproep
    activeCalls.delete(socket.data.uid);
    activeCalls.delete(to);
    if (sessionId) deletePendingCallBySession(sessionId);
    else {
      deletePendingCallsForUser(socket.data.uid);
      deletePendingCallsForUser(to);
    }
    clearCallSession(sessionId);
  });

  socket.on('call:busy', ({ to, sessionId }) => {
    const targetSocket = resolvePeerSocketId(sessionId, uid, to);
    if (targetSocket) io.to(targetSocket).emit('call:busy', { fromUid: uid, sessionId: sessionId || null });
    if (sessionId) deletePendingCallBySession(sessionId);
  });

  socket.on('call:renegotiate', ({ to, signal, sessionId }) => {
    const targetSocket = resolvePeerSocketId(sessionId, uid, to);
    if (targetSocket) io.to(targetSocket).emit('call:renegotiate', { signal, sessionId: sessionId || null });
  });

  socket.on('disconnect', () => {
    // Bewaar pending incoming offers voor de ontvanger zodat call recovery na
    // een reload/tab-herstel nog via /calls/pending/:sessionId kan slagen.
    deletePendingCallsStartedByUser(uid);
    activeCalls.delete(uid);
    Object.entries(activeCallSessions).forEach(([sessionId, session]) => {
      if (session?.callerUid === uid || session?.calleeUid === uid) clearCallSession(sessionId);
    });
  });
};
