const { readPublicFeatureFlags, isFeatureEnabled } = require('../src/featureFlags');

describe('feature flags', () => {
  const originalFlags = process.env.PULSE_FEATURE_FLAGS_JSON;

  afterEach(() => {
    if (originalFlags === undefined) delete process.env.PULSE_FEATURE_FLAGS_JSON;
    else process.env.PULSE_FEATURE_FLAGS_JSON = originalFlags;
  });

  test('message editing is disabled unless explicitly enabled', () => {
    delete process.env.PULSE_FEATURE_FLAGS_JSON;
    expect(readPublicFeatureFlags()).toEqual({ message_editing: false });
    expect(isFeatureEnabled('message_editing')).toBe(false);
  });

  test('accepts valid boolean flags from Railway configuration', () => {
    process.env.PULSE_FEATURE_FLAGS_JSON = '{"message_editing":true,"invalid":"yes"}';
    expect(readPublicFeatureFlags()).toEqual({ message_editing: true });
    expect(isFeatureEnabled('message_editing')).toBe(true);
  });
});
