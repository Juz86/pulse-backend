const API_ORIGIN = 'https://api.cloudflare.com/client/v4';

function getRealtimeKitConfigurationStatus(env = process.env) {
  const enabled = String(env.PULSE_REALTIMEKIT_CALLS_ENABLED || '').toLowerCase() === 'true';
  const configured = Boolean(
    env.CLOUDFLARE_ACCOUNT_ID
      && env.CLOUDFLARE_REALTIMEKIT_APP_ID
      && env.CLOUDFLARE_REALTIMEKIT_API_TOKEN
      && env.CLOUDFLARE_REALTIMEKIT_PRESET_NAME,
  );
  return {
    realtimeKitCallsEnabled: enabled,
    realtimeKitConfigured: configured,
    realtimeKitProvider: 'cloudflare',
  };
}

function requireConfiguration(env) {
  const status = getRealtimeKitConfigurationStatus(env);
  if (!status.realtimeKitCallsEnabled) {
    const error = new Error('RealtimeKit calls are disabled');
    error.code = 'realtimekit_disabled';
    throw error;
  }
  if (!status.realtimeKitConfigured) {
    const error = new Error('RealtimeKit is not configured');
    error.code = 'realtimekit_not_configured';
    throw error;
  }
}

function createRealtimeKitClient({ env = process.env, fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  async function request(path, body) {
    requireConfiguration(env);
    const baseUrl = `${API_ORIGIN}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}`
      + `/realtime/kit/${encodeURIComponent(env.CLOUDFLARE_REALTIMEKIT_APP_ID)}`;
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_REALTIMEKIT_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success || !payload.result) {
      const error = new Error(`RealtimeKit API request failed (${response.status})`);
      error.code = 'realtimekit_api_failed';
      error.status = response.status;
      throw error;
    }
    return payload.result;
  }

  return {
    async createMeeting({ sessionId }) {
      const result = await request('/meetings', {
        title: `Pulse call ${sessionId}`,
      });
      if (!result.id) throw Object.assign(new Error('RealtimeKit meeting id missing'), { code: 'realtimekit_invalid_response' });
      return { meetingId: result.id };
    },

    async addParticipant({ meetingId, uid, name, picture }) {
      const result = await request(`/meetings/${encodeURIComponent(meetingId)}/participants`, {
        name: String(name || 'Pulse gebruiker').slice(0, 80),
        preset_name: env.CLOUDFLARE_REALTIMEKIT_PRESET_NAME,
        custom_participant_id: uid,
        ...(picture ? { picture: String(picture).slice(0, 2048) } : {}),
      });
      if (!result.id || !result.token) {
        throw Object.assign(new Error('RealtimeKit participant credentials missing'), { code: 'realtimekit_invalid_response' });
      }
      return { participantId: result.id, authToken: result.token };
    },
  };
}

module.exports = {
  API_ORIGIN,
  createRealtimeKitClient,
  getRealtimeKitConfigurationStatus,
};
