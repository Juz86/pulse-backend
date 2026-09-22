const { db } = require('../../firebase');

let nativePool = null;

function getNativePool() {
  if (!process.env.DATABASE_URL) return null;
  if (!nativePool) {
    const { Pool } = require('pg');
    nativePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
  }
  return nativePool;
}

function containsAny(values, uid) {
  return Array.isArray(values) && values.includes(uid);
}

async function isAuthorizedFirestoreContact(callerUid, calleeUid) {
  const [contact, caller, callee] = await Promise.all([
    db.collection('users').doc(callerUid).collection('contacts').doc(calleeUid).get(),
    db.collection('users').doc(callerUid).get(),
    db.collection('users').doc(calleeUid).get(),
  ]);
  if (!contact.exists || !caller.exists || !callee.exists) return false;
  const callerData = caller.data() || {};
  const calleeData = callee.data() || {};
  return !containsAny(callerData.blockedUsers, calleeUid)
    && !containsAny(callerData.blockedByParent, calleeUid)
    && !containsAny(callerData.removedByParent, calleeUid)
    && !containsAny(calleeData.blockedUsers, callerUid)
    && !containsAny(calleeData.blockedByParent, callerUid)
    && !containsAny(calleeData.removedByParent, callerUid);
}

async function isAuthorizedNativeContact(callerUid, calleeUid) {
  const pool = getNativePool();
  if (!pool) return false;
  const result = await pool.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM native_contacts
         WHERE owner_id = $1 AND contact_id = $2
       ) AS is_contact,
       EXISTS (
         SELECT 1 FROM native_blocked_contacts
         WHERE (owner_id = $1 AND blocked_user_id = $2)
            OR (owner_id = $2 AND blocked_user_id = $1)
       ) AS is_blocked`,
    [callerUid, calleeUid],
  );
  return result.rows[0]?.is_contact === true && result.rows[0]?.is_blocked !== true;
}

async function authorizeCallStart(callerUid, calleeUid) {
  try {
    if (await isAuthorizedFirestoreContact(callerUid, calleeUid)) return true;
  } catch (error) {
    console.warn('[Calling v2] Firestore-contactcontrole mislukt:', error.message);
  }
  try {
    return await isAuthorizedNativeContact(callerUid, calleeUid);
  } catch (error) {
    console.warn('[Calling v2] Native contactcontrole mislukt:', error.message);
    return false;
  }
}

module.exports = { authorizeCallStart, isAuthorizedFirestoreContact, isAuthorizedNativeContact };
