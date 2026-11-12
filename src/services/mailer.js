import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

let transport;

export const mailEnabled = () => Boolean(config.smtp.host);

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transport;
}

/** Collected messages when running tests, so behaviour can be asserted without SMTP. */
export const outbox = [];
/** Test-only: make the next N sends fail, to exercise retry paths. Ignored outside NODE_ENV=test. */
export const testControls = { failNextSends: 0 };

/**
 * Send an email. Without SMTP configured, development logs the message,
 * tests capture it in `outbox`, and production logs a warning only (no content).
 * Returns true when the message was handed to a transport.
 */
export async function sendMail({ to, subject, text, html }) {
  if (config.isTest) {
    if (testControls.failNextSends > 0) {
      testControls.failNextSends -= 1;
      throw new Error('Simulated SMTP failure');
    }
    outbox.push({ to, subject, text, html });
    return true;
  }
  if (!mailEnabled()) {
    if (config.isProd) logger.warn('SMTP not configured; email not sent', { subject });
    else logger.info('DEV EMAIL (SMTP not configured)', { to, subject, text });
    return false;
  }
  await getTransport().sendMail({ from: config.smtp.from, to, subject, text, html });
  return true;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
