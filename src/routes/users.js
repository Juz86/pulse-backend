const { admin, db, storage } = require('../firebase');
const { verifyAuth, strictLimiter, lookupUsernameLimiter } = require('../middleware');
const { getSocketId } = require('../state');
const { sendPush } = require('../push');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
function validEmail(e) { return typeof e === 'string' && EMAIL_REGEX.test(e.trim()); }
function normalizeIdentifier(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
async function findUserByIdentifier(identifier) {
  const clean = normalizeIdentifier(identifier);
  if (!clean) return null;

  if (validEmail(clean)) {
    const emailSnap = await db.collection('users').where('email', '==', clean).limit(1).get();
    if (!emailSnap.empty) return emailSnap.docs[0].data();
  }

  if (USERNAME_REGEX.test(clean)) {
    const usernameSnap = await db.collection('users').where('username', '==', clean).limit(1).get();
    if (!usernameSnap.empty) return usernameSnap.docs[0].data();
  }

  return null;
}

// ─── Gedeelde helper: verwijder alle Firestore-data van een account ───────────
// Verwijdert geen Firebase Auth — dat doet de aanroepende route expliciet.
// Veilig voor zowel parent- als child-accounts.
async function deleteAccountData(uid) {
  // a) Gesprekken + berichten
  const convsSnap = await db.collection('conversations')
    .where('members', 'array-contains', uid).get();
  for (const convDoc of convsSnap.docs) {
    const { members = [] } = convDoc.data();
    const msgsSnap = await convDoc.ref.collection('messages').get();
    const batch = db.batch();
    msgsSnap.docs.forEach(d => batch.delete(d.ref));
    if (members.length <= 2) {
      batch.delete(convDoc.ref);
    } else {
      batch.update(convDoc.ref, { members: members.filter(m => m !== uid) });
    }
    await batch.commit();
  }

  // b) Eigen contacts-subcollectie
  const ownContactsSnap = await db.collection('users').doc(uid).collection('contacts').get();
  if (!ownContactsSnap.empty) {
    const batch = db.batch();
    ownContactsSnap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  // c) Verwijder uid uit contacts-subcollecties van andere gebruikers (ghost contacts)
  const reverseContactsSnap = await db.collectionGroup('contacts')
    .where('uid', '==', uid).get();
  if (!reverseContactsSnap.empty) {
    for (let i = 0; i < reverseContactsSnap.docs.length; i += 500) {
      const batch = db.batch();
      reverseContactsSnap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }

  // d) Vriendschapsverzoeken
  const [frFromSnap, frToSnap] = await Promise.all([
    db.collection('friendRequests').where('fromUid', '==', uid).get(),
    db.collection('friendRequests').where('toUid',   '==', uid).get(),
  ]);
  const frDocs = [...frFromSnap.docs, ...frToSnap.docs];
  if (frDocs.length > 0) {
    for (let i = 0; i < frDocs.length; i += 500) {
      const batch = db.batch();
      frDocs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }

  // e) Gebruikerssessies (technische metadata)
  const sessionsSnap = await db.collection('userSessions').where('uid', '==', uid).get();
  if (!sessionsSnap.empty) {
    for (let i = 0; i < sessionsSnap.docs.length; i += 500) {
      const batch = db.batch();
      sessionsSnap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }

  // f) Ouderactiviteiten (parentId of childUid verwijzing)
  const [paParentSnap, paChildSnap] = await Promise.all([
    db.collection('parentActivities').where('parentId', '==', uid).get(),
    db.collection('parentActivities').where('childUid', '==', uid).get(),
  ]);
  const paDocs = [...paParentSnap.docs, ...paChildSnap.docs];
  if (paDocs.length > 0) {
    for (let i = 0; i < paDocs.length; i += 500) {
      const batch = db.batch();
      paDocs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }

  // g) Firestore gebruikersdocument
  await db.collection('users').doc(uid).delete();

  // h) Firebase Storage profielfoto (geen fout als bestand niet bestaat)
  try {
    await storage.bucket().file(`users/${uid}/profilePhoto`).delete();
  } catch (e) {
    if (e.code !== 404) console.warn(`Storage verwijderen mislukt voor ${uid}:`, e.message);
  }
}

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
      // Role mag alleen worden gezet bij aanmaken of upgraden van 'user' naar 'parent'
      // 'child' en 'parent' mogen nooit verlaagd worden via client-request
      const existingDoc = await db.collection('users').doc(uid).get();
      if (!existingDoc.exists && role === 'parent') updateData.role = 'parent';
      else if (!existingDoc.exists) updateData.role = 'user';
      else if (existingDoc.data()?.role === 'user' && role === 'parent') updateData.role = 'parent';
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

  // ─── REST: Gebruiker zoeken op e-mailadres, pulse.internal of gebruikersnaam ──
  router.get('/api/users/search', verifyAuth, async (req, res) => {
    try {
      const query = normalizeIdentifier(req.query.q || req.query.email || '');
      if (!query) return res.status(400).json({ error: 'Voer een e-mailadres of gebruikersnaam in.' });
      if (!validEmail(query) && !USERNAME_REGEX.test(query)) {
        return res.status(400).json({ error: 'Zoek op een geldig e-mailadres of gebruikersnaam.' });
      }

      const user = await findUserByIdentifier(query);
      if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });

      res.json({ uid: user.uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL, username: user.username || null });
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

      const userDoc = await db.collection('users').doc(uid).get();
      const isParent = userDoc.exists && userDoc.data()?.role === 'parent';

      // 1. Als ouder: verwijder gekoppelde kindaccounts eerst (cascade)
      if (isParent) {
        const childrenSnap = await db.collection('users').where('parentId', '==', uid).get();
        for (const childDoc of childrenSnap.docs) {
          await deleteAccountData(childDoc.id);
          await admin.auth().deleteUser(childDoc.id).catch(e => console.warn(`Auth delete kind ${childDoc.id} mislukt:`, e.message));
        }
      }

      // 2. Verwijder alle data van dit account
      await deleteAccountData(uid);

      // 3. Verwijder Firebase Auth account
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

  // ─── REST: Contact blokkeren ──────────────────────────────────────────────────
  router.post('/api/users/:uid/block', verifyAuth, strictLimiter, async (req, res) => {
    try {
      const { uid } = req.params;
      const { targetUid } = req.body;
      if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });
      if (!targetUid || typeof targetUid !== 'string') return res.status(400).json({ error: 'targetUid is verplicht.' });
      if (targetUid === uid) return res.status(400).json({ error: 'Je kunt jezelf niet blokkeren.' });

      await db.collection('users').doc(uid).update({
        blockedUsers: admin.firestore.FieldValue.arrayUnion(targetUid),
      });

      // Parent notificatie
      const [userDoc, targetDoc] = await Promise.all([
        db.collection('users').doc(uid).get(),
        db.collection('users').doc(targetUid).get(),
      ]);
      const userData = userDoc.data() || {};
      const targetName = targetDoc.exists ? (targetDoc.data().displayName || targetUid) : targetUid;
      const parentId = userData.parentId;
      const childName = userData.displayName || uid;

      if (parentId) {
        const description = `${childName} heeft ${targetName} geblokkeerd.`;
        db.collection('parentActivities').add({
          parentId, childUid: uid, childName,
          type: 'contact_blocked', description, targetName,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        const parentSocket = getSocketId(parentId);
        if (parentSocket) io.to(parentSocket).emit('parent:activity', { type: 'contact_blocked', description, childName });
        sendPush(parentId,
          { title: 'Pulse — Contact geblokkeerd', body: description },
          { type: 'contact_blocked' }
        ).catch(() => {});
      }

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  // ─── REST: Contact deblokkeren ────────────────────────────────────────────────
  router.post('/api/users/:uid/unblock', verifyAuth, strictLimiter, async (req, res) => {
    try {
      const { uid } = req.params;
      const { targetUid } = req.body;
      if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });
      if (!targetUid || typeof targetUid !== 'string') return res.status(400).json({ error: 'targetUid is verplicht.' });

      // Weiger als contact geblokkeerd is door ouder
      const preCheckDoc = await db.collection('users').doc(uid).get();
      const blockedByParent = preCheckDoc.data()?.blockedByParent || [];
      if (blockedByParent.includes(targetUid)) {
        return res.status(403).json({ error: 'Dit contact is geblokkeerd door je ouder en kan niet worden gedeblokkeerd.' });
      }

      await db.collection('users').doc(uid).update({
        blockedUsers: admin.firestore.FieldValue.arrayRemove(targetUid),
      });

      // Parent notificatie
      const [userDoc, targetDoc] = await Promise.all([
        db.collection('users').doc(uid).get(),
        db.collection('users').doc(targetUid).get(),
      ]);
      const userData = userDoc.data() || {};
      const targetName = targetDoc.exists ? (targetDoc.data().displayName || targetUid) : targetUid;
      const parentId = userData.parentId;
      const childName = userData.displayName || uid;

      if (parentId) {
        const description = `${childName} heeft ${targetName} gedeblokkeerd.`;
        db.collection('parentActivities').add({
          parentId, childUid: uid, childName,
          type: 'contact_unblocked', description, targetName,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        const parentSocket = getSocketId(parentId);
        if (parentSocket) io.to(parentSocket).emit('parent:activity', { type: 'contact_unblocked', description, childName });
        sendPush(parentId,
          { title: 'Pulse — Contact gedeblokkeerd', body: description },
          { type: 'contact_unblocked' }
        ).catch(() => {});
      }

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  // ─── REST: Geblokkeerde contacten ophalen ──────────────────────────────────────
  router.get('/api/users/:uid/blocked', verifyAuth, async (req, res) => {
    try {
      const { uid } = req.params;
      if (req.uid !== uid) return res.status(403).json({ error: 'Geen toegang.' });
      const userDoc = await db.collection('users').doc(uid).get();
      const blockedUids        = userDoc.exists ? (userDoc.data().blockedUsers    || []) : [];
      const parentBlockedUids  = userDoc.exists ? (userDoc.data().blockedByParent || []) : [];
      if (blockedUids.length === 0) return res.json({ contacts: [], parentBlockedUids });
      const docs = await Promise.all(blockedUids.map(bUid => db.collection('users').doc(bUid).get()));
      const contacts = docs
        .filter(d => d.exists)
        .map(d => ({ uid: d.id, displayName: d.data().displayName, email: d.data().email, photoURL: d.data().photoURL || null, isBlockedByParent: parentBlockedUids.includes(d.id) }));
      res.json({ contacts, parentBlockedUids });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  return router;
};
