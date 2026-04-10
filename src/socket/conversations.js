const { admin, db } = require('../firebase');
const { schemas, validate } = require('../validate');

module.exports = function registerConversations(io, socket, uid) {
  // ── Gesprek aanmaken ──
  socket.on('conversation:create', async (data, callback) => {
    const validated = validate(schemas.convCreate, data, callback);
    if (!validated) return;
    const { members, memberNames, memberEmails, isGroup, groupName } = validated;
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
        creatorId: isGroup ? uid : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessage: null,
      });

      const convId = convRef.id;
      const conversationPayload = {
        id: convId,
        members,
        memberNames,
        memberEmails: memberEmails || {},
        isGroup: isGroup || false,
        groupName: groupName || null,
        creatorId: isGroup ? uid : null,
        lastMessage: null,
      };

      // Notificeer alle andere leden zodat zij de conversation:join kunnen uitvoeren
      const { onlineUsers } = require('../state');
      members.forEach(memberUid => {
        if (memberUid === uid) return;
        const sockets = onlineUsers[memberUid];
        if (sockets) sockets.forEach(sid => io.to(sid).emit('conversation:created', conversationPayload));
      });

      callback({ convId, existing: false });
    } catch (err) {
      console.error(err);
      callback({ error: 'Gesprek kon niet worden aangemaakt' });
    }
  });

  // ── Groepslid toevoegen ──
  socket.on('conversation:addMember', async ({ convId, uid: targetUid, displayName }, cb) => {
    try {
      const convDoc = await db.collection('conversations').doc(convId).get();
      if (!convDoc.exists || !(convDoc.data().members || []).includes(uid)) { cb?.({ error: 'Geen toegang.' }); return; }
      if (convDoc.data().isGroup && convDoc.data().creatorId && convDoc.data().creatorId !== uid) { cb?.({ error: 'Alleen de groepsbeheerder kan leden toevoegen.' }); return; }
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
      if (convDoc.data().isGroup && convDoc.data().creatorId && convDoc.data().creatorId !== uid) { cb?.({ error: 'Alleen de groepsbeheerder kan leden verwijderen.' }); return; }
      const update = { members: admin.firestore.FieldValue.arrayRemove(targetUid) };
      update[`memberNames.${targetUid}`] = admin.firestore.FieldValue.delete();
      await db.collection('conversations').doc(convId).update(update);
      io.to(convId).emit('conversation:memberRemoved', { convId, uid: targetUid });
      cb?.({});
    } catch (e) { cb?.({ error: e.message }); }
  });
};
