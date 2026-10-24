const { createGroupDistributionDeliveryService } = require('../src/e2ee/group/distributionDelivery');
const { authorizeGroupMessage, groupMembershipHash } = require('../src/e2ee/group/policy');

const SERVER_TIMESTAMP = 'server-ts';
const DISTRIBUTION_ID = 'bc263346-f24c-4550-8484-6ef56dd301a6';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pathKey(path) {
  return path.join('/');
}

function snapshot(store, ref) {
  const value = store.get(pathKey(ref.path));
  return {
    id: ref.path[ref.path.length - 1],
    ref,
    exists: value !== undefined,
    data: () => clone(value),
  };
}

function querySnapshot(store, query) {
  const prefix = `${pathKey(query.path)}/`;
  const docs = [...store.entries()]
    .filter(([key, value]) => (
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
    ))
    .map(([key]) => documentRef(store, key.split('/')))
    .map(ref => snapshot(store, ref));
  return { docs, empty: docs.length === 0 };
}

function documentRef(store, path) {
  return {
    kind: 'document',
    path,
    collection(name) {
      return collectionRef(store, [...path, name]);
    },
    async get() {
      return snapshot(store, this);
    },
  };
}

function collectionRef(store, path) {
  return {
    kind: 'collection',
    path,
    doc(id) {
      return documentRef(store, [...path, id]);
    },
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
    collection(name) {
      return collectionRef(store, [name]);
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(target) {
          return target.kind === 'query' ? querySnapshot(store, target) : snapshot(store, target);
        },
        set(ref, value) {
          writes.push({ type: 'set', ref, value });
        },
        update(ref, value) {
          writes.push({ type: 'update', ref, value });
        },
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

function fixture() {
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
  return {
    database,
    service: createGroupDistributionDeliveryService({
      database,
      firebaseAdmin: {
        firestore: { FieldValue: { serverTimestamp: () => SERVER_TIMESTAMP } },
      },
    }),
  };
}

function payload(overrides = {}) {
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
      {
        recipientUserId: 'user-a', recipientDeviceId: 'device-a2',
        envelopeType: 'message', ciphertext: 'Y29weS1hMg==',
      },
      {
        recipientUserId: 'user-b', recipientDeviceId: 'device-b1',
        envelopeType: 'prekey', ciphertext: 'Y29weS1iMQ==',
      },
      {
        recipientUserId: 'user-c', recipientDeviceId: 'device-c1',
        envelopeType: 'prekey', ciphertext: 'Y29weS1jMQ==',
      },
    ],
    ...overrides,
  };
}

const distributionPath = `conversations/group-123/e2eeGroupEpochs/4/senderKeyDistributions/${DISTRIBUTION_ID}`;

test('stores metadata without ciphertext and one envelope per recipient device', async () => {
  const { database, service } = fixture();
  const result = await service.storeDistribution('user-a', payload());
  expect(result).toMatchObject({ idempotent: false, epoch: 4, distributionId: DISTRIBUTION_ID });
  const metadata = database.store.get(distributionPath);
  expect(metadata.status).toBe('distributing');
  expect(metadata.pendingRecipientAudiences).toHaveLength(3);
  expect(metadata).not.toHaveProperty('ciphertext');
  expect(metadata).not.toHaveProperty('recipientEnvelopes');
  const envelopes = [...database.store.entries()].filter(([key]) => (
    key.startsWith(`${distributionPath}/deviceEnvelopes/`)
  ));
  expect(envelopes).toHaveLength(3);
});

test('same distribution is idempotent and changed ciphertext conflicts', async () => {
  const { service } = fixture();
  await service.storeDistribution('user-a', payload());
  await expect(service.storeDistribution('user-a', payload())).resolves.toMatchObject({
    idempotent: true,
    deliveries: [],
  });
  const changed = payload();
  changed.recipientEnvelopes[0].ciphertext = 'Y2hhbmdlZA==';
  await expect(service.storeDistribution('user-a', changed)).rejects.toMatchObject({
    status: 409,
    code: 'group_e2ee_distribution_id_conflict',
  });
});

test('recipient can fetch only its own encrypted distribution envelope', async () => {
  const { service } = fixture();
  await service.storeDistribution('user-a', payload());
  await expect(service.getEnvelope({
    userId: 'user-b',
    deviceId: 'device-b1',
    conversationId: 'group-123',
    epoch: 4,
    distributionId: DISTRIBUTION_ID,
  })).resolves.toMatchObject({
    recipientUserId: 'user-b',
    recipientDeviceId: 'device-b1',
    ciphertext: 'Y29weS1iMQ==',
  });
  await expect(service.getEnvelope({
    userId: 'user-a',
    deviceId: 'device-a1',
    conversationId: 'group-123',
    epoch: 4,
    distributionId: DISTRIBUTION_ID,
  })).rejects.toMatchObject({ status: 404, code: 'group_e2ee_distribution_not_found' });
});

test('distribution becomes ready only after every device acknowledges local receipt', async () => {
  const { database, service } = fixture();
  await service.storeDistribution('user-a', payload());
  const recipients = [
    ['user-a', 'device-a2'],
    ['user-b', 'device-b1'],
    ['user-c', 'device-c1'],
  ];
  for (const [index, [userId, deviceId]] of recipients.entries()) {
    const result = await service.acknowledgeEnvelope({
      userId,
      deviceId,
      conversationId: 'group-123',
      epoch: 4,
      distributionId: DISTRIBUTION_ID,
    });
    expect(result.ready).toBe(index === recipients.length - 1);
  }
  expect(database.store.get(distributionPath)).toMatchObject({
    status: 'ready',
    pendingRecipientAudiences: [],
  });
});

test('offline feed exposes only contentless pending distribution identifiers', async () => {
  const { service } = fixture();
  await service.storeDistribution('user-a', payload());
  const feed = await service.listPending({
    userId: 'user-b',
    deviceId: 'device-b1',
    conversationId: 'group-123',
    epoch: 4,
  });
  expect(feed).toEqual([{
    protocol: 'pulse_group_e2ee_v1',
    protocolVersion: 1,
    conversationId: 'group-123',
    epoch: 4,
    distributionId: DISTRIBUTION_ID,
  }]);
  expect(JSON.stringify(feed)).not.toContain('Y29weS1iMQ==');
});

test('group message remains blocked until distribution acknowledgements complete', async () => {
  const { database, service } = fixture();
  await service.storeDistribution('user-a', payload());
  const message = {
    conversationId: 'group-123',
    senderDeviceId: 'device-a1',
    senderSignalDeviceId: 1,
    senderIdentityVersion: 1,
    epoch: 4,
    distributionId: DISTRIBUTION_ID,
  };
  const authorize = () => authorizeGroupMessage({
    conversation: database.store.get('conversations/group-123'),
    authenticatedUserId: 'user-a',
    authenticatedDevice: { deviceId: 'device-a1', ...activeDevice(1) },
    payload: message,
    devicesByUser: {
      'user-a': [
        { deviceId: 'device-a1', ...activeDevice(1) },
        { deviceId: 'device-a2', ...activeDevice(2) },
      ],
      'user-b': [{ deviceId: 'device-b1', ...activeDevice(1) }],
      'user-c': [{ deviceId: 'device-c1', ...activeDevice(1) }],
    },
    distribution: database.store.get(distributionPath),
  });
  expect(authorize).toThrow(expect.objectContaining({ code: 'group_e2ee_distribution_required' }));
  for (const [userId, deviceId] of [
    ['user-a', 'device-a2'], ['user-b', 'device-b1'], ['user-c', 'device-c1'],
  ]) {
    await service.acknowledgeEnvelope({
      userId, deviceId, conversationId: 'group-123', epoch: 4, distributionId: DISTRIBUTION_ID,
    });
  }
  expect(authorize().epoch).toBe(4);
});
