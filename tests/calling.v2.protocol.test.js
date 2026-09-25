const {
  CALL_STATES,
  createSession,
  applyCommand,
} = require('../src/calling/v2/protocol');

function initial() {
  return createSession({
    sessionId: 'session-1',
    requestId: 'request-1',
    callerUid: 'caller',
    calleeUid: 'callee',
    mediaType: 'audio',
    now: '2026-01-01T00:00:00.000Z',
  });
}

function apply(session, command, actorUid, reason) {
  return applyCommand(session, {
    command,
    actorUid,
    reason,
    now: '2026-01-01T00:00:01.000Z',
  });
}

describe('Calling v2 protocol', () => {
  test('requires both peers before an accepted call becomes active', () => {
    let result = apply(initial(), 'INVITE_READY', 'caller');
    expect(result.session.state).toBe(CALL_STATES.RINGING);
    result = apply(result.session, 'ACCEPT', 'callee');
    expect(result.session.state).toBe(CALL_STATES.CONNECTING);
    result = apply(result.session, 'MEDIA_CONNECTED', 'caller');
    expect(result.session.state).toBe(CALL_STATES.CONNECTING);
    result = apply(result.session, 'MEDIA_CONNECTED', 'callee');
    expect(result.session.state).toBe(CALL_STATES.ACTIVE);
    expect(result.session.revision).toBe(5);
  });

  test('only the callee can accept a ringing call', () => {
    const ringing = apply(initial(), 'INVITE_READY', 'caller').session;
    expect(apply(ringing, 'ACCEPT', 'caller')).toEqual({ ok: false, code: 'INVALID_TRANSITION' });
  });

  test('network loss returns an active session to connecting', () => {
    const session = { ...initial(), state: CALL_STATES.ACTIVE, mediaReadyUids: ['caller', 'callee'] };
    const result = apply(session, 'NETWORK_LOST', 'caller');
    expect(result.session.state).toBe(CALL_STATES.CONNECTING);
    expect(result.session.mediaReadyUids).toEqual(['callee']);
    expect(result.session.iceRestartSequence).toBe(1);
  });

  test('each accepted network loss advances the authoritative ICE restart sequence', () => {
    const active = { ...initial(), state: CALL_STATES.ACTIVE, mediaReadyUids: ['caller', 'callee'] };
    const first = apply(active, 'NETWORK_LOST', 'callee').session;
    const second = apply(first, 'NETWORK_LOST', 'caller').session;

    expect(first.iceRestartSequence).toBe(1);
    expect(second.iceRestartSequence).toBe(2);
  });

  test('records a shared hangup reason and the terminating participant', () => {
    const session = { ...initial(), state: CALL_STATES.ACTIVE };
    const result = apply(session, 'END', 'callee');
    expect(result.session).toMatchObject({
      state: CALL_STATES.ENDED,
      terminalReason: 'hangup',
      terminalByUid: 'callee',
    });
  });

  test('rejects unsupported failure reasons', () => {
    expect(apply(initial(), 'FAIL', 'caller', 'made_up')).toEqual({ ok: false, code: 'INVALID_REASON' });
    expect(apply(initial(), 'FAIL', 'caller', 'declined')).toEqual({ ok: false, code: 'INVALID_REASON' });
  });
});
