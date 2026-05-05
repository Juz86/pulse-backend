module.exports = (io) => {
const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;
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
      username TEXT,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'child',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE native_users ADD COLUMN IF NOT EXISTS username TEXT;`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS native_users_username_unique_idx
    ON native_users (LOWER(username))
    WHERE username IS NOT NULL;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS native_parent_children (
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (parent_id, child_id),
      FOREIGN KEY (parent_id) REFERENCES native_users(id) ON DELETE CASCADE,
      FOREIGN KEY (child_id) REFERENCES native_users(id) ON DELETE CASCADE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS native_contacts (
      owner_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_id, contact_id),
      FOREIGN KEY (owner_id) REFERENCES native_users(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES native_users(id) ON DELETE CASCADE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS native_friend_requests (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (from_user_id) REFERENCES native_users(id) ON DELETE CASCADE,
      FOREIGN KEY (to_user_id) REFERENCES native_users(id) ON DELETE CASCADE
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS native_friend_requests_to_idx
    ON native_friend_requests (to_user_id, status, created_at DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS native_friend_requests_from_idx
    ON native_friend_requests (from_user_id, status, created_at DESC);
  `);
  schemaReady = true;
}

function validEmail(e) { return typeof e === 'string' && EMAIL_REGEX.test(e.trim()); }
function validUsername(u) { return typeof u === 'string' && USERNAME_REGEX.test(u.trim().toLowerCase()); }
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
    username: row.username || null,
  };
}

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

function decodeAccessToken(req) {
  const token = extractToken(req);
  if (!token) return { error: 'Niet geautoriseerd.' };
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded?.sub) return { error: 'Ongeldig token.' };
    return { sub: String(decoded.sub), role: String(decoded.role || '') };
  } catch {
    return { error: 'Ongeldig token.' };
  }
}

async function findNativeUserByIdentifier(identifier) {
  const clean = String(identifier || '').trim().toLowerCase();
  if (!clean) return null;

  if (clean.includes('@') && validEmail(clean)) {
    const byEmail = await pool.query(
      `SELECT id, email, username, display_name, role FROM native_users WHERE email = $1 LIMIT 1`,
      [clean]
    );
    if (byEmail.rows.length) return byEmail.rows[0];
  }

  if (validUsername(clean)) {
    const byUsername = await pool.query(
      `SELECT id, email, username, display_name, role FROM native_users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
      [clean]
    );
    if (byUsername.rows.length) return byUsername.rows[0];
  }

  return null;
}

function contactDtoFromUser(row) {
  return {
    userId: row.id,
    displayName: row.display_name,
    avatarUrl: null,
    profilePhotoUrl: null,
    phoneNumber: null,
    email: row.email || null,
    status: 'offline',
    isOnline: false,
    lastSeen: null,
  };
}

router.post('/native/auth/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const displayName = String(req.body?.displayName || '').trim();
  const role = req.body?.role === 'parent' ? 'parent' : 'child';

  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  // Child accounts must be created by parent flow.
  if (role === 'child') {
    return res.status(403).json({ error: 'Kindaccounts worden aangemaakt door ouderaccounts.' });
  }

  if (!validEmail(email)) return res.status(400).json({ error: 'Ongeldig e-mailadres.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens bevatten.' });
  if (!validDisplayName(displayName)) return res.status(400).json({ error: 'Naam moet minimaal 2 tekens bevatten.' });

  try {
    await ensureSchema();
    const id = crypto.randomUUID();
    const passwordHash = hashPassword(password);
    const inserted = await pool.query(
      `INSERT INTO native_users (id, email, username, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, username, display_name, role`,
      [id, email, null, passwordHash, displayName, role]
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
  const identifier = String(req.body?.email || req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Onjuiste logingegevens.' });
  }
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  const byEmail = identifier.includes('@');

  try {
    await ensureSchema();

    let found;
    if (byEmail) {
      const email = identifier.toLowerCase();
      if (!validEmail(email)) return res.status(400).json({ error: 'Onjuiste logingegevens.' });
      found = await pool.query(
        `SELECT id, email, username, password_hash, display_name, role
         FROM native_users
         WHERE email = $1
         LIMIT 1`,
        [email]
      );
    } else {
      const username = identifier.toLowerCase();
      if (!validUsername(username)) return res.status(400).json({ error: 'Onjuiste logingegevens.' });
      found = await pool.query(
        `SELECT id, email, username, password_hash, display_name, role
         FROM native_users
         WHERE LOWER(username) = LOWER($1)
         LIMIT 1`,
        [username]
      );
    }

    if (!found.rows.length) {
      return res.status(401).json({ error: 'Onjuiste logingegevens.' });
    }

    const row = found.rows[0];

    // Contract guard:
    // - parent logs in with email
    // - child logs in with username
    if (byEmail && row.role !== 'parent') {
      return res.status(403).json({ error: 'Kindaccount moet inloggen met gebruikersnaam en wachtwoord.' });
    }
    if (!byEmail && row.role !== 'child') {
      return res.status(403).json({ error: 'Ouderaccount moet inloggen met e-mailadres en wachtwoord.' });
    }

    const passwordCheck = verifyPassword(password, row.password_hash);
    if (!passwordCheck.ok) {
      return res.status(401).json({ error: 'Onjuiste logingegevens.' });
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

router.get('/native/parent/children', async (req, res) => {
  const auth = decodeAccessToken(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  if (auth.role !== 'parent') return res.status(403).json({ error: 'Alleen ouderaccounts hebben toegang.' });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  try {
    await ensureSchema();
    const result = await pool.query(
      `SELECT c.id AS uid, c.display_name, c.username, c.email, c.created_at
       FROM native_parent_children pc
       JOIN native_users c ON c.id = pc.child_id
       WHERE pc.parent_id = $1 AND c.role = 'child'
       ORDER BY c.created_at DESC`,
      [auth.sub]
    );

    const children = result.rows.map((row) => ({
      uid: row.uid,
      displayName: row.display_name,
      username: row.username || null,
      email: row.email || null,
      photoURL: null,
      online: false,
      lastSeen: null,
      pausedFeatures: { chat: false, call: false, video: false },
    }));

    return res.json(children);
  } catch (err) {
    console.error('Native parent children fout:', err);
    return res.status(500).json({ error: 'Kinderen ophalen mislukt.' });
  }
});

router.post('/native/parent/create-child', async (req, res) => {
  const auth = decodeAccessToken(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  if (auth.role !== 'parent') return res.status(403).json({ error: 'Alleen ouderaccounts kunnen kindaccounts maken.' });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  const name = String(req.body?.name || '').trim();
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!validDisplayName(name)) return res.status(400).json({ error: 'Naam moet minimaal 2 tekens bevatten.' });
  if (!validUsername(username)) return res.status(400).json({ error: 'Gebruikersnaam: 3-32 tekens, alleen a-z 0-9 . _ -' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens bevatten.' });

  const syntheticEmail = `${username}@child.native`;

  try {
    await ensureSchema();
    await pool.query('BEGIN');

    const existingUsername = await pool.query(
      `SELECT id FROM native_users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
      [username]
    );
    if (existingUsername.rows.length) {
      await pool.query('ROLLBACK');
      return res.status(409).json({ error: 'Gebruikersnaam is al in gebruik.' });
    }

    const existingEmail = await pool.query(
      `SELECT id FROM native_users WHERE email = $1 LIMIT 1`,
      [syntheticEmail]
    );
    if (existingEmail.rows.length) {
      await pool.query('ROLLBACK');
      return res.status(409).json({ error: 'Gebruikersnaam is al in gebruik.' });
    }

    const childId = crypto.randomUUID();
    const passwordHash = hashPassword(password);

    const createdChild = await pool.query(
      `INSERT INTO native_users (id, email, username, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, $5, 'child')
       RETURNING id, email, username, display_name, role`,
      [childId, syntheticEmail, username, passwordHash, name]
    );

    await pool.query(
      `INSERT INTO native_parent_children (parent_id, child_id)
       VALUES ($1, $2)
       ON CONFLICT (parent_id, child_id) DO NOTHING`,
      [auth.sub, childId]
    );

    await pool.query('COMMIT');

    const row = createdChild.rows[0];
    const child = {
      uid: row.id,
      displayName: row.display_name,
      username: row.username,
      email: row.email,
      photoURL: null,
      online: false,
      lastSeen: null,
      pausedFeatures: { chat: false, call: false, video: false },
    };

    return res.status(201).json({
      success: true,
      message: 'Kindaccount aangemaakt',
      child,
    });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch {}
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Gebruikersnaam is al in gebruik.' });
    }
    console.error('Native parent create-child fout:', err);
    return res.status(500).json({ error: 'Kindaccount aanmaken mislukt.' });
  }
});

router.get('/contacts', async (req, res) => {
  const auth = decodeAccessToken(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  try {
    await ensureSchema();
    const result = await pool.query(
      `SELECT u.id, u.email, u.username, u.display_name, c.created_at
       FROM native_contacts c
       JOIN native_users u ON u.id = c.contact_id
       WHERE c.owner_id = $1
       ORDER BY c.created_at DESC`,
      [auth.sub]
    );
    return res.json(result.rows.map(contactDtoFromUser));
  } catch (err) {
    console.error('Native contacts ophalen fout:', err);
    return res.status(500).json({ error: 'Contacten ophalen mislukt.' });
  }
});

router.post('/contacts/request', async (req, res) => {
  const auth = decodeAccessToken(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'Zoekterm ontbreekt.' });

  try {
    await ensureSchema();
    const target = await findNativeUserByIdentifier(query);
    if (!target) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    if (target.id === auth.sub) return res.status(400).json({ error: 'Je kunt jezelf niet toevoegen' });

    const already = await pool.query(
      `SELECT 1 FROM native_contacts WHERE owner_id = $1 AND contact_id = $2 LIMIT 1`,
      [auth.sub, target.id]
    );
    if (already.rows.length) return res.status(409).json({ error: 'Deze gebruiker is al contact' });

    const reverse = await pool.query(
      `SELECT 1 FROM native_contacts WHERE owner_id = $1 AND contact_id = $2 LIMIT 1`,
      [target.id, auth.sub]
    );
    if (reverse.rows.length) {
      await pool.query(
        `INSERT INTO native_contacts (owner_id, contact_id) VALUES ($1, $2) ON CONFLICT (owner_id, contact_id) DO NOTHING`,
        [auth.sub, target.id]
      );
      return res.json({ success: true, message: 'Contact toegevoegd' });
    }

    const existingPending = await pool.query(
      `SELECT id FROM native_friend_requests
       WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'
       LIMIT 1`,
      [auth.sub, target.id]
    );
    if (existingPending.rows.length) return res.status(409).json({ error: 'Verzoek al verzonden' });

    const requestId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO native_friend_requests (id, from_user_id, to_user_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [requestId, auth.sub, target.id]
    );

    io?.to(target.id).emit('friend:request', {
      requestId,
      fromUserId: auth.sub,
      toUserId: target.id,
      status: 'pending',
    });
    io?.to(auth.sub).emit('contact-requests:updated', { reason: 'request_sent' });
    io?.to(target.id).emit('contact-requests:updated', { reason: 'request_received' });

    return res.json({ success: true, message: 'Contactverzoek verstuurd' });
  } catch (err) {
    console.error('Native contactverzoek fout:', err);
    return res.status(500).json({ error: 'Contact toevoegen mislukt.' });
  }
});

router.get('/contact-requests', async (req, res) => {
  const auth = decodeAccessToken(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  try {
    await ensureSchema();
    const result = await pool.query(
      `SELECT r.id AS request_id, r.status, r.created_at,
              fu.id AS from_id, fu.display_name AS from_name,
              tu.id AS to_id, tu.display_name AS to_name
       FROM native_friend_requests r
       JOIN native_users fu ON fu.id = r.from_user_id
       JOIN native_users tu ON tu.id = r.to_user_id
       WHERE r.status = 'pending' AND (r.from_user_id = $1 OR r.to_user_id = $1)
       ORDER BY r.created_at DESC`,
      [auth.sub]
    );

    const items = result.rows.map((row) => ({
      requestId: row.request_id,
      fromUser: {
        userId: row.from_id,
        displayName: row.from_name,
        avatarUrl: null,
        profilePhotoUrl: null,
      },
      toUser: {
        userId: row.to_id,
        displayName: row.to_name,
        avatarUrl: null,
        profilePhotoUrl: null,
      },
      status: row.status,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    }));

    return res.json(items);
  } catch (err) {
    console.error('Native contact requests ophalen fout:', err);
    return res.status(500).json({ error: 'Verzoeken ophalen mislukt.' });
  }
});

router.post('/contact-requests/:requestId/accept', async (req, res) => {
  const auth = decodeAccessToken(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  const requestId = String(req.params?.requestId || '').trim();
  if (!requestId) return res.status(400).json({ error: 'requestId ontbreekt.' });

  try {
    await ensureSchema();
    const found = await pool.query(
      `SELECT id, from_user_id, to_user_id, status
       FROM native_friend_requests
       WHERE id = $1
       LIMIT 1`,
      [requestId]
    );
    if (!found.rows.length) return res.status(404).json({ error: 'Verzoek niet gevonden' });
    const row = found.rows[0];
    if (row.to_user_id !== auth.sub) return res.status(403).json({ error: 'Geen toegang.' });
    if (row.status !== 'pending') return res.json({ success: true, message: 'Actie uitgevoerd' });

    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO native_contacts (owner_id, contact_id) VALUES ($1, $2) ON CONFLICT (owner_id, contact_id) DO NOTHING`,
      [row.to_user_id, row.from_user_id]
    );
    await pool.query(
      `INSERT INTO native_contacts (owner_id, contact_id) VALUES ($1, $2) ON CONFLICT (owner_id, contact_id) DO NOTHING`,
      [row.from_user_id, row.to_user_id]
    );
    await pool.query(
      `UPDATE native_friend_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
      [requestId]
    );
    await pool.query('COMMIT');

    io?.to(row.from_user_id).emit('friend:accepted', {
      requestId,
      byUserId: row.to_user_id,
      status: 'accepted',
    });
    io?.to(row.to_user_id).emit('contacts:updated', { reason: 'request_accepted' });
    io?.to(row.from_user_id).emit('contacts:updated', { reason: 'request_accepted' });
    io?.to(row.to_user_id).emit('contact-requests:updated', { reason: 'request_accepted' });
    io?.to(row.from_user_id).emit('contact-requests:updated', { reason: 'request_accepted' });

    return res.json({ success: true, message: 'Verzoek geaccepteerd' });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error('Native accept contact request fout:', err);
    return res.status(500).json({ error: 'Actie mislukt.' });
  }
});

router.post('/contact-requests/:requestId/decline', async (req, res) => {
  const auth = decodeAccessToken(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  const requestId = String(req.params?.requestId || '').trim();
  if (!requestId) return res.status(400).json({ error: 'requestId ontbreekt.' });

  try {
    await ensureSchema();
    const found = await pool.query(
      `SELECT id, to_user_id FROM native_friend_requests WHERE id = $1 AND status = 'pending' LIMIT 1`,
      [requestId]
    );
    if (!found.rows.length) return res.status(404).json({ error: 'Verzoek niet gevonden' });
    if (found.rows[0].to_user_id !== auth.sub) return res.status(403).json({ error: 'Geen toegang.' });

    const ownerFrom = await pool.query(
      `SELECT from_user_id, to_user_id FROM native_friend_requests WHERE id = $1 LIMIT 1`,
      [requestId]
    );
    await pool.query(
      `UPDATE native_friend_requests SET status = 'declined', updated_at = NOW() WHERE id = $1`,
      [requestId]
    );
    const eventRow = ownerFrom.rows[0];
    io?.to(eventRow.from_user_id).emit('friend:declined', {
      requestId,
      byUserId: eventRow.to_user_id,
      status: 'declined',
    });
    io?.to(eventRow.from_user_id).emit('contact-requests:updated', { reason: 'request_declined' });
    io?.to(eventRow.to_user_id).emit('contact-requests:updated', { reason: 'request_declined' });
    return res.json({ success: true, message: 'Verzoek geweigerd' });
  } catch (err) {
    console.error('Native decline contact request fout:', err);
    return res.status(500).json({ error: 'Actie mislukt.' });
  }
});

router.delete('/contact-requests/:requestId/cancel', async (req, res) => {
  const auth = decodeAccessToken(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  const requestId = String(req.params?.requestId || '').trim();
  if (!requestId) return res.status(400).json({ error: 'requestId ontbreekt.' });

  try {
    await ensureSchema();
    const found = await pool.query(
      `SELECT id, from_user_id FROM native_friend_requests WHERE id = $1 AND status = 'pending' LIMIT 1`,
      [requestId]
    );
    if (!found.rows.length) return res.status(404).json({ error: 'Verzoek niet gevonden' });
    if (found.rows[0].from_user_id !== auth.sub) return res.status(403).json({ error: 'Geen toegang.' });

    const ownerTo = await pool.query(
      `SELECT from_user_id, to_user_id FROM native_friend_requests WHERE id = $1 LIMIT 1`,
      [requestId]
    );
    await pool.query(
      `UPDATE native_friend_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [requestId]
    );
    const eventRow = ownerTo.rows[0];
    io?.to(eventRow.to_user_id).emit('friend:cancelled', {
      requestId,
      byUserId: eventRow.from_user_id,
      status: 'cancelled',
    });
    io?.to(eventRow.from_user_id).emit('contact-requests:updated', { reason: 'request_cancelled' });
    io?.to(eventRow.to_user_id).emit('contact-requests:updated', { reason: 'request_cancelled' });
    return res.json({ success: true, message: 'Verzoek geannuleerd' });
  } catch (err) {
    console.error('Native cancel contact request fout:', err);
    return res.status(500).json({ error: 'Actie mislukt.' });
  }
});

router.delete('/contacts/:contactId', async (req, res) => {
  const auth = decodeAccessToken(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL ontbreekt.' });

  const contactId = String(req.params?.contactId || '').trim();
  if (!contactId) return res.status(400).json({ error: 'contactId ontbreekt.' });
  if (contactId === auth.sub) return res.status(400).json({ error: 'Ongeldig verzoek.' });

  try {
    await ensureSchema();
    await pool.query(
      `DELETE FROM native_contacts WHERE owner_id = $1 AND contact_id = $2`,
      [auth.sub, contactId]
    );
    io?.to(auth.sub).emit('contacts:updated', { reason: 'contact_removed' });
    io?.to(contactId).emit('contacts:updated', { reason: 'contact_removed_by_other' });
    io?.to(contactId).emit('contact:removed', { byUserId: auth.sub, contactId });
    return res.json({ success: true });
  } catch (err) {
    console.error('Native contact verwijderen fout:', err);
    return res.status(500).json({ error: 'Contact verwijderen mislukt.' });
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
      `SELECT id, email, username, display_name, role FROM native_users WHERE id = $1 LIMIT 1`,
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
};
