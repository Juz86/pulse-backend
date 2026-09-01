const CALL_OFFER_MAX_PER_HOUR = 120;

function buildSocketRateLimitResponse(event, args = []) {
  if (event !== 'call:offer') return null;
  const payload = args?.[0];
  const sessionId = payload && typeof payload === 'object'
    ? payload.sessionId || null
    : null;
  return {
    event: 'call:unavailable',
    payload: {
      sessionId,
      reason: 'rate_limited',
    },
  };
}

module.exports = {
  CALL_OFFER_MAX_PER_HOUR,
  buildSocketRateLimitResponse,
};
