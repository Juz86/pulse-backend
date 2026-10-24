const { createHash } = require('crypto');
const { PROTOCOL, PROTOCOL_VERSION } = require('./contracts');
const { E2EEV2Error, assertClaimPolicy } = require('./deviceLifecycle');
const { deviceAudienceId, isActiveV2Device } = require('./deviceAudience');

function deviceRef(database, userId, deviceId) {
  return database.collection('users').doc(userId).collection('devices').doc(deviceId);
}

function recipientKey(userId, deviceId) {
  return `${userId}\u0000${deviceId}`;
}

function messageRequestDigest(message) {
  const envelopes = [...message.recipientEnvelopes]
    .sort((left, right) => recipientKey(
      left.recipientUserId,
      left.recipientDeviceId,
    ).localeCompare(recipientKey(right.recipientUserId, right.recipientDeviceId)));
  return createHash('sha256').update(JSON.stringify({
    protocol: message.protocol,
    protocolVersion: message.protocolVersion,
    conversationId: message.conversationId,
    clientMessageId: message.clientMessageId,
    senderDeviceId: message.senderDeviceId,
    messageType: message.messageType,
    recipientEnvelopes: envelopes,
  })).digest('hex');
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Number.isFinite(value._seconds)) return new Date(value._seconds * 1000).toISOString();
  return typeof value === 'string' ? value : null;
}

function assertConversationEncryptionState(conversation) {
  if (!['v2_pending', 'v2_required'].includes(conversation?.e2eeState)) {
    throw new E2EEV2Error(409, 'v2_conversation_not_enabled');
  }
}

function assertExpectedEnvelopes(submitted, expected) {
  if (expected.length > 128) {
    throw new E2EEV2Error(409, 'v2_recipient_limit_exceeded');
  }

  const expectedKeys = new Set(expected.map(({ userId, deviceId }) => recipientKey(userId, deviceId)));
  const submittedKeys = new Set(submitted.map((envelope) => (
    recipientKey(envelope.recipientUserId, envelope.recipientDeviceId)
  )));
  if (
    submittedKeys.size !== submitted.length
    || submittedKeys.size !== expectedKeys.size
    || [...expectedKeys].some((key) => !submittedKeys.has(key))
  ) {
    throw new E2EEV2Error(409, 'v2_recipient_set_mismatch');
  }
}

function createMessageDeliveryService({ database, firebaseAdmin }) {
  const serverTimestamp = () => firebaseAdmin.firestore.FieldValue.serverTimestamp();
  const deleteField = () => firebaseAdmin.firestore.FieldValue.delete();
  const arrayRemove = (value) => firebaseAdmin.firestore.FieldValue.arrayRemove(value);

  async function sendMessage(senderUserId, message) {
    const conversationRef = database.collection('conversations').doc(message.conversationId);
    const senderRef = database.collection('users').doc(senderUserId);
    const messageRef = conversationRef.collection('messages').doc(message.clientMessageId);

    const requestDigest = messageRequestDigest(message);
    return database.runTransaction(async (transaction) => {
      const [conversationSnapshot, senderSnapshot, existingMessageSnapshot] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(senderRef),
        transaction.get(messageRef),
      ]);
      if (!conversationSnapshot.exists) {
        throw new E2EEV2Error(404, 'conversation_not_found');
      }
      if (!senderSnapshot.exists) {
        throw new E2EEV2Error(404, 'v2_user_not_found');
      }

      if (existingMessageSnapshot.exists) {
        const existing = existingMessageSnapshot.data() || {};
        if (
          existing.protocol !== PROTOCOL
          || existing.senderUserId !== senderUserId
          || existing.senderDeviceId !== message.senderDeviceId
          || existing.clientMessageId !== message.clientMessageId
          || existing.requestDigest !== requestDigest
        ) {
          throw new E2EEV2Error(409, 'v2_message_id_conflict');
        }
        return {
          messageId: existingMessageSnapshot.id,
          clientMessageId: message.clientMessageId,
          idempotent: true,
          deliveries: [],
        };
      }

      const conversation = conversationSnapshot.data() || {};
      assertConversationEncryptionState(conversation);
      const members = Array.isArray(conversation.members) ? conversation.members : [];
      const recipientUserId = members.find((memberId) => memberId !== senderUserId);
      if (!recipientUserId) {
        throw new E2EEV2Error(403, 'v2_direct_conversation_required');
      }

      const recipientRef = database.collection('users').doc(recipientUserId);
      const senderDeviceRef = deviceRef(database, senderUserId, message.senderDeviceId);
      const senderDevicesQuery = senderRef.collection('devices').where('status', '==', 'active');
      const recipientDevicesQuery = recipientRef.collection('devices').where('status', '==', 'active');
      const [recipientSnapshot, senderDeviceSnapshot, senderDevices, recipientDevices] = await Promise.all([
        transaction.get(recipientRef),
        transaction.get(senderDeviceRef),
        transaction.get(senderDevicesQuery),
        transaction.get(recipientDevicesQuery),
      ]);
      if (!recipientSnapshot.exists) {
        throw new E2EEV2Error(404, 'v2_user_not_found');
      }

      assertClaimPolicy({
        requesterId: senderUserId,
        recipientId: recipientUserId,
        conversation,
        requester: senderSnapshot.data() || {},
        recipient: recipientSnapshot.data() || {},
      });
      if (!senderDeviceSnapshot.exists || !isActiveV2Device(senderDeviceSnapshot.data())) {
        throw new E2EEV2Error(403, 'v2_sender_device_not_capable');
      }
      const senderSignalDeviceId = Number(senderDeviceSnapshot.data()?.signalDeviceId);
      const senderIdentityVersion = Number(senderDeviceSnapshot.data()?.identityVersion || 1);
      if (!Number.isInteger(senderSignalDeviceId) || senderSignalDeviceId < 1 || senderSignalDeviceId > 127) {
        throw new E2EEV2Error(409, 'v2_sender_device_not_capable');
      }
      if (!Number.isInteger(senderIdentityVersion) || senderIdentityVersion < 1) {
        throw new E2EEV2Error(409, 'v2_sender_device_not_capable');
      }
      const activeSenderV2Devices = senderDevices.docs.filter((snapshot) => (
        isActiveV2Device(snapshot.data())
      ));
      const activeRecipientV2Devices = recipientDevices.docs.filter((snapshot) => (
        isActiveV2Device(snapshot.data())
      ));
      if (activeRecipientV2Devices.length === 0) {
        throw new E2EEV2Error(409, 'v2_no_active_recipient_devices');
      }

      const expectedRecipients = [];
      activeSenderV2Devices.forEach((snapshot) => {
        if (snapshot.id !== message.senderDeviceId) {
          expectedRecipients.push({ userId: senderUserId, deviceId: snapshot.id });
        }
      });
      activeRecipientV2Devices.forEach((snapshot) => {
        expectedRecipients.push({ userId: recipientUserId, deviceId: snapshot.id });
      });
      assertExpectedEnvelopes(message.recipientEnvelopes, expectedRecipients);

      const acceptedAt = new Date().toISOString();
      const timestamp = serverTimestamp();
      const recipientAudiences = expectedRecipients.map(({ userId, deviceId }) => ({
        recipientUserId: userId,
        recipientDeviceId: deviceId,
      }));
      transaction.set(messageRef, {
        protocol: PROTOCOL,
        protocolVersion: PROTOCOL_VERSION,
        conversationId: message.conversationId,
        convId: message.conversationId,
        clientMessageId: message.clientMessageId,
        senderUserId,
        senderId: senderUserId,
        senderDeviceId: message.senderDeviceId,
        senderSignalDeviceId,
        senderIdentityVersion,
        messageType: message.messageType,
        requestDigest,
        recipientAudiences,
        pendingRecipientAudiences: recipientAudiences,
        recipientDeviceCount: recipientAudiences.length,
        text: 'Versleuteld bericht',
        createdAt: timestamp,
      });

      message.recipientEnvelopes.forEach((envelope) => {
        const envelopeRef = messageRef.collection('deviceEnvelopes').doc(
          deviceAudienceId(envelope.recipientUserId, envelope.recipientDeviceId),
        );
        transaction.set(envelopeRef, {
          protocol: PROTOCOL,
          protocolVersion: PROTOCOL_VERSION,
          messageId: message.clientMessageId,
          conversationId: message.conversationId,
          clientMessageId: message.clientMessageId,
          senderUserId,
          senderDeviceId: message.senderDeviceId,
          senderSignalDeviceId,
          senderIdentityVersion,
          recipientUserId: envelope.recipientUserId,
          recipientDeviceId: envelope.recipientDeviceId,
          messageType: message.messageType,
          envelopeType: envelope.envelopeType,
          ciphertext: envelope.ciphertext,
          deliveryState: 'pending',
          createdAt: timestamp,
        });
      });

      transaction.update(conversationRef, {
        lastMessage: 'Versleuteld bericht',
        lastMessageAt: timestamp,
        lastMessageType: message.messageType,
        updatedAt: timestamp,
        lastReactionMessageId: deleteField(),
        lastReactionEmoji: deleteField(),
        lastReactionReactorId: deleteField(),
        lastReactionAt: deleteField(),
        deletedFor: [],
      });

      return {
        messageId: message.clientMessageId,
        clientMessageId: message.clientMessageId,
        idempotent: false,
        acceptedAt,
        deliveries: recipientAudiences,
      };
    });
  }

  async function getEnvelope({ userId, deviceId, conversationId, messageId }) {
    const conversationRef = database.collection('conversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(messageId);
    const envelopeRef = messageRef.collection('deviceEnvelopes').doc(
      deviceAudienceId(userId, deviceId),
    );
    const [conversationSnapshot, deviceSnapshot, messageSnapshot, envelopeSnapshot] = await Promise.all([
      conversationRef.get(),
      deviceRef(database, userId, deviceId).get(),
      messageRef.get(),
      envelopeRef.get(),
    ]);
    if (!conversationSnapshot.exists || !messageSnapshot.exists) {
      throw new E2EEV2Error(404, 'v2_message_not_found');
    }
    if (!(conversationSnapshot.data()?.members || []).includes(userId)) {
      throw new E2EEV2Error(403, 'v2_message_access_denied');
    }
    if (!deviceSnapshot.exists || !isActiveV2Device(deviceSnapshot.data())) {
      throw new E2EEV2Error(403, 'v2_recipient_device_not_capable');
    }
    if (!envelopeSnapshot.exists) {
      throw new E2EEV2Error(404, 'v2_envelope_not_found');
    }

    const envelope = envelopeSnapshot.data() || {};
    if (envelope.recipientUserId !== userId || envelope.recipientDeviceId !== deviceId) {
      throw new E2EEV2Error(403, 'v2_message_access_denied');
    }
    return {
      protocol: envelope.protocol,
      protocolVersion: envelope.protocolVersion,
      messageId: envelope.messageId,
      conversationId: envelope.conversationId,
      clientMessageId: envelope.clientMessageId,
      senderUserId: envelope.senderUserId,
      senderDeviceId: envelope.senderDeviceId,
      senderSignalDeviceId: envelope.senderSignalDeviceId,
      senderIdentityVersion: envelope.senderIdentityVersion,
      recipientUserId: envelope.recipientUserId,
      recipientDeviceId: envelope.recipientDeviceId,
      messageType: envelope.messageType,
      envelopeType: envelope.envelopeType,
      ciphertext: envelope.ciphertext,
      createdAt: normalizeTimestamp(envelope.createdAt),
    };
  }

  async function listMessageFeed({ userId, deviceId, conversationId, limit = 50, offset = 0 }) {
    const conversationRef = database.collection('conversations').doc(conversationId);
    const [conversationSnapshot, deviceSnapshot] = await Promise.all([
      conversationRef.get(),
      deviceRef(database, userId, deviceId).get(),
    ]);
    if (!conversationSnapshot.exists) {
      throw new E2EEV2Error(404, 'conversation_not_found');
    }
    if (!(conversationSnapshot.data()?.members || []).includes(userId)) {
      throw new E2EEV2Error(403, 'v2_message_access_denied');
    }
    if (!deviceSnapshot.exists || !isActiveV2Device(deviceSnapshot.data())) {
      throw new E2EEV2Error(403, 'v2_recipient_device_not_capable');
    }

    const audience = { recipientUserId: userId, recipientDeviceId: deviceId };
    const snapshot = await conversationRef.collection('messages')
      .where('pendingRecipientAudiences', 'array-contains', audience)
      .get();

    return snapshot.docs.map((messageSnapshot) => {
      const message = messageSnapshot.data() || {};
      return {
        protocol: message.protocol,
        protocolVersion: message.protocolVersion,
        conversationId,
        messageId: messageSnapshot.id,
        createdAt: normalizeTimestamp(message.createdAt),
      };
    }).sort((left, right) => {
      const timeDiff = Date.parse(left.createdAt || '') - Date.parse(right.createdAt || '');
      return timeDiff || left.messageId.localeCompare(right.messageId);
    }).slice(offset, offset + limit);
  }

  async function acknowledgeMessage({ userId, deviceId, conversationId, messageId }) {
    const conversationRef = database.collection('conversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(messageId);
    const envelopeRef = messageRef.collection('deviceEnvelopes').doc(
      deviceAudienceId(userId, deviceId),
    );
    const audience = { recipientUserId: userId, recipientDeviceId: deviceId };

    return database.runTransaction(async (transaction) => {
      const [conversationSnapshot, deviceSnapshot, messageSnapshot, envelopeSnapshot] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(deviceRef(database, userId, deviceId)),
        transaction.get(messageRef),
        transaction.get(envelopeRef),
      ]);
      if (!conversationSnapshot.exists || !messageSnapshot.exists || !envelopeSnapshot.exists) {
        throw new E2EEV2Error(404, 'v2_message_not_found');
      }
      if (!(conversationSnapshot.data()?.members || []).includes(userId)) {
        throw new E2EEV2Error(403, 'v2_message_access_denied');
      }
      if (!deviceSnapshot.exists || !isActiveV2Device(deviceSnapshot.data())) {
        throw new E2EEV2Error(403, 'v2_recipient_device_not_capable');
      }
      const envelope = envelopeSnapshot.data() || {};
      if (envelope.recipientUserId !== userId || envelope.recipientDeviceId !== deviceId) {
        throw new E2EEV2Error(403, 'v2_message_access_denied');
      }
      if (envelope.deliveryState === 'decrypted') {
        return { messageId, idempotent: true };
      }
      if (envelope.deliveryState !== 'pending') {
        throw new E2EEV2Error(409, 'v2_delivery_state_invalid');
      }

      transaction.update(envelopeRef, {
        deliveryState: 'decrypted',
        decryptedAt: serverTimestamp(),
      });
      transaction.update(messageRef, {
        pendingRecipientAudiences: arrayRemove(audience),
      });
      return { messageId, idempotent: false };
    });
  }

  return { acknowledgeMessage, getEnvelope, listMessageFeed, sendMessage };
}

module.exports = {
  assertExpectedEnvelopes,
  createMessageDeliveryService,
};
