import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDb, newApp, signUp, sampleItem, pool, ORIGIN } from './helpers.js';
import { seedAdmin, demoteAdmin } from '../src/services/admin.js';
import { outbox } from '../src/services/mailer.js';

let app;
let adminSession;
const ADMIN = { email: 'root@example.com', password: 'admin password 123' };

async function loginAs(email, password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  const send = (m) => (url) => agent[m](url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return { agent, me: res.body.data.user, get: (u) => agent.get(u), post: send('post'), del: send('delete') };
}

before(async () => {
  await setupDb();
  app = newApp();
  await seedAdmin({ ...ADMIN, displayName: 'Root' });
  adminSession = await loginAs(ADMIN.email, ADMIN.password);
});
after(async () => {
  await pool.end();
});

describe('access control', () => {
  test('admin flag is exposed on /me', () => {
    assert.equal(adminSession.me.isAdmin, true);
  });

  test('normal users and anonymous get 403/401 on every admin route', async () => {
    const u = await signUp(app);
    assert.equal(u.user.isAdmin, false);
    assert.equal((await u.get('/api/admin/users')).status, 403);
    assert.equal((await u.get('/api/admin/stats')).status, 403);
    assert.equal((await u.post(`/api/admin/users/${u.user.id}/unlock`)).status, 403);
    assert.equal((await request(app).get('/api/admin/users')).status, 401);
  });

  test('a normal user cannot make themselves admin through settings', async () => {
    const u = await signUp(app);
    const res = await u.patch('/api/account').send({ role: 'admin' });
    assert.equal(res.status, 422);
  });
});

describe('privacy boundary', () => {
  test('user list and detail expose counts, never item contents or secrets', async () => {
    const u = await signUp(app, { email: 'private@example.com' });
    await u.post('/api/items').send(sampleItem({ title: 'SECRET-TITLE', ref: 'REF-9999', note: 'SECRET-NOTE' }));
    const list = await adminSession.get('/api/admin/users?q=private');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    const row = list.body.data[0];
    assert.equal(row.itemCount, 1);
    const detail = await adminSession.get(`/api/admin/users/${row.id}`);
    const blob = JSON.stringify([list.body, detail.body]);
    for (const secret of ['SECRET-TITLE', 'REF-9999', 'SECRET-NOTE', 'password_hash', '$argon2', 'calendar_token']) {
      assert.ok(!blob.includes(secret), `leaked ${secret}`);
    }
    // There is no admin route to read a user's items.
    assert.equal((await adminSession.get(`/api/admin/users/${row.id}/items`)).status, 404);
  });
});

describe('listing', () => {
  test('search, filter, paginate, stats', async () => {
    await signUp(app, { email: 'alpha@example.com', displayName: 'Alpha' });
    await signUp(app, { email: 'beta@example.com', displayName: 'Beta' });
    const res = await adminSession.get('/api/admin/users?q=alp');
    assert.deepEqual(res.body.data.map((u) => u.email), ['alpha@example.com']);
    const admins = await adminSession.get('/api/admin/users?role=admin');
    assert.deepEqual(admins.body.data.map((u) => u.email), [ADMIN.email]);
    const page = await adminSession.get('/api/admin/users?limit=1');
    assert.ok(page.body.meta.totalPages >= 3);
    const stats = await adminSession.get('/api/admin/stats');
    assert.ok(stats.body.data.users >= 3);
    assert.equal(stats.body.data.admins, 1);
    assert.equal((await adminSession.get('/api/admin/users?limit=999')).status, 422);
  });
});

describe('actions', () => {
  test('password reset email goes to the user, link not shown to admin, audited', async () => {
    const u = await signUp(app, { email: 'forgetful@example.com' });
    outbox.length = 0;
    const res = await adminSession.post(`/api/admin/users/${u.user.id}/password-reset`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { emailed: true });
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, 'forgetful@example.com');
    const token = decodeURIComponent(/token=([^\s"&]+)/.exec(outbox[0].text)[1]);
    const reset = await request(app).post('/api/auth/reset').send({ token, password: 'my new password!' });
    assert.equal(reset.status, 200);
    const audit = await adminSession.get(`/api/admin/audit?userId=${u.user.id}`);
    assert.equal(audit.body.data[0].action, 'password_reset_email');
    assert.equal(audit.body.data[0].adminEmail, ADMIN.email);
  });

  test('unlock clears a lockout', async () => {
    const u = await signUp(app, { email: 'locked@example.com', password: 'right password 1' });
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').send({ email: 'locked@example.com', password: 'wrong password' });
    }
    const before = await adminSession.get(`/api/admin/users/${u.user.id}`);
    assert.equal(before.body.data.status, 'locked');
    const res = await adminSession.post(`/api/admin/users/${u.user.id}/unlock`);
    assert.equal(res.body.data.status, 'active');
    const login = await request(app).post('/api/auth/login').send({ email: 'locked@example.com', password: 'right password 1' });
    assert.equal(login.status, 200);
  });

  test('sign-out everywhere revokes sessions', async () => {
    const u = await signUp(app);
    assert.equal((await u.get('/api/auth/me')).status, 200);
    const res = await adminSession.post(`/api/admin/users/${u.user.id}/sign-out`);
    assert.equal(res.body.data.activeSessions, 0);
    assert.equal((await u.get('/api/auth/me')).status, 401);
  });

  test('disable blocks login, sessions, calendar feed, reset; enable restores', async () => {
    const u = await signUp(app, { email: 'bad@example.com', password: 'bad actor pass 1' });
    const feed = await u.post('/api/account/calendar-token');
    const feedPath = new URL(feed.body.data.url).pathname;
    const res = await adminSession.post(`/api/admin/users/${u.user.id}/disable`);
    assert.equal(res.body.data.status, 'disabled');
    assert.equal((await u.get('/api/auth/me')).status, 401, 'session revoked');
    const login = await request(app).post('/api/auth/login').send({ email: 'bad@example.com', password: 'bad actor pass 1' });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'ACCOUNT_DISABLED');
    const wrong = await request(app).post('/api/auth/login').send({ email: 'bad@example.com', password: 'not the password' });
    assert.equal(wrong.status, 401, 'disabled status not revealed without the right password');
    assert.equal((await request(app).get(feedPath)).status, 404);
    assert.equal((await adminSession.post(`/api/admin/users/${u.user.id}/password-reset`)).status, 409);
    assert.equal((await adminSession.post(`/api/admin/users/${u.user.id}/disable`)).status, 409);
    await adminSession.post(`/api/admin/users/${u.user.id}/enable`);
    const again = await request(app).post('/api/auth/login').send({ email: 'bad@example.com', password: 'bad actor pass 1' });
    assert.equal(again.status, 200);
  });

  test('admin cannot disable or delete themselves', async () => {
    const id = adminSession.me.id;
    assert.equal((await adminSession.post(`/api/admin/users/${id}/disable`)).status, 403);
    assert.equal((await adminSession.del(`/api/admin/users/${id}`).send({ confirmEmail: ADMIN.email })).status, 403);
  });

  test('delete requires typed email confirmation; audit survives deletion', async () => {
    const u = await signUp(app, { email: 'gone@example.com' });
    await u.post('/api/items').send(sampleItem());
    const bad = await adminSession.del(`/api/admin/users/${u.user.id}`).send({ confirmEmail: 'nope@example.com' });
    assert.equal(bad.status, 422);
    const ok = await adminSession.del(`/api/admin/users/${u.user.id}`).send({ confirmEmail: 'GONE@example.com' });
    assert.equal(ok.status, 204);
    assert.equal((await adminSession.get(`/api/admin/users/${u.user.id}`)).status, 404);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM items WHERE user_id = $1', [u.user.id]);
    assert.equal(rows[0].n, 0, 'items cascade-deleted');
    const audit = await adminSession.get('/api/admin/audit');
    const entry = audit.body.data.find((a) => a.action === 'delete_user');
    assert.equal(entry.targetEmail, 'gone@example.com');
  });

  test('admin mutations require CSRF token', async () => {
    const u = await signUp(app);
    const res = await adminSession.agent.post(`/api/admin/users/${u.user.id}/unlock`).set('Origin', ORIGIN);
    assert.equal(res.status, 403);
  });
});

describe('seeding', () => {
  test('seedAdmin is idempotent, promotes, and never removes the last admin', async () => {
    const u = await signUp(app, { email: 'promote@example.com', password: 'keep this pass 1' });
    assert.deepEqual(await seedAdmin({ email: 'promote@example.com', allowPromote: false }), { action: 'refused_existing_user' });
    assert.deepEqual(await seedAdmin({ email: 'promote@example.com' }), { action: 'promoted' });
    assert.deepEqual(await seedAdmin({ email: 'promote@example.com' }), { action: 'unchanged' });
    const login = await request(app).post('/api/auth/login').send({ email: 'promote@example.com', password: 'keep this pass 1' });
    assert.equal(login.body.data.user.isAdmin, true, 'password kept on promotion');
    assert.equal((await u.get('/api/auth/me')).status, 200);

    assert.equal(await demoteAdmin('promote@example.com'), true);
    await assert.rejects(() => demoteAdmin(ADMIN.email), /last active admin/);
  });
});
