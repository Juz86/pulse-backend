const { z } = require('zod');
const { PROTOCOL, PROTOCOL_VERSION } = require('../../e2ee/v2/contracts');

const CALL_E2EE_PROTOCOL = 'pulse_call_e2ee_v1';
const CALL_E2EE_VERSION = 1;
const deviceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const base64 = z.string().min(4).max(4096).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

const callIdentitySchema = z.object({
  protocol: z.literal(CALL_E2EE_PROTOCOL),
  protocolVersion: z.literal(CALL_E2EE_VERSION),
  sessionId: deviceId,
  callerUserId: deviceId,
  calleeUserId: deviceId,
  senderDeviceId: deviceId,
  senderSignalDeviceId: z.number().int().min(1).max(127),
  senderIdentityVersion: z.number().int().positive(),
  mediaType: z.enum(['audio', 'video']),
  descriptionType: z.enum(['offer', 'answer']),
  dtlsFingerprintSha256: sha256,
  revision: z.number().int().nonnegative(),
  nonce: deviceId,
  peerBindingHash: z.union([z.literal(''), sha256]),
  identityKey: base64,
  signature: base64,
}).strict().superRefine((value, context) => {
  if (value.descriptionType === 'offer' && value.peerBindingHash !== '') {
    context.addIssue({ code: 'custom', path: ['peerBindingHash'], message: 'unexpected_peer_binding_hash' });
  }
  if (value.descriptionType === 'answer' && value.peerBindingHash === '') {
    context.addIssue({ code: 'custom', path: ['peerBindingHash'], message: 'peer_binding_hash_required' });
  }
});

function extractSha256Fingerprint(description) {
  if (typeof description !== 'string') return null;
  const fingerprints = Array.from(
    description.matchAll(/^a=fingerprint:sha-256\s+([^\r\n]+)$/gim),
    match => match[1].trim().toLowerCase().replaceAll(':', ''),
  ).filter(value => /^[0-9a-f]{64}$/.test(value));
  return fingerprints.length > 0 && new Set(fingerprints).size === 1
    ? fingerprints[0]
    : null;
}

function activeV2Device(value) {
  return Boolean(
    value
    && value.status === 'active'
    && value.protocol === PROTOCOL
    && value.protocolVersion === PROTOCOL_VERSION
    && value.capabilities?.messageEncryption === true,
  );
}

function createCallE2eeIdentityAuthorizer({ database }) {
  return async function authorizeCallE2eeIdentity({ actorUid, session, type, description, identity }) {
    const parsed = callIdentitySchema.safeParse(identity);
    if (!parsed.success) return { ok: false, status: 'INVALID_REQUEST' };
    const value = parsed.data;
    const fingerprint = extractSha256Fingerprint(description);
    if (
      !fingerprint
      || fingerprint !== value.dtlsFingerprintSha256
      || value.sessionId !== session.sessionId
      || value.callerUserId !== session.callerUid
      || value.calleeUserId !== session.calleeUid
      || value.mediaType !== session.mediaType
      || value.descriptionType !== type
      || value.revision !== session.revision
      || ![session.callerUid, session.calleeUid].includes(actorUid)
      || (type === 'offer' && actorUid !== session.callerUid)
      || (type === 'answer' && actorUid !== session.calleeUid)
    ) {
      return { ok: false, status: 'FORBIDDEN' };
    }
    const snapshot = await database.collection('users').doc(actorUid)
      .collection('devices').doc(value.senderDeviceId).get();
    const registered = snapshot.exists ? snapshot.data() : null;
    if (
      !activeV2Device(registered)
      || registered.signalDeviceId !== value.senderSignalDeviceId
      || Number(registered.identityVersion || 0) !== value.senderIdentityVersion
      || registered.identityKey !== value.identityKey
    ) {
      return { ok: false, status: 'FORBIDDEN' };
    }
    return { ok: true, identity: value };
  };
}

module.exports = {
  CALL_E2EE_PROTOCOL,
  CALL_E2EE_VERSION,
  callIdentitySchema,
  extractSha256Fingerprint,
  createCallE2eeIdentityAuthorizer,
};
