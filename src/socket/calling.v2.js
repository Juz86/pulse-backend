const { z } = require('zod');
const { CALL_COMMANDS, TERMINAL_REASONS } = require('../calling/v2/protocol');
const { authorizeCallStart } = require('../calling/v2/authorization');
const { sendIncomingCallPush: defaultSendIncomingCallPush } = require('../push');

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
}).strict();
const snapshotSchema = z.object({ sessionId: id }).strict();
const iceConfigSchema = snapshotSchema;
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
  socket.join(callerUid);

  socket.on('call:v2:start', async (payload, callback = () => {}) => {
    const input = parse(startSchema, payload, callback);
    if (!input) return;
    try {
      if (!(await authorizeStart(callerUid, input.calleeUid))) {
        callback({ ok: false, status: 'NOT_AVAILABLE' });
        return;
      }
      const result = await service.start({ ...input, callerUid });
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
      callback(response(result));
      if (result.status === 'APPLIED') {
        emitToUser(io, result.session.callerUid, 'call:v2:updated', result.session);
        emitToUser(io, result.session.calleeUid, 'call:v2:updated', result.session);
        if (input.command === CALL_COMMANDS.INVITE_READY) {
          await sendIncomingCallPush(result.session);
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
    try {
      callback(response(await service.snapshot({ ...input, actorUid: callerUid })));
    } catch (error) {
      console.error('[Calling v2] Snapshot mislukt:', error.message);
      callback({ ok: false, status: 'SERVICE_UNAVAILABLE' });
    }
  });

  socket.on('call:v2:ice-config', async (payload, callback = () => {}) => {
    const input = parse(iceConfigSchema, payload, callback);
    if (!input) return;
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
      callback({ ok: true, status: 'RELAYED' });
    } catch {
      console.error('[Calling v2] Mediabericht doorsturen mislukt');
      callback({ ok: false, status: 'SERVICE_UNAVAILABLE' });
    }
  });
};

module.exports.schemas = { startSchema, commandSchema, snapshotSchema, iceConfigSchema, mediaSchema };
