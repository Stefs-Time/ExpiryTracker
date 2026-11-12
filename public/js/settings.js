/** Settings view: profile/thresholds, calendar feed, password, import/export, account deletion. */
import { api, setCsrfToken } from './api.js';
import { $, toast, showFormError, busy, formData, copyText } from './ui.js';

let ctx; // { getUser, setUser, onSignedOut, reloadItems }

function timezones() {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Africa/Johannesburg', 'UTC', 'Europe/London', 'America/New_York', 'Australia/Sydney'];
  }
}

export async function showSettings() {
  const form = $('#form-profile');
  showFormError(form, null);
  const sel = $('#tz-select');
  if (!sel.options.length) sel.innerHTML = timezones().map((z) => `<option>${z}</option>`).join('');
  let account;
  try {
    account = (await api('/account')).data;
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
    return;
  }
  if (![...sel.options].some((o) => o.value === account.timezone)) sel.add(new Option(account.timezone));
  form.elements.displayName.value = account.displayName;
  form.elements.timezone.value = account.timezone;
  form.elements.criticalDays.value = account.criticalDays;
  form.elements.warningDays.value = account.warningDays;
  form.elements.emailReminders.checked = account.emailReminders;
  $('#mail-hint').hidden = account.mailConfigured;
  renderFeedState(account.hasCalendarFeed);
}

function renderFeedState(active, url) {
  $('#feed-box').hidden = !url;
  if (url) $('#feed-url').value = url;
  $('#feed-status').textContent = active ? (url ? '' : 'A subscription link is active.') : 'No subscription link yet.';
  $('#rotate-feed-label').textContent = active ? 'Generate new link' : 'Create subscription link';
  $('[data-action="revoke-feed"]').hidden = !active;
}

async function saveProfile(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const f = formData(form);
  const body = {
    displayName: f.displayName.trim(),
    timezone: f.timezone,
    criticalDays: Number(f.criticalDays),
    warningDays: Number(f.warningDays),
    emailReminders: form.elements.emailReminders.checked,
  };
  if (body.warningDays <= body.criticalDays) {
    return showFormError(form, { message: 'The "expiring soon" window must be longer than the critical window.', details: [{ field: 'warningDays' }] });
  }
  await busy(form, async () => {
    try {
      const { data } = await api('/account', { method: 'PATCH', body });
      showFormError(form, null);
      ctx.setUser(data);
      toast('Settings saved');
    } catch (err) {
      showFormError(form, err);
    }
  });
}

async function changePassword(e) {
  e.preventDefault();
  const form = e.currentTarget;
  await busy(form, async () => {
    try {
      const { data } = await api('/account/password', { method: 'POST', body: formData(form) });
      setCsrfToken(data.csrfToken);
      form.reset();
      showFormError(form, null);
      toast('Password updated. Other devices were signed out.');
    } catch (err) {
      showFormError(form, err);
    }
  });
}

async function deleteAccount(e) {
  e.preventDefault();
  const form = e.currentTarget;
  if (!window.confirm('Permanently delete your account and all items?')) return;
  await busy(form, async () => {
    try {
      await api('/account', { method: 'DELETE', body: formData(form) });
      form.reset();
      toast('Your account has been deleted');
      ctx.onSignedOut();
    } catch (err) {
      showFormError(form, err);
    }
  });
}

async function importFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 900_000) return toast('That file is too large to import', { error: true });
  try {
    const json = JSON.parse(await file.text());
    const items = Array.isArray(json) ? json : json.items;
    if (!Array.isArray(items)) throw new Error('No items found in that file');
    const { data } = await api('/items/import', { method: 'POST', body: { items } });
    toast(`Imported ${data.imported} item${data.imported === 1 ? '' : 's'}${data.skipped ? `, skipped ${data.skipped} duplicate${data.skipped === 1 ? '' : 's'}` : ''}`);
    ctx.reloadItems();
  } catch (err) {
    toast(err instanceof SyntaxError ? 'That file is not valid JSON' : err.message, { error: true });
  }
}

export function initSettings(context) {
  ctx = context;
  $('#form-profile').addEventListener('submit', saveProfile);
  $('#form-password').addEventListener('submit', changePassword);
  $('#form-delete').addEventListener('submit', deleteAccount);
  $('#import-file').addEventListener('change', importFile);

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    if (t.dataset.action === 'rotate-feed') {
      if (ctx.getUser().hasCalendarFeed && !window.confirm('Generate a new link? Calendars using the old link will stop updating.')) return;
      try {
        const { data } = await api('/account/calendar-token', { method: 'POST' });
        ctx.setUser({ ...ctx.getUser(), hasCalendarFeed: true });
        renderFeedState(true, data.url);
      } catch (err) {
        toast(err.message, { error: true });
      }
    }
    if (t.dataset.action === 'revoke-feed') {
      try {
        await api('/account/calendar-token', { method: 'DELETE' });
        ctx.setUser({ ...ctx.getUser(), hasCalendarFeed: false });
        renderFeedState(false);
        toast('Calendar link turned off');
      } catch (err) {
        toast(err.message, { error: true });
      }
    }
    if (t.dataset.action === 'copy-feed') {
      toast((await copyText($('#feed-url').value)) ? 'Link copied' : 'Copy failed');
    }
  });
}
