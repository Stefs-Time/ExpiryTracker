/**
 * End-to-end test harness: starts the real server (against the test database),
 * a mock Groq API, and Chromium. Run with `npm run test:e2e`.
 *
 * Requirements: PostgreSQL test DB from .env.test, and a Chromium for Playwright
 * (`npx playwright install chromium` locally / in CI).
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seedAdmin } from '../src/services/admin.js';

export const PORT = 3191;
export const BASE = `http://127.0.0.1:${PORT}`;
const GROQ_PORT = 47997;
export const AXE_SOURCE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

// ---------- Mock Groq ----------
export const groq = { mode: 'ok', calls: 0 };
const REPLIES = {
  ok: { documentType: 'License', title: "Driver's licence card (Code B)", expiryDate: '2031-03-14', issueDate: '2026-03-15', referenceLast4: '8834', licencePlate: null, confidence: 0.94, notes: '' },
  noexpiry: { documentType: 'Banking', title: 'Debit card', expiryDate: null, referenceLast4: '1234', confidence: 0.2, notes: 'Blurred' },
};
const mockServer = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    groq.calls += 1;
    if (groq.mode === 'error') { res.writeHead(500); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify(REPLIES[groq.mode]) } }] }));
  });
});

let server;
let browser;

export async function startStack() {
  await migrate();
  await pool.query('TRUNCATE users, items, item_renewals, password_resets, reminder_log, session, admin_audit, admin_notes, item_attachments CASCADE');
  await seedAdmin({ email: 'admin@e2e.test', password: 'admin-password-e2e', displayName: 'E2E Admin' });
  await new Promise((r) => mockServer.listen(GROQ_PORT, '127.0.0.1', r));
  server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_URL: BASE,
      GROQ_API_KEY: 'e2e-key',
      GROQ_BASE_URL: `http://127.0.0.1:${GROQ_PORT}/openai/v1`,
      REMINDERS_ENABLED: 'false',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch();
  return browser;
}

export async function stopStack() {
  await browser?.close();
  server?.kill('SIGTERM');
  mockServer.close();
  await pool.end();
}

export async function newPage({ width = 1280, height = 900, colorScheme = 'light', bypassCSP = false } = {}) {
  // Reduced motion: the CSS disables transitions/animations, so scans never catch mid-fade colours.
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme, bypassCSP, acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}

let n = 0;
export async function signUpVia(page, name = 'E2E User') {
  const email = `e2e${Date.now()}${n++}@example.com`;
  await page.goto(`${BASE}/#/signup`);
  await page.fill('#form-signup [name=displayName]', name);
  await page.fill('#form-signup [name=email]', email);
  await page.fill('#form-signup [name=password]', 'e2e password 123');
  await page.click('#form-signup [type=submit]');
  await page.waitForSelector('#view-dashboard:not([hidden])');
  return email;
}

export async function signIn(page, email, password) {
  await page.goto(`${BASE}/#/login`);
  await page.fill('#form-login [name=email]', email);
  await page.fill('#form-login [name=password]', password);
  await page.click('#form-login [type=submit]');
  await page.waitForSelector('#view-dashboard:not([hidden])');
}

export async function addItem(page, { title, expiryDate, category }) {
  await page.click('header [data-action=add-item]');
  if (category) await page.selectOption('#field-category', category);
  await page.fill('#item-form [name=title]', title);
  if (expiryDate) await page.fill('#item-form [name=expiryDate]', expiryDate);
  await page.click('#item-submit');
  await page.waitForSelector('#item-dialog', { state: 'hidden' });
  await page.waitForSelector(`.card:has-text("${title}")`);
}

/** Run axe-core (WCAG 2.2 AA + best practices) and return violations. Page must allow the script (bypassCSP). */
export async function axe(page) {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).slice(0, 3).join(', ')}`);
  });
}

export const daysFromToday = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

/** A small rendered "card" photo (PNG) for upload tests. */
export async function makePhoto(page, path) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 900; c.height = 570; const g = c.getContext('2d');
    g.fillStyle = '#d9ecf2'; g.fillRect(0, 0, 900, 570); g.fillStyle = '#123'; g.font = '40px sans-serif'; g.fillText('DRIVING LICENCE 14/03/2031', 30, 200);
    return c.toDataURL('image/png').split(',')[1];
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return path;
}
