const {
  CALL_STATES,
  createSession,
  applyCommand,
  expireConnecting,
  expireRinging,
  failInviteDelivery,
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
    installationId: command === 'ACCEPT' ? 'installation-callee' : undefined,
    reason,
    now: '2026-01-01T00:00:01.000Z',
    ringingDeadlineAt: command === 'INVITE_READY' ? '2026-01-01T00:00:46.000Z' : undefined,
    connectingDeadlineAt: ['ACCEPT', 'NETWORK_LOST'].includes(command)
      ? '2026-01-01T00:00:31.000Z'
      : undefined,
  });
}

describe('Calling v2 protocol', () => {
  test('requires both peers before an accepted call becomes active', () => {
    let result = apply(initial(), 'INVITE_READY', 'caller');
    expect(result.session.state).toBe(CALL_STATES.RINGING);
    result = apply(result.session, 'ACCEPT', 'callee');
    expect(result.session.state).toBe(CALL_STATES.CONNECTING);
    expect(result.session.acceptedInstallationId).toBe('installation-callee');
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

  test('does not enter ringing without a valid server deadline', () => {
    const result = applyCommand(initial(), {
      command: 'INVITE_READY',
      actorUid: 'caller',
      now: '2026-01-01T00:00:01.000Z',
    });
    expect(result).toEqual({ ok: false, code: 'INVALID_REQUEST' });
  });

  test('expires an unanswered ringing call as missed', () => {
    const ringing = apply(initial(), 'INVITE_READY', 'caller').session;
    const result = expireRinging(ringing, { now: '2026-01-01T00:00:46.000Z' });
    expect(result.session).toMatchObject({
      state: CALL_STATES.ENDED,
      revision: 3,
      ringingDeadlineAt: null,
      terminalReason: 'missed',
      terminalByUid: null,
    });
  });

  test('ends an undeliverable incoming invite as a signaling error', () => {
    const ringing = apply(initial(), 'INVITE_READY', 'caller').session;
    const result = failInviteDelivery(ringing, { now: '2026-01-01T00:00:02.000Z' });
    expect(result.session).toMatchObject({
      state: CALL_STATES.ENDED,
      revision: 3,
      terminalReason: 'signaling_error',
      terminalByUid: null,
    });
  });

  test('expires a call that never finishes connecting', () => {
    const ringing = apply(initial(), 'INVITE_READY', 'caller').session;
    const connecting = apply(ringing, 'ACCEPT', 'callee').session;
    const result = expireConnecting(connecting, { now: '2026-01-01T00:00:31.000Z' });
    expect(result.session).toMatchObject({
      state: CALL_STATES.ENDED,
      revision: 4,
      connectingDeadlineAt: null,
      terminalReason: 'connect_timeout',
      terminalByUid: null,
    });
  });

  test('keeps the connecting deadline until both peers are ready', () => {
    const ringing = apply(initial(), 'INVITE_READY', 'caller').session;
    const connecting = apply(ringing, 'ACCEPT', 'callee').session;
    const callerReady = apply(connecting, 'MEDIA_CONNECTED', 'caller').session;
    const active = apply(callerReady, 'MEDIA_CONNECTED', 'callee').session;

    expect(callerReady.connectingDeadlineAt).toBe('2026-01-01T00:00:31.000Z');
    expect(active.connectingDeadlineAt).toBeNull();
  });

  test('network loss returns an active session to connecting', () => {
    const session = { ...initial(), state: CALL_STATES.ACTIVE, mediaReadyUids: ['caller', 'callee'] };
    const result = apply(session, 'NETWORK_LOST', 'caller');
    expect(result.session.state).toBe(CALL_STATES.CONNECTING);
    expect(result.session.mediaReadyUids).toEqual(['callee']);
    expect(result.session.iceRestartSequence).toBe(1);
    expect(result.session.connectingDeadlineAt).toBe('2026-01-01T00:00:31.000Z');
  });

  test('each accepted network loss advances the authoritative ICE restart sequence', () => {
    const active = { ...initial(), state: CALL_STATES.ACTIVE, mediaReadyUids: ['caller', 'callee'] };
    const first = apply(active, 'NETWORK_LOST', 'callee').session;
    const second = apply(first, 'NETWORK_LOST', 'caller').session;

    expect(first.iceRestartSequence).toBe(1);
    expect(second.iceRestartSequence).toBe(2);
  });

  test('does not extend an existing connecting deadline on repeated network loss', () => {
    const connecting = {
      ...initial(),
      state: CALL_STATES.CONNECTING,
      connectingDeadlineAt: '2026-01-01T00:00:31.000Z',
    };
    const result = applyCommand(connecting, {
      command: 'NETWORK_LOST',
      actorUid: 'callee',
      now: '2026-01-01T00:00:10.000Z',
      connectingDeadlineAt: '2026-01-01T00:00:40.000Z',
    });

    expect(result.session.connectingDeadlineAt).toBe('2026-01-01T00:00:31.000Z');
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
