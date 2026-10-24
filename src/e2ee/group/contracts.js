const { z } = require('zod');

const GROUP_PROTOCOL = 'pulse_group_e2ee_v1';
const GROUP_PROTOCOL_VERSION = 1;
const MAX_GROUP_RECIPIENT_DEVICES = 128;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const positiveInteger = z.number().int().positive().safe();
const base64 = z.string().min(4).max(512 * 1024)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const ciphertext = base64.refine(
  value => Buffer.from(value, 'base64').length <= (384 * 1024),
  { message: 'ciphertext_too_large' },
);
const header = {
  protocol: z.literal(GROUP_PROTOCOL),
  protocolVersion: z.literal(GROUP_PROTOCOL_VERSION),
};
const sender = {
  senderDeviceId: id,
  senderSignalDeviceId: positiveInteger.max(127),
  senderIdentityVersion: positiveInteger,
};
const groupContext = {
  conversationId: id,
  epoch: positiveInteger,
  distributionId: z.string().uuid(),
};

const recipientEnvelope = z.object({
  recipientUserId: id,
  recipientDeviceId: id,
  envelopeType: z.enum(['prekey', 'message']),
  ciphertext,
}).strict();

const senderKeyDistribution = z.object({
  ...header,
  ...groupContext,
  ...sender,
  recipientEnvelopes: z.array(recipientEnvelope).min(1).max(MAX_GROUP_RECIPIENT_DEVICES),
}).strict().superRefine((value, context) => {
  const seen = new Set();
  value.recipientEnvelopes.forEach((envelope, index) => {
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

const groupMessage = z.object({
  ...header,
  ...groupContext,
  ...sender,
  clientMessageId: z.string().uuid(),
  messageType: z.literal('text'),
  ciphertext,
}).strict();

module.exports = {
  GROUP_PROTOCOL,
  GROUP_PROTOCOL_VERSION,
  MAX_GROUP_RECIPIENT_DEVICES,
  schemas: {
    groupMessage,
    senderKeyDistribution,
  },
};
