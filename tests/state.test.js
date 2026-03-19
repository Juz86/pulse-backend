const { onlineUsers, activeCalls, inactiveUsers, getSocketId } = require('../src/state');

describe('state', () => {
  afterEach(() => {
    // Opruimen na elke test
    Object.keys(onlineUsers).forEach(k => delete onlineUsers[k]);
    activeCalls.clear();
    inactiveUsers.clear();
  });

  it('getSocketId geeft null terug als user offline is', () => {
    expect(getSocketId('uid-niet-online')).toBeNull();
  });

  it('getSocketId geeft socket ID terug als user online is', () => {
    onlineUsers['uid1'] = new Set(['socket-abc']);
    expect(getSocketId('uid1')).toBe('socket-abc');
  });

  it('verwijderen van socket ID werkt correct', () => {
    onlineUsers['uid2'] = new Set(['socket-1', 'socket-2']);
    onlineUsers['uid2'].delete('socket-1');
    expect(onlineUsers['uid2'].size).toBe(1);
    expect(getSocketId('uid2')).toBe('socket-2');
  });

  it('activeCalls bijhoudt actieve gesprekken', () => {
    activeCalls.add('uid-a');
    activeCalls.add('uid-b');
    expect(activeCalls.has('uid-a')).toBe(true);
    activeCalls.delete('uid-a');
    expect(activeCalls.has('uid-a')).toBe(false);
  });

  it('inactiveUsers bijhoudt inactieve gebruikers', () => {
    inactiveUsers.add('uid-c');
    expect(inactiveUsers.has('uid-c')).toBe(true);
    inactiveUsers.delete('uid-c');
    expect(inactiveUsers.has('uid-c')).toBe(false);
  });
});
