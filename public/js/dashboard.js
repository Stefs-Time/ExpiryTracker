/** Dashboard: banner, KPIs, filters, cards, item/renew/confirm dialogs and the status report. */
import { api } from './api.js';
import { initPhotos, resetPhotoUI, loadItemPhotos, uploadPendingFor, openPhotoViewer } from './photos.js';
import { $, $$, esc, icon, toast, showFormError, busy, formData, copyText, confirmDialog } from './ui.js';
import {
  CATEGORIES, CATEGORY_KEYS, summarise, formatDate, formatCycle, suggestRenewalDate, addMonths, isISODate, plainTextReport,
} from './shared/expiry.js';

const state = { items: [], today: null, filter: 'all', q: '', category: '', loaded: false, user: null, offline: false };

const TEMPLATES = [
  { title: 'Car licence disc', category: 'Vehicle' },
  { title: "Driver's licence card", category: 'License' },
  { title: 'Firearm licence', category: 'Firearm' },
  { title: 'Bank card', category: 'Banking' },
  { title: 'Passport', category: 'Identity' },
];

const thresholds = () => ({ criticalDays: state.user.criticalDays, warningDays: state.user.warningDays });

export function setUser(user, today) {
  state.user = user;
  state.today = today;
}

export function resetDashboard() {
  state.items = [];
  state.loaded = false;
  state.filter = 'all';
  state.q = '';
  state.category = '';
}

export async function loadItems() {
  const grid = $('#cards-grid');
  if (!state.loaded) {
    grid.innerHTML = '<div class="card skeleton"></div>'.repeat(3);
    grid.setAttribute('aria-busy', 'true');
  }
  try {
    const all = [];
    let page = 1;
    let offline = false;
    for (;;) {
      const res = await api(`/items?limit=500&page=${page}`);
      all.push(...res.data);
      offline ||= res.offline;
      if (page >= res.meta.totalPages) break;
      page += 1;
    }
    state.items = all;
    state.loaded = true;
    state.offline = offline;
    $('#sync-status').textContent = offline ? 'Offline copy' : 'Synced';
    $('#sync-dot').classList.toggle('offline', offline);
  } catch (err) {
    if (err.status === 401) return;
    state.loaded = true;
    toast(err.message, { error: true });
  } finally {
    grid.setAttribute('aria-busy', 'false');
  }
  render();
}

/* ---------------- Rendering ---------------- */

export function render() {
  if (!state.user) return;
  const { items, counts } = summarise(state.items, state.today, thresholds());
  const { criticalDays, warningDays } = thresholds();

  $('#stat-total').textContent = counts.total;
  $('#stat-critical').textContent = counts.critical;
  $('#stat-soon').textContent = counts.soon;
  $('#stat-valid').textContent = counts.valid;
  $('#stat-critical-hint').textContent = `≤ ${criticalDays} days / overdue`;
  $('#stat-soon-hint').textContent = `${criticalDays + 1} – ${warningDays} days`;
  $('#stat-valid-hint').textContent = `> ${warningDays} days`;
  $('#today-chip').textContent = formatDate(state.today).toUpperCase();
  $('#footer-today').textContent = state.today;

  renderBanner(items, counts);

  const q = state.q.trim().toLowerCase();
  const filtered = items.filter((i) => {
    if (state.filter !== 'all' && i.status !== state.filter) return false;
    if (state.category && i.category !== state.category) return false;
    if (!q) return true;
    const label = CATEGORIES[i.category]?.label || '';
    return [i.title, i.ref, i.note, i.category, label].some((v) => v && v.toLowerCase().includes(q));
  });

  $$('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));

  const grid = $('#cards-grid');
  const empty = $('#empty-state');
  // Remember which card control had focus so keyboard users don't get dumped on <body>.
  const active = document.activeElement;
  const focusKey = active && grid.contains(active) && active.dataset.id
    ? { id: active.dataset.id, action: active.dataset.action }
    : lastFocusKey;
  lastFocusKey = null;
  if (!filtered.length) {
    grid.innerHTML = '';
    empty.hidden = !state.loaded;
    const fresh = !state.items.length;
    $('#empty-title').textContent = fresh ? 'Nothing tracked yet' : 'No matching items';
    $('#empty-text').textContent = fresh
      ? 'Add your first licence, card or document. Pick a quick start or add your own.'
      : 'Try clearing your search or filters.';
    $('#empty-actions').innerHTML = fresh
      ? `<button type="button" class="btn btn-primary" data-action="add-item">${icon('plus', 'icon icon-sm')}Add item</button>
         <div class="quick-adds">${TEMPLATES.map((t, n) => `<button type="button" class="btn btn-sm" data-template="${n}">${icon(CATEGORIES[t.category].icon, 'icon icon-sm')}${esc(t.title)}</button>`).join('')}</div>`
      : '<button type="button" class="btn" data-action="reset-filters">Reset filters</button>';
  } else {
    empty.hidden = true;
    grid.innerHTML = filtered.map(cardHTML).join('');
    // Widths are applied via CSSOM (allowed by CSP) rather than inline style attributes.
    $$('.bar > span', grid).forEach((s) => { s.style.width = `${s.dataset.pct}%`; });
  }
  if (focusKey && (document.activeElement === document.body || !document.activeElement)) {
    const target = grid.querySelector(`[data-id="${CSS.escape(focusKey.id)}"][data-action="${focusKey.action}"]`)
      || grid.querySelector('[data-action]')
      || $('header [data-action="add-item"]');
    target?.focus({ preventScroll: false });
  }
}

/** Set by actions that are about to re-render, so render() can restore focus after dialogs close. */
let lastFocusKey = null;
function rememberFocus(id, action) { lastFocusKey = { id, action }; }

function renderBanner(items, counts) {
  const banner = $('#banner');
  const critical = items.filter((i) => i.status === 'critical');
  const soon = items.filter((i) => i.status === 'soon');
  const setIcon = (name) => $('.banner-icon use', banner).setAttribute('href', `/icons.svg#i-${name}`);
  const headline = $('#banner-headline');
  const text = $('#banner-text');
  banner.className = 'banner';

  if (!counts.total) {
    banner.classList.add('is-empty');
    setIcon('shield-check');
    headline.textContent = 'Welcome to your vault';
    text.textContent = 'Add the licences, cards and documents you want to keep valid. We\'ll tell you when they need attention.';
  } else if (critical.length) {
    banner.classList.add('is-critical');
    setIcon('circle-alert');
    headline.textContent = `${critical.length} critical ${critical.length === 1 ? 'item needs' : 'items need'} attention`;
    const names = critical.slice(0, 4).map((c) => `${esc(c.title)} (${esc(c.label.toLowerCase())})`).join(' • ');
    const more = critical.length > 4 ? ` • +${critical.length - 4} more` : '';
    text.innerHTML = `<span class="priority">Priority:</span> ${names}${more}.${soon.length ? ` ${soon.length} more expiring within ${thresholds().warningDays} days.` : ''}`;
  } else if (soon.length) {
    banner.classList.add('is-soon');
    setIcon('clock');
    headline.textContent = `${soon.length} upcoming renewal${soon.length === 1 ? '' : 's'} within ${thresholds().warningDays} days`;
    text.textContent = `Nothing is critical. Plan ahead for ${soon.slice(0, 4).map((s) => s.title).join(', ')}${soon.length > 4 ? '…' : '.'}`;
  } else {
    banner.classList.add('is-valid');
    setIcon('shield-check');
    headline.textContent = 'Everything is up to date';
    const next = items[0];
    text.textContent = `All ${counts.total} tracked item${counts.total === 1 ? ' is' : 's are'} valid. Next expiry: ${next.title} on ${formatDate(next.expiryDate)}.`;
  }
}

function cardHTML(i) {
  const cat = CATEGORIES[i.category] || CATEGORIES.Other;
  const barLabel = i.expired ? 'Overdue' : 'Validity remaining';
  const id = esc(i.id);
  return `
  <article class="card ${i.status}" data-id="${id}">
    <div>
      <div class="card-head">
        <span class="card-cat"><span class="cat-icon">${icon(cat.icon)}</span><span class="cat-label">${esc(cat.label)}</span></span>
        <span class="card-actions">
          <button type="button" class="icon-btn renew" data-action="renew" data-id="${id}" aria-label="Mark ${esc(i.title)} as renewed" title="Mark as renewed">${icon('rotate-cw')}</button>
          <button type="button" class="icon-btn" data-action="edit" data-id="${id}" aria-label="Edit ${esc(i.title)}" title="Edit">${icon('pencil')}</button>
          <button type="button" class="icon-btn danger" data-action="delete" data-id="${id}" aria-label="Delete ${esc(i.title)}" title="Delete">${icon('trash-2')}</button>
        </span>
      </div>
      <h2>${esc(i.title)}</h2>
      <div class="card-meta">
        ${i.ref ? `<span class="ref">${esc(i.ref)}</span>` : ''}
        <span class="cycle">${esc(formatCycle(i.cycleMonths))} CYCLE</span>
        ${i.attachmentCount ? `<button type="button" class="photo-chip" data-action="photos" data-id="${id}" aria-label="View ${i.attachmentCount} photo${i.attachmentCount === 1 ? '' : 's'} of ${esc(i.title)}">${icon('image', 'icon icon-sm')}${i.attachmentCount}</button>` : ''}
      </div>
      ${i.note ? `<p class="card-note">${esc(i.note)}</p>` : ''}
      ${i.renewalWindowOpen && i.status !== 'critical' ? `<span class="window-flag">${icon('clock', 'icon icon-sm')}Renewal window open — start now</span>` : ''}
    </div>
    <div class="card-foot">
      <div class="foot-row"><span class="muted">Expires</span><span class="date">${esc(formatDate(i.expiryDate).toUpperCase())}</span></div>
      <div class="bar" role="img" aria-label="${esc(barLabel)}: ${i.remainingPct}%"><span data-pct="${Number(i.remainingPct)}"></span></div>
      <div class="foot-row"><span class="bar-label">${barLabel}</span><span class="badge ${i.status}">${esc(i.label)}</span></div>
    </div>
  </article>`;
}

/* ---------------- Item dialog ---------------- */

function fillCategorySelects() {
  const opts = CATEGORY_KEYS.map((k) => `<option value="${k}">${esc(CATEGORIES[k].label)}</option>`).join('');
  $('#field-category').innerHTML = opts;
  $('#category-filter').innerHTML = `<option value="">All types</option>${opts}`;
}

function ensureOption(select, value, label) {
  if (![...select.options].some((o) => o.value === String(value))) select.add(new Option(label, value));
}

export function openItemDialog(item = null, template = null) {
  if (state.offline || !navigator.onLine) return toast("You're offline — changes are disabled.", { error: true });
  const dlg = $('#item-dialog');
  const form = $('#item-form');
  form.reset();
  showFormError(form, null);
  const editing = Boolean(item);
  $('#item-dialog-title').textContent = editing ? 'Edit item' : 'Track new expiry';
  $('#item-submit').textContent = editing ? 'Save changes' : 'Save item';
  const src = item || {
    title: template?.title || '',
    category: template?.category || 'Vehicle',
    ref: '',
    expiryDate: addMonths(state.today, 12),
    note: '',
  };
  const cat = CATEGORIES[src.category] || CATEGORIES.Other;
  form.elements.id.value = item?.id || '';
  form.elements.title.value = src.title;
  form.elements.category.value = src.category;
  form.elements.ref.value = src.ref || '';
  form.elements.expiryDate.value = src.expiryDate;
  const cycle = src.cycleMonths ?? cat.defaultCycle;
  ensureOption(form.elements.cycleMonths, cycle, `${cycle} months`);
  form.elements.cycleMonths.value = String(cycle);
  form.elements.leadDays.value = String(src.leadDays ?? cat.defaultLead);
  form.elements.note.value = src.note || '';
  form.dataset.touchedCycle = editing ? '1' : '';
  $$('.ai-filled', form).forEach((el) => el.classList.remove('ai-filled'));
  resetPhotoUI({ editing, photoCount: item?.attachmentCount || 0 });
  dlg.showModal();
  form.elements.title.focus();
  if (editing) loadItemPhotos(item);
}

async function submitItem(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const f = formData(form);
  const body = {
    title: f.title.trim(),
    category: f.category,
    ref: f.ref.trim(),
    expiryDate: f.expiryDate,
    cycleMonths: Number(f.cycleMonths),
    leadDays: Number(f.leadDays),
    note: f.note.trim(),
  };
  if (!body.title) return showFormError(form, { message: 'Give it a title', details: [{ field: 'title' }] });
  if (!isISODate(body.expiryDate)) return showFormError(form, { message: 'Choose a valid expiry date', details: [{ field: 'expiryDate' }] });
  if (/\d{10,}/.test(body.ref.replace(/[\s-]/g, ''))) {
    return showFormError(form, { message: 'Store a masked reference only (e.g. •••• 4821) — never a full card or ID number.', details: [{ field: 'ref' }] });
  }
  await busy(form, async () => {
    try {
      let saved;
      if (f.id) {
        rememberFocus(f.id, 'edit');
        const { data } = await api(`/items/${f.id}`, { method: 'PATCH', body });
        saved = data;
        state.items = state.items.map((i) => (i.id === data.id ? data : i));
      } else {
        const { data } = await api('/items', { method: 'POST', body });
        saved = data;
        state.items.push(data);
      }
      // Upload the kept photo before closing (closing the dialog discards it).
      const photo = await uploadPendingFor(saved.id);
      const verb = f.id ? 'Updated' : 'Now tracking';
      if (photo.error) {
        toast(`${verb} "${saved.title}", but the photo wasn't saved: ${photo.error}`, { error: true, duration: 9000 });
      } else {
        toast(`${verb} "${saved.title}"${photo.uploaded ? ' with its photo' : ''}`);
      }
      $('#item-dialog').close();
      render();
      loadItems(); // re-sync (also refreshes the offline copy)
    } catch (err) {
      showFormError(form, err);
    }
  });
}

/* ---------------- Draft kept across a session expiry ---------------- */

const DRAFT_KEY = 'vx-item-draft';
const DRAFT_FIELDS = ['id', 'title', 'category', 'ref', 'expiryDate', 'cycleMonths', 'leadDays', 'note'];

/** Called when the session ends: keep an open, unsaved item form for this tab (per user). */
export function stashDraft() {
  const dlg = $('#item-dialog');
  if (!dlg.open || !state.user) return;
  const form = $('#item-form');
  const values = Object.fromEntries(DRAFT_FIELDS.map((k) => [k, form.elements[k]?.value ?? '']));
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ userId: state.user.id, savedAt: Date.now(), values }));
  } catch { /* storage unavailable: nothing to keep */ }
}

/** After sign-in, offer to reopen a draft that belongs to this user (max 2 hours old). */
export function offerDraft() {
  let draft;
  try {
    draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
    sessionStorage.removeItem(DRAFT_KEY);
  } catch { return; }
  if (!draft || draft.userId !== state.user?.id || Date.now() - draft.savedAt > 2 * 3600_000) return;
  const v = draft.values;
  toast(`You had unsaved changes to "${v.title || 'an item'}" when you were signed out.`, {
    action: 'Restore',
    duration: 15_000,
    onAction: () => {
      const existing = v.id ? state.items.find((i) => i.id === v.id) : null;
      openItemDialog(existing || null);
      const form = $('#item-form');
      for (const k of DRAFT_FIELDS) {
        if (k === 'id' && !existing) continue;
        const el = form.elements[k];
        if (!el) continue;
        if (k === 'cycleMonths' && ![...el.options].some((o) => o.value === v[k])) el.add(new Option(`${v[k]} months`, v[k]));
        el.value = v[k];
      }
    },
  });
}

/* ---------------- Renew dialog ---------------- */

async function openRenewDialog(item) {
  if (state.offline || !navigator.onLine) return toast("You're offline — changes are disabled.", { error: true });
  const form = $('#renew-form');
  form.reset();
  showFormError(form, null);
  form.elements.id.value = item.id;
  const suggested = suggestRenewalDate(item, state.today);
  form.elements.newExpiryDate.value = suggested;
  $('#renew-sub').textContent = item.title;
  $('#renew-hint').textContent = `Suggested: one ${formatCycle(item.cycleMonths)} cycle from ${item.expiryDate > state.today ? 'the current expiry' : 'today'}. Adjust to match the new card or disc.`;
  const list = $('#renew-history');
  list.innerHTML = '';
  $('#renew-dialog').showModal();
  try {
    const { data } = await api(`/items/${item.id}/renewals`);
    list.innerHTML = data.length
      ? `<li class="faint"><strong>Renewal history</strong></li>${data.map((r) => `<li><span class="mono">${esc(formatDate(r.previousExpiry))} → ${esc(formatDate(r.newExpiry))}</span><span class="faint">${esc(new Date(r.renewedAt).toLocaleDateString())}</span></li>`).join('')}`
      : '';
  } catch { /* history is optional */ }
}

async function submitRenew(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const { id, newExpiryDate } = formData(form);
  if (!isISODate(newExpiryDate)) return showFormError(form, { message: 'Choose a valid date', details: [{ field: 'newExpiryDate' }] });
  await busy(form, async () => {
    try {
      rememberFocus(id, 'renew');
      const { data } = await api(`/items/${id}/renew`, { method: 'POST', body: { newExpiryDate } });
      state.items = state.items.map((i) => (i.id === data.id ? data : i));
      $('#renew-dialog').close();
      render();
      loadItems();
      toast(`Renewed "${data.title}" until ${formatDate(data.expiryDate)}`);
    } catch (err) {
      showFormError(form, err);
    }
  });
}

/* ---------------- Delete with undo ---------------- */

async function deleteItem(item) {
  if (state.offline || !navigator.onLine) return toast("You're offline — changes are disabled.", { error: true });
  const photos = item.attachmentCount ? `, its ${item.attachmentCount} photo${item.attachmentCount === 1 ? '' : 's'}` : '';
  if (!(await confirmDialog({ title: 'Delete item?', text: `"${item.title}"${photos} and its renewal history will be deleted. You can undo straight after.`, ok: 'Delete', tone: 'danger' }))) return;
  rememberFocus(item.id, 'delete');
  try {
    await api(`/items/${item.id}`, { method: 'DELETE' });
    state.items = state.items.filter((i) => i.id !== item.id);
    render();
    loadItems();
    toast(`Removed "${item.title}"`, {
      action: 'Undo',
      onAction: async () => {
        try {
          // Restores the original item (same id, photos and renewal history).
          const { data } = await api(`/items/${item.id}/restore`, { method: 'POST' });
          state.items.push(data);
          render();
          toast(`Restored "${data.title}"`);
        } catch (err) {
          toast(err.message, { error: true });
        }
      },
    });
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* ---------------- Report ---------------- */

function openReport() {
  const { items, counts } = summarise(state.items, state.today, thresholds());
  $('#report-sub').textContent = `Generated ${formatDate(state.today)} • ${counts.total} items`;
  $('#report-summary').innerHTML = `
    <div class="critical"><small>Critical</small><strong>${counts.critical}</strong></div>
    <div class="soon"><small>Expiring soon</small><strong>${counts.soon}</strong></div>
    <div class="valid"><small>Healthy</small><strong>${counts.valid}</strong></div>`;
  $('#report-body').innerHTML = items.length
    ? items.map((i) => `<tr>
        <td><strong>${esc(i.title)}</strong><br><span class="faint">${esc(CATEGORIES[i.category]?.label || '')}</span></td>
        <td class="mono muted">${esc(i.ref || '—')}</td>
        <td class="mono">${esc(formatDate(i.expiryDate))}</td>
        <td class="num"><span class="badge ${i.status}">${esc(i.label)}</span></td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">No items tracked yet.</td></tr>';
  $('#report-plaintext').value = plainTextReport({ items, counts }, state.today);
  $('#report-dialog').showModal();
}

/* ---------------- Wiring ---------------- */

const byId = (id) => state.items.find((i) => i.id === id);

export function initDashboard() {
  fillCategorySelects();
  initPhotos({ getUser: () => state.user, onPhotosChanged: () => loadItems() });

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action],[data-filter],[data-template],[data-close]');
    if (!t) return;
    if (t.hasAttribute('data-close')) return t.closest('dialog')?.close();
    if (t.dataset.filter) {
      state.filter = t.dataset.filter;
      return render();
    }
    if (t.dataset.template) return openItemDialog(null, TEMPLATES[Number(t.dataset.template)]);
    const item = t.dataset.id ? byId(t.dataset.id) : null;
    switch (t.dataset.action) {
      case 'add-item': return openItemDialog();
      case 'edit': return item && openItemDialog(item);
      case 'renew': return item && openRenewDialog(item);
      case 'delete': return item && deleteItem(item);
      case 'open-report': return openReport();
      case 'photos': return item && openPhotoViewer(item);
      case 'copy-report':
        return toast((await copyText($('#report-plaintext').value)) ? 'Report copied to clipboard' : 'Copy failed', {});
      case 'print-report': return window.print();
      case 'reset-filters':
        state.filter = 'all';
        state.q = '';
        state.category = '';
        $('#search-input').value = '';
        $('#category-filter').value = '';
        return render();
      default: return undefined;
    }
  });

  let searchTimer;
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value; render(); }, 120);
  });
  $('#category-filter').addEventListener('change', (e) => { state.category = e.target.value; render(); });

  // Picking a category on a new item pre-fills sensible cycle / lead-time defaults.
  $('#field-category').addEventListener('change', (e) => {
    const form = $('#item-form');
    if (form.dataset.touchedCycle) return;
    const c = CATEGORIES[e.target.value];
    ensureOption(form.elements.cycleMonths, c.defaultCycle, `${c.defaultCycle} months`);
    form.elements.cycleMonths.value = String(c.defaultCycle);
    form.elements.leadDays.value = String(c.defaultLead);
  });
  $('#item-form').elements.cycleMonths.addEventListener('change', () => { $('#item-form').dataset.touchedCycle = '1'; });

  $('#item-form').addEventListener('submit', submitItem);
  $('#renew-form').addEventListener('submit', submitRenew);

  // Light-dismiss dialogs by clicking the backdrop.
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  // Keyboard shortcut: "n" adds an item, "/" focuses search.
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('#view-dashboard').hidden) return;
    if (e.key === 'n') { e.preventDefault(); openItemDialog(); }
    if (e.key === '/') { e.preventDefault(); $('#search-input').focus(); }
  });
}

