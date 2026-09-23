const { randomUUID } = require('crypto');
const { CALL_STATES, createSession, applyCommand, isParticipant } = require('./protocol');

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

  async mediaAccess({ sessionId, actorUid }) {
    const snapshot = await this.snapshot({ sessionId, actorUid });
    if (snapshot.status !== 'FOUND') return snapshot;
    if (![CALL_STATES.CONNECTING, CALL_STATES.ACTIVE].includes(snapshot.session.state)) {
      return { status: 'INVALID_TRANSITION', session: snapshot.session };
    }
    return {
      status: 'FOUND',
      session: snapshot.session,
      targetUid: snapshot.session.callerUid === actorUid
        ? snapshot.session.calleeUid
        : snapshot.session.callerUid,
    };
  }

  async mediaRoute({ sessionId, actorUid, type }) {
    const access = await this.mediaAccess({ sessionId, actorUid });
    if (access.status !== 'FOUND') return access;
    if (type === 'offer' && actorUid !== access.session.callerUid) return { status: 'FORBIDDEN' };
    if (type === 'answer' && actorUid !== access.session.calleeUid) return { status: 'FORBIDDEN' };
    return access;
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
