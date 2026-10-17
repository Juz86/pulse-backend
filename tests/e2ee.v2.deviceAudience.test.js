const {
  deviceRoomName,
  verifySocketDevice,
} = require('../src/e2ee/v2/deviceAudience');

function databaseWithDevice(device) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: Boolean(device), data: () => device }),
          }),
        }),
      }),
    }),
  };
}

describe('pulse_e2ee_v2 socket device audience', () => {
  test('creates an opaque room name without raw account or device ids', () => {
    const room = deviceRoomName('user-b', 'device-b1');
    expect(room).toBe('e2ee:v2:device:dXNlci1iAGRldmljZS1iMQ');
    expect(room).not.toContain('user-b');
    expect(room).not.toContain('device-b1');
  });

  test('binds only an active v2-capable device owned by the authenticated user', async () => {
    const binding = await verifySocketDevice({
      database: databaseWithDevice({
        status: 'active',
        protocol: 'pulse_e2ee_v2',
        protocolVersion: 2,
        platform: 'android',
        capabilities: { messageEncryption: true },
      }),
      userId: 'user-b',
      deviceId: 'device-b1',
    });
    expect(binding).toMatchObject({ deviceId: 'device-b1', platform: 'android' });
  });

  test.each([
    null,
    { status: 'revoked', protocol: 'pulse_e2ee_v2', protocolVersion: 2, capabilities: { messageEncryption: true } },
    { status: 'active', protocol: 'signal_v1', protocolVersion: 1, capabilities: { messageEncryption: true } },
  ])('rejects a missing, revoked, or legacy device', async (device) => {
    await expect(verifySocketDevice({
      database: databaseWithDevice(device),
      userId: 'user-b',
      deviceId: 'device-b1',
    })).rejects.toThrow('v2_socket_device_not_authorized');
  });
});
