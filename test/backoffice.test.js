// Back-office features: invites, support notes, audit filters/reasons, CSV exports, system status, notifications.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDb, newApp, signUp, sampleItem, pool, ORIGIN } from './helpers.js';
import { seedAdmin } from '../src/services/admin.js';
import { outbox } from '../src/services/mailer.js';

let app;
let admin;
const ADMIN = { email: 'office@example.com', password: 'back office pass 1' };

async function loginAs(email, password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const csrf = res.body.data.csrfToken;
  const send = (m) => (url) => agent[m](url).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return { agent, me: res.body.data.user, get: (u) => agent.get(u), post: send('post'), del: send('delete') };
}

before(async () => {
  await setupDb();
  app = newApp();
  await seedAdmin({ ...ADMIN, displayName: 'Office' });
  admin = await loginAs(ADMIN.email, ADMIN.password);
});
after(async () => {
  await pool.end();
});

describe('invite user', () => {
  test('creates an invited account, emails a set-password link, user completes sign-up', async () => {
    outbox.length = 0;
    const res = await admin.post('/api/admin/users').send({ email: 'New.Hire@Example.com', displayName: 'New Hire' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.emailed, true);
    assert.equal(res.body.data.link, undefined, 'link is not shown to the admin when email is available');
    assert.equal(res.body.data.user.status, 'invited');
    assert.equal(res.body.data.user.email, 'new.hire@example.com');
    assert.equal(outbox.length, 1);
    assert.match(outbox[0].subject, /invited/i);

    // Invited accounts cannot sign in until they choose a password.
    const early = await request(app).post('/api/auth/login').send({ email: 'new.hire@example.com', password: 'anything at all' });
    assert.equal(early.status, 401);

    const token = decodeURIComponent(/token=([^\s"&]+)/.exec(outbox[0].text)[1]);
    const done = await request(app).post('/api/auth/reset').send({ token, password: 'my own password 1' });
    assert.equal(done.status, 200);
    const after = await admin.get(`/api/admin/users/${res.body.data.user.id}`);
    assert.equal(after.body.data.status, 'active', 'no longer "invited" after first sign-in');

    const audit = await admin.get('/api/admin/audit?action=invite_email');
    assert.equal(audit.body.data[0].targetEmail, 'new.hire@example.com');
  });

  test('duplicate email → 409; validation; filter by invited; non-admin → 403', async () => {
    await admin.post('/api/admin/users').send({ email: 'pending@example.com', displayName: 'Pending' });
    assert.equal((await admin.post('/api/admin/users').send({ email: 'pending@example.com', displayName: 'Again' })).status, 409);
    assert.equal((await admin.post('/api/admin/users').send({ email: 'nope', displayName: '' })).status, 422);
    const invited = await admin.get('/api/admin/users?status=invited');
    assert.deepEqual(invited.body.data.map((u) => u.email), ['pending@example.com']);
    assert.ok((await admin.get('/api/admin/stats')).body.data.invited >= 1);
    const user = await signUp(app);
    assert.equal((await user.post('/api/admin/users').send({ email: 'x@example.com', displayName: 'X' })).status, 403);
  });
});

describe('user detail and support notes', () => {
  test('detail returns account, notes and activity — never item contents', async () => {
    const u = await signUp(app, { email: 'detail@example.com' });
    await u.post('/api/items').send(sampleItem({ title: 'TOP-SECRET-TITLE', note: 'TOP-SECRET-NOTE' }));
    const note = await admin.post(`/api/admin/users/${u.user.id}/notes`).send({ body: 'Called about a locked account.' });
    assert.equal(note.status, 201);
    assert.equal(note.body.data.adminEmail, ADMIN.email);
    await admin.post(`/api/admin/users/${u.user.id}/sign-out`);

    const detail = await admin.get(`/api/admin/users/${u.user.id}/detail`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.user.itemCount, 1);
    assert.equal(detail.body.data.user.noteCount, 1);
    assert.equal(detail.body.data.notes[0].body, 'Called about a locked account.');
    assert.equal(detail.body.data.activity[0].action, 'revoke_sessions');
    assert.ok(!JSON.stringify(detail.body).includes('TOP-SECRET'), 'no item contents');

    // The user themselves can never see notes about them.
    const fresh = await signUp(app);
    assert.equal((await fresh.get(`/api/admin/users/${u.user.id}/detail`)).status, 403);
    assert.ok(!JSON.stringify((await fresh.get('/api/account')).body).includes('Called about'));

    assert.equal((await admin.del(`/api/admin/users/${u.user.id}/notes/${note.body.data.id}`)).status, 204);
    assert.equal((await admin.del(`/api/admin/users/${u.user.id}/notes/${note.body.data.id}`)).status, 404);
    assert.equal((await admin.post(`/api/admin/users/${u.user.id}/notes`).send({ body: '   ' })).status, 422);
    assert.equal((await admin.post('/api/admin/users/00000000-0000-4000-8000-000000000000/notes').send({ body: 'x' })).status, 404);
  });
});

describe('audit log', () => {
  test('reason is stored; filter by action and search; pagination meta', async () => {
    const u = await signUp(app, { email: 'reasoned@example.com' });
    const dis = await admin.post(`/api/admin/users/${u.user.id}/disable`).send({ reason: 'Chargeback dispute #4411' });
    assert.equal(dis.status, 200);
    await admin.post(`/api/admin/users/${u.user.id}/enable`);

    const byAction = await admin.get('/api/admin/audit?action=disable');
    assert.ok(byAction.body.data.every((e) => e.action === 'disable'));
    assert.equal(byAction.body.data[0].reason, 'Chargeback dispute #4411');

    const bySearch = await admin.get('/api/admin/audit?q=chargeback');
    assert.equal(bySearch.body.data.length, 1);
    const byUser = await admin.get(`/api/admin/audit?userId=${u.user.id}&limit=1`);
    assert.equal(byUser.body.meta.total, 2);
    assert.equal(byUser.body.meta.totalPages, 2);
    assert.equal((await admin.get('/api/admin/audit?action=made_up')).status, 422);
    assert.equal((await admin.post(`/api/admin/users/${u.user.id}/disable`).send({ reason: 'x'.repeat(301) })).status, 422);
  });

  test('users are told by email when an admin disables, re-enables or deletes their account', async () => {
    const u = await signUp(app, { email: 'told@example.com' });
    outbox.length = 0;
    await admin.post(`/api/admin/users/${u.user.id}/disable`).send({ reason: 'internal reason, not for the user' });
    await admin.post(`/api/admin/users/${u.user.id}/enable`);
    await admin.del(`/api/admin/users/${u.user.id}`).send({ confirmEmail: 'told@example.com', reason: 'Requested by phone' });
    await new Promise((r) => setTimeout(r, 50));
    const mine = outbox.filter((m) => m.to === 'told@example.com');
    assert.deepEqual(mine.map((m) => m.subject), [
      'Your VaultExpiry account has been disabled',
      'Your VaultExpiry account has been re-enabled',
      'Your VaultExpiry account has been deleted',
    ]);
    assert.ok(!mine.some((m) => m.text.includes('internal reason')), 'internal reasons are never emailed');
    const del = await admin.get('/api/admin/audit?action=delete_user&q=told@example.com');
    assert.equal(del.body.data[0].reason, 'Requested by phone');
  });
});

describe('exports', () => {
  test('users.csv respects filters and is formula-safe; audit.csv includes reasons', async () => {
    await signUp(app, { email: 'csv@example.com', displayName: '=HYPERLINK("http://evil")' });
    const csv = await admin.get('/api/admin/users.csv?q=csv@example.com');
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /vaultexpiry-users-\d{4}-\d{2}-\d{2}\.csv/);
    assert.equal(csv.text.charCodeAt(0), 0xfeff, 'UTF-8 BOM so Excel detects the encoding');
    const lines = csv.text.slice(1).trim().split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Name,Email,Role,Status/);
    assert.match(lines[1], /^"'=HYPERLINK/);
    const audit = await admin.get('/api/admin/audit.csv?action=disable');
    assert.match(audit.text, /Chargeback dispute #4411/);
    const user = await signUp(app);
    assert.equal((await user.get('/api/admin/users.csv')).status, 403);
    assert.equal((await user.get('/api/admin/audit.csv')).status, 403);
  });

  test('sorting by name and last sign-in', async () => {
    const asc = await admin.get('/api/admin/users?sort=name&limit=200');
    const names = asc.body.data.map((u) => u.displayName.toLowerCase());
    assert.ok(names.length >= 3);
    const desc = await admin.get('/api/admin/users?sort=-name&limit=200');
    assert.equal(desc.body.data[0].displayName.toLowerCase(), names[names.length - 1]);
    assert.equal((await admin.get('/api/admin/users?sort=password_hash')).status, 422);
  });
});

describe('system status', () => {
  test('reports flags, job state and warnings — no secrets', async () => {
    const res = await admin.get('/api/admin/system');
    assert.equal(res.status, 200);
    const s = res.body.data;
    assert.equal(s.database.ok, true);
    assert.equal(s.features.scanEnabled, true);
    assert.equal(s.features.scanModel, 'test-vision-model');
    assert.match(s.version, /^\d+\.\d+\.\d+$/);
    assert.ok(s.warnings.some((w) => /SMTP/.test(w)));
    const blob = JSON.stringify(res.body);
    for (const secret of [process.env.SESSION_SECRET, process.env.FILE_ENCRYPTION_KEY, process.env.GROQ_API_KEY, 'postgres://']) {
      assert.ok(!blob.includes(secret), 'no secrets in system status');
    }
    const user = await signUp(app);
    assert.equal((await user.get('/api/admin/system')).status, 403);
  });
});
