const mockSendEachForMulticast = jest.fn();
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockDelete = jest.fn();
const mockUserData = {
  fcmTokens: ['legacy-token'],
  displayName: 'Yushua',
  photoURL: 'https://cdn.pulse.test/yushua.jpg',
};
let mockPushDevices = [];

function mockPushDeviceQuery(filters = []) {
  return {
    where: (field, _operator, value) => mockPushDeviceQuery([...filters, [field, value]]),
    get: async () => ({
      docs: mockPushDevices
        .filter((device) => filters.every(([field, value]) => device[field] === value))
        .map((device) => ({
          ref: { delete: mockDelete },
          data: () => device,
        })),
    }),
  };
}

jest.mock('../src/firebase', () => ({
  admin: {
    messaging: () => ({ sendEachForMulticast: mockSendEachForMulticast }),
    firestore: {
      FieldValue: {
        arrayRemove: jest.fn(),
        delete: jest.fn(),
        serverTimestamp: jest.fn(),
      },
    },
  },
  db: {
    collection: (name) => {
      if (name === 'pushDevices') return mockPushDeviceQuery();
      return {
        doc: () => ({
          get: async () => ({ exists: true, data: () => mockUserData }),
          update: mockUpdate,
        }),
      };
    },
  },
}));

describe('push notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPushDevices = [{
      uid: 'recipient',
      installationId: 'installation-1',
      token: 'native-token',
      transport: 'fcm_native',
      platform: 'android',
    }];
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 2,
      failureCount: 0,
      responses: [{ success: true }, { success: true }],
    });
  });

  test('keeps ordinary Pulse notifications on the legacy-compatible tokens', async () => {
    const { sendPush } = require('../src/push');

    await sendPush(
      'recipient',
      { title: 'Pulse', body: 'Je hebt een nieuw bericht.' },
      { type: 'message', conversationId: 'conversation-1' },
    );

    expect(mockSendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
      tokens: ['legacy-token'],
      notification: { title: 'Pulse', body: 'Je hebt een nieuw bericht.' },
      data: { type: 'message', conversationId: 'conversation-1' },
      android: {
        priority: 'normal',
        notification: {
          channelId: 'pulse_messages',
          priority: 'default',
          visibility: 'public',
          sound: 'default',
        },
      },
    }));
  });

  test('sends incoming calls only to native Android device tokens', async () => {
    mockPushDevices.push({
      uid: 'recipient',
      token: 'web-token',
      transport: 'fcm_web',
      platform: 'web',
    });
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true }],
    });
    const { sendIncomingCallPush } = require('../src/push');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await sendIncomingCallPush({
      protocolVersion: 2,
      sessionId: 'session-123',
      callerUid: 'caller',
      calleeUid: 'recipient',
    });

    expect(mockSendEachForMulticast).toHaveBeenCalledWith({
      tokens: ['native-token'],
      data: {
        type: 'calling_v2_incoming',
        protocolVersion: '2',
        sessionId: 'session-123',
        callerDisplayName: 'Yushua',
        callerPhotoURL: 'https://cdn.pulse.test/yushua.jpg',
      },
      android: { priority: 'high', ttl: 30000 },
      webpush: { fcmOptions: { link: 'http://localhost:3000' } },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      '"event":"FCM_SENT","sessionId":"session-123","status":"SENT"',
    ));
    expect(result).toMatchObject({ status: 'SENT', delivered: true, successCount: 1 });
    log.mockRestore();
  });

  test('removes invalid structured device tokens', async () => {
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [{
        success: false,
        error: { code: 'messaging/registration-token-not-registered' },
      }],
    });
    const { sendIncomingCallPush } = require('../src/push');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await sendIncomingCallPush({
      protocolVersion: 2,
      sessionId: 'session-invalid',
      callerUid: 'caller',
      calleeUid: 'recipient',
    });

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'PARTIAL', delivered: false, failureCount: 1 });
    log.mockRestore();
  });

  test('reports when no native Android token exists', async () => {
    mockPushDevices = [];
    const { sendIncomingCallPush } = require('../src/push');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await sendIncomingCallPush({
      protocolVersion: 2,
      sessionId: 'session-no-device',
      callerUid: 'caller',
      calleeUid: 'recipient',
    });

    expect(result).toEqual({
      status: 'NO_NATIVE_TOKENS',
      delivered: false,
      tokenCount: 0,
      successCount: 0,
      failureCount: 0,
    });
    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
    log.mockRestore();
  });

  test('sends terminal call wake-ups to both native Android participants', async () => {
    mockPushDevices = [
      { uid: 'caller', token: 'caller-token', transport: 'fcm_native', platform: 'android' },
      { uid: 'callee', token: 'callee-token', transport: 'fcm_native', platform: 'android' },
    ];
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true }],
    });
    const { sendTerminalCallPush } = require('../src/push');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await sendTerminalCallPush({
      protocolVersion: 2,
      sessionId: 'session-terminal',
      callerUid: 'caller',
      calleeUid: 'callee',
      state: 'ENDED',
      revision: 4,
      terminalReason: 'missed',
    });

    expect(mockSendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(mockSendEachForMulticast).toHaveBeenNthCalledWith(1, {
      tokens: ['caller-token'],
      data: {
        type: 'calling_v2_terminal',
        protocolVersion: '2',
        sessionId: 'session-terminal',
        state: 'ENDED',
        revision: '4',
        terminalReason: 'missed',
      },
      android: { priority: 'high', ttl: 60000 },
      webpush: { fcmOptions: { link: 'http://localhost:3000' } },
    });
    expect(mockSendEachForMulticast).toHaveBeenNthCalledWith(2, expect.objectContaining({
      tokens: ['callee-token'],
    }));
    log.mockRestore();
  });

  test('sends taken-elsewhere only to non-winning Android installations', async () => {
    mockPushDevices = [
      {
        uid: 'callee', installationId: 'winner-installation', token: 'winner-token',
        transport: 'fcm_native', platform: 'android',
      },
      {
        uid: 'callee', installationId: 'loser-installation', token: 'loser-token',
        transport: 'fcm_native', platform: 'android',
      },
    ];
    mockSendEachForMulticast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true }],
    });
    const { sendCallTakenElsewherePush } = require('../src/push');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await sendCallTakenElsewherePush({
      protocolVersion: 2,
      sessionId: 'session-accepted',
      calleeUid: 'callee',
      state: 'CONNECTING',
      revision: 3,
      acceptedInstallationId: 'winner-installation',
    });

    expect(mockSendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
      tokens: ['loser-token'],
      data: expect.objectContaining({
        type: 'calling_v2_taken_elsewhere',
        acceptedInstallationId: 'winner-installation',
      }),
    }));
    log.mockRestore();
  });
});
