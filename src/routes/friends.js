const { admin, db } = require('../firebase');
const { verifyAuth, friendReqLimiter } = require('../middleware');
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

module.exports = (io, onlineUsers) => {
  const router = require('express').Router();

  // ─── REST: Vriendschapsverzoek sturen ────────────────────────────────────────
  router.post('/api/friend-requests', verifyAuth, friendReqLimiter, async (req, res) => {
    try {
      const { fromUid, fromName, fromEmail, fromPhoto, toEmail, toIdentifier } = req.body;
      const identifier = normalizeIdentifier(toIdentifier || toEmail || '');
      if (!fromUid || !identifier) {
        return res.status(400).json({ error: 'fromUid en een e-mailadres of gebruikersnaam zijn verplicht' });
      }
      if (!validEmail(identifier) && !USERNAME_REGEX.test(identifier)) {
        return res.status(400).json({ error: 'Gebruik een geldig e-mailadres of gebruikersnaam.' });
      }
      if (req.uid !== fromUid) return res.status(403).json({ error: 'Geen toegang.' });

      const toUser = await findUserByIdentifier(identifier);
      if (!toUser) return res.status(404).json({ error: 'Gebruiker niet gevonden' });

      if (toUser.uid === fromUid) return res.status(400).json({ error: 'Je kunt jezelf niet toevoegen' });

      // Check of contact verwijderd is door ouder
      const senderDoc = await db.collection('users').doc(fromUid).get();
      const removedByParent = senderDoc.data()?.removedByParent || [];
      if (removedByParent.includes(toUser.uid)) {
        return res.status(403).json({ error: 'Dit contact kan niet worden toegevoegd.' });
      }

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
        const description = `${fromName} heeft een vriendschapsverzoek verstuurd naar ${toUser.displayName || toUser.email || identifier}.`;
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
  router.get('/api/friend-requests/:uid', verifyAuth, async (req, res) => {
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
  router.post('/api/friend-requests/:requestId/accept', verifyAuth, async (req, res) => {
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

      // Notificeer de verzender realtime, of via push als offline
      const senderSocket = getSocketId(fromUid);
      if (senderSocket) {
        io.to(senderSocket).emit('friend:accepted', { byUid: toUid, byName: toName, byEmail: toEmail });
      } else {
        sendPush(fromUid,
          { title: 'Pulse — Verzoek geaccepteerd', body: `${toName} heeft jouw vriendschapsverzoek geaccepteerd.` },
          {}
        ).catch(e => console.warn('[Pulse] Push bij acceptatie mislukt:', e.message));
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
  router.post('/api/friend-requests/:requestId/decline', verifyAuth, async (req, res) => {
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

  return router;
};
