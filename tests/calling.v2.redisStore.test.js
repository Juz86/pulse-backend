const {
  LIVE_SESSION_TTL_SECONDS,
  TERMINAL_SESSION_TTL_SECONDS,
  RINGING_DEADLINES_KEY,
  CONNECTING_DEADLINES_KEY,
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
    await expect(store.listDueRinging(Date.now())).resolves.toEqual({ status: 'UNAVAILABLE' });
    await expect(store.removeRingingDeadline(session.sessionId)).resolves.toEqual({ status: 'UNAVAILABLE' });
    await expect(store.listDueConnecting(Date.now())).resolves.toEqual({ status: 'UNAVAILABLE' });
    await expect(store.removeConnectingDeadline(session.sessionId)).resolves.toEqual({ status: 'UNAVAILABLE' });
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
    expect(args[12]).toBe('1');
    expect(args[13]).toBe('');
    expect(args[14]).toBe('');
  });

  test('indexes ringing deadlines and returns due session ids', async () => {
    const ringing = {
      ...session,
      state: 'RINGING',
      revision: 2,
      ringingDeadlineAt: '2026-01-01T00:00:45.000Z',
    };
    const redis = {
      eval: jest.fn().mockResolvedValue(JSON.stringify({ status: 'APPLIED', session: JSON.stringify(ringing) })),
      zrangebyscore: jest.fn().mockResolvedValue([session.sessionId]),
    };
    const store = new RedisCallV2Store(() => redis);

    await store.commit({ currentRevision: 1, nextSession: ringing, eventId: 'event-123' });
    await expect(store.listDueRinging(Date.parse(ringing.ringingDeadlineAt)))
      .resolves.toEqual({ status: 'FOUND', sessionIds: [session.sessionId] });

    const args = redis.eval.mock.calls[0];
    expect(args[1]).toBe(6);
    expect(args[6]).toBe(RINGING_DEADLINES_KEY);
    expect(args[7]).toBe(CONNECTING_DEADLINES_KEY);
    expect(args[13]).toBe(Date.parse(ringing.ringingDeadlineAt));
    expect(redis.zrangebyscore).toHaveBeenCalledWith(
      RINGING_DEADLINES_KEY,
      '-inf',
      Date.parse(ringing.ringingDeadlineAt),
      'LIMIT',
      0,
      100,
    );
  });

  test('indexes connecting deadlines and returns due session ids', async () => {
    const connecting = {
      ...session,
      state: 'CONNECTING',
      revision: 3,
      connectingDeadlineAt: '2026-01-01T00:00:30.000Z',
    };
    const redis = {
      eval: jest.fn().mockResolvedValue(JSON.stringify({ status: 'APPLIED', session: JSON.stringify(connecting) })),
      zrangebyscore: jest.fn().mockResolvedValue([session.sessionId]),
    };
    const store = new RedisCallV2Store(() => redis);

    await store.commit({ currentRevision: 2, nextSession: connecting, eventId: 'event-123' });
    await expect(store.listDueConnecting(Date.parse(connecting.connectingDeadlineAt)))
      .resolves.toEqual({ status: 'FOUND', sessionIds: [session.sessionId] });

    const args = redis.eval.mock.calls[0];
    expect(args[14]).toBe(Date.parse(connecting.connectingDeadlineAt));
    expect(redis.zrangebyscore).toHaveBeenCalledWith(
      CONNECTING_DEADLINES_KEY,
      '-inf',
      Date.parse(connecting.connectingDeadlineAt),
      'LIMIT',
      0,
      100,
    );
  });
});
