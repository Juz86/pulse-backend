const { db } = require('../firebase');
const { verifyAuth } = require('../middleware');
const { sendPush } = require('../push');

// Helper: controleer of req.uid de eigenaar is OF de gekoppelde ouder
async function canAccess(reqUid, targetUid) {
  if (reqUid === targetUid) return { allowed: true, role: 'self' };
  const targetDoc = await db.collection('users').doc(targetUid).get();
  if (!targetDoc.exists) return { allowed: false };
  if (targetDoc.data().parentId === reqUid) return { allowed: true, role: 'parent' };
  return { allowed: false };
}

module.exports = (io) => {
  const router = require('express').Router();

  // GET /api/agenda/:uid — haal activiteiten op
  router.get('/api/agenda/:uid', verifyAuth, async (req, res) => {
    try {
      const { uid } = req.params;
      const access = await canAccess(req.uid, uid);
      if (!access.allowed) return res.status(403).json({ error: 'Geen toegang.' });

      const snap = await db.collection('agenda').doc(uid).collection('activities')
        .orderBy('date', 'asc').get();
      const activities = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json(activities);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // POST /api/agenda/:uid — voeg activiteit toe
  router.post('/api/agenda/:uid', verifyAuth, async (req, res) => {
    try {
      const { uid } = req.params;
      const access = await canAccess(req.uid, uid);
      if (!access.allowed) return res.status(403).json({ error: 'Geen toegang.' });

      const { title, date, time } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: 'Titel is verplicht.' });
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Datum is verplicht (YYYY-MM-DD).' });
      if (time && !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Tijd moet HH:MM zijn.' });

      const createdBy = access.role === 'parent' ? 'parent' : 'child';
      const now = new Date().toISOString();

      const docRef = await db.collection('agenda').doc(uid).collection('activities').add({
        title: title.trim(),
        date,
        time: time || null,
        createdBy,
        createdAt: now,
        updatedBy: createdBy,
        updatedAt: now,
      });

      // Notificaties
      if (createdBy === 'child') {
        // Push naar ouder
        const childDoc = await db.collection('users').doc(uid).get();
        const childName = childDoc.data()?.displayName || 'Je kind';
        const parentId  = childDoc.data()?.parentId;
        const dateLabel = new Date(date).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
        if (parentId) {
          await sendPush(parentId, {
            title: 'Pulse Agenda',
            body: `${childName} heeft '${title.trim()}' toegevoegd op ${dateLabel}.`,
          }, { type: 'agenda_add', childUid: uid });
          // Log in parentActivities
          await db.collection('parentActivities').add({
            parentId,
            childUid: uid,
            type: 'agenda_add',
            description: `${childName} heeft '${title.trim()}' toegevoegd aan agenda.`,
            createdAt: now,
          });
        }
      } else {
        // In-app toast naar kind via socket
        if (io) {
          io.to(`user:${uid}`).emit('agenda:toast', {
            message: `Je ouder heeft '${title.trim()}' toegevoegd aan je agenda.`,
          });
        }
      }

      res.status(201).json({ id: docRef.id });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // PUT /api/agenda/:uid/:activityId — bewerk activiteit
  router.put('/api/agenda/:uid/:activityId', verifyAuth, async (req, res) => {
    try {
      const { uid, activityId } = req.params;
      const access = await canAccess(req.uid, uid);
      if (!access.allowed) return res.status(403).json({ error: 'Geen toegang.' });

      const { title, date, time } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: 'Titel is verplicht.' });
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Datum is verplicht (YYYY-MM-DD).' });

      const updatedBy = access.role === 'parent' ? 'parent' : 'child';
      const now = new Date().toISOString();

      await db.collection('agenda').doc(uid).collection('activities').doc(activityId).update({
        title: title.trim(),
        date,
        time: time || null,
        updatedBy,
        updatedAt: now,
      });

      // Notificatie kind als ouder wijzigt
      if (updatedBy === 'parent' && io) {
        io.to(`user:${uid}`).emit('agenda:toast', {
          message: `Je ouder heeft '${title.trim()}' gewijzigd in je agenda.`,
        });
      }

      // Push naar ouder als kind wijzigt
      if (updatedBy === 'child') {
        const childDoc = await db.collection('users').doc(uid).get();
        const childName = childDoc.data()?.displayName || 'Je kind';
        const parentId  = childDoc.data()?.parentId;
        if (parentId) {
          await sendPush(parentId, {
            title: 'Pulse Agenda',
            body: `${childName} heeft '${title.trim()}' gewijzigd.`,
          }, { type: 'agenda_edit', childUid: uid });
        }
      }

      res.json({ ok: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
  });

  // DELETE /api/agenda/:uid/:activityId — verwijder activiteit
  router.delete('/api/agenda/:uid/:activityId', verifyAuth, async (req, res) => {
    try {
      const { uid, activityId } = req.params;
      const access = await canAccess(req.uid, uid);
      if (!access.allowed) return res.status(403).json({ error: 'Geen toegang.' });

      const docRef = db.collection('agenda').doc(uid).collection('activities').doc(activityId);
      const docSnap = await docRef.get();
      const actTitle = docSnap.exists ? docSnap.data().title : 'Activiteit';

      await docRef.delete();

      // In-app toast naar kind als ouder verwijdert
      if (access.role === 'parent' && io) {
        io.to(`user:${uid}`).emit('agenda:toast', {
          message: `Je ouder heeft '${actTitle}' verwijderd uit je agenda.`,
        });
      }

      res.json({ ok: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Serverfout' }); }
  });

  return router;
};
