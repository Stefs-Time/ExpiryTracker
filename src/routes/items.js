/** Items CRUD, renewals, soft delete/restore and bulk import (all scoped to req.user). */
import { Router } from 'express';
import { parse } from '../lib/validate.js';
import { createItemSchema, updateItemSchema, renewSchema, listQuerySchema, importSchema, uuid } from '../lib/schemas.js';
import * as items from '../services/items.js';
import { todayIn } from '../../public/js/shared/expiry.js';

const router = Router();

/** The user's local "today" and status thresholds. */
const ctxFor = (user) => ({
  today: todayIn(user.timezone),
  criticalDays: user.critical_days,
  warningDays: user.warning_days,
});

const idParam = (req) => parse(uuid, req.params.id);

router.get('/', async (req, res) => {
  const opts = parse(listQuerySchema, req.query);
  const ctx = ctxFor(req.user);
  const result = await items.listItems(req.user.id, opts, ctx);
  res.json({ success: true, data: result.items, meta: { ...result.meta, today: ctx.today } });
});

router.post('/', async (req, res) => {
  const item = await items.createItem(req.user.id, parse(createItemSchema, req.body));
  res.status(201).location(`/api/items/${item.id}`).json({ success: true, data: item });
});

router.post('/import', async (req, res) => {
  const { items: list } = parse(importSchema, req.body);
  res.status(201).json({ success: true, data: await items.importItems(req.user.id, list) });
});

router.get('/:id', async (req, res) => {
  res.json({ success: true, data: await items.getItem(req.user.id, idParam(req)) });
});

router.patch('/:id', async (req, res) => {
  const id = idParam(req);
  res.json({ success: true, data: await items.updateItem(req.user.id, id, parse(updateItemSchema, req.body)) });
});

router.delete('/:id', async (req, res) => {
  await items.deleteItem(req.user.id, idParam(req));
  res.status(204).end();
});

router.post('/:id/restore', async (req, res) => {
  res.json({ success: true, data: await items.restoreItem(req.user.id, idParam(req)) });
});

router.post('/:id/renew', async (req, res) => {
  const id = idParam(req);
  const body = parse(renewSchema, req.body);
  res.json({ success: true, data: await items.renewItem(req.user.id, id, body, ctxFor(req.user).today) });
});

router.get('/:id/renewals', async (req, res) => {
  res.json({ success: true, data: await items.listRenewals(req.user.id, idParam(req)) });
});

export default router;
