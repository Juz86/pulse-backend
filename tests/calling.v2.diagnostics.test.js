const { traceCall } = require('../src/calling/v2/diagnostics');

describe('Calling v2 diagnostics', () => {
  test('logs only explicitly safe call metadata', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    traceCall('FCM_SENT', {
      sessionId: 'session-123', status: 'SENT', successCount: 1,
      token: 'must-not-be-logged', description: 'v=0',
    });
    expect(log).toHaveBeenCalledWith(
      '[Calling v2 trace] {"event":"FCM_SENT","sessionId":"session-123","status":"SENT","successCount":1}',
    );
    log.mockRestore();
  });
});
