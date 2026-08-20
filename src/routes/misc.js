const router = require('express').Router();
const { db } = require('../firebase');
const { verifyAuth } = require('../middleware');
const { admin } = require('../firebase');
const { pendingCalls } = require('../state');
const { readPublicFeatureFlags } = require('../featureFlags');

function findPendingCallBySession(sessionId) {
  return pendingCalls[sessionId] || null;
}

function readVersionCode(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// ─── Gezondheidscheck ────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({ status: 'Pulse server draait ✅', time: new Date().toISOString() });
});

router.get('/runtimez', (_req, res) => {
  const firebaseCredentialMode = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    ? 'inline_json'
    : (process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'file_path' : 'unknown');

  res.json({
    ok: true,
    nodeEnv: process.env.NODE_ENV || 'development',
    firebaseCredentialMode,
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST || null,
  });
});

// ─── Android updatebeleid ───────────────────────────────────────────────────
// De daadwerkelijke installatie verloopt altijd via Google Play In-App Updates.
// Railway bepaalt alleen vanaf welke versie een update beschikbaar of verplicht is.
router.get('/api/app-update', (req, res) => {
  const clientVersionCode = readVersionCode(req.query.clientVersionCode);
  if (clientVersionCode === null) {
    return res.status(400).json({ error: 'clientVersionCode_required' });
  }

  const latestVersionCode = readVersionCode(process.env.PULSE_ANDROID_LATEST_VERSION_CODE);
  const minimumVersionCode = readVersionCode(process.env.PULSE_ANDROID_MIN_VERSION_CODE);
  const updateAvailable = latestVersionCode !== null && clientVersionCode < latestVersionCode;
  const updateRequired = minimumVersionCode !== null && clientVersionCode < minimumVersionCode;

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    clientVersionCode,
    latestVersionCode,
    minimumVersionCode,
    updateAvailable,
    updateRequired,
  });
});

// ─── Publieke feature flags ──────────────────────────────────────────────────
// Alleen UI-/uitrolvlaggen horen hier thuis. Autorisatie wordt altijd opnieuw
// op de betreffende API-route afgedwongen en mag nooit op een feature flag leunen.
router.get('/api/feature-flags', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    flags: readPublicFeatureFlags(),
  });
});

router.get('/calls/pending/:sessionId', verifyAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const pendingCall = findPendingCallBySession(sessionId);
    if (!pendingCall) return res.status(404).json({ error: 'pending_call_not_found' });

    const fromUid = req.query.fromUid || pendingCall.from;
    if (req.uid !== pendingCall.to && req.uid !== fromUid) {
      return res.status(403).json({ error: 'Geen toegang.' });
    }

    res.json({
      ok: true,
      call: {
        sessionId: pendingCall.sessionId,
        from: pendingCall.from,
        fromUid: pendingCall.from,
        to: pendingCall.to,
        offer: pendingCall.offer,
        callerName: pendingCall.callerName || 'Iemand',
        isVideo: !!pendingCall.isVideo,
        createdAt: pendingCall.createdAt || Date.now(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── FCM token opslaan ───────────────────────────────────────────────────────
router.post('/api/fcm-token', verifyAuth, async (req, res) => {
  try {
    const { uid, token } = req.body;
    if (!uid || !token) return res.status(400).json({ error: 'uid en token verplicht' });
    if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });
    await db.collection('users').doc(uid).update({
      fcmToken:  token,  // legacy — backward compat
      fcmTokens: admin.firestore.FieldValue.arrayUnion(token),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ── TURN credentials — ICE server config nooit in de frontend bundle ─────────
router.get('/api/turn-credentials', verifyAuth, (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  // Voeg TURN toe als env vars beschikbaar zijn (TURN_URL, TURN_USERNAME, TURN_CREDENTIAL)
  const turnUrl        = process.env.TURN_URL;
  const turnUsername   = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;
  if (turnUrl && turnUsername && turnCredential) {
    iceServers.push(
      { urls: turnUrl,                               username: turnUsername, credential: turnCredential },
      { urls: turnUrl.replace(':80', ':443'),        username: turnUsername, credential: turnCredential },
      { urls: turnUrl.replace('turn:', 'turns:') + '?transport=tcp', username: turnUsername, credential: turnCredential },
    );
  }

  // Cache 1 uur in de browser
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.json({ iceServers });
});

module.exports = router;
