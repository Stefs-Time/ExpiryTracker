/**
 * Signed-in user's own account: profile/settings, AI-scan consent, password,
 * calendar feed, data export and account deletion.
 * Express 5 forwards rejected promises to the error handler, so handlers are plain async functions.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { parse } from '../lib/validate.js';
import { unauthorized, unprocessable } from '../lib/errors.js';
import { settingsSchema, changePasswordSchema, deleteAccountSchema, consentSchema } from '../lib/schemas.js';
import * as users from '../services/users.js';
import * as items from '../services/items.js';
import { listUserPhotos, storageUsage } from '../services/attachments.js';
import { mailEnabled } from '../services/mailer.js';
import { logIn, destroySession } from '../middleware/auth.js';

const router = Router();

router.get('/', async (req, res) => {
  res.json({
    success: true,
    data: {
      ...users.toPublicUser(req.user),
      mailConfigured: mailEnabled() || config.isTest,
      scanEnabled: config.scanEnabled,
      attachmentsEnabled: config.attachmentsEnabled,
      photoStorage: await storageUsage(req.user.id),
    },
  });
});

router.patch('/', async (req, res) => {
  const patch = parse(settingsSchema, req.body);
  const critical = patch.criticalDays ?? req.user.critical_days;
  const warning = patch.warningDays ?? req.user.warning_days;
  if (warning <= critical) {
    throw unprocessable('The "expiring soon" window must be longer than the critical window', [{ field: 'warningDays' }]);
  }
  const user = await users.updateSettings(req.user.id, patch);
  res.json({ success: true, data: users.toPublicUser(user) });
});

router.put('/scan-consent', async (req, res) => {
  const { consent } = parse(consentSchema, req.body);
  const user = await users.setScanConsent(req.user.id, consent);
  res.json({ success: true, data: users.toPublicUser(user) });
});

router.post('/password', async (req, res) => {
  const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
  if (!(await users.verifyPassword(req.user.id, currentPassword))) throw unauthorized('Current password is incorrect');
  await users.setPassword(req.user.id, newPassword); // signs out every other device
  const csrfToken = await logIn(req, await users.findById(req.user.id));
  res.json({ success: true, data: { csrfToken } });
});

router.post('/calendar-token', async (req, res) => {
  const token = await users.rotateCalendarToken(req.user.id);
  res.status(201).json({ success: true, data: { url: `${config.appUrl}/cal/${token}.ics` } });
});

router.delete('/calendar-token', async (req, res) => {
  await users.revokeCalendarToken(req.user.id);
  res.status(204).end();
});

// Data portability (POPIA / GDPR access requests). Photos are listed, not embedded:
// each one downloads from its URL while signed in.
router.get('/export', async (req, res) => {
  const [allItems, photos] = await Promise.all([items.allItems(req.user.id), listUserPhotos(req.user.id)]);
  res.attachment('vaultexpiry-export.json').json({
    exportedAt: new Date().toISOString(),
    account: users.toPublicUser(req.user),
    items: allItems,
    photos,
  });
});

router.delete('/', async (req, res) => {
  const { password } = parse(deleteAccountSchema, req.body);
  if (!(await users.verifyPassword(req.user.id, password))) throw unauthorized('Password is incorrect');
  await users.deleteUser(req.user.id);
  await destroySession(req);
  res.clearCookie('vx.sid');
  res.status(204).end();
});

export default router;
