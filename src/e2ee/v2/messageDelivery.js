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
      if (recipientDevices.empty) {
        throw new E2EEV2Error(409, 'v2_no_active_recipient_devices');
      }

      const expectedRecipients = [];
      senderDevices.docs.forEach((snapshot) => {
        if (!isActiveV2Device(snapshot.data())) {
          throw new E2EEV2Error(409, 'v2_recipient_device_not_capable');
        }
        if (snapshot.id !== message.senderDeviceId) {
          expectedRecipients.push({ userId: senderUserId, deviceId: snapshot.id });
        }
      });
      recipientDevices.docs.forEach((snapshot) => {
        if (!isActiveV2Device(snapshot.data())) {
          throw new E2EEV2Error(409, 'v2_recipient_device_not_capable');
        }
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
      ...envelope,
      createdAt: normalizeTimestamp(envelope.createdAt),
    };
  }

  return { getEnvelope, sendMessage };
}

module.exports = {
  assertExpectedEnvelopes,
  createMessageDeliveryService,
};
