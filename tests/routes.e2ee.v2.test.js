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
  acknowledgeMessage: jest.fn(),
  getEnvelope: jest.fn(),
  listMessageFeed: jest.fn(),
  sendMessage: jest.fn(),
};
const mockGroupDistributionService = {
  acknowledgeEnvelope: jest.fn(),
  getEnvelope: jest.fn(),
  listPending: jest.fn(),
  storeDistribution: jest.fn(),
};
const mockGroupMessageService = {
  acknowledgeMessage: jest.fn(),
  getMessage: jest.fn(),
  listPending: jest.fn(),
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
jest.mock('../src/e2ee/group/distributionDelivery', () => ({
  createGroupDistributionDeliveryService: () => mockGroupDistributionService,
}));
jest.mock('../src/e2ee/group/messageDelivery', () => ({
  createGroupMessageDeliveryService: () => mockGroupMessageService,
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
    delete process.env.E2EE_V2_PILOT_USER_IDS;
    delete process.env.E2EE_V2_PILOT_CONVERSATION_IDS;
    delete process.env.E2EE_V2_REVIEW_ATTESTATION_SHA256;
    delete process.env.E2EE_V2_REVIEW_FRONTEND_COMMIT;
    delete process.env.E2EE_V2_REVIEW_BACKEND_COMMIT;
    delete process.env.PULSE_RELEASE_COMMIT_SHA;
    delete process.env.E2EE_V2_PILOT_SEND_ENABLED;
    process.env.E2EE_V2_ENABLED = 'true';
    process.env.E2EE_V2_ROLLOUT_MODE = 'qa';
    process.env.E2EE_V2_QA_MODE_ACKNOWLEDGED = 'true';
    delete process.env.E2EE_V2_WEB_PROVIDER_ENABLED;
    delete process.env.E2EE_V2_GROUPS_ENABLED;
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
    mockMessageService.listMessageFeed.mockResolvedValue([{
      protocol: 'pulse_e2ee_v2',
      protocolVersion: 2,
      conversationId: 'conversation-1',
      messageId: 'message-1',
      createdAt: '2026-10-17T08:00:00.000Z',
    }]);
    mockMessageService.acknowledgeMessage.mockResolvedValue({
      messageId: 'message-1',
      idempotent: false,
    });
    mockGroupDistributionService.storeDistribution.mockResolvedValue({
      distributionId: 'bc263346-f24c-4550-8484-6ef56dd301a6',
      epoch: 4,
      idempotent: false,
      deliveries: [{ recipientUserId: 'user-b', recipientDeviceId: 'device-b1' }],
    });
    mockGroupMessageService.sendMessage.mockResolvedValue({
      messageId: '123e4567-e89b-42d3-a456-426614174001',
      clientMessageId: '123e4567-e89b-42d3-a456-426614174001',
      idempotent: false,
      deliveries: [{ recipientUserId: 'user-b', recipientDeviceId: 'device-b1' }],
    });
    mockGroupMessageService.listPending.mockResolvedValue([{
      protocol: 'pulse_group_e2ee_v1',
      protocolVersion: 1,
      conversationId: 'group-123',
      messageId: '123e4567-e89b-42d3-a456-426614174001',
    }]);
    mockGroupMessageService.getMessage.mockResolvedValue({
      protocol: 'pulse_group_e2ee_v1',
      protocolVersion: 1,
      conversationId: 'group-123',
      messageId: '123e4567-e89b-42d3-a456-426614174001',
      ciphertext: 'Y2lwaGVydGV4dA==',
    });
    mockGroupMessageService.acknowledgeMessage.mockResolvedValue({
      messageId: '123e4567-e89b-42d3-a456-426614174001',
      idempotent: false,
    });
  });

  afterAll(() => {
    delete process.env.E2EE_V2_ENABLED;
    delete process.env.E2EE_V2_ROLLOUT_MODE;
    delete process.env.E2EE_V2_QA_MODE_ACKNOWLEDGED;
    delete process.env.E2EE_V2_WEB_PROVIDER_ENABLED;
    delete process.env.E2EE_V2_GROUPS_ENABLED;
    delete process.env.E2EE_V2_PILOT_USER_IDS;
    delete process.env.E2EE_V2_PILOT_CONVERSATION_IDS;
    delete process.env.E2EE_V2_REVIEW_ATTESTATION_SHA256;
    delete process.env.E2EE_V2_REVIEW_FRONTEND_COMMIT;
    delete process.env.E2EE_V2_REVIEW_BACKEND_COMMIT;
    delete process.env.PULSE_RELEASE_COMMIT_SHA;
    delete process.env.E2EE_V2_PILOT_SEND_ENABLED;
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

  test('keeps group distribution routes disabled behind their own gate', async () => {
    const response = await request(buildApp())
      .post('/v2/groups/sender-key-distributions')
      .send({});

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'group_e2ee_not_enabled' });
    expect(mockGroupDistributionService.storeDistribution).not.toHaveBeenCalled();
  });

  test('relays only a contentless availability event for an accepted group distribution', async () => {
    process.env.E2EE_V2_GROUPS_ENABLED = 'true';
    const distribution = {
      protocol: 'pulse_group_e2ee_v1',
      protocolVersion: 1,
      conversationId: 'group-123',
      senderDeviceId: 'device-a1',
      senderSignalDeviceId: 1,
      senderIdentityVersion: 1,
      epoch: 4,
      distributionId: 'bc263346-f24c-4550-8484-6ef56dd301a6',
      recipientEnvelopes: [{
        recipientUserId: 'user-b',
        recipientDeviceId: 'device-b1',
        envelopeType: 'prekey',
        ciphertext: 'Y2lwaGVydGV4dA==',
      }],
    };
    const response = await request(buildApp())
      .post('/v2/groups/sender-key-distributions')
      .send(distribution);

    expect(response.status).toBe(201);
    expect(mockGroupDistributionService.storeDistribution).toHaveBeenCalledWith('user-a', distribution);
    expect(mockIoEmit).toHaveBeenCalledWith(
      'e2ee:group:distribution-available',
      expect.objectContaining({
        conversationId: 'group-123',
        epoch: 4,
        distributionId: distribution.distributionId,
      }),
    );
    expect(JSON.stringify(mockIoEmit.mock.calls)).not.toContain('Y2lwaGVydGV4dA==');
  });

  test('relays only a contentless availability event for an accepted group message', async () => {
    process.env.E2EE_V2_GROUPS_ENABLED = 'true';
    const message = {
      protocol: 'pulse_group_e2ee_v1',
      protocolVersion: 1,
      conversationId: 'group-123',
      senderDeviceId: 'device-a1',
      senderSignalDeviceId: 1,
      senderIdentityVersion: 1,
      epoch: 4,
      distributionId: 'bc263346-f24c-4550-8484-6ef56dd301a6',
      clientMessageId: '123e4567-e89b-42d3-a456-426614174001',
      messageType: 'text',
      ciphertext: 'Y2lwaGVydGV4dA==',
    };
    const response = await request(buildApp())
      .post('/v2/groups/messages/send')
      .send(message);

    expect(response.status).toBe(201);
    expect(mockGroupMessageService.sendMessage).toHaveBeenCalledWith('user-a', message);
    expect(mockIoEmit).toHaveBeenCalledWith(
      'e2ee:group:message-available',
      expect.objectContaining({
        conversationId: 'group-123',
        messageId: message.clientMessageId,
      }),
    );
    expect(JSON.stringify(mockIoEmit.mock.calls)).not.toContain('Y2lwaGVydGV4dA==');
  });

  test('keeps QA mode disabled without explicit acknowledgement', async () => {
    delete process.env.E2EE_V2_QA_MODE_ACKNOWLEDGED;
    const response = await request(buildApp())
      .post('/v2/devices/register')
      .send(validRegistration());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'v2_qa_not_acknowledged' });
    expect(mockLifecycleService.registerDevice).not.toHaveBeenCalled();
  });

  test('exposes pilot enrollment without exposing allowlists or review pins', async () => {
    const response = await request(buildApp())
      .get('/v2/pilot/status')
      .set('x-test-uid', 'user-a');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      enabled: true, enrolled: true, mode: 'qa', sendingEnabled: true,
    });
    expect(JSON.stringify(response.body)).not.toContain('user-a');
  });

  test('blocks users and conversations outside the production pilot allowlists', async () => {
    process.env.E2EE_V2_ROLLOUT_MODE = 'pilot';
    process.env.E2EE_V2_PILOT_USER_IDS = 'user-a,user-b';
    process.env.E2EE_V2_PILOT_CONVERSATION_IDS = 'conversation-1';
    process.env.E2EE_V2_REVIEW_ATTESTATION_SHA256 = 'a'.repeat(64);
    process.env.E2EE_V2_REVIEW_FRONTEND_COMMIT = 'b'.repeat(40);
    process.env.E2EE_V2_REVIEW_BACKEND_COMMIT = 'c'.repeat(40);
    process.env.PULSE_RELEASE_COMMIT_SHA = 'c'.repeat(40);

    const deniedUser = await request(buildApp())
      .get('/v2/devices')
      .set('x-test-uid', 'user-c');
    expect(deniedUser.status).toBe(403);
    expect(deniedUser.body).toEqual({ error: 'v2_pilot_user_not_allowed' });

    const deniedConversation = await request(buildApp())
      .get('/v2/conversations/conversation-2/messages?deviceId=device-a1')
      .set('x-test-uid', 'user-a');
    expect(deniedConversation.status).toBe(403);
    expect(deniedConversation.body).toEqual({ error: 'v2_pilot_conversation_not_allowed' });

    const allowedConversation = await request(buildApp())
      .get('/v2/conversations/conversation-1/messages?deviceId=device-a1')
      .set('x-test-uid', 'user-a');
    expect(allowedConversation.status).toBe(200);
  });

  test('blocks a send when any recipient account is outside the pilot cohort', async () => {
    process.env.E2EE_V2_ROLLOUT_MODE = 'pilot';
    process.env.E2EE_V2_PILOT_USER_IDS = 'user-a';
    process.env.E2EE_V2_PILOT_CONVERSATION_IDS = 'conversation-1';
    process.env.E2EE_V2_REVIEW_ATTESTATION_SHA256 = 'a'.repeat(64);
    process.env.E2EE_V2_REVIEW_FRONTEND_COMMIT = 'b'.repeat(40);
    process.env.E2EE_V2_REVIEW_BACKEND_COMMIT = 'c'.repeat(40);
    process.env.PULSE_RELEASE_COMMIT_SHA = 'c'.repeat(40);
    process.env.E2EE_V2_PILOT_SEND_ENABLED = 'true';

    const response = await request(buildApp())
      .post('/v2/messages/send')
      .set('x-test-uid', 'user-a')
      .send({
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
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'v2_pilot_user_not_allowed' });
    expect(mockMessageService.sendMessage).not.toHaveBeenCalled();
  });

  test('pauses new sends while keeping message recovery available', async () => {
    process.env.E2EE_V2_ROLLOUT_MODE = 'pilot';
    process.env.E2EE_V2_PILOT_USER_IDS = 'user-a,user-b';
    process.env.E2EE_V2_PILOT_CONVERSATION_IDS = 'conversation-1';
    process.env.E2EE_V2_REVIEW_ATTESTATION_SHA256 = 'a'.repeat(64);
    process.env.E2EE_V2_REVIEW_FRONTEND_COMMIT = 'b'.repeat(40);
    process.env.E2EE_V2_REVIEW_BACKEND_COMMIT = 'c'.repeat(40);
    process.env.PULSE_RELEASE_COMMIT_SHA = 'c'.repeat(40);

    const send = await request(buildApp())
      .post('/v2/messages/send')
      .set('x-test-uid', 'user-a')
      .send({
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
    expect(send.status).toBe(503);
    expect(send.body).toEqual({ error: 'v2_pilot_sends_paused' });
    expect(mockMessageService.sendMessage).not.toHaveBeenCalled();

    const feed = await request(buildApp())
      .get('/v2/conversations/conversation-1/messages?deviceId=device-a1')
      .set('x-test-uid', 'user-a');
    expect(feed.status).toBe(200);
    expect(mockMessageService.listMessageFeed).toHaveBeenCalled();
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

  test('acknowledges a decrypted envelope for the authenticated device', async () => {
    const response = await request(buildApp())
      .post('/v2/conversations/conversation-1/messages/message-1/ack')
      .set('x-test-uid', 'user-b')
      .send({ deviceId: 'device-b1' });

    expect(response.status).toBe(200);
    expect(mockMessageService.acknowledgeMessage).toHaveBeenCalledWith({
      userId: 'user-b',
      deviceId: 'device-b1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
    });
    expect(response.body).toEqual({ ok: true, messageId: 'message-1', idempotent: false });
  });

  test('returns a contentless message feed for the authenticated device', async () => {
    const response = await request(buildApp())
      .get('/v2/conversations/conversation-1/messages?deviceId=device-b1&limit=25&offset=0')
      .set('x-test-uid', 'user-b');

    expect(response.status).toBe(200);
    expect(mockMessageService.listMessageFeed).toHaveBeenCalledWith({
      userId: 'user-b',
      deviceId: 'device-b1',
      conversationId: 'conversation-1',
      limit: 25,
      offset: 0,
    });
    expect(response.body.messages).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain('ciphertext');
  });

  test('rejects invalid feed pagination before calling the message service', async () => {
    const response = await request(buildApp())
      .get('/v2/conversations/conversation-1/messages?deviceId=device-b1&limit=101');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'v2_limit_invalid' });
    expect(mockMessageService.listMessageFeed).not.toHaveBeenCalled();
  });
});
