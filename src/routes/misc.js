const router = require('express').Router();
const { db } = require('../firebase');
const { verifyAuth } = require('../middleware');
const { admin } = require('../firebase');
const { getPendingCall } = require('../callStore');
const { readPublicFeatureFlags } = require('../featureFlags');
const { getTurnCredentials } = require('../turnCredentials');

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
    const pendingCall = await getPendingCall(sessionId);
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
        callerCandidates: Array.isArray(pendingCall.callerCandidates) ? pendingCall.callerCandidates : [],
        callerName: pendingCall.callerName || 'Iemand',
        isVideo: !!pendingCall.isVideo,
        createdAt: pendingCall.createdAt || Date.now(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Serverfout' });
  }
});

router.post('/api/native-call-auth', verifyAuth, async (req, res) => {
  try {
    const customToken = await admin.auth().createCustomToken(req.uid, { pulseNativeCall: true });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, customToken });
  } catch (err) {
    console.error('Native call auth fout:', err);
    return res.status(500).json({ error: 'native_call_auth_failed' });
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
router.get('/api/turn-credentials', verifyAuth, async (_req, res) => {
  const credentials = await getTurnCredentials({ logger: console });
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.json(credentials);
});

module.exports = router;
