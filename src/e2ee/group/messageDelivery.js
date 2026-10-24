const { createHash } = require('crypto');
const { E2EEV2Error } = require('../v2/deviceLifecycle');
const { isActiveV2Device } = require('../v2/deviceAudience');
const { GROUP_PROTOCOL, GROUP_PROTOCOL_VERSION } = require('./contracts');
const { authorizeGroupMessage } = require('./policy');

function deviceRef(database, userId, deviceId) {
  return database.collection('users').doc(userId).collection('devices').doc(deviceId);
}

function distributionRef(conversationRef, epoch, distributionId) {
  return conversationRef.collection('e2eeGroupEpochs').doc(String(epoch))
    .collection('senderKeyDistributions').doc(distributionId);
}

function audienceKey(value) {
  return `${value.recipientUserId}\u0000${value.recipientDeviceId}`;
}

function groupMessageDigest(value) {
  return createHash('sha256').update(JSON.stringify({
    protocol: value.protocol,
    protocolVersion: value.protocolVersion,
    conversationId: value.conversationId,
    clientMessageId: value.clientMessageId,
    senderDeviceId: value.senderDeviceId,
    senderSignalDeviceId: value.senderSignalDeviceId,
    senderIdentityVersion: value.senderIdentityVersion,
    epoch: value.epoch,
    distributionId: value.distributionId,
    messageType: value.messageType,
    ciphertext: value.ciphertext,
  })).digest('hex');
}

function createGroupMessageDeliveryService({ database, firebaseAdmin }) {
  const serverTimestamp = () => firebaseAdmin.firestore.FieldValue.serverTimestamp();

  async function sendMessage(senderUserId, payload) {
    const conversationRef = database.collection('conversations').doc(payload.conversationId);
    const messageRef = conversationRef.collection('messages').doc(payload.clientMessageId);
    const senderDeviceRef = deviceRef(database, senderUserId, payload.senderDeviceId);
    const senderDistributionRef = distributionRef(
      conversationRef,
      payload.epoch,
      payload.distributionId,
    );
    const requestDigest = groupMessageDigest(payload);
    return database.runTransaction(async (transaction) => {
      const [conversationSnapshot, senderDeviceSnapshot, distributionSnapshot, existingSnapshot] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(senderDeviceRef),
        transaction.get(senderDistributionRef),
        transaction.get(messageRef),
      ]);
      if (!conversationSnapshot.exists) throw new E2EEV2Error(404, 'conversation_not_found');
      if (existingSnapshot.exists) {
        const existing = existingSnapshot.data() || {};
        if (
          existing.protocol !== GROUP_PROTOCOL
          || existing.senderUserId !== senderUserId
          || existing.senderDeviceId !== payload.senderDeviceId
          || existing.requestDigest !== requestDigest
        ) {
          throw new E2EEV2Error(409, 'group_e2ee_message_id_conflict');
        }
        return {
          messageId: payload.clientMessageId,
          clientMessageId: payload.clientMessageId,
          idempotent: true,
          deliveries: [],
        };
      }
      const conversation = conversationSnapshot.data() || {};
      const members = Array.isArray(conversation.members) ? conversation.members : [];
      const deviceQueries = members.map(userId => (
        database.collection('users').doc(userId).collection('devices').where('status', '==', 'active')
      ));
      const deviceSnapshots = await Promise.all(deviceQueries.map(query => transaction.get(query)));
      const devicesByUser = {};
      members.forEach((userId, index) => {
        devicesByUser[userId] = deviceSnapshots[index].docs.map(snapshot => ({
          deviceId: snapshot.id,
          ...snapshot.data(),
        }));
      });
      const senderDevice = senderDeviceSnapshot.exists
        ? { deviceId: senderDeviceSnapshot.id, ...senderDeviceSnapshot.data() }
        : null;
      const authorization = authorizeGroupMessage({
        conversation,
        authenticatedUserId: senderUserId,
        authenticatedDevice: senderDevice,
        devicesByUser,
        payload,
        distribution: distributionSnapshot.exists ? distributionSnapshot.data() : null,
      });
      const audiences = authorization.recipients.map(({ userId, deviceId }) => ({
        recipientUserId: userId,
        recipientDeviceId: deviceId,
      }));
      const timestamp = serverTimestamp();
      transaction.set(messageRef, {
        protocol: GROUP_PROTOCOL,
        protocolVersion: GROUP_PROTOCOL_VERSION,
        conversationId: payload.conversationId,
        convId: payload.conversationId,
        clientMessageId: payload.clientMessageId,
        senderUserId,
        senderId: senderUserId,
        senderDeviceId: payload.senderDeviceId,
        senderSignalDeviceId: payload.senderSignalDeviceId,
        senderIdentityVersion: payload.senderIdentityVersion,
        epoch: payload.epoch,
        distributionId: payload.distributionId,
        messageType: payload.messageType,
        ciphertext: payload.ciphertext,
        requestDigest,
        recipientAudiences: audiences,
        pendingRecipientAudiences: audiences,
        recipientDeviceCount: audiences.length,
        text: 'Versleuteld groepsbericht',
        createdAt: timestamp,
      });
      transaction.update(conversationRef, {
        lastMessage: 'Versleuteld groepsbericht',
        lastMessageAt: timestamp,
        lastMessageType: payload.messageType,
        updatedAt: timestamp,
        deletedFor: [],
      });
      return {
        messageId: payload.clientMessageId,
        clientMessageId: payload.clientMessageId,
        idempotent: false,
        deliveries: audiences,
      };
    });
  }

  async function assertRecipient({ userId, deviceId, conversationId, messageId }) {
    const conversationRef = database.collection('conversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(messageId);
    const [conversationSnapshot, deviceSnapshot, messageSnapshot] = await Promise.all([
      conversationRef.get(),
      deviceRef(database, userId, deviceId).get(),
      messageRef.get(),
    ]);
    if (!conversationSnapshot.exists || !messageSnapshot.exists) {
      throw new E2EEV2Error(404, 'group_e2ee_message_not_found');
    }
    if (!(conversationSnapshot.data()?.members || []).includes(userId)) {
      throw new E2EEV2Error(403, 'group_e2ee_message_access_denied');
    }
    if (!deviceSnapshot.exists || !isActiveV2Device(deviceSnapshot.data())) {
      throw new E2EEV2Error(403, 'group_e2ee_recipient_device_not_capable');
    }
    const message = messageSnapshot.data() || {};
    if (
      message.protocol !== GROUP_PROTOCOL
      || !(message.recipientAudiences || []).some(value => audienceKey(value) === audienceKey({
        recipientUserId: userId,
        recipientDeviceId: deviceId,
      }))
    ) {
      throw new E2EEV2Error(404, 'group_e2ee_message_not_found');
    }
    return { conversationRef, messageRef, message };
  }

  async function getMessage(identity) {
    const { message } = await assertRecipient(identity);
    return {
      protocol: message.protocol,
      protocolVersion: message.protocolVersion,
      conversationId: message.conversationId,
      messageId: identity.messageId,
      clientMessageId: message.clientMessageId,
      senderUserId: message.senderUserId,
      senderDeviceId: message.senderDeviceId,
      senderSignalDeviceId: message.senderSignalDeviceId,
      senderIdentityVersion: message.senderIdentityVersion,
      epoch: message.epoch,
      distributionId: message.distributionId,
      messageType: message.messageType,
      ciphertext: message.ciphertext,
    };
  }

  async function listPending({ userId, deviceId, conversationId, limit = 50 }) {
    const conversationRef = database.collection('conversations').doc(conversationId);
    const [conversationSnapshot, deviceSnapshot] = await Promise.all([
      conversationRef.get(),
      deviceRef(database, userId, deviceId).get(),
    ]);
    if (!conversationSnapshot.exists || !(conversationSnapshot.data()?.members || []).includes(userId)) {
      throw new E2EEV2Error(403, 'group_e2ee_message_access_denied');
    }
    if (!deviceSnapshot.exists || !isActiveV2Device(deviceSnapshot.data())) {
      throw new E2EEV2Error(403, 'group_e2ee_recipient_device_not_capable');
    }
    const audience = { recipientUserId: userId, recipientDeviceId: deviceId };
    const snapshot = await conversationRef.collection('messages')
      .where('pendingRecipientAudiences', 'array-contains', audience)
      .get();
    return snapshot.docs
      .filter(document => document.data()?.protocol === GROUP_PROTOCOL)
      .slice(0, limit)
      .map(document => ({
        protocol: GROUP_PROTOCOL,
        protocolVersion: GROUP_PROTOCOL_VERSION,
        conversationId,
        messageId: document.id,
      }));
  }

  async function acknowledgeMessage({ userId, deviceId, conversationId, messageId }) {
    const conversationRef = database.collection('conversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(messageId);
    const audience = { recipientUserId: userId, recipientDeviceId: deviceId };
    return database.runTransaction(async (transaction) => {
      const [conversationSnapshot, deviceSnapshot, messageSnapshot] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(deviceRef(database, userId, deviceId)),
        transaction.get(messageRef),
      ]);
      if (!conversationSnapshot.exists || !messageSnapshot.exists) {
        throw new E2EEV2Error(404, 'group_e2ee_message_not_found');
      }
      if (!(conversationSnapshot.data()?.members || []).includes(userId)) {
        throw new E2EEV2Error(403, 'group_e2ee_message_access_denied');
      }
      if (!deviceSnapshot.exists || !isActiveV2Device(deviceSnapshot.data())) {
        throw new E2EEV2Error(403, 'group_e2ee_recipient_device_not_capable');
      }
      const message = messageSnapshot.data() || {};
      const pending = message.pendingRecipientAudiences || [];
      if (!pending.some(value => audienceKey(value) === audienceKey(audience))) {
        const wasRecipient = (message.recipientAudiences || [])
          .some(value => audienceKey(value) === audienceKey(audience));
        if (wasRecipient) return { messageId, idempotent: true };
        throw new E2EEV2Error(404, 'group_e2ee_message_not_found');
      }
      transaction.update(messageRef, {
        pendingRecipientAudiences: pending.filter(value => audienceKey(value) !== audienceKey(audience)),
        updatedAt: serverTimestamp(),
      });
      return { messageId, idempotent: false };
    });
  }

  return { acknowledgeMessage, getMessage, listPending, sendMessage };
}

module.exports = { createGroupMessageDeliveryService, groupMessageDigest };
