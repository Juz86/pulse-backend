const mockSendEachForMulticast = jest.fn();
const mockUserData = {
  fcmTokens: ['token-1'],
};

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
        update: jest.fn(),
      }),
    }),
  },
}));

describe('call push payloads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendEachForMulticast.mockResolvedValue({ successCount: 1, responses: [{ success: true }] });
  });

  test('incoming calls are high-priority data-only messages', async () => {
    const { sendPush } = require('../src/push');

    await sendPush(
      'callee',
      { title: 'Caller', body: 'Caller belt je via Pulse.' },
      { type: 'incoming_call', callSessionId: 'session-1', fromUid: 'caller' }
    );

    expect(mockSendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
      tokens: ['token-1'],
      data: expect.objectContaining({ type: 'incoming_call', callSessionId: 'session-1' }),
      android: expect.objectContaining({
        priority: 'high',
        ttl: 35_000,
        collapseKey: 'call_session-1',
      }),
    }));
    const message = mockSendEachForMulticast.mock.calls[0][0];
    expect(message.notification).toBeUndefined();
    expect(message.android.notification).toBeUndefined();
  });

  test('call cancellation is data-only and shares the call collapse key', async () => {
    const { sendPush } = require('../src/push');

    await sendPush('callee', null, {
      type: 'call_cancelled',
      callSessionId: 'session-1',
    });

    const message = mockSendEachForMulticast.mock.calls[0][0];
    expect(message.notification).toBeUndefined();
    expect(message.android).toEqual(expect.objectContaining({
      priority: 'high',
      ttl: 35_000,
      collapseKey: 'call_session-1',
    }));
    expect(message.android.notification).toBeUndefined();
  });
});
