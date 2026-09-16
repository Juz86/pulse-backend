jest.mock('../src/redis', () => ({ getRedis: () => null }));

const {
  clearRealtimeKitSessionStoreForTests,
  ensureParticipant,
  ensureRealtimeKitSession,
  getRealtimeKitSession,
} = require('../src/realtimeKitSessionStore');

describe('RealtimeKit call session store', () => {
  beforeEach(clearRealtimeKitSessionStoreForTests);

  it('deduplicates simultaneous meeting creation in one process', async () => {
    const create = jest.fn(async () => ({
      sessionId: 'session-12345678',
      meetingId: 'meeting-id',
      callerUid: 'a',
      calleeUid: 'b',
      participants: {},
    }));
    const [first, second] = await Promise.all([
      ensureRealtimeKitSession('session-12345678', create),
      ensureRealtimeKitSession('session-12345678', create),
    ]);
    expect(first.meetingId).toBe('meeting-id');
    expect(second.meetingId).toBe('meeting-id');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('stores participant credentials per authorized Pulse user', async () => {
    const session = await ensureRealtimeKitSession('session-12345678', async () => ({
      sessionId: 'session-12345678',
      meetingId: 'meeting-id',
      callerUid: 'a',
      calleeUid: 'b',
      participants: {},
    }));
    await ensureParticipant(session.sessionId, 'a', async () => ({ participantId: 'p-a', authToken: 'token-a' }));
    expect((await getRealtimeKitSession('session-12345678')).participants.a)
      .toEqual({ participantId: 'p-a', authToken: 'token-a' });
  });

  it('deduplicates simultaneous participant creation per Pulse user', async () => {
    await ensureRealtimeKitSession('session-12345678', async () => ({
      sessionId: 'session-12345678', meetingId: 'meeting-id', callerUid: 'a', calleeUid: 'b', participants: {},
    }));
    const create = jest.fn(async () => ({ participantId: 'p-a', authToken: 'token-a' }));
    const [first, second] = await Promise.all([
      ensureParticipant('session-12345678', 'a', create),
      ensureParticipant('session-12345678', 'a', create),
    ]);
    expect(first).toEqual(second);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
