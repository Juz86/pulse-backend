const express = require('express');
const request = require('supertest');

let mockState;

function mockMakeDocSnapshot(id, data) {
  return {
    id,
    exists: data !== undefined,
    data: () => data,
  };
}

function mockMakeContactsCollection(ownerUid) {
  return {
    async get() {
      const rows = Object.entries(mockState.contacts[ownerUid] || {}).map(([id, data]) => ({ id, data }));
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map(({ id, data }) => mockMakeDocSnapshot(id, data)),
      };
    },
    doc(targetUid) {
      return {
        async get() {
        return mockMakeDocSnapshot(targetUid, mockState.contacts[ownerUid]?.[targetUid]);
        },
        async set(data) {
          mockState.contacts[ownerUid] = mockState.contacts[ownerUid] || {};
          mockState.contacts[ownerUid][targetUid] = { ...data };
        },
        async delete() {
          if (mockState.contacts[ownerUid]) delete mockState.contacts[ownerUid][targetUid];
        },
      };
    },
  };
}

function mockMakeUserDocRef(uid) {
  return {
    async get() {
      return mockMakeDocSnapshot(uid, mockState.users[uid]);
    },
    async update(patch) {
      const current = mockState.users[uid];
      if (!current) throw new Error(`Unknown user ${uid}`);
      Object.entries(patch).forEach(([key, value]) => {
        if (value && value.__op === 'arrayUnion') {
          const currentValues = Array.isArray(current[key]) ? current[key] : [];
          current[key] = Array.from(new Set([...currentValues, ...value.values]));
          return;
        }
        current[key] = value;
      });
    },
    collection(name) {
      if (name !== 'contacts') throw new Error(`Unsupported subcollection ${name}`);
      return mockMakeContactsCollection(uid);
    },
  };
}

jest.mock('../src/firebase', () => ({
  admin: {
    firestore: {
      FieldValue: {
        arrayUnion: (...values) => ({ __op: 'arrayUnion', values }),
        serverTimestamp: () => ({ __op: 'serverTimestamp' }),
      },
    },
  },
  storage: {
    bucket: () => ({ file: () => ({ delete: async () => {} }) }),
  },
  db: {
    collection(name) {
      if (name === 'users') {
        return {
          doc: mockMakeUserDocRef,
          where() {
            throw new Error('where() not implemented in this test for users');
          },
        };
      }
      if (name === 'conversations') {
        return {
          where() {
            return {
              async get() {
                return { docs: [] };
              },
            };
          },
        };
      }
      if (name === 'parentActivities' || name === 'friendRequests') {
        return {
          async add() {
            return { id: 'noop' };
          },
          where() {
            return {
              where() {
                return this;
              },
              limit() {
                return this;
              },
              async get() {
                return { empty: true, docs: [] };
              },
            };
          },
        };
      }
      throw new Error(`Unsupported collection ${name}`);
    },
  },
}));

jest.mock('../src/middleware', () => ({
  verifyAuth: (req, _res, next) => {
    req.uid = req.headers['x-test-uid'];
    next();
  },
  strictLimiter: (_req, _res, next) => next(),
  lookupUsernameLimiter: (_req, _res, next) => next(),
  friendReqLimiter: (_req, _res, next) => next(),
}));

jest.mock('../src/state', () => ({
  getSocketId: () => null,
}));

jest.mock('../src/push', () => ({
  sendPush: async () => {},
}));

function buildApp() {
  const usersRouterFactory = require('../src/routes/users');
  const friendsRouterFactory = require('../src/routes/friends');
  const app = express();
  app.use(express.json());
  app.use('/', usersRouterFactory({ to: () => ({ emit: () => {} }) }, {}));
  app.use('/', friendsRouterFactory({ to: () => ({ emit: () => {} }) }, {}));
  return app;
}

describe('child-parent contact guards', () => {
  beforeEach(() => {
    jest.resetModules();
    mockState = {
      users: {
        'child-1': {
          uid: 'child-1',
          role: 'child',
          displayName: 'Kind',
          parentId: 'parent-1',
          blockedUsers: [],
        },
        'parent-1': {
          uid: 'parent-1',
          role: 'parent',
          displayName: 'Ouder',
        },
      },
      contacts: {
        'child-1': {
          'parent-1': {
            uid: 'parent-1',
            displayName: 'Ouder',
            relation: 'familie',
          },
        },
        'parent-1': {
          'child-1': {
            uid: 'child-1',
            displayName: 'Kind',
            relation: 'familie',
          },
        },
      },
    };
  });

  test('child cannot block a parent account', async () => {
    const app = buildApp();

    const response = await request(app)
      .post('/api/users/child-1/block')
      .set('x-test-uid', 'child-1')
      .send({ targetUid: 'parent-1' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Een kindaccount kan geen ouderaccount blokkeren.');
    expect(mockState.users['child-1'].blockedUsers).toEqual([]);
  });

  test('child cannot remove a parent account from contacts', async () => {
    const app = buildApp();

    const response = await request(app)
      .delete('/api/contacts/child-1/parent-1')
      .set('x-test-uid', 'child-1');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Een kindaccount kan geen ouderaccount verwijderen.');
    expect(mockState.contacts['child-1']['parent-1']).toBeDefined();
  });

  test('contacts endpoint marks parent contacts as protected for children', async () => {
    const app = buildApp();

    const response = await request(app)
      .get('/api/contacts/child-1')
      .set('x-test-uid', 'child-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({
        uid: 'parent-1',
        role: 'parent',
        protectedParent: true,
      }),
    ]);
  });
});
