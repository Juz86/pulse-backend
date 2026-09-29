const { admin, db } = require('./firebase');
const { traceCall } = require('./calling/v2/diagnostics');
const { listPushDevices } = require('./pushDevices');

const APP_URL = process.env.APP_URL;

async function sendPush(uid, notification, data = {}, options = {}) {
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      tracePushResult(options, 'USER_NOT_FOUND');
      return;
    }
    const userData = userDoc.data();
    const devices = options.nativeAndroidOnly
      ? await listPushDevices(uid, { transport: 'fcm_native', platform: 'android' })
      : [];
    const legacyTokens = options.nativeAndroidOnly ? [] : [
      ...(Array.isArray(userData.fcmTokens) ? userData.fcmTokens : []),
      ...(userData.fcmToken ? [userData.fcmToken] : []),
    ];
    const tokens = [...new Set([...devices.map((device) => device.token), ...legacyTokens])];
    if (!tokens.length) {
      tracePushResult(
        options,
        options.nativeAndroidOnly ? 'NO_NATIVE_TOKENS' : 'NO_TOKENS',
        { tokenCount: 0 },
      );
      return;
    }
    const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
    const message = {
      tokens,
      data: stringData,
      android: {
        priority: options.androidPriority || 'normal',
        ...(options.androidTtlMs ? { ttl: options.androidTtlMs } : {}),
      },
      webpush: { fcmOptions: { link: APP_URL } },
    };
    if (notification) {
      message.notification = notification;
      message.android.notification = {
        channelId: 'pulse_messages',
        priority: 'default',
        visibility: 'public',
        sound: 'default',
      };
    }
    const response = await admin.messaging().sendEachForMulticast(message);
    const toRemove = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          toRemove.push(tokens[i]);
        }
      }
    });
    if (toRemove.length) {
      await Promise.all(devices
        .filter((device) => toRemove.includes(device.token))
        .map((device) => device.ref.delete()));
      const updates = { fcmTokens: admin.firestore.FieldValue.arrayRemove(...toRemove) };
      if (toRemove.includes(userData.fcmToken)) updates.fcmToken = admin.firestore.FieldValue.delete();
      await db.collection('users').doc(uid).update(updates).catch(e => console.warn('FCM token cleanup mislukt:', e.message));
    }
    tracePushResult(options, response.failureCount ? 'PARTIAL' : 'SENT', {
      tokenCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
    console.log(`📬 Push → ${uid}: ${response.successCount}/${tokens.length} bezorgd`);
  } catch (e) {
    tracePushResult(options, 'FAILED');
    console.warn(`Push mislukt voor ${uid}:`, e.message);
  }
}

function tracePushResult(options, status, counts = {}) {
  if (!options.traceSessionId) return;
  traceCall('FCM_SENT', { sessionId: options.traceSessionId, status, ...counts });
}

async function sendIncomingCallPush(session) {
  if (!session?.sessionId || !session?.calleeUid) return;
  traceCall('FCM_SEND_REQUESTED', {
    sessionId: session.sessionId,
    state: session.state,
    revision: session.revision,
  });
  return sendPush(session.calleeUid, null, {
    type: 'calling_v2_incoming',
    protocolVersion: session.protocolVersion || 2,
    sessionId: session.sessionId,
  }, {
    androidPriority: 'high',
    androidTtlMs: 30 * 1000,
    nativeAndroidOnly: true,
    traceSessionId: session.sessionId,
  });
}

module.exports = { sendPush, sendIncomingCallPush };
