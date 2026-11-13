/**
 * Admin console ("back office"): accounts, invites, support notes, audit log, system status.
 * Shows account metadata and counts only — never item or photo contents.
 *
 * Filters live in the URL (#/admin?status=locked&q=…) so views can be bookmarked and shared.
 */
import { api } from './api.js';
import { $, $$, esc, icon, toast, showFormError, busy, formData, copyText, confirmDialog } from './ui.js';

const PAGE_SIZE = 25;
const AUDIT_PAGE_SIZE = 15;

const state = {
  me: null,
  mailConfigured: true,
  // user list
  q: '', status: '', role: '', sort: 'created', page: 1, totalPages: 1, users: [],
  // audit
  auditQ: '', auditAction: '', auditPage: 1, auditTotalPages: 1,
  // detail panel
  detail: null,
};

const ACTION_LABELS = {
  password_reset_email: 'emailed a password reset to',
  password_reset_link: 'created a reset link for',
  unlock: 'unlocked',
  revoke_sessions: 'signed out',
  disable: 'disabled',
  enable: 'enabled',
  delete_user: 'deleted',
  invite_email: 'emailed an invite to',
  invite_link: 'created an invite link for',
};
const ACTION_NAMES = {
  password_reset_email: 'Password reset (email)',
  password_reset_link: 'Password reset (link)',
  unlock: 'Unlock',
  revoke_sessions: 'Sign out everywhere',
  disable: 'Disable',
  enable: 'Enable',
  delete_user: 'Delete account',
  invite_email: 'Invite (email)',
  invite_link: 'Invite (link)',
};

/* ---------------- Formatting ---------------- */

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function relative(v) {
  if (!v) return 'Never';
  const mins = Math.floor((Date.now() - new Date(v).getTime()) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`;
  const days = Math.floor(mins / 1440);
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  return fmtDate(v);
}

function duration(seconds) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} days`;
}

const lastRun = (v) => (v ? `Last run ${relative(v).toLowerCase()}` : 'Waiting for its first run');
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const statusBadge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;

/* ---------------- URL state ---------------- */

function readUrl(params) {
  state.q = params.get('q') || '';
  state.status = params.get('status') || '';
  state.role = params.get('role') || '';
  state.sort = params.get('sort') || 'created';
  state.page = Math.max(1, Number(params.get('page')) || 1);
}

function userQuery({ withPaging = true } = {}) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.status) p.set('status', state.status);
  if (state.role) p.set('role', state.role);
  if (state.sort !== 'created') p.set('sort', state.sort);
  if (withPaging && state.page > 1) p.set('page', state.page);
  return p;
}

function writeUrl() {
  const qs = userQuery().toString();
  // replaceState: no hashchange event, so the view doesn't reload itself.
  history.replaceState(null, '', `#/admin${qs ? `?${qs}` : ''}`);
}

function syncControls() {
  $('#admin-search').value = state.q;
  $('#admin-status').value = state.status;
  $('#admin-role').value = state.role;
  $('#admin-clear').hidden = !(state.q || state.status || state.role);
  $$('[data-admin-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.adminFilter === state.status && !state.q && !state.role)));
  $$('[data-admin-sort]').forEach((b) => {
    const key = b.dataset.adminSort;
    const th = b.closest('th');
    // "created" and "lastLogin" default to newest first; "name" to A→Z.
    const asc = key === 'name' ? state.sort === 'name' : state.sort === `-${key}`;
    const desc = key === 'name' ? state.sort === '-name' : state.sort === key;
    th.setAttribute('aria-sort', asc ? 'ascending' : desc ? 'descending' : 'none');
  });
  $('#admin-users-csv').href = `/api/admin/users.csv?${userQuery({ withPaging: false })}`;
}

/* ---------------- Loading ---------------- */

export async function showAdmin(me, params = new URLSearchParams()) {
  state.me = me;
  readUrl(params);
  syncControls();
  await Promise.all([loadStats(), loadUsers(), loadAudit(), loadSystem()]);
}

const refreshAll = () => Promise.all([loadStats(), loadUsers(), loadAudit()]);

async function loadStats() {
  try {
    const { data } = await api('/admin/stats');
    state.mailConfigured = data.mailConfigured;
    $('#as-users').textContent = data.users;
    $('#as-new').textContent = `${data.newLast30Days} new (30d)`;
    $('#as-locked').textContent = data.locked;
    $('#as-invited').textContent = data.invited;
    $('#as-disabled').textContent = data.disabled;
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
  }
}

async function loadUsers() {
  const params = userQuery();
  params.set('page', state.page);
  params.set('limit', PAGE_SIZE);
  if (!params.has('sort')) params.set('sort', state.sort);
  const body = $('#admin-users');
  try {
    const { data, meta } = await api(`/admin/users?${params}`);
    state.users = data;
    state.totalPages = meta.totalPages;
    $('#admin-page-info').textContent = `${meta.total} user${meta.total === 1 ? '' : 's'} · page ${meta.page} of ${meta.totalPages}`;
    $('[data-admin-page="-1"]').disabled = meta.page <= 1;
    $('[data-admin-page="1"]').disabled = meta.page >= meta.totalPages;
    body.innerHTML = data.length
      ? data.map(rowHTML).join('')
      : `<tr><td colspan="6" class="muted">No users match these filters. <button type="button" class="link-plain" data-admin-action="clear">Clear filters</button></td></tr>`;
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
  }
}

function rowHTML(u) {
  const self = u.id === state.me?.id;
  const id = esc(u.id);
  const label = esc(u.email);
  // One contextual shortcut for the most likely next step; everything else is under "Manage".
  const quick = {
    locked: ['unlock', 'lock-open', 'Unlock'],
    disabled: ['enable', 'user-check', 'Enable'],
    invited: ['reset', 'mail', 'Resend invite'],
  }[u.status];
  return `<tr>
    <td class="who">
      <button type="button" class="who-btn" data-admin-action="detail" data-id="${id}" aria-label="Manage ${label}">
        <strong>${esc(u.displayName)}${u.role === 'admin' ? '<span class="chip role-chip">ADMIN</span>' : ''}${self ? ' <span class="faint">(you)</span>' : ''}</strong>
        <span>${label}</span>
      </button>
    </td>
    <td>${statusBadge(u.status)}${u.status === 'locked' ? `<br><span class="faint">until ${esc(fmtDateTime(u.lockedUntil))}</span>` : ''}${u.noteCount ? `<br><span class="faint">${u.noteCount} note${u.noteCount === 1 ? '' : 's'}</span>` : ''}</td>
    <td class="num mono">${Number(u.itemCount)}</td>
    <td><span title="${esc(fmtDateTime(u.lastLoginAt))}">${esc(relative(u.lastLoginAt))}</span>${u.activeSessions ? `<br><span class="faint">${u.activeSessions} active session${u.activeSessions === 1 ? '' : 's'}</span>` : ''}</td>
    <td class="mono">${esc(fmtDate(u.createdAt))}</td>
    <td class="num"><span class="row-actions">
      ${quick ? `<button type="button" class="btn btn-sm btn-soft" data-admin-action="${quick[0]}" data-id="${id}" aria-label="${quick[2]}: ${label}">${icon(quick[1], 'icon icon-sm')}${quick[2]}</button>` : ''}
      <button type="button" class="btn btn-sm" data-admin-action="detail" data-id="${id}" aria-label="Manage ${label}">Manage</button>
    </span></td>
  </tr>`;
}

/* ---------------- Audit ---------------- */

function auditQuery() {
  const p = new URLSearchParams();
  if (state.auditQ) p.set('q', state.auditQ);
  if (state.auditAction) p.set('action', state.auditAction);
  return p;
}

function auditItemHTML(a, { linkTarget = true } = {}) {
  const target = linkTarget && a.targetUserId
    ? `<button type="button" class="link-plain" data-admin-action="detail" data-id="${esc(a.targetUserId)}">${esc(a.targetEmail)}</button>`
    : `<strong>${esc(a.targetEmail)}</strong>`;
  return `<li><span><strong>${esc(a.adminEmail)}</strong> ${esc(ACTION_LABELS[a.action] || a.action)} ${target}${a.reason ? `<br><span class="faint">Reason: ${esc(a.reason)}</span>` : ''}</span>
    <span class="faint mono" title="${a.ip ? `From ${esc(a.ip)}` : ''}">${esc(fmtDateTime(a.createdAt))}</span></li>`;
}

async function loadAudit() {
  const params = auditQuery();
  params.set('page', state.auditPage);
  params.set('limit', AUDIT_PAGE_SIZE);
  $('#admin-audit-csv').href = `/api/admin/audit.csv?${auditQuery()}`;
  try {
    const { data, meta } = await api(`/admin/audit?${params}`);
    state.auditTotalPages = meta.totalPages;
    $('#admin-audit').innerHTML = data.length
      ? data.map((a) => auditItemHTML(a)).join('')
      : `<li class="faint">${state.auditQ || state.auditAction ? 'No entries match.' : 'No admin actions yet.'}</li>`;
    $('#audit-page-info').textContent = `${meta.total} entr${meta.total === 1 ? 'y' : 'ies'} · page ${meta.page} of ${meta.totalPages}`;
    $('[data-audit-page="-1"]').disabled = meta.page <= 1;
    $('[data-audit-page="1"]').disabled = meta.page >= meta.totalPages;
  } catch { /* non-critical */ }
}

/* ---------------- System status ---------------- */

async function loadSystem() {
  try {
    const [{ data: s }, { data: stats }] = await Promise.all([api('/admin/system'), api('/admin/stats')]);
    $('#sys-meta').textContent = `v${s.version} · ${s.environment} · up ${duration(s.uptimeSeconds)}`;
    $('#sys-warnings').innerHTML = s.warnings.map((w) => `<li>${icon('triangle-alert', 'icon icon-sm')}<span>${esc(w)}</span></li>`).join('');
    const f = s.features;
    const check = (state2, name, detail) => `<li class="sys-item ${state2}">${icon(state2 === 'ok' ? 'circle-check' : state2 === 'warn' ? 'triangle-alert' : 'circle-minus', 'icon icon-sm')}<span><strong>${esc(name)}</strong><span>${esc(detail)}</span></span></li>`;
    $('#sys-checks').innerHTML = [
      check(s.database.ok ? 'ok' : 'warn', 'Database', s.database.ok ? `Responding (${s.database.latencyMs} ms)` : 'Not responding'),
      check(f.mailConfigured ? 'ok' : 'warn', 'Email', f.mailConfigured ? 'SMTP configured' : 'Not configured'),
      check(s.jobs.reminders.lastError ? 'warn' : f.remindersRunning ? 'ok' : 'off', 'Reminder emails',
        f.remindersRunning ? lastRun(s.jobs.reminders.lastRunAt) : 'Not running'),
      check(s.jobs.maintenance.lastError ? 'warn' : 'ok', 'Clean-up job', lastRun(s.jobs.maintenance.lastRunAt)),
      check(f.signupEnabled ? 'ok' : 'off', 'Public sign-up', f.signupEnabled ? 'Open' : 'Closed (invite only)'),
      check(f.attachmentsEnabled ? 'ok' : 'off', 'Document photos', f.attachmentsEnabled ? `${s.photoStorage.photos} stored · ${megabytes(s.photoStorage.bytes)}` : 'Off'),
      check(f.scanEnabled ? 'ok' : 'off', 'AI photo scanning', f.scanEnabled ? `Model: ${f.scanModel}` : 'Off'),
    ].join('');
    $('#sys-numbers').innerHTML = [
      ['Items tracked', stats.items], ['Active users (30 days)', stats.activeLast30Days],
      ['New users (30 days)', stats.newLast30Days], ['Reminders sent (30 days)', stats.remindersLast30Days], ['Admins', stats.admins],
    ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${Number(v)}</dd></div>`).join('');
  } catch { /* non-critical */ }
}

/* ---------------- User detail panel ---------------- */

async function openDetail(userId) {
  try {
    const { data } = await api(`/admin/users/${userId}/detail`);
    state.detail = data;
    renderDetail();
    const dlg = $('#admin-user-dialog');
    if (!dlg.open) dlg.showModal();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderDetail() {
  const { user: u, notes, activity } = state.detail;
  const self = u.id === state.me?.id;
  $('#au-avatar').textContent = (u.displayName || u.email).trim().charAt(0).toUpperCase();
  $('#au-name').innerHTML = `${esc(u.displayName)}${u.role === 'admin' ? ' <span class="chip role-chip">ADMIN</span>' : ''}${self ? ' <span class="faint">(you)</span>' : ''}`;
  $('#au-email').textContent = u.email;

  const fact = (k, v) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  $('#au-facts').innerHTML = [
    fact('Status', statusBadge(u.status) + (u.status === 'locked' ? ` <span class="faint">until ${esc(fmtDateTime(u.lockedUntil))}</span>` : '')),
    fact('Joined', esc(fmtDate(u.createdAt)) + (u.invitedAt ? ' <span class="faint">(invited)</span>' : '')),
    fact('Last sign-in', `<span title="${esc(fmtDateTime(u.lastLoginAt))}">${esc(relative(u.lastLoginAt))}</span>`),
    fact('Active sessions', Number(u.activeSessions)),
    fact('Items tracked', Number(u.itemCount)),
    fact('Photos stored', Number(u.photoCount)),
    fact('Email reminders', u.emailReminders ? 'On' : 'Off'),
    fact('Timezone', esc(u.timezone).replaceAll('/', '/<wbr>')),
    fact('Failed sign-ins', Number(u.failedLogins)),
  ].join('');

  const action = (name, iconName, title, text, cls = '') => `
    <button type="button" class="action-row ${cls}" data-admin-action="${name}" data-id="${esc(u.id)}">
      <span class="action-icon">${icon(iconName, 'icon icon-sm')}</span>
      <span><strong>${title}</strong><span>${text}</span></span>
    </button>`;
  const resetText = state.mailConfigured
    ? 'Emails them a link to choose a new password. You never see it.'
    : 'Email is off, so you get a one-time link to pass on.';
  $('#au-actions').innerHTML = [
    u.status === 'locked' ? action('unlock', 'lock-open', 'Unlock account', 'Clears the lockout from failed sign-ins so they can try again.') : '',
    u.status === 'invited' ? action('reset', 'mail', 'Resend invite', `Sends a fresh link to choose a password (valid 60 minutes). ${state.mailConfigured ? '' : 'Shown to you to pass on.'}`) : '',
    u.status !== 'disabled' && u.status !== 'invited' ? action('reset', 'key-round', 'Send password reset', resetText) : '',
    u.activeSessions > 0 ? action('sign-out', 'log-out', 'Sign out everywhere', `Ends ${u.activeSessions} active session${u.activeSessions === 1 ? '' : 's'} on all devices.`) : '',
    u.status === 'disabled' ? action('enable', 'user-check', 'Enable account', 'Lets them sign in again and resumes reminders.') : '',
    !self && u.status !== 'disabled' ? action('disable', 'user-x', 'Disable account', 'Blocks sign-in and reminders. Their data is kept.', 'danger') : '',
    !self && u.role !== 'admin' ? action('delete', 'trash-2', 'Delete account', 'Permanently removes the account, items and photos.', 'danger') : '',
  ].join('') || '<p class="muted">No actions available for your own account here. Use Settings.</p>';

  $('#au-notes').innerHTML = notes.length
    ? notes.map((n) => `<li><span>${esc(n.body)}<br><span class="faint">${esc(n.adminEmail)} · ${esc(fmtDateTime(n.createdAt))}</span></span>
        <button type="button" class="icon-btn danger" data-admin-action="delete-note" data-note="${esc(n.id)}" aria-label="Delete note">${icon('trash-2')}</button></li>`).join('')
    : '<li class="faint">No notes yet.</li>';
  $('#au-activity').innerHTML = activity.length
    ? activity.map((a) => auditItemHTML(a, { linkTarget: false })).join('')
    : '<li class="faint">No admin actions on this account.</li>';
}

/* ---------------- Actions ---------------- */

function showOneTimeLink({ title, email, text, link }) {
  $('#reset-link-title').textContent = title;
  $('#reset-link-sub').textContent = email;
  $('#reset-link-text').textContent = text;
  $('#reset-link-url').value = link;
  $('#reset-link-dialog').showModal();
}

async function runAction(action, user) {
  try {
    if (action === 'reset') {
      const invite = user.status === 'invited';
      const ok = await confirmDialog({
        title: invite ? 'Resend invite?' : 'Reset password?',
        text: invite
          ? `${user.email} will get a fresh link to choose a password.`
          : `${user.email} will get a link to choose a new password. Their current password keeps working until they use it.`,
        ok: invite ? 'Resend invite' : 'Send reset',
        tone: 'primary',
        icon: invite ? 'mail' : 'key-round',
      });
      if (!ok) return;
      const { data } = await api(`/admin/users/${user.id}/password-reset`, { method: 'POST' });
      if (data.emailed) {
        toast(`Link emailed to ${user.email}`);
      } else {
        showOneTimeLink({
          title: 'One-time link',
          email: user.email,
          link: data.link,
          text: "Email isn't configured, so send this link to the user yourself, through a channel you trust. It works once and expires in 60 minutes. Anyone holding it can take over the account.",
        });
      }
    } else if (action === 'unlock') {
      await api(`/admin/users/${user.id}/unlock`, { method: 'POST' });
      toast(`Unlocked ${user.email}`);
    } else if (action === 'sign-out') {
      if (!(await confirmDialog({ title: 'Sign out everywhere?', text: `${user.email} will be signed out on every device.`, ok: 'Sign out', tone: 'warning', icon: 'log-out' }))) return;
      await api(`/admin/users/${user.id}/sign-out`, { method: 'POST' });
      toast(`Signed out ${user.email} everywhere`);
    } else if (action === 'enable') {
      await api(`/admin/users/${user.id}/enable`, { method: 'POST' });
      toast(`Enabled ${user.email}`);
    } else if (action === 'disable') {
      const form = $('#admin-disable-form');
      form.reset();
      showFormError(form, null);
      form.elements.id.value = user.id;
      $('#admin-disable-text').textContent = `${user.email} will be signed out and won't be able to sign in, get reminders or use their calendar link until you re-enable the account. Their data is kept.${state.mailConfigured ? ' They will be told by email.' : ''}`;
      $('#admin-disable-dialog').showModal();
      return;
    } else if (action === 'delete') {
      const form = $('#admin-delete-form');
      form.reset();
      showFormError(form, null);
      form.elements.id.value = user.id;
      $('#admin-delete-email').textContent = user.email;
      $('#admin-delete-dialog').showModal();
      return;
    }
    await afterChange(user.id);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/** Refresh lists, and the detail panel if it's showing this user. */
async function afterChange(userId, { gone = false } = {}) {
  const dlg = $('#admin-user-dialog');
  if (gone) {
    if (dlg.open) dlg.close();
    state.detail = null;
  } else if (dlg.open && state.detail?.user.id === userId) {
    await openDetail(userId);
  }
  await refreshAll();
}

function setFilters(patch) {
  Object.assign(state, patch, { page: 1 });
  syncControls();
  writeUrl();
  return loadUsers();
}

/* ---------------- Wiring ---------------- */

export function initAdmin() {
  $('#audit-action').insertAdjacentHTML('beforeend', Object.entries(ACTION_NAMES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(''));

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-admin-action],[data-admin-page],[data-audit-page],[data-admin-filter],[data-admin-sort],[data-action="copy-reset-link"]');
    if (!t) return;
    if (t.dataset.action === 'copy-reset-link') {
      return toast((await copyText($('#reset-link-url').value)) ? 'Link copied' : 'Copy failed');
    }
    if (t.dataset.adminPage) {
      state.page = Math.min(state.totalPages, Math.max(1, state.page + Number(t.dataset.adminPage)));
      writeUrl();
      return loadUsers();
    }
    if (t.dataset.auditPage) {
      state.auditPage = Math.min(state.auditTotalPages, Math.max(1, state.auditPage + Number(t.dataset.auditPage)));
      return loadAudit();
    }
    if (t.dataset.adminFilter !== undefined) return setFilters({ status: t.dataset.adminFilter, q: '', role: '' });
    if (t.dataset.adminSort) {
      const key = t.dataset.adminSort;
      // First click: the natural order (A→Z for names, newest first for dates); second click reverses.
      const natural = key;
      const reversed = `-${key}`;
      return setFilters({ sort: state.sort === natural ? reversed : natural });
    }

    const action = t.dataset.adminAction;
    if (action === 'clear') return setFilters({ q: '', status: '', role: '' });
    if (action === 'invite') {
      const form = $('#admin-invite-form');
      form.reset();
      showFormError(form, null);
      $('#admin-invite-text').textContent = state.mailConfigured
        ? "We'll create the account and email them a link to choose their own password (valid for 72 hours)."
        : "We'll create the account. Email isn't configured, so you'll get a one-time link to pass on (valid for 72 hours).";
      $('#admin-invite-dialog').showModal();
      form.elements.displayName.focus();
      return undefined;
    }
    if (action === 'copy-email') {
      return toast((await copyText(state.detail.user.email)) ? 'Email address copied' : 'Copy failed');
    }
    if (action === 'delete-note') {
      try {
        await api(`/admin/users/${state.detail.user.id}/notes/${t.dataset.note}`, { method: 'DELETE' });
        await openDetail(state.detail.user.id);
        loadUsers();
      } catch (err) {
        toast(err.message, { error: true });
      }
      return undefined;
    }
    if (action === 'detail') return openDetail(t.dataset.id);
    const user = state.users.find((u) => u.id === t.dataset.id) || (state.detail?.user.id === t.dataset.id ? state.detail.user : null);
    if (user) runAction(action, user);
    return undefined;
  });

  // Filters
  let timer;
  $('#admin-search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => setFilters({ q: e.target.value.trim() }), 250);
  });
  $('#admin-status').addEventListener('change', (e) => setFilters({ status: e.target.value }));
  $('#admin-role').addEventListener('change', (e) => setFilters({ role: e.target.value }));
  $('#admin-clear').addEventListener('click', () => setFilters({ q: '', status: '', role: '' }));

  let auditTimer;
  $('#audit-search').addEventListener('input', (e) => {
    clearTimeout(auditTimer);
    auditTimer = setTimeout(() => { state.auditQ = e.target.value.trim(); state.auditPage = 1; loadAudit(); }, 250);
  });
  $('#audit-action').addEventListener('change', (e) => { state.auditAction = e.target.value; state.auditPage = 1; loadAudit(); });

  // "/" focuses the user search while the console is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('#view-admin').hidden || e.target.closest('input, textarea, select, dialog')) return;
    e.preventDefault();
    $('#admin-search').focus();
  });

  // Forms
  $('#admin-invite-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = formData(form);
    if (!f.displayName.trim()) return showFormError(form, { message: 'Name is required', details: [{ field: 'displayName' }] });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) {
      return showFormError(form, { message: 'Enter a valid email address', details: [{ field: 'email' }] });
    }
    return busy(form, async () => {
      try {
        const { data } = await api('/admin/users', { method: 'POST', body: { displayName: f.displayName.trim(), email: f.email.trim() } });
        $('#admin-invite-dialog').close();
        if (data.emailed) {
          toast(`Invite emailed to ${data.user.email}`);
        } else {
          showOneTimeLink({
            title: 'Invite link',
            email: data.user.email,
            link: data.link,
            text: `Email isn't configured, so send this link to the user yourself, through a channel you trust. They use it to choose their password. It works once and expires in ${data.expiresInHours} hours.`,
          });
        }
        await refreshAll();
      } catch (err) {
        showFormError(form, err);
      }
    });
  });

  $('#admin-disable-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { id, reason } = formData(form);
    busy(form, async () => {
      try {
        await api(`/admin/users/${id}/disable`, { method: 'POST', body: reason.trim() ? { reason: reason.trim() } : {} });
        $('#admin-disable-dialog').close();
        toast('Account disabled');
        await afterChange(id);
      } catch (err) {
        showFormError(form, err);
      }
    });
  });

  $('#admin-delete-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { id, confirmEmail, reason } = formData(form);
    busy(form, async () => {
      try {
        await api(`/admin/users/${id}`, { method: 'DELETE', body: { confirmEmail, ...(reason.trim() ? { reason: reason.trim() } : {}) } });
        $('#admin-delete-dialog').close();
        toast('Account deleted');
        await afterChange(id, { gone: true });
      } catch (err) {
        showFormError(form, err);
      }
    });
  });

  $('#au-note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = form.elements.body.value.trim();
    if (!body) return showFormError(form, { message: 'Write a note first' });
    return busy(form, async () => {
      try {
        await api(`/admin/users/${state.detail.user.id}/notes`, { method: 'POST', body: { body } });
        form.reset();
        showFormError(form, null);
        await openDetail(state.detail.user.id);
        loadUsers();
      } catch (err) {
        showFormError(form, err);
      }
    });
  });
}
