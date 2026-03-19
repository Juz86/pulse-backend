const { schemas, validate } = require('../src/validate');

describe('validate()', () => {
  it('geeft data terug bij geldige messageSend', () => {
    const data = { convId: 'abc123', message: { text: 'Hallo', type: 'text' } };
    const result = validate(schemas.messageSend, data, () => {});
    expect(result).not.toBeNull();
    expect(result.convId).toBe('abc123');
  });

  it('blokkeert lege convId', () => {
    const cb = jest.fn();
    const result = validate(schemas.messageSend, { convId: '', message: {} }, cb);
    expect(result).toBeNull();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('blokkeert te lange berichttekst', () => {
    const cb = jest.fn();
    const result = validate(schemas.messageSend, {
      convId: 'abc',
      message: { text: 'x'.repeat(5001) },
    }, cb);
    expect(result).toBeNull();
    expect(cb).toHaveBeenCalled();
  });

  it('blokkeert ongeldig berichttype', () => {
    const cb = jest.fn();
    const result = validate(schemas.messageSend, {
      convId: 'abc',
      message: { type: 'malicious' },
    }, cb);
    expect(result).toBeNull();
  });

  it('blokkeert te lange emoji in messageReact', () => {
    const cb = jest.fn();
    const result = validate(schemas.messageReact, {
      convId: 'abc', msgId: 'msg1', emoji: '🔥'.repeat(10),
    }, cb);
    expect(result).toBeNull();
  });

  it('blokkeert te grote members array in convCreate', () => {
    const cb = jest.fn();
    const result = validate(schemas.convCreate, {
      members: Array.from({ length: 51 }, (_, i) => `uid${i}`),
    }, cb);
    expect(result).toBeNull();
  });
});
