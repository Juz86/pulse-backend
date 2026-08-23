const { admin, db } = require('./firebase');

const APP_URL = process.env.APP_URL;

async function sendPush(uid, notification, data = {}) {
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
    const isIncomingCall = stringData.type === 'incoming_call';
    const response = await admin.messaging().sendEachForMulticast({
      tokens, notification, data: stringData,
      // Android WebViews are suspended in the background. A high-priority
      // notification wakes the system UI, while the data payload lets Pulse
      // restore the pending offer after the user taps it.
      android: {
        priority: isIncomingCall ? 'high' : 'normal',
        notification: {
          channelId: isIncomingCall ? 'pulse_calls' : 'pulse_messages',
          priority: isIncomingCall ? 'max' : 'default',
          visibility: 'public',
          sound: 'default',
          tag: isIncomingCall && stringData.callSessionId ? `call_${stringData.callSessionId}` : undefined,
        },
      },
      webpush: { fcmOptions: { link: APP_URL } },
    });
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

module.exports = { sendPush };
