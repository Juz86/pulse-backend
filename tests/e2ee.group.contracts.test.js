const { schemas } = require('../src/e2ee/group/contracts');
const { isGroupE2eeEnabled } = require('../src/e2ee/group/config');

const envelope = (recipientUserId, recipientDeviceId) => ({
  recipientUserId,
  recipientDeviceId,
  envelopeType: 'message',
  ciphertext: 'Y2lwaGVydGV4dA==',
});

const distribution = () => ({
  protocol: 'pulse_group_e2ee_v1',
  protocolVersion: 1,
  conversationId: 'group-123',
  senderDeviceId: 'device-a',
  senderSignalDeviceId: 1,
  senderIdentityVersion: 1,
  epoch: 2,
  distributionId: 'bc263346-f24c-4550-8484-6ef56dd301a6',
  recipientEnvelopes: [envelope('user-b', 'device-b')],
});

test('group distribution accepts the exact strict wire contract', () => {
  expect(schemas.senderKeyDistribution.safeParse(distribution()).success).toBe(true);
});

test('group distribution rejects duplicate devices and plaintext fields', () => {
  const duplicate = distribution();
  duplicate.recipientEnvelopes.push(envelope('user-b', 'device-b'));
  expect(schemas.senderKeyDistribution.safeParse(duplicate).success).toBe(false);
  expect(schemas.senderKeyDistribution.safeParse({ ...distribution(), text: 'plaintext' }).success)
    .toBe(false);
});

test('group message accepts ciphertext without recipient envelopes', () => {
  const result = schemas.groupMessage.safeParse({
    protocol: 'pulse_group_e2ee_v1',
    protocolVersion: 1,
    conversationId: 'group-123',
    clientMessageId: 'ae2b6374-03cb-44ad-97ef-74e5be2651ca',
    senderDeviceId: 'device-a',
    senderSignalDeviceId: 1,
    senderIdentityVersion: 1,
    epoch: 2,
    distributionId: 'bc263346-f24c-4550-8484-6ef56dd301a6',
    messageType: 'text',
    ciphertext: 'Y2lwaGVydGV4dA==',
  });
  expect(result.success).toBe(true);
});

test('group E2EE runtime gate is disabled unless explicitly enabled', () => {
  expect(isGroupE2eeEnabled({})).toBe(false);
  expect(isGroupE2eeEnabled({ E2EE_V2_GROUPS_ENABLED: 'false' })).toBe(false);
  expect(isGroupE2eeEnabled({ E2EE_V2_GROUPS_ENABLED: 'true' })).toBe(true);
});
