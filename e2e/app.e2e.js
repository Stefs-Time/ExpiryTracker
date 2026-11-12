// End-to-end: real server + PostgreSQL + Chromium + mock Groq.
// Covers the core user journeys, photo scanning, admin, accessibility (axe),
// responsiveness and keyboard behaviour. Run: npm run test:e2e
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BASE, startStack, stopStack, newPage, signUpVia, signIn, addItem, axe, daysFromToday, makePhoto, groq,
} from './harness.js';

let photo;
before(async () => {
  await startStack();
  const p = await newPage();
  photo = await makePhoto(p, path.join(tmpdir(), `vx-e2e-${process.pid}.png`));
  await p.context().close();
});
after(stopStack);

describe('core journeys', () => {
  test('sign up → empty state → add items → KPIs, banner and sort order', async () => {
    const p = await newPage();
    await signUpVia(p);
    await p.waitForSelector('#empty-state:not([hidden])');
    assert.equal(await p.locator('[data-template]').count(), 5);
    await addItem(p, { title: 'Lapsed disc', expiryDate: daysFromToday(-5) });
    await addItem(p, { title: 'Soon card', expiryDate: daysFromToday(60) });
    await addItem(p, { title: 'Passport', expiryDate: daysFromToday(900) });
    const kpis = await Promise.all(['#stat-total', '#stat-critical', '#stat-soon', '#stat-valid'].map((s) => p.textContent(s)));
    assert.deepEqual(kpis, ['3', '1', '1', '1']);
    assert.match(await p.getAttribute('#banner', 'class'), /is-critical/);
    assert.match(await p.textContent('.card >> nth=0'), /Lapsed disc/, 'most urgent first');
    assert.deepEqual(p.errors, []);
    await p.context().close();
  });

  test('edit, renew with history, delete + undo restores the same item', async () => {
    const p = await newPage();
    await signUpVia(p);
    await addItem(p, { title: 'Disc', expiryDate: daysFromToday(-3) });
    await p.click('.card [data-action=edit]');
    await p.fill('#item-form [name=title]', 'Disc (Polo)');
    await p.click('#item-submit');
    await p.waitForSelector('.card:has-text("Disc (Polo)")');
    await p.click('.card [data-action=renew]');
    await p.click('#renew-form [type=submit]');
    await p.waitForSelector('#renew-dialog', { state: 'hidden' });
    await p.waitForTimeout(400);
    assert.equal(await p.textContent('#stat-valid'), '1', 'renewed item is valid');
    await p.click('.card [data-action=delete]');
    await p.click('#confirm-ok');
    await p.waitForSelector('#empty-state:not([hidden])');
    await p.click('#toast-action');
    await p.waitForSelector('.card:has-text("Disc (Polo)")');
    await p.click('.card [data-action=renew]');
    await p.waitForTimeout(400);
    assert.ok((await p.locator('#renew-history li').count()) >= 2, 'renewal history survived undo');
    await p.keyboard.press('Escape');
    await p.context().close();
  });

  test('filters, search, report copy and CSV export', async () => {
    const p = await newPage();
    await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await signUpVia(p);
    await addItem(p, { title: 'Firearm licence', expiryDate: daysFromToday(10), category: 'Firearm' });
    await addItem(p, { title: 'Bank card', expiryDate: daysFromToday(400), category: 'Banking' });
    await p.click('.kpi.critical');
    assert.equal(await p.locator('.card').count(), 1);
    await p.click('#filter-tabs [data-filter=all]');
    await p.fill('#search-input', 'bank');
    await p.waitForFunction(() => document.querySelectorAll('.card').length === 1);
    await p.fill('#search-input', '');
    await p.click('header [data-action=open-report]');
    assert.equal(await p.locator('#report-body tr').count(), 2);
    await p.click('[data-action=copy-report]');
    assert.match(await p.evaluate(() => navigator.clipboard.readText()), /^VAULTEXPIRY STATUS REPORT/);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#report-dialog a[href$="status.csv"]')]);
    assert.equal(readFileSync(await dl.path(), 'utf8').trim().split('\n').length, 3);
    await p.context().close();
  });
});

describe('document photos & AI scan', () => {
  test('consent → scan fills the form → save with photo → view → delete photo', async () => {
    groq.mode = 'ok';
    const p = await newPage();
    await signUpVia(p);
    await p.click('header [data-action=add-item]');
    await p.setInputFiles('#photo-input', photo);
    await p.waitForSelector('#consent-dialog[open]');
    await p.click('#consent-dialog button[value=agree]');
    await p.waitForSelector('#scan-status.ok');
    const f = await p.evaluate(() => { const e = document.querySelector('#item-form').elements; return [e.title.value, e.category.value, e.ref.value, e.expiryDate.value]; });
    assert.deepEqual(f, ["Driver's licence card (Code B)", 'License', '•••• 8834', '2031-03-14']);
    await p.click('#item-submit');
    await p.waitForSelector('.photo-chip');
    await p.click('.photo-chip');
    await p.waitForSelector('#photo-viewer img');
    assert.ok(await p.evaluate(() => document.querySelector('#photo-viewer img').complete && document.querySelector('#photo-viewer img').naturalWidth > 0));
    await p.keyboard.press('Escape');
    await p.click('.card [data-action=edit]');
    await p.waitForSelector('#photo-grid .photo-tile');
    await p.click('#photo-grid [data-action=delete-photo]');
    await p.click('#confirm-ok');
    await p.waitForSelector('#photo-grid .photo-tile', { state: 'detached' });
    assert.deepEqual(p.errors, []);
    await p.context().close();
  });

  test('declining consent sends nothing; missing expiry clears the placeholder date', async () => {
    const p = await newPage();
    await signUpVia(p);
    groq.calls = 0;
    await p.click('header [data-action=add-item]');
    await p.setInputFiles('#photo-input', photo);
    await p.click('#consent-dialog button[value=decline]');
    await p.waitForTimeout(300);
    assert.equal(groq.calls, 0);
    await p.keyboard.press('Escape');
    groq.mode = 'noexpiry';
    await p.click('header [data-action=add-item]');
    await p.setInputFiles('#photo-input', photo);
    await p.click('#consent-dialog button[value=agree]');
    await p.waitForSelector('#scan-status.warn');
    assert.equal(await p.inputValue('#item-form [name=expiryDate]'), '');
    assert.equal(await p.evaluate(() => document.activeElement.name), 'expiryDate');
    groq.mode = 'error';
    await p.setInputFiles('#photo-input', photo);
    await p.waitForSelector('#scan-status.error');
    assert.match(await p.textContent('#scan-status'), /yourself/);
    groq.mode = 'ok';
    await p.context().close();
  });
});

describe('admin', () => {
  test('admin sees the console; normal users are redirected away', async () => {
    const p = await newPage();
    await signIn(p, 'admin@e2e.test', 'admin-password-e2e');
    await p.goto(`${BASE}/#/admin`);
    await p.waitForSelector('#admin-users tr');
    assert.ok((await p.locator('#admin-users tr').count()) >= 1);
    const u = await newPage();
    await signUpVia(u);
    await u.goto(`${BASE}/#/admin`);
    await u.waitForTimeout(300);
    assert.equal(await u.evaluate(() => location.hash), '#/');
    assert.equal(await u.isHidden('#view-admin'), true);
    await p.context().close();
    await u.context().close();
  });
});

describe('accessibility, responsiveness, keyboard', () => {
  for (const colorScheme of ['light', 'dark']) {
    test(`axe: no WCAG 2.2 AA violations on key screens (${colorScheme})`, async () => {
      const p = await newPage({ colorScheme, bypassCSP: true });
      const found = {};
      const scan = async (name) => { const v = await axe(p); if (v.length) found[name] = v; };
      await p.goto(`${BASE}/#/login`);
      await scan('login');
      await p.goto(`${BASE}/#/signup`);
      await scan('signup');
      await signUpVia(p);
      await addItem(p, { title: 'Critical item', expiryDate: daysFromToday(5) });
      await addItem(p, { title: 'Valid item', expiryDate: daysFromToday(500) });
      await scan('dashboard');
      await p.click('header [data-action=add-item]');
      await scan('item dialog');
      await p.keyboard.press('Escape');
      await p.click('header [data-action=open-report]');
      await scan('report');
      await p.keyboard.press('Escape');
      await p.goto(`${BASE}/#/settings`);
      await p.waitForTimeout(300);
      await scan('settings');
      assert.deepEqual(found, {});
      await p.context().close();
    });
  }

  test('no horizontal overflow at 320 / 375 / 768 px; header buttons keep accessible names', async () => {
    const p = await newPage({ width: 320 });
    await signUpVia(p);
    await addItem(p, { title: 'A rather long licence title that should wrap nicely', expiryDate: daysFromToday(20) });
    for (const width of [320, 375, 768]) {
      await p.setViewportSize({ width, height: 800 });
      await p.waitForTimeout(150);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.equal(over, 0, `overflow at ${width}px`);
    }
    await p.setViewportSize({ width: 375, height: 800 });
    const names = await p.evaluate(() => [...document.querySelectorAll('header .btn')].map((b) => b.textContent.trim()));
    assert.deepEqual(names, ['Status report', 'Add item']);
    await p.context().close();
  });

  test('keyboard: focus returns to the card after saving; skip link is visible on focus', async () => {
    const p = await newPage();
    await signUpVia(p);
    await addItem(p, { title: 'Keyboard item', expiryDate: daysFromToday(200) });
    await p.focus('.card [data-action=edit]');
    await p.keyboard.press('Enter');
    await p.waitForSelector('#item-dialog[open]');
    await p.keyboard.press('Enter'); // submit from the title field
    await p.waitForSelector('#item-dialog', { state: 'hidden' });
    await p.waitForTimeout(600);
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.action), 'edit');
    await p.goto(`${BASE}/#/login`);
    await p.evaluate(() => document.querySelector('.skip-link').focus());
    const box = await p.locator('.skip-link').boundingBox();
    assert.ok(box.width > 40 && box.height > 20, 'skip link visible');
    await p.context().close();
  });
});
