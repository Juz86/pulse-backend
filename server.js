const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');

// ─── Firebase Admin initialiseren ───────────────────────────────────────────
// Vervang dit met jouw eigen serviceAccountKey.json bestand van Firebase
const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ─── Express + HTTP + Socket.IO ──────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',        // In productie: vervang * door jouw domeinnaam
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

// ─── Gezondheidscheck ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Pulse server draait ✅', time: new Date().toISOString() });
});

// ─── REST: Gebruikersprofiel opslaan ─────────────────────────────────────────
app.post('/api/users', async (req, res) => {
  try {
    const { uid, displayName, email, photoURL } = req.body;
    if (!uid || !email) return res.status(400).json({ error: 'uid en email zijn verplicht' });

    await db.collection('users').doc(uid).set(
      { uid, displayName: displayName || email.split('@')[0], email, photoURL: photoURL || '', updatedAt: admin.firestore.FieldValue.serverTimestamp(), online: true },
      { merge: true }
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Gebruiker zoeken op email ─────────────────────────────────────────
app.get('/api/users/search', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email is verplicht' });

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
app.get('/api/conversations/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const snap = await db.collection('conversations')
      .where('members', 'array-contains', uid)
      .orderBy('updatedAt', 'desc')
      .limit(50)
      .get();

    const convs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(convs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Berichten ophalen ──────────────────────────────────────────────────
app.get('/api/messages/:convId', async (req, res) => {
  try {
    const { convId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const snap = await db.collection('conversations').doc(convId)
      .collection('messages')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
    res.json(msgs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── Socket.IO: Realtime events ──────────────────────────────────────────────
// Bijhouden welke users online zijn: uid → socket.id
const onlineUsers = {};

io.on('connection', (socket) => {
  console.log('🔌 Verbonden:', socket.id);

  // ── User registreren als online ──
  socket.on('user:online', async ({ uid }) => {
    onlineUsers[uid] = socket.id;
    socket.data.uid = uid;
    await db.collection('users').doc(uid).update({ online: true, lastSeen: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    io.emit('user:status', { uid, online: true });
    console.log(`👤 Online: ${uid}`);
  });

  // ── Gesprek / kamer joinen ──
  socket.on('conversation:join', ({ convId }) => {
    socket.join(convId);
    console.log(`📬 ${socket.data.uid} joined room ${convId}`);
  });

  // ── Bericht sturen ──
  socket.on('message:send', async ({ convId, message }) => {
    try {
      const msgRef = await db.collection('conversations').doc(convId)
        .collection('messages').add({
          ...message,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      // Gesprek updaten met laatste bericht
      await db.collection('conversations').doc(convId).update({
        lastMessage: message.text,
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Stuur bericht naar iedereen in de kamer (inclusief afzender)
      io.to(convId).emit('message:received', { id: msgRef.id, ...message });
    } catch (err) {
      console.error('Fout bij opslaan bericht:', err);
      socket.emit('error', { message: 'Bericht kon niet worden opgeslagen' });
    }
  });

  // ── Typen indicator ──
  socket.on('typing:start', ({ convId, uid, name }) => {
    socket.to(convId).emit('typing:update', { uid, name, typing: true });
  });

  socket.on('typing:stop', ({ convId, uid }) => {
    socket.to(convId).emit('typing:update', { uid, typing: false });
  });

  // ── WebRTC Signaling: Bellen ──
  socket.on('call:offer', ({ to, from, offer, isVideo, callerName }) => {
    const targetSocket = onlineUsers[to];
    if (targetSocket) {
      io.to(targetSocket).emit('call:incoming', { from, offer, isVideo, callerName });
    } else {
      socket.emit('call:unavailable', { to });
    }
  });

  socket.on('call:answer', ({ to, answer }) => {
    const targetSocket = onlineUsers[to];
    if (targetSocket) io.to(targetSocket).emit('call:answer', { answer });
  });

  socket.on('call:ice-candidate', ({ to, candidate }) => {
    const targetSocket = onlineUsers[to];
    if (targetSocket) io.to(targetSocket).emit('call:ice-candidate', { candidate });
  });

  socket.on('call:end', ({ to }) => {
    const targetSocket = onlineUsers[to];
    if (targetSocket) io.to(targetSocket).emit('call:ended');
  });

  socket.on('call:decline', ({ to }) => {
    const targetSocket = onlineUsers[to];
    if (targetSocket) io.to(targetSocket).emit('call:declined');
  });

  // ── Gesprek aanmaken ──
  socket.on('conversation:create', async ({ members, memberNames, isGroup, groupName }, callback) => {
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
            return callback({ convId: doc.id, existing: true });
          }
        }
      }

      const convRef = await db.collection('conversations').add({
        members,
        memberNames,
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

  // ── Verbreken ──
  socket.on('disconnect', async () => {
    const uid = socket.data.uid;
    if (uid) {
      delete onlineUsers[uid];
      await db.collection('users').doc(uid).update({ online: false, lastSeen: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
      io.emit('user:status', { uid, online: false });
      console.log(`👋 Offline: ${uid}`);
    }
  });
});

// ─── Server starten ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Pulse server draait op poort ${PORT}`);
});
