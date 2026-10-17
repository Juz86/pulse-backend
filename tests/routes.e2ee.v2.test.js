const express = require('express');
const request = require('supertest');

const mockLifecycleService = {
  claimKeyBundles: jest.fn(),
  refillPreKeys: jest.fn(),
  registerDevice: jest.fn(),
  revokeDevice: jest.fn(),
  rotateDeviceKeys: jest.fn(),
};
const mockMessageService = {
  getEnvelope: jest.fn(),
  sendMessage: jest.fn(),
};
const mockIoEmit = jest.fn();
const mockIoTo = jest.fn(() => ({ emit: mockIoEmit }));

jest.mock('../src/firebase', () => ({
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'server-ts',
        delete: () => ({ __op: 'delete' }),
      },
    },
  },
  db: {
    collection(name) {
      if (name === 'conversations') {
        return {
          where: () => ({ get: async () => ({ docs: [] }) }),
        };
      }
      if (name === 'users') {
        return {
          doc: () => ({
            collection: () => ({ get: async () => ({ docs: [] }) }),
          }),
        };
      }
      throw new Error(`Unsupported collection ${name}`);
    },
  },
}));

jest.mock('../src/middleware', () => ({
  verifyAuth: (req, _res, next) => {
    req.uid = req.headers['x-test-uid'] || 'user-a';
    next();
  },
}));

jest.mock('../src/state', () => ({ onlineUsers: {} }));

jest.mock('../src/e2ee/v2/deviceLifecycle', () => {
  class MockE2EEV2Error extends Error {
    constructor(status, code) {
      super(code);
      this.status = status;
      this.code = code;
    }
  }
  return {
    E2EEV2Error: MockE2EEV2Error,
    createDeviceLifecycleService: () => mockLifecycleService,
  };
});

jest.mock('../src/e2ee/v2/messageDelivery', () => ({
  createMessageDeliveryService: () => mockMessageService,
}));

const { E2EEV2Error } = require('../src/e2ee/v2/deviceLifecycle');
const { registerE2EEV2Routes } = require('../src/e2ee/v2/routes');

const BASE64_KEY = 'AQIDBA==';

function validRegistration(overrides = {}) {
  return {
    protocol: 'pulse_e2ee_v2',
    protocolVersion: 2,
    deviceId: 'device-a1',
    signalDeviceId: 3,
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

function buildApp() {
  const app = express();
  const router = express.Router();
  app.use(express.json());
  registerE2EEV2Routes(router, {
    to: mockIoTo,
  });
  app.use(router);
  return app;
}

describe('pulse_e2ee_v2 routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.E2EE_V2_ENABLED = 'true';
    delete process.env.E2EE_V2_WEB_PROVIDER_ENABLED;
    mockLifecycleService.registerDevice.mockResolvedValue({
      status: 'REGISTERED',
      deviceId: 'device-a1',
      identityVersion: 1,
    });
    mockLifecycleService.claimKeyBundles.mockResolvedValue({
      protocol: 'pulse_e2ee_v2',
      protocolVersion: 2,
      conversationId: 'conversation-1',
      recipientUserId: 'user-b',
      claimedAt: '2026-10-17T08:00:00.000Z',
      devices: [],
    });
    mockMessageService.sendMessage.mockResolvedValue({
      messageId: '123e4567-e89b-42d3-a456-426614174000',
      clientMessageId: '123e4567-e89b-42d3-a456-426614174000',
      idempotent: false,
      acceptedAt: '2026-10-17T08:00:00.000Z',
      deliveries: [{ recipientUserId: 'user-b', recipientDeviceId: 'device-b1' }],
    });
    mockMessageService.getEnvelope.mockResolvedValue({
      protocol: 'pulse_e2ee_v2',
      protocolVersion: 2,
      messageId: '123e4567-e89b-42d3-a456-426614174000',
      conversationId: 'conversation-1',
      clientMessageId: '123e4567-e89b-42d3-a456-426614174000',
      senderUserId: 'user-a',
      senderDeviceId: 'device-a1',
      senderSignalDeviceId: 1,
      senderIdentityVersion: 1,
      recipientUserId: 'user-b',
      recipientDeviceId: 'device-b1',
      messageType: 'text',
      envelopeType: 'prekey',
      ciphertext: 'ZW5jcnlwdGVk',
      createdAt: '2026-10-17T08:00:00.000Z',
    });
  });

  afterAll(() => {
    delete process.env.E2EE_V2_ENABLED;
    delete process.env.E2EE_V2_WEB_PROVIDER_ENABLED;
  });

  test('keeps every v2 route disabled unless the server gate is enabled', async () => {
    process.env.E2EE_V2_ENABLED = 'false';
    const response = await request(buildApp())
      .post('/v2/devices/register')
      .send(validRegistration());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'v2_not_enabled' });
    expect(mockLifecycleService.registerDevice).not.toHaveBeenCalled();
  });

  test('registers a valid v2 device for the authenticated user', async () => {
    const body = validRegistration();
    const response = await request(buildApp())
      .post('/v2/devices/register')
      .set('x-test-uid', 'user-a')
      .send(body);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, status: 'REGISTERED' });
    expect(mockLifecycleService.registerDevice).toHaveBeenCalledWith('user-a', body);
  });

  test('keeps web registration blocked behind its separate provider gate', async () => {
    const response = await request(buildApp())
      .post('/v2/devices/register')
      .send(validRegistration({ platform: 'web' }));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'v2_platform_not_enabled' });
    expect(mockLifecycleService.registerDevice).not.toHaveBeenCalled();
  });

  test('rejects private material before calling the device service', async () => {
    const response = await request(buildApp())
      .post('/v2/devices/register')
      .send(validRegistration({ privateKey: BASE64_KEY }));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('v2_contract_invalid');
    expect(mockLifecycleService.registerDevice).not.toHaveBeenCalled();
  });

  test('rejects the legacy protocol before calling the device service', async () => {
    const response = await request(buildApp())
      .post('/v2/devices/register')
      .send(validRegistration({ protocol: 'signal_v1', protocolVersion: 1 }));

    expect(response.status).toBe(400);
    expect(mockLifecycleService.registerDevice).not.toHaveBeenCalled();
  });

  test('claims key bundles for an authenticated direct-conversation member', async () => {
    const response = await request(buildApp())
      .post('/v2/conversations/conversation-1/users/user-b/key-bundles/claim')
      .set('x-test-uid', 'user-a')
      .send({
        protocol: 'pulse_e2ee_v2',
        protocolVersion: 2,
        requesterDeviceId: 'device-a1',
        claimId: '123e4567-e89b-42d3-a456-426614174000',
      });

    expect(response.status).toBe(200);
    expect(mockLifecycleService.claimKeyBundles).toHaveBeenCalledWith({
      requesterId: 'user-a',
      requesterDeviceId: 'device-a1',
      claimId: '123e4567-e89b-42d3-a456-426614174000',
      conversationId: 'conversation-1',
      recipientId: 'user-b',
    });
  });

  test('claims key bundles only for the authenticated users other devices', async () => {
    const response = await request(buildApp())
      .post('/v2/conversations/conversation-1/own-device-key-bundles/claim')
      .set('x-test-uid', 'user-a')
      .send({
        protocol: 'pulse_e2ee_v2',
        protocolVersion: 2,
        requesterDeviceId: 'device-a1',
        claimId: '123e4567-e89b-42d3-a456-426614174001',
      });

    expect(response.status).toBe(200);
    expect(mockLifecycleService.claimKeyBundles).toHaveBeenCalledWith({
      requesterId: 'user-a',
      requesterDeviceId: 'device-a1',
      claimId: '123e4567-e89b-42d3-a456-426614174001',
      conversationId: 'conversation-1',
      recipientId: 'user-a',
      allowOwnDevices: true,
    });
  });

  test('returns stable service error codes', async () => {
    mockLifecycleService.claimKeyBundles.mockRejectedValue(
      new E2EEV2Error(409, 'v2_prekeys_unavailable'),
    );

    const response = await request(buildApp())
      .post('/v2/conversations/conversation-1/users/user-b/key-bundles/claim')
      .send({
        protocol: 'pulse_e2ee_v2',
        protocolVersion: 2,
        requesterDeviceId: 'device-a1',
        claimId: '123e4567-e89b-42d3-a456-426614174000',
      });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'v2_prekeys_unavailable' });
  });

  test('stores a v2 message and emits only a contentless device-room signal', async () => {
    const body = {
      protocol: 'pulse_e2ee_v2',
      protocolVersion: 2,
      conversationId: 'conversation-1',
      clientMessageId: '123e4567-e89b-42d3-a456-426614174000',
      senderDeviceId: 'device-a1',
      messageType: 'text',
      recipientEnvelopes: [{
        recipientUserId: 'user-b',
        recipientDeviceId: 'device-b1',
        envelopeType: 'prekey',
        ciphertext: 'ZW5jcnlwdGVk',
      }],
    };
    const response = await request(buildApp())
      .post('/v2/messages/send')
      .set('x-test-uid', 'user-a')
      .send(body);

    expect(response.status).toBe(201);
    expect(mockMessageService.sendMessage).toHaveBeenCalledWith('user-a', body);
    expect(mockIoTo).toHaveBeenCalledWith('e2ee:v2:device:dXNlci1iAGRldmljZS1iMQ');
    expect(mockIoEmit).toHaveBeenCalledWith('e2ee:v2:message-available', {
      protocol: 'pulse_e2ee_v2',
      protocolVersion: 2,
      conversationId: 'conversation-1',
      messageId: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(JSON.stringify(mockIoEmit.mock.calls)).not.toContain('ZW5jcnlwdGVk');
  });

  test('does not emit a second realtime signal for an idempotent retry', async () => {
    mockMessageService.sendMessage.mockResolvedValueOnce({
      messageId: '123e4567-e89b-42d3-a456-426614174000',
      clientMessageId: '123e4567-e89b-42d3-a456-426614174000',
      idempotent: true,
      deliveries: [],
    });
    const response = await request(buildApp()).post('/v2/messages/send').send({
      protocol: 'pulse_e2ee_v2',
      protocolVersion: 2,
      conversationId: 'conversation-1',
      clientMessageId: '123e4567-e89b-42d3-a456-426614174000',
      senderDeviceId: 'device-a1',
      messageType: 'text',
      recipientEnvelopes: [{
        recipientUserId: 'user-b',
        recipientDeviceId: 'device-b1',
        envelopeType: 'message',
        ciphertext: 'ZW5jcnlwdGVk',
      }],
    });

    expect(response.status).toBe(200);
    expect(response.body.idempotent).toBe(true);
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  test('returns only the envelope requested for an authenticated device', async () => {
    const response = await request(buildApp())
      .get('/v2/conversations/conversation-1/messages/message-1/envelope?deviceId=device-b1')
      .set('x-test-uid', 'user-b');

    expect(response.status).toBe(200);
    expect(mockMessageService.getEnvelope).toHaveBeenCalledWith({
      userId: 'user-b',
      deviceId: 'device-b1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
    });
    expect(response.body.recipientDeviceId).toBe('device-b1');
  });
});
