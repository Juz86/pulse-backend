const {
  CALL_E2EE_PROTOCOL,
  CALL_E2EE_VERSION,
  createCallE2eeIdentityAuthorizer,
  extractSha256Fingerprint,
} = require('../src/calling/v2/e2eeIdentity');

const fingerprint = 'ab'.repeat(32);
const colonFingerprint = fingerprint.match(/.{2}/g).join(':').toUpperCase();
const description = `v=0\r\na=fingerprint:sha-256 ${colonFingerprint}\r\n`;
const session = {
  sessionId: 'session-123',
  callerUid: 'caller',
  calleeUid: 'callee',
  mediaType: 'video',
  revision: 3,
};
const identity = {
  protocol: CALL_E2EE_PROTOCOL,
  protocolVersion: CALL_E2EE_VERSION,
  sessionId: session.sessionId,
  callerUserId: session.callerUid,
  calleeUserId: session.calleeUid,
  senderDeviceId: 'device-a1',
  senderSignalDeviceId: 1,
  senderIdentityVersion: 2,
  mediaType: 'video',
  descriptionType: 'offer',
  dtlsFingerprintSha256: fingerprint,
  revision: 3,
  nonce: 'nonce-123',
  peerBindingHash: '',
  identityKey: 'aWRlbnRpdHk=',
  signature: 'c2lnbmF0dXJl',
};

function databaseWithDevice(device) {
  const get = jest.fn().mockResolvedValue({ exists: Boolean(device), data: () => device });
  const deviceDoc = jest.fn(() => ({ get }));
  const devices = jest.fn(() => ({ doc: deviceDoc }));
  const userDoc = jest.fn(() => ({ collection: devices }));
  return {
    database: { collection: jest.fn(() => ({ doc: userDoc })) },
    get,
    deviceDoc,
  };
}

function registeredDevice(overrides = {}) {
  return {
    status: 'active',
    protocol: 'pulse_e2ee_v2',
    protocolVersion: 2,
    capabilities: { messageEncryption: true },
    signalDeviceId: 1,
    identityVersion: 2,
    identityKey: 'aWRlbnRpdHk=',
    ...overrides,
  };
}

describe('Calling v2 E2EE identity authorization', () => {
  test('extracts one consistent SHA-256 fingerprint from SDP', () => {
    expect(extractSha256Fingerprint(description)).toBe(fingerprint);
    expect(extractSha256Fingerprint(
      `${description}a=fingerprint:sha-256 ${'cd'.repeat(32)}\r\n`,
    )).toBeNull();
    expect(extractSha256Fingerprint('a=fingerprint:sha-1 AA:BB')).toBeNull();
  });

  test('accepts a binding only when the active registered device matches exactly', async () => {
    const { database, deviceDoc } = databaseWithDevice(registeredDevice());
    const authorize = createCallE2eeIdentityAuthorizer({ database });

    await expect(authorize({
      actorUid: 'caller', session, type: 'offer', description, identity,
    })).resolves.toEqual({ ok: true, identity });
    expect(deviceDoc).toHaveBeenCalledWith('device-a1');
  });

  test.each([
    ['fingerprint mutation', { description: description.replace(colonFingerprint, 'CD'.repeat(32)) }],
    ['session swap', { identity: { ...identity, sessionId: 'session-999' } }],
    ['identity rollback', { identity: { ...identity, senderIdentityVersion: 1 } }],
  ])('rejects %s', async (_label, override) => {
    const { database } = databaseWithDevice(registeredDevice());
    const authorize = createCallE2eeIdentityAuthorizer({ database });
    const result = await authorize({
      actorUid: 'caller', session, type: 'offer', description, identity, ...override,
    });
    expect(result).toEqual({ ok: false, status: 'FORBIDDEN' });
  });

  test('rejects a revoked or mismatched registered device', async () => {
    const { database } = databaseWithDevice(registeredDevice({ status: 'revoked' }));
    const authorize = createCallE2eeIdentityAuthorizer({ database });
    await expect(authorize({
      actorUid: 'caller', session, type: 'offer', description, identity,
    })).resolves.toEqual({ ok: false, status: 'FORBIDDEN' });
  });
});
