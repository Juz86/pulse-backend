function isCallingV2Enabled() {
  return String(process.env.PULSE_CALLING_V2_ENABLED || '').toLowerCase() === 'true';
}

module.exports = { isCallingV2Enabled };
