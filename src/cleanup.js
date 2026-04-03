// src/cleanup.js — Gecentraliseerde retentiecleanup voor alle communicatiegegevens
// Beleid: 30 dagen voor alle categorieën
// Schema: Firestore (geen SQL, geen PostgreSQL)
// Uitvoering: dagelijks om 03:00, idempotent en batchgewijs

const { admin, db } = require('./firebase');

const RETENTION_DAYS = 30;

// ─── Hulpfuncties ─────────────────────────────────────────────────────────────

function cutoffTimestamp() {
  const d = new Date();
  d.setDate(d.getDate() - RETENTION_DAYS);
  return admin.firestore.Timestamp.fromDate(d);
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

// ─── 1. Berichten (inclusief oproepen en videogesprekken) ─────────────────────
// Collection: conversations/{convId}/messages
// Veld: createdAt (Firestore serverTimestamp)
// Alle berichttypen (text, call, contact) worden verwijderd na 30 dagen.
async function cleanMessages() {
  const cutoff = cutoffTimestamp();
  let totalDeleted = 0;

  const convsSnap = await db.collection('conversations').get();

  for (const convDoc of convsSnap.docs) {
    const oldMsgs = await convDoc.ref
      .collection('messages')
      .where('createdAt', '<', cutoff)
      .get();

    if (oldMsgs.empty) continue;
    totalDeleted += await deleteDocs(oldMsgs.docs);
  }

  return totalDeleted;
}

// ─── 2. Technische metadata (gebruikerssessies van kinderen) ──────────────────
// Collection: userSessions
// Veld: startTime (Firestore serverTimestamp)
async function cleanUserSessions() {
  const cutoff = cutoffTimestamp();

  const snap = await db.collection('userSessions')
    .where('startTime', '<', cutoff)
    .get();

  if (snap.empty) return 0;
  return deleteDocs(snap.docs);
}

// ─── 3. Support- en incidentdossiers (ouderactiviteiten) ──────────────────────
// Collection: parentActivities
// Veld: createdAt (Firestore serverTimestamp)
async function cleanParentActivities() {
  const cutoff = cutoffTimestamp();

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
async function cleanVerificationCodes() {
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

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

  console.log(`[Cleanup] Klaar. Totaal: berichten=${results.messages}, sessies=${results.userSessions}, activiteiten=${results.parentActivities}, otp=${results.verificationCodes}`);
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

module.exports = { runCleanup, scheduleDaily };
