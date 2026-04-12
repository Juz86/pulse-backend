const { admin, db } = require('../firebase');
const { queueMessage } = require('../redis');
const { sendPush } = require('../push');
const { schemas, validate } = require('../validate');
const { getMessageHistoryType, resolveConversationHistoryRules } = require('../cleanup');

function emitToOnlineMembersOutsideConversation(io, convId, members, senderId, eventName, payload, onlineUsers) {
  const roomSockets = io.sockets.adapter.rooms.get(convId) || new Set();

  members.forEach(memberUid => {
    if (memberUid === senderId) return;
    const sockets = onlineUsers[memberUid];
    if (!sockets) return;
    sockets.forEach(sid => {
      if (roomSockets.has(sid)) return;
      io.to(sid).emit(eventName, payload);
    });
  });
}

module.exports = function registerMessages(io, socket, uid) {
  // ── Gesprek / kamer joinen ──
  socket.on('conversation:join', async ({ convId }) => {
    try {
      const convDoc = await db.collection('conversations').doc(convId).get();
      if (!convDoc.exists || !(convDoc.data().members || []).includes(uid)) return;
      socket.join(convId);
    } catch {}
  });

  // ── Bericht sturen ──
  socket.on('message:send', async (data, callback) => {
    const validated = validate(schemas.messageSend, data, callback);
    if (!validated) return;
    const { convId, message } = validated;
    try {
      // Blokkeer gepauzeerde accounts + verifieer lidmaatschap
      const [senderDoc, convMemberDoc] = await Promise.all([
        db.collection('users').doc(uid).get(),
        db.collection('conversations').doc(convId).get(),
      ]);
      const senderData = senderDoc.data() || {};
      const senderPf = senderData.pausedFeatures || (senderData.paused ? { chat: true, call: true, video: true } : null);
      if (senderDoc.exists && senderPf?.chat) {
        if (typeof callback === 'function') callback({ error: 'Chatten is gepauzeerd door je ouder.' });
        return;
      }
      if (!convMemberDoc.exists || !(convMemberDoc.data().members || []).includes(uid)) {
        if (typeof callback === 'function') callback({ error: 'Geen toegang tot dit gesprek.' });
        return;
      }

      // Blokkeer check (alleen 1-op-1 gesprekken)
      const convDataCheck = convMemberDoc.data();
      if (!convDataCheck.isGroup) {
        const otherUid = (convDataCheck.members || []).find(m => m !== uid);
        if (otherUid) {
          const senderBlocked = senderData.blockedUsers || [];
          if (senderBlocked.includes(otherUid)) {
            // Afzender heeft de ander geblokkeerd — stille drop
            if (typeof callback === 'function') callback({ id: 'dropped_' + Date.now(), ...message, senderId: socket.userId, status: 'verstuurd' });
            return;
          }
          const otherDoc = await db.collection('users').doc(otherUid).get();
          const otherBlocked = otherDoc.data()?.blockedUsers || [];
          if (otherBlocked.includes(uid)) {
            // Ontvanger heeft de afzender geblokkeerd — stille drop (afzender weet het niet)
            if (typeof callback === 'function') callback({ id: 'dropped_' + Date.now(), ...message, senderId: socket.userId, status: 'verstuurd' });
            return;
          }
        }
      }

      const verifiedMessage = { ...message, senderId: socket.userId };
      const convMembers = convMemberDoc.data().members || [];
      const historyRules = await resolveConversationHistoryRules(convMembers);
      const isEphemeralDirectChat =
        !convDataCheck.isGroup &&
        getMessageHistoryType(verifiedMessage) === 'chat' &&
        Number(historyRules?.chatRetentionDays ?? 30) === 0;
      const lastMessage = verifiedMessage.type === 'contact'
        ? `Contactpersoon: ${verifiedMessage.sharedContact?.name || ''}`
        : verifiedMessage.type === 'call' ? (verifiedMessage.isVideo ? 'Video-oproep' : 'Spraakoproep')
        : verifiedMessage.text;

      if (isEphemeralDirectChat) {
        const transientMsg = {
          id: `transient_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          convId,
          ...verifiedMessage,
          status: 'verstuurd',
          createdAt: new Date().toISOString(),
          transient: true,
        };
        const { onlineUsers } = require('../state');
        const receiverUids = convMembers.filter(memberUid => memberUid !== verifiedMessage.senderId);
        const anyReceiverOnline = receiverUids.some(memberUid => onlineUsers[memberUid]?.size);

        io.to(convId).emit('message:received', transientMsg);
        emitToOnlineMembersOutsideConversation(
          io,
          convId,
          convMembers,
          verifiedMessage.senderId,
          'message:received',
          transientMsg,
          onlineUsers,
        );

        if (typeof callback === 'function') callback(transientMsg);
        if (anyReceiverOnline) {
          socket.emit('message:status', { convId, msgId: transientMsg.id, status: 'bezorgd' });
        }
        return;
      }

      // Sla bericht op en update gesprek tegelijk (parallel)
      const [msgRef] = await Promise.all([
        db.collection('conversations').doc(convId).collection('messages').add({
          ...verifiedMessage,
          status: 'verstuurd',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
        db.collection('conversations').doc(convId).update({
          lastMessage,
          lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          deletedFor: [],  // Herstel gesprek voor iedereen die het had verwijderd
        }),
      ]);

      const savedMsg = { id: msgRef.id, ...verifiedMessage, status: 'verstuurd' };

      // Stuur bericht naar iedereen in de kamer (inclusief afzender)
      io.to(convId).emit('message:received', savedMsg);

      // Bevestig aan afzender zodat optimistic bericht vervangen kan worden
      if (typeof callback === 'function') callback(savedMsg);

      // Push notificaties + bezorgstatus asynchroon — blokkeert de socket handler niet
      (async () => {
        try {
          const { onlineUsers } = require('../state');
          const convDoc = await db.collection('conversations').doc(convId).get();
          const members = convDoc.data()?.members || [];
          const senderName = verifiedMessage.senderName || 'Iemand';

          // Stuur ook rechtstreeks naar elk lid (ook als ze de chat niet open hebben)
          const receiverUids = members.filter(memberUid => memberUid !== verifiedMessage.senderId);
          const anyReceiverOnline = receiverUids.some(memberUid => onlineUsers[memberUid]?.size);
          emitToOnlineMembersOutsideConversation(
            io,
            convId,
            members,
            verifiedMessage.senderId,
            'message:received',
            savedMsg,
            onlineUsers,
          );

          // Als ontvanger online is → markeer als bezorgd in Firestore en notificeer verzender
          if (anyReceiverOnline) {
            await msgRef.update({ status: 'bezorgd' });
            socket.emit('message:status', { convId, msgId: savedMsg.id, status: 'bezorgd' });
          }

          const offlineMembers = members.filter(memberUid =>
            memberUid !== verifiedMessage.senderId && !onlineUsers[memberUid]?.size
          );
          // Verwerk in batches van 5 om Firestore/FCM overbelasting te voorkomen
          const BATCH_SIZE = 5;
          for (let i = 0; i < offlineMembers.length; i += BATCH_SIZE) {
            const batch = offlineMembers.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (memberUid) => {
              await queueMessage(memberUid, savedMsg);
              await sendPush(memberUid,
                { title: senderName, body: verifiedMessage.text?.substring(0, 100) || 'Nieuw bericht' },
                { convId }
              );
            }));
          }

          // @vermeldingen verwerken
          const mentionedUids = Array.isArray(verifiedMessage.mentions) ? verifiedMessage.mentions : [];
          if (mentionedUids.length > 0 && convDoc.data()?.isGroup) {
            const groupName = convDoc.data()?.groupName || 'een groep';
            for (const mentionedUid of mentionedUids) {
              if (mentionedUid === verifiedMessage.senderId) continue;
              if (!members.includes(mentionedUid)) continue;
              const mentionedSockets = onlineUsers[mentionedUid];
              if (mentionedSockets) {
                mentionedSockets.forEach(sid => io.to(sid).emit('mention:notify', {
                  convId, senderName, groupName,
                }));
              } else {
                sendPush(mentionedUid,
                  { title: `${senderName} heeft je vermeld`, body: `In ${groupName}: ${verifiedMessage.text?.substring(0, 80) || ''}` },
                  { convId }
                ).catch(e => console.warn('mention push mislukt:', e.message));
              }
            }
          }
        } catch (e) { console.warn('Push/bezorgstatus fout na message:send:', e.message); }
      })();
    } catch (err) {
      console.error('Fout bij opslaan bericht:', err);
      socket.emit('error', { message: 'Bericht kon niet worden opgeslagen' });
    }
  });

  // ── Emoji-reactie op bericht ──
  socket.on('message:react', async (data, callback) => {
    const validated = validate(schemas.messageReact, data, callback);
    if (!validated) return;
    const { convId, msgId, emoji } = validated;
    try {
      const { onlineUsers } = require('../state');
      const convDoc = await db.collection('conversations').doc(convId).get();
      if (!convDoc.exists || !(convDoc.data().members || []).includes(uid)) return callback?.({ error: 'Geen toegang.' });

      const msgRef = db.collection('conversations').doc(convId).collection('messages').doc(msgId);
      const msgDoc = await msgRef.get();
      if (!msgDoc.exists) return callback?.({ error: 'Bericht niet gevonden.' });

      const currentReactors = (msgDoc.data().reactions || {})[emoji] || [];
      const hasReacted = currentReactors.includes(uid);
      const field = `reactions.${emoji}`;
      await msgRef.update({
        [field]: hasReacted
          ? admin.firestore.FieldValue.arrayRemove(uid)
          : admin.firestore.FieldValue.arrayUnion(uid),
      });

      const updatedReactions = (await msgRef.get()).data().reactions || {};
      const payload = { convId, msgId, reactions: updatedReactions };
      io.to(convId).emit('message:reaction', payload);
      const members = convDoc.data().members || [];
      emitToOnlineMembersOutsideConversation(
        io,
        convId,
        members,
        null,
        'message:reaction',
        payload,
        onlineUsers,
      );
      callback?.({ success: true });
    } catch (err) {
      console.error('Fout bij reactie:', err);
      callback?.({ error: 'Serverfout' });
    }
  });

  // ── Bericht bewerken ──
  socket.on('message:edit', async (data, callback) => {
    const validated = validate(schemas.messageEdit, data, callback);
    if (!validated) return;
    const { convId, msgId, newText } = validated;
    try {
      const { onlineUsers } = require('../state');
      const trimmed = newText.trim();
      if (!trimmed) return callback?.({ error: 'Bericht mag niet leeg zijn.' });

      const msgRef = db.collection('conversations').doc(convId).collection('messages').doc(msgId);
      const msgDoc = await msgRef.get();
      if (!msgDoc.exists) return callback?.({ error: 'Bericht niet gevonden.' });
      if (msgDoc.data().senderId !== uid) return callback?.({ error: 'Alleen eigen berichten bewerken.' });
      if (msgDoc.data().type && msgDoc.data().type !== 'text') return callback?.({ error: 'Dit bericht kan niet bewerkt worden.' });

      const editedAt = new Date().toISOString();
      await msgRef.update({ text: trimmed, editedAt });

      const payload = { convId, msgId, text: trimmed, editedAt };
      io.to(convId).emit('message:edited', payload);
      const convDoc = await db.collection('conversations').doc(convId).get();
      const members = convDoc.exists ? (convDoc.data().members || []) : [];
      emitToOnlineMembersOutsideConversation(
        io,
        convId,
        members,
        null,
        'message:edited',
        payload,
        onlineUsers,
      );

      callback?.({ success: true });
    } catch (err) {
      console.error('Fout bij bewerken bericht:', err);
      callback?.({ error: 'Serverfout' });
    }
  });

  // ── Berichtenstatus: gelezen ──
  socket.on('messages:read', async ({ convId }) => {
    try {
      const { onlineUsers } = require('../state');
      // Haal gesprekleden op om verzenders te notificeren
      const convDoc = await db.collection('conversations').doc(convId).get();
      const members = convDoc.exists ? (convDoc.data().members || []) : [];
      const senderUids = members.filter(m => m !== uid);

      // Batch-update alle ongelezen berichten van anderen naar 'gelezen'
      const snap = await db.collection('conversations').doc(convId)
        .collection('messages')
        .where('status', 'in', ['verstuurd', 'bezorgd'])
        .get();

      if (!snap.empty) {
        const toUpdate = snap.docs.filter(doc => doc.data().senderId !== uid);
        const CHUNK = 500;
        for (let i = 0; i < toUpdate.length; i += CHUNK) {
          const batch = db.batch();
          toUpdate.slice(i, i + CHUNK).forEach(doc => batch.update(doc.ref, { status: 'gelezen' }));
          await batch.commit();
        }
      }

      // Notificeer verzenders direct via onlineUsers
      senderUids.forEach(senderUid => {
        const sockets = onlineUsers[senderUid];
        if (sockets) sockets.forEach(sid => io.to(sid).emit('message:status', { convId, status: 'gelezen' }));
      });
    } catch (e) {
      console.error('messages:read error:', e);
    }
  });
};
