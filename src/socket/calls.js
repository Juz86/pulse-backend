const { admin, db } = require('../firebase');
const { sendPush } = require('../push');
const {
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
} = require('../callStore');
const { cleanupCommunicationsForUser, resolveConversationHistoryRules } = require('../cleanup');

function buildSessionId() {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function emitToUserExcept(io, userUid, excludedSocketId, event, payload) {
  const room = io.to(userUid);
  if (typeof room.except === 'function') room.except(excludedSocketId).emit(event, payload);
  else room.emit(event, payload);
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
  const onCall = (event, handler) => {
    socket.on(event, (payload = {}) => Promise.resolve(handler(payload || {})).catch((error) => {
      console.error(`${event} fout:`, error);
      socket.emit('call:unavailable', {
        sessionId: payload?.sessionId || null,
        reason: 'signaling_unavailable',
      });
    }));
  };

  // ── Video upgrade doorsturen naar de andere kant ──
  onCall('call:video-upgrade', async ({ to, sessionId }) => {
    io.to(to).emit('call:video-upgrade', { sessionId: sessionId || null });
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
  onCall('call:offer', async ({ to, offer, isVideo, callerName, sessionId }) => {
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
    // Een ontbrekende socket betekent alleen dat de WebView niet actief is;
    // Android kan in de achtergrond of na afsluiten nog steeds via FCM rinkelen.
    // De offer moet daarom altijd bewaard blijven tot de ontvanger hem kan
    // herstellen vanuit de inkomende oproepmelding.
    if (await isUserInCall(to)) {
      socket.emit('call:busy', { to, sessionId: effectiveSessionId });
      return;
    }
    // Voorkom dubbele inkomende oproep notificaties voor hetzelfde gesprek
    const created = await createPendingCall({
      sessionId: effectiveSessionId,
      from: uid,
      to,
      offer,
      callerName,
      isVideo: !!isVideo,
      callerSocketId: socket.id,
      createdAt: Date.now(),
    });
    if (!created.created) {
      if (created.reason === 'busy') socket.emit('call:busy', { to, sessionId: effectiveSessionId });
      return;
    }
    // De user-room werkt ook over meerdere Railway instances via de Redis adapter.
    io.to(to).emit('call:offer', {
      from: uid, fromUid: uid, offer, isVideo, callerName, sessionId: effectiveSessionId,
    });
    // Dit moet buiten de socket-voorwaarde blijven: bij een afgesloten app is
    // er juist geen socket meer, terwijl FCM dan de enige manier is om het
    // inkomende gesprek te tonen en de opgeslagen offer te herstellen.
    sendPush(to,
      {
        title: isVideo ? '📹 Inkomend videogesprek' : '📞 Inkomende oproep',
        body: `${callerName || 'Iemand'} belt je via Pulse.`,
      },
      {
        type: 'incoming_call',
        callSessionId: effectiveSessionId,
        sessionId: effectiveSessionId,
        fromUid: uid,
        callerName: callerName || 'Iemand',
        isVideo: !!isVideo,
      }
    );
  });

  onCall('call:answer', async ({ to, answer, sessionId }) => {
    const result = await claimPendingCall(
      sessionId, uid, to, socket.id, null, answer,
    );
    if (!result.claimed) {
      socket.emit('call:ended', {
        sessionId: sessionId || null,
        reason: result.reason === 'answered_elsewhere' ? 'answered_elsewhere' : 'call_expired',
      });
      return;
    }
    const { pending, active } = result;
    emitToUserExcept(io, uid, socket.id, 'call:ended', {
      sessionId: pending.sessionId,
      reason: 'answered_elsewhere',
    });
    io.to(to).emit('call:answer', { answer, fromUid: uid, sessionId: pending.sessionId });
    const answeredSessionId = active.sessionId;
    sendPush(uid, null, {
      type: 'call_cancelled',
      reason: 'answered',
      callSessionId: answeredSessionId,
      sessionId: answeredSessionId,
    });
  });

  onCall('call:ice-candidate', async ({ to, candidate, sessionId }) => {
    await addCallerCandidate(sessionId, uid, to, candidate);
    io.to(to).emit('call:ice-candidate', { candidate, fromUid: uid, sessionId: sessionId || null });
  });

  onCall('call:end', async ({ to, sessionId }) => {
    const pendingCall = sessionId ? await getPendingCall(sessionId) : await getPendingCallByCallee(to);
    const active = sessionId ? await getActiveCall(sessionId) : null;
    if (pendingCall?.from === uid) {
      io.to(to).emit('call:ended', { sessionId: pendingCall.sessionId });
    } else {
      io.to(to).emit('call:ended', { sessionId: sessionId || null });
    }
    const endedSessionId = sessionId || pendingCall?.sessionId || '';
    sendPush(to, null, {
      type: 'call_cancelled',
      callSessionId: endedSessionId,
      sessionId: endedSessionId,
    });
    // Als oproep nog uitstond (niet beantwoord) → gemiste oproep notificatie
    if (pendingCall) {
      const { callerName, isVideo, sessionId: pendingSessionId } = pendingCall;
      await deletePendingCall(pendingSessionId);
      sendPush(to,
        { title: '📞 Gemiste oproep', body: `${callerName} heeft je ${isVideo ? 'geprobeerd te videobellen' : 'gebeld'}.` },
        { type: 'missed_call' }
      );
    }
    if (active) await clearActiveCall(sessionId);
  });

  onCall('call:decline', async ({ to, sessionId }) => {
    io.to(to).emit('call:declined', { sessionId: sessionId || null });
    // Bewust geweigerd → geen gemiste oproep
    if (sessionId) await deletePendingCall(sessionId);
    sendPush(uid, null, {
      type: 'call_cancelled',
      callSessionId: sessionId || '',
      sessionId: sessionId || '',
    });
    await clearActiveCall(sessionId);
  });

  onCall('call:busy', async ({ to, sessionId }) => {
    io.to(to).emit('call:busy', { fromUid: uid, sessionId: sessionId || null });
    if (sessionId) await deletePendingCall(sessionId);
  });

  onCall('call:renegotiate', async ({ to, signal, sessionId }) => {
    io.to(to).emit('call:renegotiate', { signal, sessionId: sessionId || null });
  });

  onCall('call:resume', async ({ to, sessionId, needsAnswer }) => {
    const active = await resumeActiveCall(sessionId, uid, socket.id);
    if (!active) return;
    const peerUid = active.callerUid === uid ? active.calleeUid : active.callerUid;
    io.to(peerUid).emit('call:peer-resumed', { sessionId, fromUid: uid });
    if (needsAnswer && uid === active.callerUid && active.answer) {
      socket.emit('call:answer', { answer: active.answer, fromUid: peerUid, sessionId });
    }
    if (to && to !== peerUid) console.warn('call:resume peer mismatch', { sessionId, uid });
  });

  onCall('call:heartbeat', async ({ sessionId }) => {
    const active = await touchActiveCall(sessionId, uid, socket.id);
    socket.emit('call:heartbeat:ack', {
      sessionId: sessionId || null,
      active: Boolean(active),
    });
  });

  socket.on('disconnect', () => {
    // De korte heartbeat-lease houdt ruimte voor netwerkherstel. Zonder een
    // levende gesprekspartner vervalt de bezetstatus automatisch.
  });
};
