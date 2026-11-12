import { config } from './config.js';
import { logger } from './lib/logger.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { startReminderScheduler, stopReminderScheduler } from './services/reminders.js';
import { seedAdmin } from './services/admin.js';
import { startMaintenance, stopMaintenance } from './services/maintenance.js';

/**
 * Optional boot-time admin bootstrap (handy on Railway, where one-off scripts are awkward).
 * Creates the admin account if it does not exist. It never promotes an existing normal
 * account (someone could have registered that email first) and never overwrites a
 * password, so ADMIN_PASSWORD can (and should) be removed after the first boot.
 */
async function bootstrapAdmin() {
  const { email, password, name } = config.bootstrapAdmin;
  if (!email) return;
  try {
    const { action } = await seedAdmin({ email, password, displayName: name, allowPromote: false });
    if (action === 'refused_existing_user') {
      logger.warn('ADMIN_EMAIL belongs to an existing non-admin account; not promoting it automatically. '
        + 'Verify the account is yours, then run: npm run admin:seed -- --email <email>');
      return;
    }
    if (action !== 'unchanged') logger.info('Platform admin bootstrap', { email, action });
    if (action === 'created' && password.length < 12) {
      logger.warn('Platform admin created with a short password (< 12 characters). Change it in Settings after first sign-in.');
    }
    if (password && action === 'unchanged') {
      logger.warn('ADMIN_PASSWORD is still set but the admin already exists; remove it from the environment');
    }
  } catch (err) {
    logger.error('Platform admin bootstrap failed', { email, err: err.message });
  }
}

async function main() {
  await migrate();
  await bootstrapAdmin();
  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info('VaultExpiry listening', { port: config.port, env: config.env });
  });
  server.keepAliveTimeout = 65_000; // longer than typical proxy idle timeouts
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  startReminderScheduler();
  startMaintenance();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    stopReminderScheduler();
    stopMaintenance();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', { err: String(err?.stack || err) }));

main().catch((err) => {
  logger.error('Startup failed', { err: err.message });
  process.exit(1);
});
