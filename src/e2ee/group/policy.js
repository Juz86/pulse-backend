const { createHash } = require('crypto');
const { E2EEV2Error } = require('../v2/deviceLifecycle');
const { isActiveV2Device } = require('../v2/deviceAudience');
const { MAX_GROUP_RECIPIENT_DEVICES } = require('./contracts');

function recipientKey(userId, deviceId) {
  return `${userId}\u0000${deviceId}`;
}

function canonicalMembers(members) {
  return [...new Set(Array.isArray(members) ? members : [])]
    .filter(member => typeof member === 'string' && member.length > 0)
    .sort();
}

function groupMembershipHash(members) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalMembers(members)))
    .digest('hex');
}

function assertGroupContext({ conversation, authenticatedUserId, authenticatedDevice, payload }) {
  if (!conversation?.isGroup) throw new E2EEV2Error(409, 'group_e2ee_group_required');
  if (!['v2_pending', 'v2_required'].includes(conversation.e2eeState)) {
    throw new E2EEV2Error(409, 'group_e2ee_conversation_not_enabled');
  }
  const members = canonicalMembers(conversation.members);
  if (members.length < 2 || !members.includes(authenticatedUserId)) {
    throw new E2EEV2Error(403, 'group_e2ee_membership_denied');
  }
  const epoch = Number(conversation.e2eeGroupEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new E2EEV2Error(409, 'group_e2ee_epoch_not_initialized');
  }
  if (conversation.e2eeGroupMembershipHash !== groupMembershipHash(members)) {
    throw new E2EEV2Error(409, 'group_e2ee_epoch_rotation_required');
  }
  if (payload.epoch !== epoch) throw new E2EEV2Error(409, 'group_e2ee_epoch_mismatch');
  if (!isActiveV2Device(authenticatedDevice)) {
    throw new E2EEV2Error(403, 'group_e2ee_sender_device_not_capable');
  }
  if (
    payload.senderDeviceId !== authenticatedDevice.deviceId
    || payload.senderSignalDeviceId !== Number(authenticatedDevice.signalDeviceId)
    || payload.senderIdentityVersion !== Number(authenticatedDevice.identityVersion || 1)
  ) {
    throw new E2EEV2Error(403, 'group_e2ee_sender_device_mismatch');
  }
  return { epoch, members };
}

function expectedGroupRecipientDevices({ members, senderUserId, senderDeviceId, devicesByUser }) {
  const recipients = [];
  members.forEach((userId) => {
    const devices = (devicesByUser[userId] || []).filter(isActiveV2Device);
    if (devices.length === 0) {
      throw new E2EEV2Error(409, 'group_e2ee_member_missing_device');
    }
    devices.forEach((device) => {
      if (userId !== senderUserId || device.deviceId !== senderDeviceId) {
        recipients.push({ userId, deviceId: device.deviceId });
      }
    });
  });
  if (recipients.length === 0 || recipients.length > MAX_GROUP_RECIPIENT_DEVICES) {
    throw new E2EEV2Error(409, 'group_e2ee_recipient_limit');
  }
  return recipients.sort((left, right) => (
    recipientKey(left.userId, left.deviceId).localeCompare(recipientKey(right.userId, right.deviceId))
  ));
}

function assertExactGroupRecipients(envelopes, expectedRecipients) {
  const expected = new Set(expectedRecipients.map(({ userId, deviceId }) => (
    recipientKey(userId, deviceId)
  )));
  const actual = new Set(envelopes.map(envelope => (
    recipientKey(envelope.recipientUserId, envelope.recipientDeviceId)
  )));
  if (
    actual.size !== envelopes.length
    || actual.size !== expected.size
    || [...expected].some(key => !actual.has(key))
  ) {
    throw new E2EEV2Error(409, 'group_e2ee_recipient_set_mismatch');
  }
}

function authorizeGroupDistribution({
  conversation,
  authenticatedUserId,
  authenticatedDevice,
  devicesByUser,
  payload,
}) {
  const context = assertGroupContext({
    conversation,
    authenticatedUserId,
    authenticatedDevice,
    payload,
  });
  const recipients = expectedGroupRecipientDevices({
    members: context.members,
    senderUserId: authenticatedUserId,
    senderDeviceId: payload.senderDeviceId,
    devicesByUser,
  });
  assertExactGroupRecipients(payload.recipientEnvelopes, recipients);
  return { ...context, recipients };
}

function authorizeGroupMessage({
  conversation,
  authenticatedUserId,
  authenticatedDevice,
  payload,
  distribution,
}) {
  const context = assertGroupContext({
    conversation,
    authenticatedUserId,
    authenticatedDevice,
    payload,
  });
  if (
    !distribution
    || distribution.status !== 'active'
    || distribution.conversationId !== payload.conversationId
    || distribution.epoch !== payload.epoch
    || distribution.distributionId !== payload.distributionId
    || distribution.senderUserId !== authenticatedUserId
    || distribution.senderDeviceId !== payload.senderDeviceId
    || distribution.membershipHash !== conversation.e2eeGroupMembershipHash
  ) {
    throw new E2EEV2Error(409, 'group_e2ee_distribution_required');
  }
  return context;
}

module.exports = {
  assertExactGroupRecipients,
  authorizeGroupDistribution,
  authorizeGroupMessage,
  canonicalMembers,
  expectedGroupRecipientDevices,
  groupMembershipHash,
};
