const {
  evaluateE2EEV2Access,
  evaluateE2EEV2SendAccess,
  getE2EEV2PilotStatus,
  parseIdAllowlist,
  readE2EEV2RolloutPolicy,
} = require('../src/e2ee/v2/rolloutPolicy');

const REVIEW_ENV = {
  E2EE_V2_REVIEW_ATTESTATION_SHA256: 'a'.repeat(64),
  E2EE_V2_REVIEW_FRONTEND_COMMIT: 'b'.repeat(40),
  E2EE_V2_REVIEW_BACKEND_COMMIT: 'c'.repeat(40),
  PULSE_RELEASE_COMMIT_SHA: 'c'.repeat(40),
};

describe('E2EE v2 rollout policy', () => {
  test('is fail-closed by default', () => {
    expect(readE2EEV2RolloutPolicy({})).toMatchObject({
      configured: false,
      mode: 'disabled',
      reason: 'v2_not_enabled',
    });
  });

  test('requires an explicit QA acknowledgement', () => {
    const base = { E2EE_V2_ENABLED: 'true', E2EE_V2_ROLLOUT_MODE: 'qa' };
    expect(evaluateE2EEV2Access({ userId: 'user-a', env: base })).toMatchObject({
      allowed: false,
      error: 'v2_qa_not_acknowledged',
      status: 503,
    });
    expect(evaluateE2EEV2Access({
      userId: 'user-a',
      env: { ...base, E2EE_V2_QA_MODE_ACKNOWLEDGED: 'true' },
    })).toEqual({ allowed: true, mode: 'qa' });
  });

  test('requires review pins and non-empty allowlists for pilot mode', () => {
    const env = {
      E2EE_V2_ENABLED: 'true',
      E2EE_V2_ROLLOUT_MODE: 'pilot',
      E2EE_V2_PILOT_USER_IDS: 'user-a,user-b',
      E2EE_V2_PILOT_CONVERSATION_IDS: 'conversation-1',
      E2EE_V2_PILOT_SEND_ENABLED: 'true',
      ...REVIEW_ENV,
    };
    expect(readE2EEV2RolloutPolicy(env)).toMatchObject({ configured: true, mode: 'pilot' });
    expect(evaluateE2EEV2Access({
      userId: 'user-a', conversationId: 'conversation-1', env,
    })).toEqual({ allowed: true, mode: 'pilot' });
    expect(evaluateE2EEV2SendAccess({
      userId: 'user-a', conversationId: 'conversation-1', env,
    })).toEqual({ allowed: true, mode: 'pilot' });
  });

  test('allows a bounded unreviewed internal Play test without weakening pilot mode', () => {
    const env = {
      E2EE_V2_ENABLED: 'true',
      E2EE_V2_ROLLOUT_MODE: 'internal_play_test',
      E2EE_V2_INTERNAL_PLAY_TEST_ACK: 'UNREVIEWED_INTERNAL_PLAY_TEST',
      E2EE_V2_PILOT_USER_IDS: 'user-a,user-b',
      E2EE_V2_PILOT_CONVERSATION_IDS: 'conversation-1',
    };

    expect(readE2EEV2RolloutPolicy(env)).toMatchObject({
      configured: true,
      mode: 'internal_play_test',
      sendEnabled: false,
    });
    expect(evaluateE2EEV2Access({
      userId: 'user-a', conversationId: 'conversation-1', env,
    })).toEqual({ allowed: true, mode: 'internal_play_test' });
    expect(evaluateE2EEV2SendAccess({
      userId: 'user-a', conversationId: 'conversation-1', env,
    })).toMatchObject({ allowed: false, error: 'v2_pilot_sends_paused', status: 503 });

    expect(readE2EEV2RolloutPolicy({
      ...env,
      E2EE_V2_INTERNAL_PLAY_TEST_ACK: 'true',
    })).toMatchObject({
      configured: false,
      reason: 'v2_internal_play_test_not_configured',
    });
    expect(readE2EEV2RolloutPolicy({
      ...env,
      E2EE_V2_ROLLOUT_MODE: 'pilot',
    })).toMatchObject({ configured: false, reason: 'v2_pilot_not_configured' });
  });

  test('keeps the internal Play test restricted to exact allowlists', () => {
    const env = {
      E2EE_V2_ENABLED: 'true',
      E2EE_V2_ROLLOUT_MODE: 'internal_play_test',
      E2EE_V2_INTERNAL_PLAY_TEST_ACK: 'UNREVIEWED_INTERNAL_PLAY_TEST',
      E2EE_V2_PILOT_USER_IDS: 'user-a,user-b',
      E2EE_V2_PILOT_CONVERSATION_IDS: 'conversation-1',
      E2EE_V2_PILOT_SEND_ENABLED: 'true',
    };

    expect(evaluateE2EEV2Access({ userId: 'user-c', env })).toMatchObject({
      allowed: false, error: 'v2_pilot_user_not_allowed', status: 403,
    });
    expect(evaluateE2EEV2Access({
      userId: 'user-a', conversationId: 'conversation-2', env,
    })).toMatchObject({
      allowed: false, error: 'v2_pilot_conversation_not_allowed', status: 403,
    });
    expect(evaluateE2EEV2SendAccess({
      userId: 'user-a', conversationId: 'conversation-1', env,
    })).toEqual({ allowed: true, mode: 'internal_play_test' });
  });

  test('rejects a deployed backend commit that differs from the reviewed commit', () => {
    const policy = readE2EEV2RolloutPolicy({
      E2EE_V2_ENABLED: 'true',
      E2EE_V2_ROLLOUT_MODE: 'pilot',
      E2EE_V2_PILOT_USER_IDS: 'user-a',
      E2EE_V2_PILOT_CONVERSATION_IDS: 'conversation-1',
      ...REVIEW_ENV,
      PULSE_RELEASE_COMMIT_SHA: 'd'.repeat(40),
    });
    expect(policy).toMatchObject({ configured: false, reason: 'v2_pilot_not_configured' });
  });

  test('rejects users and conversations outside the pilot cohort', () => {
    const env = {
      E2EE_V2_ENABLED: 'true',
      E2EE_V2_ROLLOUT_MODE: 'pilot',
      E2EE_V2_PILOT_USER_IDS: 'user-a,user-b',
      E2EE_V2_PILOT_CONVERSATION_IDS: 'conversation-1',
      ...REVIEW_ENV,
    };
    expect(evaluateE2EEV2Access({ userId: 'user-c', env })).toMatchObject({
      allowed: false, error: 'v2_pilot_user_not_allowed', status: 403,
    });
    expect(evaluateE2EEV2Access({
      userId: 'user-a', conversationId: 'conversation-2', env,
    })).toMatchObject({
      allowed: false, error: 'v2_pilot_conversation_not_allowed', status: 403,
    });
  });

  test('does not accept wildcards or malformed allowlist identifiers', () => {
    expect(parseIdAllowlist('user-a,*')).toBeNull();
    const policy = readE2EEV2RolloutPolicy({
      E2EE_V2_ENABLED: 'true',
      E2EE_V2_ROLLOUT_MODE: 'pilot',
      E2EE_V2_PILOT_USER_IDS: '*',
      E2EE_V2_PILOT_CONVERSATION_IDS: 'conversation-1',
      ...REVIEW_ENV,
    });
    expect(policy).toMatchObject({ configured: false, reason: 'v2_pilot_not_configured' });
  });

  test('exposes only enrollment state, never allowlist contents or review pins', () => {
    const env = {
      E2EE_V2_ENABLED: 'true',
      E2EE_V2_ROLLOUT_MODE: 'pilot',
      E2EE_V2_PILOT_USER_IDS: 'user-a',
      E2EE_V2_PILOT_CONVERSATION_IDS: 'conversation-1',
      ...REVIEW_ENV,
    };
    expect(getE2EEV2PilotStatus('user-a', env)).toEqual({
      enabled: true, enrolled: true, mode: 'pilot', sendingEnabled: false,
    });
    expect(JSON.stringify(getE2EEV2PilotStatus('user-a', env))).not.toContain('conversation-1');
    expect(getE2EEV2PilotStatus('user-b', env)).toEqual({
      enabled: true, enrolled: false, mode: 'pilot', sendingEnabled: false,
    });
  });

  test('can pause sends without disabling read access', () => {
    const env = {
      E2EE_V2_ENABLED: 'true',
      E2EE_V2_ROLLOUT_MODE: 'pilot',
      E2EE_V2_PILOT_USER_IDS: 'user-a',
      E2EE_V2_PILOT_CONVERSATION_IDS: 'conversation-1',
      ...REVIEW_ENV,
    };
    expect(evaluateE2EEV2Access({
      userId: 'user-a', conversationId: 'conversation-1', env,
    }).allowed).toBe(true);
    expect(evaluateE2EEV2SendAccess({
      userId: 'user-a', conversationId: 'conversation-1', env,
    })).toMatchObject({
      allowed: false, error: 'v2_pilot_sends_paused', status: 503,
    });
  });
});
