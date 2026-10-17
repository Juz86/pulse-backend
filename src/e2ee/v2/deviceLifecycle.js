const { randomUUID } = require('crypto');
const {
  MAX_ONE_TIME_PREKEYS,
  PROTOCOL,
  PROTOCOL_VERSION,
} = require('./contracts');

class E2EEV2Error extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'E2EEV2Error';
    this.status = status;
    this.code = code;
  }
}

function deviceRef(database, userId, deviceId) {
  return database.collection('users').doc(userId).collection('devices').doc(deviceId);
}

function signalDeviceQuery(database, userId, signalDeviceId) {
  return database.collection('users').doc(userId).collection('devices')
    .where('signalDeviceId', '==', signalDeviceId);
}

function assertSignalDeviceIdAvailable(snapshot, deviceId) {
  if (snapshot.docs.some((device) => device.id !== deviceId)) {
    throw new E2EEV2Error(409, 'v2_signal_device_id_conflict');
  }
}

function securityEventRef(database, userId) {
  return database.collection('users').doc(userId)
    .collection('e2eeSecurityEvents').doc(randomUUID());
}

function isBlocked(user, otherUserId) {
  return ['blockedUsers', 'blockedByParent', 'removedByParent']
    .some((field) => Array.isArray(user?.[field]) && user[field].includes(otherUserId));
}

function isChatPaused(user) {
  return Boolean(user?.pausedFeatures?.chat || user?.paused);
}

function assertClaimPolicy({ requesterId, recipientId, conversation, requester, recipient }) {
  const members = Array.isArray(conversation?.members) ? conversation.members : [];
  if (
    conversation?.isGroup
    || members.length !== 2
    || !members.includes(requesterId)
    || !members.includes(recipientId)
    || requesterId === recipientId
  ) {
    throw new E2EEV2Error(403, 'v2_direct_conversation_required');
  }
  if (
    isChatPaused(requester)
    || isChatPaused(recipient)
    || isBlocked(requester, recipientId)
    || isBlocked(recipient, requesterId)
  ) {
    throw new E2EEV2Error(403, 'v2_policy_denied');
  }
}

function createDeviceLifecycleService({ database, firebaseAdmin }) {
  const serverTimestamp = () => firebaseAdmin.firestore.FieldValue.serverTimestamp();
  const deleteField = () => firebaseAdmin.firestore.FieldValue.delete();

  async function registerDevice(userId, registration) {
    const ref = deviceRef(database, userId, registration.deviceId);
    const signalIdQuery = signalDeviceQuery(database, userId, registration.signalDeviceId);

    return database.runTransaction(async (transaction) => {
      const [existing, signalIdMatches] = await Promise.all([
        transaction.get(ref),
        transaction.get(signalIdQuery),
      ]);
      assertSignalDeviceIdAvailable(signalIdMatches, registration.deviceId);
      if (existing.exists) {
        const current = existing.data() || {};
        if (current.status === 'revoked') {
          throw new E2EEV2Error(409, 'v2_device_revoked');
        }
        if (current.identityKey !== registration.identityKey) {
          throw new E2EEV2Error(409, 'v2_identity_change_requires_rotation');
        }
        return {
          status: 'ALREADY_REGISTERED',
          deviceId: registration.deviceId,
          identityVersion: Number(current.identityVersion || 1),
        };
      }

      transaction.set(ref, {
        deviceLabel: registration.deviceLabel || 'Onbekend apparaat',
        platform: registration.platform,
        capabilities: registration.capabilities,
        signalDeviceId: registration.signalDeviceId,
        registrationId: registration.registrationId,
        identityKey: registration.identityKey,
        identityVersion: 1,
        signedPreKey: registration.signedPreKey,
        kyberPreKey: registration.kyberPreKey,
        oneTimePreKeys: registration.oneTimePreKeys,
        oneTimePreKeyCount: registration.oneTimePreKeys.length,
        protocol: PROTOCOL,
        protocolVersion: PROTOCOL_VERSION,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      return {
        status: 'REGISTERED',
        deviceId: registration.deviceId,
        identityVersion: 1,
      };
    });
  }

  async function rotateDeviceKeys(userId, deviceId, rotation) {
    const ref = deviceRef(database, userId, deviceId);
    const eventRef = securityEventRef(database, userId);
    const signalIdQuery = signalDeviceQuery(database, userId, rotation.signalDeviceId);

    return database.runTransaction(async (transaction) => {
      const [snapshot, signalIdMatches] = await Promise.all([
        transaction.get(ref),
        transaction.get(signalIdQuery),
      ]);
      if (!snapshot.exists || snapshot.data()?.status !== 'active') {
        throw new E2EEV2Error(404, 'v2_device_not_found');
      }
      assertSignalDeviceIdAvailable(signalIdMatches, deviceId);

      const current = snapshot.data() || {};
      const identityChanged = current.identityKey !== rotation.identityKey;
      const identityVersion = Number(current.identityVersion || 1) + (identityChanged ? 1 : 0);
      const timestamp = serverTimestamp();
      const event = {
        type: identityChanged ? 'identity_changed' : 'keys_rotated',
        userId,
        deviceId,
        signalDeviceId: rotation.signalDeviceId,
        identityVersion,
        createdAt: timestamp,
      };

      transaction.update(ref, {
        signalDeviceId: rotation.signalDeviceId,
        registrationId: rotation.registrationId,
        identityKey: rotation.identityKey,
        identityVersion,
        signedPreKey: rotation.signedPreKey,
        kyberPreKey: rotation.kyberPreKey,
        oneTimePreKeys: rotation.oneTimePreKeys,
        oneTimePreKeyCount: rotation.oneTimePreKeys.length,
        updatedAt: timestamp,
        ...(identityChanged ? {
          identityChangedAt: timestamp,
          sessionsInvalidAfter: timestamp,
        } : {}),
      });
      transaction.set(eventRef, event);

      return {
        status: 'ROTATED',
        deviceId,
        identityChanged,
        identityVersion,
        event: {
          ...event,
          createdAt: new Date().toISOString(),
        },
      };
    });
  }

  async function refillPreKeys(userId, deviceId, submittedPreKeys) {
    const ref = deviceRef(database, userId, deviceId);

    return database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data()?.status !== 'active') {
        throw new E2EEV2Error(404, 'v2_device_not_found');
      }
      const current = snapshot.data() || {};
      if (current.protocol !== PROTOCOL || current.protocolVersion !== PROTOCOL_VERSION) {
        throw new E2EEV2Error(409, 'v2_device_protocol_mismatch');
      }

      const existing = Array.isArray(current.oneTimePreKeys) ? current.oneTimePreKeys : [];
      const existingIds = new Set(existing.map((key) => key.keyId));
      if (submittedPreKeys.some((key) => existingIds.has(key.keyId))) {
        throw new E2EEV2Error(409, 'v2_prekey_id_conflict');
      }
      const combined = [...existing, ...submittedPreKeys];
      if (combined.length > MAX_ONE_TIME_PREKEYS) {
        throw new E2EEV2Error(409, 'v2_prekey_limit_exceeded');
      }

      transaction.update(ref, {
        oneTimePreKeys: combined,
        oneTimePreKeyCount: combined.length,
        updatedAt: serverTimestamp(),
      });
      return { status: 'REFILLED', deviceId, oneTimePreKeyCount: combined.length };
    });
  }

  async function revokeDevice(userId, deviceId) {
    const ref = deviceRef(database, userId, deviceId);
    const eventRef = securityEventRef(database, userId);

    return database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new E2EEV2Error(404, 'v2_device_not_found');

      const current = snapshot.data() || {};
      if (current.status === 'revoked') {
        return { status: 'ALREADY_REVOKED', deviceId };
      }

      const timestamp = serverTimestamp();
      const event = {
        type: 'device_revoked',
        userId,
        deviceId,
        signalDeviceId: Number(current.signalDeviceId),
        identityVersion: Number(current.identityVersion || 1),
        createdAt: timestamp,
      };
      transaction.update(ref, {
        status: 'revoked',
        oneTimePreKeys: [],
        oneTimePreKeyCount: 0,
        signedPreKey: deleteField(),
        kyberPreKey: deleteField(),
        revokedAt: timestamp,
        sessionsInvalidAfter: timestamp,
        updatedAt: timestamp,
      });
      transaction.set(eventRef, event);

      return {
        status: 'REVOKED',
        deviceId,
        event: { ...event, createdAt: new Date().toISOString() },
      };
    });
  }

  async function claimKeyBundles({
    requesterId,
    requesterDeviceId,
    claimId,
    conversationId,
    recipientId,
    allowOwnDevices = false,
  }) {
    const conversationRef = database.collection('conversations').doc(conversationId);
    const requesterRef = database.collection('users').doc(requesterId);
    const recipientRef = database.collection('users').doc(recipientId);
    const requesterDeviceRef = deviceRef(database, requesterId, requesterDeviceId);
    const claimRef = conversationRef.collection('e2eePreKeyClaims').doc(claimId);
    const activeDevicesQuery = recipientRef.collection('devices').where('status', '==', 'active');

    return database.runTransaction(async (transaction) => {
      const [
        conversationSnapshot,
        requesterSnapshot,
        recipientSnapshot,
        requesterDeviceSnapshot,
        existingClaimSnapshot,
      ] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(requesterRef),
        transaction.get(recipientRef),
        transaction.get(requesterDeviceRef),
        transaction.get(claimRef),
      ]);
      if (!conversationSnapshot.exists) {
        throw new E2EEV2Error(404, 'conversation_not_found');
      }
      if (!requesterSnapshot.exists || !recipientSnapshot.exists) {
        throw new E2EEV2Error(404, 'v2_user_not_found');
      }

      const conversation = conversationSnapshot.data() || {};
      const isOwnDeviceClaim = requesterId === recipientId;
      if (isOwnDeviceClaim) {
        const members = Array.isArray(conversation.members) ? conversation.members : [];
        if (!allowOwnDevices || conversation.isGroup || members.length !== 2 || !members.includes(requesterId)) {
          throw new E2EEV2Error(403, 'v2_direct_conversation_required');
        }
      } else {
        assertClaimPolicy({
          requesterId,
          recipientId,
          conversation,
          requester: requesterSnapshot.data() || {},
          recipient: recipientSnapshot.data() || {},
        });
      }

      if (!requesterDeviceSnapshot.exists) {
        throw new E2EEV2Error(403, 'v2_requester_device_not_found');
      }
      const requesterDevice = requesterDeviceSnapshot.data() || {};
      if (
        requesterDevice.status !== 'active'
        || requesterDevice.protocol !== PROTOCOL
        || requesterDevice.protocolVersion !== PROTOCOL_VERSION
      ) {
        throw new E2EEV2Error(403, 'v2_requester_device_not_capable');
      }

      if (existingClaimSnapshot.exists) {
        const existingClaim = existingClaimSnapshot.data() || {};
        if (
          existingClaim.requesterUserId !== requesterId
          || existingClaim.requesterDeviceId !== requesterDeviceId
          || existingClaim.recipientUserId !== recipientId
        ) {
          throw new E2EEV2Error(409, 'v2_claim_id_conflict');
        }
        return existingClaim.response;
      }

      const devicesSnapshot = await transaction.get(activeDevicesQuery);
      if (devicesSnapshot.empty) {
        throw new E2EEV2Error(409, 'v2_no_active_recipient_devices');
      }

      const claimedAt = new Date().toISOString();
      const timestamp = serverTimestamp();
      const targetDeviceSnapshots = devicesSnapshot.docs.filter((snapshot) => (
        !isOwnDeviceClaim || snapshot.id !== requesterDeviceId
      ));
      const devices = targetDeviceSnapshots.map((snapshot) => {
        const device = snapshot.data() || {};
        if (device.protocol !== PROTOCOL || device.protocolVersion !== PROTOCOL_VERSION) {
          throw new E2EEV2Error(409, 'v2_recipient_device_not_capable');
        }
        const preKeys = Array.isArray(device.oneTimePreKeys) ? device.oneTimePreKeys : [];
        if (preKeys.length === 0) {
          throw new E2EEV2Error(409, 'v2_prekeys_unavailable');
        }

        const [oneTimePreKey, ...remainingPreKeys] = preKeys;
        transaction.update(snapshot.ref, {
          oneTimePreKeys: remainingPreKeys,
          oneTimePreKeyCount: remainingPreKeys.length,
          lastPreKeyClaimedAt: timestamp,
          updatedAt: timestamp,
        });

        return {
          deviceId: snapshot.id,
          signalDeviceId: device.signalDeviceId,
          registrationId: device.registrationId,
          identityKey: device.identityKey,
          identityVersion: Number(device.identityVersion || 1),
          signedPreKey: device.signedPreKey,
          kyberPreKey: device.kyberPreKey,
          oneTimePreKey,
        };
      });

      const response = {
        protocol: PROTOCOL,
        protocolVersion: PROTOCOL_VERSION,
        conversationId,
        recipientUserId: recipientId,
        claimedAt,
        devices,
      };
      transaction.set(claimRef, {
        requesterUserId: requesterId,
        requesterDeviceId,
        recipientUserId: recipientId,
        createdAt: timestamp,
        expiresAt: firebaseAdmin.firestore.Timestamp.fromDate(
          new Date(Date.now() + (15 * 60 * 1000)),
        ),
        response,
      });
      return response;
    });
  }

  return {
    claimKeyBundles,
    refillPreKeys,
    registerDevice,
    revokeDevice,
    rotateDeviceKeys,
  };
}

module.exports = {
  E2EEV2Error,
  assertClaimPolicy,
  createDeviceLifecycleService,
};
