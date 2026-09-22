const registerCallingV2 = require('../src/socket/calling.v2');

function harness({ service = {}, authorizeStart = async () => true } = {}) {
  const handlers = {};
  const socket = { on: jest.fn((event, handler) => { handlers[event] = handler; }) };
  const emitToUser = jest.fn();
  const io = {};
  registerCallingV2(io, socket, 'caller', { service, authorizeStart, emitToUser });
  return { handlers, emitToUser, io };
}

describe('Calling v2 socket contract', () => {
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

  test('returns only participant-authorized snapshots from the service', async () => {
    const service = { snapshot: jest.fn().mockResolvedValue({ status: 'FORBIDDEN' }) };
    const { handlers } = harness({ service });
    const callback = jest.fn();
    await handlers['call:v2:snapshot']({ sessionId: 'session-123' }, callback);
    expect(service.snapshot).toHaveBeenCalledWith({ sessionId: 'session-123', actorUid: 'caller' });
    expect(callback).toHaveBeenCalledWith({ ok: false, status: 'FORBIDDEN' });
  });
});
