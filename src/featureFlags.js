const FEATURE_FLAG_DEFAULTS = Object.freeze({
  message_editing: false,
});

function readPublicFeatureFlags(value = process.env.PULSE_FEATURE_FLAGS_JSON) {
  if (!value) return { ...FEATURE_FLAG_DEFAULTS };
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...FEATURE_FLAG_DEFAULTS };
    return Object.entries(parsed).reduce((flags, [name, enabled]) => {
      if (/^[a-z][a-z0-9_]{1,79}$/.test(name) && typeof enabled === 'boolean') flags[name] = enabled;
      return flags;
    }, { ...FEATURE_FLAG_DEFAULTS });
  } catch {
    return { ...FEATURE_FLAG_DEFAULTS };
  }
}

function isFeatureEnabled(name) {
  return readPublicFeatureFlags()[name] === true;
}

module.exports = { FEATURE_FLAG_DEFAULTS, readPublicFeatureFlags, isFeatureEnabled };
