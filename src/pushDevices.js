const crypto = require('crypto');
const { admin, db } = require('./firebase');

const ALLOWED_TRANSPORTS = new Set(['fcm_native', 'fcm_web']);
const ALLOWED_PLATFORMS = new Set(['android', 'web']);

function normalize(value, maximumLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) return null;
  return normalized;
}

function parsePushDevice(input = {}) {
  const installationId = normalize(input.installationId, 128);
  const token = normalize(input.token, 4096);
  const transport = normalize(input.transport, 32);
  const platform = normalize(input.platform, 32);
  if (!installationId || !token || !ALLOWED_TRANSPORTS.has(transport) || !ALLOWED_PLATFORMS.has(platform)) {
    return null;
  }
  if (transport === 'fcm_native' && platform !== 'android') return null;
  if (transport === 'fcm_web' && platform !== 'web') return null;
  return { installationId, token, transport, platform };
}

function pushDeviceDocumentId(installationId) {
  return crypto.createHash('sha256').update(installationId).digest('hex');
}

async function registerPushDevice(uid, input) {
  const device = parsePushDevice(input);
  if (!device) return null;
  const ref = db.collection('pushDevices').doc(pushDeviceDocumentId(device.installationId));
  await ref.set({
    uid,
    token: device.token,
    transport: device.transport,
    platform: device.platform,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ref, ...device };
}

async function listPushDevices(uid, filters = {}) {
  let query = db.collection('pushDevices').where('uid', '==', uid);
  if (filters.transport) query = query.where('transport', '==', filters.transport);
  if (filters.platform) query = query.where('platform', '==', filters.platform);
  const snapshot = await query.get();
  return snapshot.docs
    .map((doc) => ({ ref: doc.ref, ...doc.data() }))
    .filter((device) => typeof device.token === 'string' && device.token.trim());
}

module.exports = {
  listPushDevices,
  parsePushDevice,
  pushDeviceDocumentId,
  registerPushDevice,
};
