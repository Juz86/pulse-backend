const { Resend } = require('resend');
const { getRedis } = require('./redis');
const { db } = require('./firebase');

// ─── Resend HTTP API (betrouwbaarder dan SMTP op cloud hosting) ───────────────
const resend = new Resend(process.env.RESEND_API_KEY);

// Nodemailer-compatibele wrapper zodat auth.js ongewijzigd blijft
const transporter = {
  sendMail: async ({ from, to, subject, html }) => {
    const { data, error } = await resend.emails.send({ from, to, subject, html });
    if (error) {
      console.error('[Pulse] Resend fout:', JSON.stringify(error));
      throw new Error(error.message || 'Resend fout');
    }
    console.log('[Pulse] E-mail verstuurd, id:', data?.id);
  },
};

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
