const { z } = require('zod');

const schemas = {
  messageSend: z.object({
    convId:  z.string().min(1).max(128),
    message: z.object({
      text: z.string().max(5000).optional(),
      type: z.enum(['text', 'image', 'call', 'contact', 'file']).optional(),
    }).passthrough(),
  }),
  messageEdit: z.object({
    convId:  z.string().min(1).max(128),
    msgId:   z.string().min(1).max(128),
    newText: z.string().min(1).max(5000),
  }),
  messageReact: z.object({
    convId: z.string().min(1).max(128),
    msgId:  z.string().min(1).max(128),
    emoji:  z.string().min(1).max(8),
  }),
  convCreate: z.object({
    members:      z.array(z.string().min(1).max(128)).min(1).max(50),
    memberNames:  z.record(z.string(), z.string().max(64)).optional(),
    memberEmails: z.record(z.string(), z.string().max(128)).optional(),
    isGroup:      z.boolean().optional(),
    groupName:    z.string().max(64).optional(),
  }),
};

function validate(schema, data, callback) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues[0]?.message || 'Ongeldige invoer.';
    if (typeof callback === 'function') callback({ error: msg });
    return null;
  }
  return result.data;
}

module.exports = { schemas, validate };
