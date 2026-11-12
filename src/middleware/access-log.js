import crypto from 'node:crypto';
import { logger } from '../lib/logger.js';

/**
 * Structured access log for API and calendar-feed requests, with a request ID
 * returned as X-Request-Id (quote it in support tickets to find the log line).
 * Never logs bodies or query strings; calendar tokens in paths are redacted.
 * Static asset requests are skipped to keep log volume low.
 */
export function accessLog(req, res, next) {
  const isApi = req.path.startsWith('/api/') || req.path.startsWith('/cal/');
  if (!isApi) return next();
  const id = crypto.randomUUID();
  // Capture now: routers rewrite req.url/req.path while the request is in flight.
  const rawPath = req.originalUrl.split('?')[0];
  const start = process.hrtime.bigint();
  res.set('X-Request-Id', id);
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const path = rawPath.replace(/^\/cal\/[^/]+\.ics$/, '/cal/[redacted].ics');
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http', {
      reqId: id,
      method: req.method,
      path,
      status: res.statusCode,
      ms: Math.round(ms),
      userId: req.session?.userId,
      ip: req.ip,
    });
  });
  return next();
}
