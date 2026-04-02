const router = require('express').Router();
const crypto = require('crypto');
const { admin } = require('../firebase');
const { sendCodeLimiter, verifyCodeLimiter, strictLimiter } = require('../middleware');
const { transporter, otpSet, otpGet, otpDel } = require('../email');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(e) { return typeof e === 'string' && EMAIL_REGEX.test(e.trim()); }

// ─── OTP: Stuur verificatiecode ──────────────────────────────────────────────
router.post('/api/send-code', sendCodeLimiter, async (req, res) => {
  const { email } = req.body;
  if (!validEmail(email)) return res.status(400).json({ error: 'Ongeldig e-mailadres.' });

  const code = crypto.randomInt(100000, 1000000).toString();
  await otpSet(email, code, Date.now() + 15 * 60 * 1000);

  try {
    await transporter.sendMail({
      from: '"Pulse" <info@pulse-messenger.com>',
      to: email,
      subject: 'Jouw verificatiecode voor Pulse',
      html: `
        <div style="font-family:sans-serif;max-width:400px;margin:auto">
          <h2 style="color:#7c4dff">Pulse verificatiecode</h2>
          <p>Gebruik de onderstaande code om je account te bevestigen:</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#f3f0ff;border-radius:8px;color:#7c4dff">
            ${code}
          </div>
          <p style="color:#888;font-size:13px">Deze code is 15 minuten geldig en kan slechts één keer gebruikt worden.</p>
        </div>
      `,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('E-mail fout:', err);
    await otpDel(email); // code opruimen — gebruiker heeft hem niet ontvangen
    res.status(500).json({ error: 'E-mail versturen mislukt.' });
  }
});

// ─── OTP: Verifieer code ─────────────────────────────────────────────────────
router.post('/api/verify-code', verifyCodeLimiter, async (req, res) => {
  const { email, code } = req.body;
  const entry = await otpGet(email);
  if (!entry)                       return res.status(400).json({ error: 'Geen code gevonden. Vraag een nieuwe aan.' });
  if (Date.now() > entry.expiresAt) { await otpDel(email); return res.status(400).json({ error: 'Code verlopen.' }); }
  const a = Buffer.from(String(entry.code));
  const b = Buffer.from(String(code));
  const mismatch = a.length !== b.length || !crypto.timingSafeEqual(a, b);
  if (mismatch)                     return res.status(400).json({ error: 'Verkeerde code.' });
  await otpDel(email);
  res.json({ ok: true });
});

// ─── Wachtwoord reset mail (eigen stijl) ─────────────────────────────────────
router.post('/api/send-reset', sendCodeLimiter, async (req, res) => {
  const { email, actionUrl } = req.body;
  if (!validEmail(email)) return res.status(400).json({ error: 'Ongeldig e-mailadres.' });
  try {
    const resetLink = await admin.auth().generatePasswordResetLink(email, {
      url: actionUrl || process.env.APP_URL || 'http://localhost:3000',
    });
    await transporter.sendMail({
      from: '"Pulse" <info@pulse-messenger.com>',
      to: email,
      subject: 'Wachtwoord opnieuw instellen — Pulse',
      html: `
        <div style="font-family:sans-serif;max-width:440px;margin:auto;background:#13111a;border-radius:16px;padding:36px;color:#e2e0ff">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
            <span style="font-size:28px">💬</span>
            <span style="font-size:22px;font-weight:800;color:#a78bfa;letter-spacing:-0.5px">Pulse</span>
          </div>
          <h2 style="margin:0 0 12px;font-size:20px;color:#fff">Wachtwoord opnieuw instellen</h2>
          <p style="color:#9d9ab5;margin:0 0 28px;line-height:1.6">
            We hebben een verzoek ontvangen om het wachtwoord van je Pulse-account te wijzigen voor <strong style="color:#e2e0ff">${email}</strong>.
          </p>
          <a href="${resetLink}" style="display:block;text-align:center;background:linear-gradient(135deg,#7c6fff,#a855f7);color:#fff;text-decoration:none;padding:15px 24px;border-radius:12px;font-weight:700;font-size:15px;margin-bottom:24px">
            Wachtwoord wijzigen →
          </a>
          <p style="color:#6b6880;font-size:13px;line-height:1.6;margin:0">
            Als je dit niet hebt aangevraagd, kun je deze e-mail negeren.<br/>
            De link is 1 uur geldig.
          </p>
        </div>
      `,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset mail fout:', err);
    res.status(500).json({ error: 'E-mail versturen mislukt.' });
  }
});

module.exports = router;
