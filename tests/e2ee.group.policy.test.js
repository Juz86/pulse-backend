const {
  authorizeGroupDistribution,
  authorizeGroupMessage,
  groupMembershipHash,
} = require('../src/e2ee/group/policy');

const device = (deviceId, signalDeviceId) => ({
  deviceId,
  signalDeviceId,
  identityVersion: 1,
  status: 'active',
  protocol: 'pulse_e2ee_v2',
  protocolVersion: 2,
  capabilities: { messageEncryption: true },
});

const members = ['user-a', 'user-b', 'user-c'];
const conversation = () => ({
  isGroup: true,
  members,
  e2eeState: 'v2_pending',
  e2eeGroupEpoch: 4,
  e2eeGroupMembershipHash: groupMembershipHash(members),
});
const devicesByUser = {
  'user-a': [device('device-a1', 1), device('device-a2', 2)],
  'user-b': [device('device-b1', 1)],
  'user-c': [device('device-c1', 1)],
};
const payload = () => ({
  conversationId: 'group-123',
  senderDeviceId: 'device-a1',
  senderSignalDeviceId: 1,
  senderIdentityVersion: 1,
  epoch: 4,
  distributionId: 'bc263346-f24c-4550-8484-6ef56dd301a6',
  recipientEnvelopes: [
    { recipientUserId: 'user-a', recipientDeviceId: 'device-a2' },
    { recipientUserId: 'user-b', recipientDeviceId: 'device-b1' },
    { recipientUserId: 'user-c', recipientDeviceId: 'device-c1' },
  ],
});

test('distribution requires exact fan-out to every other active member device', () => {
  const result = authorizeGroupDistribution({
    conversation: conversation(),
    authenticatedUserId: 'user-a',
    authenticatedDevice: devicesByUser['user-a'][0],
    devicesByUser,
    payload: payload(),
  });
  expect(result.recipients).toEqual([
    { userId: 'user-a', deviceId: 'device-a2' },
    { userId: 'user-b', deviceId: 'device-b1' },
    { userId: 'user-c', deviceId: 'device-c1' },
  ]);
});

test.each([
  ['stale epoch', value => { value.epoch = 3; }, 'group_e2ee_epoch_mismatch'],
  ['missing recipient', value => { value.recipientEnvelopes.pop(); }, 'group_e2ee_recipient_set_mismatch'],
  ['foreign recipient', value => { value.recipientEnvelopes[2].recipientDeviceId = 'foreign'; }, 'group_e2ee_recipient_set_mismatch'],
  ['sender mismatch', value => { value.senderSignalDeviceId = 2; }, 'group_e2ee_sender_device_mismatch'],
])('%s fails closed', (_label, mutate, code) => {
  const value = payload();
  mutate(value);
  expect(() => authorizeGroupDistribution({
    conversation: conversation(),
    authenticatedUserId: 'user-a',
    authenticatedDevice: devicesByUser['user-a'][0],
    devicesByUser,
    payload: value,
  })).toThrow(expect.objectContaining({ code }));
});

test('membership changes require a new epoch before distribution', () => {
  const changed = conversation();
  changed.members = [...members, 'user-d'];
  expect(() => authorizeGroupDistribution({
    conversation: changed,
    authenticatedUserId: 'user-a',
    authenticatedDevice: devicesByUser['user-a'][0],
    devicesByUser,
    payload: payload(),
  })).toThrow(expect.objectContaining({ code: 'group_e2ee_epoch_rotation_required' }));
});

test('every member needs an active v2 device', () => {
  expect(() => authorizeGroupDistribution({
    conversation: conversation(),
    authenticatedUserId: 'user-a',
    authenticatedDevice: devicesByUser['user-a'][0],
    devicesByUser: { ...devicesByUser, 'user-c': [] },
    payload: payload(),
  })).toThrow(expect.objectContaining({ code: 'group_e2ee_member_missing_device' }));
});

test('group message requires the current sender distribution and membership hash', () => {
  const value = payload();
  delete value.recipientEnvelopes;
  expect(authorizeGroupMessage({
    conversation: conversation(),
    authenticatedUserId: 'user-a',
    authenticatedDevice: devicesByUser['user-a'][0],
    payload: value,
    devicesByUser,
    distribution: {
      status: 'ready',
      pendingRecipientAudiences: [],
      conversationId: 'group-123',
      epoch: 4,
      distributionId: value.distributionId,
      senderUserId: 'user-a',
      senderDeviceId: 'device-a1',
      membershipHash: groupMembershipHash(members),
      recipientAudiences: value.recipientEnvelopes || [
        { recipientUserId: 'user-a', recipientDeviceId: 'device-a2' },
        { recipientUserId: 'user-b', recipientDeviceId: 'device-b1' },
        { recipientUserId: 'user-c', recipientDeviceId: 'device-c1' },
      ],
    },
  }).epoch).toBe(4);
});

test('group message rejects a distribution from the old membership', () => {
  const value = payload();
  delete value.recipientEnvelopes;
  expect(() => authorizeGroupMessage({
    conversation: conversation(),
    authenticatedUserId: 'user-a',
    authenticatedDevice: devicesByUser['user-a'][0],
    payload: value,
    devicesByUser,
    distribution: {
      status: 'ready',
      pendingRecipientAudiences: [],
      conversationId: 'group-123',
      epoch: 4,
      distributionId: value.distributionId,
      senderUserId: 'user-a',
      senderDeviceId: 'device-a1',
      membershipHash: groupMembershipHash(['user-a', 'user-b']),
      recipientAudiences: [],
    },
  })).toThrow(expect.objectContaining({ code: 'group_e2ee_distribution_required' }));
});
