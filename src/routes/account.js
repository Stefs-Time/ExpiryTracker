import { Router } from 'express';
import { config } from '../config.js';
import { parse } from '../lib/validate.js';
import { unauthorized } from '../lib/errors.js';
import { settingsSchema, changePasswordSchema, deleteAccountSchema } from '../lib/schemas.js';
import * as users from '../services/users.js';
import * as items from '../services/items.js';
import { logIn, destroySession } from '../middleware/auth.js';
import { mailEnabled } from '../services/mailer.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ success: true, data: { ...users.toPublicUser(req.user), mailConfigured: mailEnabled() || config.isTest } });
});

router.patch('/', async (req, res, next) => {
  try {
    const patch = parse(settingsSchema, req.body);
    const merged = {
      critical: patch.criticalDays ?? req.user.critical_days,
      warning: patch.warningDays ?? req.user.warning_days,
    };
    if (merged.warning <= merged.critical) {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'The "expiring soon" window must be longer than the critical window' },
      });
    }
    const user = await users.updateSettings(req.user.id, patch);
    res.json({ success: true, data: users.toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
    if (!(await users.verifyPassword(req.user.id, currentPassword))) throw unauthorized('Current password is incorrect');
    await users.setPassword(req.user.id, newPassword); // signs out every other device
    const csrfToken = await logIn(req, await users.findById(req.user.id));
    res.json({ success: true, data: { csrfToken } });
  } catch (err) {
    next(err);
  }
});

router.post('/calendar-token', async (req, res, next) => {
  try {
    const token = await users.rotateCalendarToken(req.user.id);
    res.status(201).json({ success: true, data: { url: `${config.appUrl}/cal/${token}.ics` } });
  } catch (err) {
    next(err);
  }
});

router.delete('/calendar-token', async (req, res, next) => {
  try {
    await users.revokeCalendarToken(req.user.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Data portability (e.g. POPIA / GDPR access requests).
router.get('/export', async (req, res, next) => {
  try {
    const all = await items.allItems(req.user.id);
    const payload = {
      exportedAt: new Date().toISOString(),
      account: users.toPublicUser(req.user),
      items: all,
    };
    res.attachment('vaultexpiry-export.json').json(payload);
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    const { password } = parse(deleteAccountSchema, req.body);
    if (!(await users.verifyPassword(req.user.id, password))) throw unauthorized('Password is incorrect');
    await users.deleteUser(req.user.id);
    await destroySession(req);
    res.clearCookie('vx.sid');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
