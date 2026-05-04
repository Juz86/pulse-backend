const admin = require('firebase-admin');

const rawServiceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
const firebaseEnabled = String(process.env.FIREBASE_ENABLED || '').toLowerCase() === 'true';

function buildDisabledError(method) {
  return new Error(`Firebase disabled: cannot call ${method}. Set FIREBASE_ENABLED=true and GOOGLE_APPLICATION_CREDENTIALS_JSON to enable.`);
}

function makeDisabledAdmin() {
  const disabledPromise = (method) => Promise.reject(buildDisabledError(method));

  return {
    auth() {
      return {
        verifyIdToken: () => disabledPromise('auth.verifyIdToken'),
        createUser: () => disabledPromise('auth.createUser'),
        updateUser: () => disabledPromise('auth.updateUser'),
        deleteUser: () => disabledPromise('auth.deleteUser'),
        getUser: () => disabledPromise('auth.getUser'),
        getUsers: () => disabledPromise('auth.getUsers'),
        generatePasswordResetLink: () => disabledPromise('auth.generatePasswordResetLink'),
      };
    },
    firestore: {
      FieldValue: {
        serverTimestamp: () => new Date(),
        delete: () => null,
        arrayUnion: (...values) => values,
        arrayRemove: (...values) => values,
      },
      Timestamp: {
        fromDate: (d) => d,
      },
    },
  };
}

function makeDisabledDb() {
  const fail = (method) => {
    throw buildDisabledError(method);
  };

  return {
    collection: () => ({
      doc: () => ({
        get: () => Promise.reject(buildDisabledError('db.collection().doc().get')),
        set: () => Promise.reject(buildDisabledError('db.collection().doc().set')),
        update: () => Promise.reject(buildDisabledError('db.collection().doc().update')),
        delete: () => Promise.reject(buildDisabledError('db.collection().doc().delete')),
        collection: () => ({
          doc: () => ({
            get: () => Promise.reject(buildDisabledError('db.collection().doc().collection().doc().get')),
            set: () => Promise.reject(buildDisabledError('db.collection().doc().collection().doc().set')),
            update: () => Promise.reject(buildDisabledError('db.collection().doc().collection().doc().update')),
            delete: () => Promise.reject(buildDisabledError('db.collection().doc().collection().doc().delete')),
          }),
        }),
      }),
      add: () => Promise.reject(buildDisabledError('db.collection().add')),
      where: () => ({ get: () => Promise.reject(buildDisabledError('db.collection().where().get')) }),
      orderBy: () => ({
        limit: () => ({ get: () => Promise.reject(buildDisabledError('db.collection().orderBy().limit().get')) }),
        get: () => Promise.reject(buildDisabledError('db.collection().orderBy().get')),
      }),
      limit: () => ({ get: () => Promise.reject(buildDisabledError('db.collection().limit().get')) }),
      get: () => Promise.reject(buildDisabledError('db.collection().get')),
    }),
    batch: () => ({
      set: () => fail('db.batch().set'),
      update: () => fail('db.batch().update'),
      delete: () => fail('db.batch().delete'),
      commit: () => Promise.reject(buildDisabledError('db.batch().commit')),
    }),
    runTransaction: () => Promise.reject(buildDisabledError('db.runTransaction')),
  };
}

let exportedAdmin;
let exportedDb;
let exportedStorage;

if (!firebaseEnabled) {
  console.warn('⚠️ Firebase is disabled (FIREBASE_ENABLED != true). Running without Firebase.');
  exportedAdmin = makeDisabledAdmin();
  exportedDb = makeDisabledDb();
  exportedStorage = null;
} else if (!rawServiceAccount) {
  console.warn('⚠️ Firebase enabled but GOOGLE_APPLICATION_CREDENTIALS_JSON ontbreekt. Falling back to disabled Firebase.');
  exportedAdmin = makeDisabledAdmin();
  exportedDb = makeDisabledDb();
  exportedStorage = null;
} else {
  try {
    const serviceAccount = JSON.parse(rawServiceAccount);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.firebasestorage.app`,
    });

    exportedAdmin = admin;
    exportedDb = admin.firestore();
    exportedStorage = admin.storage();
    console.log('✅ Firebase initialized');
  } catch (err) {
    console.error('❌ Firebase init failed:', err.message);
    exportedAdmin = makeDisabledAdmin();
    exportedDb = makeDisabledDb();
    exportedStorage = null;
  }
}

module.exports = {
  admin: exportedAdmin,
  db: exportedDb,
  storage: exportedStorage,
};
