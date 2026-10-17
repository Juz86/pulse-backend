const { z } = require('zod');

const PROTOCOL = 'pulse_e2ee_v2';
const PROTOCOL_VERSION = 2;
const MAX_ONE_TIME_PREKEYS = 100;
const MAX_SIGNAL_DEVICE_ID = 127;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const base64 = z.string().min(4).max(350000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const ciphertext = base64.refine(
  (value) => Buffer.from(value, 'base64').length <= (256 * 1024),
  { message: 'ciphertext_too_large' },
);
const keyMaterial = base64.max(2048);
const positiveInteger = z.number().int().positive().safe();
const signalDeviceId = positiveInteger.max(MAX_SIGNAL_DEVICE_ID);
const protocolHeader = {
  protocol: z.literal(PROTOCOL),
  protocolVersion: z.literal(PROTOCOL_VERSION),
};

const signedPreKey = z.object({
  keyId: positiveInteger,
  publicKey: keyMaterial,
  signature: keyMaterial,
}).strict();

const kyberPreKey = z.object({
  keyId: positiveInteger,
  publicKey: base64.max(5500),
  signature: keyMaterial,
}).strict();

const oneTimePreKey = z.object({
  keyId: positiveInteger,
  publicKey: keyMaterial,
}).strict();

const oneTimePreKeys = z.array(oneTimePreKey).min(1).max(MAX_ONE_TIME_PREKEYS)
  .superRefine((keys, context) => {
    const seen = new Set();
    keys.forEach((key, index) => {
      if (seen.has(key.keyId)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate_prekey_id',
          path: [index, 'keyId'],
        });
      }
      seen.add(key.keyId);
    });
  });

const deviceRegistration = z.object({
  ...protocolHeader,
  deviceId: id,
  signalDeviceId,
  deviceLabel: z.string().min(1).max(80).optional(),
  platform: z.enum(['android', 'web']),
  capabilities: z.object({
    messageEncryption: z.literal(true),
    hardwareBackedKeystore: z.boolean(),
  }).strict(),
  registrationId: positiveInteger,
  identityKey: keyMaterial,
  signedPreKey,
  kyberPreKey,
  oneTimePreKeys,
}).strict();

const keyRotation = z.object({
  ...protocolHeader,
  registrationId: positiveInteger,
  signalDeviceId,
  identityKey: keyMaterial,
  signedPreKey,
  kyberPreKey,
  oneTimePreKeys,
}).strict();

const preKeyRefill = z.object({
  ...protocolHeader,
  oneTimePreKeys,
}).strict();

const lifecycleAction = z.object(protocolHeader).strict();

const keyBundleClaim = z.object({
  ...protocolHeader,
  requesterDeviceId: id,
  claimId: z.string().uuid(),
}).strict();

const recipientEnvelope = z.object({
  recipientUserId: id,
  recipientDeviceId: id,
  envelopeType: z.enum(['prekey', 'message']),
  ciphertext,
}).strict();

const messageSend = z.object({
  ...protocolHeader,
  conversationId: id,
  clientMessageId: z.string().uuid(),
  senderDeviceId: id,
  messageType: z.literal('text'),
  recipientEnvelopes: z.array(recipientEnvelope).min(1).max(128),
}).strict().superRefine((message, context) => {
  const seen = new Set();
  message.recipientEnvelopes.forEach((envelope, index) => {
    const key = `${envelope.recipientUserId}\u0000${envelope.recipientDeviceId}`;
    if (seen.has(key)) {
      context.addIssue({
        code: 'custom',
        message: 'duplicate_recipient',
        path: ['recipientEnvelopes', index],
      });
    }
    seen.add(key);
  });
});

module.exports = {
  MAX_ONE_TIME_PREKEYS,
  MAX_SIGNAL_DEVICE_ID,
  PROTOCOL,
  PROTOCOL_VERSION,
  schemas: {
    deviceRegistration,
    keyBundleClaim,
    keyRotation,
    lifecycleAction,
    messageSend,
    preKeyRefill,
  },
};
