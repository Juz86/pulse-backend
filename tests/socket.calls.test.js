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
      const operator = {
        emit(event, payload) {
          emitted.push({ target, event, payload });
        },
        except(excludedSocketId) {
          return {
            emit(event, payload) {
              emitted.push({ target, excludedSocketId, event, payload });
            },
          };
        },
      };
      return operator;
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

  test('caller disconnect keeps pending offer for a reconnect', async () => {
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

    expect(mockPendingCalls['session-2']).toBeDefined();
  });

  test('stores caller ICE candidates while the callee is not connected', async () => {
    const registerCalls = require('../src/socket/calls');
    mockOnlineUsers.callee = new Set();
    mockSocketLookup = jest.fn(() => null);
    const io = makeIo();
    const callerSocket = makeSocket('caller', 'socket-caller');
    registerCalls(io, callerSocket, 'caller');

    await callerSocket.trigger('call:offer', {
      to: 'callee',
      offer: { type: 'offer', sdp: 'audio-offer' },
      isVideo: false,
      callerName: 'Caller',
      sessionId: 'native-session',
    });
    await callerSocket.trigger('call:ice-candidate', {
      to: 'callee',
      sessionId: 'native-session',
      candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
    });

    expect(mockPendingCalls['native-session'].callerCandidates).toEqual([
      { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
    ]);
  });

  test('keeps ICE candidates that arrive while the offer checks are still pending', async () => {
    const registerCalls = require('../src/socket/calls');
    mockOnlineUsers.callee = new Set();
    mockSocketLookup = jest.fn(() => null);
    const io = makeIo();
    const callerSocket = makeSocket('caller', 'socket-caller');
    registerCalls(io, callerSocket, 'caller');

    await callerSocket.trigger('call:ice-candidate', {
      to: 'callee',
      sessionId: 'early-native-session',
      candidate: { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
    });
    await callerSocket.trigger('call:offer', {
      to: 'callee',
      offer: { type: 'offer', sdp: 'audio-offer' },
      isVideo: false,
      callerName: 'Caller',
      sessionId: 'early-native-session',
    });

    expect(mockPendingCalls['early-native-session'].callerCandidates).toEqual([
      { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
    ]);
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
      target: 'callee',
      event: 'call:offer',
      payload: expect.objectContaining({
        fromUid: 'caller',
        isVideo: true,
        sessionId: 'video-session',
      }),
    });
    expect(mockSendPush).toHaveBeenCalledWith(
      'callee',
      expect.objectContaining({ title: '📹 Inkomend videogesprek' }),
      expect.objectContaining({
        type: 'incoming_call',
        callSessionId: 'video-session',
        fromUid: 'caller',
        isVideo: true,
      })
    );
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
    await phoneSocket.trigger('call:answer', {
      to: 'caller', answer: { type: 'answer', sdp: 'phone-answer' }, sessionId: 'multi-device-session',
    });
    await tabletSocket.trigger('call:answer', {
      to: 'caller', answer: { type: 'answer', sdp: 'tablet-answer' }, sessionId: 'multi-device-session',
    });

    expect(io.emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'callee', event: 'call:offer' }),
      expect.objectContaining({ target: 'caller', event: 'call:answer', payload: expect.objectContaining({ sessionId: 'multi-device-session' }) }),
      expect.objectContaining({ target: 'callee', excludedSocketId: 'socket-callee-phone', event: 'call:ended', payload: expect.objectContaining({ reason: 'answered_elsewhere' }) }),
    ]));
    expect(mockActiveCallSessions['multi-device-session']).toEqual(expect.objectContaining({
      calleeSocketId: 'socket-callee-phone',
    }));
    expect(tabletSocket.emit).toHaveBeenCalledWith('call:ended', expect.objectContaining({ reason: 'answered_elsewhere' }));
  });

  test('forwards answer, video upgrade, and end while clearing active call state', async () => {
    const registerCalls = require('../src/socket/calls');
    mockSocketLookup = jest.fn((uid) => (uid === 'caller' ? 'socket-caller' : 'socket-callee'));
    const io = makeIo();
    const callerSocket = makeSocket('caller', 'socket-caller');
    const calleeSocket = makeSocket('callee', 'socket-callee');
    registerCalls(io, callerSocket, 'caller');
    registerCalls(io, calleeSocket, 'callee');

    await callerSocket.trigger('call:offer', {
      to: 'callee',
      offer: { type: 'offer', sdp: 'offer-sdp' },
      isVideo: false,
      callerName: 'Caller',
      sessionId: 'session-live',
    });
    await calleeSocket.trigger('call:answer', {
      to: 'caller',
      answer: { type: 'answer', sdp: 'answer-sdp' },
      sessionId: 'session-live',
    });
    await calleeSocket.trigger('call:video-upgrade', { to: 'caller', sessionId: 'session-live' });
    await calleeSocket.trigger('call:end', { to: 'caller', sessionId: 'session-live' });

    expect(io.emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'caller', event: 'call:answer', payload: expect.objectContaining({ sessionId: 'session-live' }) }),
      expect.objectContaining({ target: 'caller', event: 'call:video-upgrade', payload: { sessionId: 'session-live' } }),
      expect.objectContaining({ target: 'caller', event: 'call:ended', payload: { sessionId: 'session-live' } }),
    ]));
    expect(mockActiveCallSessions['session-live']).toBeUndefined();
  });

  test('resumes an active call after reconnect and can replay the answer', async () => {
    const registerCalls = require('../src/socket/calls');
    mockSocketLookup = jest.fn((uid) => (uid === 'caller' ? 'socket-caller-old' : 'socket-callee'));
    const io = makeIo();
    const callerSocket = makeSocket('caller', 'socket-caller-old');
    const calleeSocket = makeSocket('callee', 'socket-callee');
    registerCalls(io, callerSocket, 'caller');
    registerCalls(io, calleeSocket, 'callee');

    await callerSocket.trigger('call:offer', {
      to: 'callee', offer: { type: 'offer', sdp: 'offer' }, isVideo: true,
      callerName: 'Caller', sessionId: 'resume-session',
    });
    await calleeSocket.trigger('call:answer', {
      to: 'caller', answer: { type: 'answer', sdp: 'saved-answer' }, sessionId: 'resume-session',
    });

    const resumedCaller = makeSocket('caller', 'socket-caller-new');
    registerCalls(io, resumedCaller, 'caller');
    await resumedCaller.trigger('call:resume', {
      to: 'callee', sessionId: 'resume-session', needsAnswer: true,
    });

    expect(mockActiveCallSessions['resume-session']).toEqual(expect.objectContaining({
      callerSocketId: 'socket-caller-new',
    }));
    expect(io.emitted).toContainEqual(expect.objectContaining({
      target: 'callee', event: 'call:peer-resumed',
    }));
    expect(resumedCaller.emit).toHaveBeenCalledWith('call:answer', expect.objectContaining({
      answer: { type: 'answer', sdp: 'saved-answer' },
      sessionId: 'resume-session',
    }));
  });

  test('heartbeat acknowledges an expired server-side call lease', async () => {
    const registerCalls = require('../src/socket/calls');
    const io = makeIo();
    const callerSocket = makeSocket('caller', 'socket-caller');
    registerCalls(io, callerSocket, 'caller');

    await callerSocket.trigger('call:heartbeat', { sessionId: 'missing-session' });

    expect(callerSocket.emit).toHaveBeenCalledWith('call:heartbeat:ack', {
      sessionId: 'missing-session',
      active: false,
    });
  });
});
