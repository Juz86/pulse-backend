const { isCallingV2Enabled } = require('../src/calling/v2/config');

describe('Calling v2 rollout guard', () => {
  const original = process.env.PULSE_CALLING_V2_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.PULSE_CALLING_V2_ENABLED;
    else process.env.PULSE_CALLING_V2_ENABLED = original;
  });

  test('defaults to disabled', () => {
    delete process.env.PULSE_CALLING_V2_ENABLED;
    expect(isCallingV2Enabled()).toBe(false);
  });

  test('requires an explicit true value', () => {
    process.env.PULSE_CALLING_V2_ENABLED = 'true';
    expect(isCallingV2Enabled()).toBe(true);
    process.env.PULSE_CALLING_V2_ENABLED = 'false';
    expect(isCallingV2Enabled()).toBe(false);
  });
});
