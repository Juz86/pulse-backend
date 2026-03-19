jest.mock('../src/firebase', () => ({
  admin: { auth: () => ({ verifyIdToken: jest.fn() }) },
  db: {},
}));

const { makeRateLimiter } = require('../src/middleware');

describe('makeRateLimiter()', () => {
  it('laat verzoeken door tot de limiet', () => {
    const check = makeRateLimiter(3);
    expect(check()).toBe(true);
    expect(check()).toBe(true);
    expect(check()).toBe(true);
    expect(check()).toBe(false); // limiet bereikt
  });

  it('reset na 1 minuut', () => {
    jest.useFakeTimers();
    const check = makeRateLimiter(2);
    check(); check();
    expect(check()).toBe(false);
    jest.advanceTimersByTime(61_000);
    expect(check()).toBe(true); // reset
    jest.useRealTimers();
  });
});
