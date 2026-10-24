const { admin, db } = require('../firebase');
const { schemas, validate } = require('../validate');
const { sendPush } = require('../push');
const {
  initialGroupEpochFields,
  rotateGroupEpochFields,
} = require('../e2ee/group/epochLifecycle');

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

      const groupEpochFields = isGroup ? initialGroupEpochFields(members) : {};
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
        ...groupEpochFields,
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
        ...groupEpochFields,
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
      const convRef = db.collection('conversations').doc(convId);
      const result = await db.runTransaction(async (transaction) => {
        const convDoc = await transaction.get(convRef);
        if (!convDoc.exists || !(convDoc.data().members || []).includes(uid)) {
          throw new Error('Geen toegang.');
        }
        const convData = convDoc.data() || {};
        if (!convData.isGroup) throw new Error('Dit is geen groepsgesprek.');
        if (!isGroupAdmin(convData, uid)) {
          throw new Error('Alleen de groepsbeheerder kan leden toevoegen.');
        }
        const nextMembers = [...new Set([...(convData.members || []), targetUid])];
        const membershipChanged = nextMembers.length !== (convData.members || []).length;
        const epochFields = membershipChanged
          ? rotateGroupEpochFields(
            convData,
            nextMembers,
            admin.firestore.FieldValue.serverTimestamp(),
          )
          : {};
        transaction.update(convRef, {
          members: nextMembers,
          [`memberNames.${targetUid}`]: displayName,
          ...epochFields,
        });
        return { convData, nextMembers, epochFields };
      });
      const conversation = {
        id: convId,
        ...result.convData,
        members: result.nextMembers,
        memberNames: { ...(result.convData.memberNames || {}), [targetUid]: displayName },
        ...result.epochFields,
      };
      const payload = { convId, uid: targetUid, conversation };
      // Snake_case en het conversation-object vormen het gedeelde realtime
      // contract met de client. Het nieuwe lid zit nog niet in de room en
      // krijgt daarom ook een directe invalidatie voor zijn gesprekkenlijst.
      io.to(convId).emit('conversation:member_added', payload);
      emitToUser(io, targetUid, 'conversation:member_added', payload);
      cb?.({});
    } catch (e) { cb?.({ error: e.message }); }
  });

  // ── Groepslid verwijderen ──
  socket.on('conversation:removeMember', async ({ convId, uid: targetUid }, cb) => {
    try {
      const convRef = db.collection('conversations').doc(convId);
      const result = await db.runTransaction(async (transaction) => {
        const convDoc = await transaction.get(convRef);
        if (!convDoc.exists || !(convDoc.data().members || []).includes(uid)) {
          throw new Error('Geen toegang.');
        }
        const convData = convDoc.data() || {};
        const members = convData.members || [];
        const isSelfLeave = targetUid === uid;
        if (!members.includes(targetUid)) throw new Error('Geen toegang.');
        if (!convData.isGroup) throw new Error('Dit is geen groepsgesprek.');
        if (!isSelfLeave && !isGroupAdmin(convData, uid)) {
          throw new Error('Alleen beheerders kunnen leden verwijderen.');
        }
        if (!isSelfLeave && isGroupAdmin(convData, targetUid)) {
          throw new Error('Een beheerder kan een andere beheerder niet verwijderen.');
        }
        const nextMembers = members.filter(memberUid => memberUid !== targetUid);
        const epochFields = rotateGroupEpochFields(
          convData,
          nextMembers,
          admin.firestore.FieldValue.serverTimestamp(),
        );
        const update = {
          members: nextMembers,
          [`memberNames.${targetUid}`]: admin.firestore.FieldValue.delete(),
          ...epochFields,
        };
        if (convData.creatorId === targetUid) {
          const nextCreatorId = nextMembers[0];
          if (nextCreatorId) update.creatorId = nextCreatorId;
          else update.creatorId = admin.firestore.FieldValue.delete();
        }
        transaction.update(convRef, update);
        return { convData, nextMembers, epochFields };
      });
      const { convData, nextMembers, epochFields } = result;
      const memberNames = { ...(convData.memberNames || {}) };
      delete memberNames[targetUid];
      const conversation = {
        id: convId,
        ...convData,
        members: nextMembers,
        memberNames,
        ...epochFields,
        ...(convData.creatorId === targetUid ? { creatorId: nextMembers[0] || null } : {}),
      };
      const payload = { convId, uid: targetUid, removedSelf: false, conversation };
      io.to(convId).emit('conversation:member_removed', payload);
      // De verwijderde gebruiker ontvangt een eigen payload zodat de client
      // direct de geopende groep sluit en uit zijn gesprekkenlijst verwijdert.
      emitToUser(io, targetUid, 'conversation:member_removed', {
        ...payload,
        removedSelf: true,
      });
      cb?.({});
    } catch (e) { cb?.({ error: e.message }); }
  });

  // ── Groep opheffen ──
  socket.on('conversation:dissolveGroup', async ({ convId }, cb = () => {}) => {
    if (!convId) return cb({ error: 'Ongeldige groep.' });
    try {
      const convRef = db.collection('conversations').doc(convId);
      const convDoc = await convRef.get();
      if (!convDoc.exists) return cb({ error: 'Groep niet gevonden.' });

      const conversation = convDoc.data() || {};
      if (!conversation.isGroup) return cb({ error: 'Dit is geen groepsgesprek.' });
      if (!(conversation.members || []).includes(uid)) return cb({ error: 'Je zit niet in deze groep.' });
      if (!isGroupAdmin(conversation, uid)) return cb({ error: 'Alleen beheerders kunnen een groep opheffen.' });

      await db.recursiveDelete(convRef);

      (conversation.members || []).forEach((memberUid) => {
        emitToUser(io, memberUid, 'conversation:dissolved', { convId, groupName: conversation.groupName || '' });
      });
      cb({ ok: true, convId });
    } catch (error) {
      console.error('Groep opheffen mislukt:', error);
      cb({ error: 'Groep kon niet worden opgeheven.' });
    }
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

  socket.on('conversation:relinquishAdmin', async ({ convId }, cb = () => {}) => {
    if (!convId) return cb({ error: 'Ongeldige groep.' });
    try {
      const convRef = db.collection('conversations').doc(convId);
      const convDoc = await convRef.get();
      if (!convDoc.exists) return cb({ error: 'Groep niet gevonden.' });

      const currentConversation = convDoc.data() || {};
      if (!currentConversation.isGroup) return cb({ error: 'Dit is geen groepsgesprek.' });
      if (!(currentConversation.members || []).includes(uid)) return cb({ error: 'Je zit niet in deze groep.' });
      if (!isGroupAdmin(currentConversation, uid)) return cb({ error: 'Je bent geen beheerder van deze groep.' });

      const adminIds = Array.from(new Set(currentConversation.adminIds || [currentConversation.creatorId])).filter(Boolean);
      const nextAdminIds = adminIds.filter((adminUid) => adminUid !== uid);
      if (!nextAdminIds.length) return cb({ error: 'Maak eerst een ander groepslid beheerder.' });

      const updatedAt = new Date().toISOString();
      const conversation = { id: convId, ...currentConversation, adminIds: nextAdminIds, updatedAt };
      await convRef.update({ adminIds: nextAdminIds, updatedAt });
      (currentConversation.members || []).forEach((memberUid) => {
        emitToUser(io, memberUid, 'conversation:admins_updated', {
          conversation,
          relinquishedUid: uid,
        });
      });
      cb({ ok: true, conversation });
    } catch (error) {
      console.error('Beheerderrol opgeven mislukt:', error);
      cb({ error: 'Beheerderrol kon niet worden opgegeven.' });
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
