import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { csrfProtection, noStore } from './middleware/security.js';
import { requireUser } from './middleware/auth.js';
import { errorHandler, notFoundApi } from './middleware/errors.js';
import authRoutes from './routes/auth.js';
import itemRoutes from './routes/items.js';
import accountRoutes from './routes/account.js';
import reportRoutes from './routes/reports.js';
import { findByCalendarToken } from './services/users.js';
import { allItems } from './services/items.js';
import { buildCalendar } from './services/calendar.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PgStore = connectPgSimple(session);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy); // Railway terminates TLS at its edge proxy

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'"],
          'connect-src': ["'self'"],
          'manifest-src': ["'self'"],
          'worker-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'base-uri': ["'self'"],
          'upgrade-insecure-requests': config.isProd ? [] : null,
        },
      },
      hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'same-origin' },
    }),
  );
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });

  // Health check for Railway (no session, no auth).
  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.set('Cache-Control', 'no-store').json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // Private calendar subscription feed: authenticated by an unguessable token in the URL.
  const feedLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  app.get('/cal/:token.ics', feedLimiter, async (req, res, next) => {
    try {
      const token = String(req.params.token || '');
      const user = /^[A-Za-z0-9_-]{40,60}$/.test(token) ? await findByCalendarToken(token) : null;
      if (!user) return res.status(404).type('text/plain').send('Calendar not found');
      const ics = buildCalendar(await allItems(user.id), { appUrl: config.appUrl });
      res.set('Cache-Control', 'private, max-age=900').type('text/calendar; charset=utf-8').send(ics);
    } catch (err) {
      next(err);
    }
  });

  // Static frontend. The service worker and HTML must always revalidate so updates roll out.
  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (base === 'sw.js' || filePath.endsWith('.html') || base === 'manifest.webmanifest') {
          res.set('Cache-Control', 'no-cache');
        } else {
          res.set('Cache-Control', 'public, max-age=3600');
        }
        if (base === 'manifest.webmanifest') res.type('application/manifest+json');
      },
    }),
  );

  // --- API ---
  const api = express.Router();
  api.use(noStore);
  const smallJson = express.json({ limit: '32kb' });
  const importJson = express.json({ limit: '1mb' });
  api.use((req, res, next) => (req.path === '/items/import' ? importJson : smallJson)(req, res, next));
  api.use(
    session({
      name: 'vx.sid',
      store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false, pruneSessionInterval: 60 * 15 }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: true,
      cookie: {
        httpOnly: true,
        secure: config.isProd,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days, sliding
      },
    }),
  );
  api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, skip: () => config.isTest }));
  api.use(csrfProtection);

  api.use('/auth', authRoutes);
  api.use('/items', requireUser, itemRoutes);
  api.use('/account', requireUser, accountRoutes);
  api.use('/reports', requireUser, reportRoutes);
  api.use(notFoundApi);

  app.use('/api', api);
  app.use('/api', errorHandler);

  // Anything else: plain 404 (the SPA uses hash routing, so no HTML fallback is needed).
  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  app.use(errorHandler);
  return app;
}
