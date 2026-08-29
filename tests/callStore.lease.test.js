jest.mock('../src/redis', () => ({
  getRedis: () => null,
}));

describe('call session lease', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  async function createActiveCall(sessionId = 'lease-session') {
    const store = require('../src/callStore');
    await store.createPendingCall({
      sessionId,
      from: 'caller',
      to: 'callee',
      offer: { type: 'offer', sdp: 'offer' },
    });
    const result = await store.claimPendingCall(
      sessionId,
      'callee',
      'caller',
      'socket-callee',
      'socket-caller',
      { type: 'answer', sdp: 'answer' },
    );
    expect(result.claimed).toBe(true);
    return store;
  }

  test('a heartbeat keeps both call participants busy', async () => {
    const store = await createActiveCall();

    expect(await store.isUserInCall('caller')).toBe(true);
    expect(await store.isUserInCall('callee')).toBe(true);
    expect(await store.touchActiveCall('lease-session', 'caller', 'socket-caller-new'))
      .toEqual(expect.objectContaining({
        callerSocketId: 'socket-caller-new',
        heartbeatAt: expect.any(Number),
      }));
  });

  test('legacy active calls without a heartbeat no longer block new calls', async () => {
    const store = await createActiveCall('legacy-session');
    const state = require('../src/state');
    delete state.activeCallSessions['legacy-session'].heartbeatAt;

    expect(await store.isUserInCall('callee')).toBe(false);
    expect(await store.getActiveCall('legacy-session')).toBeNull();
  });

  test('expired in-memory leases are cleared', async () => {
    const store = await createActiveCall('expired-session');
    const state = require('../src/state');
    state.activeCallSessions['expired-session'].heartbeatAt = Date.now() - 76_000;

    expect(await store.isUserInCall('caller')).toBe(false);
    expect(await store.getActiveCall('expired-session')).toBeNull();
  });
});
