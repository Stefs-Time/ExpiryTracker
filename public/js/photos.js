/**
 * Document photos in the browser: re-encode, AI scan (with consent), pending
 * photo in the item dialog, photo grid for existing items, and the viewer.
 *
 * Privacy: photos are re-encoded through a <canvas> before upload, which
 * drops EXIF metadata (GPS, device) at the source; the server strips it again.
 */
import { api, features } from './api.js';
import { $, esc, icon, toast } from './ui.js';
import { CATEGORIES, formatDate } from './shared/expiry.js';

const MAX_SIDE = 2000; // px: enough to read small print, keeps uploads ~0.3–1.5 MB
const MAX_INPUT_BYTES = 30 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 3.8 * 1024 * 1024;

let pending = null; // { blob, url, width, height }

/** Decode any browser-supported image, fix orientation, downscale, and encode as JPEG. */
export async function prepareImage(file) {
  if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('Choose a photo (JPEG, PNG or WebP).');
  if (file.size > MAX_INPUT_BYTES) throw new Error('That photo is too large (over 30 MB).');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("Your browser can't open this photo format. Try a JPEG or PNG. On iPhone: Settings → Camera → Formats → Most Compatible.");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // flatten transparency (PNG) onto white
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  for (const quality of [0.85, 0.75, 0.6]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_UPLOAD_BYTES) return { blob, width, height };
  }
  throw new Error('That photo is too detailed to upload. Try a smaller one.');
}

/* ---------------- Consent ---------------- */

function askConsent() {
  const dlg = $('#consent-dialog');
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'agree'), { once: true }));
}

async function ensureConsent(user) {
  if (user.aiScanConsent) return true;
  if (!(await askConsent())) return false;
  const { data } = await api('/account/scan-consent', { method: 'PUT', body: { consent: true } });
  user.aiScanConsent = data.aiScanConsent;
  return true;
}

/* ---------------- Item dialog: pending photo + scan ---------------- */

function setStatus(html, tone = '') {
  const el = $('#scan-status');
  el.className = `scan-status ${tone}`;
  el.innerHTML = html;
  el.hidden = !html;
}

export function resetPhotoUI({ editing }) {
  discardPending();
  setStatus('');
  $('#scan-box').hidden = !(features.scanEnabled || features.attachmentsEnabled);
  $('#photo-btn-label').textContent = features.scanEnabled ? 'Scan or add a photo' : 'Add a photo';
  $('#scan-hint').textContent = features.scanEnabled
    ? (editing ? 'Scan a new card to update the expiry date. You check before saving.' : "We'll read the expiry date for you. You check every field before saving.")
    : 'Keep a digital copy of this document.';
  $('#keep-photo-row').hidden = !features.attachmentsEnabled;
  $('#item-photos').hidden = true;
  $('#photo-grid').innerHTML = '';
}

function discardPending() {
  if (pending?.url) URL.revokeObjectURL(pending.url);
  pending = null;
  $('#pending-photo').hidden = true;
  $('#pending-img').removeAttribute('src');
  $('#photo-input').value = '';
}

const FIELD_ORDER = ['title', 'category', 'ref', 'expiryDate', 'cycleMonths', 'leadDays'];

function applySuggestion(form, s, { editing }) {
  const filled = [];
  for (const key of FIELD_ORDER) {
    const value = s[key];
    if (value === null || value === undefined || value === '') continue;
    // When editing, only update what a new card changes: expiry date and reference.
    if (editing && !['expiryDate', 'ref'].includes(key)) continue;
    const el = form.elements[key];
    if (!el) continue;
    if (key === 'cycleMonths' && ![...el.options].some((o) => o.value === String(value))) el.add(new Option(`${value} months`, value));
    el.value = String(value);
    el.classList.add('ai-filled');
    filled.push(key);
  }
  if (!editing) form.dataset.touchedCycle = '1'; // keep the scanned cycle if the category changes
  return filled;
}

async function onPhotoChosen(file, ctx) {
  const form = $('#item-form');
  setStatus(`${icon('loader-circle', 'icon icon-sm spin')} Preparing photo…`);
  let prepared;
  try {
    prepared = await prepareImage(file);
  } catch (err) {
    setStatus(esc(err.message), 'error');
    return;
  }
  discardPending();
  pending = { ...prepared, url: URL.createObjectURL(prepared.blob) };
  $('#pending-img').src = pending.url;
  $('#pending-photo').hidden = !features.attachmentsEnabled && !features.scanEnabled;
  $('#keep-photo').checked = features.attachmentsEnabled;

  if (!features.scanEnabled) {
    setStatus('');
    return;
  }
  try {
    if (!(await ensureConsent(ctx.user))) {
      setStatus('Photo added without reading it. Fill in the details yourself.');
      return;
    }
  } catch (err) {
    setStatus(esc(err.message), 'error');
    return;
  }

  setStatus(`${icon('loader-circle', 'icon icon-sm spin')} Reading your document…`);
  form.setAttribute('aria-busy', 'true');
  try {
    const { data } = await api('/scan', { method: 'POST', raw: pending.blob, contentType: 'image/jpeg' });
    const filled = applySuggestion(form, data.suggestion, { editing: ctx.editing });
    const cat = CATEGORIES[data.suggestion.category]?.label || 'document';
    const missingExpiry = !data.suggestion.expiryDate;
    const low = data.confidence < 0.6;
    const parts = [
      `${icon('sparkles', 'icon icon-sm')} <strong>Filled ${filled.length} field${filled.length === 1 ? '' : 's'} from your photo</strong> (looks like a ${esc(cat.toLowerCase())}).`,
      missingExpiry ? ' <strong>No expiry date found. Please enter it.</strong>' : ` Expiry read as <strong>${esc(formatDate(data.suggestion.expiryDate))}</strong>.`,
      low && !missingExpiry ? ' The photo was hard to read, so double-check the date.' : '',
      ' Check every field before saving.',
      data.notes ? `<br><span class="faint">Note: ${esc(data.notes)}</span>` : '',
    ];
    setStatus(parts.join(''), missingExpiry || low ? 'warn' : 'ok');
    (missingExpiry ? form.elements.expiryDate : form.elements.title).focus();
  } catch (err) {
    setStatus(`${esc(err.message)} Your photo is still attached below.`, 'error');
  } finally {
    form.removeAttribute('aria-busy');
  }
}

/** Upload the pending photo after the item is saved (if the user kept it). */
export async function uploadPendingFor(itemId) {
  if (!pending || !features.attachmentsEnabled || !$('#keep-photo').checked) return null;
  const label = $('#pending-label').value;
  try {
    const { data } = await api(`/items/${itemId}/attachments?label=${encodeURIComponent(label)}`, {
      method: 'POST', raw: pending.blob, contentType: 'image/jpeg',
    });
    return data;
  } catch (err) {
    toast(`Item saved, but the photo wasn't: ${err.message}`, { error: true, duration: 7000 });
    return null;
  } finally {
    discardPending();
  }
}

/* ---------------- Existing photos (edit dialog) ---------------- */

const LABELS = { front: 'Front', back: 'Back', other: 'Other' };

function photoTile(p, title, { removable }) {
  return `<li class="photo-tile">
    <a href="${esc(p.url)}" target="_blank" rel="noopener" title="Open full size">
      <img src="${esc(p.url)}" alt="${esc(LABELS[p.label])} of ${esc(title)}" loading="lazy" width="${Number(p.width) || ''}" height="${Number(p.height) || ''}">
    </a>
    <span class="photo-meta"><span>${esc(LABELS[p.label])}</span>
      ${removable ? `<button type="button" class="icon-btn danger" data-action="delete-photo" data-id="${esc(p.id)}" data-item="${esc(p.itemId)}" aria-label="Delete ${esc(LABELS[p.label].toLowerCase())} photo">${icon('trash-2')}</button>` : ''}
    </span>
  </li>`;
}

export async function loadItemPhotos(item) {
  if (!features.attachmentsEnabled || !item?.attachmentCount) return;
  try {
    const { data } = await api(`/items/${item.id}/attachments`);
    $('#photo-grid').innerHTML = data.map((p) => photoTile(p, item.title, { removable: true })).join('');
    $('#item-photos').hidden = !data.length;
  } catch { /* non-critical */ }
}

/* ---------------- Viewer ---------------- */

export async function openPhotoViewer(item) {
  const dlg = $('#photo-dialog');
  $('#photo-dialog-title').textContent = item.title;
  const box = $('#photo-viewer');
  box.innerHTML = `<p class="muted">${icon('loader-circle', 'icon icon-sm spin')} Loading…</p>`;
  dlg.showModal();
  try {
    const { data } = await api(`/items/${item.id}/attachments`);
    box.innerHTML = data.length
      ? `<ul class="photo-grid large">${data.map((p) => photoTile(p, item.title, { removable: false })).join('')}</ul>`
      : '<p class="muted">No photos yet. Edit the item to add one.</p>';
  } catch (err) {
    box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}

/* ---------------- Wiring ---------------- */

export function initPhotos(ctx) {
  $('#photo-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) onPhotoChosen(file, { user: ctx.getUser(), editing: Boolean($('#item-form').elements.id.value) });
  });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action="discard-photo"],[data-action="delete-photo"]');
    if (!t) return;
    if (t.dataset.action === 'discard-photo') {
      discardPending();
      setStatus('');
      return;
    }
    const { confirmDialog } = await import('./ui.js');
    if (!(await confirmDialog({ title: 'Delete photo?', text: 'This digital copy will be permanently deleted.', ok: 'Delete', tone: 'danger' }))) return;
    try {
      await api(`/items/${t.dataset.item}/attachments/${t.dataset.id}`, { method: 'DELETE' });
      t.closest('.photo-tile').remove();
      $('#item-photos').hidden = !$('#photo-grid').children.length;
      ctx.onPhotosChanged();
      toast('Photo deleted');
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  // Clear AI highlights once the user edits a field.
  $('#item-form').addEventListener('input', (e) => e.target.classList?.remove('ai-filled'));
  $('#item-dialog').addEventListener('close', () => discardPending());
}
