const {
  getConnectingTimeoutSeconds,
  getRingingTimeoutSeconds,
  isCallingV2Enabled,
} = require('../src/calling/v2/config');

describe('Calling v2 rollout guard', () => {
  const original = process.env.PULSE_CALLING_V2_ENABLED;
  const originalRingingTimeout = process.env.PULSE_CALLING_V2_RINGING_TIMEOUT_SECONDS;
  const originalConnectingTimeout = process.env.PULSE_CALLING_V2_CONNECTING_TIMEOUT_SECONDS;

  afterEach(() => {
    if (original === undefined) delete process.env.PULSE_CALLING_V2_ENABLED;
    else process.env.PULSE_CALLING_V2_ENABLED = original;
    if (originalRingingTimeout === undefined) delete process.env.PULSE_CALLING_V2_RINGING_TIMEOUT_SECONDS;
    else process.env.PULSE_CALLING_V2_RINGING_TIMEOUT_SECONDS = originalRingingTimeout;
    if (originalConnectingTimeout === undefined) delete process.env.PULSE_CALLING_V2_CONNECTING_TIMEOUT_SECONDS;
    else process.env.PULSE_CALLING_V2_CONNECTING_TIMEOUT_SECONDS = originalConnectingTimeout;
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

  test('uses a bounded connecting timeout with a 30 second default', () => {
    delete process.env.PULSE_CALLING_V2_CONNECTING_TIMEOUT_SECONDS;
    expect(getConnectingTimeoutSeconds()).toBe(30);
    process.env.PULSE_CALLING_V2_CONNECTING_TIMEOUT_SECONDS = '60';
    expect(getConnectingTimeoutSeconds()).toBe(60);
    process.env.PULSE_CALLING_V2_CONNECTING_TIMEOUT_SECONDS = '121';
    expect(getConnectingTimeoutSeconds()).toBe(30);
  });
});
