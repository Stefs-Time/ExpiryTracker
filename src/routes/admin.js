/**
 * Platform admin ("back office") API. Mounted behind requireUser + requireAdmin.
 * No endpoint here returns item or photo contents — only account metadata and counts.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { parse } from '../lib/validate.js';
import { toCsv } from '../lib/csv.js';
import { logger } from '../lib/logger.js';
import {
  uuid, adminUserListSchema, adminUserFilterSchema, adminAuditSchema, adminAuditFilterSchema,
  adminDeleteSchema, adminReasonSchema, adminInviteSchema, adminNoteSchema,
} from '../lib/schemas.js';
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

const id = (req) => parse(uuid, req.params.id);
const done = async (res, userId) => res.json({ success: true, data: await admin.getUser(userId) });
/** Emails go out when SMTP is configured (tests capture them in the outbox). */
const canEmail = () => mailEnabled() || config.isTest;
const today = () => new Date().toISOString().slice(0, 10);

/** Best-effort courtesy email to a user about an admin action. Never blocks or fails the action. */
function notify(to, name, subject, lines) {
  if (!canEmail()) return;
  sendMail({
    to,
    subject,
    text: [`Hi ${name},`, '', ...lines, '', 'If you have questions, reply to this email or contact support.'].join('\n'),
    html: `<p>Hi ${escapeHtml(name)},</p>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}<p>If you have questions, reply to this email or contact support.</p>`,
  }).catch((err) => logger.warn('Admin notification email failed', { err: err.message }));
}

// ---------- Overview ----------

router.get('/stats', async (req, res) => {
  res.json({ success: true, data: { ...(await admin.platformStats()), mailConfigured: mailEnabled() } });
});

router.get('/system', async (req, res) => {
  res.json({ success: true, data: await admin.systemStatus() });
});

// ---------- Users ----------

router.get('/users', async (req, res) => {
  const result = await admin.listUsers(parse(adminUserListSchema, req.query));
  res.json({ success: true, data: result.users, meta: result.meta });
});

router.get('/users.csv', async (req, res) => {
  const users = await admin.exportUsers(parse(adminUserFilterSchema, req.query));
  const header = ['Name', 'Email', 'Role', 'Status', 'Joined', 'Last sign-in', 'Items', 'Photos', 'Active sessions', 'Email reminders', 'Timezone'];
  const rows = users.map((u) => [
    u.displayName, u.email, u.role, u.status, u.createdAt, u.lastLoginAt || '', u.itemCount, u.photoCount,
    u.activeSessions, u.emailReminders ? 'on' : 'off', u.timezone,
  ]);
  res.type('text/csv; charset=utf-8').attachment(`vaultexpiry-users-${today()}.csv`).send(toCsv(header, rows));
});

/** Invite: create the account; the user sets their own password through a 72-hour link. */
router.post('/users', async (req, res) => {
  const input = parse(adminInviteSchema, req.body);
  const viaEmail = canEmail();
  const { user, token } = await admin.inviteUser(req.user, input, req.ip, viaEmail ? 'invite_email' : 'invite_link');
  const link = `${config.appUrl}/#/reset?token=${encodeURIComponent(token)}`;
  if (viaEmail) {
    await sendMail({
      to: user.email,
      subject: 'You have been invited to VaultExpiry',
      text: `Hi ${user.display_name},\n\nAn account has been created for you on VaultExpiry, where you can track when your licences, cards and documents expire.\n\nChoose your password within ${admin.INVITE_TTL_HOURS} hours to get started:\n${link}\n\nIf you weren't expecting this, you can ignore this email.`,
      html: `<p>Hi ${escapeHtml(user.display_name)},</p><p>An account has been created for you on VaultExpiry, where you can track when your licences, cards and documents expire.</p><p><a href="${escapeHtml(link)}">Choose your password</a> within ${admin.INVITE_TTL_HOURS} hours to get started.</p><p>If you weren't expecting this, you can ignore this email.</p>`,
    });
  }
  res.status(201).json({
    success: true,
    data: {
      user: await admin.getUser(user.id),
      emailed: viaEmail,
      ...(viaEmail ? {} : { link, expiresInHours: admin.INVITE_TTL_HOURS }),
    },
  });
});

router.get('/users/:id', async (req, res) => {
  res.json({ success: true, data: await admin.getUser(id(req)) });
});

/** Account + support notes + recent admin activity, for the detail panel. */
router.get('/users/:id/detail', async (req, res) => {
  res.json({ success: true, data: await admin.getUserDetail(id(req)) });
});

/**
 * Password reset. When SMTP is configured the link is emailed to the user and
 * never shown to the admin. Without SMTP the admin receives a one-time link to
 * pass on through a trusted channel (the action is audited as such).
 */
router.post('/users/:id/password-reset', async (req, res) => {
  const userId = id(req);
  const viaEmail = canEmail();
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
});

router.post('/users/:id/unlock', async (req, res) => {
  const userId = id(req);
  await admin.unlockUser(req.user, userId, req.ip);
  await done(res, userId);
});

router.post('/users/:id/sign-out', async (req, res) => {
  const userId = id(req);
  await admin.signOutEverywhere(req.user, userId, req.ip);
  await done(res, userId);
});

router.post('/users/:id/disable', async (req, res) => {
  const userId = id(req);
  const { reason } = parse(adminReasonSchema, req.body);
  const { target } = await admin.disableUser(req.user, userId, req.ip, reason);
  notify(target.email, target.display_name, 'Your VaultExpiry account has been disabled', [
    'An administrator has disabled your VaultExpiry account. You can no longer sign in, and reminders are paused.',
    'Your data has been kept and the account can be re-enabled.',
  ]);
  await done(res, userId);
});

router.post('/users/:id/enable', async (req, res) => {
  const userId = id(req);
  const { target } = await admin.enableUser(req.user, userId, req.ip);
  notify(target.email, target.display_name, 'Your VaultExpiry account has been re-enabled', [
    'An administrator has re-enabled your VaultExpiry account. You can sign in again, and reminders have resumed.',
  ]);
  await done(res, userId);
});

router.delete('/users/:id', async (req, res) => {
  const userId = id(req);
  const { confirmEmail, reason } = parse(adminDeleteSchema, req.body);
  const { target } = await admin.deleteUser(req.user, userId, confirmEmail, req.ip, reason);
  notify(target.email, target.display_name, 'Your VaultExpiry account has been deleted', [
    'An administrator has deleted your VaultExpiry account. Your tracked items and photos have been permanently removed.',
  ]);
  res.status(204).end();
});

// ---------- Support notes ----------

router.post('/users/:id/notes', async (req, res) => {
  const { body } = parse(adminNoteSchema, req.body);
  res.status(201).json({ success: true, data: await admin.addNote(req.user, id(req), body) });
});

router.delete('/users/:id/notes/:noteId', async (req, res) => {
  await admin.deleteNote(id(req), parse(uuid, req.params.noteId));
  res.status(204).end();
});

// ---------- Audit ----------

router.get('/audit', async (req, res) => {
  const { userId, ...q } = parse(adminAuditSchema, req.query);
  const result = await admin.listAudit({ ...q, targetUserId: userId });
  res.json({ success: true, data: result.entries, meta: result.meta });
});

router.get('/audit.csv', async (req, res) => {
  const { userId, ...q } = parse(adminAuditFilterSchema, req.query);
  const entries = await admin.exportAudit({ ...q, targetUserId: userId });
  const header = ['When', 'Admin', 'Action', 'User', 'Reason', 'IP'];
  const rows = entries.map((e) => [e.createdAt, e.adminEmail, e.action, e.targetEmail, e.reason || '', e.ip || '']);
  res.type('text/csv; charset=utf-8').attachment(`vaultexpiry-audit-${today()}.csv`).send(toCsv(header, rows));
});

export default router;
