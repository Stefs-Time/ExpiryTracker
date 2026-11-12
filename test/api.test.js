import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupDb, newApp, signUp, sampleItem, pool, ORIGIN } from './helpers.js';
import { outbox } from '../src/services/mailer.js';
import { runReminderPass } from '../src/services/reminders.js';
import { todayIn, addMonths } from '../public/js/shared/expiry.js';

let app;
before(async () => {
  await setupDb();
  app = newApp();
});
after(async () => {
  await pool.end();
});

describe('health & security headers', () => {
  test('GET /healthz', async () => {
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  test('CSP and no-store on API', async () => {
    const res = await request(app).get('/api/auth/me');
    assert.equal(res.status, 401);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });

  test('serves the PWA shell', async () => {
    const res = await request(app).get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /manifest\.webmanifest/);
    const sw = await request(app).get('/sw.js');
    assert.equal(sw.headers['cache-control'], 'no-cache');
  });
});

describe('auth', () => {
  test('signup validates input', async () => {
    const res = await request(app).post('/api/auth/signup').send({ email: 'bad', password: 'short', displayName: '' });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.details.length >= 2);
  });

  test('signup → me → logout → me', async () => {
    const s = await signUp(app, { email: 'Flow@Example.com' });
    assert.equal(s.user.email, 'flow@example.com');
    const me = await s.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.displayName, 'Test User');
    assert.equal(me.body.data.user.password_hash, undefined);
    const out = await s.post('/api/auth/logout');
    assert.equal(out.status, 204);
    assert.equal((await s.get('/api/auth/me')).status, 401);
  });

  test('duplicate email → 409', async () => {
    await signUp(app, { email: 'dupe@example.com' });
    const res = await request(app).post('/api/auth/signup')
      .send({ email: 'DUPE@example.com', password: 'another password 1', displayName: 'X' });
    assert.equal(res.status, 409);
  });

  test('login success, wrong password, and lockout', async () => {
    await signUp(app, { email: 'lock@example.com', password: 'the right password' });
    const ok = await request(app).post('/api/auth/login').send({ email: 'lock@example.com', password: 'the right password' });
    assert.equal(ok.status, 200);
    assert.ok(ok.headers['set-cookie'][0].includes('HttpOnly'));
    assert.ok(/SameSite=Lax/i.test(ok.headers['set-cookie'][0]));
    for (let i = 0; i < 5; i++) {
      const bad = await request(app).post('/api/auth/login').send({ email: 'lock@example.com', password: 'wrong password!' });
      assert.equal(bad.status, 401);
    }
    const locked = await request(app).post('/api/auth/login').send({ email: 'lock@example.com', password: 'the right password' });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
  });

  test('unknown email gives the same error as a wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'whatever pass' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, 'Incorrect email or password');
  });

  test('password reset flow is single-use and signs out other sessions', async () => {
    const s = await signUp(app, { email: 'reset@example.com' });
    outbox.length = 0;
    const r1 = await request(app).post('/api/auth/forgot').send({ email: 'reset@example.com' });
    assert.equal(r1.status, 202);
    const r2 = await request(app).post('/api/auth/forgot').send({ email: 'missing@example.com' });
    assert.equal(r2.status, 202);
    assert.deepEqual(r1.body, r2.body); // no account enumeration
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(outbox.length, 1);
    const token = decodeURIComponent(/token=([^\s"&]+)/.exec(outbox[0].text)[1]);

    const reset = await request(app).post('/api/auth/reset').send({ token, password: 'brand new password' });
    assert.equal(reset.status, 200);
    assert.equal((await s.get('/api/auth/me')).status, 401, 'old session revoked');
    const again = await request(app).post('/api/auth/reset').send({ token, password: 'another new password' });
    assert.equal(again.status, 400);
    const login = await request(app).post('/api/auth/login').send({ email: 'reset@example.com', password: 'brand new password' });
    assert.equal(login.status, 200);
  });
});

describe('CSRF protections', () => {
  test('authenticated mutation without token → 403', async () => {
    const s = await signUp(app);
    const res = await s.agent.post('/api/items').send(sampleItem());
    assert.equal(res.status, 403);
  });

  test('cross-site Origin → 403', async () => {
    const s = await signUp(app);
    const res = await s.agent.post('/api/items').set('Origin', 'https://evil.example').set('X-CSRF-Token', s.csrf).send(sampleItem());
    assert.equal(res.status, 403);
  });

  test('form-encoded body → 415', async () => {
    const s = await signUp(app);
    const res = await s.agent.post('/api/items').set('X-CSRF-Token', s.csrf).type('form').send('title=x');
    assert.equal(res.status, 415);
  });

  test('Sec-Fetch-Site cross-site → 403', async () => {
    const res = await request(app).post('/api/auth/login').set('Sec-Fetch-Site', 'cross-site').send({ email: 'a@b.co', password: 'x' });
    assert.equal(res.status, 403);
  });
});

describe('items', () => {
  test('CRUD with ownership isolation', async () => {
    const a = await signUp(app);
    const b = await signUp(app);
    const created = await a.post('/api/items').send(sampleItem());
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    assert.equal(created.body.data.expiryDate, '2030-12-04');

    assert.equal((await b.get(`/api/items/${id}`)).status, 404, 'other user cannot read');
    assert.equal((await b.patch(`/api/items/${id}`).send({ title: 'pwn' })).status, 404, 'other user cannot update');
    assert.equal((await b.del(`/api/items/${id}`)).status, 404, 'other user cannot delete');

    const upd = await a.patch(`/api/items/${id}`).send({ title: 'Updated', expiryDate: '2031-01-31' });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.data.title, 'Updated');
    assert.equal(upd.body.data.expiryDate, '2031-01-31');

    const list = await a.get('/api/items');
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.meta.total, 1);
    assert.equal((await b.get('/api/items')).body.data.length, 0);

    assert.equal((await a.del(`/api/items/${id}`)).status, 204);
    assert.equal((await a.get(`/api/items/${id}`)).status, 404);
  });

  test('validation: bad date, unknown category, full card number, extra fields', async () => {
    const s = await signUp(app);
    assert.equal((await s.post('/api/items').send(sampleItem({ expiryDate: '2026-02-30' }))).status, 422);
    assert.equal((await s.post('/api/items').send(sampleItem({ category: 'Boats' }))).status, 422);
    const card = await s.post('/api/items').send(sampleItem({ ref: '4111 1111 1111 1111' }));
    assert.equal(card.status, 422);
    assert.match(card.body.error.message, /masked/i);
    assert.equal((await s.post('/api/items').send(sampleItem({ user_id: 'x' }))).status, 422);
    assert.equal((await s.get('/api/items/not-a-uuid')).status, 422);
  });

  test('stored XSS payloads are returned verbatim as JSON data (escaped by the client)', async () => {
    const s = await signUp(app);
    const res = await s.post('/api/items').send(sampleItem({ title: '<img src=x onerror=alert(1)>' }));
    assert.equal(res.status, 201);
    assert.equal(res.headers['content-type'].startsWith('application/json'), true);
  });

  test('filters: search, category, status', async () => {
    const s = await signUp(app);
    const today = todayIn('Africa/Johannesburg');
    await s.post('/api/items').send(sampleItem({ title: 'Disc', category: 'Vehicle', expiryDate: addMonths(today, -1) }));
    await s.post('/api/items').send(sampleItem({ title: 'Card', category: 'Banking', expiryDate: addMonths(today, 2) }));
    await s.post('/api/items').send(sampleItem({ title: 'Passport 100%_', category: 'Identity', expiryDate: addMonths(today, 60) }));
    const st = async (q) => (await s.get(`/api/items?${q}`)).body.data.map((i) => i.title);
    assert.deepEqual(await st('status=critical'), ['Disc']);
    assert.deepEqual(await st('status=soon'), ['Card']);
    assert.deepEqual(await st('status=valid'), ['Passport 100%_']);
    assert.deepEqual(await st('category=Banking'), ['Card']);
    assert.deepEqual(await st('q=pass'), ['Passport 100%_']);
    assert.deepEqual(await st('q=%25'), ['Passport 100%_'], 'LIKE wildcards are escaped');
    assert.equal((await s.get('/api/items?limit=1')).body.meta.totalPages, 3);
    assert.equal((await s.get('/api/items?limit=9999')).status, 422);
  });

  test('renew: default suggestion, explicit date, history', async () => {
    const s = await signUp(app);
    const today = todayIn('Africa/Johannesburg');
    const lapsed = addMonths(today, -2);
    const { body } = await s.post('/api/items').send(sampleItem({ expiryDate: lapsed, cycleMonths: 12 }));
    const id = body.data.id;
    const r1 = await s.post(`/api/items/${id}/renew`).send({});
    assert.equal(r1.status, 200);
    assert.equal(r1.body.data.expiryDate, addMonths(today, 12), 'lapsed item renews from today');
    const r2 = await s.post(`/api/items/${id}/renew`).send({ newExpiryDate: '2035-05-05' });
    assert.equal(r2.body.data.expiryDate, '2035-05-05');
    const hist = await s.get(`/api/items/${id}/renewals`);
    assert.equal(hist.body.data.length, 2);
    assert.equal(hist.body.data[0].previousExpiry, addMonths(today, 12));
  });

  test('import skips duplicates', async () => {
    const s = await signUp(app);
    const items = [sampleItem({ title: 'One' }), sampleItem({ title: 'Two' })];
    const r1 = await s.post('/api/items/import').send({ items });
    assert.deepEqual(r1.body.data, { imported: 2, skipped: 0 });
    const r2 = await s.post('/api/items/import').send({ items: [...items, sampleItem({ title: 'Three' })] });
    assert.deepEqual(r2.body.data, { imported: 1, skipped: 2 });
  });
});

describe('reports & calendar', () => {
  test('status JSON, CSV (formula-safe), text, ICS', async () => {
    const s = await signUp(app);
    await s.post('/api/items').send(sampleItem({ title: '=HYPERLINK("http://x")', expiryDate: '2030-01-15' }));
    const json = await s.get('/api/reports/status');
    assert.equal(json.body.data.counts.total, 1);
    const csv = await s.get('/api/reports/status.csv');
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.text, /"'=HYPERLINK\(""http:\/\/x""\)"/);
    const txt = await s.get('/api/reports/status.txt');
    assert.match(txt.text, /VAULTEXPIRY STATUS REPORT/);
    const ics = await s.get('/api/reports/calendar.ics');
    assert.match(ics.text, /BEGIN:VCALENDAR/);
    assert.match(ics.text, /DTSTART;VALUE=DATE:20300115/);
    assert.match(ics.text, /TRIGGER:-P59DT15H/); // lead 60 days at 09:00
    assert.ok(ics.text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines folded');
  });

  test('private calendar feed token: create, use, rotate, revoke', async () => {
    const s = await signUp(app);
    await s.post('/api/items').send(sampleItem());
    const c1 = await s.post('/api/account/calendar-token');
    assert.equal(c1.status, 201);
    const path1 = new URL(c1.body.data.url).pathname;
    const feed = await request(app).get(path1);
    assert.equal(feed.status, 200);
    assert.match(feed.text, /Expires: Driver/);
    const c2 = await s.post('/api/account/calendar-token');
    assert.equal((await request(app).get(path1)).status, 404, 'old link stops working');
    await s.del('/api/account/calendar-token');
    assert.equal((await request(app).get(new URL(c2.body.data.url).pathname)).status, 404);
  });
});

describe('account', () => {
  test('settings update + threshold validation', async () => {
    const s = await signUp(app);
    const ok = await s.patch('/api/account').send({ criticalDays: 14, warningDays: 60, timezone: 'Europe/London' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.criticalDays, 14);
    assert.equal((await s.patch('/api/account').send({ criticalDays: 60, warningDays: 30 })).status, 422);
    assert.equal((await s.patch('/api/account').send({ timezone: 'Mars/Base' })).status, 422);
    assert.equal((await s.patch('/api/account').send({ email: 'x@y.z' })).status, 422, 'email not changeable here');
  });

  test('change password keeps this session, revokes others', async () => {
    const s = await signUp(app, { email: 'pw@example.com', password: 'first password 1' });
    const other = request.agent(app);
    await other.post('/api/auth/login').send({ email: 'pw@example.com', password: 'first password 1' });
    assert.equal((await other.get('/api/auth/me')).status, 200);
    const bad = await s.post('/api/account/password').send({ currentPassword: 'nope', newPassword: 'second password 2' });
    assert.equal(bad.status, 401);
    const res = await s.post('/api/account/password').send({ currentPassword: 'first password 1', newPassword: 'second password 2' });
    assert.equal(res.status, 200);
    assert.equal((await s.get('/api/auth/me')).status, 200, 'current session kept');
    assert.equal((await other.get('/api/auth/me')).status, 401, 'other session revoked');
  });

  test('export and delete account', async () => {
    const s = await signUp(app);
    await s.post('/api/items').send(sampleItem());
    const exp = await s.get('/api/account/export');
    assert.equal(exp.body.items.length, 1);
    assert.equal((await s.del('/api/account').send({ password: 'wrong' })).status, 401);
    const del = await s.del('/api/account').send({ password: s.password });
    assert.equal(del.status, 204);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [s.user.id]);
    assert.equal(rows[0].n, 0);
  });
});

describe('reminders', () => {
  test('sends one digest per stage and never duplicates', async () => {
    const s = await signUp(app, { email: 'remind@example.com' });
    const today = todayIn('Africa/Johannesburg');
    const soonDate = addMonths(today, 1); // ~30 days: critical stage
    await s.post('/api/items').send(sampleItem({ title: 'Disc', expiryDate: soonDate, leadDays: 30 }));
    await s.post('/api/items').send(sampleItem({ title: 'Far away', expiryDate: addMonths(today, 36) }));
    outbox.length = 0;
    const noon = new Date(`${today}T10:00:00Z`); // 12:00 SAST
    await runReminderPass(noon);
    const mine = outbox.filter((m) => m.to === 'remind@example.com');
    assert.equal(mine.length, 1);
    assert.match(mine[0].text, /Disc/);
    assert.doesNotMatch(mine[0].text, /Far away/);
    await runReminderPass(noon);
    assert.equal(outbox.filter((m) => m.to === 'remind@example.com').length, 1, 'no duplicate');

    await s.patch('/api/account').send({ emailReminders: false });
    const { body } = await s.post('/api/items').send(sampleItem({ title: 'Other', expiryDate: addMonths(today, 2) }));
    assert.ok(body.data.id);
    await runReminderPass(noon);
    assert.equal(outbox.filter((m) => m.to === 'remind@example.com').length, 1, 'opt-out respected');
  });
});

test('origin check allows same origin', async () => {
  const res = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'x@y.co', password: 'abcdefghijk' });
  assert.equal(res.status, 401);
});
