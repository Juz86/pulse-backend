const express = require('express');
const request = require('supertest');

let mockState;
let mockSendPush;
let mockSendFriendRequestPush;
let mockSendFriendRequestOutcomePush;

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
    if (value && value.__op === 'delete') {
      const parts = String(key).split('.');
      const parent = parts.slice(0, -1).reduce((cursor, part) => cursor?.[part], target);
      if (parent) delete parent[parts[parts.length - 1]];
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
            if (options.merge) {
              mockState.users[uid] = { ...current };
              mockApplyPatch(mockState.users[uid], data);
            } else {
              mockState.users[uid] = { ...data };
            }
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
      where(field, op, value) {
        return {
          limit() {
            return this;
          },
          async get() {
            const docs = Object.entries(mockState.users)
              .filter(([, data]) => op === '==' && data[field] === value)
              .map(([id, data]) => mockMakeDocSnapshot(id, data));
            return { empty: docs.length === 0, docs };
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
      async add(data) {
        const id = `req-${Object.keys(mockState.friendRequests).length + 1}`;
        mockState.friendRequests[id] = { ...data };
        return { id };
      },
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
      where(field, op, value) {
        if (field !== 'members' || op !== 'array-contains') {
          throw new Error(`Unsupported conversations query ${field} ${op}`);
        }
        const docs = Object.entries(mockState.conversations)
          .filter(([, data]) => Array.isArray(data.members) && data.members.includes(value))
          .map(([id, data]) => mockMakeDocSnapshot(id, data));
        return {
          async get() {
            return { docs };
          },
        };
      },
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
            const messageDocs = () => (mockState.messages[convId] || []).map((message) => ({
              id: message.id,
              data: () => message,
              ref: {
                delete() {
                  mockState.messages[convId] = (mockState.messages[convId] || [])
                    .filter((candidate) => candidate.id !== message.id);
                },
              },
            }));
            return {
              where(field, op, value) {
                if (field !== 'type' || op !== '==') throw new Error(`Unsupported message query ${field} ${op}`);
                return {
                  async get() {
                    const docs = messageDocs().filter((messageDoc) => messageDoc.data().type === value);
                    return { docs };
                  },
                };
              },
              async get() {
                const docs = messageDocs();
                return { docs, empty: docs.length === 0 };
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
      async add(data) {
        mockState.parentActivities.push(data);
        return { id: `activity-${mockState.parentActivities.length}` };
      },
    };
  }

  throw new Error(`Unsupported collection ${name}`);
}

jest.mock('../src/firebase', () => ({
  admin: {
    auth: () => ({
      createCustomToken: async (uid) => `native-token-${uid}`,
    }),
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
    batch() {
      return {
        set(ref, data) {
          return ref.set(data);
        },
        update(ref, patch) {
          return ref.update(patch);
        },
        delete(ref) {
          ref.delete();
        },
        async commit() {},
      };
    },
  },
}));

jest.mock('../src/middleware', () => ({
  verifyAuth: (req, _res, next) => {
    req.uid = req.headers['x-test-uid'] || 'test-user';
    next();
  },
  strictLimiter: (_req, _res, next) => next(),
  callBootstrapLimiter: (_req, _res, next) => next(),
  lookupUsernameLimiter: (_req, _res, next) => next(),
  friendReqLimiter: (_req, _res, next) => next(),
}));

jest.mock('../src/state', () => ({
  getSocketId: () => null,
}));

jest.mock('../src/push', () => ({
  sendPush: (...args) => mockSendPush(...args),
  sendFriendRequestPush: (...args) => mockSendFriendRequestPush(...args),
  sendFriendRequestOutcomePush: (...args) => mockSendFriendRequestOutcomePush(...args),
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
    mockSendFriendRequestPush = jest.fn().mockResolvedValue(undefined);
    mockSendFriendRequestOutcomePush = jest.fn().mockResolvedValue(undefined);
    mockState = {
      users: {
        'user-1': { uid: 'user-1', displayName: 'User One', email: 'user1@example.com', parentId: 'parent-1' },
        'user-2': { uid: 'user-2', displayName: 'User Two', parentId: 'parent-2' },
        'parent-1': { uid: 'parent-1', displayName: 'Parent One' },
        'parent-2': { uid: 'parent-2', displayName: 'Parent Two' },
      },
      contacts: {},
      friendRequests: {
        'req-1': {
          fromUid: 'user-1',
          fromName: 'User One',
          fromEmail: 'user1@example.com',
          toUid: 'user-2',
          toName: 'User Two',
          toEmail: 'user2@example.com',
          status: 'pending',
        },
      },
      conversations: {
        'conv-1': {
          members: ['user-1', 'user-2'],
          lastMessage: 'Hallo',
          lastMessageType: 'text',
          deletedFor: ['user-1'],
        },
      },
      messages: {},
      parentActivities: [],
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

  test('GET /api/app-update exposes the configured Play update policy', async () => {
    const previousLatest = process.env.PULSE_ANDROID_LATEST_VERSION_CODE;
    const previousMinimum = process.env.PULSE_ANDROID_MIN_VERSION_CODE;
    process.env.PULSE_ANDROID_LATEST_VERSION_CODE = '23';
    process.env.PULSE_ANDROID_MIN_VERSION_CODE = '22';

    const app = buildApp();
    const response = await request(app).get('/api/app-update?clientVersionCode=21');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      clientVersionCode: 21,
      latestVersionCode: 23,
      minimumVersionCode: 22,
      updateAvailable: true,
      updateRequired: true,
    }));

    if (previousLatest === undefined) delete process.env.PULSE_ANDROID_LATEST_VERSION_CODE;
    else process.env.PULSE_ANDROID_LATEST_VERSION_CODE = previousLatest;
    if (previousMinimum === undefined) delete process.env.PULSE_ANDROID_MIN_VERSION_CODE;
    else process.env.PULSE_ANDROID_MIN_VERSION_CODE = previousMinimum;
  });

  test('GET /api/feature-flags exposes only valid public boolean flags', async () => {
    const previousFlags = process.env.PULSE_FEATURE_FLAGS_JSON;
    process.env.PULSE_FEATURE_FLAGS_JSON = JSON.stringify({
      group_member_actions_v2: true,
      future_call_ui: false,
      invalidFlag: 'true',
      'invalid-name': true,
    });

    const app = buildApp();
    const response = await request(app).get('/api/feature-flags');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      ok: true,
      flags: {
        message_editing: false,
        group_member_actions_v2: true,
        future_call_ui: false,
      },
    });

    if (previousFlags === undefined) delete process.env.PULSE_FEATURE_FLAGS_JSON;
    else process.env.PULSE_FEATURE_FLAGS_JSON = previousFlags;
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

  test('sending a request notifies both involved child accounts parents', async () => {
    mockState.users['user-2'].email = 'user2@example.com';
    const app = buildApp();
    const response = await request(app)
      .post('/api/friend-requests')
      .set('x-test-uid', 'user-1')
      .send({
        fromUid: 'user-1',
        fromName: 'User One',
        fromEmail: 'user1@example.com',
        toEmail: 'user2@example.com',
      });

    expect(response.status).toBe(200);
    expect(mockState.parentActivities).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentId: 'parent-1', type: 'friend_request_sent' }),
      expect.objectContaining({ parentId: 'parent-2', type: 'friend_request_received' }),
    ]));
    expect(mockSendPush).toHaveBeenCalledWith(
      'parent-1',
      expect.objectContaining({ title: 'Pulse - Ouderlijk toezicht' }),
      expect.objectContaining({ action: 'friend_request_sent' }),
    );
    expect(mockSendPush).toHaveBeenCalledWith(
      'parent-2',
      expect.objectContaining({ title: 'Pulse - Ouderlijk toezicht' }),
      expect.objectContaining({ action: 'friend_request_received' }),
    );
  });

  test('accepting an offline friend request updates both lists and notifies the sender', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/friend-requests/req-1/accept')
      .set('x-test-uid', 'user-2');

    expect(response.status).toBe(200);
    expect(mockState.friendRequests['req-1'].status).toBe('accepted');
    expect(mockState.contacts['user-1']['user-2']).toEqual(expect.objectContaining({ uid: 'user-2' }));
    expect(mockState.contacts['user-2']['user-1']).toEqual(expect.objectContaining({ uid: 'user-1' }));
    expect(mockSendFriendRequestOutcomePush).toHaveBeenCalledWith(expect.objectContaining({
      recipientUid: 'user-1',
      requestId: 'req-1',
      actorDisplayName: 'User Two',
      outcome: 'accepted',
    }));
    expect(mockState.parentActivities).toEqual([expect.objectContaining({
      parentId: 'parent-2',
      childUid: 'user-2',
      type: 'friend_request_accepted',
    })]);
    expect(mockSendPush).toHaveBeenCalledWith(
      'parent-2',
      expect.objectContaining({ title: 'Pulse - Ouderlijk toezicht' }),
      expect.objectContaining({ type: 'parent_friend_request_activity', action: 'friend_request_accepted' }),
    );
  });

  test('declining an offline friend request notifies the sender', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/friend-requests/req-1/decline')
      .set('x-test-uid', 'user-2');

    expect(response.status).toBe(200);
    expect(mockState.friendRequests['req-1'].status).toBe('declined');
    expect(mockSendFriendRequestOutcomePush).toHaveBeenCalledWith(expect.objectContaining({
      recipientUid: 'user-1',
      requestId: 'req-1',
      actorDisplayName: 'User Two',
      outcome: 'declined',
    }));
    expect(mockState.parentActivities).toEqual([expect.objectContaining({
      parentId: 'parent-2',
      childUid: 'user-2',
      type: 'friend_request_declined',
    })]);
    expect(mockSendPush).toHaveBeenCalledWith(
      'parent-2',
      expect.objectContaining({ title: 'Pulse - Ouderlijk toezicht' }),
      expect.objectContaining({ type: 'parent_friend_request_activity', action: 'friend_request_declined' }),
    );
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
      lastMessage: null,
      lastMessageAt: null,
      lastMessageType: null,
      deletedFor: [],
    }));
    expect(mockState.conversations['conv-1'].clearedAt['user-1']).toBe('ts');
  });

  test("DELETE /api/conversations/:convId removes only the requester's own messages", async () => {
    mockState.messages['conv-1'] = [
      { id: 'message-a', senderId: 'user-1', text: 'Van gebruiker A', createdAt: 100 },
      { id: 'message-b', senderId: 'user-2', text: 'Van gebruiker B', createdAt: 200 },
    ];
    mockState.conversations['conv-1'].deletedFor = [];
    const app = buildApp();

    const response = await request(app)
      .delete('/api/conversations/conv-1')
      .set('x-test-uid', 'user-1');

    expect(response.status).toBe(200);
    expect(mockState.messages['conv-1']).toEqual([
      expect.objectContaining({ id: 'message-b', senderId: 'user-2' }),
    ]);
    expect(mockState.conversations['conv-1']).toEqual(expect.objectContaining({
      lastMessage: 'Van gebruiker B',
      deletedFor: ['user-1'],
    }));
  });

  test('DELETE /api/conversations/:convId rejects a user who is not a participant', async () => {
    mockState.users.outsider = { uid: 'outsider', displayName: 'Outsider' };
    const app = buildApp();

    const response = await request(app)
      .delete('/api/conversations/conv-1')
      .set('x-test-uid', 'outsider');

    expect(response.status).toBe(403);
  });

});
