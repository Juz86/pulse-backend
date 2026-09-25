const mockSendEachForMulticast = jest.fn();
const mockUpdate = jest.fn();
const mockUserData = { fcmTokens: ['token-1'] };

jest.mock('../src/firebase', () => ({
  admin: {
    messaging: () => ({ sendEachForMulticast: mockSendEachForMulticast }),
    firestore: {
      FieldValue: {
        arrayRemove: jest.fn(),
        delete: jest.fn(),
      },
    },
  },
  db: {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => mockUserData }),
        update: mockUpdate,
      }),
    }),
  },
}));

describe('push notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendEachForMulticast.mockResolvedValue({ successCount: 1, responses: [{ success: true }] });
  });

  test('sends ordinary Pulse notifications on the message channel', async () => {
    const { sendPush } = require('../src/push');

    await sendPush(
      'recipient',
      { title: 'Pulse', body: 'Je hebt een nieuw bericht.' },
      { type: 'message', conversationId: 'conversation-1' },
    );

    expect(mockSendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
      tokens: ['token-1'],
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

  test('sends incoming calls as short-lived high-priority data messages', async () => {
    const { sendIncomingCallPush } = require('../src/push');

    await sendIncomingCallPush({
      protocolVersion: 2,
      sessionId: 'session-123',
      calleeUid: 'recipient',
    });

    expect(mockSendEachForMulticast).toHaveBeenCalledWith({
      tokens: ['token-1'],
      data: {
        type: 'calling_v2_incoming',
        protocolVersion: '2',
        sessionId: 'session-123',
      },
      android: { priority: 'high', ttl: 30000 },
      webpush: { fcmOptions: { link: 'http://localhost:3000' } },
    });
  });
});
