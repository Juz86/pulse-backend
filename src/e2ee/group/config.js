function isGroupE2eeEnabled(env = process.env) {
  return String(env.E2EE_V2_GROUPS_ENABLED || '').toLowerCase() === 'true';
}

module.exports = { isGroupE2eeEnabled };
