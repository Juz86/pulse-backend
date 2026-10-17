jest.mock('../src/firebase', () => ({
  admin: { firestore: { FieldValue: { serverTimestamp: jest.fn() } } },
  db: {
    collection(name) {
      return {
        doc() {
          return {
            async get() {
              if (name === 'users') {
                return { exists: true, data: () => ({ uid: 'user-a' }) };
              }
              return {
                exists: true,
                data: () => ({
                  members: ['user-a', 'user-b'],
                  isGroup: false,
                  e2eeState: 'v2_required',
                }),
              };
            },
          };
        },
      };
    },
  },
}));
jest.mock('../src/redis', () => ({ queueMessage: jest.fn() }));
jest.mock('../src/push', () => ({ sendPush: jest.fn(), sendMessagePush: jest.fn() }));
jest.mock('../src/validate', () => ({
  schemas: { messageSend: {} },
  validate: (_schema, data) => data,
}));
jest.mock('../src/cleanup', () => ({ resolveConversationHistoryRules: jest.fn() }));
jest.mock('../src/featureFlags', () => ({ isFeatureEnabled: jest.fn(() => false) }));

const registerMessages = require('../src/socket/messages');

test('legacy socket send is blocked for a v2_required conversation', async () => {
  const handlers = {};
  const socket = {
    userId: 'user-a',
    on: jest.fn((event, handler) => { handlers[event] = handler; }),
    join: jest.fn(),
  };
  const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
  const callback = jest.fn();
  registerMessages(io, socket, 'user-a');

  await handlers['message:send']({
    convId: 'conversation-1',
    message: { type: 'text', text: 'mag niet worden opgeslagen' },
  }, callback);

  expect(callback).toHaveBeenCalledWith({
    error: 'Dit gesprek vereist end-to-end versleuteling.',
    code: 'v2_required',
  });
  expect(io.to).not.toHaveBeenCalled();
});
