const { z } = require('zod');
const { CALL_COMMANDS, TERMINAL_REASONS } = require('../calling/v2/protocol');
const { authorizeCallStart } = require('../calling/v2/authorization');
const {
  sendIncomingCallPush: defaultSendIncomingCallPush,
  sendTerminalCallPush: defaultSendTerminalCallPush,
  sendCallTakenElsewherePush: defaultSendCallTakenElsewherePush,
} = require('../push');
const { traceCall } = require('../calling/v2/diagnostics');
const { recordCallHistory: defaultRecordCallHistory } = require('../calling/v2/callHistory');

const id = z.string().trim().min(8).max(128);
const uid = z.string().trim().min(1).max(128);
const startSchema = z.object({
  requestId: id,
  calleeUid: uid,
  mediaType: z.enum(['audio', 'video']),
}).strict();
const commandSchema = z.object({
  sessionId: id,
  eventId: id,
  expectedRevision: z.number().int().positive(),
  command: z.enum(Object.values(CALL_COMMANDS)),
  reason: z.enum(TERMINAL_REASONS).optional(),
  installationId: id.optional(),
}).strict();
const snapshotSchema = z.object({ sessionId: id }).strict();
const iceConfigSchema = snapshotSchema;
const browserClientSchema = z.object({
  platform: z.literal('web'),
  capability: z.literal('audio'),
  installationId: id,
  available: z.boolean(),
}).strict();
const mediaBase = { sessionId: id, messageId: id };
const mediaSchema = z.discriminatedUnion('type', [
  z.object({
    ...mediaBase,
    type: z.literal('offer'),
    description: z.string().min(1).max(100000),
  }).strict(),
  z.object({
    ...mediaBase,
    type: z.literal('answer'),
    description: z.string().min(1).max(100000),
  }).strict(),
  z.object({
    ...mediaBase,
    type: z.literal('candidate'),
    candidate: z.object({
      mediaStreamId: z.string().max(256).nullable(),
      mediaLineIndex: z.number().int().min(0).max(64),
      value: z.string().min(1).max(4096),
    }).strict(),
  }).strict(),
]);

function defaultEmitToUser(io, targetUid, event, payload) {
  io.to(targetUid).emit(event, payload);
}

async function defaultHasBrowserCallReceiver(io, targetUid) {
  if (typeof io?.in !== 'function') return false;
  try {
    const sockets = await io.in(targetUid).fetchSockets();
    return sockets.some((candidate) => (
      candidate.data?.callPlatform === 'web'
      && candidate.data?.canReceiveAudioCalls === true
    ));
  } catch {
    return false;
  }
}

function parse(schema, payload, callback) {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  callback({ ok: false, status: 'INVALID_REQUEST' });
  return null;
}

function response(result) {
  const ok = ['CREATED', 'IDEMPOTENT', 'APPLIED', 'DUPLICATE', 'FOUND'].includes(result.status);
  return { ok, status: result.status, ...(result.session ? { session: result.session } : {}) };
}

module.exports = function registerCallingV2(io, socket, callerUid, options) {
  const service = options.service;
  const authorizeStart = options.authorizeStart || authorizeCallStart;
  const emitToUser = options.emitToUser || defaultEmitToUser;
  const getTurnCredentials = options.getTurnCredentials;
  const sendIncomingCallPush = options.sendIncomingCallPush || defaultSendIncomingCallPush;
  const sendTerminalCallPush = options.sendTerminalCallPush || defaultSendTerminalCallPush;
  const sendCallTakenElsewherePush = options.sendCallTakenElsewherePush || defaultSendCallTakenElsewherePush;
  const recordCallHistory = options.recordCallHistory || defaultRecordCallHistory;
  const hasBrowserCallReceiver = options.hasBrowserCallReceiver || defaultHasBrowserCallReceiver;
  socket.join(callerUid);

  socket.on('call:v2:client-ready', (payload, callback = () => {}) => {
    const input = parse(browserClientSchema, payload, callback);
    if (!input) return;
    socket.data = socket.data || {};
    socket.data.callPlatform = input.platform;
    socket.data.callInstallationId = input.installationId;
    socket.data.canReceiveAudioCalls = input.available;
    callback({ ok: true, status: input.available ? 'AVAILABLE' : 'UNAVAILABLE' });
  });

  socket.on('call:v2:start', async (payload, callback = () => {}) => {
    const input = parse(startSchema, payload, callback);
    if (!input) return;
    try {
      if (!(await authorizeStart(callerUid, input.calleeUid))) {
        callback({ ok: false, status: 'NOT_AVAILABLE' });
        return;
      }
      const result = await service.start({ ...input, callerUid });
      traceCall('SESSION_CREATED', {
        sessionId: result.session?.sessionId, requestId: input.requestId,
        status: result.status, state: result.session?.state,
        revision: result.session?.revision, mediaType: input.mediaType,
      });
      callback(response(result));
      if (['CREATED', 'IDEMPOTENT'].includes(result.status)) {
        emitToUser(io, callerUid, 'call:v2:updated', result.session);
        emitToUser(io, input.calleeUid, 'call:v2:updated', result.session);
      }
    } catch (error) {
      console.error('[Calling v2] Start mislukt:', error.message);
      callback({ ok: false, status: 'SERVICE_UNAVAILABLE' });
    }
  });

  socket.on('call:v2:command', async (payload, callback = () => {}) => {
    const input = parse(commandSchema, payload, callback);
    if (!input) return;
    try {
      const result = await service.command({ ...input, actorUid: callerUid });
      traceCall(input.command, {
        sessionId: input.sessionId, command: input.command, status: result.status,
        state: result.session?.state, revision: result.session?.revision,
      });
      callback(response(result));
      if (result.status === 'APPLIED') {
        emitToUser(io, result.session.callerUid, 'call:v2:updated', result.session);
        emitToUser(io, result.session.calleeUid, 'call:v2:updated', result.session);
        if (input.command === CALL_COMMANDS.INVITE_READY) {
          const [delivery, browserDeliveryAvailable] = await Promise.all([
            sendIncomingCallPush(result.session),
            hasBrowserCallReceiver(io, result.session.calleeUid),
          ]);
          traceCall('INCOMING_ROUTES_RESOLVED', {
            sessionId: result.session.sessionId,
            nativeDelivered: delivery?.delivered === true,
            browserAvailable: browserDeliveryAvailable,
          });
          if (delivery?.delivered === false && !browserDeliveryAvailable) {
            traceCall('FCM_INCOMING_DELIVERY_FAILED', {
              sessionId: result.session.sessionId,
              status: delivery.status,
              state: result.session.state,
              revision: result.session.revision,
            });
            const failed = await service.failIncomingDelivery({
              sessionId: result.session.sessionId,
              expectedRevision: result.session.revision,
            });
            if (failed.status === 'APPLIED') {
              emitToUser(io, failed.session.callerUid, 'call:v2:updated', failed.session);
              emitToUser(io, failed.session.calleeUid, 'call:v2:updated', failed.session);
              await sendTerminalCallPush(failed.session);
            }
          }
        } else if (input.command === CALL_COMMANDS.ACCEPT && result.session.acceptedInstallationId) {
          await sendCallTakenElsewherePush(result.session);
        } else if (result.session.state === 'ENDED') {
          await sendTerminalCallPush(result.session);
          if (['missed', 'declined'].includes(result.session.terminalReason)) {
            try {
              const history = await recordCallHistory(result.session);
              if (['CREATED', 'DUPLICATE'].includes(history.status)) {
                const historyPayload = {
                  conversationId: history.conversationId,
                  sessionId: result.session.sessionId,
                };
                if (history.status === 'CREATED' && history.message) {
                  io.to(history.conversationId).emit('message:received', history.message);
                }
                emitToUser(io, result.session.callerUid, 'call-history:updated', historyPayload);
                emitToUser(io, result.session.calleeUid, 'call-history:updated', historyPayload);
              }
            } catch (error) {
              console.error('[Calling v2] Oproepgeschiedenis opslaan mislukt:', error.message);
            }
          }
        }
      }
    } catch (error) {
      console.error('[Calling v2] Commando mislukt:', error.message);
      callback({ ok: false, status: 'SERVICE_UNAVAILABLE' });
    }
  });

  socket.on('call:v2:snapshot', async (payload, callback = () => {}) => {
    const input = parse(snapshotSchema, payload, callback);
    if (!input) return;
    traceCall('SNAPSHOT_REQUESTED', { sessionId: input.sessionId });
    try {
      const result = await service.snapshot({ ...input, actorUid: callerUid });
      traceCall('SNAPSHOT_RECEIVED', {
        sessionId: input.sessionId, status: result.status,
        state: result.session?.state, revision: result.session?.revision,
      });
      callback(response(result));
    } catch (error) {
      console.error('[Calling v2] Snapshot mislukt:', error.message);
      callback({ ok: false, status: 'SERVICE_UNAVAILABLE' });
    }
  });

  socket.on('call:v2:ice-config', async (payload, callback = () => {}) => {
    const input = parse(iceConfigSchema, payload, callback);
    if (!input) return;
    traceCall('ICE_CONFIG_REQUESTED', { sessionId: input.sessionId });
    try {
      const access = await service.mediaAccess({ ...input, actorUid: callerUid });
      if (access.status !== 'FOUND') {
        callback(response(access));
        return;
      }
      if (typeof getTurnCredentials !== 'function') {
        callback({ ok: false, status: 'SERVICE_UNAVAILABLE' });
        return;
      }
      const configuration = await getTurnCredentials();
      const iceServers = Array.isArray(configuration.iceServers) ? configuration.iceServers : [];
      const urls = iceServers.flatMap(server => Array.isArray(server.urls) ? server.urls : [server.urls]);
      traceCall('ICE_CONFIG_RECEIVED', {
        sessionId: input.sessionId, status: 'FOUND', iceServerCount: iceServers.length,
        hasStun: urls.some(url => typeof url === 'string' && url.startsWith('stun:')),
        hasTurn: urls.some(url => typeof url === 'string' && /^(turn|turns):/.test(url)),
      });
      callback({ ok: true, status: 'FOUND', ...configuration });
    } catch {
      console.error('[Calling v2] TURN-configuratie ophalen mislukt');
      callback({ ok: false, status: 'SERVICE_UNAVAILABLE' });
    }
  });

  socket.on('call:v2:media', async (payload, callback = () => {}) => {
    const input = parse(mediaSchema, payload, callback);
    if (!input) return;
    try {
      const route = await service.mediaRoute({
        sessionId: input.sessionId,
        actorUid: callerUid,
        type: input.type,
      });
      if (route.status !== 'FOUND') {
        callback(response(route));
        return;
      }
      const envelope = {
        protocolVersion: 2,
        ...input,
        senderUid: callerUid,
      };
      emitToUser(io, route.targetUid, 'call:v2:media', envelope);
      traceCall(`${input.type.toUpperCase()}_SENT`, {
        sessionId: input.sessionId, status: 'RELAYED', messageType: input.type,
      });
      callback({ ok: true, status: 'RELAYED' });
    } catch {
      console.error('[Calling v2] Mediabericht doorsturen mislukt');
      callback({ ok: false, status: 'SERVICE_UNAVAILABLE' });
    }
  });
};

module.exports.schemas = {
  startSchema, commandSchema, snapshotSchema, iceConfigSchema, mediaSchema, browserClientSchema,
};
module.exports.defaultHasBrowserCallReceiver = defaultHasBrowserCallReceiver;
