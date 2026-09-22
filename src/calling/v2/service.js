const { randomUUID } = require('crypto');
const { createSession, applyCommand, isParticipant } = require('./protocol');

class CallV2Service {
  constructor(store, { createId = randomUUID, now = () => new Date().toISOString() } = {}) {
    this.store = store;
    this.createId = createId;
    this.now = now;
  }

  async start({ requestId, callerUid, calleeUid, mediaType }) {
    if (!requestId || !callerUid || !calleeUid || callerUid === calleeUid) return { status: 'INVALID_REQUEST' };
    const session = createSession({ sessionId: this.createId(), requestId, callerUid, calleeUid, mediaType, now: this.now() });
    const result = await this.store.create(session);
    if (['CREATED', 'IDEMPOTENT'].includes(result.status)) return result;
    if (result.status === 'BUSY') return { status: 'BUSY' };
    return { status: result.status === 'CONFLICT' ? 'CONFLICT' : 'SERVICE_UNAVAILABLE' };
  }

  async snapshot({ sessionId, actorUid }) {
    const result = await this.store.get(sessionId);
    if (result.status === 'UNAVAILABLE') return { status: 'SERVICE_UNAVAILABLE' };
    if (result.status !== 'FOUND') return { status: 'NOT_FOUND' };
    if (!isParticipant(result.session, actorUid)) return { status: 'FORBIDDEN' };
    return { status: 'FOUND', session: result.session };
  }

  async command({ sessionId, eventId, expectedRevision, command, actorUid, reason }) {
    const snapshot = await this.snapshot({ sessionId, actorUid });
    if (snapshot.status !== 'FOUND') return snapshot;
    const priorEvent = await this.store.hasEvent(sessionId, eventId);
    if (priorEvent.status === 'UNAVAILABLE') return { status: 'SERVICE_UNAVAILABLE' };
    if (priorEvent.status === 'FOUND') return { status: 'DUPLICATE', session: snapshot.session };
    if (snapshot.session.revision !== expectedRevision) return { status: 'CONFLICT', session: snapshot.session };
    const transition = applyCommand(snapshot.session, { command, actorUid, reason, now: this.now() });
    if (!transition.ok) return { status: transition.code, session: snapshot.session };
    const result = await this.store.commit({ currentRevision: expectedRevision, nextSession: transition.session, eventId });
    if (['APPLIED', 'DUPLICATE', 'CONFLICT'].includes(result.status)) return result;
    if (result.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
    return { status: 'SERVICE_UNAVAILABLE' };
  }
}

module.exports = { CallV2Service };
