const nodemailer = require('nodemailer');
const { getRedis } = require('./redis');
const { db } = require('./firebase');

// ─── Resend SMTP transporter ──────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: 'smtp.resend.com',
  port: 465,
  secure: true,
  auth: {
    user: 'resend',
    pass: process.env.RESEND_API_KEY,
  },
});

// ─── OTP store: Redis (snel) + Firestore (persistent, multi-instance safe) ────
const OTP_TTL_SECONDS = 15 * 60;
const OTP_COLLECTION  = 'verificationCodes';

async function otpSet(email, code, expiresAt) {
  const r = getRedis();

  await db.collection(OTP_COLLECTION).doc(email).set({
    code, expiresAt, createdAt: Date.now(),
  }).catch(e => console.warn('[Pulse] OTP Firestore set mislukt:', e.message));

  if (r) {
    await r.set(`otp:${email}`, JSON.stringify({ code, expiresAt }), 'EX', OTP_TTL_SECONDS).catch(() => {});
  }
}

async function otpGet(email) {
  const r = getRedis();

  if (r) {
    try {
      const val = await r.get(`otp:${email}`);
      if (val) return JSON.parse(val);
    } catch { /* doorvallen naar Firestore */ }
  }

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
