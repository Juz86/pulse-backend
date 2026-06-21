const express = require('express');
const request = require('supertest');

let mockState;
let mockSendPush;

function mockMakeDocSnapshot(id, data) {
  return {
    id,
    exists: data !== undefined,
    data: () => data,
  };
}

function mockSetNestedValue(target, path, value) {
  const parts = String(path).split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function mockGetNestedValue(target, path) {
  return String(path).split('.').reduce((acc, key) => (acc ? acc[key] : undefined), target);
}

function mockApplyPatch(target, patch) {
  Object.entries(patch).forEach(([key, value]) => {
    if (value && value.__op === 'arrayUnion') {
      const current = Array.isArray(mockGetNestedValue(target, key)) ? mockGetNestedValue(target, key) : [];
      mockSetNestedValue(target, key, Array.from(new Set([...current, ...value.values])));
      return;
    }
    if (value && value.__op === 'arrayRemove') {
      const current = Array.isArray(mockGetNestedValue(target, key)) ? mockGetNestedValue(target, key) : [];
      mockSetNestedValue(target, key, current.filter((entry) => !value.values.includes(entry)));
      return;
    }
    if (value && value.__op === 'serverTimestamp') {
      mockSetNestedValue(target, key, 'ts');
      return;
    }
    mockSetNestedValue(target, key, value);
  });
}

function mockMakeCollection(name, ownerId = null) {
  if (name === 'users') {
    return {
      doc(uid) {
        return {
          async get() {
            return mockMakeDocSnapshot(uid, mockState.users[uid]);
          },
          async set(data, options = {}) {
            const current = mockState.users[uid] || {};
            mockState.users[uid] = options.merge ? { ...current, ...data } : { ...data };
          },
          async update(patch) {
            if (!mockState.users[uid]) throw new Error(`Unknown user ${uid}`);
            mockApplyPatch(mockState.users[uid], patch);
          },
          collection(sub) {
            if (sub !== 'contacts') throw new Error(`Unsupported subcollection ${sub}`);
            return mockMakeCollection('contacts', uid);
          },
        };
      },
      where() {
        return {
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

  if (name === 'contacts') {
    return {
      async get() {
        const items = Object.entries(mockState.contacts[ownerId] || {}).map(([id, data]) => mockMakeDocSnapshot(id, data));
        return { empty: items.length === 0, docs: items };
      },
      doc(targetUid) {
        return {
          async get() {
            return mockMakeDocSnapshot(targetUid, mockState.contacts[ownerId]?.[targetUid]);
          },
          async set(data) {
            mockState.contacts[ownerId] = mockState.contacts[ownerId] || {};
            mockState.contacts[ownerId][targetUid] = { ...data };
          },
          async delete() {
            if (mockState.contacts[ownerId]) delete mockState.contacts[ownerId][targetUid];
          },
        };
      },
    };
  }

  if (name === 'friendRequests') {
    return {
      doc(requestId) {
        return {
          async get() {
            return mockMakeDocSnapshot(requestId, mockState.friendRequests[requestId]);
          },
          async update(patch) {
            if (!mockState.friendRequests[requestId]) throw new Error(`Unknown request ${requestId}`);
            mockApplyPatch(mockState.friendRequests[requestId], patch);
          },
        };
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

  if (name === 'conversations') {
    return {
      doc(convId) {
        return {
          async get() {
            return mockMakeDocSnapshot(convId, mockState.conversations[convId]);
          },
          async set(data, options = {}) {
            const current = mockState.conversations[convId] || {};
            if (options.merge) {
              mockState.conversations[convId] = { ...current };
              mockApplyPatch(mockState.conversations[convId], data);
            } else {
              mockState.conversations[convId] = { ...data };
            }
          },
          async update(patch) {
            if (!mockState.conversations[convId]) throw new Error(`Unknown conversation ${convId}`);
            mockApplyPatch(mockState.conversations[convId], patch);
          },
          collection(sub) {
            if (sub !== 'messages') throw new Error(`Unsupported subcollection ${sub}`);
            return {
              async get() {
                return { docs: [] };
              },
            };
          },
        };
      },
      where() {
        return {
          async get() {
            return { docs: [] };
          },
        };
      },
    };
  }

  if (name === 'parentActivities') {
    return {
      async add() {
        return { id: 'activity-1' };
      },
    };
  }

  throw new Error(`Unsupported collection ${name}`);
}

jest.mock('../src/firebase', () => ({
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ __op: 'serverTimestamp' }),
        arrayUnion: (...values) => ({ __op: 'arrayUnion', values }),
        arrayRemove: (...values) => ({ __op: 'arrayRemove', values }),
        delete: () => ({ __op: 'delete' }),
      },
    },
  },
  db: {
    collection(name) {
      return mockMakeCollection(name);
    },
  },
}));

jest.mock('../src/middleware', () => ({
  verifyAuth: (req, _res, next) => {
    req.uid = req.headers['x-test-uid'] || 'test-user';
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
  sendPush: (...args) => mockSendPush(...args),
}));

jest.mock('../src/cleanup', () => ({
  normalizeHistoryRules: (value) => value || {},
  HISTORY_RETENTION_OPTIONS_DAYS: [0, 30, 90],
  COMM_RETENTION_DAYS: 30,
  resolveConversationHistoryRules: async () => ({}),
}));

function buildApp() {
  const miscRouter = require('../src/routes/misc');
  const friendsRouterFactory = require('../src/routes/friends');
  const usersRouterFactory = require('../src/routes/users');
  const app = express();
  const io = { to: () => ({ emit: () => {} }) };
  app.use(express.json());
  app.use('/', miscRouter);
  app.use('/', friendsRouterFactory(io, {}));
  app.use('/', usersRouterFactory(io, {}));
  return app;
}

describe('compatibility routes', () => {
  beforeEach(() => {
    jest.resetModules();
    mockSendPush = jest.fn().mockResolvedValue(undefined);
    mockState = {
      users: {
        'user-1': { uid: 'user-1', displayName: 'User One' },
        'user-2': { uid: 'user-2', displayName: 'User Two' },
      },
      contacts: {},
      friendRequests: {
        'req-1': {
          fromUid: 'user-1',
          fromName: 'User One',
          fromEmail: 'user1@example.com',
          toUid: 'user-2',
          status: 'pending',
        },
      },
      conversations: {
        'conv-1': {
          members: ['user-1', 'user-2'],
          lastMessage: 'Hallo',
          lastMessageType: 'text',
          lastCallDirection: 'outgoing',
          lastCallIsVideo: true,
          lastCallSenderId: 'user-1',
          deletedFor: ['user-1'],
        },
      },
    };
  });

  test('GET /runtimez returns runtime metadata', async () => {
    const app = buildApp();
    const response = await request(app).get('/runtimez');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      nodeEnv: expect.any(String),
      firebaseCredentialMode: expect.any(String),
    }));
  });

  test('POST /api/friend-requests/:requestId/remind updates reminder state', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/friend-requests/req-1/remind')
      .set('x-test-uid', 'user-1');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mockState.friendRequests['req-1']).toEqual(expect.objectContaining({
      reminderCount: 1,
      remindedAt: 'ts',
    }));
    expect(mockSendPush).toHaveBeenCalled();
  });

  test('DELETE /api/friend-requests/:requestId/cancel marks request as cancelled', async () => {
    const app = buildApp();
    const response = await request(app)
      .delete('/api/friend-requests/req-1/cancel')
      .set('x-test-uid', 'user-1');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mockState.friendRequests['req-1']).toEqual(expect.objectContaining({
      status: 'cancelled',
      cancelledAt: 'ts',
    }));
  });

  test('DELETE /api/conversations/:convId/clear clears conversation for requesting user', async () => {
    const app = buildApp();
    const response = await request(app)
      .delete('/api/conversations/conv-1/clear')
      .set('x-test-uid', 'user-1');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mockState.conversations['conv-1']).toEqual(expect.objectContaining({
      lastMessage: '',
      lastMessageAt: null,
      lastMessageType: null,
      lastCallDirection: null,
      lastCallIsVideo: false,
      lastCallSenderId: null,
      deletedFor: [],
    }));
    expect(mockState.conversations['conv-1'].clearedAt['user-1']).toBe('ts');
  });
});
