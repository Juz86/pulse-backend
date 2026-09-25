const { admin, db } = require('./firebase');

const APP_URL = process.env.APP_URL;

async function sendPush(uid, notification, data = {}, options = {}) {
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();
    const tokens = [...new Set([
      ...(Array.isArray(userData.fcmTokens) ? userData.fcmTokens : []),
      ...(userData.fcmToken ? [userData.fcmToken] : []),
    ])];
    if (!tokens.length) return;
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
      const updates = { fcmTokens: admin.firestore.FieldValue.arrayRemove(...toRemove) };
      if (toRemove.includes(userData.fcmToken)) updates.fcmToken = admin.firestore.FieldValue.delete();
      await db.collection('users').doc(uid).update(updates).catch(e => console.warn('FCM token cleanup mislukt:', e.message));
    }
    console.log(`📬 Push → ${uid}: ${response.successCount}/${tokens.length} bezorgd`);
  } catch (e) {
    console.warn(`Push mislukt voor ${uid}:`, e.message);
  }
}

async function sendIncomingCallPush(session) {
  if (!session?.sessionId || !session?.calleeUid) return;
  return sendPush(session.calleeUid, null, {
    type: 'calling_v2_incoming',
    protocolVersion: session.protocolVersion || 2,
    sessionId: session.sessionId,
  }, {
    androidPriority: 'high',
    androidTtlMs: 30 * 1000,
  });
}

module.exports = { sendPush, sendIncomingCallPush };
