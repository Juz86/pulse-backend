const mockSet = jest.fn();
const mockUserUpdate = jest.fn();
const mockServerTimestamp = jest.fn(() => 'server-time');
const mockArrayRemove = jest.fn((token) => ({ remove: token }));
const mockDelete = jest.fn(() => 'delete-field');
let mockStoredDevice = null;
const mockUserData = {
  'user-1': { fcmToken: 'token-123', fcmTokens: ['token-123'] },
  'user-2': { fcmToken: 'token-123', fcmTokens: ['token-123'] },
};

const mockCollection = jest.fn((name) => ({
  doc: jest.fn((id) => {
    if (name === 'pushDevices') {
      return {
        get: async () => ({
          exists: Boolean(mockStoredDevice),
          data: () => mockStoredDevice,
        }),
        set: async (data) => {
          mockStoredDevice = data;
          mockSet(id, data);
        },
      };
    }
    return {
      get: async () => ({
        exists: Boolean(mockUserData[id]),
        data: () => mockUserData[id],
      }),
      update: (updates) => mockUserUpdate(id, updates),
    };
  }),
}));

jest.mock('../src/firebase', () => ({
  admin: {
    firestore: {
      FieldValue: {
        arrayRemove: mockArrayRemove,
        delete: mockDelete,
        serverTimestamp: mockServerTimestamp,
      },
    },
  },
  db: {
    collection: mockCollection,
  },
}));

describe('push device registry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoredDevice = null;
  });

  test('validates matching transport and platform combinations', () => {
    const { parsePushDevice } = require('../src/pushDevices');

    expect(parsePushDevice({
      installationId: 'install-123',
      token: 'token-123',
      transport: 'fcm_native',
      platform: 'android',
    })).toEqual({
      installationId: 'install-123',
      token: 'token-123',
      transport: 'fcm_native',
      platform: 'android',
    });
    expect(parsePushDevice({
      installationId: 'install-123',
      token: 'token-123',
      transport: 'fcm_native',
      platform: 'web',
    })).toBeNull();
  });

  test('uses a stable opaque document id and removes previous ownership', async () => {
    const { pushDeviceDocumentId, registerPushDevice } = require('../src/pushDevices');
    const input = {
      installationId: 'install-123',
      token: 'token-123',
      transport: 'fcm_native',
      platform: 'android',
    };

    await registerPushDevice('user-1', input);
    await registerPushDevice('user-2', input);

    const expectedId = pushDeviceDocumentId('install-123');
    expect(expectedId).toMatch(/^[a-f0-9]{64}$/);
    expect(mockSet).toHaveBeenNthCalledWith(
      1,
      expectedId,
      expect.objectContaining({ uid: 'user-1', installationId: 'install-123' }),
    );
    expect(mockSet).toHaveBeenNthCalledWith(
      2,
      expectedId,
      expect.objectContaining({ uid: 'user-2' }),
    );
    expect(mockUserUpdate).toHaveBeenCalledWith('user-1', {
      fcmToken: 'delete-field',
      fcmTokens: { remove: 'token-123' },
    });
  });
});
