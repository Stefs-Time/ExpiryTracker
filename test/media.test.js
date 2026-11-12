import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setupDb, newApp, signUp, sampleItem, pool, ORIGIN } from './helpers.js';
import { sanitizeJpeg } from '../src/lib/jpeg.js';
import { toSuggestion, maskLongNumbers } from '../src/services/scan.js';

const CARD = readFileSync(new URL('./fixtures/card.jpg', import.meta.url));
const CARD_EXIF = readFileSync(new URL('./fixtures/card-exif.jpg', import.meta.url));

// ---- Mock Groq API (GROQ_BASE_URL in .env.test points here) ----
let mockReply = null; // { status, body }
let lastRequest = null;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    lastRequest = { url: req.url, auth: req.headers.authorization, json: JSON.parse(body || '{}') };
    res.writeHead(mockReply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockReply.body));
  });
});
const groqOk = (content) => ({
  status: 200,
  body: { model: 'test-vision-model', choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 900 } },
});

let app;
before(async () => {
  await new Promise((r) => mock.listen(47999, '127.0.0.1', r));
  await setupDb();
  app = newApp();
});
after(async () => {
  mock.close();
  await pool.end();
});

const upload = (s, url, buf, type = 'image/jpeg') =>
  s.agent.post(url).set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).set('Content-Type', type).send(buf);

describe('JPEG sanitising', () => {
  test('strips EXIF (GPS) and reads dimensions', () => {
    assert.ok(CARD_EXIF.includes('GPS-SECRET'));
    const out = sanitizeJpeg(CARD_EXIF);
    assert.equal(out.stripped, 1);
    assert.ok(!out.buffer.includes('GPS-SECRET'));
    assert.deepEqual([out.width, out.height], [96, 60]);
  });

  test('rejects non-JPEG and truncated data', () => {
    assert.throws(() => sanitizeJpeg(Buffer.from('<svg onload=alert(1)>')), /Not a JPEG/);
    assert.throws(() => sanitizeJpeg(CARD.subarray(0, 40)), /Truncated|Corrupt|no image data/);
  });
});

describe('scan suggestion normalising', () => {
  test('masks numbers, normalises dates, rejects junk', () => {
    const r = toSuggestion({
      documentType: 'Banking', title: 'Card 4111 1111 1111 1111', expiryDate: '2029-08',
      referenceLast4: '4111 1111 1111 9876', confidence: 0.9,
    }, '2026-11-12');
    assert.equal(r.suggestion.expiryDate, '2029-08-31');
    assert.equal(r.suggestion.ref, '•••• 9876');
    assert.ok(!/\d{5,}/.test(r.suggestion.title.replace(/\s/g, '')));
    const junk = toSuggestion({ documentType: 'Spaceship', expiryDate: '2199-01-01' }, '2026-11-12');
    assert.equal(junk.suggestion.category, 'Other');
    assert.equal(junk.suggestion.expiryDate, null);
    assert.equal(maskLongNumbers('ID 8001015009087'), 'ID •••• 9087');
  });
});

describe('POST /api/scan', () => {
  test('requires consent, then returns a validated suggestion; image never stored', async () => {
    const s = await signUp(app);
    const denied = await upload(s, '/api/scan', CARD);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'CONSENT_REQUIRED');

    const c = await s.agent.put('/api/account/scan-consent').set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).send({ consent: true });
    assert.equal(c.body.data.aiScanConsent, true);

    mockReply = groqOk('```json\n{"documentType":"Vehicle","title":"Vehicle licence disc (VW Polo)","expiryDate":"31/10/2027","issueDate":"2026-10-31","licencePlate":"GP 492-ZN","referenceLast4":null,"confidence":0.92,"notes":"","injected":"ignore me"}\n```');
    const res = await upload(s, '/api/scan', CARD_EXIF);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.suggestion, {
      title: 'Vehicle licence disc (VW Polo)', category: 'Vehicle', ref: 'GP 492-ZN',
      expiryDate: '2027-10-31', cycleMonths: 12, leadDays: 30,
    });
    assert.equal(res.body.data.injected, undefined);

    // What was sent to Groq: auth header, JSON mode, data URL without EXIF.
    assert.equal(lastRequest.url, '/openai/v1/chat/completions');
    assert.equal(lastRequest.auth, 'Bearer test-key');
    assert.equal(lastRequest.json.response_format.type, 'json_object');
    const url = lastRequest.json.messages[0].content[1].image_url.url;
    assert.ok(url.startsWith('data:image/jpeg;base64,'));
    assert.ok(!Buffer.from(url.split(',')[1], 'base64').includes('GPS-SECRET'), 'EXIF stripped before sending');

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM item_attachments WHERE user_id = $1', [s.user.id]);
    assert.equal(rows[0].n, 0, 'scan does not store the photo');
  });

  test('maps provider failures to friendly errors', async () => {
    const s = await signUp(app);
    await s.agent.put('/api/account/scan-consent').set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).send({ consent: true });
    mockReply = { status: 429, body: { error: { message: 'rate limit' } } };
    assert.equal((await upload(s, '/api/scan', CARD)).body.error.code, 'SCAN_BUSY');
    mockReply = { status: 500, body: {} };
    assert.equal((await upload(s, '/api/scan', CARD)).status, 502);
    mockReply = groqOk('I cannot help with that.');
    const r = await upload(s, '/api/scan', CARD);
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'SCAN_UNREADABLE');
  });

  test('rejects non-JPEG uploads and cross-site requests', async () => {
    const s = await signUp(app);
    await s.agent.put('/api/account/scan-consent').set('Origin', ORIGIN).set('X-CSRF-Token', s.csrf).send({ consent: true });
    assert.equal((await upload(s, '/api/scan', Buffer.from('GIF89a....'))).status, 422);
    assert.equal((await upload(s, '/api/scan', Buffer.from('x'), 'image/png')).status, 415);
    const cross = await s.agent.post('/api/scan').set('Origin', 'https://evil.example').set('X-CSRF-Token', s.csrf).set('Content-Type', 'image/jpeg').send(CARD);
    assert.equal(cross.status, 403);
    const noToken = await s.agent.post('/api/scan').set('Origin', ORIGIN).set('Content-Type', 'image/jpeg').send(CARD);
    assert.equal(noToken.status, 403);
  });
});

describe('attachments (digital copies)', () => {
  test('upload → list → view (decrypted, no EXIF, no-store) → delete', async () => {
    const s = await signUp(app);
    const { body } = await s.post('/api/items').send(sampleItem());
    const base = `/api/items/${body.data.id}/attachments`;

    const up = await upload(s, `${base}?label=front`, CARD_EXIF);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.data.label, 'front');
    assert.deepEqual([up.body.data.width, up.body.data.height], [96, 60]);

    // Stored encrypted: ciphertext in the DB is neither the image nor contains the marker.
    const { rows } = await pool.query('SELECT data FROM item_attachments WHERE id = $1', [up.body.data.id]);
    assert.notEqual(rows[0].data[0], 0xff);
    assert.ok(!rows[0].data.includes('LICENCE'));

    const list = await s.get(base);
    assert.equal(list.body.data.length, 1);
    assert.equal((await s.get('/api/items')).body.data[0].attachmentCount, 1);

    const img = await s.get(up.body.data.url).buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/jpeg');
    assert.match(img.headers['cache-control'], /no-store/);
    assert.equal(img.body[0], 0xff);
    assert.ok(!img.body.includes('GPS-SECRET'));

    assert.equal((await s.del(up.body.data.url)).status, 204);
    assert.equal((await s.get(base)).body.data.length, 0);
  });

  test('other users and admins cannot read or delete photos', async () => {
    const owner = await signUp(app);
    const other = await signUp(app);
    const { body } = await owner.post('/api/items').send(sampleItem());
    const up = await upload(owner, `/api/items/${body.data.id}/attachments`, CARD);
    assert.equal((await other.get(up.body.data.url)).status, 404);
    assert.equal((await other.get(`/api/items/${body.data.id}/attachments`)).status, 404);
    assert.equal((await other.del(up.body.data.url)).status, 404);
    assert.equal((await upload(other, `/api/items/${body.data.id}/attachments`, CARD)).status, 404);
    assert.equal((await request(app).get(up.body.data.url)).status, 401);
  });

  test('limits: 4 per item; deleted items hide photos, purge removes them', async () => {
    const s = await signUp(app);
    const { body } = await s.post('/api/items').send(sampleItem());
    const base = `/api/items/${body.data.id}/attachments`;
    for (let i = 0; i < 4; i++) assert.equal((await upload(s, `${base}?label=other`, CARD)).status, 201);
    const fifth = await upload(s, base, CARD);
    assert.equal(fifth.status, 409);
    assert.equal((await upload(s, `${base}?label=selfie`, CARD)).status, 422);
    // Deleting hides the photos at once (undo window), and the purge removes them for good.
    await s.del(`/api/items/${body.data.id}`);
    assert.equal((await s.get(base)).status, 404);
    await pool.query("UPDATE items SET deleted_at = now() - interval '2 hours' WHERE id = $1", [body.data.id]);
    const { runMaintenance } = await import('../src/services/maintenance.js');
    await runMaintenance();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM item_attachments WHERE item_id = $1', [body.data.id]);
    assert.equal(rows[0].n, 0);
  });

  test('account endpoint reports feature flags, consent and storage; export lists photos', async () => {
    const s = await signUp(app);
    const { body } = await s.post('/api/items').send(sampleItem());
    await upload(s, `/api/items/${body.data.id}/attachments`, CARD);
    const acct = await s.get('/api/account');
    assert.equal(acct.body.data.scanEnabled, true);
    assert.equal(acct.body.data.attachmentsEnabled, true);
    assert.equal(acct.body.data.aiScanConsent, false);
    assert.equal(acct.body.data.photoStorage.photos, 1);
    const exp = await s.get('/api/account/export');
    assert.equal(exp.body.photos.length, 1);
    assert.equal(exp.body.photos[0].data, undefined, 'no image bytes in export JSON');
    const cfg = await request(app).get('/api/auth/config');
    assert.equal(cfg.body.data.scanEnabled, true);
  });
});
