const { admin, db } = require('../firebase');
const { verifyAuth, strictLimiter, lookupUsernameLimiter } = require('../middleware');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(e) { return typeof e === 'string' && EMAIL_REGEX.test(e.trim()); }

module.exports = (io, onlineUsers) => {
  const router = require('express').Router();

  // ─── REST: Gebruikersprofiel opslaan ─────────────────────────────────────────
  router.post('/api/users', verifyAuth, async (req, res) => {
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
  router.get('/api/users/lookup-username', lookupUsernameLimiter, async (req, res) => {
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
  router.get('/api/users/search', verifyAuth, async (req, res) => {
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
  router.get('/api/conversations/:uid', verifyAuth, async (req, res) => {
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
  router.get('/api/messages/:convId', verifyAuth, async (req, res) => {
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
  router.delete('/api/messages/:convId/:msgId', verifyAuth, async (req, res) => {
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
  router.delete('/api/conversations/:convId', verifyAuth, async (req, res) => {
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
  router.delete('/api/account/:uid', verifyAuth, strictLimiter, async (req, res) => {
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

  // ─── REST: Profielfoto ophalen ────────────────────────────────────────────────
  router.get('/api/users/:uid/photo', verifyAuth, async (req, res) => {
    try {
      const { uid } = req.params;
      if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });
      res.json({ photoURL: userDoc.data().photoURL || null });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  // ─── REST: Profielfoto opslaan ────────────────────────────────────────────────
  router.post('/api/users/:uid/photo', verifyAuth, async (req, res) => {
    try {
      const { uid } = req.params;
      if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });
      const { photoURL } = req.body;
      if (!photoURL || typeof photoURL !== 'string') return res.status(400).json({ error: 'photoURL is verplicht.' });
      await db.collection('users').doc(uid).update({ photoURL });
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  return router;
};
