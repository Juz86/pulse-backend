const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JWT_SECRET = process.env.NATIVE_AUTH_JWT_SECRET || process.env.JWT_SECRET || 'dev-native-secret-change-me';
const JWT_EXPIRES_IN = process.env.NATIVE_AUTH_JWT_EXPIRES_IN || '7d';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS native_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'child',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  schemaReady = true;
}

function validEmail(e) { return typeof e === 'string' && EMAIL_REGEX.test(e.trim()); }
function validDisplayName(name) { return typeof name === 'string' && name.trim().length >= 2; }
function validPassword(password) { return typeof password === 'string' && password.length >= 8; }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  const raw = String(encoded || '');
  // Legacy fallback: old rows may still contain plaintext password.
  if (!raw.includes(':')) {
    return { ok: raw === password, needsRehash: raw === password };
  }

  const [salt, hash] = raw.split(':');
  if (!salt || !hash) return { ok: false, needsRehash: false };

  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  if (a.length !== b.length) return { ok: false, needsRehash: false };
  return { ok: crypto.timingSafeEqual(a, b), needsRehash: false };
}

function makeToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: 'native' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function toUserDto(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
}

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

router.post('/native/auth/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const displayName = String(req.body?.displayName || '').trim();
  const role = req.body?.role === 'parent' ? 'parent' : 'child';

  if (!validEmail(email)) return res.status(400).json({ error: 'Ongeldig e-mailadres.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens bevatten.' });
  if (!validDisplayName(displayName)) return res.status(400).json({ error: 'Naam moet minimaal 2 tekens bevatten.' });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  try {
    await ensureSchema();
    const id = crypto.randomUUID();
    const passwordHash = hashPassword(password);
    const inserted = await pool.query(
      `INSERT INTO native_users (id, email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, display_name, role`,
      [id, email, passwordHash, displayName, role]
    );

    return res.status(201).json({ ok: true, user: toUserDto(inserted.rows[0]) });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'E-mailadres bestaat al.' });
    }
    console.error('Native register fout:', err);
    return res.status(500).json({ error: 'Registratie mislukt.' });
  }
});

router.post('/native/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!validEmail(email) || !password) {
    return res.status(400).json({ error: 'Onjuiste e-mail of wachtwoord.' });
  }
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  try {
    await ensureSchema();
    const found = await pool.query(
      `SELECT id, email, password_hash, display_name, role
       FROM native_users
       WHERE email = $1
       LIMIT 1`,
      [email]
    );
    if (!found.rows.length) {
      return res.status(401).json({ error: 'Onjuiste e-mail of wachtwoord.' });
    }

    const row = found.rows[0];
    const passwordCheck = verifyPassword(password, row.password_hash);
    if (!passwordCheck.ok) {
      return res.status(401).json({ error: 'Onjuiste e-mail of wachtwoord.' });
    }

    if (passwordCheck.needsRehash) {
      const upgradedHash = hashPassword(password);
      await pool.query(
        `UPDATE native_users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [upgradedHash, row.id]
      );
    }

    const user = toUserDto(row);
    const accessToken = makeToken(user);
    const refreshToken = accessToken;

    return res.json({ accessToken, refreshToken, user });
  } catch (err) {
    console.error('Native login fout:', err);
    return res.status(500).json({ error: 'Inloggen mislukt.' });
  }
});

router.get('/native/auth/me', async (req, res) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Niet geautoriseerd.' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const id = decoded?.sub;
    if (!id) return res.status(401).json({ error: 'Ongeldig token.' });
    if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

    await ensureSchema();
    const found = await pool.query(
      `SELECT id, email, display_name, role FROM native_users WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!found.rows.length) {
      return res.status(401).json({ error: 'Ongeldig token.' });
    }

    return res.json({ user: toUserDto(found.rows[0]) });
  } catch {
    return res.status(401).json({ error: 'Ongeldig token.' });
  }
});

router.post('/native/auth/logout', (_req, res) => {
  return res.json({ success: true });
});

router.post('/native/auth/refresh', (req, res) => {
  const refreshToken = String(req.body?.refreshToken || '');
  if (!refreshToken) return res.status(401).json({ error: 'Ongeldig refresh token.' });

  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    const accessToken = jwt.sign(
      { sub: decoded.sub, email: decoded.email, role: decoded.role, type: 'native' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    return res.json({ accessToken, refreshToken });
  } catch {
    return res.status(401).json({ error: 'Ongeldig refresh token.' });
  }
});

module.exports = router;
