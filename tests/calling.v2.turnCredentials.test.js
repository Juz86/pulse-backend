const {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  createCloudflareTurnCredentialsProvider,
  normalizeIceServers,
  readTtlSeconds,
} = require('../src/calling/v2/turnCredentials');

describe('Calling v2 Cloudflare TURN credentials', () => {
  test('normalizes ICE servers and removes Cloudflare port 53 fallback', () => {
    expect(normalizeIceServers({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turn:turn.cloudflare.com:53?transport=udp',
            'turns:turn.cloudflare.com:443?transport=tcp',
          ],
          username: 'temporary-user',
          credential: 'temporary-secret',
        },
      ],
    })).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        username: 'temporary-user',
        credential: 'temporary-secret',
      },
    ]);
  });

  test('accepts the singleton ICE server form returned by the API', () => {
    expect(normalizeIceServers({
      iceServers: {
        urls: 'turns:turn.cloudflare.com:443?transport=tcp',
        username: 'temporary-user',
        credential: 'temporary-secret',
      },
    })).toEqual([{
      urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'temporary-user',
      credential: 'temporary-secret',
    }]);
  });

  test('rejects relay entries with blank credentials', () => {
    expect(() => normalizeIceServers({
      iceServers: [{
        urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
        username: ' ',
        credential: 'temporary-secret',
      }],
    })).toThrow('cloudflare_turn_missing_relay');
  });

  test('fails closed when Cloudflare returns no authenticated relay', () => {
    expect(() => normalizeIceServers({
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
    })).toThrow('cloudflare_turn_missing_relay');
  });

  test('uses a bounded short-lived credential TTL', () => {
    expect(readTtlSeconds()).toBe(DEFAULT_TTL_SECONDS);
    expect(readTtlSeconds('59')).toBe(DEFAULT_TTL_SECONDS);
    expect(readTtlSeconds('999999')).toBe(MAX_TTL_SECONDS);
  });

  test('requests credentials from Cloudflare without exposing the permanent key', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        iceServers: [{
          urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
          username: 'temporary-user',
          credential: 'temporary-secret',
        }],
      }),
    });
    const provider = createCloudflareTurnCredentialsProvider({
      env: {
        CLOUDFLARE_TURN_KEY_ID: 'key/id',
        CLOUDFLARE_TURN_KEY_SECRET: 'permanent-secret',
        CLOUDFLARE_TURN_TTL_SECONDS: '3600',
      },
      fetchImpl,
    });

    const result = await provider();
    expect(result.expiresInSeconds).toBe(3600);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/key%2Fid/credentials/generate-ice-servers'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer permanent-secret' }),
        body: JSON.stringify({ ttl: 3600 }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('permanent-secret');
  });

  test('fails closed when credentials are not configured', async () => {
    const provider = createCloudflareTurnCredentialsProvider({ env: {}, fetchImpl: jest.fn() });
    await expect(provider()).rejects.toThrow('cloudflare_turn_not_configured');
  });

  test('propagates Cloudflare HTTP failure without leaking the key secret', async () => {
    const provider = createCloudflareTurnCredentialsProvider({
      env: {
        CLOUDFLARE_TURN_KEY_ID: 'key-id',
        CLOUDFLARE_TURN_KEY_SECRET: 'do-not-leak',
      },
      fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 503 }),
    });
    await expect(provider()).rejects.toThrow('cloudflare_turn_http_503');
    await expect(provider()).rejects.not.toThrow('do-not-leak');
  });
});
