const { getRingingTimeoutSeconds, isCallingV2Enabled } = require('../src/calling/v2/config');

describe('Calling v2 rollout guard', () => {
  const original = process.env.PULSE_CALLING_V2_ENABLED;
  const originalRingingTimeout = process.env.PULSE_CALLING_V2_RINGING_TIMEOUT_SECONDS;

  afterEach(() => {
    if (original === undefined) delete process.env.PULSE_CALLING_V2_ENABLED;
    else process.env.PULSE_CALLING_V2_ENABLED = original;
    if (originalRingingTimeout === undefined) delete process.env.PULSE_CALLING_V2_RINGING_TIMEOUT_SECONDS;
    else process.env.PULSE_CALLING_V2_RINGING_TIMEOUT_SECONDS = originalRingingTimeout;
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

  test('uses a bounded ringing timeout with a 45 second default', () => {
    delete process.env.PULSE_CALLING_V2_RINGING_TIMEOUT_SECONDS;
    expect(getRingingTimeoutSeconds()).toBe(45);
    process.env.PULSE_CALLING_V2_RINGING_TIMEOUT_SECONDS = '30';
    expect(getRingingTimeoutSeconds()).toBe(30);
    process.env.PULSE_CALLING_V2_RINGING_TIMEOUT_SECONDS = '5';
    expect(getRingingTimeoutSeconds()).toBe(45);
  });
});
