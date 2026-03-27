const nodemailer = require('nodemailer');
const { getRedis } = require('./redis');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ─── OTP store: Redis (persistent) met in-memory Map als fallback ─────────────
const localOtpStore = new Map();
const OTP_TTL_SECONDS = 15 * 60;

async function otpSet(email, code, expiresAt) {
  const r = getRedis();
  if (r) {
    await r.set(`otp:${email}`, JSON.stringify({ code, expiresAt }), 'EX', OTP_TTL_SECONDS);
  } else {
    localOtpStore.set(email, { code, expiresAt });
  }
}

async function otpGet(email) {
  const r = getRedis();
  if (r) {
    const val = await r.get(`otp:${email}`);
    return val ? JSON.parse(val) : null;
  }
  return localOtpStore.get(email) || null;
}

async function otpDel(email) {
  const r = getRedis();
  if (r) {
    await r.del(`otp:${email}`);
  } else {
    localOtpStore.delete(email);
  }
}

module.exports = { transporter, otpSet, otpGet, otpDel };
