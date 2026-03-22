const rateLimit = require('express-rate-limit');
const { admin } = require('./firebase');

const sendCodeLimiter       = rateLimit({ windowMs: 15 * 60 * 1000, max: 5,   message: { error: 'Te veel verzoeken, probeer later opnieuw.' } });
const lookupUsernameLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10,  message: { error: 'Te veel verzoeken, probeer later opnieuw.' } });
const friendReqLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20,  message: { error: 'Te veel verzoeken, probeer later opnieuw.' } });
const globalLimiter    = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Te veel verzoeken.' } });
const strictLimiter    = rateLimit({ windowMs: 60 * 60 * 1000, max: 5,   message: { error: 'Te veel verzoeken.' } });

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

async function verifyAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Niet geautoriseerd.' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: 'Ongeldig token.' });
  }
}

function makeRateLimiter(maxPerMinute) {
  let count = 0;
  let resetAt = Date.now() + 60_000;
  return () => {
    const now = Date.now();
    if (now > resetAt) { count = 0; resetAt = now + 60_000; }
    if (count >= maxPerMinute) return false;
    count++;
    return true;
  };
}

// Per-seconde variant — voor burst-bescherming op frequente events
function makeSecondLimiter(maxPerSecond) {
  let count = 0;
  let resetAt = Date.now() + 1_000;
  return () => {
    const now = Date.now();
    if (now > resetAt) { count = 0; resetAt = now + 1_000; }
    if (count >= maxPerSecond) return false;
    count++;
    return true;
  };
}

module.exports = { sendCodeLimiter, lookupUsernameLimiter, friendReqLimiter, globalLimiter, strictLimiter, securityHeaders, verifyAuth, makeRateLimiter, makeSecondLimiter };
