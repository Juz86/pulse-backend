const express = require('express');
const request = require('supertest');

let mockState;
let mockIoEmit;
let mockIoTo;
let mockSendPush;
let mockSendMail;

function mockMakeDocSnapshot(id, data) {
  return {
    id,
    exists: data !== undefined,
    data: () => data,
  };
}

function mockApplyFieldValue(target, patch) {
  Object.entries(patch).forEach(([key, value]) => {
    if (value && value.__op === 'arrayUnion') {
      const current = Array.isArray(target[key]) ? target[key] : [];
      target[key] = Array.from(new Set([...current, ...value.values]));
      return;
    }
    if (value && value.__op === 'arrayRemove') {
      const current = Array.isArray(target[key]) ? target[key] : [];
      target[key] = current.filter((entry) => !value.values.includes(entry));
      return;
    }
    if (value && value.__op === 'serverTimestamp') {
      target[key] = 'ts';
      return;
    }
    target[key] = value;
  });
}

function mockMakeQuery(items, filters = [], limitCount = null) {
  return {
    where(field, op, value) {
      return mockMakeQuery(items, [...filters, { field, op, value }], limitCount);
    },
    limit(count) {
      return makeQuery(items, filters, count);
    },
    async get() {
      let results = items.filter(({ data }) =>
        filters.every((filter) => {
          const fieldValue = data?.[filter.field];
          if (filter.op === '==') return fieldValue === filter.value;
          if (filter.op === 'array-contains') return Array.isArray(fieldValue) && fieldValue.includes(filter.value);
          return false;
        })
      );
      if (typeof limitCount === 'number') results = results.slice(0, limitCount);
      return {
        empty: results.length === 0,
        size: results.length,
        docs: results.map(({ id, data }) => mockMakeDocSnapshot(id, data)),
      };
    },
  };
}

function mockUserDocRef(uid) {
  return {
    async get() {
      return mockMakeDocSnapshot(uid, mockState.users[uid]);
    },
    async set(data, options = {}) {
      const current = mockState.users[uid] || {};
      mockState.users[uid] = options.merge ? { ...current, ...data } : { ...data };
    },
    async update(patch) {
      const current = mockState.users[uid];
      if (!current) throw new Error(`Unknown user ${uid}`);
      mockApplyFieldValue(current, patch);
    },
    collection(sub) {
      if (sub !== 'contacts') throw new Error(`Unsupported subcollection ${sub}`);
      return mockContactsCollection(uid);
    },
  };
}

function mockContactsCollection(ownerUid) {
  return {
    async get() {
      const records = Object.entries(mockState.contacts[ownerUid] || {}).map(([id, data]) => ({ id, data }));
      return {
        empty: records.length === 0,
        size: records.length,
        docs: records.map(({ id, data }) => mockMakeDocSnapshot(id, data)),
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

function mockInvitationDocRef(id) {
  return {
    async get() {
      return mockMakeDocSnapshot(id, mockState.invitations[id]);
    },
    async update(patch) {
      const current = mockState.invitations[id];
      if (!current) throw new Error(`Unknown invite ${id}`);
      mockApplyFieldValue(current, patch);
    },
  };
}

jest.mock('../src/firebase', () => ({
  admin: {
    auth: () => ({
      verifyIdToken: jest.fn().mockImplementation(async (token) => ({ uid: token || 'unknown' })),
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
      if (name === 'users') {
        return {
          doc: mockUserDocRef,
          where(field, op, value) {
            const items = Object.entries(mockState.users).map(([id, data]) => ({ id, data }));
            return mockMakeQuery(items, [{ field, op, value }], null);
          },
        };
      }
      if (name === 'coparentInvitations') {
        return {
          doc: mockInvitationDocRef,
          async add(data) {
            const id = `invite-${Object.keys(mockState.invitations).length + 1}`;
            mockState.invitations[id] = { ...data };
            return { id };
          },
          where(field, op, value) {
            const items = Object.entries(mockState.invitations).map(([id, data]) => ({ id, data }));
            return mockMakeQuery(items, [{ field, op, value }], null);
          },
        };
      }
      if (name === 'parentActivities') {
        return {
          async add(data) {
            mockState.parentActivities.push({ ...data });
            return { id: `activity-${mockState.parentActivities.length}` };
          },
        };
      }
      throw new Error(`Unsupported collection ${name}`);
    },
    batch() {
      const ops = [];
      return {
        set(ref, data) {
          ops.push(() => ref.set(data));
        },
        delete(ref) {
          ops.push(() => ref.delete());
        },
        update(ref, patch) {
          ops.push(() => ref.update(patch));
        },
        async commit() {
          for (const op of ops) await op();
        },
      };
    },
  },
}));

jest.mock('../src/middleware', () => ({
  verifyAuth: (req, res, next) => {
    req.uid = req.headers['x-test-uid'];
    next();
  },
}));

jest.mock('../src/push', () => ({
  sendPush: (...args) => mockSendPush(...args),
}));

jest.mock('../src/email', () => ({
  transporter: {
    sendMail: (...args) => mockSendMail(...args),
  },
}));

jest.mock('../src/state', () => ({
  activeCalls: new Map(),
}));

function buildApp(onlineUsers = {}) {
  const routerFactory = require('../src/routes/parent');
  const app = express();
  app.use(express.json());
  app.use('/', routerFactory({ to: mockIoTo }, onlineUsers));
  return app;
}

describe('parent coparent assignment rules', () => {
  beforeEach(() => {
    jest.resetModules();
    mockState = {
      users: {
        'parent-a': { uid: 'parent-a', role: 'parent', displayName: 'Ouder A', email: 'a@example.com' },
        'parent-b': { uid: 'parent-b', role: 'parent', displayName: 'Ouder B', email: 'b@example.com' },
        'parent-c': { uid: 'parent-c', role: 'parent', displayName: 'Ouder C', email: 'c@example.com' },
        'child-1': {
          uid: 'child-1',
          role: 'child',
          displayName: 'Kind A',
          email: 'kinda@pulse.internal',
          parentId: 'parent-a',
          parentUid: 'parent-a',
          managedByParentId: 'parent-a',
          parentIds: ['parent-a', 'parent-b'],
          blockedByParent: [],
          blockedUsers: [],
        },
      },
      contacts: {
        'child-1': {
          'parent-a': { uid: 'parent-a', displayName: 'Ouder A', email: 'a@example.com', relation: 'familie' },
          'parent-b': { uid: 'parent-b', displayName: 'Ouder B', email: 'b@example.com', relation: 'familie' },
        },
        'parent-a': {
          'child-1': { uid: 'child-1', displayName: 'Kind A', email: 'kinda@pulse.internal', relation: 'familie' },
        },
        'parent-b': {},
      },
      invitations: {
        'invite-1': {
          childUid: 'child-1',
          childName: 'Kind A',
          fromParentUid: 'parent-a',
          fromParentName: 'Ouder A',
          fromParentEmail: 'a@example.com',
          toEmail: 'b@example.com',
          status: 'pending',
        },
      },
      parentActivities: [],
    };
    mockIoEmit = jest.fn();
    mockIoTo = jest.fn(() => ({ emit: mockIoEmit }));
    mockSendPush = jest.fn().mockResolvedValue(undefined);
    mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test' });
  });

  it('laat alleen de oorspronkelijke ouder een co-ouder uitnodigen', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/parent/invite-coparent')
      .set('x-test-uid', 'parent-b')
      .send({ childUid: 'child-1', toEmail: 'c@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/oorspronkelijke ouder/i);
  });

  it('voegt het kind toe aan de contacten van ouder B na acceptatie', async () => {
    const app = buildApp({ 'parent-a': new Set(['socket-a']) });
    const res = await request(app)
      .post('/api/parent/coparent-invitations/invite-1/accept')
      .set('x-test-uid', 'parent-b')
      .send();

    expect(res.status).toBe(200);
    expect(mockState.contacts['parent-b']['child-1']).toBeDefined();
    expect(mockState.contacts['child-1']['parent-b']).toBeDefined();
    expect(mockState.parentActivities.some((entry) => entry.type === 'coparent_accepted')).toBe(true);
    expect(mockIoEmit).toHaveBeenCalledWith('coparent:accepted', expect.objectContaining({
      childUid: 'child-1',
      childName: 'Kind A',
      coparentName: 'Ouder B',
    }));
  });

  it('meldt een weigering realtime en logt die als ouderactiviteit', async () => {
    const app = buildApp({ 'parent-a': new Set(['socket-a']) });
    const res = await request(app)
      .post('/api/parent/coparent-invitations/invite-1/decline')
      .set('x-test-uid', 'parent-b')
      .send();

    expect(res.status).toBe(200);
    expect(mockState.invitations['invite-1'].status).toBe('declined');
    expect(mockState.parentActivities.some((entry) => entry.type === 'coparent_declined')).toBe(true);
    expect(mockIoEmit).toHaveBeenCalledWith('coparent:declined', expect.objectContaining({
      childUid: 'child-1',
      childName: 'Kind A',
      coparentName: 'Ouder B',
    }));
  });

  it('beschermt co-ouders tegen blokkeren via kindcontactbeheer', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/parent/child/child-1/block-contact')
      .set('x-test-uid', 'parent-a')
      .send({ targetUid: 'parent-b' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/co-ouders/i);
  });

  it('beschermt co-ouders tegen verwijderen via kindcontactbeheer', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/parent/child/child-1/remove-contact')
      .set('x-test-uid', 'parent-a')
      .send({ targetUid: 'parent-b' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/co-ouders/i);
  });
});
