const { admin, db } = require('./firebase');
const { traceCall } = require('./calling/v2/diagnostics');
const { listPushDevices } = require('./pushDevices');

const APP_URL = process.env.APP_URL;

async function sendPush(uid, notification, data = {}, options = {}) {
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      tracePushResult(options, 'USER_NOT_FOUND');
      return pushResult('USER_NOT_FOUND');
    }
    const userData = userDoc.data();
    const allDevices = options.nativeAndroidOnly
      ? await listPushDevices(uid, { transport: 'fcm_native', platform: 'android' })
      : [];
    const excludedInstallationIds = new Set(options.excludeInstallationIds || []);
    const devices = allDevices.filter(device => !excludedInstallationIds.has(device.installationId));
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
      return pushResult(options.nativeAndroidOnly ? 'NO_NATIVE_TOKENS' : 'NO_TOKENS');
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
    return pushResult(response.failureCount ? 'PARTIAL' : 'SENT', {
      tokenCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  } catch (e) {
    tracePushResult(options, 'FAILED');
    console.warn(`Push mislukt voor ${uid}:`, e.message);
    return pushResult('FAILED');
  }
}

function pushResult(status, counts = {}) {
  const successCount = counts.successCount || 0;
  return {
    status,
    delivered: successCount > 0,
    tokenCount: counts.tokenCount || 0,
    successCount,
    failureCount: counts.failureCount || 0,
  };
}

function tracePushResult(options, status, counts = {}) {
  if (!options.traceSessionId) return;
  traceCall(options.traceEvent || 'FCM_SENT', {
    sessionId: options.traceSessionId,
    status,
    ...counts,
  });
}

async function callDisplayName(uid) {
  if (!uid) return 'Pulse-gebruiker';
  try {
    const snapshot = await db.collection('users').doc(uid).get();
    if (!snapshot.exists) return 'Pulse-gebruiker';
    const user = snapshot.data() || {};
    const candidate = [user.displayName, user.name, user.username]
      .find((value) => typeof value === 'string' && value.trim());
    return candidate ? candidate.trim().slice(0, 160) : 'Pulse-gebruiker';
  } catch (error) {
    console.warn(`Bellernaam ophalen mislukt voor ${uid}:`, error.message);
    return 'Pulse-gebruiker';
  }
}

async function sendIncomingCallPush(session) {
  if (!session?.sessionId || !session?.callerUid || !session?.calleeUid) return;
  traceCall('FCM_SEND_REQUESTED', {
    sessionId: session.sessionId,
    state: session.state,
    revision: session.revision,
  });
  const callerDisplayName = await callDisplayName(session.callerUid);
  return sendPush(session.calleeUid, null, {
    type: 'calling_v2_incoming',
    protocolVersion: session.protocolVersion || 2,
    sessionId: session.sessionId,
    callerDisplayName,
  }, {
    androidPriority: 'high',
    androidTtlMs: 30 * 1000,
    nativeAndroidOnly: true,
    traceSessionId: session.sessionId,
  });
}

async function sendTerminalCallPush(session) {
  if (!session?.sessionId || session.state !== 'ENDED' || !session.callerUid || !session.calleeUid) return;
  traceCall('FCM_TERMINAL_SEND_REQUESTED', {
    sessionId: session.sessionId,
    state: session.state,
    revision: session.revision,
  });
  const data = {
    type: 'calling_v2_terminal',
    protocolVersion: session.protocolVersion || 2,
    sessionId: session.sessionId,
    state: session.state,
    revision: session.revision,
    terminalReason: session.terminalReason || 'unknown',
  };
  return Promise.all([session.callerUid, session.calleeUid].map((uid) => sendPush(uid, null, data, {
    androidPriority: 'high',
    androidTtlMs: 60 * 1000,
    nativeAndroidOnly: true,
    traceSessionId: session.sessionId,
    traceEvent: 'FCM_TERMINAL_SENT',
  })));
}

async function sendCallTakenElsewherePush(session) {
  if (!session?.sessionId || !session?.calleeUid || !session?.acceptedInstallationId) return;
  traceCall('FCM_TAKEN_ELSEWHERE_SEND_REQUESTED', {
    sessionId: session.sessionId,
    state: session.state,
    revision: session.revision,
  });
  return sendPush(session.calleeUid, null, {
    type: 'calling_v2_taken_elsewhere',
    protocolVersion: session.protocolVersion || 2,
    sessionId: session.sessionId,
    revision: session.revision,
    acceptedInstallationId: session.acceptedInstallationId,
  }, {
    androidPriority: 'high',
    androidTtlMs: 60 * 1000,
    nativeAndroidOnly: true,
    excludeInstallationIds: [session.acceptedInstallationId],
    traceSessionId: session.sessionId,
    traceEvent: 'FCM_TAKEN_ELSEWHERE_SENT',
  });
}

module.exports = {
  sendPush,
  sendIncomingCallPush,
  sendTerminalCallPush,
  sendCallTakenElsewherePush,
};
