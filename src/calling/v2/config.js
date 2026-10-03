function isCallingV2Enabled() {
  return String(process.env.PULSE_CALLING_V2_ENABLED || '').toLowerCase() === 'true';
}

function getRingingTimeoutSeconds() {
  const configured = Number(process.env.PULSE_CALLING_V2_RINGING_TIMEOUT_SECONDS);
  return Number.isInteger(configured) && configured >= 10 && configured <= 120
    ? configured
    : 45;
}

module.exports = { getRingingTimeoutSeconds, isCallingV2Enabled };
