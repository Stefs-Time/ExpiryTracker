import { config } from './config.js';
import { logger } from './lib/logger.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { startReminderScheduler, stopReminderScheduler } from './services/reminders.js';

async function main() {
  await migrate();
  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info('VaultExpiry listening', { port: config.port, env: config.env });
  });
  server.keepAliveTimeout = 65_000; // longer than typical proxy idle timeouts
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  startReminderScheduler();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    stopReminderScheduler();
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
