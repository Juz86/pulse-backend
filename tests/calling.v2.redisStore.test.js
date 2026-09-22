const {
  LIVE_SESSION_TTL_SECONDS,
  TERMINAL_SESSION_TTL_SECONDS,
  RedisCallV2Store,
} = require('../src/calling/v2/redisStore');

const session = {
  sessionId: 'session-123', requestId: 'request-123', callerUid: 'a', calleeUid: 'b',
  state: 'PREPARING', revision: 1,
};

describe('Calling v2 Redis store', () => {
  test('fails closed without Redis', async () => {
    const store = new RedisCallV2Store(() => null);
    await expect(store.create(session)).resolves.toEqual({ status: 'UNAVAILABLE' });
    await expect(store.get(session.sessionId)).resolves.toEqual({ status: 'UNAVAILABLE' });
    await expect(store.hasEvent(session.sessionId, 'event-123')).resolves.toEqual({ status: 'UNAVAILABLE' });
    await expect(store.commit({ currentRevision: 1, nextSession: session, eventId: 'event-123' }))
      .resolves.toEqual({ status: 'UNAVAILABLE' });
  });

  test('creates session, participant leases and idempotency key atomically', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(JSON.stringify({ status: 'CREATED', session: JSON.stringify(session) })) };
    const store = new RedisCallV2Store(() => redis);
    const result = await store.create(session);
    expect(result).toEqual({ status: 'CREATED', session });
    const args = redis.eval.mock.calls[0];
    expect(args[1]).toBe(4);
    expect(args.slice(2, 6)).toEqual([
      'pulse:calling:v2:session:session-123',
      'pulse:calling:v2:user:a',
      'pulse:calling:v2:user:b',
      'pulse:calling:v2:request:a:request-123',
    ]);
    expect(args).toContain(LIVE_SESSION_TTL_SECONDS);
  });

  test('uses the shorter TTL and releases leases for ended sessions', async () => {
    const ended = { ...session, state: 'ENDED', revision: 2 };
    const redis = { eval: jest.fn().mockResolvedValue(JSON.stringify({ status: 'APPLIED', session: JSON.stringify(ended) })) };
    const store = new RedisCallV2Store(() => redis);
    await store.commit({ currentRevision: 1, nextSession: ended, eventId: 'event-123' });
    const args = redis.eval.mock.calls[0];
    expect(args).toContain(TERMINAL_SESSION_TTL_SECONDS);
    expect(args[args.length - 1]).toBe('1');
  });
});
