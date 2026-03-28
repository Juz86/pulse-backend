const { admin, db } = require('../firebase');
const { verifyAuth } = require('../middleware');
const { sendPush } = require('../push');
const { activeCalls } = require('../state');

module.exports = (io, onlineUsers) => {
  const router = require('express').Router();

  // GET /api/parent/children — haal gekoppelde kinderen op
  router.get('/api/parent/children', verifyAuth, async (req, res) => {
    try {
      const parentDoc = await db.collection('users').doc(req.uid).get();
      if (!parentDoc.exists || parentDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const snap = await db.collection('users').where('parentId', '==', req.uid).get();
      const children = snap.docs.map(d => {
        const { uid, displayName, username, email, photoURL, online, lastSeen, paused, pausedFeatures } = d.data();
        const pf = pausedFeatures || { chat: paused || false, call: paused || false, video: paused || false };
        return { uid, displayName, username: username || null, email, photoURL: photoURL || null, online: online || false, lastSeen: lastSeen || null, pausedFeatures: pf };
      });
      res.json(children);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
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
      if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });
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
      if (childData.parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });

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

  // POST /api/parent/pause/:childUid — pauzeer kind (feature: 'chat'|'call'|'video'|'all')
  router.post('/api/parent/pause/:childUid', verifyAuth, async (req, res) => {
    try {
      const callerDoc = await db.collection('users').doc(req.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== 'parent') return res.status(403).json({ error: 'Geen ouderaccount.' });
      const { childUid } = req.params;
      const childDoc = await db.collection('users').doc(childUid).get();
      if (!childDoc.exists) return res.status(404).json({ error: 'Niet gevonden.' });
      if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });

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
      if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });

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
      if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });

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
      if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });

      const childData = childDoc.data();
      const blockedByParent = childData.blockedByParent || [];
      const blockedUsers    = childData.blockedUsers    || [];

      const contactsSnap = await db.collection('users').doc(childUid).collection('contacts').get();
      const contacts = contactsSnap.docs.map(d => ({
        uid: d.id,
        displayName:      d.data().displayName,
        email:            d.data().email,
        photoURL:         d.data().photoURL || null,
        username:         d.data().username || null,
        isBlocked:        blockedUsers.includes(d.id),
        isBlockedByParent: blockedByParent.includes(d.id),
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
      if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });

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
      if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });

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
      if (childDoc.data().parentId !== req.uid) return res.status(403).json({ error: 'Geen toegang.' });

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

  return router;
};
