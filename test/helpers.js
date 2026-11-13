import request from 'supertest';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';

export const ORIGIN = 'http://127.0.0.1';

export async function setupDb() {
  await migrate();
  await pool.query('TRUNCATE users, items, item_renewals, password_resets, reminder_log, session, admin_audit, admin_notes CASCADE');
}

export function newApp() {
  return createApp();
}

/** A logged-in supertest agent with CSRF token handling. */
export async function signUp(app, overrides = {}) {
  const agent = request.agent(app);
  const body = {
    email: `user${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: 'correct horse battery',
    displayName: 'Test User',
    ...overrides,
  };
  const res = await agent.post('/api/auth/signup').set('Origin', ORIGIN).send(body);
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  const send = (method) => (url) => agent[method](url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return {
    agent,
    user: res.body.data.user,
    password: body.password,
    csrf,
    get: (url) => agent.get(url),
    post: send('post'),
    patch: send('patch'),
    del: send('delete'),
  };
}

export const sampleItem = (o = {}) => ({
  title: "Driver's licence",
  category: 'License',
  ref: 'DL •••• 8834',
  expiryDate: '2030-12-04',
  cycleMonths: 60,
  leadDays: 60,
  note: 'Eye test required',
  ...o,
});

export { pool };
