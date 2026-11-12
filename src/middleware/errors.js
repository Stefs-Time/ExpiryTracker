import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundApi(req, res) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }
  // body-parser errors (malformed JSON, payload too large)
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  }
  logger.error('Unhandled error', { err: err.message, stack: err.stack, path: req.path, method: req.method });
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
