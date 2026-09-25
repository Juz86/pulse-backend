const registerCallingV2 = require('../src/socket/calling.v2');

function harness({
  service = {},
  authorizeStart = async () => true,
  getTurnCredentials,
  sendIncomingCallPush = jest.fn(),
} = {}) {
  const handlers = {};
  const socket = {
    join: jest.fn(),
    on: jest.fn((event, handler) => { handlers[event] = handler; }),
  };
  const emitToUser = jest.fn();
  const io = {};
  registerCallingV2(io, socket, 'caller', {
    service, authorizeStart, emitToUser, getTurnCredentials, sendIncomingCallPush,
  });
  return { handlers, emitToUser, io, socket, sendIncomingCallPush };
}

describe('Calling v2 socket contract', () => {
  test('joins the authenticated user room for cross-instance delivery', () => {
    const { socket } = harness();
    expect(socket.join).toHaveBeenCalledWith('caller');
  });

  test('rejects malformed start payloads before calling the service', async () => {
    const service = { start: jest.fn() };
    const { handlers } = harness({ service });
    const callback = jest.fn();
    await handlers['call:v2:start']({ requestId: 'short', calleeUid: 'b', mediaType: 'audio' }, callback);
    expect(callback).toHaveBeenCalledWith({ ok: false, status: 'INVALID_REQUEST' });
    expect(service.start).not.toHaveBeenCalled();
  });

  test('does not expose whether an unavailable contact exists or blocked the caller', async () => {
    const service = { start: jest.fn() };
    const { handlers } = harness({ service, authorizeStart: async () => false });
    const callback = jest.fn();
    await handlers['call:v2:start']({ requestId: 'request-123', calleeUid: 'b', mediaType: 'audio' }, callback);
    expect(callback).toHaveBeenCalledWith({ ok: false, status: 'NOT_AVAILABLE' });
    expect(service.start).not.toHaveBeenCalled();
  });

  test('acknowledges and publishes an authoritative created session to both participants', async () => {
    const session = { sessionId: 'session-123', callerUid: 'caller', calleeUid: 'callee', revision: 1 };
    const service = { start: jest.fn().mockResolvedValue({ status: 'CREATED', session }) };
    const { handlers, emitToUser, io } = harness({ service });
    const callback = jest.fn();
    await handlers['call:v2:start']({ requestId: 'request-123', calleeUid: 'callee', mediaType: 'video' }, callback);
    expect(service.start).toHaveBeenCalledWith({ requestId: 'request-123', calleeUid: 'callee', mediaType: 'video', callerUid: 'caller' });
    expect(callback).toHaveBeenCalledWith({ ok: true, status: 'CREATED', session });
    expect(emitToUser).toHaveBeenNthCalledWith(1, io, 'caller', 'call:v2:updated', session);
    expect(emitToUser).toHaveBeenNthCalledWith(2, io, 'callee', 'call:v2:updated', session);
  });

  test('publishes applied commands but not duplicates', async () => {
    const session = { sessionId: 'session-123', callerUid: 'caller', calleeUid: 'callee', revision: 2 };
    const service = { command: jest.fn().mockResolvedValueOnce({ status: 'APPLIED', session }).mockResolvedValueOnce({ status: 'DUPLICATE', session }) };
    const { handlers, emitToUser } = harness({ service });
    const payload = { sessionId: 'session-123', eventId: 'event-123', expectedRevision: 1, command: 'INVITE_READY' };
    await handlers['call:v2:command'](payload, jest.fn());
    expect(emitToUser).toHaveBeenCalledTimes(2);
    await handlers['call:v2:command'](payload, jest.fn());
    expect(emitToUser).toHaveBeenCalledTimes(2);
  });

  test('sends one incoming push only after an applied invite-ready transition', async () => {
    const session = {
      protocolVersion: 2,
      sessionId: 'session-123',
      callerUid: 'caller',
      calleeUid: 'callee',
      mediaType: 'audio',
      revision: 2,
      state: 'RINGING',
    };
    const service = {
      command: jest.fn()
        .mockResolvedValueOnce({ status: 'APPLIED', session })
        .mockResolvedValueOnce({ status: 'DUPLICATE', session }),
    };
    const sendIncomingCallPush = jest.fn().mockResolvedValue(undefined);
    const { handlers } = harness({ service, sendIncomingCallPush });
    const payload = {
      sessionId: 'session-123',
      eventId: 'event-123',
      expectedRevision: 1,
      command: 'INVITE_READY',
    };

    await handlers['call:v2:command'](payload, jest.fn());
    await handlers['call:v2:command'](payload, jest.fn());

    expect(sendIncomingCallPush).toHaveBeenCalledTimes(1);
    expect(sendIncomingCallPush).toHaveBeenCalledWith(session);
  });

  test('returns only participant-authorized snapshots from the service', async () => {
    const service = { snapshot: jest.fn().mockResolvedValue({ status: 'FORBIDDEN' }) };
    const { handlers } = harness({ service });
    const callback = jest.fn();
    await handlers['call:v2:snapshot']({ sessionId: 'session-123' }, callback);
    expect(service.snapshot).toHaveBeenCalledWith({ sessionId: 'session-123', actorUid: 'caller' });
    expect(callback).toHaveBeenCalledWith({ ok: false, status: 'FORBIDDEN' });
  });

  test('returns TURN configuration only after media access is authorized', async () => {
    const service = { mediaAccess: jest.fn().mockResolvedValue({ status: 'FOUND' }) };
    const getTurnCredentials = jest.fn().mockResolvedValue({
      iceServers: [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }],
      expiresInSeconds: 7200,
    });
    const { handlers } = harness({ service, getTurnCredentials });
    const callback = jest.fn();
    await handlers['call:v2:ice-config']({ sessionId: 'session-123' }, callback);
    expect(service.mediaAccess).toHaveBeenCalledWith({ sessionId: 'session-123', actorUid: 'caller' });
    expect(getTurnCredentials).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      status: 'FOUND',
      expiresInSeconds: 7200,
    }));
  });

  test('does not request TURN credentials for an unauthorized session', async () => {
    const service = { mediaAccess: jest.fn().mockResolvedValue({ status: 'FORBIDDEN' }) };
    const getTurnCredentials = jest.fn();
    const { handlers } = harness({ service, getTurnCredentials });
    const callback = jest.fn();
    await handlers['call:v2:ice-config']({ sessionId: 'session-123' }, callback);
    expect(getTurnCredentials).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ ok: false, status: 'FORBIDDEN' });
  });

  test('relays validated media only to the authorized peer', async () => {
    const service = {
      mediaRoute: jest.fn().mockResolvedValue({ status: 'FOUND', targetUid: 'callee' }),
    };
    const { handlers, emitToUser, io } = harness({ service });
    const callback = jest.fn();
    await handlers['call:v2:media']({
      sessionId: 'session-123',
      messageId: 'message-123',
      type: 'offer',
      description: 'v=0',
    }, callback);
    expect(service.mediaRoute).toHaveBeenCalledWith({
      sessionId: 'session-123', actorUid: 'caller', type: 'offer',
    });
    expect(emitToUser).toHaveBeenCalledWith(io, 'callee', 'call:v2:media', {
      protocolVersion: 2,
      sessionId: 'session-123',
      messageId: 'message-123',
      type: 'offer',
      description: 'v=0',
      senderUid: 'caller',
    });
    expect(callback).toHaveBeenCalledWith({ ok: true, status: 'RELAYED' });
  });

  test('rejects oversized or malformed media before authorization', async () => {
    const service = { mediaRoute: jest.fn() };
    const { handlers } = harness({ service });
    const callback = jest.fn();
    await handlers['call:v2:media']({
      sessionId: 'session-123',
      messageId: 'message-123',
      type: 'candidate',
      candidate: { mediaStreamId: null, mediaLineIndex: -1, value: 'candidate' },
    }, callback);
    expect(service.mediaRoute).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ ok: false, status: 'INVALID_REQUEST' });
  });

  test('does not relay media when the session rejects it', async () => {
    const service = { mediaRoute: jest.fn().mockResolvedValue({ status: 'INVALID_TRANSITION' }) };
    const { handlers, emitToUser } = harness({ service });
    const callback = jest.fn();
    await handlers['call:v2:media']({
      sessionId: 'session-123', messageId: 'message-123', type: 'answer', description: 'v=0',
    }, callback);
    expect(emitToUser).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ ok: false, status: 'INVALID_TRANSITION' });
  });
});
