const nodemailer = require('nodemailer');
const { getRedis } = require('./redis');
const { db } = require('./firebase');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ─── OTP store: Redis (snel) + Firestore (persistent, multi-instance safe) ────
// Firestore garandeert dat de code beschikbaar is ongeacht welke Railway-instantie
// het verify-verzoek verwerkt. Redis is een optionele read-through cache.
const OTP_TTL_SECONDS = 15 * 60;
const OTP_COLLECTION  = 'verificationCodes';

async function otpSet(email, code, expiresAt) {
  const r    = getRedis();
  const data = { code, expiresAt };

  // Altijd naar Firestore schrijven — persistent en zichtbaar op alle instanties
  await db.collection(OTP_COLLECTION).doc(email).set({
    code, expiresAt, createdAt: Date.now(),
  }).catch(e => console.warn('[Pulse] OTP Firestore set mislukt:', e.message));

  // Redis als extra cache voor snelle reads
  if (r) {
    await r.set(`otp:${email}`, JSON.stringify(data), 'EX', OTP_TTL_SECONDS).catch(() => {});
  }
}

async function otpGet(email) {
  const r = getRedis();

  // Redis eerst (sneller)
  if (r) {
    try {
      const val = await r.get(`otp:${email}`);
      if (val) return JSON.parse(val);
    } catch { /* val bij Redis-fout: doorvallen naar Firestore */ }
  }

  // Firestore als fallback
  const snap = await db.collection(OTP_COLLECTION).doc(email).get().catch(() => null);
  if (!snap?.exists) return null;
  return snap.data();
}

async function otpDel(email) {
  const r = getRedis();

  await db.collection(OTP_COLLECTION).doc(email).delete()
    .catch(e => console.warn('[Pulse] OTP Firestore delete mislukt:', e.message));

  if (r) {
    await r.del(`otp:${email}`).catch(() => {});
  }
}

module.exports = { transporter, otpSet, otpGet, otpDel };
