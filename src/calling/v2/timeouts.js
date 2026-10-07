const { traceCall } = require('./diagnostics');

function startCallV2TimeoutSweeper({
  service,
  onExpired,
  intervalMs = 1000,
  now = Date.now,
}) {
  let running = false;

  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const nowMs = now();
      const checks = [
        ['PREPARING_TIMEOUT', await service.expireDuePreparing({ nowMs })],
        ['RINGING_TIMEOUT', await service.expireDueRinging({ nowMs })],
        ['CONNECTING_TIMEOUT', await service.expireDueConnecting({ nowMs })],
      ];
      for (const [event, result] of checks) {
        if (result.status !== 'APPLIED') {
          traceCall(`${event}_SWEEP_FAILED`, { status: result.status });
          continue;
        }
        for (const session of result.sessions) {
          traceCall(event, {
            sessionId: session.sessionId,
            status: 'APPLIED',
            state: session.state,
            revision: session.revision,
          });
          await onExpired(session);
        }
      }
    } catch (error) {
      console.error('[Calling v2] Time-outcontrole mislukt:', error.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  void sweep();
  return { sweep, stop: () => clearInterval(timer) };
}

module.exports = { startCallV2TimeoutSweeper };
