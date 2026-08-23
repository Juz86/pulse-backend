const REALTIME_SYNC_PROTOCOL_VERSION = 1;
const REALTIME_SYNC_DOMAINS = Object.freeze([
  'conversations',
  'contacts',
  'friendRequests',
  'blockedContacts',
]);

function getSyncRequiredPayload() {
  return {
    protocolVersion: REALTIME_SYNC_PROTOCOL_VERSION,
    domains: [...REALTIME_SYNC_DOMAINS],
    reason: 'socket_connected',
  };
}

module.exports = {
  REALTIME_SYNC_DOMAINS,
  REALTIME_SYNC_PROTOCOL_VERSION,
  getSyncRequiredPayload,
};
