const { db, admin } = require('../../firebase');
const { verifyAuth } = require('../../middleware');
const { onlineUsers } = require('../../state');
const { PROTOCOL, PROTOCOL_VERSION, schemas } = require('./contracts');
const { E2EEV2Error, createDeviceLifecycleService } = require('./deviceLifecycle');
const { deviceRoomName } = require('./deviceAudience');
const { createMessageDeliveryService } = require('./messageDelivery');

function isE2EEV2Enabled() {
  return String(process.env.E2EE_V2_ENABLED || '').toLowerCase() === 'true';
}

function isE2EEV2PlatformEnabled(platform) {
  if (platform === 'android') return true;
  return platform === 'web'
    && String(process.env.E2EE_V2_WEB_PROVIDER_ENABLED || '').toLowerCase() === 'true';
}

function parseBody(schema, body, res) {
  const result = schema.safeParse(body || {});
  if (result.success) return result.data;
  res.status(400).json({
    error: 'v2_contract_invalid',
    issues: result.error.issues.map((issue) => ({
      code: ['duplicate_prekey_id', 'duplicate_recipient'].includes(issue.message)
        ? issue.message
        : issue.code,
      path: issue.path.join('.'),
    })),
  });
  return null;
}

function sendError(res, error, label) {
  if (error instanceof E2EEV2Error) {
    return res.status(error.status).json({ error: error.code });
  }
  console.error(label, error);
  return res.status(500).json({ error: 'v2_request_failed' });
}

function emitToUser(io, userId, eventName, payload) {
  const sockets = onlineUsers[userId];
  if (!sockets) return;
  sockets.forEach((socketId) => io.to(socketId).emit(eventName, payload));
}

async function broadcastSecurityEvent(io, event) {
  if (!event) return;
  const payload = {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    userId: event.userId,
    deviceId: event.deviceId,
    signalDeviceId: event.signalDeviceId,
    identityVersion: event.identityVersion,
    type: event.type,
    createdAt: event.createdAt,
  };
  emitToUser(io, event.userId, 'e2ee:device-security', payload);

  const conversations = await db.collection('conversations')
    .where('members', 'array-contains', event.userId)
    .get();
  conversations.docs.forEach((conversation) => {
    const eventName = event.type === 'identity_changed'
      ? 'e2ee:identity-changed'
      : 'e2ee:device-security';
    io.to(conversation.id).emit(eventName, payload);
  });
}

function scheduleSecurityEvent(io, event) {
  broadcastSecurityEvent(io, event).catch((error) => {
    console.warn('v2 security event broadcast mislukt:', error.message);
  });
}

function registerE2EEV2Routes(router, io) {
  const service = createDeviceLifecycleService({ database: db, firebaseAdmin: admin });
  const messageService = createMessageDeliveryService({ database: db, firebaseAdmin: admin });

  router.use('/v2', (_req, res, next) => {
    if (!isE2EEV2Enabled()) {
      return res.status(503).json({ error: 'v2_not_enabled' });
    }
    return next();
  });

  router.get('/v2/devices', verifyAuth, async (req, res) => {
    try {
      const snapshot = await db.collection('users').doc(req.uid).collection('devices').get();
      const devices = snapshot.docs
        .map((doc) => ({ deviceId: doc.id, ...doc.data() }))
        .filter((device) => device.protocol === PROTOCOL)
        .map((device) => ({
          deviceId: device.deviceId,
          signalDeviceId: device.signalDeviceId,
          deviceLabel: device.deviceLabel,
          platform: device.platform,
          capabilities: device.capabilities,
          identityVersion: Number(device.identityVersion || 1),
          oneTimePreKeyCount: Number(device.oneTimePreKeyCount || 0),
          protocol: device.protocol,
          protocolVersion: device.protocolVersion,
          status: device.status,
          createdAt: device.createdAt,
          updatedAt: device.updatedAt,
          revokedAt: device.revokedAt || null,
        }));
      res.json({ ok: true, devices });
    } catch (error) {
      sendError(res, error, 'v2 devices lijst fout:');
    }
  });

  router.post('/v2/devices/register', verifyAuth, async (req, res) => {
    const registration = parseBody(schemas.deviceRegistration, req.body, res);
    if (!registration) return;
    if (!isE2EEV2PlatformEnabled(registration.platform)) {
      return res.status(409).json({ error: 'v2_platform_not_enabled' });
    }
    try {
      const result = await service.registerDevice(req.uid, registration);
      res.status(result.status === 'REGISTERED' ? 201 : 200).json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error, 'v2 device register fout:');
    }
  });

  router.put('/v2/devices/:deviceId/keys', verifyAuth, async (req, res) => {
    const rotation = parseBody(schemas.keyRotation, req.body, res);
    if (!rotation) return;
    try {
      const result = await service.rotateDeviceKeys(req.uid, req.params.deviceId, rotation);
      scheduleSecurityEvent(io, result.event);
      res.json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error, 'v2 key rotation fout:');
    }
  });

  router.post('/v2/devices/:deviceId/prekeys', verifyAuth, async (req, res) => {
    const refill = parseBody(schemas.preKeyRefill, req.body, res);
    if (!refill) return;
    try {
      const result = await service.refillPreKeys(
        req.uid,
        req.params.deviceId,
        refill.oneTimePreKeys,
      );
      res.json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error, 'v2 prekey refill fout:');
    }
  });

  router.post('/v2/devices/:deviceId/revoke', verifyAuth, async (req, res) => {
    const action = parseBody(schemas.lifecycleAction, req.body, res);
    if (!action) return;
    try {
      const result = await service.revokeDevice(req.uid, req.params.deviceId);
      scheduleSecurityEvent(io, result.event);
      res.json({ ok: true, ...result });
    } catch (error) {
      sendError(res, error, 'v2 device revoke fout:');
    }
  });

  router.post(
    '/v2/conversations/:conversationId/users/:recipientUserId/key-bundles/claim',
    verifyAuth,
    async (req, res) => {
      const claimRequest = parseBody(schemas.keyBundleClaim, req.body, res);
      if (!claimRequest) return;
      try {
        const claim = await service.claimKeyBundles({
          requesterId: req.uid,
          requesterDeviceId: claimRequest.requesterDeviceId,
          claimId: claimRequest.claimId,
          conversationId: req.params.conversationId,
          recipientId: req.params.recipientUserId,
        });
        res.json(claim);
      } catch (error) {
        sendError(res, error, 'v2 key-bundle claim fout:');
      }
    },
  );

  router.post(
    '/v2/conversations/:conversationId/own-device-key-bundles/claim',
    verifyAuth,
    async (req, res) => {
      const claimRequest = parseBody(schemas.keyBundleClaim, req.body, res);
      if (!claimRequest) return;
      try {
        const claim = await service.claimKeyBundles({
          requesterId: req.uid,
          requesterDeviceId: claimRequest.requesterDeviceId,
          claimId: claimRequest.claimId,
          conversationId: req.params.conversationId,
          recipientId: req.uid,
          allowOwnDevices: true,
        });
        res.json(claim);
      } catch (error) {
        sendError(res, error, 'v2 own-device key-bundle claim fout:');
      }
    },
  );

  router.post('/v2/messages/send', verifyAuth, async (req, res) => {
    const message = parseBody(schemas.messageSend, req.body, res);
    if (!message) return;
    try {
      const result = await messageService.sendMessage(req.uid, message);
      if (!result.idempotent) {
        result.deliveries.forEach(({ recipientUserId, recipientDeviceId }) => {
          io.to(deviceRoomName(recipientUserId, recipientDeviceId)).emit(
            'e2ee:v2:message-available',
            {
              protocol: PROTOCOL,
              protocolVersion: PROTOCOL_VERSION,
              conversationId: message.conversationId,
              messageId: result.messageId,
            },
          );
        });
      }
      res.status(result.idempotent ? 200 : 201).json({
        ok: true,
        messageId: result.messageId,
        clientMessageId: result.clientMessageId,
        idempotent: result.idempotent,
        acceptedAt: result.acceptedAt || null,
      });
    } catch (error) {
      sendError(res, error, 'v2 message send fout:');
    }
  });

  router.get(
    '/v2/conversations/:conversationId/messages',
    verifyAuth,
    async (req, res) => {
      const deviceId = String(req.query.deviceId || '');
      const limit = Number(req.query.limit || 50);
      const offset = Number(req.query.offset || 0);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) {
        return res.status(400).json({ error: 'v2_device_id_invalid' });
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ error: 'v2_limit_invalid' });
      }
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000) {
        return res.status(400).json({ error: 'v2_offset_invalid' });
      }
      try {
        const messages = await messageService.listMessageFeed({
          userId: req.uid,
          deviceId,
          conversationId: req.params.conversationId,
          limit,
          offset,
        });
        res.json({ messages });
      } catch (error) {
        sendError(res, error, 'v2 berichtenfeed ophalen fout:');
      }
    },
  );

  router.post(
    '/v2/conversations/:conversationId/messages/:messageId/ack',
    verifyAuth,
    async (req, res) => {
      const deviceId = String(req.body?.deviceId || '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) {
        return res.status(400).json({ error: 'v2_device_id_invalid' });
      }
      try {
        const result = await messageService.acknowledgeMessage({
          userId: req.uid,
          deviceId,
          conversationId: req.params.conversationId,
          messageId: req.params.messageId,
        });
        res.json({ ok: true, ...result });
      } catch (error) {
        sendError(res, error, 'v2 berichtbevestiging fout:');
      }
    },
  );

  router.get(
    '/v2/conversations/:conversationId/messages/:messageId/envelope',
    verifyAuth,
    async (req, res) => {
      const deviceId = String(req.query.deviceId || '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) {
        return res.status(400).json({ error: 'v2_device_id_invalid' });
      }
      try {
        const envelope = await messageService.getEnvelope({
          userId: req.uid,
          deviceId,
          conversationId: req.params.conversationId,
          messageId: req.params.messageId,
        });
        res.json(envelope);
      } catch (error) {
        sendError(res, error, 'v2 envelope ophalen fout:');
      }
    },
  );

  return router;
}

module.exports = {
  PROTOCOL,
  PROTOCOL_VERSION,
  broadcastSecurityEvent,
  isE2EEV2Enabled,
  isE2EEV2PlatformEnabled,
  registerE2EEV2Routes,
};
