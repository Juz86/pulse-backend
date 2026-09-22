const { z } = require('zod');
const { onlineUsers } = require('../state');
const { CALL_COMMANDS, TERMINAL_REASONS } = require('../calling/v2/protocol');
const { authorizeCallStart } = require('../calling/v2/authorization');

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

function defaultEmitToUser(io, targetUid, event, payload) {
  const sockets = onlineUsers[targetUid];
  if (!sockets) return;
  sockets.forEach((socketId) => io.to(socketId).emit(event, payload));
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
};

module.exports.schemas = { startSchema, commandSchema, snapshotSchema };
