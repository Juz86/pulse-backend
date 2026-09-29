const router = require('express').Router();
const { db } = require('../firebase');
const { verifyAuth } = require('../middleware');
const { admin } = require('../firebase');
const { readPublicFeatureFlags } = require('../featureFlags');
const { registerPushDevice } = require('../pushDevices');

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

// ─── FCM token opslaan ───────────────────────────────────────────────────────
router.post('/api/fcm-token', verifyAuth, async (req, res) => {
  try {
    const { uid, token, installationId, transport, platform } = req.body;
    if (!uid || !token) return res.status(400).json({ error: 'uid en token verplicht' });
    if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });
    const device = await registerPushDevice(uid, {
      installationId,
      token,
      transport,
      platform,
    });
    if (!device) return res.status(400).json({ error: 'Ongeldige pushregistratie.' });
    await db.collection('users').doc(uid).update({
      fcmToken: token, // legacy - backward compatibility for ordinary notifications
      fcmTokens: admin.firestore.FieldValue.arrayUnion(token),
    });
    res.json({ ok: true, stored: true });
  } catch (err) {
    res.status(500).json({ error: 'Serverfout' });
  }
});

module.exports = router;
