const { admin, db } = require('../firebase');
const { schemas, validate } = require('../validate');
const { sendPush } = require('../push');

function isGroupAdmin(conversation, uid) {
  return Array.isArray(conversation?.adminIds)
    ? conversation.adminIds.includes(uid)
    : conversation?.creatorId === uid;
}

function emitToUser(io, uid, event, payload) {
  const { onlineUsers } = require('../state');
  const sockets = onlineUsers[uid];
  if (!sockets) return;
  sockets.forEach((socketId) => io.to(socketId).emit(event, payload));
}

module.exports = function registerConversations(io, socket, uid) {
  db.collection('group_admin_promotions').where('targetUid', '==', uid).get()
    .then((snapshot) => {
      snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((request) => request.status === 'pending')
        .forEach((request) => socket.emit('conversation:admin_promotion_requested', { request }));
    })
    .catch((error) => console.warn('Beheerderverzoeken ophalen mislukt:', error.message));

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
      const convData = convDoc.data() || {};
      const members = convData.members || [];
      const isSelfLeave = targetUid === uid;
      if (!members.includes(targetUid)) { cb?.({ error: 'Geen toegang.' }); return; }
      if (convData.isGroup && convData.creatorId && convData.creatorId !== uid && !isSelfLeave) { cb?.({ error: 'Alleen de groepsbeheerder kan leden verwijderen.' }); return; }
      const update = { members: admin.firestore.FieldValue.arrayRemove(targetUid) };
      update[`memberNames.${targetUid}`] = admin.firestore.FieldValue.delete();
      if (convData.isGroup && convData.creatorId === targetUid) {
        const nextCreatorId = members.find(memberUid => memberUid !== targetUid);
        if (nextCreatorId) update.creatorId = nextCreatorId;
        else update.creatorId = admin.firestore.FieldValue.delete();
      }
      await db.collection('conversations').doc(convId).update(update);
      io.to(convId).emit('conversation:memberRemoved', { convId, uid: targetUid });
      cb?.({});
    } catch (e) { cb?.({ error: e.message }); }
  });

  socket.on('conversation:promoteAdmin', async ({ convId, uid: targetUid }, cb = () => {}) => {
    if (!convId || !targetUid) return cb({ error: 'Ongeldig beheerderverzoek.' });
    try {
      const convRef = db.collection('conversations').doc(convId);
      const convDoc = await convRef.get();
      if (!convDoc.exists) return cb({ error: 'Groep niet gevonden.' });

      const conversation = convDoc.data() || {};
      if (!conversation.isGroup) return cb({ error: 'Dit is geen groepsgesprek.' });
      if (!isGroupAdmin(conversation, uid)) return cb({ error: 'Alleen beheerders kunnen dit verzoek versturen.' });
      if (!(conversation.members || []).includes(targetUid)) return cb({ error: 'Dit lid zit niet in de groep.' });
      if (isGroupAdmin(conversation, targetUid)) return cb({ error: 'Dit lid is al beheerder.' });

      const requestRef = db.collection('group_admin_promotions').doc(`${convId}_${targetUid}`);
      const existingRequest = await requestRef.get();
      if (existingRequest.exists && existingRequest.data()?.status === 'pending') {
        return cb({ error: 'Er staat al een beheerderverzoek open.' });
      }

      const requestedByName = conversation.memberNames?.[uid] || conversation.memberEmails?.[uid] || uid;
      const request = {
        id: requestRef.id,
        convId,
        targetUid,
        requestedByUid: uid,
        requestedByName,
        groupName: conversation.groupName || 'deze groep',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await requestRef.set(request);
      emitToUser(io, targetUid, 'conversation:admin_promotion_requested', { request });
      sendPush(targetUid, {
        title: 'Beheerderverzoek',
        body: `${requestedByName} vraagt je beheerder te worden van ${request.groupName}.`,
      }, { type: 'group_admin_promotion', convId, requestId: request.id }).catch(() => {});
      cb({ ok: true, request });
    } catch (error) {
      console.error('Beheerderverzoek versturen mislukt:', error);
      cb({ error: 'Beheerderverzoek kon niet worden verstuurd.' });
    }
  });

  socket.on('conversation:respondToAdminPromotion', async ({ requestId, accept }, cb = () => {}) => {
    if (!requestId || typeof accept !== 'boolean') return cb({ error: 'Ongeldige reactie.' });
    try {
      const requestRef = db.collection('group_admin_promotions').doc(requestId);
      const requestDoc = await requestRef.get();
      if (!requestDoc.exists) return cb({ error: 'Beheerderverzoek niet gevonden.' });
      const request = requestDoc.data();
      if (request.targetUid !== uid || request.status !== 'pending') return cb({ error: 'Dit beheerderverzoek is niet meer beschikbaar.' });

      const convRef = db.collection('conversations').doc(request.convId);
      const convDoc = await convRef.get();
      if (!convDoc.exists) return cb({ error: 'Groep niet gevonden.' });
      const currentConversation = convDoc.data() || {};
      if (!currentConversation.isGroup || !(currentConversation.members || []).includes(uid)) {
        return cb({ error: 'Je zit niet meer in deze groep.' });
      }

      const updatedAt = new Date().toISOString();
      await requestRef.update({ status: accept ? 'accepted' : 'declined', respondedAt: updatedAt, updatedAt });
      if (!accept) return cb({ ok: true, accepted: false });

      const adminIds = Array.from(new Set([...(currentConversation.adminIds || [currentConversation.creatorId]), uid].filter(Boolean)));
      const conversation = { id: request.convId, ...currentConversation, adminIds, updatedAt };
      await convRef.update({ adminIds, updatedAt });
      (currentConversation.members || []).forEach((memberUid) => {
        emitToUser(io, memberUid, 'conversation:admins_updated', {
          conversation,
          promotedUid: uid,
          promotedByName: request.requestedByName,
        });
      });
      cb({ ok: true, accepted: true, conversation });
    } catch (error) {
      console.error('Beheerderverzoek beantwoorden mislukt:', error);
      cb({ error: 'Beheerderverzoek kon niet worden verwerkt.' });
    }
  });
};
