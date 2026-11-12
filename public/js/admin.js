/** Admin console: platform stats, user management, audit log. Shows account metadata only. */
import { api } from './api.js';
import { $, esc, icon, toast, showFormError, busy, formData, copyText } from './ui.js';

const state = { page: 1, totalPages: 1, q: '', status: '', role: '', users: [], me: null };

const ACTION_LABELS = {
  password_reset_email: 'emailed a password reset to',
  password_reset_link: 'created a reset link for',
  unlock: 'unlocked',
  revoke_sessions: 'signed out',
  disable: 'disabled',
  enable: 'enabled',
  delete_user: 'deleted',
};

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (v) => new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function relative(v) {
  if (!v) return 'Never';
  const days = Math.floor((Date.now() - new Date(v).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  return fmtDate(v);
}

export async function showAdmin(me) {
  state.me = me;
  await Promise.all([loadStats(), loadUsers(), loadAudit()]);
}

async function loadStats() {
  try {
    const { data } = await api('/admin/stats');
    $('#as-users').textContent = data.users;
    $('#as-new').textContent = `${data.newLast30Days} new (30d)`;
    $('#as-active').textContent = data.activeLast30Days;
    $('#as-items').textContent = data.items;
    $('#as-reminders').textContent = `${data.remindersLast30Days} reminders (30d)`;
    $('#as-disabled').textContent = data.disabled;
    $('#admin-mail-warning').hidden = data.mailConfigured;
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
  }
}

async function loadUsers() {
  const params = new URLSearchParams({ page: state.page, limit: 25 });
  if (state.q) params.set('q', state.q);
  if (state.status) params.set('status', state.status);
  if (state.role) params.set('role', state.role);
  const body = $('#admin-users');
  try {
    const { data, meta } = await api(`/admin/users?${params}`);
    state.users = data;
    state.totalPages = meta.totalPages;
    $('#admin-page-info').textContent = `${meta.total} user${meta.total === 1 ? '' : 's'} · page ${meta.page} of ${meta.totalPages}`;
    $('[data-admin-page="-1"]').disabled = meta.page <= 1;
    $('[data-admin-page="1"]').disabled = meta.page >= meta.totalPages;
    body.innerHTML = data.length ? data.map(rowHTML).join('') : '<tr><td colspan="6" class="muted">No users match.</td></tr>';
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
  }
}

function rowHTML(u) {
  const self = u.id === state.me?.id;
  const id = esc(u.id);
  const label = esc(u.email);
  const btn = (action, iconName, title, cls = '') =>
    `<button type="button" class="icon-btn ${cls}" data-admin-action="${action}" data-id="${id}" title="${title}" aria-label="${title}: ${label}">${icon(iconName)}</button>`;
  const actions = [
    u.status !== 'disabled' ? btn('reset', 'key-round', 'Send password reset') : '',
    u.status === 'locked' ? btn('unlock', 'lock-open', 'Unlock account', 'renew') : '',
    u.activeSessions > 0 ? btn('sign-out', 'log-out', 'Sign out everywhere') : '',
    !self && u.status !== 'disabled' ? btn('disable', 'user-x', 'Disable account', 'danger') : '',
    u.status === 'disabled' ? btn('enable', 'user-check', 'Enable account', 'renew') : '',
    !self && u.role !== 'admin' ? btn('delete', 'trash-2', 'Delete account', 'danger') : '',
  ].join('');
  return `<tr>
    <td class="who"><strong>${esc(u.displayName)}${u.role === 'admin' ? '<span class="chip role-chip">ADMIN</span>' : ''}${self ? ' <span class="faint">(you)</span>' : ''}</strong><span>${label}</span></td>
    <td><span class="badge ${u.status}">${u.status}</span>${u.status === 'locked' ? `<br><span class="faint">until ${esc(fmtDateTime(u.lockedUntil))}</span>` : ''}</td>
    <td class="num mono">${Number(u.itemCount)}</td>
    <td>${esc(relative(u.lastLoginAt))}${u.activeSessions ? `<br><span class="faint">${u.activeSessions} active session${u.activeSessions === 1 ? '' : 's'}</span>` : ''}</td>
    <td class="mono">${esc(fmtDate(u.createdAt))}</td>
    <td class="num"><span class="row-actions">${actions}</span></td>
  </tr>`;
}

async function loadAudit() {
  try {
    const { data } = await api('/admin/audit?limit=50');
    $('#admin-audit').innerHTML = data.length
      ? data.map((a) => `<li><span><strong>${esc(a.adminEmail)}</strong> ${esc(ACTION_LABELS[a.action] || a.action)} <strong>${esc(a.targetEmail)}</strong></span><span class="faint mono">${esc(fmtDateTime(a.createdAt))}</span></li>`).join('')
      : '<li class="faint">No admin actions yet.</li>';
  } catch { /* non-critical */ }
}

function confirmAction(title, text, okLabel) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true }));
}

async function runAction(action, user) {
  const refresh = () => Promise.all([loadUsers(), loadStats(), loadAudit()]);
  try {
    if (action === 'reset') {
      if (!(await confirmAction('Reset password?', `${user.email} will get a link to choose a new password. Their current password keeps working until they use it.`, 'Send reset'))) return;
      const { data } = await api(`/admin/users/${user.id}/password-reset`, { method: 'POST' });
      if (data.emailed) {
        toast(`Reset link emailed to ${user.email}`);
      } else {
        $('#reset-link-sub').textContent = user.email;
        $('#reset-link-url').value = data.link;
        $('#reset-link-dialog').showModal();
      }
    } else if (action === 'unlock') {
      await api(`/admin/users/${user.id}/unlock`, { method: 'POST' });
      toast(`Unlocked ${user.email}`);
    } else if (action === 'sign-out') {
      if (!(await confirmAction('Sign out everywhere?', `${user.email} will be signed out on every device.`, 'Sign out'))) return;
      await api(`/admin/users/${user.id}/sign-out`, { method: 'POST' });
      toast(`Signed out ${user.email} everywhere`);
    } else if (action === 'disable') {
      if (!(await confirmAction('Disable account?', `${user.email} will be signed out and won't be able to sign in, get reminders or use their calendar link until you re-enable the account. Their data is kept.`, 'Disable'))) return;
      await api(`/admin/users/${user.id}/disable`, { method: 'POST' });
      toast(`Disabled ${user.email}`);
    } else if (action === 'enable') {
      await api(`/admin/users/${user.id}/enable`, { method: 'POST' });
      toast(`Enabled ${user.email}`);
    } else if (action === 'delete') {
      const form = $('#admin-delete-form');
      form.reset();
      showFormError(form, null);
      form.elements.id.value = user.id;
      $('#admin-delete-email').textContent = user.email;
      $('#admin-delete-dialog').showModal();
      return;
    }
    await refresh();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

export function initAdmin() {
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-admin-action],[data-admin-page],[data-action="copy-reset-link"]');
    if (!t) return;
    if (t.dataset.action === 'copy-reset-link') {
      return toast((await copyText($('#reset-link-url').value)) ? 'Link copied' : 'Copy failed');
    }
    if (t.dataset.adminPage) {
      state.page = Math.min(state.totalPages, Math.max(1, state.page + Number(t.dataset.adminPage)));
      return loadUsers();
    }
    const user = state.users.find((u) => u.id === t.dataset.id);
    if (user) runAction(t.dataset.adminAction, user);
  });

  let timer;
  $('#admin-search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value.trim(); state.page = 1; loadUsers(); }, 250);
  });
  $('#admin-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; loadUsers(); });
  $('#admin-role').addEventListener('change', (e) => { state.role = e.target.value; state.page = 1; loadUsers(); });

  $('#admin-delete-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { id, confirmEmail } = formData(form);
    busy(form, async () => {
      try {
        await api(`/admin/users/${id}`, { method: 'DELETE', body: { confirmEmail } });
        $('#admin-delete-dialog').close();
        toast('Account deleted');
        await Promise.all([loadUsers(), loadStats(), loadAudit()]);
      } catch (err) {
        showFormError(form, err);
      }
    });
  });
}
