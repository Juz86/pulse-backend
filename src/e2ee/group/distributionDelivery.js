const { createHash } = require('crypto');
const { E2EEV2Error } = require('../v2/deviceLifecycle');
const { deviceAudienceId, isActiveV2Device } = require('../v2/deviceAudience');
const { GROUP_PROTOCOL, GROUP_PROTOCOL_VERSION } = require('./contracts');
const { authorizeGroupDistribution, groupMembershipHash } = require('./policy');

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

function distributionDigest(value) {
  const envelopes = [...value.recipientEnvelopes]
    .sort((left, right) => audienceKey(left).localeCompare(audienceKey(right)));
  return createHash('sha256').update(JSON.stringify({
    protocol: value.protocol,
    protocolVersion: value.protocolVersion,
    conversationId: value.conversationId,
    senderDeviceId: value.senderDeviceId,
    senderSignalDeviceId: value.senderSignalDeviceId,
    senderIdentityVersion: value.senderIdentityVersion,
    epoch: value.epoch,
    distributionId: value.distributionId,
    recipientEnvelopes: envelopes,
  })).digest('hex');
}

function createGroupDistributionDeliveryService({ database, firebaseAdmin }) {
  const serverTimestamp = () => firebaseAdmin.firestore.FieldValue.serverTimestamp();

  async function storeDistribution(senderUserId, payload) {
    const conversationRef = database.collection('conversations').doc(payload.conversationId);
    const senderDeviceRef = deviceRef(database, senderUserId, payload.senderDeviceId);
    const targetRef = distributionRef(
      conversationRef,
      payload.epoch,
      payload.distributionId,
    );
    const requestDigest = distributionDigest(payload);

    return database.runTransaction(async (transaction) => {
      const [conversationSnapshot, senderDeviceSnapshot, existingSnapshot] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(senderDeviceRef),
        transaction.get(targetRef),
      ]);
      if (!conversationSnapshot.exists) {
        throw new E2EEV2Error(404, 'conversation_not_found');
      }
      if (existingSnapshot.exists) {
        const existing = existingSnapshot.data() || {};
        if (
          existing.requestDigest !== requestDigest
          || existing.senderUserId !== senderUserId
          || existing.senderDeviceId !== payload.senderDeviceId
        ) {
          throw new E2EEV2Error(409, 'group_e2ee_distribution_id_conflict');
        }
        return {
          distributionId: payload.distributionId,
          epoch: payload.epoch,
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
      const authorization = authorizeGroupDistribution({
        conversation,
        authenticatedUserId: senderUserId,
        authenticatedDevice: senderDevice,
        devicesByUser,
        payload,
      });
      const audiences = authorization.recipients.map(({ userId, deviceId }) => ({
        recipientUserId: userId,
        recipientDeviceId: deviceId,
      }));
      const timestamp = serverTimestamp();
      transaction.set(targetRef, {
        protocol: GROUP_PROTOCOL,
        protocolVersion: GROUP_PROTOCOL_VERSION,
        conversationId: payload.conversationId,
        epoch: payload.epoch,
        distributionId: payload.distributionId,
        membershipHash: conversation.e2eeGroupMembershipHash,
        senderUserId,
        senderDeviceId: payload.senderDeviceId,
        senderSignalDeviceId: payload.senderSignalDeviceId,
        senderIdentityVersion: payload.senderIdentityVersion,
        requestDigest,
        recipientAudiences: audiences,
        pendingRecipientAudiences: audiences,
        recipientDeviceCount: audiences.length,
        status: 'distributing',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      payload.recipientEnvelopes.forEach((envelope) => {
        const envelopeRef = targetRef.collection('deviceEnvelopes').doc(
          deviceAudienceId(envelope.recipientUserId, envelope.recipientDeviceId),
        );
        transaction.set(envelopeRef, {
          protocol: GROUP_PROTOCOL,
          protocolVersion: GROUP_PROTOCOL_VERSION,
          conversationId: payload.conversationId,
          epoch: payload.epoch,
          distributionId: payload.distributionId,
          senderUserId,
          senderDeviceId: payload.senderDeviceId,
          senderSignalDeviceId: payload.senderSignalDeviceId,
          senderIdentityVersion: payload.senderIdentityVersion,
          recipientUserId: envelope.recipientUserId,
          recipientDeviceId: envelope.recipientDeviceId,
          envelopeType: envelope.envelopeType,
          ciphertext: envelope.ciphertext,
          deliveryState: 'pending',
          createdAt: timestamp,
        });
      });
      return {
        distributionId: payload.distributionId,
        epoch: payload.epoch,
        idempotent: false,
        deliveries: audiences,
      };
    });
  }

  async function getEnvelope({ userId, deviceId, conversationId, epoch, distributionId }) {
    const conversationRef = database.collection('conversations').doc(conversationId);
    const targetRef = distributionRef(conversationRef, epoch, distributionId);
    const envelopeRef = targetRef.collection('deviceEnvelopes').doc(
      deviceAudienceId(userId, deviceId),
    );
    const [conversationSnapshot, deviceSnapshot, distributionSnapshot, envelopeSnapshot] = await Promise.all([
      conversationRef.get(),
      deviceRef(database, userId, deviceId).get(),
      targetRef.get(),
      envelopeRef.get(),
    ]);
    if (!conversationSnapshot.exists || !distributionSnapshot.exists || !envelopeSnapshot.exists) {
      throw new E2EEV2Error(404, 'group_e2ee_distribution_not_found');
    }
    if (!(conversationSnapshot.data()?.members || []).includes(userId)) {
      throw new E2EEV2Error(403, 'group_e2ee_distribution_access_denied');
    }
    if (!deviceSnapshot.exists || !isActiveV2Device(deviceSnapshot.data())) {
      throw new E2EEV2Error(403, 'group_e2ee_recipient_device_not_capable');
    }
    const envelope = envelopeSnapshot.data() || {};
    if (envelope.recipientUserId !== userId || envelope.recipientDeviceId !== deviceId) {
      throw new E2EEV2Error(403, 'group_e2ee_distribution_access_denied');
    }
    return {
      protocol: envelope.protocol,
      protocolVersion: envelope.protocolVersion,
      conversationId: envelope.conversationId,
      epoch: envelope.epoch,
      distributionId: envelope.distributionId,
      senderUserId: envelope.senderUserId,
      senderDeviceId: envelope.senderDeviceId,
      senderSignalDeviceId: envelope.senderSignalDeviceId,
      senderIdentityVersion: envelope.senderIdentityVersion,
      recipientUserId: envelope.recipientUserId,
      recipientDeviceId: envelope.recipientDeviceId,
      envelopeType: envelope.envelopeType,
      ciphertext: envelope.ciphertext,
    };
  }

  async function acknowledgeEnvelope({ userId, deviceId, conversationId, epoch, distributionId }) {
    const conversationRef = database.collection('conversations').doc(conversationId);
    const targetRef = distributionRef(conversationRef, epoch, distributionId);
    const envelopeRef = targetRef.collection('deviceEnvelopes').doc(
      deviceAudienceId(userId, deviceId),
    );
    const audience = { recipientUserId: userId, recipientDeviceId: deviceId };
    return database.runTransaction(async (transaction) => {
      const [conversationSnapshot, deviceSnapshot, distributionSnapshot, envelopeSnapshot] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(deviceRef(database, userId, deviceId)),
        transaction.get(targetRef),
        transaction.get(envelopeRef),
      ]);
      if (!conversationSnapshot.exists || !distributionSnapshot.exists || !envelopeSnapshot.exists) {
        throw new E2EEV2Error(404, 'group_e2ee_distribution_not_found');
      }
      if (!(conversationSnapshot.data()?.members || []).includes(userId)) {
        throw new E2EEV2Error(403, 'group_e2ee_distribution_access_denied');
      }
      if (!deviceSnapshot.exists || !isActiveV2Device(deviceSnapshot.data())) {
        throw new E2EEV2Error(403, 'group_e2ee_recipient_device_not_capable');
      }
      const envelope = envelopeSnapshot.data() || {};
      if (envelope.recipientUserId !== userId || envelope.recipientDeviceId !== deviceId) {
        throw new E2EEV2Error(403, 'group_e2ee_distribution_access_denied');
      }
      if (envelope.deliveryState === 'received') {
        return { distributionId, epoch, idempotent: true, ready: distributionSnapshot.data()?.status === 'ready' };
      }
      if (envelope.deliveryState !== 'pending') {
        throw new E2EEV2Error(409, 'group_e2ee_delivery_state_invalid');
      }
      const distribution = distributionSnapshot.data() || {};
      const pending = (distribution.pendingRecipientAudiences || [])
        .filter(value => audienceKey(value) !== audienceKey(audience));
      transaction.update(envelopeRef, {
        deliveryState: 'received',
        receivedAt: serverTimestamp(),
      });
      transaction.update(targetRef, {
        pendingRecipientAudiences: pending,
        status: pending.length === 0 ? 'ready' : 'distributing',
        updatedAt: serverTimestamp(),
      });
      return { distributionId, epoch, idempotent: false, ready: pending.length === 0 };
    });
  }

  async function listPending({ userId, deviceId, conversationId, epoch, limit = 50 }) {
    const conversationRef = database.collection('conversations').doc(conversationId);
    const [conversationSnapshot, deviceSnapshot] = await Promise.all([
      conversationRef.get(),
      deviceRef(database, userId, deviceId).get(),
    ]);
    if (!conversationSnapshot.exists) {
      throw new E2EEV2Error(404, 'conversation_not_found');
    }
    const conversation = conversationSnapshot.data() || {};
    if (!conversation.isGroup || !(conversation.members || []).includes(userId)) {
      throw new E2EEV2Error(403, 'group_e2ee_distribution_access_denied');
    }
    if (!deviceSnapshot.exists || !isActiveV2Device(deviceSnapshot.data())) {
      throw new E2EEV2Error(403, 'group_e2ee_recipient_device_not_capable');
    }
    if (
      Number(conversation.e2eeGroupEpoch) !== epoch
      || conversation.e2eeGroupMembershipHash !== groupMembershipHash(conversation.members)
    ) {
      throw new E2EEV2Error(409, 'group_e2ee_epoch_rotation_required');
    }
    const audience = { recipientUserId: userId, recipientDeviceId: deviceId };
    const snapshot = await conversationRef.collection('e2eeGroupEpochs').doc(String(epoch))
      .collection('senderKeyDistributions')
      .where('pendingRecipientAudiences', 'array-contains', audience)
      .get();
    return snapshot.docs.slice(0, limit).map(document => ({
      protocol: GROUP_PROTOCOL,
      protocolVersion: GROUP_PROTOCOL_VERSION,
      conversationId,
      epoch,
      distributionId: document.id,
    }));
  }

  return { acknowledgeEnvelope, getEnvelope, listPending, storeDistribution };
}

module.exports = {
  createGroupDistributionDeliveryService,
  distributionDigest,
};
