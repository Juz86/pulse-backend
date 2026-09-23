const { CallV2Service } = require('../src/calling/v2/service');

class MemoryStore {
  constructor() {
    this.sessions = new Map();
    this.requests = new Map();
    this.leases = new Map();
    this.events = new Set();
  }

  async create(session) {
    const requestKey = `${session.callerUid}:${session.requestId}`;
    const existingId = this.requests.get(requestKey);
    if (existingId) return { status: 'IDEMPOTENT', session: this.sessions.get(existingId) };
    if (this.leases.has(session.callerUid) || this.leases.has(session.calleeUid)) return { status: 'BUSY' };
    this.sessions.set(session.sessionId, session);
    this.requests.set(requestKey, session.sessionId);
    this.leases.set(session.callerUid, session.sessionId);
    this.leases.set(session.calleeUid, session.sessionId);
    return { status: 'CREATED', session };
  }

  async get(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? { status: 'FOUND', session } : { status: 'NOT_FOUND' };
  }

  async hasEvent(sessionId, eventId) {
    return { status: this.events.has(`${sessionId}:${eventId}`) ? 'FOUND' : 'NOT_FOUND' };
  }

  async commit({ currentRevision, nextSession, eventId }) {
    const eventKey = `${nextSession.sessionId}:${eventId}`;
    const current = this.sessions.get(nextSession.sessionId);
    if (!current) return { status: 'NOT_FOUND' };
    if (this.events.has(eventKey)) return { status: 'DUPLICATE', session: current };
    if (current.revision !== currentRevision) return { status: 'CONFLICT', session: current };
    this.sessions.set(nextSession.sessionId, nextSession);
    this.events.add(eventKey);
    if (nextSession.state === 'ENDED') {
      this.leases.delete(nextSession.callerUid);
      this.leases.delete(nextSession.calleeUid);
    }
    return { status: 'APPLIED', session: nextSession };
  }
}

function makeService(store = new MemoryStore()) {
  let sequence = 0;
  return {
    store,
    service: new CallV2Service(store, {
      createId: () => `session-${++sequence}`,
      now: () => '2026-01-01T00:00:00.000Z',
    }),
  };
}

describe('Calling v2 service', () => {
  test('deduplicates a retried start request', async () => {
    const { service } = makeService();
    const input = { requestId: 'request-123', callerUid: 'a', calleeUid: 'b', mediaType: 'audio' };
    const first = await service.start(input);
    const retry = await service.start(input);
    expect(first.status).toBe('CREATED');
    expect(retry.status).toBe('IDEMPOTENT');
    expect(retry.session.sessionId).toBe(first.session.sessionId);
  });

  test('leases both participants so concurrent calls are rejected', async () => {
    const { service } = makeService();
    await service.start({ requestId: 'request-123', callerUid: 'a', calleeUid: 'b', mediaType: 'audio' });
    await expect(service.start({ requestId: 'request-456', callerUid: 'c', calleeUid: 'b', mediaType: 'video' }))
      .resolves.toEqual({ status: 'BUSY' });
  });

  test('prevents non-participants from reading a session', async () => {
    const { service } = makeService();
    const started = await service.start({ requestId: 'request-123', callerUid: 'a', calleeUid: 'b', mediaType: 'audio' });
    await expect(service.snapshot({ sessionId: started.session.sessionId, actorUid: 'outsider' }))
      .resolves.toEqual({ status: 'FORBIDDEN' });
  });

  test('returns authoritative state for stale revisions', async () => {
    const { service } = makeService();
    const started = await service.start({ requestId: 'request-123', callerUid: 'a', calleeUid: 'b', mediaType: 'audio' });
    const result = await service.command({
      sessionId: started.session.sessionId,
      eventId: 'event-123',
      expectedRevision: 99,
      command: 'INVITE_READY',
      actorUid: 'a',
    });
    expect(result.status).toBe('CONFLICT');
    expect(result.session.revision).toBe(1);
  });

  test('deduplicates a retried command event', async () => {
    const { service } = makeService();
    const started = await service.start({ requestId: 'request-123', callerUid: 'a', calleeUid: 'b', mediaType: 'audio' });
    const command = {
      sessionId: started.session.sessionId,
      eventId: 'event-123',
      expectedRevision: 1,
      command: 'INVITE_READY',
      actorUid: 'a',
    };
    expect((await service.command(command)).status).toBe('APPLIED');
    expect((await service.command(command)).status).toBe('DUPLICATE');
  });

  test('allows media only after acceptance and returns the other participant', async () => {
    const { service, store } = makeService();
    const started = await service.start({
      requestId: 'request-123',
      callerUid: 'a',
      calleeUid: 'b',
      mediaType: 'audio',
    });
    await expect(service.mediaAccess({ sessionId: started.session.sessionId, actorUid: 'a' }))
      .resolves.toMatchObject({ status: 'INVALID_TRANSITION' });

    store.sessions.set(started.session.sessionId, { ...started.session, state: 'CONNECTING' });
    await expect(service.mediaAccess({ sessionId: started.session.sessionId, actorUid: 'a' }))
      .resolves.toMatchObject({ status: 'FOUND', targetUid: 'b' });
    await expect(service.mediaAccess({ sessionId: started.session.sessionId, actorUid: 'b' }))
      .resolves.toMatchObject({ status: 'FOUND', targetUid: 'a' });
  });

  test('enforces offer and answer roles while allowing candidates from both peers', async () => {
    const { service, store } = makeService();
    const started = await service.start({
      requestId: 'request-123',
      callerUid: 'a',
      calleeUid: 'b',
      mediaType: 'audio',
    });
    store.sessions.set(started.session.sessionId, { ...started.session, state: 'CONNECTING' });

    await expect(service.mediaRoute({ sessionId: started.session.sessionId, actorUid: 'b', type: 'offer' }))
      .resolves.toEqual({ status: 'FORBIDDEN' });
    await expect(service.mediaRoute({ sessionId: started.session.sessionId, actorUid: 'a', type: 'answer' }))
      .resolves.toEqual({ status: 'FORBIDDEN' });
    await expect(service.mediaRoute({ sessionId: started.session.sessionId, actorUid: 'a', type: 'candidate' }))
      .resolves.toMatchObject({ status: 'FOUND', targetUid: 'b' });
    await expect(service.mediaRoute({ sessionId: started.session.sessionId, actorUid: 'b', type: 'candidate' }))
      .resolves.toMatchObject({ status: 'FOUND', targetUid: 'a' });
  });

  test('does not authorize media for a non-participant', async () => {
    const { service } = makeService();
    const started = await service.start({ requestId: 'request-123', callerUid: 'a', calleeUid: 'b', mediaType: 'audio' });
    await expect(service.mediaAccess({ sessionId: started.session.sessionId, actorUid: 'outsider' }))
      .resolves.toEqual({ status: 'FORBIDDEN' });
  });

  test('fails closed when Redis is unavailable', async () => {
    const store = { create: async () => ({ status: 'UNAVAILABLE' }) };
    const { service } = makeService(store);
    await expect(service.start({ requestId: 'request-123', callerUid: 'a', calleeUid: 'b', mediaType: 'audio' }))
      .resolves.toEqual({ status: 'SERVICE_UNAVAILABLE' });
  });
});
