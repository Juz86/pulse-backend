const OPERATIONS = new Set([
  'device_list',
  'device_register',
  'key_rotate',
  'prekey_refill',
  'device_revoke',
  'key_bundle_claim',
  'own_device_key_bundle_claim',
  'message_send',
  'message_feed',
  'message_ack',
  'message_envelope',
  'pilot_status',
  'unknown',
]);

function durationBucket(durationMs) {
  if (durationMs < 100) return 'lt_100ms';
  if (durationMs < 500) return 'lt_500ms';
  if (durationMs < 2000) return 'lt_2s';
  return 'gte_2s';
}

function outcomeForStatus(statusCode) {
  if (statusCode < 400) return 'success';
  if (statusCode < 500) return 'client_error';
  return 'server_error';
}

function classifyOperation(method, routePath) {
  const key = `${String(method || '').toUpperCase()} ${String(routePath || '')}`;
  const routes = new Map([
    ['GET /v2/pilot/status', 'pilot_status'],
    ['GET /v2/devices', 'device_list'],
    ['POST /v2/devices/register', 'device_register'],
    ['PUT /v2/devices/:deviceId/keys', 'key_rotate'],
    ['POST /v2/devices/:deviceId/prekeys', 'prekey_refill'],
    ['POST /v2/devices/:deviceId/revoke', 'device_revoke'],
    ['POST /v2/conversations/:conversationId/users/:recipientUserId/key-bundles/claim', 'key_bundle_claim'],
    ['POST /v2/conversations/:conversationId/own-device-key-bundles/claim', 'own_device_key_bundle_claim'],
    ['POST /v2/messages/send', 'message_send'],
    ['GET /v2/conversations/:conversationId/messages', 'message_feed'],
    ['POST /v2/conversations/:conversationId/messages/:messageId/ack', 'message_ack'],
    ['GET /v2/conversations/:conversationId/messages/:messageId/envelope', 'message_envelope'],
  ]);
  return routes.get(key) || 'unknown';
}

function recordE2EEV2Request({ method, routePath, rolloutMode, statusCode, durationMs }) {
  const operation = classifyOperation(method, routePath);
  const metric = {
    event: 'e2ee_v2_request',
    operation: OPERATIONS.has(operation) ? operation : 'unknown',
    outcome: outcomeForStatus(statusCode),
    statusCode: Number(statusCode),
    rolloutMode: ['qa', 'internal_play_test', 'pilot'].includes(rolloutMode)
      ? rolloutMode
      : 'disabled',
    durationBucket: durationBucket(Math.max(0, Number(durationMs) || 0)),
  };
  console.info('[PulseMetric]', JSON.stringify(metric));
  return metric;
}

function createE2EEV2TelemetryMiddleware(getRolloutMode) {
  return (req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      recordE2EEV2Request({
        method: req.method,
        routePath: req.route?.path || req.baseUrl || '',
        rolloutMode: getRolloutMode(),
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  };
}

module.exports = {
  classifyOperation,
  createE2EEV2TelemetryMiddleware,
  durationBucket,
  outcomeForStatus,
  recordE2EEV2Request,
};
