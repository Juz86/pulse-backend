const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { admin } = require('../firebase');
const { verifyAuth } = require('../middleware');
const { getRedis } = require('../redis');

const CODE_TTL_SECONDS = 60;
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_PREFIX = 'call:v2:native-auth:';
const CLAIM_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`;
const bootstrapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'native_auth_rate_limited' },
});
const claimLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'native_auth_rate_limited' },
});

function codeKey(code) {
  return `${KEY_PREFIX}${code}`;
}

function createCallingV2NativeAuthRouter({
  getRedisClient = getRedis,
  createCustomToken = (uid) => admin.auth().createCustomToken(uid),
  authMiddleware = verifyAuth,
  issueLimiter = bootstrapLimiter,
  redeemLimiter = claimLimiter,
} = {}) {
  const router = express.Router();

  router.post(
    '/api/calling/v2/native-auth/bootstrap',
    authMiddleware,
    issueLimiter,
    async (req, res) => {
      const redis = getRedisClient();
      if (!redis) return res.status(503).json({ error: 'native_auth_unavailable' });
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const code = crypto.randomBytes(32).toString('base64url');
          const stored = await redis.set(
            codeKey(code),
            String(req.uid),
            'EX',
            CODE_TTL_SECONDS,
            'NX',
          );
          if (stored === 'OK') {
            return res.json({ ok: true, code, expiresInSeconds: CODE_TTL_SECONDS });
          }
        }
        return res.status(503).json({ error: 'native_auth_unavailable' });
      } catch {
        return res.status(503).json({ error: 'native_auth_unavailable' });
      }
    },
  );

  router.post(
    '/api/calling/v2/native-auth/claim',
    redeemLimiter,
    async (req, res) => {
      const code = String(req.body?.code || '');
      if (!CODE_PATTERN.test(code)) {
        return res.status(400).json({ error: 'native_auth_code_invalid' });
      }
      const redis = getRedisClient();
      if (!redis) return res.status(503).json({ error: 'native_auth_unavailable' });
      try {
        const uid = await redis.eval(CLAIM_SCRIPT, 1, codeKey(code));
        if (!uid) return res.status(401).json({ error: 'native_auth_code_invalid' });
        const customToken = await createCustomToken(String(uid));
        return res.json({ ok: true, customToken });
      } catch {
        return res.status(503).json({ error: 'native_auth_unavailable' });
      }
    },
  );

  return router;
}

module.exports = createCallingV2NativeAuthRouter;
module.exports.CODE_TTL_SECONDS = CODE_TTL_SECONDS;
module.exports.CLAIM_SCRIPT = CLAIM_SCRIPT;
