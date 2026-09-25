const express = require('express');
const request = require('supertest');
const createCallingV2NativeAuthRouter = require('../src/routes/calling.v2.nativeAuth');

const passThrough = (req, _res, next) => next();

function buildHarness() {
  const values = new Map();
  const redis = {
    set: jest.fn(async (key, value) => {
      if (values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }),
    eval: jest.fn(async (_script, _count, key) => {
      const value = values.get(key) || null;
      values.delete(key);
      return value;
    }),
  };
  const createCustomToken = jest.fn(async (uid) => `custom:${uid}`);
  const app = express();
  app.use(express.json());
  app.use(createCallingV2NativeAuthRouter({
    getRedisClient: () => redis,
    createCustomToken,
    authMiddleware: (req, _res, next) => {
      req.uid = 'web-user';
      next();
    },
    issueLimiter: passThrough,
    redeemLimiter: passThrough,
  }));
  return { app, redis, createCustomToken };
}

describe('Calling v2 native authentication bridge', () => {
  test('issues a short-lived code and redeems it exactly once', async () => {
    const { app, redis, createCustomToken } = buildHarness();
    const issued = await request(app)
      .post('/api/calling/v2/native-auth/bootstrap')
      .send({});

    expect(issued.status).toBe(200);
    expect(issued.body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.body.expiresInSeconds).toBe(60);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(issued.body.code),
      'web-user',
      'EX',
      60,
      'NX',
    );

    const claimed = await request(app)
      .post('/api/calling/v2/native-auth/claim')
      .send({ code: issued.body.code });
    expect(claimed.status).toBe(200);
    expect(claimed.body.customToken).toBe('custom:web-user');
    expect(createCustomToken).toHaveBeenCalledWith('web-user');

    const replay = await request(app)
      .post('/api/calling/v2/native-auth/claim')
      .send({ code: issued.body.code });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('native_auth_code_invalid');
  });

  test('fails closed when Redis is unavailable', async () => {
    const app = express();
    app.use(express.json());
    app.use(createCallingV2NativeAuthRouter({
      getRedisClient: () => null,
      authMiddleware: passThrough,
      issueLimiter: passThrough,
      redeemLimiter: passThrough,
    }));
    const issued = await request(app)
      .post('/api/calling/v2/native-auth/bootstrap')
      .send({});
    const claimed = await request(app)
      .post('/api/calling/v2/native-auth/claim')
      .send({ code: 'a'.repeat(43) });
    expect(issued.status).toBe(503);
    expect(claimed.status).toBe(503);
  });

  test('rejects malformed codes without touching Redis', async () => {
    const { app, redis } = buildHarness();
    const response = await request(app)
      .post('/api/calling/v2/native-auth/claim')
      .send({ code: 'not-a-valid-code' });
    expect(response.status).toBe(400);
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
