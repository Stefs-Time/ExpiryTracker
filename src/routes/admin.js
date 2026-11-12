import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { parse } from '../lib/validate.js';
import { uuid } from '../lib/schemas.js';
import * as admin from '../services/admin.js';
import { sendMail, escapeHtml, mailEnabled } from '../services/mailer.js';

const router = Router();

// Admin mutations are sensitive; cap them per IP regardless of the global limiter.
router.use(
  rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.method === 'GET' || config.isTest,
  }),
);

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'locked', 'disabled']).optional(),
  role: z.enum(['user', 'admin']).optional(),
  sort: z.enum(['created', '-created', 'email', 'lastLogin']).optional().default('created'),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
const auditSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  userId: uuid.optional(),
});
const deleteSchema = z.object({ confirmEmail: z.string().trim().toLowerCase().max(254) }).strict();

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};
const id = (req) => parse(uuid, req.params.id);
const done = async (res, userId) => res.json({ success: true, data: await admin.getUser(userId) });

router.get('/stats', wrap(async (req, res) => {
  res.json({ success: true, data: { ...(await admin.platformStats()), mailConfigured: mailEnabled() } });
}));

router.get('/users', wrap(async (req, res) => {
  const result = await admin.listUsers(parse(listSchema, req.query));
  res.json({ success: true, data: result.users, meta: result.meta });
}));

router.get('/users/:id', wrap(async (req, res) => {
  res.json({ success: true, data: await admin.getUser(id(req)) });
}));

/**
 * Password reset. When SMTP is configured the link is emailed to the user and
 * never shown to the admin. Without SMTP the admin receives a one-time link to
 * pass on through a trusted channel (the action is audited as such).
 */
router.post('/users/:id/password-reset', wrap(async (req, res) => {
  const userId = id(req);
  const viaEmail = mailEnabled() || config.isTest;
  const { target, result: token } = await admin.createResetFor(
    req.user, userId, req.ip, viaEmail ? 'password_reset_email' : 'password_reset_link',
  );
  const link = `${config.appUrl}/#/reset?token=${encodeURIComponent(token)}`;
  if (viaEmail) {
    await sendMail({
      to: target.email,
      subject: 'Reset your VaultExpiry password',
      text: `Hi ${target.display_name},\n\nA VaultExpiry administrator started a password reset for your account. Use this link within 60 minutes to choose a new password:\n${link}\n\nIf you didn't expect this, contact support.`,
      html: `<p>Hi ${escapeHtml(target.display_name)},</p><p>A VaultExpiry administrator started a password reset for your account. Use this link within 60 minutes to choose a new password:</p><p><a href="${escapeHtml(link)}">Reset password</a></p><p>If you didn't expect this, contact support.</p>`,
    });
    return res.json({ success: true, data: { emailed: true } });
  }
  return res.json({ success: true, data: { emailed: false, link, expiresInMinutes: 60 } });
}));

router.post('/users/:id/unlock', wrap(async (req, res) => {
  const userId = id(req);
  await admin.unlockUser(req.user, userId, req.ip);
  await done(res, userId);
}));

router.post('/users/:id/sign-out', wrap(async (req, res) => {
  const userId = id(req);
  await admin.signOutEverywhere(req.user, userId, req.ip);
  await done(res, userId);
}));

router.post('/users/:id/disable', wrap(async (req, res) => {
  const userId = id(req);
  await admin.disableUser(req.user, userId, req.ip);
  await done(res, userId);
}));

router.post('/users/:id/enable', wrap(async (req, res) => {
  const userId = id(req);
  await admin.enableUser(req.user, userId, req.ip);
  await done(res, userId);
}));

router.delete('/users/:id', wrap(async (req, res) => {
  const userId = id(req);
  const { confirmEmail } = parse(deleteSchema, req.body);
  await admin.deleteUser(req.user, userId, confirmEmail, req.ip);
  res.status(204).end();
}));

router.get('/audit', wrap(async (req, res) => {
  const q = parse(auditSchema, req.query);
  res.json({ success: true, data: await admin.listAudit({ ...q, targetUserId: q.userId }) });
}));

export default router;
