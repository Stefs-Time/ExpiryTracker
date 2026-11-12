/** App bootstrap: session, hash router, auth forms, theme, PWA service worker. */
import { api, setCsrfToken } from './api.js';
import { $, $$, toast, showFormError, busy, formData, wireStrengthMeter } from './ui.js';
import { initDashboard, loadItems, render, setUser as setDashUser, resetDashboard } from './dashboard.js';
import { initSettings, showSettings } from './settings.js';
import { todayIn } from './shared/expiry.js';

let user = null;
let signupEnabled = true;

/* ---------------- Theme ---------------- */
const THEMES = ['system', 'light', 'dark'];
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

function currentTheme() {
  try { return localStorage.getItem('vx-theme') || 'system'; } catch { return 'system'; }
}
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try { localStorage.setItem('vx-theme', theme); } catch { /* ignore */ }
  const btn = $('#theme-toggle');
  btn.querySelector('use').setAttribute('href', `/icons.svg#i-${THEME_ICON[theme]}`);
  btn.setAttribute('aria-label', `Theme: ${theme}. Click to change.`);
  btn.title = `Theme: ${theme}`;
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $$('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#07080a' : '#f5f6f8'));
}

/* ---------------- Session ---------------- */
function setUser(u) {
  user = u;
  if (u) {
    setDashUser(u, todayIn(u.timezone));
    $('#user-menu-btn').textContent = (u.displayName || u.email).trim().charAt(0).toUpperCase();
    $('#menu-name').textContent = u.displayName;
    $('#menu-email').textContent = u.email;
    render();
  }
  $$('[data-auth="in"]').forEach((el) => { el.hidden = !u; });
}

/** Remove cached personal API responses (offline copy) — on sign-in, sign-out and session end. */
async function clearOfflineData() {
  try { await caches.delete('vx-data'); } catch { /* Cache API unavailable */ }
}

async function signedIn(data) {
  await clearOfflineData();
  setCsrfToken(data.csrfToken);
  setUser(data.user);
  resetDashboard();
  location.hash = '#/';
  await route();
  loadItems();
  api('/auth/me').catch(() => {}); // prime the offline copy of the session
}

async function signOut({ silent = false } = {}) {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
  setCsrfToken(null);
  setUser(null);
  resetDashboard();
  await clearOfflineData();
  if (!silent) toast('Signed out');
  location.hash = '#/login';
}

/* ---------------- Router ---------------- */
const AUTH_ROUTES = ['login', 'signup', 'forgot', 'reset'];

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { path: path || '', params: new URLSearchParams(qs || '') };
}

async function route() {
  const { path, params } = parseHash();
  $('#user-menu').hidden = true;

  if (!user && !AUTH_ROUTES.includes(path)) {
    location.replace('#/login');
    return;
  }
  if (user && AUTH_ROUTES.includes(path) && path !== 'reset') {
    location.replace('#/');
    return;
  }

  $('#view-auth').hidden = !AUTH_ROUTES.includes(path);
  $('#view-dashboard').hidden = !(user && path === '');
  $('#view-settings').hidden = !(user && path === 'settings');

  if (AUTH_ROUTES.includes(path)) {
    const target = path === 'signup' && !signupEnabled ? 'login' : path;
    $$('[data-auth-form]').forEach((f) => {
      f.hidden = f.dataset.authForm !== target;
      showFormError(f, null);
    });
    $$('[data-signup-link]').forEach((a) => { a.hidden = !signupEnabled; });
    const form = $(`[data-auth-form="${target}"]`);
    if (target === 'reset') form.dataset.token = params.get('token') || '';
    $('.form-ok', $('#form-forgot')).hidden = true;
    document.title = { login: 'Sign in', signup: 'Create account', forgot: 'Reset password', reset: 'New password' }[target] + ' · VaultExpiry';
    form.querySelector('input')?.focus();
  } else if (path === 'settings') {
    document.title = 'Settings · VaultExpiry';
    await showSettings();
  } else {
    document.title = 'VaultExpiry';
  }
}

/* ---------------- Auth forms ---------------- */
function wireAuthForms() {
  $('#form-login').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    busy(form, async () => {
      try {
        const { data } = await api('/auth/login', { method: 'POST', body: formData(form) });
        form.reset();
        await signedIn(data);
      } catch (err) {
        showFormError(form, err);
      }
    });
  });

  $('#form-signup').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = formData(form);
    body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Johannesburg';
    if (body.password.length < 10) {
      return showFormError(form, { message: 'Password must be at least 10 characters', details: [{ field: 'password' }] });
    }
    busy(form, async () => {
      try {
        const { data } = await api('/auth/signup', { method: 'POST', body });
        form.reset();
        await signedIn(data);
        toast(`Welcome, ${data.user.displayName}!`);
      } catch (err) {
        // Browser timezone may be unknown to the server; retry with the default.
        if (err.details?.some((d) => d.field === 'timezone')) {
          delete body.timezone;
          try {
            const { data } = await api('/auth/signup', { method: 'POST', body });
            form.reset();
            return signedIn(data);
          } catch (err2) {
            return showFormError(form, err2);
          }
        }
        showFormError(form, err);
      }
    });
  });

  $('#form-forgot').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    busy(form, async () => {
      try {
        const { data } = await api('/auth/forgot', { method: 'POST', body: formData(form) });
        showFormError(form, null);
        const ok = $('.form-ok', form);
        ok.textContent = data.message;
        ok.hidden = false;
      } catch (err) {
        showFormError(form, err);
      }
    });
  });

  $('#form-reset').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    busy(form, async () => {
      try {
        const { data } = await api('/auth/reset', {
          method: 'POST',
          body: { token: form.dataset.token, password: formData(form).password },
        });
        form.reset();
        await signedIn(data);
        toast('Password updated — you are signed in');
      } catch (err) {
        showFormError(form, err);
      }
    });
  });

  $$('input[autocomplete="new-password"]').forEach(wireStrengthMeter);

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action="toggle-password"]');
    if (!t) return;
    const input = t.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    t.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    t.querySelector('use').setAttribute('href', `/icons.svg#i-${show ? 'eye-off' : 'eye'}`);
  });
}

/* ---------------- Header menu ---------------- */
function wireMenu() {
  const btn = $('#user-menu-btn');
  const panel = $('#user-menu');
  const setOpen = (open) => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector('[role="menuitem"]')?.focus();
  };
  btn.addEventListener('click', () => setOpen(panel.hidden));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) setOpen(false);
    if (e.target.closest('[data-action="logout"]')) signOut();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { setOpen(false); btn.focus(); }
  });
}

/* ---------------- Connectivity & PWA ---------------- */
function wireConnectivity() {
  const update = () => { $('#offline-bar').hidden = navigator.onLine; };
  window.addEventListener('online', () => { update(); if (user) loadItems(); });
  window.addEventListener('offline', update);
  update();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is available', { action: 'Refresh', onAction: () => sw.postMessage({ type: 'skip-waiting' }) });
          }
        });
      });
    }).catch(() => { /* SW unsupported (e.g. private mode) — app still works online */ });
    // Reload only when a new worker replaces an existing one (an update the user accepted),
    // not when the very first worker claims the page on first visit.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
  }

  // Re-evaluate "today" when the app returns to the foreground (e.g. left open overnight).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && user) {
      setDashUser(user, todayIn(user.timezone));
      render();
    }
  });
}

/* ---------------- Boot ---------------- */
async function boot() {
  applyTheme(currentTheme());
  $('#theme-toggle').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    applyTheme(next);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(currentTheme()));

  initDashboard();
  initSettings({
    getUser: () => user,
    setUser: (u) => setUser(u),
    onSignedOut: () => signOut({ silent: true }),
    reloadItems: () => loadItems(),
  });
  wireAuthForms();
  wireMenu();
  wireConnectivity();

  window.addEventListener('vx:unauthorized', () => {
    if (!user) return;
    clearOfflineData();
    setCsrfToken(null);
    setUser(null);
    resetDashboard();
    toast('Your session has ended. Please sign in again.', { error: true });
    location.hash = '#/login';
  });
  window.addEventListener('hashchange', route);

  api('/auth/config').then(({ data }) => { signupEnabled = data.signupEnabled; }).catch(() => {});

  try {
    const { data } = await api('/auth/me');
    setCsrfToken(data.csrfToken);
    setUser(data.user);
  } catch {
    setUser(null);
  }
  await route();
  if (user) loadItems();
}

boot();
