import { Router } from 'express';
import { parse } from '../lib/validate.js';
import { createItemSchema, updateItemSchema, renewSchema, listQuerySchema, importSchema, uuid } from '../lib/schemas.js';
import * as items from '../services/items.js';
import { todayIn } from '../../public/js/shared/expiry.js';

const router = Router();

const ctxFor = (user) => ({
  today: todayIn(user.timezone),
  criticalDays: user.critical_days,
  warningDays: user.warning_days,
});

const idParam = (req) => parse(uuid, req.params.id);

router.get('/', async (req, res, next) => {
  try {
    const opts = parse(listQuerySchema, req.query);
    const result = await items.listItems(req.user.id, opts, ctxFor(req.user));
    res.json({ success: true, data: result.items, meta: { ...result.meta, today: ctxFor(req.user).today } });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const data = parse(createItemSchema, req.body);
    const item = await items.createItem(req.user.id, data);
    res.status(201).location(`/api/items/${item.id}`).json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

router.post('/import', async (req, res, next) => {
  try {
    const { items: list } = parse(importSchema, req.body);
    res.status(201).json({ success: true, data: await items.importItems(req.user.id, list) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await items.getItem(req.user.id, idParam(req)) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = idParam(req);
    const patch = parse(updateItemSchema, req.body);
    res.json({ success: true, data: await items.updateItem(req.user.id, id, patch) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await items.deleteItem(req.user.id, idParam(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/renew', async (req, res, next) => {
  try {
    const id = idParam(req);
    const body = parse(renewSchema, req.body);
    const item = await items.renewItem(req.user.id, id, body, ctxFor(req.user).today);
    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/restore', async (req, res, next) => {
  try {
    res.json({ success: true, data: await items.restoreItem(req.user.id, idParam(req)) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/renewals', async (req, res, next) => {
  try {
    res.json({ success: true, data: await items.listRenewals(req.user.id, idParam(req)) });
  } catch (err) {
    next(err);
  }
});

export default router;
