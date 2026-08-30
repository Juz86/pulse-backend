const {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  getTurnCredentials,
  getTurnConfigurationStatus,
  normalizeCloudflareIceServer,
  readTtlSeconds,
  summarizeTurnCredentials,
} = require('../src/turnCredentials');

describe('Cloudflare TURN credentials', () => {
  it('normaliseert TURN urls en verwijdert poort 53', () => {
    expect(normalizeCloudflareIceServer({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turn:turn.cloudflare.com:53?transport=udp',
            'turns:turn.cloudflare.com:443?transport=tcp',
          ],
          username: 'user',
          credential: 'secret',
        },
      ],
    })).toEqual({
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'user',
      credential: 'secret',
    });
  });

  it('begrensd de TTL op 48 uur', () => {
    expect(readTtlSeconds()).toBe(DEFAULT_TTL_SECONDS);
    expect(readTtlSeconds('999999')).toBe(MAX_TTL_SECONDS);
  });

  it('rapporteert veilige runtime-metadata zonder secrets', () => {
    expect(getTurnConfigurationStatus({
      CLOUDFLARE_TURN_KEY_ID: 'key-id',
      CLOUDFLARE_TURN_KEY_SECRET: 'key-secret',
      CLOUDFLARE_TURN_TTL_SECONDS: '7200',
    })).toEqual({
      turnConfigured: true,
      turnProvider: 'cloudflare',
      turnCredentialTtlSeconds: 7200,
    });
    expect(JSON.stringify(getTurnConfigurationStatus({}))).not.toContain('secret');
  });

  it('haalt tijdelijke credentials server-side bij Cloudflare op', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478'] },
          {
            urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
            username: 'temporary-user',
            credential: 'temporary-secret',
          },
        ],
      }),
    });

    const result = await getTurnCredentials({
      env: {
        CLOUDFLARE_TURN_KEY_ID: 'key-id',
        CLOUDFLARE_TURN_KEY_SECRET: 'key-secret',
      },
      fetchImpl,
    });

    expect(result.hasTurn).toBe(true);
    expect(result.source).toBe('cloudflare');
    expect(result.iceServers.at(-1).username).toBe('temporary-user');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/key-id/credentials/generate-ice-servers'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer key-secret' }),
      }),
    );
  });

  it('valt zonder Cloudflare-config veilig terug op STUN', async () => {
    const result = await getTurnCredentials({ env: {} });
    expect(result.hasTurn).toBe(false);
    expect(result.source).toBe('stun-only');
    expect(result.iceServers.every((server) => String(server.urls).startsWith('stun:'))).toBe(true);
  });

  it('lekt geen Cloudflare-fout en gebruikt statische TURN als fallback', async () => {
    const logger = { warn: jest.fn() };
    const result = await getTurnCredentials({
      env: {
        CLOUDFLARE_TURN_KEY_ID: 'key-id',
        CLOUDFLARE_TURN_KEY_SECRET: 'key-secret',
        TURN_URL: 'turn:legacy.example.com:3478',
        TURN_USERNAME: 'legacy-user',
        TURN_CREDENTIAL: 'legacy-secret',
      },
      fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 503 }),
      logger,
    });
    expect(result.source).toBe('static');
    expect(result.hasTurn).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('maakt een veilige diagnose zonder tijdelijke TURN-secrets of adressen', () => {
    const summary = summarizeTurnCredentials({
      source: 'cloudflare',
      hasTurn: true,
      expiresIn: 7200,
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turns:turn.cloudflare.com:443?transport=tcp',
          ],
          username: 'temporary-user',
          credential: 'temporary-secret',
        },
      ],
    });

    expect(summary).toEqual({
      ok: true,
      source: 'cloudflare',
      hasTurn: true,
      expiresIn: 7200,
      stunUrlCount: 1,
      turnUrlCount: 2,
      turnTransports: ['tcp', 'udp'],
      turnPorts: [443, 3478],
    });
    expect(JSON.stringify(summary)).not.toContain('temporary-user');
    expect(JSON.stringify(summary)).not.toContain('temporary-secret');
  });

  it('markeert STUN-fallback niet als succesvolle Cloudflare-probe', () => {
    expect(summarizeTurnCredentials({
      source: 'stun-only',
      hasTurn: false,
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    }).ok).toBe(false);
  });
});
