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

  test('heartbeats from both participants keep the call busy', async () => {
    const store = await createActiveCall();

    expect(await store.isUserInCall('caller')).toBe(true);
    expect(await store.isUserInCall('callee')).toBe(true);
    expect(await store.touchActiveCall('lease-session', 'caller', 'socket-caller-new'))
      .toEqual(expect.objectContaining({
        callerSocketId: 'socket-caller-new',
        callerHeartbeatAt: expect.any(Number),
        heartbeatAt: expect.any(Number),
      }));
    expect(await store.touchActiveCall('lease-session', 'callee', 'socket-callee-new'))
      .toEqual(expect.objectContaining({
        calleeSocketId: 'socket-callee-new',
        calleeHeartbeatAt: expect.any(Number),
      }));
  });

  test('one participant cannot keep an abandoned call alive', async () => {
    const store = await createActiveCall('abandoned-session');
    const state = require('../src/state');
    state.activeCallSessions['abandoned-session'].calleeHeartbeatAt = Date.now() - 76_000;

    expect(await store.touchActiveCall('abandoned-session', 'caller', 'socket-caller-new')).toBeNull();
    expect(await store.isUserInCall('caller')).toBe(false);
    expect(await store.isUserInCall('callee')).toBe(false);
  });

  test('legacy shared heartbeat is frozen per participant during migration', async () => {
    const store = await createActiveCall('legacy-migration-session');
    const state = require('../src/state');
    const legacyHeartbeatAt = Date.now() - 60_000;
    delete state.activeCallSessions['legacy-migration-session'].callerHeartbeatAt;
    delete state.activeCallSessions['legacy-migration-session'].calleeHeartbeatAt;
    state.activeCallSessions['legacy-migration-session'].heartbeatAt = legacyHeartbeatAt;

    const active = await store.touchActiveCall('legacy-migration-session', 'caller', 'socket-caller-new');

    expect(active.callerHeartbeatAt).toBeGreaterThan(legacyHeartbeatAt);
    expect(active.calleeHeartbeatAt).toBe(legacyHeartbeatAt);
  });

  test('legacy active calls without a heartbeat no longer block new calls', async () => {
    const store = await createActiveCall('legacy-session');
    const state = require('../src/state');
    delete state.activeCallSessions['legacy-session'].heartbeatAt;
    delete state.activeCallSessions['legacy-session'].callerHeartbeatAt;
    delete state.activeCallSessions['legacy-session'].calleeHeartbeatAt;

    expect(await store.isUserInCall('callee')).toBe(false);
    expect(await store.getActiveCall('legacy-session')).toBeNull();
  });

  test('expired in-memory leases are cleared', async () => {
    const store = await createActiveCall('expired-session');
    const state = require('../src/state');
    state.activeCallSessions['expired-session'].heartbeatAt = Date.now() - 76_000;
    state.activeCallSessions['expired-session'].callerHeartbeatAt = Date.now() - 76_000;
    state.activeCallSessions['expired-session'].calleeHeartbeatAt = Date.now() - 76_000;

    expect(await store.isUserInCall('caller')).toBe(false);
    expect(await store.getActiveCall('expired-session')).toBeNull();
  });
});
