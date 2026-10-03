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
      const result = await service.expireDueRinging({ nowMs: now() });
      if (result.status !== 'APPLIED') {
        traceCall('RINGING_TIMEOUT_SWEEP_FAILED', { status: result.status });
        return;
      }
      for (const session of result.sessions) {
        traceCall('RINGING_TIMEOUT', {
          sessionId: session.sessionId,
          status: 'APPLIED',
          state: session.state,
          revision: session.revision,
        });
        onExpired(session);
      }
    } catch (error) {
      console.error('[Calling v2] Ringing-time-outcontrole mislukt:', error.message);
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
