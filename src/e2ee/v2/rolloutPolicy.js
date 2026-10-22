const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isTrue(value) {
  return String(value || '').toLowerCase() === 'true';
}

function parseIdAllowlist(value) {
  if (!value) return new Set();
  const entries = String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => !ID_PATTERN.test(entry))) return null;
  return new Set(entries);
}

function readE2EEV2RolloutPolicy(env = process.env) {
  const globallyEnabled = isTrue(env.E2EE_V2_ENABLED);
  const mode = String(env.E2EE_V2_ROLLOUT_MODE || 'disabled').toLowerCase();
  const userIds = parseIdAllowlist(env.E2EE_V2_PILOT_USER_IDS);
  const conversationIds = parseIdAllowlist(env.E2EE_V2_PILOT_CONVERSATION_IDS);
  const review = {
    attestationSha256: String(env.E2EE_V2_REVIEW_ATTESTATION_SHA256 || '').toLowerCase(),
    frontendCommit: String(env.E2EE_V2_REVIEW_FRONTEND_COMMIT || '').toLowerCase(),
    backendCommit: String(env.E2EE_V2_REVIEW_BACKEND_COMMIT || '').toLowerCase(),
  };
  const deployedBackendCommit = String(env.PULSE_RELEASE_COMMIT_SHA || '').toLowerCase();

  let configured = false;
  let reason = 'v2_not_enabled';
  if (globallyEnabled && mode === 'qa') {
    configured = isTrue(env.E2EE_V2_QA_MODE_ACKNOWLEDGED);
    reason = configured ? null : 'v2_qa_not_acknowledged';
  } else if (globallyEnabled && mode === 'pilot') {
    configured = Boolean(
      userIds
      && conversationIds
      && userIds.size > 0
      && conversationIds.size > 0
      && SHA256_PATTERN.test(review.attestationSha256)
      && COMMIT_PATTERN.test(review.frontendCommit)
      && COMMIT_PATTERN.test(review.backendCommit)
      && COMMIT_PATTERN.test(deployedBackendCommit)
      && review.backendCommit === deployedBackendCommit
    );
    reason = configured ? null : 'v2_pilot_not_configured';
  } else if (globallyEnabled) {
    reason = 'v2_rollout_mode_invalid';
  }

  return {
    configured,
    conversationIds: conversationIds || new Set(),
    deployedBackendCommit,
    globallyEnabled,
    mode,
    reason,
    review,
    sendEnabled: configured && (
      mode === 'qa' || isTrue(env.E2EE_V2_PILOT_SEND_ENABLED)
    ),
    userIds: userIds || new Set(),
  };
}

function evaluateE2EEV2Access({ userId, conversationId = null, env = process.env } = {}) {
  const policy = readE2EEV2RolloutPolicy(env);
  if (!policy.configured) {
    return { allowed: false, mode: policy.mode, status: 503, error: policy.reason };
  }
  if (policy.mode === 'qa') return { allowed: true, mode: policy.mode };
  if (!policy.userIds.has(String(userId || ''))) {
    return { allowed: false, mode: policy.mode, status: 403, error: 'v2_pilot_user_not_allowed' };
  }
  if (conversationId && !policy.conversationIds.has(String(conversationId))) {
    return {
      allowed: false,
      mode: policy.mode,
      status: 403,
      error: 'v2_pilot_conversation_not_allowed',
    };
  }
  return { allowed: true, mode: policy.mode };
}

function getE2EEV2PilotStatus(userId, env = process.env) {
  const policy = readE2EEV2RolloutPolicy(env);
  return {
    enabled: policy.configured,
    enrolled: policy.configured && (
      policy.mode === 'qa' || policy.userIds.has(String(userId || ''))
    ),
    mode: policy.mode,
    sendingEnabled: policy.sendEnabled,
  };
}

function evaluateE2EEV2SendAccess(options = {}) {
  const access = evaluateE2EEV2Access(options);
  if (!access.allowed) return access;
  const policy = readE2EEV2RolloutPolicy(options.env || process.env);
  if (!policy.sendEnabled) {
    return {
      allowed: false,
      mode: policy.mode,
      status: 503,
      error: 'v2_pilot_sends_paused',
    };
  }
  return access;
}

module.exports = {
  evaluateE2EEV2Access,
  evaluateE2EEV2SendAccess,
  getE2EEV2PilotStatus,
  parseIdAllowlist,
  readE2EEV2RolloutPolicy,
};
