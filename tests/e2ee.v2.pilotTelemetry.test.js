const {
  classifyOperation,
  durationBucket,
  recordE2EEV2Request,
} = require('../src/e2ee/v2/pilotTelemetry');

describe('E2EE v2 pilot telemetry', () => {
  test('classifies fixed route templates without inspecting identifiers', () => {
    expect(classifyOperation('POST', '/v2/messages/send')).toBe('message_send');
    expect(classifyOperation(
      'POST',
      '/v2/conversations/:conversationId/messages/:messageId/ack',
    )).toBe('message_ack');
    expect(classifyOperation('GET', '/v2/not-a-route')).toBe('unknown');
  });

  test('uses coarse duration buckets', () => {
    expect(durationBucket(12)).toBe('lt_100ms');
    expect(durationBucket(450)).toBe('lt_500ms');
    expect(durationBucket(900)).toBe('lt_2s');
    expect(durationBucket(2500)).toBe('gte_2s');
  });

  test('logs only allowlisted operational metadata', () => {
    const log = jest.spyOn(console, 'info').mockImplementation(() => {});
    const metric = recordE2EEV2Request({
      method: 'POST',
      routePath: '/v2/messages/send',
      rolloutMode: 'pilot',
      statusCode: 201,
      durationMs: 35,
      userId: 'must-not-appear',
      conversationId: 'must-not-appear',
      ciphertext: 'must-not-appear',
    });

    expect(metric).toEqual({
      event: 'e2ee_v2_request',
      operation: 'message_send',
      outcome: 'success',
      statusCode: 201,
      rolloutMode: 'pilot',
      durationBucket: 'lt_100ms',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('must-not-appear');
    log.mockRestore();
  });
});
