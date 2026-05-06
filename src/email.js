const { Resend } = require('resend');
const { getRedis } = require('./redis');
const { db } = require('./firebase');

// ─── Resend HTTP API (betrouwbaarder dan SMTP op cloud hosting) ───────────────
const resendApiKey =
  process.env.RESEND_API_KEY ||
  process.env.resend_api_key ||
  process.env.RESEND_KEY ||
  process.env.resend_key ||
  '';
const resend = new Resend(resendApiKey);
if (!resendApiKey) {
  console.warn('⚠️ RESEND_API_KEY ontbreekt (ook lowercase varianten niet gevonden). OTP e-mail kan niet worden verstuurd.');
}

// Nodemailer-compatibele wrapper zodat auth.js ongewijzigd blijft
const transporter = {
  sendMail: async ({ from, to, subject, html }) => {
    if (!resendApiKey) {
      throw new Error('RESEND_API_KEY ontbreekt in environment variables');
    }
    const { data, error } = await resend.emails.send({ from, to, subject, html });
    if (error) {
      console.error('[Pulse] Resend fout:', JSON.stringify(error));
      throw new Error(error.message || 'Resend fout');
    }
    console.log('[Pulse] E-mail verstuurd, id:', data?.id);
  },
};

// ─── OTP store: Redis (snel) + Firestore (persistent) + Memory fallback ──────
const OTP_TTL_SECONDS = 15 * 60;
const OTP_COLLECTION = 'verificationCodes';
const otpMemoryStore = new Map();

async function otpSet(email, code, expiresAt) {
  const r = getRedis();

  // Always store in memory fallback so verify works even without Redis/Firebase.
  otpMemoryStore.set(email, { code, expiresAt });

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
    } catch {
      // fall through
    }
  }

  const snap = await db.collection(OTP_COLLECTION).doc(email).get().catch(() => null);
  if (snap?.exists) return snap.data();

  const mem = otpMemoryStore.get(email);
  if (!mem) return null;
  if (Date.now() > mem.expiresAt) {
    otpMemoryStore.delete(email);
    return null;
  }
  return mem;
}

async function otpDel(email) {
  const r = getRedis();

  otpMemoryStore.delete(email);

  await db.collection(OTP_COLLECTION).doc(email).delete()
    .catch(e => console.warn('[Pulse] OTP Firestore delete mislukt:', e.message));

  if (r) {
    await r.del(`otp:${email}`).catch(() => {});
  }
}

module.exports = { transporter, otpSet, otpGet, otpDel };
