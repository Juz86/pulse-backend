const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

// storageBucket: via env var of afgeleid van project_id (default Firebase bucket)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`,
});

const db      = admin.firestore();
const storage = admin.storage();

module.exports = { admin, db, storage };
