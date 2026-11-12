/**
 * Photo routes:
 *   POST   /api/scan                               — AI-read a photo (not stored)
 *   GET    /api/items/:id/attachments              — list photo metadata
 *   POST   /api/items/:id/attachments?label=front  — upload (raw image/jpeg body)
 *   GET    /api/items/:id/attachments/:aid         — decrypted image (owner only, never cached)
 *   DELETE /api/items/:id/attachments/:aid
 * Request bodies are raw JPEG bytes (no multipart parser needed).
 */
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { parse } from '../lib/validate.js';
import { uuid, photoLabelSchema } from '../lib/schemas.js';
import { AppError } from '../lib/errors.js';
import * as attachments from '../services/attachments.js';
import { scanDocument } from '../services/scan.js';

const rawJpeg = express.raw({ type: 'image/jpeg', limit: '5mb' });

// ---- Scan ----
export const scanRouter = Router();

// Each scan costs money and sends data to a third party: cap per user.
const scanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `scan:${req.user.id}`,
  skip: () => config.isTest && !process.env.TEST_RATE_LIMIT,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: "You've scanned a lot of photos in the last hour. Try again later, or fill the details in yourself." },
  }),
});

scanRouter.post('/', scanLimiter, rawJpeg, async (req, res) => {
  if (!config.scanEnabled) throw new AppError(503, 'FEATURE_DISABLED', 'Photo scanning is not enabled on this server');
  if (!req.user.ai_scan_consent_at) {
    throw new AppError(403, 'CONSENT_REQUIRED', 'Please agree to photo scanning before using it');
  }
  const img = attachments.prepareImage(req.body);
  const result = await scanDocument(img.buffer, req.user);
  res.json({ success: true, data: result });
});

// ---- Attachments (mounted under /api/items/:id/attachments) ----
export const attachmentRouter = Router({ mergeParams: true });

attachmentRouter.use((req, res, next) => {
  if (!config.attachmentsEnabled) return next(new AppError(503, 'FEATURE_DISABLED', 'Document photos are not enabled on this server'));
  return next();
});

const itemId = (req) => parse(uuid, req.params.id);
const attId = (req) => parse(uuid, req.params.aid);

attachmentRouter.get('/', async (req, res) => {
  res.json({ success: true, data: await attachments.listAttachments(req.user.id, itemId(req)) });
});

attachmentRouter.post('/', rawJpeg, async (req, res) => {
  const { label } = parse(photoLabelSchema, req.query);
  const meta = await attachments.addAttachment(req.user.id, itemId(req), { label, body: req.body });
  res.status(201).location(meta.url).json({ success: true, data: meta });
});

attachmentRouter.get('/:aid', async (req, res) => {
  const file = await attachments.readAttachment(req.user.id, itemId(req), attId(req));
  res.set({
    'Content-Type': file.contentType,
    'Cache-Control': 'private, no-store',
    'Content-Disposition': 'inline; filename="document.jpg"',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: file.etag,
  });
  res.send(file.body);
});

attachmentRouter.delete('/:aid', async (req, res) => {
  await attachments.deleteAttachment(req.user.id, itemId(req), attId(req));
  res.status(204).end();
});
