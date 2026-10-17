const { PROTOCOL, PROTOCOL_VERSION, schemas } = require('../src/e2ee/v2/contracts');
const { createMessageDeliveryService } = require('../src/e2ee/v2/messageDelivery');

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const SERVER_TIMESTAMP = 'server-ts';
const DELETE_FIELD = { __delete: true };

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pathKey(path) {
  return path.join('/');
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
      return { kind: 'query', path, field, operator, value };
    },
  };
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
      && query.operator === '=='
      && value?.[query.field] === query.value
    ))
    .map(([key]) => documentRef(store, key.split('/')))
    .map((ref) => snapshot(store, ref));
  return { docs, empty: docs.length === 0 };
}

function applyPatch(target, patch) {
  Object.entries(patch).forEach(([key, value]) => {
    if (value?.__delete) delete target[key];
    else target[key] = clone(value);
  });
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
        else {
          const current = store.get(key);
          if (!current) throw new Error(`Missing document ${key}`);
          applyPatch(current, value);
        }
      });
      return result;
    },
  };
}

function activeDevice(overrides = {}) {
  return {
    status: 'active',
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    platform: 'android',
    capabilities: { messageEncryption: true, hardwareBackedKeystore: true },
    ...overrides,
  };
}

function fixture() {
  const database = createDatabase({
    'users/user-a': { uid: 'user-a' },
    'users/user-b': { uid: 'user-b' },
    'users/user-a/devices/device-a1': activeDevice({ signalDeviceId: 1 }),
    'users/user-a/devices/device-a2': activeDevice({ signalDeviceId: 2 }),
    'users/user-b/devices/device-b1': activeDevice({ signalDeviceId: 3 }),
    'conversations/conversation-1': {
      members: ['user-a', 'user-b'],
      isGroup: false,
      e2eeState: 'v2_pending',
    },
  });
  const firebaseAdmin = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => SERVER_TIMESTAMP,
        delete: () => DELETE_FIELD,
      },
    },
  };
  return {
    database,
    service: createMessageDeliveryService({ database, firebaseAdmin }),
  };
}

function validMessage(overrides = {}) {
  return {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    conversationId: 'conversation-1',
    clientMessageId: UUID,
    senderDeviceId: 'device-a1',
    messageType: 'text',
    recipientEnvelopes: [
      {
        recipientUserId: 'user-a',
        recipientDeviceId: 'device-a2',
        envelopeType: 'message',
        ciphertext: 'c2VuZGVyLWNvcHk=',
      },
      {
        recipientUserId: 'user-b',
        recipientDeviceId: 'device-b1',
        envelopeType: 'prekey',
        ciphertext: 'cmVjaXBpZW50LWNvcHk=',
      },
    ],
    ...overrides,
  };
}

async function expectError(promise, status, code) {
  await expect(promise).rejects.toMatchObject({ status, code });
}

describe('pulse_e2ee_v2 message contract', () => {
  test('accepts the strict per-device message shape', () => {
    expect(schemas.messageSend.safeParse(validMessage()).success).toBe(true);
  });

  test('rejects plaintext and duplicate device recipients', () => {
    expect(schemas.messageSend.safeParse({ ...validMessage(), text: 'geheim' }).success).toBe(false);
    const envelope = validMessage().recipientEnvelopes[0];
    const result = schemas.messageSend.safeParse({
      ...validMessage(),
      recipientEnvelopes: [envelope, envelope],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toBe('duplicate_recipient');
  });

  test('rejects ciphertext larger than 256 KiB after base64 decoding', () => {
    const oversized = Buffer.alloc((256 * 1024) + 1).toString('base64');
    const message = validMessage();
    message.recipientEnvelopes[0].ciphertext = oversized;
    const result = schemas.messageSend.safeParse(message);
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message === 'ciphertext_too_large')).toBe(true);
  });
});

describe('pulse_e2ee_v2 per-device storage', () => {
  test('stores metadata separately and one ciphertext envelope per target device', async () => {
    const { database, service } = fixture();
    const result = await service.sendMessage('user-a', validMessage());

    expect(result).toMatchObject({ messageId: UUID, idempotent: false });
    expect(result.deliveries).toEqual(expect.arrayContaining([
      { recipientUserId: 'user-a', recipientDeviceId: 'device-a2' },
      { recipientUserId: 'user-b', recipientDeviceId: 'device-b1' },
    ]));

    const metadata = database.store.get(`conversations/conversation-1/messages/${UUID}`);
    expect(metadata).not.toHaveProperty('ciphertext');
    expect(metadata).not.toHaveProperty('recipientEnvelopes');
    expect(metadata.senderSignalDeviceId).toBe(1);
    expect(metadata.senderIdentityVersion).toBe(1);
    const envelopeDocuments = [...database.store.entries()].filter(([key]) => (
      key.startsWith(`conversations/conversation-1/messages/${UUID}/deviceEnvelopes/`)
    ));
    expect(envelopeDocuments).toHaveLength(2);
    expect(envelopeDocuments.map(([, value]) => value.ciphertext)).toEqual(expect.arrayContaining([
      'c2VuZGVyLWNvcHk=',
      'cmVjaXBpZW50LWNvcHk=',
    ]));
  });

  test('requires the exact authoritative active-device recipient set', async () => {
    const { service } = fixture();
    await expectError(service.sendMessage('user-a', validMessage({
      recipientEnvelopes: [validMessage().recipientEnvelopes[1]],
    })), 409, 'v2_recipient_set_mismatch');
  });

  test('rejects a v2 send before the conversation enters a v2 state', async () => {
    const { database, service } = fixture();
    database.store.get('conversations/conversation-1').e2eeState = 'legacy';
    await expectError(service.sendMessage('user-a', validMessage()), 409, 'v2_conversation_not_enabled');
  });

  test('treats the same client message id as an idempotent retry without new delivery', async () => {
    const { database, service } = fixture();
    await service.sendMessage('user-a', validMessage());
    const countBefore = database.store.size;
    const retry = await service.sendMessage('user-a', validMessage());

    expect(retry).toMatchObject({ messageId: UUID, idempotent: true, deliveries: [] });
    expect(database.store.size).toBe(countBefore);
  });

  test('rejects reuse of a client message id with different encrypted content', async () => {
    const { service } = fixture();
    await service.sendMessage('user-a', validMessage());
    const changed = validMessage();
    changed.recipientEnvelopes[1].ciphertext = 'YW5kZXJlLWluaG91ZA==';
    await expectError(service.sendMessage('user-a', changed), 409, 'v2_message_id_conflict');
  });

  test('rejects fan-out while any active target device is not v2 capable', async () => {
    const { database, service } = fixture();
    database.store.get('users/user-b/devices/device-b1').protocol = 'signal_v1';
    await expectError(service.sendMessage('user-a', validMessage()), 409, 'v2_recipient_device_not_capable');
  });

  test('returns only the authenticated recipient device envelope', async () => {
    const { service } = fixture();
    await service.sendMessage('user-a', validMessage());

    const envelope = await service.getEnvelope({
      userId: 'user-b',
      deviceId: 'device-b1',
      conversationId: 'conversation-1',
      messageId: UUID,
    });
    expect(envelope).toMatchObject({
      recipientUserId: 'user-b',
      recipientDeviceId: 'device-b1',
      senderSignalDeviceId: 1,
      senderIdentityVersion: 1,
      ciphertext: 'cmVjaXBpZW50LWNvcHk=',
    });
    await expectError(service.getEnvelope({
      userId: 'user-a',
      deviceId: 'device-a1',
      conversationId: 'conversation-1',
      messageId: UUID,
    }), 404, 'v2_envelope_not_found');
  });
});
