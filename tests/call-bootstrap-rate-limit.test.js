const { isCallBootstrapRequest } = require('../src/callBootstrapRateLimit');

describe('call bootstrap rate-limit routing', () => {
  test.each([
    ['POST', '/api/native-call-auth'],
    ['GET', '/api/turn-credentials'],
    ['GET', '/calls/pending/call_123'],
    ['GET', '/calls/pending/call_123?fromUid=user-1'],
  ])('recognizes %s %s as call bootstrap traffic', (method, url) => {
    expect(isCallBootstrapRequest({ method, path: url })).toBe(true);
  });

  test.each([
    ['GET', '/api/native-call-auth'],
    ['POST', '/api/turn-credentials'],
    ['GET', '/api/turn-diagnostics'],
    ['POST', '/api/messages'],
    ['GET', '/health'],
  ])('keeps %s %s under the global limiter', (method, url) => {
    expect(isCallBootstrapRequest({ method, path: url })).toBe(false);
  });

  test('ignores query parameters when Express path is unavailable', () => {
    expect(isCallBootstrapRequest({
      method: 'GET',
      url: '/calls/pending/call_456?fromUid=user-2',
    })).toBe(true);
  });
});
