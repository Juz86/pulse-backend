const {
  createRealtimeKitClient,
  getRealtimeKitConfigurationStatus,
} = require('../src/realtimeKit');

const configuredEnv = {
  PULSE_REALTIMEKIT_CALLS_ENABLED: 'true',
  CLOUDFLARE_ACCOUNT_ID: 'account-id',
  CLOUDFLARE_REALTIMEKIT_APP_ID: 'app-id',
  CLOUDFLARE_REALTIMEKIT_API_TOKEN: 'server-secret',
  CLOUDFLARE_REALTIMEKIT_PRESET_NAME: 'pulse-call',
};

describe('Cloudflare RealtimeKit client', () => {
  it('reports enablement and configuration without exposing secrets', () => {
    const status = getRealtimeKitConfigurationStatus(configuredEnv);
    expect(status).toEqual({
      realtimeKitCallsEnabled: true,
      realtimeKitConfigured: true,
      realtimeKitProvider: 'cloudflare',
    });
    expect(JSON.stringify(status)).not.toContain('server-secret');
  });

  it('keeps the engine disabled until explicitly enabled', async () => {
    const client = createRealtimeKitClient({ env: {}, fetchImpl: jest.fn() });
    await expect(client.createMeeting({ sessionId: 'call-12345678' }))
      .rejects.toMatchObject({ code: 'realtimekit_disabled' });
  });

  it('creates meetings and participant credentials server-side', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { id: 'meeting-id' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { id: 'participant-id', token: 'participant-token' } }),
      });
    const client = createRealtimeKitClient({ env: configuredEnv, fetchImpl });

    await expect(client.createMeeting({ sessionId: 'call-12345678' }))
      .resolves.toEqual({ meetingId: 'meeting-id' });
    await expect(client.addParticipant({ meetingId: 'meeting-id', uid: 'user-a', name: 'User A' }))
      .resolves.toEqual({ participantId: 'participant-id', authToken: 'participant-token' });

    expect(fetchImpl.mock.calls[0][0]).toContain('/accounts/account-id/realtime/kit/app-id/meetings');
    expect(fetchImpl.mock.calls[1][0]).toContain('/meetings/meeting-id/participants');
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer server-secret');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      name: 'User A',
      preset_name: 'pulse-call',
      custom_participant_id: 'user-a',
    });
  });

  it('returns a stable error without leaking the Cloudflare response', async () => {
    const client = createRealtimeKitClient({
      env: configuredEnv,
      fetchImpl: jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ errors: [{ message: 'secret provider detail' }] }),
      }),
    });
    await expect(client.createMeeting({ sessionId: 'call-12345678' }))
      .rejects.toMatchObject({ code: 'realtimekit_api_failed', status: 401 });
  });
});
