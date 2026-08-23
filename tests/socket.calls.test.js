let mockUsers;
let mockPendingCalls;
let mockActiveCalls;
let mockActiveCallSessions;
let mockOnlineUsers;
let mockSocketLookup;
let mockSendPush;
let socketCounter;

function makeSocket(uid, id = `socket-${uid}-${++socketCounter}`) {
  const handlers = new Map();
  return {
    id,
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
  const emitted = [];
  return {
    emitted,
    to(target) {
      return {
        emit(event, payload) {
          emitted.push({ target, event, payload });
        },
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
  get activeCallSessions() {
    return mockActiveCallSessions;
  },
  get onlineUsers() {
    return mockOnlineUsers;
  },
  getSocketIds: (uid) => Array.from(mockOnlineUsers[uid] || []),
  getCallPeerSocketId: (sessionId, fromUid, toUid) => {
    const session = mockActiveCallSessions[sessionId];
    if (!session) return null;
    if (session.callerUid === fromUid && session.calleeUid === toUid) return session.calleeSocketId;
    if (session.calleeUid === fromUid && session.callerUid === toUid) return session.callerSocketId;
    return null;
  },
  clearCallSession: (sessionId) => {
    delete mockActiveCallSessions[sessionId];
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
    mockActiveCallSessions = {};
    mockOnlineUsers = { callee: new Set(['socket-callee']) };
    socketCounter = 0;
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

  test('forwards a video offer with its session id to the recipient', async () => {
    const registerCalls = require('../src/socket/calls');
    const io = makeIo();
    const callerSocket = makeSocket('caller', 'socket-caller');
    registerCalls(io, callerSocket, 'caller');

    await callerSocket.trigger('call:offer', {
      to: 'callee',
      from: 'caller',
      offer: { type: 'offer', sdp: 'video-offer' },
      isVideo: true,
      callerName: 'Caller',
      sessionId: 'video-session',
    });

    expect(io.emitted).toContainEqual({
      target: 'socket-callee',
      event: 'call:offer',
      payload: expect.objectContaining({
        fromUid: 'caller',
        isVideo: true,
        sessionId: 'video-session',
      }),
    });
  });

  test('rings every recipient device and lets only the first answer claim the call', async () => {
    const registerCalls = require('../src/socket/calls');
    mockOnlineUsers.callee = new Set(['socket-callee-phone', 'socket-callee-tablet']);
    mockSocketLookup = jest.fn((uid) => (uid === 'caller' ? 'socket-caller' : null));
    const io = makeIo();
    const callerSocket = makeSocket('caller', 'socket-caller');
    const phoneSocket = makeSocket('callee', 'socket-callee-phone');
    const tabletSocket = makeSocket('callee', 'socket-callee-tablet');
    registerCalls(io, callerSocket, 'caller');
    registerCalls(io, phoneSocket, 'callee');
    registerCalls(io, tabletSocket, 'callee');

    await callerSocket.trigger('call:offer', {
      to: 'callee', from: 'caller', offer: { type: 'offer', sdp: 'offer' },
      isVideo: true, callerName: 'Caller', sessionId: 'multi-device-session',
    });
    phoneSocket.trigger('call:answer', {
      to: 'caller', answer: { type: 'answer', sdp: 'phone-answer' }, sessionId: 'multi-device-session',
    });
    tabletSocket.trigger('call:answer', {
      to: 'caller', answer: { type: 'answer', sdp: 'tablet-answer' }, sessionId: 'multi-device-session',
    });

    expect(io.emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'socket-callee-phone', event: 'call:offer' }),
      expect.objectContaining({ target: 'socket-callee-tablet', event: 'call:offer' }),
      expect.objectContaining({ target: 'socket-caller', event: 'call:answer', payload: expect.objectContaining({ sessionId: 'multi-device-session' }) }),
      expect.objectContaining({ target: 'socket-callee-tablet', event: 'call:ended', payload: expect.objectContaining({ reason: 'answered_elsewhere' }) }),
    ]));
    expect(mockActiveCallSessions['multi-device-session']).toEqual(expect.objectContaining({
      calleeSocketId: 'socket-callee-phone',
    }));
    expect(tabletSocket.emit).toHaveBeenCalledWith('call:ended', expect.objectContaining({ reason: 'answered_elsewhere' }));
  });

  test('forwards answer, video upgrade, and end while clearing active call state', () => {
    const registerCalls = require('../src/socket/calls');
    mockSocketLookup = jest.fn((uid) => (uid === 'caller' ? 'socket-caller' : 'socket-callee'));
    const io = makeIo();
    const calleeSocket = makeSocket('callee');
    registerCalls(io, calleeSocket, 'callee');

    calleeSocket.trigger('call:answer', {
      to: 'caller',
      answer: { type: 'answer', sdp: 'answer-sdp' },
      sessionId: 'session-live',
    });
    calleeSocket.trigger('call:video-upgrade', { to: 'caller', sessionId: 'session-live' });
    calleeSocket.trigger('call:end', { to: 'caller', sessionId: 'session-live' });

    expect(io.emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'socket-caller', event: 'call:answer', payload: expect.objectContaining({ sessionId: 'session-live' }) }),
      expect.objectContaining({ target: 'socket-caller', event: 'call:video-upgrade', payload: { sessionId: 'session-live' } }),
      expect.objectContaining({ target: 'socket-caller', event: 'call:ended', payload: { sessionId: 'session-live' } }),
    ]));
    expect(mockActiveCalls.has('caller')).toBe(false);
    expect(mockActiveCalls.has('callee')).toBe(false);
  });
});
