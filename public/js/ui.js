/** Small DOM helpers shared by the views. All user content goes through esc(). */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="/icons.svg#i-${name}"/></svg>`;

let toastTimer;
export function toast(message, { error = false, action, onAction, duration = 3500 } = {}) {
  const el = $('#toast');
  $('#toast-msg').textContent = message;
  el.classList.toggle('error', error);
  el.querySelector('use').setAttribute('href', `/icons.svg#i-${error ? 'circle-alert' : 'circle-check'}`);
  const btn = $('#toast-action');
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action;
    btn.onclick = () => {
      el.classList.remove('show');
      onAction?.();
    };
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? Math.max(duration, 6000) : duration);
}

/** Show an error message inside a form (and mark invalid fields from API details). */
export function showFormError(form, err) {
  const box = $('.form-error', form);
  $$('[aria-invalid]', form).forEach((i) => i.removeAttribute('aria-invalid'));
  if (!err) {
    if (box) box.hidden = true;
    return;
  }
  for (const d of err.details || []) {
    const input = d.field && form.elements.namedItem(d.field);
    if (input?.setAttribute) input.setAttribute('aria-invalid', 'true');
  }
  if (box) {
    box.textContent = err.message || 'Something went wrong';
    box.hidden = false;
  }
}

/** Disable a form's submit button while `fn` runs. */
export async function busy(form, fn) {
  const btn = form.querySelector('[type="submit"]');
  const prev = btn?.disabled;
  if (btn) btn.disabled = true;
  form.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    if (btn) btn.disabled = prev;
    form.removeAttribute('aria-busy');
  }
}

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

/** Rough password strength (0..4) for the meter — guidance only; the server enforces rules. */
export function passwordScore(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) s++;
  if (/^(.)\1+$/.test(pw) || /^(password|1234567890|qwerty)/i.test(pw)) s = 0;
  return Math.min(4, s);
}

export function wireStrengthMeter(input) {
  const bar = input.closest('.field')?.querySelector('.strength > span');
  if (!bar) return;
  const colors = ['var(--red-solid)', 'var(--red-solid)', 'var(--amber-solid)', 'var(--green-solid)', 'var(--green-solid)'];
  input.addEventListener('input', () => {
    const s = passwordScore(input.value);
    bar.style.width = `${input.value ? Math.max(10, s * 25) : 0}%`;
    bar.style.backgroundColor = colors[s];
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
