import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { parse } from '../lib/validate.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { signupSchema, loginSchema, forgotSchema, resetSchema } from '../lib/schemas.js';
import * as users from '../services/users.js';
import { sendMail, escapeHtml } from '../services/mailer.js';
import { logIn, destroySession, requireUser } from '../middleware/auth.js';
import { ensureCsrfToken } from '../middleware/security.js';

const router = Router();

const limiter = (limit, windowMinutes) =>
  rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => config.isTest && !process.env.TEST_RATE_LIMIT,
    handler: (req, res) =>
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' },
      }),
  });

const loginLimiter = limiter(10, 15);
const signupLimiter = limiter(5, 60);
const resetLimiter = limiter(5, 60);

router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: { signupEnabled: config.signupEnabled, scanEnabled: config.scanEnabled, attachmentsEnabled: config.attachmentsEnabled },
  });
});

router.post('/signup', signupLimiter, async (req, res) => {
  if (!config.signupEnabled) throw new AppError(403, 'SIGNUP_DISABLED', 'Sign-up is currently disabled');
  const input = parse(signupSchema, req.body);
  const user = await users.createUser(input);
  const csrfToken = await logIn(req, user);
  res.status(201).json({ success: true, data: { user: users.toPublicUser(user), csrfToken } });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = parse(loginSchema, req.body);
  const user = await users.authenticate(email, password);
  const csrfToken = await logIn(req, user);
  res.json({ success: true, data: { user: users.toPublicUser(user), csrfToken } });
});

router.post('/logout', async (req, res) => {
  await destroySession(req);
  res.clearCookie('vx.sid');
  res.status(204).end();
});

router.get('/me', requireUser, (req, res) => {
  const csrfToken = ensureCsrfToken(req.session);
  res.json({ success: true, data: { user: users.toPublicUser(req.user), csrfToken } });
});

// Always 202 so the response does not reveal whether an account exists.
router.post('/forgot', resetLimiter, async (req, res) => {
  const { email } = parse(forgotSchema, req.body);
  const reset = await users.createPasswordReset(email);
  if (reset) {
    const link = `${config.appUrl}/#/reset?token=${encodeURIComponent(reset.token)}`;
    sendMail({
      to: reset.user.email,
      subject: 'Reset your VaultExpiry password',
      text: `Hi ${reset.user.display_name},\n\nUse this link within 60 minutes to choose a new password:\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
      html: `<p>Hi ${escapeHtml(reset.user.display_name)},</p><p>Use this link within 60 minutes to choose a new password:</p><p><a href="${escapeHtml(link)}">Reset password</a></p><p>If you didn't ask for this, you can ignore this email.</p>`,
    }).catch((err) => logger.error('Password reset email failed', { err: err.message }));
  }
  res.status(202).json({
    success: true,
    data: { message: 'If an account exists for that email, a reset link is on its way.' },
  });
});

router.post('/reset', resetLimiter, async (req, res) => {
  const { token, password } = parse(resetSchema, req.body);
  const userId = await users.consumePasswordReset(token, password);
  const user = await users.findById(userId);
  const csrfToken = await logIn(req, user);
  res.json({ success: true, data: { user: users.toPublicUser(user), csrfToken } });
});

export default router;
