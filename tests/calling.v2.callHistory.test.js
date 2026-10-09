const mockServerTimestamp = { _serverTimestamp: true };

function createHarness({ duplicate = false, hasConversation = true } = {}) {
  const eventRef = { id: 'event-ref' };
  const conversationRef = {
    id: 'conversation-1',
    collection: jest.fn(() => ({ doc: jest.fn(() => eventRef) })),
  };
  const conversationDoc = {
    id: 'conversation-1',
    ref: conversationRef,
    data: () => ({ members: ['caller', 'callee'], isGroup: false }),
  };
  const query = {
    get: jest.fn().mockResolvedValue({ docs: hasConversation ? [conversationDoc] : [] }),
  };
  const collection = {
    where: jest.fn(() => query),
  };
  const transaction = {
    get: jest.fn().mockResolvedValue({ exists: duplicate }),
    set: jest.fn(),
    update: jest.fn(),
  };
  const database = {
    collection: jest.fn(() => collection),
    runTransaction: jest.fn(async (callback) => callback(transaction)),
  };
  const firebaseAdmin = {
    firestore: { FieldValue: { serverTimestamp: jest.fn(() => mockServerTimestamp) } },
  };
  return { database, firebaseAdmin, transaction, conversationRef, eventRef };
}

describe('Calling v2 call history', () => {
  const session = {
    sessionId: 'session/123',
    callerUid: 'caller',
    calleeUid: 'callee',
    mediaType: 'audio',
    state: 'ENDED',
    terminalReason: 'missed',
    updatedAt: '2026-10-08T20:00:00.000Z',
  };

  test('stores one call event and updates the conversation summary per participant', async () => {
    const { createCallHistoryRecorder, callEventDocumentId } = require('../src/calling/v2/callHistory');
    const harness = createHarness();
    const recordCallHistory = createCallHistoryRecorder(harness);

    const result = await recordCallHistory(session);

    expect(result.status).toBe('CREATED');
    expect(harness.conversationRef.collection).toHaveBeenCalledWith('messages');
    expect(callEventDocumentId(session.sessionId)).not.toContain('/');
    expect(harness.transaction.set).toHaveBeenCalledWith(harness.eventRef, expect.objectContaining({
      sessionId: session.sessionId,
      terminalReason: 'missed',
      type: 'call',
      messageType: 'call',
      protocol: 'pulse_call_v2',
      createdAt: mockServerTimestamp,
    }));
    expect(harness.transaction.update).toHaveBeenCalledWith(
      harness.conversationRef,
      expect.objectContaining({
        lastMessageType: 'call',
        lastCallEvent: expect.objectContaining({
          presentations: {
            caller: { kind: 'outgoing_unanswered', label: 'Geen antwoord' },
            callee: { kind: 'missed_incoming', label: 'Gemiste spraakoproep' },
          },
        }),
      }),
    );
    expect(result.message).toMatchObject({
      id: expect.any(String),
      conversationId: 'conversation-1',
      type: 'call',
      sessionId: session.sessionId,
    });
  });

  test('does not create a second event for the same session', async () => {
    const { createCallHistoryRecorder } = require('../src/calling/v2/callHistory');
    const harness = createHarness({ duplicate: true });

    const result = await createCallHistoryRecorder(harness)(session);

    expect(result.status).toBe('DUPLICATE');
    expect(harness.transaction.set).not.toHaveBeenCalled();
    expect(harness.transaction.update).not.toHaveBeenCalled();
  });

  test('stores a declined call with participant-specific presentation', async () => {
    const { createCallHistoryRecorder } = require('../src/calling/v2/callHistory');
    const harness = createHarness();

    const result = await createCallHistoryRecorder(harness)({
      ...session,
      terminalReason: 'declined',
    });

    expect(result).toMatchObject({
      status: 'CREATED',
      callEvent: {
        terminalReason: 'declined',
        presentations: {
          caller: { kind: 'outgoing_declined', label: 'Oproep geweigerd' },
          callee: { kind: 'incoming_declined', label: 'Oproep geweigerd' },
        },
      },
      message: { text: 'Oproep geweigerd' },
    });
  });

  test('ignores terminal states that do not belong in call history yet', async () => {
    const { createCallHistoryRecorder } = require('../src/calling/v2/callHistory');
    const harness = createHarness();

    const result = await createCallHistoryRecorder(harness)({
      ...session,
      terminalReason: 'hangup',
    });

    expect(result).toEqual({ status: 'IGNORED' });
    expect(harness.database.collection).not.toHaveBeenCalled();
  });
});
