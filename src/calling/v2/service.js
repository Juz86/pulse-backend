const { randomUUID } = require('crypto');
const {
  CALL_STATES,
  CALL_COMMANDS,
  createSession,
  applyCommand,
  expireConnecting,
  expireRinging,
  failInviteDelivery,
  isParticipant,
} = require('./protocol');

class CallV2Service {
  constructor(store, {
    createId = randomUUID,
    now = () => new Date().toISOString(),
    ringingTimeoutMs = 45_000,
    connectingTimeoutMs = 30_000,
  } = {}) {
    this.store = store;
    this.createId = createId;
    this.now = now;
    this.ringingTimeoutMs = ringingTimeoutMs;
    this.connectingTimeoutMs = connectingTimeoutMs;
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

  async command({ sessionId, eventId, expectedRevision, command, actorUid, reason, installationId }) {
    const snapshot = await this.snapshot({ sessionId, actorUid });
    if (snapshot.status !== 'FOUND') return snapshot;
    const priorEvent = await this.store.hasEvent(sessionId, eventId);
    if (priorEvent.status === 'UNAVAILABLE') return { status: 'SERVICE_UNAVAILABLE' };
    if (priorEvent.status === 'FOUND') return { status: 'DUPLICATE', session: snapshot.session };
    if (snapshot.session.revision !== expectedRevision) return { status: 'CONFLICT', session: snapshot.session };
    const transitionTime = this.now();
    const transition = applyCommand(snapshot.session, {
      command,
      actorUid,
      installationId,
      reason,
      now: transitionTime,
      ringingDeadlineAt: command === CALL_COMMANDS.INVITE_READY
        ? new Date(Date.parse(transitionTime) + this.ringingTimeoutMs).toISOString()
        : undefined,
      connectingDeadlineAt: [CALL_COMMANDS.ACCEPT, CALL_COMMANDS.NETWORK_LOST].includes(command)
        ? new Date(Date.parse(transitionTime) + this.connectingTimeoutMs).toISOString()
        : undefined,
    });
    if (!transition.ok) return { status: transition.code, session: snapshot.session };
    const result = await this.store.commit({ currentRevision: expectedRevision, nextSession: transition.session, eventId });
    if (['APPLIED', 'DUPLICATE', 'CONFLICT'].includes(result.status)) return result;
    if (result.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
    return { status: 'SERVICE_UNAVAILABLE' };
  }

  async expireDueRinging({ nowMs = Date.now(), limit = 100 } = {}) {
    const due = await this.store.listDueRinging(nowMs, limit);
    if (due.status !== 'FOUND') return { status: 'SERVICE_UNAVAILABLE', sessions: [] };

    const sessions = [];
    for (const sessionId of due.sessionIds) {
      const current = await this.store.get(sessionId);
      if (current.status !== 'FOUND') {
        if (current.status === 'NOT_FOUND') await this.store.removeRingingDeadline(sessionId);
        continue;
      }
      const deadlineMs = Date.parse(current.session.ringingDeadlineAt);
      if (current.session.state !== CALL_STATES.RINGING || !Number.isFinite(deadlineMs)) {
        await this.store.removeRingingDeadline(sessionId);
        continue;
      }
      if (deadlineMs > nowMs) continue;

      const transition = expireRinging(current.session, { now: new Date(nowMs).toISOString() });
      const result = await this.store.commit({
        currentRevision: current.session.revision,
        nextSession: transition.session,
        eventId: `server:ringing-timeout:${current.session.revision}`,
      });
      if (result.status === 'APPLIED') sessions.push(result.session);
    }
    return { status: 'APPLIED', sessions };
  }

  async expireDueConnecting({ nowMs = Date.now(), limit = 100 } = {}) {
    const due = await this.store.listDueConnecting(nowMs, limit);
    if (due.status !== 'FOUND') return { status: 'SERVICE_UNAVAILABLE', sessions: [] };

    const sessions = [];
    for (const sessionId of due.sessionIds) {
      const current = await this.store.get(sessionId);
      if (current.status !== 'FOUND') {
        if (current.status === 'NOT_FOUND') await this.store.removeConnectingDeadline(sessionId);
        continue;
      }
      const deadlineMs = Date.parse(current.session.connectingDeadlineAt);
      if (current.session.state !== CALL_STATES.CONNECTING || !Number.isFinite(deadlineMs)) {
        await this.store.removeConnectingDeadline(sessionId);
        continue;
      }
      if (deadlineMs > nowMs) continue;

      const transition = expireConnecting(current.session, { now: new Date(nowMs).toISOString() });
      const result = await this.store.commit({
        currentRevision: current.session.revision,
        nextSession: transition.session,
        eventId: `server:connecting-timeout:${current.session.revision}`,
      });
      if (result.status === 'APPLIED') sessions.push(result.session);
    }
    return { status: 'APPLIED', sessions };
  }

  async failIncomingDelivery({ sessionId, expectedRevision }) {
    const current = await this.store.get(sessionId);
    if (current.status === 'UNAVAILABLE') return { status: 'SERVICE_UNAVAILABLE' };
    if (current.status !== 'FOUND') return { status: 'NOT_FOUND' };
    if (current.session.revision !== expectedRevision) {
      return { status: 'CONFLICT', session: current.session };
    }
    const transition = failInviteDelivery(current.session, { now: this.now() });
    if (!transition.ok) return { status: transition.code, session: current.session };
    const result = await this.store.commit({
      currentRevision: expectedRevision,
      nextSession: transition.session,
      eventId: `server:incoming-delivery-failed:${expectedRevision}`,
    });
    if (['APPLIED', 'DUPLICATE', 'CONFLICT'].includes(result.status)) return result;
    if (result.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
    return { status: 'SERVICE_UNAVAILABLE' };
  }
}

module.exports = { CallV2Service };
