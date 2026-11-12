/** Minimal structured JSON logger (stdout/stderr), suitable for Railway log search. */
import { config } from '../config.js';

function write(level, msg, meta) {
  if (config.isTest && level !== 'error') return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...meta });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const logger = {
  info: (msg, meta = {}) => write('info', msg, meta),
  warn: (msg, meta = {}) => write('warn', msg, meta),
  error: (msg, meta = {}) => write('error', msg, meta),
};
