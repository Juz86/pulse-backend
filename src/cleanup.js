// src/cleanup.js — Gecentraliseerde retentiecleanup voor alle communicatiegegevens
// Beleid: communicatiedata 30 dagen, logbestanden/technische metadata 7 dagen
// Schema: Firestore (geen SQL, geen PostgreSQL)
// Uitvoering: dagelijks om 03:00, idempotent en batchgewijs

const { admin, db } = require('./firebase');

const COMM_RETENTION_DAYS = 30; // default voor communicatiegegevens
const LOG_RETENTION_DAYS  = 7;  // technische metadata (sessies), OTP-codes
const HISTORY_RETENTION_OPTIONS_DAYS = [0, 1, 7, 30];
const HISTORY_RULE_KEYS = {
  chat: 'chatRetentionDays',
  call: 'callRetentionDays',
  video: 'videoRetentionDays',
};

// ─── Hulpfuncties ─────────────────────────────────────────────────────────────

function cutoffTimestamp(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return admin.firestore.Timestamp.fromDate(d);
}

function normalizeRetentionDays(value) {
  const numeric = Number(value);
  return HISTORY_RETENTION_OPTIONS_DAYS.includes(numeric) ? numeric : COMM_RETENTION_DAYS;
}

function normalizeHistoryRules(rules = {}) {
  return {
    chatRetentionDays: normalizeRetentionDays(rules?.chatRetentionDays),
    callRetentionDays: normalizeRetentionDays(rules?.callRetentionDays),
    videoRetentionDays: normalizeRetentionDays(rules?.videoRetentionDays),
  };
}

function getMessageHistoryType(message = {}) {
  if (message.type === 'call') return message.isVideo ? 'video' : 'call';
  return 'chat';
}

function summarizeMessageForConversation(data = {}) {
  if (data.type === 'contact') return `Contactpersoon: ${data.sharedContact?.name || ''}`;
  if (data.type === 'call') {
    const safeDuration = (typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration >= 0)
      ? Math.round(data.duration)
      : 0;
    const dur = safeDuration > 0
      ? (safeDuration >= 60 ? `${Math.floor(safeDuration / 60)} min` : `${safeDuration} sec`)
      : '';
    if (data.direction === 'completed') return `${data.isVideo ? 'Video-oproep' : 'Spraakoproep'}${dur ? ` · ${dur}` : ''}`;
    if (data.direction === 'declined') return data.isVideo ? 'Video-oproep geweigerd' : 'Oproep geweigerd';
    return data.isVideo ? 'Gemiste video-oproep' : 'Gemiste oproep';
  }
  return data.text || '';
}

async function getHistorySettings(collectionName, uid) {
  const doc = await db.collection(collectionName).doc(uid).get();
  const data = doc.exists ? doc.data() || {} : {};
  return normalizeHistoryRules(data.historyRules);
}

async function getUserHistoryRules(uid) {
  if (!uid) return normalizeHistoryRules();
  const userDoc = await db.collection('users').doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() || {} : {};
  if (userData.role === 'child') return getHistorySettings('child_settings', uid);
  return getHistorySettings('parent_settings', uid);
}

async function resolveConversationHistoryRules(members = []) {
  const uniqueMembers = [...new Set((Array.isArray(members) ? members : []).filter(Boolean))];
  if (uniqueMembers.length === 0) return normalizeHistoryRules();
  const rulesList = await Promise.all(uniqueMembers.map(uid => getUserHistoryRules(uid)));
  return rulesList.reduce((acc, rules) => ({
    chatRetentionDays: Math.min(acc.chatRetentionDays, normalizeRetentionDays(rules.chatRetentionDays)),
    callRetentionDays: Math.min(acc.callRetentionDays, normalizeRetentionDays(rules.callRetentionDays)),
    videoRetentionDays: Math.min(acc.videoRetentionDays, normalizeRetentionDays(rules.videoRetentionDays)),
  }), normalizeHistoryRules());
}

// Verwijder documenten in batches van max 500 (Firestore-limiet)
async function deleteDocs(docs) {
  let deleted = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += Math.min(500, docs.length - i);
  }
  return deleted;
}

async function syncConversationSummary(convDoc, convData = {}) {
  const messagesRef = convDoc.ref.collection('messages');
  if (typeof messagesRef.orderBy !== 'function') return;
  const latestSnap = await messagesRef
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (latestSnap.empty) {
    await convDoc.ref.update({
      lastMessage: null,
      lastMessageAt: null,
      updatedAt: convData.createdAt || null,
      lastCallSenderId: admin.firestore.FieldValue.delete(),
      lastCallDirection: admin.firestore.FieldValue.delete(),
      lastCallIsVideo: admin.firestore.FieldValue.delete(),
    });
    return;
  }

  const latestData = latestSnap.docs[0].data() || {};
  const latestCreatedAt = latestData.createdAt || convData.updatedAt || convData.createdAt || null;
  const update = {
    lastMessage: summarizeMessageForConversation(latestData),
    lastMessageAt: latestCreatedAt,
    updatedAt: latestCreatedAt,
  };

  if (latestData.type === 'call') {
    update.lastCallSenderId = latestData.senderId || null;
    update.lastCallDirection = latestData.direction || null;
    update.lastCallIsVideo = !!latestData.isVideo;
  } else {
    update.lastCallSenderId = admin.firestore.FieldValue.delete();
    update.lastCallDirection = admin.firestore.FieldValue.delete();
    update.lastCallIsVideo = admin.firestore.FieldValue.delete();
  }

  await convDoc.ref.update(update);
}

async function cleanConversation(convDoc) {
  const convData = convDoc.data() || {};
  const historyRules = await resolveConversationHistoryRules(convData.members || []);
  const messagesSnap = await convDoc.ref.collection('messages').get();
  if (messagesSnap.empty) return 0;

  const nowMs = Date.now();
  const docsToDelete = messagesSnap.docs.filter((doc) => {
    const data = doc.data() || {};
    const historyType = getMessageHistoryType(data);
    const days = normalizeRetentionDays(historyRules[HISTORY_RULE_KEYS[historyType]]);
    if (days === 0) return true;
    const createdAt = data.createdAt?.toDate ? data.createdAt.toDate().getTime() : data.createdAt?._seconds ? data.createdAt._seconds * 1000 : new Date(data.createdAt || 0).getTime();
    if (!createdAt) return false;
    return createdAt < (nowMs - days * 24 * 60 * 60 * 1000);
  });

  if (docsToDelete.length === 0) return 0;
  const deleted = await deleteDocs(docsToDelete);
  await syncConversationSummary(convDoc, convData);
  return deleted;
}

// ─── 1. Berichten (inclusief oproepen en videogesprekken) ─────────────────────
// Collection: conversations/{convId}/messages
// Veld: createdAt (Firestore serverTimestamp)
// Alle berichttypen (text, call, video, contact) worden verwijderd volgens de
// kortste bewaartermijn van de deelnemers: 24 uur, 7, 14 of standaard 30 dagen.
async function cleanMessages() {
  let totalDeleted = 0;

  const convsSnap = await db.collection('conversations').get();

  for (const convDoc of convsSnap.docs) {
    totalDeleted += await cleanConversation(convDoc);
  }

  return totalDeleted;
}

async function cleanupCommunicationsForUser(uid) {
  if (!uid) return 0;
  const convsSnap = await db.collection('conversations')
    .where('members', 'array-contains', uid)
    .get();

  let totalDeleted = 0;
  for (const convDoc of convsSnap.docs) {
    totalDeleted += await cleanConversation(convDoc);
  }
  return totalDeleted;
}

// ─── 2. Technische metadata (gebruikerssessies van kinderen) ──────────────────
// Collection: userSessions
// Veld: startTime (Firestore serverTimestamp)
// Logbestanden → 7 dagen retentie
async function cleanUserSessions() {
  const cutoff = cutoffTimestamp(LOG_RETENTION_DAYS);

  const snap = await db.collection('userSessions')
    .where('startTime', '<', cutoff)
    .get();

  if (snap.empty) return 0;
  return deleteDocs(snap.docs);
}

// ─── 3. Support- en incidentdossiers (ouderactiviteiten) ──────────────────────
// Collection: parentActivities
// Veld: createdAt (Firestore serverTimestamp)
// Support/incident → 30 dagen retentie
async function cleanParentActivities() {
  const cutoff = cutoffTimestamp(COMM_RETENTION_DAYS);

  const snap = await db.collection('parentActivities')
    .where('createdAt', '<', cutoff)
    .get();

  if (snap.empty) return 0;
  return deleteDocs(snap.docs);
}

// ─── 4. Verlopen OTP-codes (logbestanden / verificatiedata) ───────────────────
// Collection: verificationCodes/{email}
// Veld: createdAt (Unix ms timestamp)
// Codes worden verwijderd bij gebruik (otpDel), maar verlopen/geabandoneerde
// codes kunnen blijven staan als Firestore-document.
// Logbestanden → 7 dagen retentie
async function cleanVerificationCodes() {
  const cutoffMs = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const snap = await db.collection('verificationCodes').get();

  const expired = snap.docs.filter(d => {
    const data = d.data();
    // Verwijder als createdAt ouder is dan 30 dagen, of als expiresAt al lang verstreken is
    const createdAt = data.createdAt || 0;
    const expiresAt = data.expiresAt || 0;
    return createdAt < cutoffMs || expiresAt < cutoffMs;
  });

  if (expired.length === 0) return 0;
  return deleteDocs(expired);
}

// ─── 5. Vriendschapsverzoeken ─────────────────────────────────────────────────
// Collection: friendRequests
// Veld: createdAt (Firestore serverTimestamp)
// Verwijder verzoeken ouder dan 30 dagen ongeacht status (pending/accepted/declined).
// Geaccepteerde verzoeken resulteren in contacts-subcollectie-documenten die
// los van friendRequests bestaan — die worden hier NIET geraakt.
// Accounts (users collection) worden nooit aangeraakt.
async function cleanFriendRequests() {
  const cutoff = cutoffTimestamp(COMM_RETENTION_DAYS);

  const snap = await db.collection('friendRequests')
    .where('createdAt', '<', cutoff)
    .get();

  if (snap.empty) return 0;
  return deleteDocs(snap.docs);
}

// ─── 6. Agenda-activiteiten (verlopen items) ──────────────────────────────────
// Collection: agenda/{uid}/activities
// Veld: date (YYYY-MM-DD string)
// Verwijder activiteiten waarvan de datum meer dan 30 dagen geleden was.
async function cleanAgendaActivities() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - COMM_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  const snap = await db.collectionGroup('activities')
    .where('date', '<', cutoffStr)
    .get();

  if (snap.empty) return 0;
  return deleteDocs(snap.docs);
}

// ─── Hoofdfunctie: voer alle cleanup-taken uit ────────────────────────────────
async function runCleanup() {
  const started = new Date().toISOString();
  console.log(`[Cleanup] Gestart om ${started}`);

  const results = {};

  try {
    results.messages = await cleanMessages();
    console.log(`[Cleanup] Berichten/oproepen/video: ${results.messages} verwijderd`);
  } catch (err) {
    console.error('[Cleanup] Berichten mislukt:', err.message);
    results.messages = 'FOUT';
  }

  try {
    results.userSessions = await cleanUserSessions();
    console.log(`[Cleanup] Gebruikerssessies: ${results.userSessions} verwijderd`);
  } catch (err) {
    console.error('[Cleanup] Gebruikerssessies mislukt:', err.message);
    results.userSessions = 'FOUT';
  }

  try {
    results.parentActivities = await cleanParentActivities();
    console.log(`[Cleanup] Ouderactiviteiten: ${results.parentActivities} verwijderd`);
  } catch (err) {
    console.error('[Cleanup] Ouderactiviteiten mislukt:', err.message);
    results.parentActivities = 'FOUT';
  }

  try {
    results.verificationCodes = await cleanVerificationCodes();
    console.log(`[Cleanup] OTP-codes: ${results.verificationCodes} verwijderd`);
  } catch (err) {
    console.error('[Cleanup] OTP-codes mislukt:', err.message);
    results.verificationCodes = 'FOUT';
  }

  try {
    results.agendaActivities = await cleanAgendaActivities();
    console.log(`[Cleanup] Agenda-activiteiten: ${results.agendaActivities} verwijderd`);
  } catch (err) {
    console.error('[Cleanup] Agenda-activiteiten mislukt:', err.message);
    results.agendaActivities = 'FOUT';
  }

  try {
    results.friendRequests = await cleanFriendRequests();
    console.log(`[Cleanup] Vriendschapsverzoeken: ${results.friendRequests} verwijderd`);
  } catch (err) {
    console.error('[Cleanup] Vriendschapsverzoeken mislukt:', err.message);
    results.friendRequests = 'FOUT';
  }

  console.log(`[Cleanup] Klaar — berichten=${results.messages} sessies=${results.userSessions} parentActiviteiten=${results.parentActivities} otp=${results.verificationCodes} agenda=${results.agendaActivities} vriendschapsverzoeken=${results.friendRequests}`);
}

// ─── Dagelijkse planning om 03:00 (Railway-compatibel) ───────────────────────
// Berekent de milliseconden tot de volgende 03:00 en herhaalt daarna elke 24u.
// Idempotent: meermaals draaien is veilig.
function scheduleDaily() {
  function msUntilNext03() {
    const now = new Date();
    const next = new Date();
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  const delay = msUntilNext03();
  const nextRun = new Date(Date.now() + delay).toISOString();
  console.log(`[Cleanup] Volgende run gepland om ${nextRun}`);

  setTimeout(() => {
    runCleanup();
    // Na de eerste run elke 24 uur herhalen
    setInterval(runCleanup, 24 * 60 * 60 * 1000);
  }, delay);
}

module.exports = {
  runCleanup,
  scheduleDaily,
  cleanupCommunicationsForUser,
  normalizeRetentionDays,
  normalizeHistoryRules,
  getMessageHistoryType,
  getUserHistoryRules,
  resolveConversationHistoryRules,
  HISTORY_RETENTION_OPTIONS_DAYS,
  COMM_RETENTION_DAYS,
};
