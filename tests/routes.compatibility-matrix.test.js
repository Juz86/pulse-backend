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
            return {
              where(field, op, value) {
                if (field !== 'type' || op !== '==') throw new Error(`Unsupported message query ${field} ${op}`);
                return {
                  async get() {
                    const docs = (mockState.messages[convId] || [])
                      .filter((message) => message.type === value)
                      .map((message) => mockMakeDocSnapshot(message.id, message));
                    return { docs };
                  },
                };
              },
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
  pendingCalls: {},
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
      messages: {
        'conv-1': [
          {
            id: 'msg-call-1',
            type: 'call',
            isVideo: true,
            direction: 'completed',
            senderId: 'user-1',
            createdAt: '2026-06-21T12:00:00.000Z',
          },
          {
            id: 'msg-call-2',
            type: 'call',
            isVideo: false,
            direction: 'no-answer',
            senderId: 'user-2',
            createdAt: '2026-06-21T12:05:00.000Z',
          },
        ],
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

  test('GET /calls/pending/:sessionId returns pending call offer for authorized user', async () => {
    const { pendingCalls } = require('../src/state');
    pendingCalls['call_123'] = {
      sessionId: 'call_123',
      from: 'user-1',
      to: 'user-2',
      offer: { type: 'offer', sdp: 'test-sdp' },
      callerName: 'User One',
      isVideo: true,
      createdAt: 12345,
    };

    const app = buildApp();
    const response = await request(app)
      .get('/calls/pending/call_123?fromUid=user-1')
      .set('x-test-uid', 'user-2');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      call: expect.objectContaining({
        sessionId: 'call_123',
        from: 'user-1',
        to: 'user-2',
        callerName: 'User One',
        isVideo: true,
        offer: expect.objectContaining({ type: 'offer' }),
      }),
    }));

    delete pendingCalls['call_123'];
  });

  test('GET /api/messages/recent-calls returns normalized recent call entries', async () => {
    const app = buildApp();
    const response = await request(app)
      .get('/api/messages/recent-calls?limit=10')
      .set('x-test-uid', 'user-1');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  test('DELETE /api/messages/recent-calls stores clear timestamp on user profile', async () => {
    const app = buildApp();
    const response = await request(app)
      .delete('/api/messages/recent-calls')
      .set('x-test-uid', 'user-1');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mockState.users['user-1'].callLogClearedAt).toBe('ts');
  });
});
