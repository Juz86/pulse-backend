const express = require('express');
const request = require('supertest');

let mockState;

function mockMakeSnapshot(id, data, ref = null) {
  return {
    id,
    exists: data !== undefined,
    data: () => data,
    ref,
  };
}

function mockApplyPatch(target, patch) {
  Object.entries(patch).forEach(([key, value]) => {
    if (value && value.__op === 'serverTimestamp') {
      target[key] = 'ts';
      return;
    }
    target[key] = value;
  });
}

function mockMakeMessageDocRef(convId, msgId) {
  return {
    async get() {
      const message = (mockState.messages[convId] || []).find((entry) => entry.id === msgId);
      return mockMakeSnapshot(msgId, message, this);
    },
    async set(data, options = {}) {
      const list = mockState.messages[convId] || [];
      const index = list.findIndex((entry) => entry.id === msgId);
      if (index < 0) return;
      if (options.merge) mockApplyPatch(list[index], data);
      else list[index] = { ...data, id: msgId };
    },
  };
}

function mockMakeMessagesCollection(convId) {
  return {
    async add(data) {
      const id = `msg-${(mockState.messages[convId] || []).length + 1}`;
      const created = { id, ...data, createdAt: 'ts' };
      mockState.messages[convId] = mockState.messages[convId] || [];
      mockState.messages[convId].push(created);
      return { id };
    },
    doc(msgId) {
      return mockMakeMessageDocRef(convId, msgId);
    },
    async get() {
      const docs = (mockState.messages[convId] || []).map((entry) => mockMakeSnapshot(entry.id, entry));
      return { docs };
    },
    orderBy() {
      return {
        limit() {
          return {
            async get() {
              const docs = (mockState.messages[convId] || []).map((entry) => mockMakeSnapshot(entry.id, entry));
              return { docs };
            },
            where() {
              return this;
            },
          };
        },
      };
    },
    where(field, op, value) {
      if (field !== 'type' || op !== '==') throw new Error(`Unsupported message query ${field} ${op}`);
      return {
        async get() {
          const docs = (mockState.messages[convId] || [])
            .filter((entry) => entry.type === value || entry.messageType === value)
            .map((entry) => mockMakeSnapshot(entry.id, entry));
          return { docs };
        },
      };
    },
  };
}

function mockMakeConversationDocRef(convId) {
  return {
    collection(name) {
      if (name !== 'messages') throw new Error(`Unsupported subcollection ${name}`);
      return mockMakeMessagesCollection(convId);
    },
    async get() {
      return mockMakeSnapshot(convId, mockState.conversations[convId], this);
    },
    async update(patch) {
      mockApplyPatch(mockState.conversations[convId], patch);
    },
  };
}

function mockMakeDeviceDocRef(uid, deviceId) {
  return {
    async get() {
      return mockMakeSnapshot(deviceId, mockState.devices[uid]?.[deviceId], this);
    },
    async set(data) {
      mockState.devices[uid] = mockState.devices[uid] || {};
      mockState.devices[uid][deviceId] = { ...data };
    },
  };
}

jest.mock('../src/firebase', () => ({
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ __op: 'serverTimestamp' }),
      },
    },
  },
  db: {
    collection(name) {
      if (name === 'users') {
        return {
          doc(uid) {
            return {
              async get() {
                return mockMakeSnapshot(uid, mockState.users[uid], this);
              },
              async set(data, options = {}) {
                mockState.users[uid] = mockState.users[uid] || {};
                if (options.merge) mockApplyPatch(mockState.users[uid], data);
                else mockState.users[uid] = { ...data };
              },
              collection(sub) {
                if (sub !== 'devices') throw new Error(`Unsupported subcollection ${sub}`);
                return {
                  async get() {
                    const docs = Object.entries(mockState.devices[uid] || {}).map(([id, data]) => mockMakeSnapshot(id, data));
                    return { docs };
                  },
                  doc(deviceId) {
                    return mockMakeDeviceDocRef(uid, deviceId);
                  },
                };
              },
            };
          },
        };
      }

      if (name === 'conversations') {
        return {
          doc(convId) {
            return mockMakeConversationDocRef(convId);
          },
          where(field, op, value) {
            if (field !== 'members' || op !== 'array-contains') throw new Error(`Unsupported conversation query ${field} ${op}`);
            return {
              async get() {
                const docs = Object.entries(mockState.conversations)
                  .filter(([, data]) => Array.isArray(data.members) && data.members.includes(value))
                  .map(([id, data]) => mockMakeSnapshot(id, data, mockMakeConversationDocRef(id)));
                return { docs };
              },
            };
          },
        };
      }

      throw new Error(`Unsupported collection ${name}`);
    },
  },
}));

jest.mock('../src/middleware', () => ({
  verifyAuth: (req, _res, next) => {
    req.uid = req.headers['x-test-uid'] || 'user-1';
    next();
  },
}));

jest.mock('../src/state', () => ({
  onlineUsers: {
    'user-2': new Set(['socket-user-2']),
  },
}));

function buildApp() {
  const e2eeRouterFactory = require('../src/routes/e2ee');
  const app = express();
  app.use(express.json());
  app.use('/', e2eeRouterFactory({
    to: () => ({ emit: () => {} }),
  }));
  return app;
}

describe('e2ee routes', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.FIREBASE_ENABLED = 'true';
    mockState = {
      users: {
        'user-1': { uid: 'user-1', displayName: 'User One' },
        'user-2': { uid: 'user-2', displayName: 'User Two' },
      },
      devices: {
        'user-1': {
          'dev-sender': {
            identityPublicKey: 'pub-1',
            signedPreKey: { keyId: 1, publicKey: 'spk-1', signature: 'sig-1' },
            oneTimePreKeys: [{ keyId: 11, publicKey: 'otk-11' }],
            status: 'active',
          },
        },
        'user-2': {
          'dev-recipient': {
            identityPublicKey: 'pub-2',
            signedPreKey: { keyId: 2, publicKey: 'spk-2', signature: 'sig-2' },
            oneTimePreKeys: [{ keyId: 22, publicKey: 'otk-22' }],
            status: 'active',
          },
        },
      },
      conversations: {
        'conv-1': {
          members: ['user-1', 'user-2'],
          memberNames: { 'user-2': 'User Two' },
          deletedFor: [],
        },
      },
      messages: {
        'conv-1': [
          {
            id: 'msg-attachment-1',
            type: 'attachment',
            messageType: 'attachment',
            attachment: {
              name: 'foto.png',
              downloadUrl: 'http://localhost:3001/attachments/mock-2',
              transfer: 'remote',
              mimeType: 'application/pulse-e2ee-envelope+json',
              originalMimeType: 'image/png',
              contentEncoding: 'mock-e2ee-envelope-v1',
              envelopeKind: 'pulse_mock_media_envelope',
              expectedPayloadSha256: 'abcd1234',
              encryption: {
                strategyKey: '',
                mediaKeyId: 'mock-media-key-1',
                keyWrapAlg: 'pulse_mock_media_key_unwrap',
                wrappedMediaKey: 'wrapped-key-1',
                wrappedMediaKeyDigest: 'digest-1',
                envelopeKind: 'pulse_mock_media_envelope',
                originalMimeType: 'image/png',
              },
            },
            createdAt: '2026-06-21T11:00:00.000Z',
          },
        ],
      },
    };
  });

  test('GET /readyz exposes service readiness', async () => {
    const response = await request(buildApp()).get('/readyz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      service: 'pulse-e2ee',
    }));
  });

  test('GET /devices returns active devices for authenticated user', async () => {
    const response = await request(buildApp())
      .get('/devices')
      .set('x-test-uid', 'user-1');

    expect(response.status).toBe(200);
    expect(response.body.devices).toEqual([
      expect.objectContaining({ id: 'dev-sender', status: 'active' }),
    ]);
  });

  test('GET /users/:remoteUserId/key-bundle returns remote device bundle', async () => {
    const response = await request(buildApp())
      .get('/users/user-2/key-bundle')
      .set('x-test-uid', 'user-1');

    expect(response.status).toBe(200);
    expect(response.body.devices).toEqual([
      expect.objectContaining({
        deviceId: 'dev-recipient',
        identityPublicKey: 'pub-2',
        signedPreKey: expect.objectContaining({ publicKey: 'spk-2' }),
        oneTimePreKey: expect.objectContaining({ publicKey: 'otk-22' }),
      }),
    ]);
  });

  test('POST /messages/send stores encrypted service message', async () => {
    const response = await request(buildApp())
      .post('/messages/send')
      .set('x-test-uid', 'user-1')
      .send({
        conversationId: 'conv-1',
        senderDeviceId: 'dev-sender',
        ciphertext: 'Zm9v',
        messageType: 'text',
        protocol: 'signal_v1',
        protocolVersion: 1,
        recipientPayloads: [
          {
            recipientUserId: 'user-2',
            recipientDeviceId: 'dev-recipient',
            encryptedMessageKey: 'mock-key-1',
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ ok: true, messageId: expect.any(String) }));
    expect(mockState.messages['conv-1']).toEqual(expect.arrayContaining([
      expect.objectContaining({
        senderUserId: 'user-1',
        senderDeviceId: 'dev-sender',
        ciphertext: 'Zm9v',
        protocol: 'signal_v1',
        messageType: 'text',
      }),
    ]));
  });

  test('GET /messages/feed/:convId returns encrypted feed view for recipient device', async () => {
    mockState.messages['conv-1'].push({
      id: 'msg-1',
      convId: 'conv-1',
      conversationId: 'conv-1',
      senderId: 'user-1',
      senderUserId: 'user-1',
      senderDeviceId: 'dev-sender',
      ciphertext: 'Zm9v',
      protocol: 'signal_v1',
      protocolVersion: 1,
      messageType: 'text',
      recipientPayloads: [
        {
          recipientUserId: 'user-2',
          recipientDeviceId: 'dev-recipient',
          encryptedMessageKey: 'mock-key-1',
        },
      ],
      createdAt: '2026-06-21T12:00:00.000Z',
    });

    const response = await request(buildApp())
      .get('/messages/feed/conv-1?deviceId=dev-recipient')
      .set('x-test-uid', 'user-2');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'msg-attachment-1',
        type: 'attachment',
      }),
      expect.objectContaining({
        id: 'msg-1',
        senderUserId: 'user-1',
        senderDeviceId: 'dev-sender',
        encryptedMessageKey: 'mock-key-1',
        ciphertext: 'Zm9v',
        protocol: 'signal_v1',
      }),
    ]));
  });

  test('GET /api/attachments/:attachmentId/meta returns metadata and integrity headers', async () => {
    const response = await request(buildApp())
      .get('/api/attachments/mock-2/meta')
      .set('x-test-uid', 'user-2');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      messageId: 'msg-attachment-1',
      attachment: expect.objectContaining({
        name: 'foto.png',
        downloadUrl: 'http://localhost:3001/attachments/mock-2',
        expectedPayloadSha256: 'abcd1234',
      }),
    }));
    expect(response.headers['x-pulse-expected-sha256']).toBe('abcd1234');
    expect(response.headers['x-pulse-content-encoding']).toBe('mock-e2ee-envelope-v1');
    expect(response.headers['x-pulse-envelope-kind']).toBe('pulse_mock_media_envelope');
    expect(response.headers['x-pulse-original-mimetype']).toBe('image/png');
    expect(response.headers['x-pulse-media-key-id']).toBe('mock-media-key-1');
    expect(response.headers['x-pulse-key-wrap-alg']).toBe('pulse_mock_media_key_unwrap');
    expect(response.headers['x-pulse-wrapped-media-key-digest']).toBe('digest-1');
  });
});
