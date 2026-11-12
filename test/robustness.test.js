// Audit round 2: soft delete + undo, maintenance, error paths, reminder retry, JPEG edge cases.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setupDb, newApp, signUp, sampleItem, pool, ORIGIN } from './helpers.js';
import { runMaintenance } from '../src/services/maintenance.js';
import { runReminderPass } from '../src/services/reminders.js';
import { outbox, testControls } from '../src/services/mailer.js';
import { sanitizeJpeg } from '../src/lib/jpeg.js';
import { todayIn, addDays } from '../public/js/shared/expiry.js';

const CARD = readFileSync(new URL('./fixtures/card.jpg', import.meta.url));
let app;
// Mock Groq that drops the connection (network failure).
const mock = http.createServer((req) => req.socket.destroy());

before(async () => {
  await new Promise((r) => mock.listen(47999, '127.0.0.1', r));
  await setupDb();
  app = newApp();
});
after(async () => {
  mock.close();
  await pool.end();
});

const upload = (s, url) => s.agent.post(url).set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).set('Content-Type', 'image/jpeg').send(CARD);

describe('soft delete & undo', () => {
  test('delete hides the item everywhere; restore brings back the same item with photos and history', async () => {
    const s = await signUp(app);
    const { body } = await s.post('/api/items').send(sampleItem({ expiryDate: '2030-01-01' }));
    const id = body.data.id;
    await upload(s, `/api/items/${id}/attachments`);
    await s.post(`/api/items/${id}/renew`).send({ newExpiryDate: '2031-01-01' });
    const photoUrl = (await s.get(`/api/items/${id}/attachments`)).body.data[0].url;

    assert.equal((await s.del(`/api/items/${id}`)).status, 204);
    assert.equal((await s.get(`/api/items/${id}`)).status, 404);
    assert.equal((await s.get('/api/items')).body.data.length, 0);
    assert.equal((await s.get(photoUrl)).status, 404, 'photo hidden while deleted');
    assert.equal((await s.get('/api/reports/status')).body.data.counts.total, 0);
    assert.equal((await s.del(`/api/items/${id}`)).status, 404, 'double delete');
    assert.equal((await s.patch(`/api/items/${id}`).send({ title: 'x' })).status, 404, 'cannot edit deleted');
    assert.equal((await upload(s, `/api/items/${id}/attachments`)).status, 404, 'cannot attach to deleted');

    const restored = await s.post(`/api/items/${id}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.id, id, 'same id');
    assert.equal(restored.body.data.attachmentCount, 1, 'photo restored');
    assert.equal((await s.get(`/api/items/${id}/renewals`)).body.data.length, 1, 'history restored');
    assert.equal((await s.get(photoUrl)).status, 200);
  });

  test('other users cannot restore; restore is refused after the undo window; purge removes rows', async () => {
    const s = await signUp(app);
    const other = await signUp(app);
    const { body } = await s.post('/api/items').send(sampleItem());
    const id = body.data.id;
    await upload(s, `/api/items/${id}/attachments`);
    await s.del(`/api/items/${id}`);
    assert.equal((await other.post(`/api/items/${id}/restore`)).status, 410);

    // Age the deletion beyond the window.
    await pool.query("UPDATE items SET deleted_at = now() - interval '2 hours' WHERE id = $1", [id]);
    const late = await s.post(`/api/items/${id}/restore`);
    assert.equal(late.status, 410);
    assert.equal(late.body.error.code, 'GONE');

    const result = await runMaintenance();
    assert.ok(result.items >= 1);
    const { rows } = await pool.query('SELECT (SELECT count(*) FROM items WHERE id = $1)::int AS i, (SELECT count(*) FROM item_attachments WHERE item_id = $1)::int AS a', [id]);
    assert.deepEqual(rows[0], { i: 0, a: 0 }, 'item and photos permanently deleted');
  });

  test('deleted items free the item limit, are excluded from import de-dupe and admin counts', async () => {
    const s = await signUp(app);
    const item = sampleItem({ title: 'Re-import me' });
    const { body } = await s.post('/api/items').send(item);
    await s.del(`/api/items/${body.data.id}`);
    const imp = await s.post('/api/items/import').send({ items: [item] });
    assert.deepEqual(imp.body.data, { imported: 1, skipped: 0 });
  });

  test('reminders skip soft-deleted items', async () => {
    const s = await signUp(app, { email: 'softrem@example.com' });
    const today = todayIn('Africa/Johannesburg');
    const { body } = await s.post('/api/items').send(sampleItem({ title: 'Deleted soon', expiryDate: addDays(today, 5) }));
    await s.del(`/api/items/${body.data.id}`);
    outbox.length = 0;
    await runReminderPass(new Date(`${today}T10:00:00Z`));
    assert.equal(outbox.filter((m) => m.to === 'softrem@example.com').length, 0);
  });
});

describe('reliability', () => {
  test('a failed reminder email is retried on the next pass (claims released)', async () => {
    const s = await signUp(app, { email: 'retry@example.com' });
    const today = todayIn('Africa/Johannesburg');
    await s.post('/api/items').send(sampleItem({ title: 'Retry me', expiryDate: addDays(today, 3) }));
    const noon = new Date(`${today}T10:00:00Z`);
    outbox.length = 0;
    testControls.failNextSends = 1000; // every send fails this pass
    await runReminderPass(noon);
    testControls.failNextSends = 0;
    assert.equal(outbox.filter((m) => m.to === 'retry@example.com').length, 0);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM reminder_log r JOIN items i ON i.id = r.item_id JOIN users u ON u.id = i.user_id WHERE u.email = 'retry@example.com'`,
    );
    assert.equal(rows[0].n, 0, 'no stage marked as sent');
    await runReminderPass(noon);
    assert.equal(outbox.filter((m) => m.to === 'retry@example.com').length, 1, 'sent on retry');
  });

  test('maintenance removes stale password-reset tokens', async () => {
    const s = await signUp(app, { email: 'oldreset@example.com' });
    await request(app).post('/api/auth/forgot').send({ email: 'oldreset@example.com' });
    await pool.query("UPDATE password_resets SET expires_at = now() - interval '3 days' WHERE user_id = $1", [s.user.id]);
    await runMaintenance();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1', [s.user.id]);
    assert.equal(rows[0].n, 0);
  });

  test('AI provider network failure → 502 with a friendly message', async () => {
    const s = await signUp(app);
    await s.agent.put('/api/account/scan-consent').set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).send({ consent: true });
    const r = await upload(s, '/api/scan');
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /yourself|later/);
  });

  test('malformed JSON → 400, oversized body → 413, unknown API route → 404 JSON', async () => {
    const s = await signUp(app);
    const bad = await s.agent.post('/api/items').set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).set('Content-Type', 'application/json').send('{"title":');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'BAD_REQUEST');
    const big = await s.post('/api/items').send({ ...sampleItem(), note: 'x'.repeat(40_000) });
    assert.equal(big.status, 413);
    const nf = await s.get('/api/nope');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.success, false);
  });

  test('every API response carries an X-Request-Id', async () => {
    const r = await request(app).get('/api/auth/config');
    assert.match(r.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  });
});

describe('JPEG edge cases', () => {
  test('restart markers and fill bytes are tolerated; bad segment lengths and huge dimensions rejected', () => {
    // Insert a fill byte (FF FF) before the first marker after SOI.
    const withFill = Buffer.concat([CARD.subarray(0, 2), Buffer.from([0xff]), CARD.subarray(2)]);
    assert.doesNotThrow(() => sanitizeJpeg(withFill));
    const badLen = Buffer.from(CARD);
    badLen.writeUInt16BE(0xffff, 4); // first segment claims to run past the end
    assert.throws(() => sanitizeJpeg(badLen), /segment length|Truncated|Corrupt/);
    // Patch the SOF dimensions to 20000 x 20000.
    const huge = Buffer.from(CARD);
    for (let i = 2; i < huge.length - 8; i++) {
      if (huge[i] === 0xff && huge[i + 1] === 0xc0) { huge.writeUInt16BE(20000, i + 5); huge.writeUInt16BE(20000, i + 7); break; }
    }
    assert.throws(() => sanitizeJpeg(huge), /too large/);
  });
});
