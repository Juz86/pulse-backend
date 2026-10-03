const { startCallV2TimeoutSweeper } = require('../src/calling/v2/timeouts');

describe('Calling v2 timeout sweeper', () => {
  test('publishes every session atomically expired by the service', async () => {
    const session = {
      sessionId: 'session-123',
      callerUid: 'caller',
      calleeUid: 'callee',
      state: 'ENDED',
      revision: 3,
    };
    const service = {
      expireDueRinging: jest.fn().mockResolvedValue({ status: 'APPLIED', sessions: [session] }),
    };
    const onExpired = jest.fn();
    const sweeper = startCallV2TimeoutSweeper({
      service,
      onExpired,
      intervalMs: 60_000,
      now: () => 1234,
    });

    await new Promise(setImmediate);
    sweeper.stop();

    expect(service.expireDueRinging).toHaveBeenCalledWith({ nowMs: 1234 });
    expect(onExpired).toHaveBeenCalledWith(session);
  });
});
