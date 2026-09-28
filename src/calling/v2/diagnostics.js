const SAFE_FIELDS = [
  'sessionId', 'requestId', 'status', 'state', 'revision', 'command',
  'mediaType', 'messageType', 'tokenCount', 'successCount', 'failureCount',
  'iceServerCount', 'hasStun', 'hasTurn',
];

function traceCall(event, details = {}) {
  const safeDetails = {};
  for (const key of SAFE_FIELDS) {
    if (details[key] !== undefined && details[key] !== null) safeDetails[key] = details[key];
  }
  console.log(`[Calling v2 trace] ${JSON.stringify({ event, ...safeDetails })}`);
}

module.exports = { traceCall };
