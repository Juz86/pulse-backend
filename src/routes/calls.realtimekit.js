const router = require('express').Router();
const { callBootstrapLimiter, verifyAuth } = require('../middleware');
const { getPendingCall } = require('../callStore');
const { createRealtimeKitClient, getRealtimeKitConfigurationStatus } = require('../realtimeKit');
const {
  ensureRealtimeKitSession,
  ensureParticipant,
  getRealtimeKitSession,
} = require('../realtimeKitSessionStore');

function isValidSessionId(value) {
  return /^[a-zA-Z0-9:_-]{8,160}$/.test(String(value || ''));
}

router.get('/api/calls/realtimekit/status', verifyAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ...getRealtimeKitConfigurationStatus() });
});

router.post('/api/calls/realtimekit/session/:sessionId/join', verifyAuth, callBootstrapLimiter, async (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) return res.status(400).json({ error: 'invalid_session_id' });

  try {
    let session = await getRealtimeKitSession(sessionId);
    if (!session) {
      const pending = await getPendingCall(sessionId);
      if (!pending) return res.status(404).json({ error: 'pending_call_not_found' });
      if (req.uid !== pending.from && req.uid !== pending.to) {
        return res.status(403).json({ error: 'call_access_denied' });
      }
      const client = createRealtimeKitClient();
      session = await ensureRealtimeKitSession(sessionId, async () => {
        const { meetingId } = await client.createMeeting({ sessionId });
        return {
          sessionId,
          meetingId,
          callerUid: pending.from,
          calleeUid: pending.to,
          isVideo: Boolean(pending.isVideo),
          participants: {},
          createdAt: Date.now(),
        };
      });
    }

    if (req.uid !== session.callerUid && req.uid !== session.calleeUid) {
      return res.status(403).json({ error: 'call_access_denied' });
    }

    const participant = await ensureParticipant(sessionId, req.uid, async () => {
      const client = createRealtimeKitClient();
      return client.addParticipant({
        meetingId: session.meetingId,
        uid: req.uid,
        name: req.body?.name,
        picture: req.body?.picture,
      });
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      engine: 'realtimekit-v2',
      sessionId,
      authToken: participant.authToken,
      isVideo: session.isVideo,
    });
  } catch (error) {
    const knownStatus = error.code === 'realtimekit_disabled' ? 503
      : error.code === 'realtimekit_not_configured' ? 503
        : error.code === 'realtimekit_api_failed' ? 502 : 500;
    console.error('RealtimeKit call bootstrap failed:', error.code || error.message);
    return res.status(knownStatus).json({ error: error.code || 'realtimekit_bootstrap_failed' });
  }
});

module.exports = router;
