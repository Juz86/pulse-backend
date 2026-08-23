const {
  REALTIME_SYNC_DOMAINS,
  REALTIME_SYNC_PROTOCOL_VERSION,
  getSyncRequiredPayload,
} = require('../src/socket/sync');

describe('realtime sync socket protocol', () => {
  test('requests reconciliation of every cached domain on connect', () => {
    expect(getSyncRequiredPayload()).toEqual({
      protocolVersion: 1,
      domains: ['conversations', 'contacts', 'friendRequests', 'blockedContacts'],
      reason: 'socket_connected',
    });
  });

  test('does not expose a mutable protocol domain list', () => {
    expect(REALTIME_SYNC_PROTOCOL_VERSION).toBe(1);
    expect(Object.isFrozen(REALTIME_SYNC_DOMAINS)).toBe(true);
  });
});
