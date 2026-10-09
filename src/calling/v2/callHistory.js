const { admin, db } = require('../../firebase');

const RECORDED_TERMINAL_REASONS = new Set(['missed', 'declined']);

function buildCallPresentations(session) {
  if (session.terminalReason === 'declined') {
    return {
      [session.callerUid]: {
        kind: 'outgoing_declined',
        label: 'Oproep geweigerd',
      },
      [session.calleeUid]: {
        kind: 'incoming_declined',
        label: 'Oproep geweigerd',
      },
    };
  }

  return {
    [session.callerUid]: {
      kind: 'outgoing_unanswered',
      label: 'Geen antwoord',
    },
    [session.calleeUid]: {
      kind: 'missed_incoming',
      label: 'Gemiste spraakoproep',
    },
  };
}

function buildCallHistoryEvent(session) {
  return {
    sessionId: session.sessionId,
    mediaType: session.mediaType || 'audio',
    terminalReason: session.terminalReason,
    callerUid: session.callerUid,
    calleeUid: session.calleeUid,
    occurredAt: session.updatedAt || new Date().toISOString(),
    presentations: buildCallPresentations(session),
  };
}

function callEventDocumentId(sessionId) {
  return Buffer.from(sessionId, 'utf8').toString('base64url');
}

async function findDirectConversation(database, callerUid, calleeUid) {
  const snapshot = await database.collection('conversations')
    .where('members', 'array-contains', callerUid)
    .get();

  return snapshot.docs.find((doc) => {
    const conversation = doc.data() || {};
    const members = conversation.members || [];
    return !conversation.isGroup
      && members.length === 2
      && members.includes(callerUid)
      && members.includes(calleeUid);
  }) || null;
}

function createCallHistoryRecorder({ database = db, firebaseAdmin = admin } = {}) {
  return async function recordCallHistory(session) {
    if (
      session?.state !== 'ENDED'
      || !RECORDED_TERMINAL_REASONS.has(session?.terminalReason)
      || !session?.sessionId
      || !session?.callerUid
      || !session?.calleeUid
    ) {
      return { status: 'IGNORED' };
    }

    const conversationDoc = await findDirectConversation(
      database,
      session.callerUid,
      session.calleeUid,
    );
    if (!conversationDoc) return { status: 'CONVERSATION_NOT_FOUND' };

    const callEvent = buildCallHistoryEvent(session);
    const summaryText = session.terminalReason === 'declined'
      ? 'Oproep geweigerd'
      : 'Gemiste spraakoproep';
    const eventRef = conversationDoc.ref
      .collection('messages')
      .doc(callEventDocumentId(session.sessionId));
    const serverTimestamp = firebaseAdmin.firestore.FieldValue.serverTimestamp();

    const status = await database.runTransaction(async (transaction) => {
      const existing = await transaction.get(eventRef);
      if (existing.exists) return 'DUPLICATE';

      transaction.set(eventRef, {
        ...callEvent,
        convId: conversationDoc.id,
        conversationId: conversationDoc.id,
        type: 'call',
        messageType: 'call',
        senderId: session.callerUid,
        senderUserId: session.callerUid,
        protocol: 'pulse_call_v2',
        text: summaryText,
        isVideo: session.mediaType === 'video',
        createdAt: serverTimestamp,
      });
      transaction.update(conversationDoc.ref, {
        lastMessage: summaryText,
        lastMessageType: 'call',
        lastMessageAt: serverTimestamp,
        updatedAt: serverTimestamp,
        lastCallEvent: callEvent,
        deletedFor: [],
      });
      return 'CREATED';
    });

    return {
      status,
      conversationId: conversationDoc.id,
      callEvent,
      message: {
        id: callEventDocumentId(session.sessionId),
        convId: conversationDoc.id,
        conversationId: conversationDoc.id,
        type: 'call',
        messageType: 'call',
        senderId: session.callerUid,
        senderUserId: session.callerUid,
        protocol: 'pulse_call_v2',
        text: summaryText,
        isVideo: session.mediaType === 'video',
        createdAt: callEvent.occurredAt,
        ...callEvent,
      },
    };
  };
}

const recordCallHistory = createCallHistoryRecorder();

module.exports = {
  buildCallHistoryEvent,
  callEventDocumentId,
  createCallHistoryRecorder,
  recordCallHistory,
};
