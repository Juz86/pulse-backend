const {
  CALL_OFFER_MAX_PER_HOUR,
  buildSocketRateLimitResponse,
} = require('../src/socket/rateLimitResponse');

describe('socket call rate-limit response', () => {
  test('allows normal repeated call usage without the old 15-per-hour lockout', () => {
    expect(CALL_OFFER_MAX_PER_HOUR).toBe(120);
  });

  test('ends a rate-limited call attempt explicitly with its session id', () => {
    expect(buildSocketRateLimitResponse('call:offer', [{ sessionId: 'call-42' }])).toEqual({
      event: 'call:unavailable',
      payload: {
        sessionId: 'call-42',
        reason: 'rate_limited',
      },
    });
  });

  test('does not emit call errors for unrelated rate-limited events', () => {
    expect(buildSocketRateLimitResponse('message:send', [{ sessionId: 'message-1' }])).toBeNull();
  });
});
