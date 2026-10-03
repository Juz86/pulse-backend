const CALL_PROTOCOL_VERSION = 2;

const CALL_STATES = Object.freeze({ PREPARING: 'PREPARING', RINGING: 'RINGING', CONNECTING: 'CONNECTING', ACTIVE: 'ACTIVE', ENDED: 'ENDED' });
const CALL_COMMANDS = Object.freeze({ INVITE_READY: 'INVITE_READY', ACCEPT: 'ACCEPT', MEDIA_CONNECTED: 'MEDIA_CONNECTED', NETWORK_LOST: 'NETWORK_LOST', DECLINE: 'DECLINE', END: 'END', FAIL: 'FAIL' });
const TERMINAL_REASONS = Object.freeze(['declined', 'hangup', 'cancelled', 'missed', 'invite_timeout', 'connect_timeout', 'media_error', 'signaling_error']);
const CLIENT_FAILURE_REASONS = Object.freeze(['invite_timeout', 'connect_timeout', 'media_error', 'signaling_error']);

function isParticipant(session, uid) {
  return session.callerUid === uid || session.calleeUid === uid;
}

function createSession({ sessionId, requestId, callerUid, calleeUid, mediaType, now }) {
  return {
    protocolVersion: CALL_PROTOCOL_VERSION,
    sessionId,
    requestId,
    callerUid,
    calleeUid,
    mediaType,
    state: CALL_STATES.PREPARING,
    revision: 1,
    mediaReadyUids: [],
    iceRestartSequence: 0,
    ringingDeadlineAt: null,
    terminalReason: null,
    terminalByUid: null,
    createdAt: now,
    updatedAt: now,
  };
}

function reject(code) { return { ok: false, code }; }

function applyCommand(session, { command, actorUid, reason, now, ringingDeadlineAt }) {
  if (!isParticipant(session, actorUid)) return reject('FORBIDDEN');
  if (session.state === CALL_STATES.ENDED) return reject('ALREADY_ENDED');

  const next = {
    ...session,
    mediaReadyUids: [...(session.mediaReadyUids || [])],
    revision: session.revision + 1,
    updatedAt: now,
  };

  switch (command) {
    case CALL_COMMANDS.INVITE_READY:
      if (actorUid !== session.callerUid || session.state !== CALL_STATES.PREPARING) return reject('INVALID_TRANSITION');
      if (!Number.isFinite(Date.parse(ringingDeadlineAt))) return reject('INVALID_REQUEST');
      next.state = CALL_STATES.RINGING;
      next.ringingDeadlineAt = ringingDeadlineAt;
      break;
    case CALL_COMMANDS.ACCEPT:
      if (actorUid !== session.calleeUid || session.state !== CALL_STATES.RINGING) return reject('INVALID_TRANSITION');
      next.state = CALL_STATES.CONNECTING;
      next.ringingDeadlineAt = null;
      break;
    case CALL_COMMANDS.MEDIA_CONNECTED: {
      if (![CALL_STATES.CONNECTING, CALL_STATES.ACTIVE].includes(session.state)) return reject('INVALID_TRANSITION');
      next.mediaReadyUids = Array.from(new Set([...next.mediaReadyUids, actorUid]));
      const bothReady = [session.callerUid, session.calleeUid].every((uid) => next.mediaReadyUids.includes(uid));
      next.state = bothReady ? CALL_STATES.ACTIVE : CALL_STATES.CONNECTING;
      break;
    }
    case CALL_COMMANDS.NETWORK_LOST:
      if (![CALL_STATES.CONNECTING, CALL_STATES.ACTIVE].includes(session.state)) return reject('INVALID_TRANSITION');
      next.mediaReadyUids = next.mediaReadyUids.filter((uid) => uid !== actorUid);
      next.iceRestartSequence = (session.iceRestartSequence || 0) + 1;
      next.state = CALL_STATES.CONNECTING;
      break;
    case CALL_COMMANDS.DECLINE:
      if (actorUid !== session.calleeUid || session.state !== CALL_STATES.RINGING) return reject('INVALID_TRANSITION');
      next.state = CALL_STATES.ENDED;
      next.ringingDeadlineAt = null;
      next.terminalReason = 'declined';
      next.terminalByUid = actorUid;
      break;
    case CALL_COMMANDS.END:
      next.state = CALL_STATES.ENDED;
      next.ringingDeadlineAt = null;
      next.terminalReason = session.state === CALL_STATES.PREPARING ? 'cancelled' : 'hangup';
      next.terminalByUid = actorUid;
      break;
    case CALL_COMMANDS.FAIL:
      if (!CLIENT_FAILURE_REASONS.includes(reason)) return reject('INVALID_REASON');
      next.state = CALL_STATES.ENDED;
      next.ringingDeadlineAt = null;
      next.terminalReason = reason;
      next.terminalByUid = actorUid;
      break;
    default:
      return reject('UNKNOWN_COMMAND');
  }
  return { ok: true, session: next };
}

function expireRinging(session, { now }) {
  if (session.state !== CALL_STATES.RINGING) return reject('INVALID_TRANSITION');
  return {
    ok: true,
    session: {
      ...session,
      state: CALL_STATES.ENDED,
      revision: session.revision + 1,
      ringingDeadlineAt: null,
      terminalReason: 'missed',
      terminalByUid: null,
      updatedAt: now,
    },
  };
}

module.exports = {
  CALL_PROTOCOL_VERSION,
  CALL_STATES,
  CALL_COMMANDS,
  TERMINAL_REASONS,
  CLIENT_FAILURE_REASONS,
  isParticipant,
  createSession,
  applyCommand,
  expireRinging,
};
