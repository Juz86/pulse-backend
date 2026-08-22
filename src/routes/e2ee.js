const { randomUUID } = require('crypto');
const { admin, db } = require('../firebase');
const { verifyAuth } = require('../middleware');
const { onlineUsers } = require('../state');

function isServiceReady() {
  return String(process.env.FIREBASE_ENABLED || '').toLowerCase() === 'true';
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Number.isFinite(value?._seconds)) return new Date(value._seconds * 1000).toISOString();
  return value;
}

function buildEncryptedPreview({ messageType = 'text', sharedContact = null } = {}) {
  if (messageType === 'contact') {
    return `Contactpersoon: ${sharedContact?.name || 'Contactpersoon'}`;
  }
  if (messageType === 'attachment') {
    return 'Bijlage';
  }
  return 'Versleuteld bericht';
}

function getAttachmentIdentifierCandidates(attachment = {}) {
  const candidates = [];
  const values = [
    attachment.downloadUrl,
    attachment.url,
    attachment.thumbnailUrl,
    attachment.storageKey,
  ].filter(Boolean);

  values.forEach((value) => {
    try {
      const parsed = new URL(value);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length > 0) candidates.push(parts[parts.length - 1]);
    } catch {
      const parts = String(value).split('/').filter(Boolean);
      if (parts.length > 0) candidates.push(parts[parts.length - 1]);
    }
  });

  return Array.from(new Set(candidates.filter(Boolean)));
}

async function findAttachmentForUser(userId, attachmentId) {
  const convsSnap = await db.collection('conversations')
    .where('members', 'array-contains', userId)
    .get();

  for (const convDoc of convsSnap.docs) {
    const messagesSnap = await convDoc.ref.collection('messages').get();
    for (const msgDoc of messagesSnap.docs) {
      const message = msgDoc.data() || {};
      const attachment = message.attachment || null;
      if (!attachment || typeof attachment !== 'object') continue;
      const candidates = getAttachmentIdentifierCandidates(attachment);
      if (candidates.includes(attachmentId)) {
        return {
          convId: convDoc.id,
          messageId: msgDoc.id,
          attachment,
        };
      }
    }
  }

  return null;
}

function resolveRecipientMessageView(message, viewerUid, viewerDeviceId = '') {
  const recipientPayloads = Array.isArray(message.recipientPayloads) ? message.recipientPayloads : [];
  const matchingPayload = recipientPayloads.find((payload) => (
    payload?.recipientUserId === viewerUid
      && (!viewerDeviceId || payload?.recipientDeviceId === viewerDeviceId)
  )) || recipientPayloads.find((payload) => payload?.recipientUserId === viewerUid) || null;

  return {
    id: message.id,
    convId: message.convId || message.conversationId,
    conversationId: message.conversationId || message.convId,
    senderId: message.senderId || message.senderUserId,
    senderUserId: message.senderUserId || message.senderId,
    senderDeviceId: message.senderDeviceId || null,
    ciphertext: message.ciphertext || '',
    encryptedMessageKey: matchingPayload?.encryptedMessageKey || null,
    messageType: message.messageType || 'text',
    type: message.messageType || 'text',
    sharedContact: message.sharedContact || null,
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
    replyToMessageId: message.replyToMessageId || null,
    protocol: message.protocol || 'signal_v1',
    protocolVersion: Number(message.protocolVersion || 1),
    createdAt: normalizeTimestamp(message.createdAt) || new Date().toISOString(),
    text: buildEncryptedPreview({
      messageType: message.messageType || 'text',
      sharedContact: message.sharedContact || null,
    }),
    deliveryState: 'sent',
  };
}

function buildRealtimeServicePayload(message) {
  return {
    id: message.id,
    convId: message.convId || message.conversationId,
    conversationId: message.conversationId || message.convId,
    senderId: message.senderId || message.senderUserId,
    senderUserId: message.senderUserId || message.senderId,
    senderDeviceId: message.senderDeviceId || null,
    ciphertext: message.ciphertext || '',
    encryptedMessageKey: null,
    messageType: message.messageType || 'text',
    type: message.messageType || 'text',
    sharedContact: message.sharedContact || null,
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
    replyToMessageId: message.replyToMessageId || null,
    protocol: message.protocol || 'signal_v1',
    protocolVersion: Number(message.protocolVersion || 1),
    createdAt: normalizeTimestamp(message.createdAt) || new Date().toISOString(),
    text: buildEncryptedPreview({
      messageType: message.messageType || 'text',
      sharedContact: message.sharedContact || null,
    }),
    deliveryState: 'sent',
  };
}

module.exports = (io) => {
  const router = require('express').Router();

  router.get('/readyz', (_req, res) => {
    const ready = isServiceReady();
    res.json({
      ok: ready,
      service: 'pulse-e2ee',
      transport: 'service',
      capabilities: {
        devices: ready,
        keyBundles: ready,
        encryptedMessages: ready,
        receipts: ready,
      },
    });
  });

  router.get('/devices', verifyAuth, async (req, res) => {
    try {
      const snap = await db.collection('users').doc(req.uid).collection('devices').get();
      const devices = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json({ ok: true, devices });
    } catch (err) {
      console.error('devices lijst fout:', err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  router.post('/devices/register', verifyAuth, async (req, res) => {
    try {
      const {
        deviceLabel = 'Onbekend apparaat',
        identityPublicKey,
        signedPreKey,
        oneTimePreKeys = [],
        platform = 'web',
        protocol = 'signal_v1',
        protocolVersion = 1,
      } = req.body || {};

      if (!identityPublicKey || !signedPreKey?.publicKey || !signedPreKey?.signature) {
        return res.status(400).json({ error: 'device_registration_invalid' });
      }

      const deviceId = `dev_${randomUUID()}`;
      await db.collection('users').doc(req.uid).collection('devices').doc(deviceId).set({
        deviceLabel,
        identityPublicKey,
        signedPreKey,
        oneTimePreKeys: Array.isArray(oneTimePreKeys) ? oneTimePreKeys : [],
        platform,
        protocol,
        protocolVersion,
        status: 'active',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ ok: true, deviceId });
    } catch (err) {
      console.error('device register fout:', err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  router.get('/users/:remoteUserId/key-bundle', verifyAuth, async (req, res) => {
    try {
      const { remoteUserId } = req.params;
      const snap = await db.collection('users').doc(remoteUserId).collection('devices').get();
      const devices = snap.docs
        .map((doc) => ({ deviceId: doc.id, ...doc.data() }))
        .filter((device) => device.status === 'active')
        .map((device) => ({
          deviceId: device.deviceId,
          identityPublicKey: device.identityPublicKey,
          signedPreKey: device.signedPreKey,
          oneTimePreKey: Array.isArray(device.oneTimePreKeys) ? (device.oneTimePreKeys[0] || null) : null,
        }));

      res.json({ ok: true, userId: remoteUserId, devices });
    } catch (err) {
      console.error('key bundle fout:', err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  router.get('/messages/feed/:convId', verifyAuth, async (req, res) => {
    try {
      const { convId } = req.params;
      const uid = req.uid;
      const limit = parseInt(req.query.limit, 10) || 50;
      const viewerDeviceId = String(req.query.deviceId || '');

      const convDoc = await db.collection('conversations').doc(convId).get();
      if (!convDoc.exists) return res.status(404).json({ error: 'conversation_not_found' });
      const convData = convDoc.data() || {};
      if (!(convData.members || []).includes(uid)) return res.status(403).json({ error: 'Geen toegang.' });

      let query = db.collection('conversations').doc(convId)
        .collection('messages')
        .orderBy('createdAt', 'desc')
        .limit(limit);

      const clearedAt = convData.clearedAt?.[uid];
      if (clearedAt) query = query.where('createdAt', '>', clearedAt);

      const snap = await query.get();
      const messages = snap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((message) => !(message.deletedFor || []).includes(uid))
        .reverse()
        .map((message) => {
          if (message.protocol === 'signal_v1' || message.protocol === 'pulse_e2ee_service') {
            return resolveRecipientMessageView(message, uid, viewerDeviceId);
          }
          return {
            id: message.id,
            ...message,
            createdAt: normalizeTimestamp(message.createdAt) || new Date().toISOString(),
          };
        });

      res.json(messages);
    } catch (err) {
      console.error('messages feed fout:', err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  router.get('/api/attachments/:attachmentId/meta', verifyAuth, async (req, res) => {
    try {
      const { attachmentId } = req.params;
      const resolved = await findAttachmentForUser(req.uid, attachmentId);
      if (!resolved?.attachment) return res.status(404).json({ error: 'attachment_not_found' });

      const attachment = resolved.attachment;
      const expectedSha = attachment.expectedPayloadSha256 || attachment.encryption?.sha256 || '';
      const strategyKey = attachment.strategyKey || attachment.encryption?.strategyKey || '';
      const contentEncoding = attachment.contentEncoding || '';
      const envelopeKind = attachment.envelopeKind || attachment.encryption?.envelopeKind || '';
      const originalMimeType = attachment.originalMimeType || attachment.encryption?.originalMimeType || '';
      const mediaKeyId = attachment.encryption?.mediaKeyId || '';
      const keyWrapAlg = attachment.encryption?.keyWrapAlg || '';
      const wrappedMediaKeyDigest = attachment.encryption?.wrappedMediaKeyDigest || '';

      if (expectedSha) res.setHeader('X-Pulse-Expected-Sha256', expectedSha);
      if (strategyKey) res.setHeader('X-Pulse-Encryption-Strategy', strategyKey);
      if (contentEncoding) res.setHeader('X-Pulse-Content-Encoding', contentEncoding);
      if (envelopeKind) res.setHeader('X-Pulse-Envelope-Kind', envelopeKind);
      if (originalMimeType) res.setHeader('X-Pulse-Original-MimeType', originalMimeType);
      if (mediaKeyId) res.setHeader('X-Pulse-Media-Key-Id', mediaKeyId);
      if (keyWrapAlg) res.setHeader('X-Pulse-Key-Wrap-Alg', keyWrapAlg);
      if (wrappedMediaKeyDigest) res.setHeader('X-Pulse-Wrapped-Media-Key-Digest', wrappedMediaKeyDigest);

      res.json({
        ok: true,
        attachment,
        conversationId: resolved.convId,
        messageId: resolved.messageId,
      });
    } catch (err) {
      console.error('attachment meta fout:', err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  router.post('/messages/send', verifyAuth, async (req, res) => {
    try {
      const {
        conversationId,
        senderDeviceId,
        ciphertext,
        messageType = 'text',
        sharedContact = null,
        mentions = [],
        protocol = 'signal_v1',
        protocolVersion = 1,
        replyToMessageId = null,
        recipientPayloads = [],
      } = req.body || {};

      if (!conversationId || !senderDeviceId || !ciphertext || !Array.isArray(recipientPayloads) || recipientPayloads.length === 0) {
        return res.status(400).json({ error: 'encrypted_message_invalid' });
      }

      const convRef = db.collection('conversations').doc(conversationId);
      const convDoc = await convRef.get();
      if (!convDoc.exists) return res.status(404).json({ error: 'conversation_not_found' });
      const convData = convDoc.data() || {};
      if (!(convData.members || []).includes(req.uid)) return res.status(403).json({ error: 'Geen toegang.' });

      const senderDeviceDoc = await db.collection('users').doc(req.uid).collection('devices').doc(senderDeviceId).get();
      if (!senderDeviceDoc.exists || senderDeviceDoc.data()?.status !== 'active') {
        return res.status(404).json({ error: 'sender_device_not_found' });
      }

      const filteredRecipientPayloads = recipientPayloads.filter((payload) => (
        payload?.recipientUserId
          && payload?.recipientDeviceId
          && payload?.encryptedMessageKey
          && payload.recipientUserId !== req.uid
      ));

      if (filteredRecipientPayloads.length === 0) {
        return res.status(404).json({ error: 'no_recipient_devices' });
      }

      const createdAt = admin.firestore.FieldValue.serverTimestamp();
      const messageRecord = {
        convId: conversationId,
        conversationId,
        senderId: req.uid,
        senderUserId: req.uid,
        senderDeviceId,
        ciphertext,
        messageType,
        sharedContact: messageType === 'contact' ? (sharedContact || null) : null,
        mentions: Array.isArray(mentions) ? mentions : [],
        protocol: protocol || 'signal_v1',
        protocolVersion: Number(protocolVersion || 1),
        replyToMessageId: replyToMessageId || null,
        recipientPayloads: filteredRecipientPayloads,
        text: buildEncryptedPreview({ messageType, sharedContact }),
        createdAt,
      };

      const msgRef = await convRef.collection('messages').add(messageRecord);

      await convRef.update({
        lastMessage: buildEncryptedPreview({ messageType, sharedContact }),
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastReactionMessageId: admin.firestore.FieldValue.delete(),
        lastReactionEmoji: admin.firestore.FieldValue.delete(),
        lastReactionReactorId: admin.firestore.FieldValue.delete(),
        lastReactionAt: admin.firestore.FieldValue.delete(),
        lastMessageType: messageType,
        deletedFor: [],
      });

      const realtimePayload = buildRealtimeServicePayload({
        id: msgRef.id,
        ...messageRecord,
        createdAt: new Date().toISOString(),
      });

      io.to(conversationId).emit('message:received', realtimePayload);
      (convData.members || []).forEach((memberUid) => {
        const sockets = onlineUsers[memberUid];
        if (!sockets) return;
        sockets.forEach((sid) => io.to(sid).emit('message:received', realtimePayload));
      });

      res.json({ ok: true, messageId: msgRef.id });
    } catch (err) {
      console.error('encrypted send fout:', err);
      res.status(500).json({ error: 'request_failed' });
    }
  });

  router.post('/messages/receipt', verifyAuth, async (req, res) => {
    try {
      const { messageId, recipientDeviceId, type } = req.body || {};
      if (!messageId || !recipientDeviceId || !['delivered', 'read'].includes(type)) {
        return res.status(400).json({ error: 'receipt_invalid' });
      }

      const convsSnap = await db.collection('conversations')
        .where('members', 'array-contains', req.uid)
        .get();

      for (const convDoc of convsSnap.docs) {
        const msgRef = convDoc.ref.collection('messages').doc(messageId);
        const msgDoc = await msgRef.get();
        if (!msgDoc.exists) continue;

        await msgRef.set({
          receiptSummary: {
            ...(msgDoc.data()?.receiptSummary || {}),
            [type]: admin.firestore.FieldValue.serverTimestamp(),
            [`${type}By`]: req.uid,
            [`${type}DeviceId`]: recipientDeviceId,
          },
        }, { merge: true });

        return res.json({ ok: true });
      }

      return res.status(404).json({ error: 'message_not_found' });
    } catch (err) {
      console.error('receipt fout:', err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  return router;
};
