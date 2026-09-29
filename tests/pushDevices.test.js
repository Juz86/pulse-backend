const mockSet = jest.fn();
const mockServerTimestamp = jest.fn(() => 'server-time');
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

jest.mock('../src/firebase', () => ({
  admin: {
    firestore: {
      FieldValue: {
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

  test('uses a stable opaque document id and overwrites ownership', async () => {
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
    expect(mockCollection).toHaveBeenCalledWith('pushDevices');
    expect(mockDoc).toHaveBeenNthCalledWith(1, expectedId);
    expect(mockDoc).toHaveBeenNthCalledWith(2, expectedId);
    expect(mockSet).toHaveBeenNthCalledWith(1, expect.objectContaining({ uid: 'user-1' }));
    expect(mockSet).toHaveBeenNthCalledWith(2, expect.objectContaining({ uid: 'user-2' }));
  });
});
