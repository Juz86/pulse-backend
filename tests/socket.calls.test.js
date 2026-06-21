let mockUsers;
let mockPendingCalls;
let mockActiveCalls;
let mockSocketLookup;
let mockSendPush;

function makeSocket(uid) {
  const handlers = new Map();
  return {
    data: { uid },
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit: jest.fn(),
    trigger(event, payload) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`Missing handler for ${event}`);
      return handler(payload);
    },
  };
}

function makeIo() {
  return {
    to(target) {
      return {
        emit: jest.fn(),
      };
    },
    sockets: {
      adapter: {
        rooms: new Map(),
      },
    },
  };
}

jest.mock('../src/firebase', () => ({
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ __op: 'serverTimestamp' }),
      },
    },
  },
  db: {
    collection(name) {
      if (name !== 'users') throw new Error(`Unsupported collection ${name}`);
      return {
        doc(uid) {
          return {
            async get() {
              return {
                exists: true,
                data: () => mockUsers[uid] || {},
              };
            },
          };
        },
      };
    },
  },
}));

jest.mock('../src/push', () => ({
  sendPush: (...args) => mockSendPush(...args),
}));

jest.mock('../src/state', () => ({
  get activeCalls() {
    return mockActiveCalls;
  },
  get pendingCalls() {
    return mockPendingCalls;
  },
  getSocketId: (...args) => mockSocketLookup(...args),
}));

jest.mock('../src/cleanup', () => ({
  cleanupCommunicationsForUser: jest.fn(),
  resolveConversationHistoryRules: jest.fn().mockResolvedValue({}),
}));

describe('socket call recovery behavior', () => {
  beforeEach(() => {
    jest.resetModules();
    mockUsers = {
      caller: { uid: 'caller', blockedUsers: [] },
      callee: { uid: 'callee', blockedUsers: [] },
    };
    mockPendingCalls = {};
    mockActiveCalls = new Set();
    mockSocketLookup = jest.fn((uid) => (uid === 'callee' ? 'socket-callee' : null));
    mockSendPush = jest.fn().mockResolvedValue(undefined);
  });

  test('callee disconnect keeps pending offer available for recovery', async () => {
    const registerCalls = require('../src/socket/calls');
    const io = makeIo();
    const callerSocket = makeSocket('caller');
    registerCalls(io, callerSocket, 'caller');

    await callerSocket.trigger('call:offer', {
      to: 'callee',
      from: 'caller',
      offer: { type: 'offer', sdp: 'abc' },
      isVideo: true,
      callerName: 'Caller',
      sessionId: 'session-1',
    });

    expect(mockPendingCalls['session-1']).toEqual(expect.objectContaining({
      from: 'caller',
      to: 'callee',
      sessionId: 'session-1',
    }));

    const calleeSocket = makeSocket('callee');
    registerCalls(io, calleeSocket, 'callee');
    calleeSocket.trigger('disconnect');

    expect(mockPendingCalls['session-1']).toEqual(expect.objectContaining({
      from: 'caller',
      to: 'callee',
      sessionId: 'session-1',
    }));
  });

  test('caller disconnect clears pending offer started by caller', async () => {
    const registerCalls = require('../src/socket/calls');
    const io = makeIo();
    const callerSocket = makeSocket('caller');
    registerCalls(io, callerSocket, 'caller');

    await callerSocket.trigger('call:offer', {
      to: 'callee',
      from: 'caller',
      offer: { type: 'offer', sdp: 'abc' },
      isVideo: false,
      callerName: 'Caller',
      sessionId: 'session-2',
    });

    expect(mockPendingCalls['session-2']).toBeDefined();

    callerSocket.trigger('disconnect');

    expect(mockPendingCalls['session-2']).toBeUndefined();
  });
});
