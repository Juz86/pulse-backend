const { admin, db, storage } = require('../firebase');
const { verifyAuth } = require('../middleware');
const { sendPush } = require('../push');
const { activeCalls } = require('../state');
const { transporter } = require('../email');

const HISTORY_RETENTION_OPTIONS_DAYS = [1, 7, 14, 30];
const DEFAULT_HISTORY_RETENTION_DAYS = 30;

function normalizeRetentionDays(value) {
  const numeric = Number(value);
  return HISTORY_RETENTION_OPTIONS_DAYS.includes(numeric) ? numeric : DEFAULT_HISTORY_RETENTION_DAYS;
}

async function getParentHistorySettings(parentUid) {
  const doc = await db.collection('parent_settings').doc(parentUid).get();
  const data = doc.exists ? doc.data() || {} : {};
  return { retentionDays: normalizeRetentionDays(data.historyRules?.retentionDays) };
}

async function getChildHistorySettings(childUid) {
  const doc = await db.collection('child_settings').doc(childUid).get();
  const data = doc.exists ? doc.data() || {} : {};
  return { retentionDays: normalizeRetentionDays(data.historyRules?.retentionDays) };
}

async function setParentHistorySettings(parentUid, retentionDays) {
  const normalizedDays = normalizeRetentionDays(retentionDays);
  await db.collection('parent_settings').doc(parentUid).set({
    parentUid,
    historyRules: { retentionDays: normalizedDays },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { retentionDays: normalizedDays };
}

async function setChildHistorySettings(childUid, retentionDays, parentUid) {
  const normalizedDays = normalizeRetentionDays(retentionDays);
  await db.collection('child_settings').doc(childUid).set({
    childUid,
    parentUid,
    historyRules: { retentionDays: normalizedDays },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { retentionDays: normalizedDays };
}

module.exports = (io, onlineUsers) => {
  const router = require('express').Router();

  // ─── Helper: controleer of uid een ouder is van dit kind ─────────────────────
  function isParentOf(uid, childData) {
    if (Array.isArray(childData.parentIds) && childData.parentIds.includes(uid)) return true;
    if (childData.parentId === uid) return true;
    if (childData.parentUid === uid) return true;
    if (childData.managedByParentId === uid) return true;
    return false;
  }

  function isPrimaryParentOf(uid, childData) {
    if (childData.managedByParentId === uid) return true;
    if (childData.parentId === uid) return true;
    if (childData.parentUid === uid) return true;
    return false;
  }

  async function listChildrenForParent(parentUid) {
    const [snap1, snap2, snap3, snap4] = await Promise.all([
      db.collection('users').where('parentId', '==', parentUid).get(),
      db.collection('users').where('parentIds', 'array-contains', parentUid).get(),
      db.collection('users').where('parentUid', '==', parentUid).get(),
      db.collection('users').where('managedByParentId', '==', parentUid).get(),
    ]);

    const seen = new Set();
    return [...snap1.docs, ...snap2.docs, ...snap3.docs, ...snap4.docs].filter(d => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
  }

  // GET /api/parent/children — haal gekoppelde kinderen op
  router.get('/api/parent/children', verifyAuth, async (req, res) => {
    try {
      const parentDoc = await db.collection('users').doc(req.uid).get();
      if (!parentDoc.exists || parentDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });

      const allDocs = await listChildrenForParent(req.uid);

      const children = allDocs.map(d => {
        const { uid, displayName, username, email, photoURL, online, lastSeen, paused, pausedFeatures } = d.data();
        const pf = pausedFeatures || { chat: paused || false, call: paused || false, video: paused || false };
        return {
          uid,
          displayName,
          username: username || null,
          email,
          photoURL: photoURL || null,
          online: online || false,
          lastSeen: lastSeen || null,
          pausedFeatures: pf,
          canInviteCoparent: isPrimaryParentOf(req.uid, d.data()),
        };
      });
      res.json(children);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
  });

  router.get('/api/parent/settings', verifyAuth, async (req, res) => {
    try {
      const parentDoc = await db.collection('users').doc(req.uid).get();
      if (!parentDoc.exists || parentDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });

      const historySettings = await getParentHistorySettings(req.uid);
      const children = await listChildrenForParent(req.uid);
      const childHistoryRules = await Promise.all(children.map(async (childDoc) => {
        const childSettings = await getChildHistorySettings(childDoc.id);
        return { childUid: childDoc.id, retentionDays: childSettings.retentionDays };
      }));

      res.json({
        historyRules: {
          retentionDays: historySettings.retentionDays,
          options: HISTORY_RETENTION_OPTIONS_DAYS,
          defaultRetentionDays: DEFAULT_HISTORY_RETENTION_DAYS,
        },
        childHistoryRules,
      });
    } catch (err) {
      console.error('parent settings ophalen mislukt:', err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  router.post('/api/parent/settings/history', verifyAuth, async (req, res) => {
    try {
      const parentDoc = await db.collection('users').doc(req.uid).get();
      if (!parentDoc.exists || parentDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });

      const retentionDays = Number(req.body?.retentionDays);
      if (!HISTORY_RETENTION_OPTIONS_DAYS.includes(retentionDays)) return res.status(400).json({ error: 'Ongeldige bewaartermijn.' });

      const historySettings = await setParentHistorySettings(req.uid, retentionDays);
      res.json({
        success: true,
        ok: true,
        historyRules: {
          retentionDays: historySettings.retentionDays,
          options: HISTORY_RETENTION_OPTIONS_DAYS,
          defaultRetentionDays: DEFAULT_HISTORY_RETENTION_DAYS,
        },
      });
    } catch (err) {
      console.error('parent history settings opslaan mislukt:', err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  router.post('/api/parent/child/:childUid/settings/history', verifyAuth, async (req, res) => {
    try {
      const { childUid } = req.params;
      const childDoc = await db.collection('users').doc(childUid).get();
      if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
      if (!isParentOf(req.uid, childDoc.data() || {})) return res.status(403).json({ error: 'Geen toegang tot dit kind.' });

      const retentionDays = Number(req.body?.retentionDays);
      if (!HISTORY_RETENTION_OPTIONS_DAYS.includes(retentionDays)) return res.status(400).json({ error: 'Ongeldige bewaartermijn.' });

      const historySettings = await setChildHistorySettings(childUid, retentionDays, req.uid);
      res.json({
        success: true,
        ok: true,
        childUid,
        historyRules: {
          retentionDays: historySettings.retentionDays,
          options: HISTORY_RETENTION_OPTIONS_DAYS,
          defaultRetentionDays: DEFAULT_HISTORY_RETENTION_DAYS,
        },
      });
    } catch (err) {
      console.error('child history settings opslaan mislukt:', err);
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  // POST /api/parent/create-child — ouder maakt kindaccount direct aan
  router.post('/api/parent/create-child', verifyAuth, async (req, res) => {
    try {
      const parentDoc = await db.collection('users').doc(req.uid).get();
      if (!parentDoc.exists || parentDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const parentData = parentDoc.data();

      const { name, username, password } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Naam is verplicht.' });
      if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Gebruikersnaam is verplicht.' });
      if (!password || password.length < 6) return res.status(400).json({ error: 'Wachtwoord moet minimaal 6 tekens zijn.' });

      const cleanUsername = username.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
        return res.status(400).json({ error: 'Gebruikersnaam mag alleen letters, cijfers en _ bevatten (3-20 tekens).' });
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
        parentUid:   req.uid,
        managedByParentId: req.uid,
        parentIds:   [req.uid],
        parentEmail: parentData.email,
        online:         false,
        pausedFeatures: { chat: false, call: false, video: false },
        createdAt:      admin.firestore.FieldValue.serverTimestamp(),
      });

      // Voeg wederzijds als contact toe
      const batch = db.batch();
      batch.set(db.collection('users').doc(newUser.uid).collection('contacts').doc(req.uid), {
        uid: req.uid, displayName: parentData.displayName || parentData.email,
        email: parentData.email, photoURL: parentData.photoURL || null, addedAt: new Date().toISOString(),
        relation: 'familie',
      });
      batch.set(db.collection('users').doc(req.uid).collection('contacts').doc(newUser.uid), {
        uid: newUser.uid, displayName: name.trim(),
        email: internalEmail, photoURL: null, addedAt: new Date().toISOString(),
        relation: 'familie',
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
  router.post('/api/parent/change-child-password/:childUid', verifyAuth, async (req, res) => {
    try {
      const { childUid } = req.params;
      const { password } = req.body;
      if (!password || password.length < 6) return res.status(400).json({ error: 'Wachtwoord moet minimaal 6 tekens zijn.' });
      const childDoc = await db.collection('users').doc(childUid).get();
      if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
      if (childDoc.data().role !== 'child') return res.status(403).json({ error: 'Alleen kindaccounts worden ondersteund.' });
      if (!isParentOf(req.uid, childDoc.data())) return res.status(403).json({ error: 'Geen toegang.' });
      await admin.auth().updateUser(childUid, { password });
      res.json({ success: true });
    } catch (err) { console.error('change-child-password fout:', err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // POST /api/parent/change-child-username/:childUid — ouder wijzigt gebruikersnaam van kind
  router.post('/api/parent/change-child-username/:childUid', verifyAuth, async (req, res) => {
    try {
      const { childUid } = req.params;
      const { username } = req.body;
      if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Gebruikersnaam is verplicht.' });

      const childRef = db.collection('users').doc(childUid);
      const childDoc = await childRef.get();
      if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
      const childData = childDoc.data();
      if (childData.role !== 'child') return res.status(403).json({ error: 'Alleen kindaccounts worden ondersteund.' });
      if (!isParentOf(req.uid, childData)) return res.status(403).json({ error: 'Geen toegang.' });

      const cleanUsername = username.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
        return res.status(400).json({ error: 'Gebruikersnaam mag alleen letters, cijfers en _ bevatten (3-20 tekens).' });
      }
      if (cleanUsername === (childData.username || '').trim().toLowerCase()) {
        return res.json({ success: true, username: cleanUsername, email: childData.email || `${cleanUsername}@pulse.internal` });
      }

      const existing = await db.collection('users').where('username', '==', cleanUsername).limit(1).get();
      if (!existing.empty && existing.docs[0].id !== childUid) {
        return res.status(400).json({ error: 'Deze gebruikersnaam is al in gebruik.' });
      }

      const internalEmail = `${cleanUsername}@pulse.internal`;
      await admin.auth().updateUser(childUid, { email: internalEmail });
      await childRef.update({ username: cleanUsername, email: internalEmail });

      const batch = db.batch();
      batch.update(db.collection('users').doc(req.uid).collection('contacts').doc(childUid), { username: cleanUsername, email: internalEmail });

      const contactRefs = await db.collectionGroup('contacts').where('uid', '==', childUid).get();
      contactRefs.docs.forEach((docSnap) => {
        if (docSnap.ref.path !== `users/${req.uid}/contacts/${childUid}`) {
          batch.update(docSnap.ref, { username: cleanUsername, email: internalEmail });
        }
      });
      await batch.commit();

      res.json({ success: true, username: cleanUsername, email: internalEmail });
    } catch (err) {
      console.error('change-child-username fout:', err);
      if (err.code === 'auth/email-already-exists') return res.status(400).json({ error: 'Deze gebruikersnaam is al in gebruik.' });
      res.status(500).json({ error: 'Serverfout' });
    }
  });

  // DELETE /api/parent/delete-child/:childUid — ouder verwijdert kindaccount
  router.delete('/api/parent/delete-child/:childUid', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const { childUid } = req.params;
      const childDoc = await db.collection('users').doc(childUid).get();
      if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
      const childData = childDoc.data();
      if (!isParentOf(req.uid, childData)) return res.status(403).json({ error: 'Geen toegang.' });
      if (childData.role !== 'child') return res.status(403).json({ error: 'Alleen kindaccounts kunnen worden verwijderd via dit endpoint.' });

      // 1. Firebase Auth EERST verwijderen — als dit mislukt stoppen we zonder Firestore aan te raken.
      // Retry-logica: max 3 pogingen met exponentiële backoff.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await admin.auth().deleteUser(childUid);
          break;
        } catch (err) {
          if (err.code === 'auth/user-not-found') break; // al verwijderd, ok
          if (attempt === 3) throw err;
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
      }

      // 2. Gesprekken + berichten
      const convsSnap = await db.collection('conversations').where('members', 'array-contains', childUid).get();
      for (const convDoc of convsSnap.docs) {
        const convData = convDoc.data();
        const { members = [], isGroup } = convData;
        const msgsSnap = await convDoc.ref.collection('messages').get();
        const batch = db.batch();
        msgsSnap.docs.forEach(d => batch.delete(d.ref));
        if (members.length <= 2) {
          batch.delete(convDoc.ref);
          if (isGroup) {
            storage.bucket().file(`groups/${convDoc.id}/photo`).delete().catch(() => {});
          }
        } else {
          batch.update(convDoc.ref, {
            members: members.filter(m => m !== childUid),
            [`memberNames.${childUid}`]: admin.firestore.FieldValue.delete(),
          });
        }
        await batch.commit();
      }

      // 3. Eigen contacts-subcollectie
      const contactsSnap = await db.collection('users').doc(childUid).collection('contacts').get();
      if (!contactsSnap.empty) {
        const batch = db.batch();
        contactsSnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      // 4. Verwijder childUid uit contacts-subcollecties van andere gebruikers (ghost contacts)
      const reverseSnap = await db.collectionGroup('contacts').where('uid', '==', childUid).get();
      if (!reverseSnap.empty) {
        for (let i = 0; i < reverseSnap.docs.length; i += 500) {
          const batch = db.batch();
          reverseSnap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      }

      // 5. Vriendschapsverzoeken
      const [frFrom, frTo] = await Promise.all([
        db.collection('friendRequests').where('fromUid', '==', childUid).get(),
        db.collection('friendRequests').where('toUid',   '==', childUid).get(),
      ]);
      const frDocs = [...frFrom.docs, ...frTo.docs];
      if (frDocs.length > 0) {
        const batch = db.batch();
        frDocs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }

      // 6. Gebruikerssessies (technische metadata)
      const sessionsSnap = await db.collection('userSessions').where('uid', '==', childUid).get();
      if (!sessionsSnap.empty) {
        for (let i = 0; i < sessionsSnap.docs.length; i += 500) {
          const batch = db.batch();
          sessionsSnap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      }

      // 7. Ouderactiviteiten voor dit kind
      const paSnap = await db.collection('parentActivities').where('childUid', '==', childUid).get();
      if (!paSnap.empty) {
        for (let i = 0; i < paSnap.docs.length; i += 500) {
          const batch = db.batch();
          paSnap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      }

      // 8. Firestore gebruikersdocument
      await db.collection('users').doc(childUid).delete();

      // 9. Firebase Storage: profielfoto + chatachtergrond
      const deleteFile = async (path) => {
        try { await storage.bucket().file(path).delete(); }
        catch (e) { if (e.code !== 404 && !e.message?.includes('No such object')) throw e; }
      };
      await deleteFile(`users/${childUid}/profilePhoto`);
      await deleteFile(`users/${childUid}/chatBackground`);

      res.json({ success: true });
    } catch (err) { console.error('delete-child fout:', err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // POST /api/parent/pause/:childUid — pauzeer kind (feature: 'chat'|'call'|'video'|'all')
  router.post('/api/parent/pause/:childUid', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const { childUid } = req.params;
      const childDoc = await db.collection('users').doc(childUid).get();
      if (!childDoc.exists) return res.status(404).json({ error: 'Niet gevonden.' });
      if (!isParentOf(req.uid, childDoc.data())) return res.status(403).json({ error: 'Geen toegang.' });

      const { feature } = req.body; // 'chat', 'call', 'video', or 'all' / undefined
      const current = childDoc.data().pausedFeatures || { chat: false, call: false, video: false };
      let updated;
      if (!feature || feature === 'all') {
        updated = { chat: true, call: true, video: true };
      } else if (['chat', 'call', 'video'].includes(feature)) {
        updated = { ...current, [feature]: true };
      } else {
        return res.status(400).json({ error: 'Ongeldig kenmerk.' });
      }

      await db.collection('users').doc(childUid).update({ pausedFeatures: updated });
      const s = onlineUsers[childUid];
      if (s) s.forEach(sid => {
        io.to(sid).emit('account:paused', { features: updated });
        if (activeCalls.has(childUid) && (updated.call || updated.video)) io.to(sid).emit('call:ended');
      });
      if (updated.call || updated.video) activeCalls.delete(childUid);

      const featureLabel = !feature || feature === 'all' ? 'alles' : feature === 'chat' ? 'chatten' : feature === 'call' ? 'bellen' : 'videobellen';
      if (!onlineUsers[childUid]?.size) {
        sendPush(childUid,
          { title: 'Pulse', body: `${featureLabel.charAt(0).toUpperCase() + featureLabel.slice(1)} is gepauzeerd door je ouder.` },
          { type: 'paused' }
        );
      }
      res.json({ success: true, pausedFeatures: updated });
    } catch (err) { res.status(500).json({ error: 'Serverfout' }); }
  });

  // POST /api/parent/resume/:childUid — hervat kind (feature: 'chat'|'call'|'video'|'all')
  router.post('/api/parent/resume/:childUid', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const { childUid } = req.params;
      const childDoc = await db.collection('users').doc(childUid).get();
      if (!childDoc.exists) return res.status(404).json({ error: 'Niet gevonden.' });
      if (!isParentOf(req.uid, childDoc.data())) return res.status(403).json({ error: 'Geen toegang.' });

      const { feature } = req.body;
      const current = childDoc.data().pausedFeatures || { chat: false, call: false, video: false };
      let updated;
      if (!feature || feature === 'all') {
        updated = { chat: false, call: false, video: false };
      } else if (['chat', 'call', 'video'].includes(feature)) {
        updated = { ...current, [feature]: false };
      } else {
        return res.status(400).json({ error: 'Ongeldig kenmerk.' });
      }

      await db.collection('users').doc(childUid).update({ pausedFeatures: updated });
      const s = onlineUsers[childUid];
      if (s) s.forEach(sid => io.to(sid).emit('account:resumed', { features: updated }));
      res.json({ success: true, pausedFeatures: updated });
    } catch (err) { res.status(500).json({ error: 'Serverfout' }); }
  });

  // GET /api/parent/activities — haal activiteiten op voor ouder
  router.get('/api/parent/activities', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const snap = await db.collection('parentActivities')
        .where('parentId', '==', req.uid)
        .limit(50)
        .get();
      const activities = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt || null }));
      res.json(activities);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // GET /api/parent/analytics/:childUid — analyserapport voor kind
  router.get('/api/parent/analytics/:childUid', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const { childUid } = req.params;
      const childDoc = await db.collection('users').doc(childUid).get();
      if (!childDoc.exists) return res.status(404).json({ error: 'Niet gevonden.' });
      if (!isParentOf(req.uid, childDoc.data())) return res.status(403).json({ error: 'Geen toegang.' });

      const childData = childDoc.data();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const [contactsSnap, friendReqSentSnap, friendReqRecvSnap, sessionsSnap, convsSnap] = await Promise.all([
        db.collection('users').doc(childUid).collection('contacts').get(),
        db.collection('friendRequests').where('fromUid', '==', childUid).limit(20).get(),
        db.collection('friendRequests').where('toUid', '==', childUid).limit(20).get(),
        db.collection('userSessions').where('uid', '==', childUid).limit(200).get(),
        db.collection('conversations').where('members', 'array-contains', childUid).limit(25).get(),
      ]);

      const profile = {
        displayName: childData.displayName, photoURL: childData.photoURL || null,
        username: childData.username || null, online: !!onlineUsers[childUid]?.size,
        lastSeen: childData.lastSeen || null,
      };

      const contactList = contactsSnap.docs.map(d => ({ uid: d.id, displayName: d.data().displayName, photoURL: d.data().photoURL || null, email: d.data().email || null, username: d.data().username || null, relation: d.data().relation || null }));

      const friendRequests = {
        sent: friendReqSentSnap.docs.map(d => ({ toName: d.data().toName || d.data().toEmail || '', status: d.data().status, createdAt: d.data().createdAt || null })),
        received: friendReqRecvSnap.docs.map(d => ({ fromName: d.data().fromName || d.data().fromEmail || '', status: d.data().status, createdAt: d.data().createdAt || null })),
      };

      const dailyMap = {};
      const hourlyMap = {};
      let totalSecondsLast7Days = 0;
      const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
      sessionsSnap.docs.forEach(doc => {
        const d = doc.data();
        const startMs = d.startTime?._seconds ? d.startTime._seconds * 1000 : (d.startTime?.seconds ? d.startTime.seconds * 1000 : 0);
        const duration = d.duration || 0;
        if (!startMs || startMs < thirtyDaysAgoMs) return;
        if (startMs >= sevenDaysAgoMs) totalSecondsLast7Days += duration;
        const dt = new Date(startMs);
        const dateStr = dt.toISOString().split('T')[0];
        const hour = dt.getHours();
        dailyMap[dateStr] = (dailyMap[dateStr] || 0) + duration;
        hourlyMap[hour] = (hourlyMap[hour] || 0) + Math.round(duration / 60);
      });
      const last7Days = [];
      for (let i = 6; i >= 0; i--) {
        const dt = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const dateStr = dt.toISOString().split('T')[0];
        last7Days.push({ date: dateStr, seconds: dailyMap[dateStr] || 0 });
      }
      const sessions = { totalSecondsLast7Days, daily: last7Days, hourlyPattern: hourlyMap };

      const topContactsMap = {};
      let totalMessagesSent = 0, totalCallSecs = 0, totalVideoSecs = 0;

      await Promise.allSettled(convsSnap.docs.slice(0, 20).map(async convDoc => {
        const convData = convDoc.data();
        const otherUid = convData.isGroup ? null : (convData.members || []).find(m => m !== childUid);
        const otherName = otherUid ? (convData.memberNames?.[otherUid] || 'Onbekend') : (convData.name || 'Groep');
        const key = otherUid || convDoc.id;
        const msgsSnap = await db.collection('conversations').doc(convDoc.id).collection('messages')
          .where('createdAt', '>=', thirtyDaysAgo).limit(500).get();
        let sentMsgs = 0, calls = 0, videos = 0, callSecs = 0;
        msgsSnap.docs.forEach(doc => {
          const msg = doc.data();
          if (msg.type === 'call') {
            const dur = msg.duration || 0;
            if (msg.isVideo) totalVideoSecs += dur; else totalCallSecs += dur;
            if (msg.senderId === childUid) { calls++; if (msg.isVideo) videos++; callSecs += dur; }
          } else if (msg.senderId === childUid) { sentMsgs++; totalMessagesSent++; }
        });
        if (sentMsgs > 0 || calls > 0) {
          if (!topContactsMap[key]) {
            const contactInfo = contactList.find(cl => cl.uid === otherUid) || {};
            topContactsMap[key] = { uid: otherUid, name: otherName, email: contactInfo.email || null, isGroup: !!convData.isGroup, messagesSent: 0, callCount: 0, videoCalls: 0, totalCallSecs: 0 };
          }
          topContactsMap[key].messagesSent += sentMsgs;
          topContactsMap[key].callCount += calls;
          topContactsMap[key].videoCalls += videos;
          topContactsMap[key].totalCallSecs += callSecs;
        }
      }));

      const topContacts = Object.values(topContactsMap)
        .sort((a, b) => (b.messagesSent + b.callCount * 5) - (a.messagesSent + a.callCount * 5))
        .slice(0, 8);

      // Vul ontbrekende e-mailadressen op via users-document
      const missingEmailUids = topContacts.filter(c => !c.email && !c.isGroup).map(c => c.uid);
      if (missingEmailUids.length > 0) {
        const userDocs = await Promise.allSettled(missingEmailUids.map(uid => db.collection('users').doc(uid).get()));
        userDocs.forEach((result, i) => {
          if (result.status === 'fulfilled' && result.value.exists) {
            const tc = topContacts.find(c => c.uid === missingEmailUids[i]);
            if (tc) tc.email = result.value.data().email || null;
          }
        });
      }

      // Vul ook ontbrekende e-mailadressen in contactList op
      const missingListUids = contactList.filter(c => !c.email).map(c => c.uid);
      if (missingListUids.length > 0) {
        const listDocs = await Promise.allSettled(missingListUids.map(uid => db.collection('users').doc(uid).get()));
        listDocs.forEach((result, i) => {
          if (result.status === 'fulfilled' && result.value.exists) {
            const entry = contactList.find(c => c.uid === missingListUids[i]);
            if (entry) entry.email = result.value.data().email || null;
          }
        });
      }

      const messaging = { totalMessagesSent, totalCallSecs, totalVideoSecs, topContacts };

      res.json({ profile, contacts: { total: contactsSnap.size, list: contactList.slice(0, 10) }, friendRequests, sessions, messaging });
    } catch (err) { console.error('Analytics error:', err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // GET /api/parent/child/:childUid/contacts — contacten van kind ophalen
  router.get('/api/parent/child/:childUid/contacts', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const { childUid } = req.params;
      const childDoc = await db.collection('users').doc(childUid).get();
      if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
      if (!isParentOf(req.uid, childDoc.data())) return res.status(403).json({ error: 'Geen toegang.' });

      const childData = childDoc.data();
      const blockedByParent = childData.blockedByParent || [];
      const blockedUsers    = childData.blockedUsers    || [];
      const parentContactUids = new Set([
        ...(Array.isArray(childData.parentIds) ? childData.parentIds : []),
        childData.parentId,
        childData.parentUid,
        childData.managedByParentId,
      ].filter(Boolean));

      const contactsSnap = await db.collection('users').doc(childUid).collection('contacts').get();
      const contacts = contactsSnap.docs.map(d => ({
        uid: d.id,
        displayName:      d.data().displayName,
        email:            d.data().email,
        photoURL:         d.data().photoURL || null,
        username:         d.data().username || null,
        relation:         d.data().relation || null,
        isBlocked:        blockedUsers.includes(d.id),
        isBlockedByParent: blockedByParent.includes(d.id),
        isParentContact:  parentContactUids.has(d.id),
      }));
      res.json(contacts);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // POST /api/parent/child/:childUid/block-contact — ouder blokkeert contact van kind
  router.post('/api/parent/child/:childUid/block-contact', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const { childUid } = req.params;
      const { targetUid } = req.body;
      if (!targetUid || typeof targetUid !== 'string') return res.status(400).json({ error: 'targetUid is verplicht.' });

      const [childDoc, targetDoc] = await Promise.all([
        db.collection('users').doc(childUid).get(),
        db.collection('users').doc(targetUid).get(),
      ]);
      if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
      if (!isParentOf(req.uid, childDoc.data())) return res.status(403).json({ error: 'Geen toegang.' });
      if (
        (Array.isArray(childDoc.data().parentIds) && childDoc.data().parentIds.includes(targetUid)) ||
        childDoc.data().parentId === targetUid ||
        childDoc.data().parentUid === targetUid ||
        childDoc.data().managedByParentId === targetUid
      ) {
        return res.status(400).json({ error: 'Co-ouders kunnen niet worden geblokkeerd via dit kindaccount.' });
      }

      const targetName = targetDoc.exists ? (targetDoc.data().displayName || targetUid) : targetUid;
      const childName  = childDoc.data().displayName || childUid;

      await db.collection('users').doc(childUid).update({
        blockedByParent: admin.firestore.FieldValue.arrayUnion(targetUid),
        blockedUsers:    admin.firestore.FieldValue.arrayUnion(targetUid),
      });

      // Real-time naar kind
      const childSockets = onlineUsers[childUid];
      if (childSockets) childSockets.forEach(sid => io.to(sid).emit('contact:blocked-by-parent', { targetUid, targetName }));

      // Push naar kind
      sendPush(childUid,
        { title: 'Pulse', body: `Je ouder heeft ${targetName} geblokkeerd.` },
        { type: 'blocked_by_parent' }
      ).catch(() => {});

      // Log parentActivities
      db.collection('parentActivities').add({
        parentId: req.uid, childUid, childName, targetName,
        type: 'parent_blocked_contact',
        description: `Ouder heeft ${targetName} geblokkeerd voor ${childName}.`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // POST /api/parent/child/:childUid/unblock-contact — ouder deblokkeer contact van kind
  router.post('/api/parent/child/:childUid/unblock-contact', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const { childUid } = req.params;
      const { targetUid } = req.body;
      if (!targetUid || typeof targetUid !== 'string') return res.status(400).json({ error: 'targetUid is verplicht.' });

      const [childDoc, targetDoc] = await Promise.all([
        db.collection('users').doc(childUid).get(),
        db.collection('users').doc(targetUid).get(),
      ]);
      if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
      if (!isParentOf(req.uid, childDoc.data())) return res.status(403).json({ error: 'Geen toegang.' });

      const targetName = targetDoc.exists ? (targetDoc.data().displayName || targetUid) : targetUid;
      const childName  = childDoc.data().displayName || childUid;

      await db.collection('users').doc(childUid).update({
        blockedByParent: admin.firestore.FieldValue.arrayRemove(targetUid),
        blockedUsers:    admin.firestore.FieldValue.arrayRemove(targetUid),
      });

      // Real-time naar kind
      const childSockets = onlineUsers[childUid];
      if (childSockets) childSockets.forEach(sid => io.to(sid).emit('contact:unblocked-by-parent', { targetUid, targetName }));

      db.collection('parentActivities').add({
        parentId: req.uid, childUid, childName, targetName,
        type: 'parent_unblocked_contact',
        description: `Ouder heeft ${targetName} gedeblokkeerd voor ${childName}.`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // POST /api/parent/child/:childUid/remove-contact — ouder verwijdert contact van kind
  router.post('/api/parent/child/:childUid/remove-contact', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const { childUid } = req.params;
      const { targetUid } = req.body;
      if (!targetUid || typeof targetUid !== 'string') return res.status(400).json({ error: 'targetUid is verplicht.' });

      const [childDoc, targetDoc] = await Promise.all([
        db.collection('users').doc(childUid).get(),
        db.collection('users').doc(targetUid).get(),
      ]);
      if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
      if (!isParentOf(req.uid, childDoc.data())) return res.status(403).json({ error: 'Geen toegang.' });
      if (
        (Array.isArray(childDoc.data().parentIds) && childDoc.data().parentIds.includes(targetUid)) ||
        childDoc.data().parentId === targetUid ||
        childDoc.data().parentUid === targetUid ||
        childDoc.data().managedByParentId === targetUid
      ) {
        return res.status(400).json({ error: 'Co-ouders kunnen niet worden verwijderd via dit kindaccount.' });
      }

      const targetName = targetDoc.exists ? (targetDoc.data().displayName || targetUid) : targetUid;
      const childName  = childDoc.data().displayName || childUid;

      // Verwijder wederzijds contact
      const batch = db.batch();
      batch.delete(db.collection('users').doc(childUid).collection('contacts').doc(targetUid));
      batch.delete(db.collection('users').doc(targetUid).collection('contacts').doc(childUid));
      await batch.commit();

      // Voeg toe aan removedByParent zodat kind niet opnieuw kan toevoegen
      await db.collection('users').doc(childUid).update({
        removedByParent: admin.firestore.FieldValue.arrayUnion(targetUid),
      });

      // Real-time naar kind
      const childSockets = onlineUsers[childUid];
      if (childSockets) childSockets.forEach(sid => io.to(sid).emit('contact:removed-by-parent', { targetUid, targetName }));

      // Push naar kind
      sendPush(childUid,
        { title: 'Pulse', body: `Je ouder heeft ${targetName} verwijderd uit je contacten.` },
        { type: 'removed_by_parent' }
      ).catch(() => {});

      db.collection('parentActivities').add({
        parentId: req.uid, childUid, childName, targetName,
        type: 'parent_removed_contact',
        description: `Ouder heeft ${targetName} verwijderd uit contacten van ${childName}.`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // ─── CO-OUDERSCHAP ────────────────────────────────────────────────────────────

  // POST /api/parent/invite-coparent — Ouder A nodigt Ouder B uit voor een kind
  router.post('/api/parent/invite-coparent', verifyAuth, async (req, res) => {
    try {
      const { childUid, toEmail } = req.body;
      if (!childUid || !toEmail) return res.status(400).json({ error: 'childUid en toEmail zijn verplicht.' });

      const cleanEmail = toEmail.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Ongeldig e-mailadres.' });

      // Controleer of de uitnodigende partij ouder is en toegang heeft tot het kind
      const [callerDoc, childDoc] = await Promise.all([
        db.collection('users').doc(req.uid).get(),
        db.collection('users').doc(childUid).get(),
      ]);
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      if (!childDoc.exists) return res.status(404).json({ error: 'Kind niet gevonden.' });
      if (!isParentOf(req.uid, childDoc.data())) return res.status(403).json({ error: 'Geen toegang tot dit kind.' });
      if (!isPrimaryParentOf(req.uid, childDoc.data())) {
        return res.status(403).json({ error: 'Alleen de oorspronkelijke ouder kan een andere ouder uitnodigen.' });
      }

      const callerData = callerDoc.data();
      const childData  = childDoc.data();

      // Uitgenodigde mag niet zichzelf zijn
      if (cleanEmail === (callerData.email || '').toLowerCase()) return res.status(400).json({ error: 'Je kunt jezelf niet uitnodigen.' });

      // Controleer of uitgenodigde al co-ouder is
      if (Array.isArray(childData.parentIds)) {
        const existingParentDocs = await Promise.all(childData.parentIds.map(pid => db.collection('users').doc(pid).get()));
        const alreadyCoparent = existingParentDocs.some(d => d.exists && (d.data().email || '').toLowerCase() === cleanEmail);
        if (alreadyCoparent) return res.status(400).json({ error: 'Deze ouder heeft al toegang tot dit kind.' });
      }

      // Controleer of er al een openstaande uitnodiging is
      const existing = await db.collection('coparentInvitations')
        .where('childUid', '==', childUid)
        .where('toEmail', '==', cleanEmail)
        .where('status', '==', 'pending')
        .limit(1).get();
      if (!existing.empty) return res.status(400).json({ error: 'Er is al een openstaande uitnodiging voor dit e-mailadres.' });

      // Sla uitnodiging op
      const inviteRef = await db.collection('coparentInvitations').add({
        childUid,
        childName:      childData.displayName || childUid,
        fromParentUid:  req.uid,
        fromParentName: callerData.displayName || callerData.email,
        fromParentEmail: callerData.email || '',
        toEmail:        cleanEmail,
        status:         'pending',
        createdAt:      admin.firestore.FieldValue.serverTimestamp(),
      });

      // Stuur uitnodigingsmail
      try {
        await transporter.sendMail({
          from: '"Pulse" <info@pulse-messenger.com>',
          to: cleanEmail,
          subject: `${callerData.displayName || 'Een ouder'} nodigt je uit als co-ouder op Pulse`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:auto">
              <h2 style="color:#7c4dff">Pulse — Co-ouder uitnodiging</h2>
              <p><strong>${callerData.displayName || callerData.email}</strong> wil jou toegang geven tot het account van <strong>${childData.displayName}</strong> op Pulse.</p>
              <p>Als je akkoord gaat, kun je ${childData.displayName} beheren in jouw Ouderlijk toezicht dashboard.</p>
              <p>Log in op Pulse en ga naar <strong>Ouderlijk toezicht</strong> om de uitnodiging te accepteren of te weigeren.</p>
              <p style="color:#888;font-size:13px">Heb je geen Pulse-account? Maak er gratis een aan op pulse-messenger.com.</p>
            </div>
          `,
        });
      } catch (mailErr) {
        console.error('[Pulse] Co-ouder uitnodigingsmail mislukt:', mailErr.message);
        // Uitnodiging is wel opgeslagen, mail fout is niet fataal
      }

      res.json({ success: true, inviteId: inviteRef.id });
    } catch (err) { console.error('invite-coparent fout:', err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // GET /api/parent/coparent-invitations — openstaande uitnodigingen voor ingelogde ouder
  router.get('/api/parent/coparent-invitations', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });

      const email = (callerDoc.data().email || '').toLowerCase();
      if (!email) return res.json([]);

      const snap = await db.collection('coparentInvitations')
        .where('toEmail', '==', email)
        .where('status', '==', 'pending')
        .get();

      const invitations = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt || null }));
      res.json(invitations);
    } catch (err) { console.error('coparent-invitations fout:', err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // POST /api/parent/coparent-invitations/:inviteId/accept — Ouder B accepteert
  router.post('/api/parent/coparent-invitations/:inviteId/accept', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });

      const callerEmail = (callerDoc.data().email || '').toLowerCase();
      const inviteRef  = db.collection('coparentInvitations').doc(req.params.inviteId);
      const inviteDoc  = await inviteRef.get();

      if (!inviteDoc.exists) return res.status(404).json({ error: 'Uitnodiging niet gevonden.' });
      const invite = inviteDoc.data();
      if (invite.status !== 'pending') return res.status(400).json({ error: 'Uitnodiging is al verwerkt.' });
      if (invite.toEmail !== callerEmail) return res.status(403).json({ error: 'Deze uitnodiging is niet voor jou.' });

      const childRef = db.collection('users').doc(invite.childUid);
      const childDoc = await childRef.get();
      if (!childDoc.exists) {
        await inviteRef.update({ status: 'expired' });
        return res.status(404).json({ error: 'Kindaccount bestaat niet meer.' });
      }

      const callerData = callerDoc.data();

      // Voeg req.uid toe aan parentIds van het kind
      await childRef.update({
        parentIds: admin.firestore.FieldValue.arrayUnion(req.uid),
      });

      // Voeg kind toe als contact van nieuwe ouder (en andersom)
      const childData = childDoc.data();
      const batch = db.batch();
      batch.set(db.collection('users').doc(req.uid).collection('contacts').doc(invite.childUid), {
        uid: invite.childUid,
        displayName: childData.displayName || invite.childName,
        email: childData.email || '',
        photoURL: childData.photoURL || null,
        addedAt: new Date().toISOString(),
        relation: 'familie',
      });
      batch.set(db.collection('users').doc(invite.childUid).collection('contacts').doc(req.uid), {
        uid: req.uid,
        displayName: callerData.displayName || callerData.email,
        email: callerData.email || '',
        photoURL: callerData.photoURL || null,
        addedAt: new Date().toISOString(),
        relation: 'familie',
      });
      await batch.commit();

      // Markeer uitnodiging als geaccepteerd
      await inviteRef.update({ status: 'accepted', acceptedAt: admin.firestore.FieldValue.serverTimestamp(), acceptedByUid: req.uid });

      db.collection('parentActivities').add({
        parentId: invite.fromParentUid,
        childUid: invite.childUid,
        childName: invite.childName,
        targetName: callerData.displayName || callerEmail,
        type: 'coparent_accepted',
        description: `${callerData.displayName || callerEmail} heeft de co-ouderuitnodiging voor ${invite.childName} geaccepteerd.`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      // Notificeer Ouder A via push
      sendPush(invite.fromParentUid,
        { title: 'Pulse', body: `${callerData.displayName || callerEmail} heeft de uitnodiging voor ${invite.childName} geaccepteerd.` },
        { type: 'coparent_accepted' }
      ).catch(() => {});

      // Real-time naar Ouder A als online
      const parentASockets = onlineUsers[invite.fromParentUid];
      if (parentASockets) parentASockets.forEach(sid => io.to(sid).emit('coparent:accepted', { childUid: invite.childUid, childName: invite.childName, coparentName: callerData.displayName || callerEmail }));

      res.json({ success: true });
    } catch (err) { console.error('accept-coparent fout:', err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // POST /api/parent/coparent-invitations/:inviteId/decline — Ouder B weigert
  router.post('/api/parent/coparent-invitations/:inviteId/decline', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });

      const callerEmail = (callerDoc.data().email || '').toLowerCase();
      const inviteRef   = db.collection('coparentInvitations').doc(req.params.inviteId);
      const inviteDoc   = await inviteRef.get();

      if (!inviteDoc.exists) return res.status(404).json({ error: 'Uitnodiging niet gevonden.' });
      const invite = inviteDoc.data();
      if (invite.status !== 'pending') return res.status(400).json({ error: 'Uitnodiging is al verwerkt.' });
      if (invite.toEmail !== callerEmail) return res.status(403).json({ error: 'Deze uitnodiging is niet voor jou.' });

      await inviteRef.update({ status: 'declined', declinedAt: admin.firestore.FieldValue.serverTimestamp() });

      db.collection('parentActivities').add({
        parentId: invite.fromParentUid,
        childUid: invite.childUid,
        childName: invite.childName,
        targetName: callerDoc.data().displayName || callerEmail,
        type: 'coparent_declined',
        description: `${callerDoc.data().displayName || callerEmail} heeft de co-ouderuitnodiging voor ${invite.childName} geweigerd.`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      // Notificeer Ouder A
      sendPush(invite.fromParentUid,
        { title: 'Pulse', body: `De uitnodiging voor ${invite.childName} is geweigerd.` },
        { type: 'coparent_declined' }
      ).catch(() => {});

      const parentASockets = onlineUsers[invite.fromParentUid];
      if (parentASockets) {
        const coparentName = callerDoc.data().displayName || callerEmail;
        parentASockets.forEach(sid => io.to(sid).emit('coparent:declined', {
          childUid: invite.childUid,
          childName: invite.childName,
          coparentName,
        }));
      }

      res.json({ success: true });
    } catch (err) { console.error('decline-coparent fout:', err); res.status(500).json({ error: 'Serverfout' }); }
  });

  return router;
};
