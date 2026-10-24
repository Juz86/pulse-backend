const { createGroupDistributionDeliveryService } = require('../src/e2ee/group/distributionDelivery');
const { createGroupMessageDeliveryService } = require('../src/e2ee/group/messageDelivery');
const { groupMembershipHash } = require('../src/e2ee/group/policy');

const DISTRIBUTION_ID = 'bc263346-f24c-4550-8484-6ef56dd301a6';
const MESSAGE_ID = 'ae2b6374-03cb-44ad-97ef-74e5be2651ca';

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const pathKey = path => path.join('/');

function snapshot(store, ref) {
  const value = store.get(pathKey(ref.path));
  return { id: ref.path.at(-1), ref, exists: value !== undefined, data: () => clone(value) };
}

function querySnapshot(store, query) {
  const prefix = `${pathKey(query.path)}/`;
  const docs = [...store.entries()].filter(([key, value]) => (
    key.startsWith(prefix)
    && key.slice(prefix.length).indexOf('/') === -1
    && (
      (query.operator === '==' && value?.[query.field] === query.value)
      || (
        query.operator === 'array-contains'
        && Array.isArray(value?.[query.field])
        && value[query.field].some(item => JSON.stringify(item) === JSON.stringify(query.value))
      )
    )
  )).map(([key]) => documentRef(store, key.split('/'))).map(ref => snapshot(store, ref));
  return { docs, empty: docs.length === 0 };
}

function documentRef(store, path) {
  return {
    kind: 'document',
    path,
    collection: name => collectionRef(store, [...path, name]),
    async get() { return snapshot(store, this); },
  };
}

function collectionRef(store, path) {
  return {
    kind: 'collection',
    path,
    doc: id => documentRef(store, [...path, id]),
    where(field, operator, value) {
      const query = { kind: 'query', path, field, operator, value };
      query.get = async () => querySnapshot(store, query);
      return query;
    },
  };
}

function createDatabase(initial) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));
  return {
    store,
    collection: name => collectionRef(store, [name]),
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        get: async target => (target.kind === 'query' ? querySnapshot(store, target) : snapshot(store, target)),
        set: (ref, value) => writes.push({ type: 'set', ref, value }),
        update: (ref, value) => writes.push({ type: 'update', ref, value }),
      };
      const result = await callback(transaction);
      writes.forEach(({ type, ref, value }) => {
        const key = pathKey(ref.path);
        if (type === 'set') store.set(key, clone(value));
        else Object.assign(store.get(key), clone(value));
      });
      return result;
    },
  };
}

function activeDevice(signalDeviceId) {
  return {
    signalDeviceId,
    identityVersion: 1,
    status: 'active',
    protocol: 'pulse_e2ee_v2',
    protocolVersion: 2,
    capabilities: { messageEncryption: true },
  };
}

function distributionPayload() {
  return {
    protocol: 'pulse_group_e2ee_v1',
    protocolVersion: 1,
    conversationId: 'group-123',
    senderDeviceId: 'device-a1',
    senderSignalDeviceId: 1,
    senderIdentityVersion: 1,
    epoch: 4,
    distributionId: DISTRIBUTION_ID,
    recipientEnvelopes: [
      { recipientUserId: 'user-a', recipientDeviceId: 'device-a2', envelopeType: 'message', ciphertext: 'Y29weS1hMg==' },
      { recipientUserId: 'user-b', recipientDeviceId: 'device-b1', envelopeType: 'prekey', ciphertext: 'Y29weS1iMQ==' },
      { recipientUserId: 'user-c', recipientDeviceId: 'device-c1', envelopeType: 'prekey', ciphertext: 'Y29weS1jMQ==' },
    ],
  };
}

function messagePayload(overrides = {}) {
  return {
    protocol: 'pulse_group_e2ee_v1',
    protocolVersion: 1,
    conversationId: 'group-123',
    clientMessageId: MESSAGE_ID,
    senderDeviceId: 'device-a1',
    senderSignalDeviceId: 1,
    senderIdentityVersion: 1,
    epoch: 4,
    distributionId: DISTRIBUTION_ID,
    messageType: 'text',
    ciphertext: 'Z3JvdXAtY2lwaGVydGV4dA==',
    ...overrides,
  };
}

async function fixture() {
  const members = ['user-a', 'user-b', 'user-c'];
  const database = createDatabase({
    'conversations/group-123': {
      isGroup: true,
      members,
      e2eeState: 'v2_pending',
      e2eeGroupEpoch: 4,
      e2eeGroupMembershipHash: groupMembershipHash(members),
    },
    'users/user-a/devices/device-a1': activeDevice(1),
    'users/user-a/devices/device-a2': activeDevice(2),
    'users/user-b/devices/device-b1': activeDevice(1),
    'users/user-c/devices/device-c1': activeDevice(1),
  });
  const firebaseAdmin = { firestore: { FieldValue: { serverTimestamp: () => 'server-ts' } } };
  const distributions = createGroupDistributionDeliveryService({ database, firebaseAdmin });
  await distributions.storeDistribution('user-a', distributionPayload());
  for (const [userId, deviceId] of [
    ['user-a', 'device-a2'], ['user-b', 'device-b1'], ['user-c', 'device-c1'],
  ]) {
    await distributions.acknowledgeEnvelope({
      userId, deviceId, conversationId: 'group-123', epoch: 4, distributionId: DISTRIBUTION_ID,
    });
  }
  return {
    database,
    service: createGroupMessageDeliveryService({ database, firebaseAdmin }),
  };
}

test('stores one sender-key ciphertext with an authoritative device audience', async () => {
  const { database, service } = await fixture();
  const result = await service.sendMessage('user-a', messagePayload());
  expect(result.deliveries).toHaveLength(3);
  const stored = database.store.get(`conversations/group-123/messages/${MESSAGE_ID}`);
  expect(stored).toMatchObject({
    protocol: 'pulse_group_e2ee_v1',
    ciphertext: 'Z3JvdXAtY2lwaGVydGV4dA==',
    text: 'Versleuteld groepsbericht',
  });
  expect(stored.recipientAudiences).toHaveLength(3);
});

test('new active member device invalidates a previously ready distribution', async () => {
  const { database, service } = await fixture();
  database.store.set('users/user-b/devices/device-b2', activeDevice(2));
  await expect(service.sendMessage('user-a', messagePayload())).rejects.toMatchObject({
    status: 409,
    code: 'group_e2ee_distribution_required',
  });
});

test('recipient fetch is device-bound and the pending feed contains no ciphertext', async () => {
  const { service } = await fixture();
  await service.sendMessage('user-a', messagePayload());
  await expect(service.getMessage({
    userId: 'user-b', deviceId: 'device-b1', conversationId: 'group-123', messageId: MESSAGE_ID,
  })).resolves.toMatchObject({ ciphertext: 'Z3JvdXAtY2lwaGVydGV4dA==' });
  await expect(service.getMessage({
    userId: 'user-a', deviceId: 'device-a1', conversationId: 'group-123', messageId: MESSAGE_ID,
  })).rejects.toMatchObject({ status: 404, code: 'group_e2ee_message_not_found' });
  const feed = await service.listPending({
    userId: 'user-b', deviceId: 'device-b1', conversationId: 'group-123',
  });
  expect(feed).toEqual([{
    protocol: 'pulse_group_e2ee_v1', protocolVersion: 1,
    conversationId: 'group-123', messageId: MESSAGE_ID,
  }]);
  expect(JSON.stringify(feed)).not.toContain('Z3JvdXAtY2lwaGVydGV4dA==');
});

test('device acknowledgement removes only that device from the pending feed idempotently', async () => {
  const { service } = await fixture();
  await service.sendMessage('user-a', messagePayload());
  const identity = {
    userId: 'user-b', deviceId: 'device-b1', conversationId: 'group-123', messageId: MESSAGE_ID,
  };
  await expect(service.acknowledgeMessage(identity)).resolves.toEqual({
    messageId: MESSAGE_ID, idempotent: false,
  });
  await expect(service.acknowledgeMessage(identity)).resolves.toEqual({
    messageId: MESSAGE_ID, idempotent: true,
  });
  await expect(service.listPending(identity)).resolves.toEqual([]);
});

test('message retries are idempotent and changed ciphertext conflicts', async () => {
  const { service } = await fixture();
  await service.sendMessage('user-a', messagePayload());
  await expect(service.sendMessage('user-a', messagePayload())).resolves.toMatchObject({
    idempotent: true, deliveries: [],
  });
  await expect(service.sendMessage('user-a', messagePayload({ ciphertext: 'Y2hhbmdlZA==' })))
    .rejects.toMatchObject({ status: 409, code: 'group_e2ee_message_id_conflict' });
});
