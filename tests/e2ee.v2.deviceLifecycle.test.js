const { schemas, PROTOCOL, PROTOCOL_VERSION } = require('../src/e2ee/v2/contracts');
const {
  E2EEV2Error,
  createDeviceLifecycleService,
} = require('../src/e2ee/v2/deviceLifecycle');

const SERVER_TIMESTAMP = { __op: 'serverTimestamp' };
const DELETE_FIELD = { __op: 'delete' };
const BASE64_KEY = 'AQIDBA==';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function applyPatch(target, patch) {
  Object.entries(patch).forEach(([key, value]) => {
    if (value?.__op === 'serverTimestamp') target[key] = 'server-ts';
    else if (value?.__op === 'delete') delete target[key];
    else target[key] = clone(value);
  });
}

function makeDocumentRef(state, path) {
  return {
    kind: 'document',
    path,
    collection(name) {
      return makeCollectionRef(state, [...path, name]);
    },
  };
}

function makeCollectionRef(state, path) {
  return {
    kind: 'collection',
    path,
    doc(id) {
      return makeDocumentRef(state, [...path, id]);
    },
    where(field, operator, value) {
      return { kind: 'query', path, field, operator, value };
    },
  };
}

function resolveDocument(state, path) {
  if (path[0] === 'users' && path.length === 2) return state.users[path[1]];
  if (path[0] === 'conversations' && path.length === 2) return state.conversations[path[1]];
  if (path[0] === 'conversations' && path[2] === 'e2eePreKeyClaims' && path.length === 4) {
    return state.preKeyClaims[path[1]]?.[path[3]];
  }
  if (path[0] === 'users' && path[2] === 'devices' && path.length === 4) {
    return state.devices[path[1]]?.[path[3]];
  }
  if (path[0] === 'users' && path[2] === 'e2eeSecurityEvents' && path.length === 4) {
    return state.securityEvents[path[1]]?.[path[3]];
  }
  throw new Error(`Unsupported document path: ${path.join('/')}`);
}

function assignDocument(state, path, data, merge = false) {
  if (path[0] === 'conversations' && path[2] === 'e2eePreKeyClaims' && path.length === 4) {
    state.preKeyClaims[path[1]] = state.preKeyClaims[path[1]] || {};
    const target = merge ? (state.preKeyClaims[path[1]][path[3]] || {}) : {};
    applyPatch(target, data);
    state.preKeyClaims[path[1]][path[3]] = target;
    return;
  }
  if (path[0] === 'users' && path[2] === 'devices' && path.length === 4) {
    state.devices[path[1]] = state.devices[path[1]] || {};
    const target = merge ? (state.devices[path[1]][path[3]] || {}) : {};
    applyPatch(target, data);
    state.devices[path[1]][path[3]] = target;
    return;
  }
  if (path[0] === 'users' && path[2] === 'e2eeSecurityEvents' && path.length === 4) {
    state.securityEvents[path[1]] = state.securityEvents[path[1]] || {};
    const target = merge ? (state.securityEvents[path[1]][path[3]] || {}) : {};
    applyPatch(target, data);
    state.securityEvents[path[1]][path[3]] = target;
    return;
  }
  throw new Error(`Unsupported assignment path: ${path.join('/')}`);
}

function makeSnapshot(state, ref) {
  const data = resolveDocument(state, ref.path);
  return {
    id: ref.path[ref.path.length - 1],
    ref,
    exists: data !== undefined,
    data: () => clone(data),
  };
}

function makeQuerySnapshot(state, query) {
  if (
    query.path[0] !== 'users'
    || query.path[2] !== 'devices'
    || query.operator !== '=='
  ) {
    throw new Error(`Unsupported query: ${JSON.stringify(query)}`);
  }
  const uid = query.path[1];
  const docs = Object.entries(state.devices[uid] || {})
    .filter(([, device]) => device?.[query.field] === query.value)
    .map(([deviceId]) => makeSnapshot(state, makeDocumentRef(state, [...query.path, deviceId])));
  return { docs, empty: docs.length === 0 };
}

function createFakeDatabase(state) {
  return {
    collection(name) {
      return makeCollectionRef(state, [name]);
    },
    async runTransaction(callback) {
      const operations = [];
      const transaction = {
        async get(target) {
          if (target.kind === 'query') return makeQuerySnapshot(state, target);
          return makeSnapshot(state, target);
        },
        set(ref, data, options = {}) {
          operations.push({ type: 'set', ref, data, options });
        },
        update(ref, patch) {
          operations.push({ type: 'update', ref, data: patch });
        },
      };

      const result = await callback(transaction);
      operations.forEach((operation) => {
        if (operation.type === 'set') {
          assignDocument(state, operation.ref.path, operation.data, operation.options.merge);
          return;
        }
        const target = resolveDocument(state, operation.ref.path);
        if (!target) throw new Error(`Cannot update missing document: ${operation.ref.path.join('/')}`);
        applyPatch(target, operation.data);
      });
      return result;
    },
  };
}

function createFixture() {
  const state = {
    users: {
      'user-a': { uid: 'user-a' },
      'user-b': { uid: 'user-b' },
    },
    conversations: {
      'conversation-1': { members: ['user-a', 'user-b'], isGroup: false },
    },
    devices: {
      'user-a': {
        'device-requester': {
          status: 'active',
          protocol: PROTOCOL,
          protocolVersion: PROTOCOL_VERSION,
          signalDeviceId: 1,
          registrationId: 41,
          identityKey: BASE64_KEY,
          identityVersion: 1,
          signedPreKey: { keyId: 5, publicKey: BASE64_KEY, signature: BASE64_KEY },
          kyberPreKey: { keyId: 15, publicKey: BASE64_KEY, signature: BASE64_KEY },
          oneTimePreKeys: [{ keyId: 6, publicKey: BASE64_KEY }],
          oneTimePreKeyCount: 1,
        },
      },
      'user-b': {
        'device-b1': {
          status: 'active',
          protocol: PROTOCOL,
          protocolVersion: PROTOCOL_VERSION,
          signalDeviceId: 2,
          registrationId: 42,
          identityKey: BASE64_KEY,
          identityVersion: 1,
          signedPreKey: { keyId: 7, publicKey: BASE64_KEY, signature: BASE64_KEY },
          kyberPreKey: { keyId: 17, publicKey: BASE64_KEY, signature: BASE64_KEY },
          oneTimePreKeys: [
            { keyId: 8, publicKey: BASE64_KEY },
            { keyId: 9, publicKey: BASE64_KEY },
          ],
          oneTimePreKeyCount: 2,
        },
      },
    },
    securityEvents: {},
    preKeyClaims: {},
  };
  const firebaseAdmin = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => SERVER_TIMESTAMP,
        delete: () => DELETE_FIELD,
      },
      Timestamp: {
        fromDate: (date) => date.toISOString(),
      },
    },
  };
  return {
    state,
    service: createDeviceLifecycleService({
      database: createFakeDatabase(state),
      firebaseAdmin,
    }),
  };
}

function validRegistration(overrides = {}) {
  return {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    deviceId: 'device-a1',
    signalDeviceId: 3,
    deviceLabel: 'Tablet',
    platform: 'android',
    capabilities: { messageEncryption: true, hardwareBackedKeystore: true },
    registrationId: 41,
    identityKey: BASE64_KEY,
    signedPreKey: { keyId: 5, publicKey: BASE64_KEY, signature: BASE64_KEY },
    kyberPreKey: { keyId: 15, publicKey: BASE64_KEY, signature: BASE64_KEY },
    oneTimePreKeys: [{ keyId: 6, publicKey: BASE64_KEY }],
    ...overrides,
  };
}

async function expectServiceError(promise, status, code) {
  await expect(promise).rejects.toMatchObject({
    name: 'E2EEV2Error',
    status,
    code,
  });
}

describe('pulse_e2ee_v2 backend contracts', () => {
  test('accepts a strict valid registration', () => {
    expect(schemas.deviceRegistration.safeParse(validRegistration()).success).toBe(true);
  });

  test.each(['privateKey', 'sessionRecord', 'plaintext'])('rejects forbidden %s fields', (field) => {
    const result = schemas.deviceRegistration.safeParse(validRegistration({ [field]: BASE64_KEY }));
    expect(result.success).toBe(false);
  });

  test('rejects legacy protocol registration', () => {
    expect(schemas.deviceRegistration.safeParse(validRegistration({ protocol: 'signal_v1' })).success).toBe(false);
  });

  test('requires a bounded Signal device id and a Kyber prekey', () => {
    expect(schemas.deviceRegistration.safeParse(validRegistration({ signalDeviceId: 128 })).success)
      .toBe(false);
    expect(schemas.deviceRegistration.safeParse(validRegistration({ kyberPreKey: undefined })).success)
      .toBe(false);
  });

  test('rejects duplicate submitted prekey ids', () => {
    const result = schemas.deviceRegistration.safeParse(validRegistration({
      oneTimePreKeys: [
        { keyId: 6, publicKey: BASE64_KEY },
        { keyId: 6, publicKey: BASE64_KEY },
      ],
    }));
    expect(result.success).toBe(false);
  });
});

describe('pulse_e2ee_v2 device lifecycle', () => {
  test('registers a device once and treats an identical retry as idempotent', async () => {
    const { state, service } = createFixture();
    const registration = validRegistration();

    await expect(service.registerDevice('user-a', registration)).resolves.toMatchObject({
      status: 'REGISTERED',
      identityVersion: 1,
    });
    await expect(service.registerDevice('user-a', registration)).resolves.toMatchObject({
      status: 'ALREADY_REGISTERED',
      identityVersion: 1,
    });
    expect(state.devices['user-a']['device-a1']).toMatchObject({
      identityKey: BASE64_KEY,
      oneTimePreKeyCount: 1,
      protocol: PROTOCOL,
      status: 'active',
    });
  });

  test('requires the rotation endpoint for an identity change', async () => {
    const { service } = createFixture();
    await service.registerDevice('user-a', validRegistration());

    await expectServiceError(
      service.registerDevice('user-a', validRegistration({ identityKey: 'BQYHCA==' })),
      409,
      'v2_identity_change_requires_rotation',
    );
  });

  test('rejects reuse of a Signal device id by another opaque device', async () => {
    const { service } = createFixture();

    await expectServiceError(
      service.registerDevice('user-a', validRegistration({ signalDeviceId: 1 })),
      409,
      'v2_signal_device_id_conflict',
    );
  });

  test('rotates an identity, increments its version and records a security event', async () => {
    const { state, service } = createFixture();
    await service.registerDevice('user-a', validRegistration());

    const result = await service.rotateDeviceKeys('user-a', 'device-a1', {
      signalDeviceId: 3,
      registrationId: 51,
      identityKey: 'BQYHCA==',
      signedPreKey: { keyId: 15, publicKey: BASE64_KEY, signature: BASE64_KEY },
      kyberPreKey: { keyId: 25, publicKey: BASE64_KEY, signature: BASE64_KEY },
      oneTimePreKeys: [{ keyId: 16, publicKey: BASE64_KEY }],
    });

    expect(result).toMatchObject({ identityChanged: true, identityVersion: 2 });
    expect(state.devices['user-a']['device-a1']).toMatchObject({
      identityKey: 'BQYHCA==',
      identityVersion: 2,
      kyberPreKey: { keyId: 25 },
      sessionsInvalidAfter: 'server-ts',
    });
    expect(Object.values(state.securityEvents['user-a'])).toEqual([
      expect.objectContaining({
        type: 'identity_changed',
        signalDeviceId: 3,
        identityVersion: 2,
      }),
    ]);
  });

  test('refills prekeys without replacing unclaimed keys', async () => {
    const { state, service } = createFixture();
    const result = await service.refillPreKeys('user-b', 'device-b1', [
      { keyId: 10, publicKey: BASE64_KEY },
    ]);

    expect(result.oneTimePreKeyCount).toBe(3);
    expect(state.devices['user-b']['device-b1'].oneTimePreKeys.map((key) => key.keyId))
      .toEqual([8, 9, 10]);
  });

  test('rejects a refill that reuses an existing prekey id', async () => {
    const { state, service } = createFixture();

    await expectServiceError(
      service.refillPreKeys('user-b', 'device-b1', [{ keyId: 8, publicKey: BASE64_KEY }]),
      409,
      'v2_prekey_id_conflict',
    );
    expect(state.devices['user-b']['device-b1'].oneTimePreKeyCount).toBe(2);
  });

  test('revokes a device and removes all distributable prekeys', async () => {
    const { state, service } = createFixture();
    await expect(service.revokeDevice('user-b', 'device-b1')).resolves.toMatchObject({
      status: 'REVOKED',
    });

    expect(state.devices['user-b']['device-b1']).toMatchObject({
      status: 'revoked',
      oneTimePreKeys: [],
      oneTimePreKeyCount: 0,
      sessionsInvalidAfter: 'server-ts',
    });
    expect(state.devices['user-b']['device-b1'].signedPreKey).toBeUndefined();
    expect(Object.values(state.securityEvents['user-b'])).toEqual([
      expect.objectContaining({ type: 'device_revoked', signalDeviceId: 2 }),
    ]);
  });
});

describe('pulse_e2ee_v2 transactional prekey claim', () => {
  test('claims and consumes exactly one prekey per active recipient device', async () => {
    const { state, service } = createFixture();
    const claim = await service.claimKeyBundles({
      requesterId: 'user-a',
      requesterDeviceId: 'device-requester',
      claimId: '123e4567-e89b-42d3-a456-426614174000',
      conversationId: 'conversation-1',
      recipientId: 'user-b',
    });

    expect(claim).toMatchObject({
      protocol: PROTOCOL,
      protocolVersion: PROTOCOL_VERSION,
      recipientUserId: 'user-b',
      devices: [expect.objectContaining({
        deviceId: 'device-b1',
        oneTimePreKey: { keyId: 8, publicKey: BASE64_KEY },
      })],
    });
    expect(state.devices['user-b']['device-b1'].oneTimePreKeys)
      .toEqual([{ keyId: 9, publicKey: BASE64_KEY }]);
    expect(state.devices['user-b']['device-b1'].oneTimePreKeyCount).toBe(1);
  });

  test('returns an identical claim retry without consuming another prekey', async () => {
    const { state, service } = createFixture();
    const request = {
      requesterId: 'user-a',
      requesterDeviceId: 'device-requester',
      claimId: '123e4567-e89b-42d3-a456-426614174000',
      conversationId: 'conversation-1',
      recipientId: 'user-b',
    };

    const first = await service.claimKeyBundles(request);
    const retry = await service.claimKeyBundles(request);

    expect(retry).toEqual(first);
    expect(state.devices['user-b']['device-b1'].oneTimePreKeys)
      .toEqual([{ keyId: 9, publicKey: BASE64_KEY }]);
  });

  test('claims only sibling-device prekeys for the authenticated users own devices', async () => {
    const { state, service } = createFixture();
    state.devices['user-a']['device-sibling'] = {
      ...clone(state.devices['user-a']['device-requester']),
      registrationId: 44,
      oneTimePreKeys: [
        { keyId: 12, publicKey: BASE64_KEY },
        { keyId: 13, publicKey: BASE64_KEY },
      ],
      oneTimePreKeyCount: 2,
    };

    const claim = await service.claimKeyBundles({
      requesterId: 'user-a',
      requesterDeviceId: 'device-requester',
      claimId: '123e4567-e89b-42d3-a456-426614174001',
      conversationId: 'conversation-1',
      recipientId: 'user-a',
      allowOwnDevices: true,
    });

    expect(claim.recipientUserId).toBe('user-a');
    expect(claim.devices).toEqual([
      expect.objectContaining({
        deviceId: 'device-sibling',
        oneTimePreKey: { keyId: 12, publicKey: BASE64_KEY },
      }),
    ]);
    expect(state.devices['user-a']['device-requester'].oneTimePreKeyCount).toBe(1);
    expect(state.devices['user-a']['device-sibling'].oneTimePreKeyCount).toBe(1);
  });

  test('does not consume any prekey when one active device has no stock', async () => {
    const { state, service } = createFixture();
    state.devices['user-b']['device-b2'] = {
      ...clone(state.devices['user-b']['device-b1']),
      oneTimePreKeys: [],
      oneTimePreKeyCount: 0,
    };

    await expectServiceError(
      service.claimKeyBundles({
        requesterId: 'user-a',
        requesterDeviceId: 'device-requester',
        claimId: '123e4567-e89b-42d3-a456-426614174000',
        conversationId: 'conversation-1',
        recipientId: 'user-b',
      }),
      409,
      'v2_prekeys_unavailable',
    );
    expect(state.devices['user-b']['device-b1'].oneTimePreKeys.map((key) => key.keyId))
      .toEqual([8, 9]);
  });

  test('does not consume prekeys when parent or user policy blocks the contact', async () => {
    const { state, service } = createFixture();
    state.users['user-b'].blockedByParent = ['user-a'];

    await expectServiceError(
      service.claimKeyBundles({
        requesterId: 'user-a',
        requesterDeviceId: 'device-requester',
        claimId: '123e4567-e89b-42d3-a456-426614174000',
        conversationId: 'conversation-1',
        recipientId: 'user-b',
      }),
      403,
      'v2_policy_denied',
    );
    expect(state.devices['user-b']['device-b1'].oneTimePreKeyCount).toBe(2);
  });

  test('ignores legacy active devices while claiming every active v2 device', async () => {
    const { state, service } = createFixture();
    state.devices['user-b']['legacy-device'] = {
      status: 'active',
      protocol: 'signal_v1',
      protocolVersion: 1,
      oneTimePreKeys: [{ keyId: 99, publicKey: BASE64_KEY }],
    };

    const claim = await service.claimKeyBundles({
      requesterId: 'user-a',
      requesterDeviceId: 'device-requester',
      claimId: '123e4567-e89b-42d3-a456-426614174000',
      conversationId: 'conversation-1',
      recipientId: 'user-b',
    });

    expect(claim.devices.map((device) => device.deviceId)).toEqual(['device-b1']);
    expect(state.devices['user-b']['device-b1'].oneTimePreKeyCount).toBe(1);
    expect(state.devices['user-b']['legacy-device'].oneTimePreKeys).toEqual([
      { keyId: 99, publicKey: BASE64_KEY },
    ]);
  });

  test('rejects a claim when the recipient has no active v2 devices', async () => {
    const { state, service } = createFixture();
    state.devices['user-b']['device-b1'].protocol = 'signal_v1';
    state.devices['user-b']['device-b1'].protocolVersion = 1;

    await expectServiceError(service.claimKeyBundles({
      requesterId: 'user-a',
      requesterDeviceId: 'device-requester',
      claimId: '123e4567-e89b-42d3-a456-426614174000',
      conversationId: 'conversation-1',
      recipientId: 'user-b',
    }), 409, 'v2_no_active_recipient_devices');
  });

  test('rejects group and unrelated conversation claims', async () => {
    const { state, service } = createFixture();
    state.conversations['conversation-1'].isGroup = true;

    await expectServiceError(
      service.claimKeyBundles({
        requesterId: 'user-a',
        requesterDeviceId: 'device-requester',
        claimId: '123e4567-e89b-42d3-a456-426614174000',
        conversationId: 'conversation-1',
        recipientId: 'user-b',
      }),
      403,
      'v2_direct_conversation_required',
    );
  });
});

test('service errors retain stable status and code', () => {
  expect(new E2EEV2Error(409, 'example')).toMatchObject({
    name: 'E2EEV2Error',
    status: 409,
    code: 'example',
  });
});
