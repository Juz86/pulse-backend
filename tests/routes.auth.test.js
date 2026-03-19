/**
 * Integration tests voor auth routes.
 * Firebase Admin en nodemailer worden gemockt zodat er geen echte verbinding nodig is.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────
jest.mock('../src/firebase', () => ({
  admin: {
    auth: () => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'test-uid' }),
      generatePasswordResetLink: jest.fn().mockResolvedValue('https://reset.link/test'),
    }),
    firestore: { FieldValue: { serverTimestamp: () => 'ts', arrayUnion: (...a) => a, arrayRemove: (...a) => a, delete: () => 'delete' } },
    messaging: () => ({ sendEachForMulticast: jest.fn().mockResolvedValue({ successCount: 0, responses: [] }) }),
  },
  db: {
    collection: () => ({
      doc: () => ({ get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }), set: jest.fn(), update: jest.fn() }),
      where: () => ({ limit: () => ({ get: jest.fn().mockResolvedValue({ empty: true, docs: [] }) }) }),
      add: jest.fn().mockResolvedValue({ id: 'new-doc-id' }),
      get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
    }),
    batch: () => ({ update: jest.fn(), delete: jest.fn(), commit: jest.fn() }),
  },
}));

jest.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test' }),
  }),
}));

jest.mock('../src/redis', () => ({
  redisPub: null, redisSub: null,
  queueMessage: jest.fn(), flushQueue: jest.fn().mockResolvedValue([]),
}));

// ── Setup ────────────────────────────────────────────────────────────────────
const express = require('express');
const request = require('supertest');
const { sendCodeLimiter, strictLimiter } = require('../src/middleware');
const authRouter = require('../src/routes/auth');

// Overschrijf rate limiters zodat ze tests niet blokkeren
jest.mock('../src/middleware', () => {
  const passThrough = (req, res, next) => next();
  return {
    sendCodeLimiter: passThrough, strictLimiter: passThrough,
    globalLimiter: passThrough, friendReqLimiter: passThrough,
    verifyAuth: passThrough, securityHeaders: passThrough,
    makeRateLimiter: () => () => true,
  };
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', authRouter); // auth.js registreert zelf /api/... paden
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('POST /api/send-code', () => {
  it('weigert ongeldig e-mailadres', async () => {
    const res = await request(buildApp()).post('/api/send-code').send({ email: 'geen-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('accepteert geldig e-mailadres', async () => {
    const res = await request(buildApp()).post('/api/send-code').send({ email: 'test@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/verify-code', () => {
  it('geeft fout als er geen code is', async () => {
    const res = await request(buildApp()).post('/api/verify-code').send({ email: 'x@x.com', code: '123456' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/send-reset', () => {
  it('weigert ongeldig e-mailadres', async () => {
    const res = await request(buildApp()).post('/api/send-reset').send({ email: 'geen-email' });
    expect(res.status).toBe(400);
  });

  it('stuurt reset mail bij geldig adres', async () => {
    const res = await request(buildApp()).post('/api/send-reset').send({ email: 'test@example.com', actionUrl: 'https://app.pulse.nl' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
