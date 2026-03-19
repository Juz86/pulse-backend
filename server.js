const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const sendCodeLimiter  = rateLimit({ windowMs: 15 * 60 * 1000, max: 5,  message: { error: 'Te veel verzoeken, probeer later opnieuw.' } });
const friendReqLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: { error: 'Te veel verzoeken, probeer later opnieuw.' } });
const globalLimiter    = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Te veel verzoeken.' } });
const strictLimiter    = rateLimit({ windowMs: 60 * 60 * 1000, max: 5,   message: { error: 'Te veel verzoeken.' } });

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(e) { return typeof e === 'string' && EMAIL_REGEX.test(e.trim()); }

// ─── Firebase Admin initialiseren ───────────────────────────────────────────
// Vervang dit met jouw eigen serviceAccountKey.json bestand van Firebase
const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ─── Redis wachtrij (optioneel) ──────────────────────────────────────────────
let redis = null;
let redisReady = false;
try {
  const Redis = require('ioredis');
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      enableOfflineQueue: false,
      retryStrategy: () => null, // niet automatisch herhalen
    });
    redisClient.on('ready', () => {
      redis = redisClient;
      redisReady = true;
      console.log('✅ Redis verbonden');
    });
    redisClient.on('error', (err) => {
      console.warn('⚠️ Redis niet beschikbaar, fallback op Firestore:', err.message);
      redis = null;
      redisReady = false;
    });
    redisClient.on('reconnecting', () => {
      console.log('🔄 Redis herverbinden…');
    });
  } else {
    console.log('ℹ️ Geen REDIS_URL — berichtenwachtrij uitgeschakeld');
  }
} catch (e) {
  console.warn('⚠️ ioredis laden mislukt, fallback op Firestore:', e.message);
  redis = null;
}

/** Voeg bericht toe aan wachtrij voor offline ontvanger */
async function queueMessage(receiverUid, msg) {
  if (!redis) return;
  try {
    const key = `queue:${receiverUid}`;
    await redis.rpush(key, JSON.stringify(msg));
    await redis.expire(key, 7 * 24 * 60 * 60); // 7 dagen TTL
  } catch (e) {
    console.warn('Redis queueMessage mislukt:', e.message);
  }
}

/** Haal alle wachtende berichten op en verwijder de wachtrij */
async function flushQueue(receiverUid) {
  if (!redis) return [];
  try {
    const key = `queue:${receiverUid}`;
    const items = await redis.lrange(key, 0, -1);
    if (items.length) await redis.del(key);
    return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    console.warn('Redis flushQueue mislukt:', e.message);
    return [];
  }
}

/** Stuur push-notificatie naar één of meerdere apparaten van een gebruiker */
async function sendPush(uid, notification, data = {}) {
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();
    // Ondersteun zowel fcmTokens array (meerdere apparaten) als legacy fcmToken
    const tokens = [...new Set([
      ...(Array.isArray(userData.fcmTokens) ? userData.fcmTokens : []),
      ...(userData.fcmToken ? [userData.fcmToken] : []),
    ])];
    if (!tokens.length) return;
    // FCM data-velden moeten strings zijn
    const stringData = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification,
      data: stringData,
      webpush: { fcmOptions: { link: APP_URL } },
    });
    // Verwijder verlopen of ongeldige tokens automatisch
    const toRemove = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          toRemove.push(tokens[i]);
        }
      }
    });
    if (toRemove.length) {
      const updates = { fcmTokens: admin.firestore.FieldValue.arrayRemove(...toRemove) };
      if (toRemove.includes(userData.fcmToken)) updates.fcmToken = admin.firestore.FieldValue.delete();
      await db.collection('users').doc(uid).update(updates).catch(e => console.warn('FCM token cleanup mislukt:', e.message));
    }
    console.log(`📬 Push → ${uid}: ${response.successCount}/${tokens.length} bezorgd`);
  } catch (e) {
    console.warn(`Push mislukt voor ${uid}:`, e.message);
  }
}

// ─── E-mail transporter (Nodemailer via Gmail) ────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ─── OTP opslag in geheugen { email: { code, expiresAt } } ───────────────────
const otpStore = new Map();

// ─── App URL ──────────────────────────────────────────────────────────────────
const APP_URL = process.env.APP_URL;
if (!APP_URL) console.warn('⚠️ APP_URL niet ingesteld — stel dit in als de Cloudflare Pages URL in de Railway omgevingsvariabelen.');

// ─── Bijhouden actieve inkomende oproepen { calleeUid: { callerUid, callerName, isVideo } } ─
const pendingCalls  = {};
const activeCalls   = new Set(); // uid's die momenteel in een actief gesprek zitten
const inactiveUsers = new Set(); // uid's die online zijn maar inactief (3 min geen activiteit)

// ─── Express + HTTP + Socket.IO ──────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const FRONTEND_URL = process.env.FRONTEND_URL || APP_URL;

const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'], credentials: true },
});

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(globalLimiter);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
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

// ─── Gezondheidscheck ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Pulse server draait ✅', time: new Date().toISOString() });
});

// ─── OTP: Stuur verificatiecode ──────────────────────────────────────────────
app.post('/api/send-code', sendCodeLimiter, async (req, res) => {
  const { email } = req.body;
  if (!validEmail(email)) return res.status(400).json({ error: 'Ongeldig e-mailadres.' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(email, { code, expiresAt: Date.now() + 15 * 60 * 1000 });

  try {
    await transporter.sendMail({
      from: `"Pulse" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Jouw verificatiecode voor Pulse',
      html: `
        <div style="font-family:sans-serif;max-width:400px;margin:auto">
          <h2 style="color:#7c4dff">Pulse verificatiecode</h2>
          <p>Gebruik de onderstaande code om je account te bevestigen:</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#f3f0ff;border-radius:8px;color:#7c4dff">
            ${code}
          </div>
          <p style="color:#888;font-size:13px">Deze code is 15 minuten geldig en kan slechts één keer gebruikt worden.</p>
        </div>
      `,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('E-mail fout:', err);
    res.status(500).json({ error: 'E-mail versturen mislukt.' });
  }
});

// ─── OTP: Verifieer code ─────────────────────────────────────────────────────
app.post('/api/verify-code', strictLimiter, (req, res) => {
  const { email, code } = req.body;
  const entry = otpStore.get(email);
  if (!entry)                    return res.status(400).json({ error: 'Geen code gevonden. Vraag een nieuwe aan.' });
  if (Date.now() > entry.expiresAt) { otpStore.delete(email); return res.status(400).json({ error: 'Code verlopen.' }); }
  const a = Buffer.from(String(entry.code));
  const b = Buffer.from(String(code));
  const mismatch = a.length !== b.length || !crypto.timingSafeEqual(a, b);
  if (mismatch)                  return res.status(400).json({ error: 'Verkeerde code.' });
  otpStore.delete(email);
  res.json({ ok: true });
});

// ─── Wachtwoord reset mail (eigen stijl) ─────────────────────────────────────
app.post('/api/send-reset', sendCodeLimiter, async (req, res) => {
  const { email, actionUrl } = req.body;
  if (!validEmail(email)) return res.status(400).json({ error: 'Ongeldig e-mailadres.' });
  try {
    const resetLink = await admin.auth().generatePasswordResetLink(email, {
      url: actionUrl || 'http://localhost:3000',
    });
    await transporter.sendMail({
      from: `"Pulse" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Wachtwoord opnieuw instellen — Pulse',
      html: `
        <div style="font-family:sans-serif;max-width:440px;margin:auto;background:#13111a;border-radius:16px;padding:36px;color:#e2e0ff">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
            <span style="font-size:28px">💬</span>
            <span style="font-size:22px;font-weight:800;color:#a78bfa;letter-spacing:-0.5px">Pulse</span>
          </div>
          <h2 style="margin:0 0 12px;font-size:20px;color:#fff">Wachtwoord opnieuw instellen</h2>
          <p style="color:#9d9ab5;margin:0 0 28px;line-height:1.6">
            We hebben een verzoek ontvangen om het wachtwoord van je Pulse-account te wijzigen voor <strong style="color:#e2e0ff">${email}</strong>.
          </p>
          <a href="${resetLink}" style="display:block;text-align:center;background:linear-gradient(135deg,#7c6fff,#a855f7);color:#fff;text-decoration:none;padding:15px 24px;border-radius:12px;font-weight:700;font-size:15px;margin-bottom:24px">
            Wachtwoord wijzigen →
          </a>
          <p style="color:#6b6880;font-size:13px;line-height:1.6;margin:0">
            Als je dit niet hebt aangevraagd, kun je deze e-mail negeren.<br/>
            De link is 1 uur geldig.
          </p>
        </div>
      `,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset mail fout:', err);
    res.status(500).json({ error: 'E-mail versturen mislukt.' });
  }
});

// ─── REST: Gebruikersprofiel opslaan ─────────────────────────────────────────
app.post('/api/users', verifyAuth, async (req, res) => {
  try {
    const { uid, displayName, email, photoURL, role } = req.body;
    if (!uid || !validEmail(email)) return res.status(400).json({ error: 'uid en geldig e-mailadres zijn verplicht' });
    if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });

    const name = displayName || email.split('@')[0];
    const updateData = { uid, displayName: name, email, photoURL: photoURL || '', updatedAt: admin.firestore.FieldValue.serverTimestamp(), online: true };
    // Role mag alleen worden gezet als het account nog geen rol heeft (bij aanmaken)
    // Nooit overschrijven via client-request — voorkomt role-escalatie
    const existingDoc = await db.collection('users').doc(uid).get();
    if (!existingDoc.exists && role === 'parent') updateData.role = 'parent';
    else if (!existingDoc.exists) updateData.role = 'user';
    await db.collection('users').doc(uid).set(updateData, { merge: true });

    // memberNames bijwerken in alle gesprekken van deze gebruiker
    const convs = await db.collection('conversations').where('members', 'array-contains', uid).get();
    if (!convs.empty) {
      const batch = db.batch();
      convs.docs.forEach(d => batch.update(d.ref, { [`memberNames.${uid}`]: name }));
      await batch.commit();
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Gebruikersnaam opzoeken voor login (openbaar — geen auth) ──────────
app.get('/api/users/lookup-username', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Gebruikersnaam verplicht.' });
    const clean = username.trim().toLowerCase();
    const snap = await db.collection('users').where('username', '==', clean).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Gebruikersnaam niet gevonden.' });
    // Geef alleen terug dat de gebruiker bestaat — intern e-mailadres niet tonen
    res.json({ exists: true, email: `${clean}@pulse.internal` });
  } catch (err) { res.status(500).json({ error: 'Serverfout' }); }
});

// ─── REST: Gebruiker zoeken op email ─────────────────────────────────────────
app.get('/api/users/search', verifyAuth, async (req, res) => {
  try {
    const { email } = req.query;
    if (!validEmail(email)) return res.status(400).json({ error: 'Ongeldig e-mailadres.' });

    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Gebruiker niet gevonden' });

    const user = snap.docs[0].data();
    res.json({ uid: user.uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Gesprekken ophalen ─────────────────────────────────────────────────
app.get('/api/conversations/:uid', verifyAuth, async (req, res) => {
  try {
    const { uid } = req.params;
    if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });
    const snap = await db.collection('conversations')
      .where('members', 'array-contains', uid)
      .orderBy('updatedAt', 'desc')
      .limit(50)
      .get();

    const convs = snap.docs
      .filter(d => !(d.data().deletedFor || []).includes(uid))
      .map(d => ({ id: d.id, ...d.data() }));

    // Vul memberEmails aan voor gesprekken die het nog niet hebben
    const uidsNeeded = new Set();
    convs.forEach(c => {
      if (!c.isGroup && c.members) {
        c.members.forEach(m => {
          if (!c.memberEmails?.[m]) uidsNeeded.add(m);
        });
      }
    });
    const emailMap = {};
    if (uidsNeeded.size > 0) {
      try {
        const results = await admin.auth().getUsers([...uidsNeeded].map(u => ({ uid: u })));
        results.users.forEach(u => { emailMap[u.uid] = u.email; });
      } catch {}
    }
    convs.forEach(c => {
      if (!c.isGroup && c.members) {
        c.memberEmails = c.memberEmails || {};
        c.members.forEach(m => {
          if (!c.memberEmails[m] && emailMap[m]) c.memberEmails[m] = emailMap[m];
        });
      }
    });

    res.json(convs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Berichten ophalen ──────────────────────────────────────────────────
app.get('/api/messages/:convId', verifyAuth, async (req, res) => {
  try {
    const { convId } = req.params;
    const uid = req.uid;
    const limit = parseInt(req.query.limit) || 50;

    const convDoc = await db.collection('conversations').doc(convId).get();
    if (!convDoc.exists) return res.status(404).json({ error: 'Gesprek niet gevonden.' });
    const convData = convDoc.data();
    if (!(convData.members || []).includes(uid)) return res.status(403).json({ error: 'Geen toegang tot dit gesprek.' });

    let query = db.collection('conversations').doc(convId)
      .collection('messages')
      .orderBy('createdAt', 'desc')
      .limit(limit);

    const clearedAt = convData.clearedAt?.[uid];
    if (clearedAt) query = query.where('createdAt', '>', clearedAt);

    const snap = await query.get();
    const msgs = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(m => !(m.deletedFor || []).includes(uid))
      .reverse();
    res.json(msgs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Bericht verwijderen ───────────────────────────────────────────────
app.delete('/api/messages/:convId/:msgId', verifyAuth, async (req, res) => {
  try {
    const { convId, msgId } = req.params;
    const scope = req.query.scope === 'all' ? 'all' : 'self';
    const uid = req.uid;

    const convDoc2 = await db.collection('conversations').doc(convId).get();
    if (!convDoc2.exists || !(convDoc2.data().members || []).includes(uid)) return res.status(403).json({ error: 'Geen toegang tot dit gesprek.' });
    const msgRef = db.collection('conversations').doc(convId).collection('messages').doc(msgId);
    const msgDoc = await msgRef.get();
    if (!msgDoc.exists) return res.status(404).json({ error: 'Bericht niet gevonden' });

    if (scope === 'all') {
      // Alleen de afzender mag voor iedereen verwijderen
      if (msgDoc.data().senderId !== uid) return res.status(403).json({ error: 'Geen toegang.' });
      await msgRef.delete();
      // Stuur event naar iedereen in de room én rechtstreeks naar elk lid
      io.to(convId).emit('message:deleted', { convId, msgId });
      const convDoc = await db.collection('conversations').doc(convId).get();
      const members = convDoc.exists ? (convDoc.data().members || []) : [];
      members.forEach(memberUid => {
        const sockets = onlineUsers[memberUid];
        if (sockets) sockets.forEach(sid => io.to(sid).emit('message:deleted', { convId, msgId }));
      });
    } else {
      // Voor mezelf: voeg uid toe aan deletedFor array
      await msgRef.update({ deletedFor: admin.firestore.FieldValue.arrayUnion(uid) });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Gesprek verwijderen (soft delete per gebruiker) ───────────────────
app.delete('/api/conversations/:convId', verifyAuth, async (req, res) => {
  try {
    const { convId } = req.params;
    const uid = req.uid;

    const convRef = db.collection('conversations').doc(convId);
    const convDoc = await convRef.get();
    if (!convDoc.exists) return res.status(404).json({ error: 'Niet gevonden' });

    const { members = [], deletedFor = [] } = convDoc.data();
    const newDeletedFor = [...new Set([...deletedFor, uid])];

    if (members.every(m => newDeletedFor.includes(m))) {
      // Iedereen heeft verwijderd → echt verwijderen uit database
      const msgsSnap = await convRef.collection('messages').get();
      const batch = db.batch();
      msgsSnap.docs.forEach(doc => batch.delete(doc.ref));
      batch.delete(convRef);
      await batch.commit();
    } else {
      // Alleen voor deze gebruiker verbergen
      await convRef.update({
        deletedFor: admin.firestore.FieldValue.arrayUnion(uid),
        [`clearedAt.${uid}`]: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout bij verwijderen' });
  }
});


// ─── REST: Account verwijderen ───────────────────────────────────────────────
app.delete('/api/account/:uid', verifyAuth, strictLimiter, async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ error: 'uid is verplicht' });
    if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });

    // 1. Verwijder alle gesprekken waarbij de gebruiker lid is
    const convsSnap = await db.collection('conversations')
      .where('members', 'array-contains', uid).get();

    for (const convDoc of convsSnap.docs) {
      const convRef = convDoc.ref;
      const { members = [] } = convDoc.data();
      if (!Array.isArray(members)) continue;
      const msgsSnap = await convRef.collection('messages').get();
      const batch = db.batch();
      msgsSnap.docs.forEach(d => batch.delete(d.ref));
      if (members.length <= 2) {
        // 1-op-1 gesprek → volledig verwijderen
        batch.delete(convRef);
      } else {
        // Groepsgesprek → gebruiker verwijderen uit members
        batch.update(convRef, { members: members.filter(m => m !== uid) });
      }
      await batch.commit();
    }

    // 2. Verwijder contacten-subcollectie
    const contactsSnap = await db.collection('users').doc(uid).collection('contacts').get();
    const contactBatch = db.batch();
    contactsSnap.docs.forEach(d => contactBatch.delete(d.ref));
    await contactBatch.commit();

    // 3. Verwijder gebruikersdocument
    await db.collection('users').doc(uid).delete();

    // 4. Verwijder Firebase Auth account
    await admin.auth().deleteUser(uid);

    res.json({ success: true });
  } catch (err) {
    console.error('Account verwijderen mislukt:', err);
    res.status(500).json({ error: 'Serverfout bij verwijderen account' });
  }
});

// ─── Socket.IO: Realtime events ──────────────────────────────────────────────
// Bijhouden welke users online zijn: uid → Set van socket IDs
const onlineUsers = {};
function getSocketId(uid) {
  const sockets = onlineUsers[uid];
  return sockets?.size ? sockets.values().next().value : null;
}

// ── Socket.IO auth middleware ──────────────────────────────────────────────
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authenticatie vereist.'));
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    socket.userId = decoded.uid;
    next();
  } catch {
    next(new Error('Ongeldig token.'));
  }
});

io.on('connection', (socket) => {
  const uid = socket.userId;
  console.log('🔌 Verbonden:', socket.id, uid);

  // ── User registreren als online ──
  socket.on('user:online', async () => {
    if (!onlineUsers[uid]) onlineUsers[uid] = new Set();
    onlineUsers[uid].add(socket.id);
    socket.data.uid = uid;
    inactiveUsers.delete(uid); // Actief bij verbinding
    const userSnap = await db.collection('users').doc(uid).get().catch(() => null);
    await db.collection('users').doc(uid).update({ online: true, inactive: false, lastSeen: admin.firestore.FieldValue.serverTimestamp() }).catch(e => console.warn('Online-update mislukt:', e.message));
    io.emit('user:status', { uid, online: true, inactive: false });
    socket.emit('users:online', Object.keys(onlineUsers));
    socket.emit('users:inactive', [...inactiveUsers]);
    if (userSnap?.exists && userSnap.data()?.paused) socket.emit('account:paused');

    // ── Bezorg wachtende berichten uit Redis wachtrij ──
    const queued = await flushQueue(uid);
    if (queued.length > 0) {
      // Bezorg in chronologische volgorde
      for (const msg of queued) {
        socket.emit('message:received', msg);
      }
      // Markeer als bezorgd in Firestore (per gesprek, gegroepeerd voor efficiëntie)
      const byConv = {};
      queued.forEach(msg => {
        if (msg.convId && msg.id) {
          if (!byConv[msg.convId]) byConv[msg.convId] = [];
          byConv[msg.convId].push(msg);
        }
      });
      for (const [convId, msgs] of Object.entries(byConv)) {
        const batch = db.batch();
        msgs.forEach(msg => {
          const ref = db.collection('conversations').doc(convId).collection('messages').doc(msg.id);
          batch.update(ref, { status: 'bezorgd' });
        });
        batch.commit().catch(e => console.warn('Batch bezorgd-update mislukt:', e.message));
        // Notificeer verzenders dat berichten nu bezorgd zijn
        msgs.forEach(msg => {
          const senderSockets = onlineUsers[msg.senderId];
          if (senderSockets) {
            senderSockets.forEach(sid => io.to(sid).emit('message:status', { convId, msgId: msg.id, status: 'bezorgd' }));
          }
        });
      }
    }

    console.log(`👤 Online: ${uid}`);
  });

  // ── Stuur actuele online lijst op verzoek ──
  socket.on('users:online:request', () => {
    socket.emit('users:online', Object.keys(onlineUsers));
    socket.emit('users:inactive', [...inactiveUsers]);
  });

  // ── Inactiviteit detectie ──
  socket.on('user:inactive', async () => {
    inactiveUsers.add(uid);
    await db.collection('users').doc(uid).update({ inactive: true }).catch(e => console.warn('Inactief-update mislukt:', e.message));
    io.emit('user:status', { uid, online: true, inactive: true });
  });

  socket.on('user:active', async () => {
    inactiveUsers.delete(uid);
    await db.collection('users').doc(uid).update({ inactive: false }).catch(e => console.warn('Actief-update mislukt:', e.message));
    io.emit('user:status', { uid, online: true, inactive: false });
  });

  // ── Profielupdate broadcasten naar alle verbonden clients ──
  socket.on('user:updated', ({ displayName, photoURL }) => {
    socket.broadcast.emit('user:updated', { uid: socket.userId, displayName, photoURL });
  });

  // ── Video upgrade doorsturen naar de andere kant ──
  socket.on('call:video-upgrade', ({ to }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:video-upgrade');
  });

  // ── Oproep opslaan als bericht in gesprek ──
  socket.on('call:log', async ({ convId, isVideo, direction, duration }) => {
    try {
      if (!convId || !direction) return;
      const senderId = uid; // gebruik verified socket.userId
      const safeDuration = (typeof duration === 'number' && isFinite(duration) && duration >= 0) ? Math.round(duration) : 0;
      const userDoc = await db.collection('users').doc(senderId).get();
      const senderName = userDoc.exists ? (userDoc.data().displayName || '') : '';
      const msgRef = await db.collection('conversations').doc(convId)
        .collection('messages').add({
          type: 'call', isVideo: !!isVideo, direction, duration: safeDuration,
          senderId, senderName,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      const dur = safeDuration > 0
        ? (safeDuration >= 60 ? `${Math.floor(safeDuration / 60)} min` : `${safeDuration} sec`)
        : '';
      const label = direction === 'completed'
        ? (isVideo ? 'Video-oproep' : 'Spraakoproep') + (dur ? ` · ${dur}` : '')
        : direction === 'declined'
          ? (isVideo ? 'Video-oproep geweigerd' : 'Oproep geweigerd')
          : (isVideo ? 'Gemiste video-oproep' : 'Gemiste oproep');
      await db.collection('conversations').doc(convId).update({
        lastMessage:       label,
        lastMessageAt:     admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
        lastCallSenderId:  senderId,
        lastCallDirection: direction,
        lastCallIsVideo:   !!isVideo,
      });
      const savedMsg = { id: msgRef.id, convId, type: 'call', isVideo: !!isVideo, direction, duration: safeDuration, senderId, senderName };
      // Stuur naar iedereen in de room (als ze de chat open hebben)
      io.to(convId).emit('message:received', savedMsg);
      // Stuur ook rechtstreeks naar elk lid — ook als ze de chat niet open hebben
      const convDoc = await db.collection('conversations').doc(convId).get();
      const members = convDoc.exists ? (convDoc.data().members || []) : [];
      members.forEach(uid => {
        if (uid === senderId) return; // beller heeft al optimistisch bericht
        const sockets = onlineUsers[uid];
        if (sockets) sockets.forEach(sid => io.to(sid).emit('message:received', savedMsg));
      });
    } catch (e) {
      console.error('call:log fout:', e);
    }
  });

  // ── Gesprek / kamer joinen ──
  socket.on('conversation:join', async ({ convId }) => {
    try {
      const convDoc = await db.collection('conversations').doc(convId).get();
      if (!convDoc.exists || !(convDoc.data().members || []).includes(uid)) return;
      socket.join(convId);
    } catch {}
  });

  // ── Bericht sturen ──
  socket.on('message:send', async ({ convId, message }, callback) => {
    try {
      // Blokkeer gepauzeerde accounts + verifieer lidmaatschap
      const [senderDoc, convMemberDoc] = await Promise.all([
        db.collection('users').doc(uid).get(),
        db.collection('conversations').doc(convId).get(),
      ]);
      if (senderDoc.exists && senderDoc.data().paused) {
        if (typeof callback === 'function') callback({ error: 'Account gepauzeerd.' });
        return;
      }
      if (!convMemberDoc.exists || !(convMemberDoc.data().members || []).includes(uid)) {
        if (typeof callback === 'function') callback({ error: 'Geen toegang tot dit gesprek.' });
        return;
      }
      const verifiedMessage = { ...message, senderId: socket.userId };
      const lastMessage = verifiedMessage.type === 'contact'
        ? `Contactpersoon: ${verifiedMessage.sharedContact?.name || ''}`
        : verifiedMessage.type === 'call' ? (verifiedMessage.isVideo ? 'Video-oproep' : 'Spraakoproep')
        : verifiedMessage.text;

      // Sla bericht op en update gesprek tegelijk (parallel)
      const [msgRef] = await Promise.all([
        db.collection('conversations').doc(convId).collection('messages').add({
          ...verifiedMessage,
          status: 'verstuurd',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
        db.collection('conversations').doc(convId).update({
          lastMessage,
          lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          deletedFor: [],  // Herstel gesprek voor iedereen die het had verwijderd
        }),
      ]);

      const savedMsg = { id: msgRef.id, ...verifiedMessage, status: 'verstuurd' };

      // Stuur bericht naar iedereen in de kamer (inclusief afzender)
      io.to(convId).emit('message:received', savedMsg);

      // Bevestig aan afzender zodat optimistic bericht vervangen kan worden
      if (typeof callback === 'function') callback(savedMsg);

      // Push notificaties + bezorgstatus asynchroon — blokkeert de socket handler niet
      (async () => {
        try {
          const convDoc = await db.collection('conversations').doc(convId).get();
          const members = convDoc.data()?.members || [];
          const senderName = verifiedMessage.senderName || 'Iemand';

          // Stuur ook rechtstreeks naar elk lid (ook als ze de chat niet open hebben)
          let anyReceiverOnline = false;
          members.forEach(memberUid => {
            if (memberUid === verifiedMessage.senderId) return;
            const sockets = onlineUsers[memberUid];
            if (sockets) {
              anyReceiverOnline = true;
              sockets.forEach(sid => io.to(sid).emit('message:received', savedMsg));
            }
          });

          // Als ontvanger online is → markeer als bezorgd in Firestore en notificeer verzender
          if (anyReceiverOnline) {
            await msgRef.update({ status: 'bezorgd' });
            socket.emit('message:status', { convId, msgId: savedMsg.id, status: 'bezorgd' });
          }

          const offlineMembers = members.filter(memberUid =>
            memberUid !== verifiedMessage.senderId && !onlineUsers[memberUid]?.size
          );
          // Verwerk in batches van 5 om Firestore/FCM overbelasting te voorkomen
          const BATCH_SIZE = 5;
          for (let i = 0; i < offlineMembers.length; i += BATCH_SIZE) {
            const batch = offlineMembers.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (memberUid) => {
              await queueMessage(memberUid, savedMsg);
              await sendPush(memberUid,
                { title: senderName, body: verifiedMessage.text?.substring(0, 100) || 'Nieuw bericht' },
                { convId }
              );
            }));
          }

          // @vermeldingen verwerken
          const mentionedUids = Array.isArray(verifiedMessage.mentions) ? verifiedMessage.mentions : [];
          if (mentionedUids.length > 0 && convDoc.data()?.isGroup) {
            const groupName = convDoc.data()?.groupName || 'een groep';
            for (const mentionedUid of mentionedUids) {
              if (mentionedUid === verifiedMessage.senderId) continue;
              if (!members.includes(mentionedUid)) continue;
              const mentionedSockets = onlineUsers[mentionedUid];
              if (mentionedSockets) {
                mentionedSockets.forEach(sid => io.to(sid).emit('mention:notify', {
                  convId, senderName, groupName,
                }));
              } else {
                sendPush(mentionedUid,
                  { title: `${senderName} heeft je vermeld`, body: `In ${groupName}: ${verifiedMessage.text?.substring(0, 80) || ''}` },
                  { convId }
                ).catch(e => console.warn('mention push mislukt:', e.message));
              }
            }
          }
        } catch (e) { console.warn('Push/bezorgstatus fout na message:send:', e.message); }
      })();
    } catch (err) {
      console.error('Fout bij opslaan bericht:', err);
      socket.emit('error', { message: 'Bericht kon niet worden opgeslagen' });
    }
  });

  // ── Emoji-reactie op bericht ──
  socket.on('message:react', async ({ convId, msgId, emoji }, callback) => {
    try {
      const convDoc = await db.collection('conversations').doc(convId).get();
      if (!convDoc.exists || !(convDoc.data().members || []).includes(uid)) return callback?.({ error: 'Geen toegang.' });

      const msgRef = db.collection('conversations').doc(convId).collection('messages').doc(msgId);
      const msgDoc = await msgRef.get();
      if (!msgDoc.exists) return callback?.({ error: 'Bericht niet gevonden.' });

      const currentReactors = (msgDoc.data().reactions || {})[emoji] || [];
      const hasReacted = currentReactors.includes(uid);
      const field = `reactions.${emoji}`;
      await msgRef.update({
        [field]: hasReacted
          ? admin.firestore.FieldValue.arrayRemove(uid)
          : admin.firestore.FieldValue.arrayUnion(uid),
      });

      const updatedReactions = (await msgRef.get()).data().reactions || {};
      const payload = { convId, msgId, reactions: updatedReactions };
      io.to(convId).emit('message:reaction', payload);
      const members = convDoc.data().members || [];
      members.forEach(memberUid => {
        const sockets = onlineUsers[memberUid];
        if (sockets) sockets.forEach(sid => io.to(sid).emit('message:reaction', payload));
      });
      callback?.({ success: true });
    } catch (err) {
      console.error('Fout bij reactie:', err);
      callback?.({ error: 'Serverfout' });
    }
  });

  // ── Bericht bewerken ──
  socket.on('message:edit', async ({ convId, msgId, newText }, callback) => {
    try {
      const trimmed = newText?.trim();
      if (!trimmed) return callback?.({ error: 'Bericht mag niet leeg zijn.' });

      const msgRef = db.collection('conversations').doc(convId).collection('messages').doc(msgId);
      const msgDoc = await msgRef.get();
      if (!msgDoc.exists) return callback?.({ error: 'Bericht niet gevonden.' });
      if (msgDoc.data().senderId !== uid) return callback?.({ error: 'Alleen eigen berichten bewerken.' });
      if (msgDoc.data().type && msgDoc.data().type !== 'text') return callback?.({ error: 'Dit bericht kan niet bewerkt worden.' });

      const editedAt = new Date().toISOString();
      await msgRef.update({ text: trimmed, editedAt });

      const payload = { convId, msgId, text: trimmed, editedAt };
      io.to(convId).emit('message:edited', payload);
      const convDoc = await db.collection('conversations').doc(convId).get();
      const members = convDoc.exists ? (convDoc.data().members || []) : [];
      members.forEach(memberUid => {
        const sockets = onlineUsers[memberUid];
        if (sockets) sockets.forEach(sid => io.to(sid).emit('message:edited', payload));
      });

      callback?.({ success: true });
    } catch (err) {
      console.error('Fout bij bewerken bericht:', err);
      callback?.({ error: 'Serverfout' });
    }
  });

  // ── Typen indicator ──
  socket.on('typing:start', ({ convId, name }) => {
    socket.to(convId).emit('typing:update', { uid, name, typing: true });
  });

  socket.on('typing:stop', ({ convId }) => {
    socket.to(convId).emit('typing:update', { uid, typing: false });
  });

  // ── WebRTC Signaling: Bellen ──
  socket.on('call:offer', async ({ to, from, offer, isVideo, callerName }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) {
      // Controleer of ontvanger al in een actief gesprek zit
      if (activeCalls.has(to)) {
        socket.emit('call:busy', { to });
        return;
      }
      io.to(targetSocket).emit('call:incoming', { from, offer, isVideo, callerName });
      // Bijhouden dat deze oproep uitstaat (nog niet beantwoord)
      pendingCalls[to] = { from, callerName, isVideo };
    } else {
      socket.emit('call:unavailable', { to });
      // Gebruiker is offline → gemiste oproep notificatie
      sendPush(to,
        { title: '📞 Gemiste oproep', body: `${callerName} heeft je ${isVideo ? 'geprobeerd te videobellen' : 'gebeld'}.` },
        { type: 'missed_call' }
      );
    }
  });

  socket.on('call:answer', ({ to, answer }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:answer', { answer });
    // Oproep beantwoord → beide users zijn nu in een actief gesprek
    activeCalls.add(socket.data.uid);
    activeCalls.add(to);
    delete pendingCalls[socket.data.uid];
    delete pendingCalls[to];
  });

  socket.on('call:ice-candidate', ({ to, candidate }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:ice-candidate', { candidate });
  });

  socket.on('call:end', async ({ to }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:ended');
    // Beide users zijn niet meer in een actief gesprek
    activeCalls.delete(socket.data.uid);
    activeCalls.delete(to);
    // Als oproep nog uitstond (niet beantwoord) → gemiste oproep notificatie
    if (pendingCalls[to]) {
      const { callerName, isVideo } = pendingCalls[to];
      delete pendingCalls[to];
      sendPush(to,
        { title: '📞 Gemiste oproep', body: `${callerName} heeft je ${isVideo ? 'geprobeerd te videobellen' : 'gebeld'}.` },
        { type: 'missed_call' }
      );
    }
  });

  socket.on('call:decline', ({ to }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:declined');
    // Bewust geweigerd → geen gemiste oproep
    activeCalls.delete(socket.data.uid);
    activeCalls.delete(to);
    delete pendingCalls[socket.data.uid];
    delete pendingCalls[to];
  });

  socket.on('call:renegotiate', ({ to, signal }) => {
    const targetSocket = getSocketId(to);
    if (targetSocket) io.to(targetSocket).emit('call:renegotiate', { signal });
  });

  // ── Gesprek aanmaken ──
  socket.on('conversation:create', async ({ members, memberNames, memberEmails, isGroup, groupName }, callback) => {
    try {
      // Check of 1-op-1 gesprek al bestaat
      if (!isGroup && members.length === 2) {
        const existing = await db.collection('conversations')
          .where('members', 'array-contains', members[0])
          .where('isGroup', '==', false)
          .get();

        for (const doc of existing.docs) {
          const data = doc.data();
          if (data.members.includes(members[1])) {
            const deletedFor = data.deletedFor || [];
            const requestingUid = members[0];
            if (deletedFor.includes(requestingUid)) {
              await doc.ref.update({
                deletedFor: admin.firestore.FieldValue.arrayRemove(requestingUid),
                [`clearedAt.${requestingUid}`]: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
            return callback({ convId: doc.id, existing: true });
          }
        }
      }

      const convRef = await db.collection('conversations').add({
        members,
        memberNames,
        memberEmails: memberEmails || {},
        isGroup: isGroup || false,
        groupName: groupName || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessage: null,
      });

      callback({ convId: convRef.id, existing: false });
    } catch (err) {
      console.error(err);
      callback({ error: 'Gesprek kon niet worden aangemaakt' });
    }
  });

  // ── Berichtenstatus: gelezen ──
  socket.on('messages:read', async ({ convId }) => {
    try {
      // Haal gesprekleden op om verzenders te notificeren
      const convDoc = await db.collection('conversations').doc(convId).get();
      const members = convDoc.exists ? (convDoc.data().members || []) : [];
      const senderUids = members.filter(m => m !== uid);

      // Batch-update alle ongelezen berichten van anderen naar 'gelezen'
      const snap = await db.collection('conversations').doc(convId)
        .collection('messages')
        .where('status', 'in', ['verstuurd', 'bezorgd'])
        .get();

      if (!snap.empty) {
        const batch = db.batch();
        snap.docs.forEach(doc => {
          if (doc.data().senderId !== uid) batch.update(doc.ref, { status: 'gelezen' });
        });
        await batch.commit();
      }

      // Notificeer verzenders direct via onlineUsers
      senderUids.forEach(senderUid => {
        const sockets = onlineUsers[senderUid];
        if (sockets) sockets.forEach(sid => io.to(sid).emit('message:status', { convId, status: 'gelezen' }));
      });
    } catch (e) {
      console.error('messages:read error:', e);
    }
  });

  // ── Groepslid toevoegen ──
  socket.on('conversation:addMember', async ({ convId, uid: targetUid, displayName }, cb) => {
    try {
      const convDoc = await db.collection('conversations').doc(convId).get();
      if (!convDoc.exists || !(convDoc.data().members || []).includes(uid)) { cb?.({ error: 'Geen toegang.' }); return; }
      await db.collection('conversations').doc(convId).update({
        members: admin.firestore.FieldValue.arrayUnion(targetUid),
        [`memberNames.${targetUid}`]: displayName,
      });
      io.to(convId).emit('conversation:memberAdded', { convId, uid: targetUid, displayName });
      cb?.({});
    } catch (e) { cb?.({ error: e.message }); }
  });

  // ── Groepslid verwijderen ──
  socket.on('conversation:removeMember', async ({ convId, uid: targetUid }, cb) => {
    try {
      const convDoc = await db.collection('conversations').doc(convId).get();
      if (!convDoc.exists || !(convDoc.data().members || []).includes(uid)) { cb?.({ error: 'Geen toegang.' }); return; }
      const update = { members: admin.firestore.FieldValue.arrayRemove(targetUid) };
      update[`memberNames.${targetUid}`] = admin.firestore.FieldValue.delete();
      await db.collection('conversations').doc(convId).update(update);
      io.to(convId).emit('conversation:memberRemoved', { convId, uid: targetUid });
      cb?.({});
    } catch (e) { cb?.({ error: e.message }); }
  });

  
  // ── Verbreken ──
  socket.on('disconnect', async () => {
    const uid = socket.data.uid;
    if (uid) {
      onlineUsers[uid]?.delete(socket.id);
      activeCalls.delete(uid);
      if (!onlineUsers[uid]?.size) {
        delete onlineUsers[uid];
        inactiveUsers.delete(uid);
        await db.collection('users').doc(uid).update({ online: false, inactive: false, lastSeen: admin.firestore.FieldValue.serverTimestamp() }).catch(e => console.warn('Offline-update mislukt:', e.message));
        io.emit('user:status', { uid, online: false });
      }
      console.log(`👋 Offline: ${uid}`);
    }
  });
});

// ─── REST: Ouderlijk toezicht ─────────────────────────────────────────────────

// GET /api/parent/children — haal gekoppelde kinderen op
app.get('/api/parent/children', verifyAuth, async (req, res) => {
  try {
    const parentDoc = await db.collection('users').doc(req.uid).get();
    if (!parentDoc.exists || parentDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
    const snap = await db.collection('users').where('parentId', '==', req.uid).get();
    const children = snap.docs.map(d => {
      const { uid, displayName, username, email, photoURL, online, lastSeen, paused } = d.data();
      return { uid, displayName, username: username || null, email, photoURL: photoURL || null, online: online || false, lastSeen: lastSeen || null, paused: paused || false };
    });
    res.json(children);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
});

// POST /api/parent/create-child — ouder maakt kindaccount direct aan
app.post('/api/parent/create-child', verifyAuth, async (req, res) => {
  try {
    const parentDoc = await db.collection('users').doc(req.uid).get();
    if (!parentDoc.exists || parentDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
    const parentData = parentDoc.data();

    const { name, username, password } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Naam is verplicht.' });
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Gebruikersnaam is verplicht.' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Wachtwoord moet minimaal 6 tekens zijn.' });

    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{2,30}$/.test(cleanUsername)) {
      return res.status(400).json({ error: 'Gebruikersnaam mag alleen letters, cijfers en _ bevatten (2-30 tekens).' });
    }

    // Controleer of gebruikersnaam al in gebruik is
    const existing = await db.collection('users').where('username', '==', cleanUsername).limit(1).get();
    if (!existing.empty) {
      // Controleer of het bijbehorende Firebase Auth account nog bestaat (stale cleanup)
      const existingUid = existing.docs[0].id;
      let authExists = true;
      try { await admin.auth().getUser(existingUid); } catch { authExists = false; }
      if (!authExists) {
        await db.collection('users').doc(existingUid).delete();
      } else {
        return res.status(400).json({ error: 'Deze gebruikersnaam is al in gebruik.' });
      }
    }

    const internalEmail = `${cleanUsername}@pulse.internal`;

    // Maak Firebase Auth account aan via Admin SDK
    const newUser = await admin.auth().createUser({
      email:       internalEmail,
      password,
      displayName: name.trim(),
    });

    // Sla kindprofiel op in Firestore
    await db.collection('users').doc(newUser.uid).set({
      uid:         newUser.uid,
      displayName: name.trim(),
      username:    cleanUsername,
      email:       internalEmail,
      photoURL:    '',
      role:        'child',
      parentId:    req.uid,
      parentEmail: parentData.email,
      online:      false,
      paused:      false,
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    });

    // Voeg wederzijds als contact toe
    const batch = db.batch();
    batch.set(db.collection('users').doc(newUser.uid).collection('contacts').doc(req.uid), {
      uid: req.uid, displayName: parentData.displayName || parentData.email,
      email: parentData.email, photoURL: parentData.photoURL || null, addedAt: new Date().toISOString(),
    });
    batch.set(db.collection('users').doc(req.uid).collection('contacts').doc(newUser.uid), {
      uid: newUser.uid, displayName: name.trim(),
      email: internalEmail, photoURL: null, addedAt: new Date().toISOString(),
    });
    await batch.commit();

    res.json({ success: true, uid: newUser.uid, displayName: name.trim(), username: cleanUsername, online: false, paused: false });
  } catch (err) {
    console.error('create-child fout:', err);
    if (err.code === 'auth/email-already-exists') return res.status(400).json({ error: 'Deze gebruikersnaam is al in gebruik.' });
    res.status(500).json({ error: 'Serverfout' });
  }
});

// POST /api/parent/change-child-password/:childUid — ouder wijzigt wachtwoord van kind
app.post('/api/parent/change-child-password/:childUid', verifyAuth, async (req, res) => {
  try {
    const { childUid } = req.params;
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Wachtwoord moet minimaal 6 tekens zijn.' });
    const childDoc = await db.collection('users').doc(childUid).get();
    if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
    if (childDoc.data().role !== 'child') return res.status(403).json({ error: 'Alleen kindaccounts worden ondersteund.' });
    if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });
    await admin.auth().updateUser(childUid, { password });
    res.json({ success: true });
  } catch (err) { console.error('change-child-password fout:', err); res.status(500).json({ error: 'Serverfout' }); }
});

// DELETE /api/parent/delete-child/:childUid — ouder verwijdert kindaccount
app.delete('/api/parent/delete-child/:childUid', verifyAuth, async (req, res) => {
  try {
    const callerDoc = await db.collection('users').doc(req.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
    const { childUid } = req.params;
    const childDoc = await db.collection('users').doc(childUid).get();
    if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
    const childData = childDoc.data();
    if (childData.parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });
    if (childData.role !== 'child') return res.status(403).json({ error: 'Alleen kindaccounts kunnen worden verwijderd via dit endpoint.' });

    // Verwijder gesprekken
    const convsSnap = await db.collection('conversations').where('members', 'array-contains', childUid).get();
    for (const convDoc of convsSnap.docs) {
      const { members = [] } = convDoc.data();
      const msgsSnap = await convDoc.ref.collection('messages').get();
      const batch = db.batch();
      msgsSnap.docs.forEach(d => batch.delete(d.ref));
      if (members.length <= 2) batch.delete(convDoc.ref);
      else batch.update(convDoc.ref, { members: members.filter(m => m !== childUid) });
      await batch.commit();
    }

    // Verwijder contacten-subcollectie
    const contactsSnap = await db.collection('users').doc(childUid).collection('contacts').get();
    if (!contactsSnap.empty) {
      const batch = db.batch();
      contactsSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    // Verwijder Firestore document + Firebase Auth account
    await db.collection('users').doc(childUid).delete();
    await admin.auth().deleteUser(childUid);

    res.json({ success: true });
  } catch (err) { console.error('delete-child fout:', err); res.status(500).json({ error: 'Serverfout' }); }
});

// POST /api/parent/pause/:childUid — pauzeer kind
app.post('/api/parent/pause/:childUid', verifyAuth, async (req, res) => {
  try {
    const callerDoc = await db.collection('users').doc(req.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
    const { childUid } = req.params;
    const childDoc = await db.collection('users').doc(childUid).get();
    if (!childDoc.exists) return res.status(404).json({ error: 'Niet gevonden.' });
    if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });
    await db.collection('users').doc(childUid).update({ paused: true });
    const s = onlineUsers[childUid];
    if (s) s.forEach(sid => {
      io.to(sid).emit('account:paused');
      // Beëindig actieve oproep als kind in gesprek zit
      if (activeCalls.has(childUid)) io.to(sid).emit('call:ended');
    });
    activeCalls.delete(childUid);
    sendPush(childUid,
      { title: 'Pulse', body: 'Je account is gepauzeerd door je ouder.' },
      { type: 'paused' }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Serverfout' }); }
});

// POST /api/parent/resume/:childUid — hervat kind
app.post('/api/parent/resume/:childUid', verifyAuth, async (req, res) => {
  try {
    const callerDoc = await db.collection('users').doc(req.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
    const { childUid } = req.params;
    const childDoc = await db.collection('users').doc(childUid).get();
    if (!childDoc.exists) return res.status(404).json({ error: 'Niet gevonden.' });
    if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });
    await db.collection('users').doc(childUid).update({ paused: false });
    const s = onlineUsers[childUid];
    if (s) s.forEach(sid => io.to(sid).emit('account:resumed'));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Serverfout' }); }
});

// GET /api/parent/activities — haal activiteiten op voor ouder
app.get('/api/parent/activities', verifyAuth, async (req, res) => {
  try {
    const callerDoc = await db.collection('users').doc(req.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
    const snap = await db.collection('parentActivities')
      .where('parentId', '==', req.uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    const activities = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt || null }));
    res.json(activities);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
});

// ─── REST: FCM token opslaan ─────────────────────────────────────────────────
app.post('/api/fcm-token', verifyAuth, async (req, res) => {
  try {
    const { uid, token } = req.body;
    if (!uid || !token) return res.status(400).json({ error: 'uid en token verplicht' });
    if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });
    await db.collection('users').doc(uid).update({
      fcmToken:  token,  // legacy — backward compat
      fcmTokens: admin.firestore.FieldValue.arrayUnion(token),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Vriendschapsverzoek sturen ────────────────────────────────────────
app.post('/api/friend-requests', verifyAuth, friendReqLimiter, async (req, res) => {
  try {
    const { fromUid, fromName, fromEmail, fromPhoto, toEmail } = req.body;
    if (!fromUid || !validEmail(toEmail)) return res.status(400).json({ error: 'fromUid en geldig toEmail zijn verplicht' });
    if (req.uid !== fromUid) return res.status(403).json({ error: 'Geen toegang.' });

    // Zoek de ontvanger op email
    const snap = await db.collection('users').where('email', '==', toEmail).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    const toUser = snap.docs[0].data();

    if (toUser.uid === fromUid) return res.status(400).json({ error: 'Je kunt jezelf niet toevoegen' });

    // Check of ze al contacten zijn
    const alreadyA = await db.collection('users').doc(fromUid).collection('contacts').doc(toUser.uid).get();
    if (alreadyA.exists) return res.status(400).json({ error: 'Al in contactenlijst' });

    // Als de ander jou nog heeft → direct herstellen zonder nieuw verzoek
    const alreadyB = await db.collection('users').doc(toUser.uid).collection('contacts').doc(fromUid).get();
    if (alreadyB.exists) {
      const nickname = req.body.nickname || '';
      const batch = db.batch();
      batch.set(db.collection('users').doc(fromUid).collection('contacts').doc(toUser.uid), {
        uid: toUser.uid, displayName: toUser.displayName, email: toUser.email,
        photoURL: toUser.photoURL || null, nickname,
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await batch.commit();
      return res.json({ success: true, restored: true, toUid: toUser.uid });
    }

    // Check of er al een pending verzoek bestaat
    const existing = await db.collection('friendRequests')
      .where('fromUid', '==', fromUid)
      .where('toUid', '==', toUser.uid)
      .where('status', '==', 'pending')
      .limit(1).get();
    if (!existing.empty) return res.status(400).json({ error: 'Verzoek al verzonden' });

    // Maak het verzoek aan
    const reqRef = await db.collection('friendRequests').add({
      fromUid, fromName, fromEmail, fromPhoto: fromPhoto || null,
      toUid: toUser.uid, toName: toUser.displayName, toEmail: toUser.email,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Stuur realtime notificatie naar ontvanger
    const targetSocket = getSocketId(toUser.uid);
    if (targetSocket) {
      io.to(targetSocket).emit('friend:request', {
        id: reqRef.id, fromUid, fromName, fromEmail, fromPhoto: fromPhoto || null,
      });
    }

    // Activiteit opslaan + ouder realtime notificeren als kind een verzoek stuurt
    db.collection('users').doc(fromUid).get().then(senderDoc => {
      const parentId = senderDoc.data()?.parentId;
      if (!parentId) return;
      const description = `${fromName} heeft een vriendschapsverzoek verstuurd naar ${toUser.displayName || toEmail}.`;
      db.collection('parentActivities').add({
        parentId, childUid: fromUid, childName: fromName,
        type: 'friend_request_sent', description,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => console.warn('parentActivities opslaan mislukt (sent):', e.message));
      const parentSocket = getSocketId(parentId);
      if (parentSocket) io.to(parentSocket).emit('parent:activity', { type: 'friend_request_sent', description, childName: fromName });
    }).catch(e => console.warn('Ouder ophalen mislukt (sent):', e.message));
    res.json({ success: true, requestId: reqRef.id, toUid: toUser.uid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Vriendschapsverzoeken ophalen voor een gebruiker ──────────────────
app.get('/api/friend-requests/:uid', verifyAuth, async (req, res) => {
  try {
    const { uid } = req.params;
    if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });
    const snap = await db.collection('friendRequests')
      .where('toUid', '==', uid)
      .where('status', '==', 'pending')
      .get();
    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    requests.sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    res.json(requests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Vriendschapsverzoek accepteren ─────────────────────────────────────
app.post('/api/friend-requests/:requestId/accept', verifyAuth, async (req, res) => {
  try {
    const { requestId } = req.params;
    const reqDoc = await db.collection('friendRequests').doc(requestId).get();
    if (!reqDoc.exists) return res.status(404).json({ error: 'Verzoek niet gevonden' });
    const { fromUid, fromName, fromEmail, fromPhoto, toUid, toName, toEmail } = reqDoc.data();
    if (req.uid !== toUid) return res.status(403).json({ error: 'Geen toegang.' });

    const batch = db.batch();
    // Voeg toe aan beiden contactenlijst
    batch.set(db.collection('users').doc(toUid).collection('contacts').doc(fromUid), {
      uid: fromUid, displayName: fromName, email: fromEmail, photoURL: fromPhoto || null,
      addedAt: new Date().toISOString(),
    });
    batch.set(db.collection('users').doc(fromUid).collection('contacts').doc(toUid), {
      uid: toUid, displayName: toName, email: toEmail, photoURL: null,
      addedAt: new Date().toISOString(),
    });
    // Verzoek als geaccepteerd markeren
    batch.update(db.collection('friendRequests').doc(requestId), { status: 'accepted' });
    await batch.commit();

    // Notificeer de verzender realtime
    const senderSocket = getSocketId(fromUid);
    if (senderSocket) {
      io.to(senderSocket).emit('friend:accepted', { byUid: toUid, byName: toName, byEmail: toEmail });
    }

    // Activiteit opslaan + ouder realtime notificeren als kind een verzoek accepteert
    db.collection('users').doc(toUid).get().then(acceptorDoc => {
      const parentId = acceptorDoc.data()?.parentId;
      if (!parentId) return;
      const description = `${toName} heeft een vriendschapsverzoek van ${fromName} geaccepteerd.`;
      db.collection('parentActivities').add({
        parentId, childUid: toUid, childName: toName,
        type: 'friend_request_accepted', description,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => console.warn('parentActivities opslaan mislukt (accepted):', e.message));
      const parentSocket = getSocketId(parentId);
      if (parentSocket) io.to(parentSocket).emit('parent:activity', { type: 'friend_request_accepted', description, childName: toName });
    }).catch(e => console.warn('Ouder ophalen mislukt (accepted):', e.message));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Vriendschapsverzoek weigeren ──────────────────────────────────────
app.post('/api/friend-requests/:requestId/decline', verifyAuth, async (req, res) => {
  try {
    const { requestId } = req.params;
    const reqDoc = await db.collection('friendRequests').doc(requestId).get();
    if (!reqDoc.exists) return res.status(404).json({ error: 'Verzoek niet gevonden' });
    if (req.uid !== reqDoc.data().toUid) return res.status(403).json({ error: 'Geen toegang.' });
    await db.collection('friendRequests').doc(requestId).update({ status: 'declined' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── Automatisch opschonen: berichten ouder dan 30 dagen ─────────────────────
async function cleanupOldMessages() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffTs = admin.firestore.Timestamp.fromDate(cutoff);

  try {
    const convsSnap = await db.collection('conversations').get();
    let totalDeleted = 0;

    for (const convDoc of convsSnap.docs) {
      const oldMsgs = await convDoc.ref.collection('messages')
        .where('createdAt', '<', cutoffTs)
        .get();

      if (oldMsgs.empty) continue;

      // Verwijder in batches van 500 (Firestore limiet)
      const chunks = [];
      for (let i = 0; i < oldMsgs.docs.length; i += 500) {
        chunks.push(oldMsgs.docs.slice(i, i + 500));
      }
      for (const chunk of chunks) {
        const batch = db.batch();
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
        totalDeleted += chunk.length;
      }
    }

    console.log(`🧹 Opschonen klaar: ${totalDeleted} berichten verwijderd`);
  } catch (err) {
    console.error('Opschonen mislukt:', err);
  }
}

// Dagelijks uitvoeren (elke 24 uur), en direct bij opstarten
cleanupOldMessages();
setInterval(cleanupOldMessages, 24 * 60 * 60 * 1000);

// ─── Server starten ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Pulse server draait op poort ${PORT}`);
});
