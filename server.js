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
app.get('/api/messages/:convId', async (req, res) => {
  try {
    const { convId } = req.params;
    const { uid } = req.query;
    const limit = parseInt(req.query.limit) || 50;

    let query = db.collection('conversations').doc(convId)
      .collection('messages')
      .orderBy('createdAt', 'desc')
      .limit(limit);

    if (uid) {
      const convDoc = await db.collection('conversations').doc(convId).get();
      const clearedAt = convDoc.exists ? convDoc.data().clearedAt?.[uid] : null;
      if (clearedAt) query = query.where('createdAt', '>', clearedAt);
    }

    const snap = await query.get();
    const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
    res.json(msgs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Gesprek verwijderen (soft delete per gebruiker) ───────────────────
app.delete('/api/conversations/:convId', async (req, res) => {
  try {
    const { convId } = req.params;
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'uid is verplicht' });

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
    socket.emit('users:online', Object.keys(onlineUsers));
    console.log(`👤 Online: ${uid}`);
  });

  // ── Gesprek / kamer joinen ──
  socket.on('conversation:join', ({ convId }) => {
    socket.join(convId);
    console.log(`📬 ${socket.data.uid} joined room ${convId}`);
  });

  // ── Bericht sturen ──
  socket.on('message:send', async ({ convId, message }, callback) => {
    try {
      const msgRef = await db.collection('conversations').doc(convId)
        .collection('messages').add({
          ...message,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      const savedMsg = { id: msgRef.id, ...message };

      // Gesprek updaten met laatste bericht
      db.collection('conversations').doc(convId).update({
        lastMessage: message.text,
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Stuur bericht naar iedereen in de kamer (inclusief afzender)
      io.to(convId).emit('message:received', savedMsg);

      // Bevestig aan afzender zodat optimistic bericht vervangen kan worden
      if (typeof callback === 'function') callback(savedMsg);

      // Stuur "delivered" als ontvanger online is in de kamer
      const room = io.sockets.adapter.rooms.get(convId);
      if (room && room.size > 1) {
        socket.emit('message:status', { convId, msgId: savedMsg.id, status: 'delivered' });
      }

      // Push notificatie naar leden die offline zijn
      try {
        const convDoc = await db.collection('conversations').doc(convId).get();
        const members = convDoc.data()?.members || [];
        const senderName = message.senderName || 'Iemand';
        for (const memberUid of members) {
          if (memberUid === message.senderId) continue;
          if (onlineUsers[memberUid]) continue; // online, geen push nodig
          const userDoc = await db.collection('users').doc(memberUid).get();
          const fcmToken = userDoc.data()?.fcmToken;
          if (!fcmToken) continue;
          await admin.messaging().send({
            token: fcmToken,
            notification: {
              title: senderName,
              body: message.text?.substring(0, 100) || 'Nieuw bericht',
            },
            data: { convId },
            webpush: { fcmOptions: { link: 'https://pulse-message.netlify.app' } },
          }).catch(() => {});
        }
      } catch {}
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
  socket.on('messages:read', ({ convId, uid }) => {
    socket.to(convId).emit('message:status', { convId, readerId: uid, status: 'read' });
  });

  // ── Groepslid toevoegen ──
  socket.on('conversation:addMember', async ({ convId, uid, displayName }, cb) => {
    try {
      await db.collection('conversations').doc(convId).update({
        members: admin.firestore.FieldValue.arrayUnion(uid),
        [`memberNames.${uid}`]: displayName,
      });
      io.to(convId).emit('conversation:memberAdded', { convId, uid, displayName });
      cb?.({});
    } catch (e) { cb?.({ error: e.message }); }
  });

  // ── Groepslid verwijderen ──
  socket.on('conversation:removeMember', async ({ convId, uid }, cb) => {
    try {
      const update = { members: admin.firestore.FieldValue.arrayRemove(uid) };
      update[`memberNames.${uid}`] = admin.firestore.FieldValue.delete();
      await db.collection('conversations').doc(convId).update(update);
      io.to(convId).emit('conversation:memberRemoved', { convId, uid });
      cb?.({});
    } catch (e) { cb?.({ error: e.message }); }
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

// ─── REST: FCM token opslaan ─────────────────────────────────────────────────
app.post('/api/fcm-token', async (req, res) => {
  try {
    const { uid, token } = req.body;
    if (!uid || !token) return res.status(400).json({ error: 'uid en token verplicht' });
    await db.collection('users').doc(uid).update({ fcmToken: token });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Vriendschapsverzoek sturen ────────────────────────────────────────
app.post('/api/friend-requests', async (req, res) => {
  try {
    const { fromUid, fromName, fromEmail, fromPhoto, toEmail } = req.body;
    if (!fromUid || !toEmail) return res.status(400).json({ error: 'fromUid en toEmail zijn verplicht' });

    // Zoek de ontvanger op email
    const snap = await db.collection('users').where('email', '==', toEmail).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    const toUser = snap.docs[0].data();

    if (toUser.uid === fromUid) return res.status(400).json({ error: 'Je kunt jezelf niet toevoegen' });

    // Check of ze al contacten zijn
    const alreadyContact = await db.collection('users').doc(toUser.uid).collection('contacts').doc(fromUid).get();
    if (alreadyContact.exists) return res.status(400).json({ error: 'Al in contactenlijst' });

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
    const targetSocket = onlineUsers[toUser.uid];
    if (targetSocket) {
      io.to(targetSocket).emit('friend:request', {
        id: reqRef.id, fromUid, fromName, fromEmail, fromPhoto: fromPhoto || null,
      });
    }

    res.json({ success: true, requestId: reqRef.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Vriendschapsverzoeken ophalen voor een gebruiker ──────────────────
app.get('/api/friend-requests/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
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
app.post('/api/friend-requests/:requestId/accept', async (req, res) => {
  try {
    const { requestId } = req.params;
    const reqDoc = await db.collection('friendRequests').doc(requestId).get();
    if (!reqDoc.exists) return res.status(404).json({ error: 'Verzoek niet gevonden' });
    const { fromUid, fromName, fromEmail, fromPhoto, toUid, toName, toEmail } = reqDoc.data();

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
    const senderSocket = onlineUsers[fromUid];
    if (senderSocket) {
      io.to(senderSocket).emit('friend:accepted', { byUid: toUid, byName: toName, byEmail: toEmail });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── REST: Vriendschapsverzoek weigeren ──────────────────────────────────────
app.post('/api/friend-requests/:requestId/decline', async (req, res) => {
  try {
    const { requestId } = req.params;
    await db.collection('friendRequests').doc(requestId).update({ status: 'declined' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ─── Server starten ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Pulse server draait op poort ${PORT}`);
});
