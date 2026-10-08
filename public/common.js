// Shared browser helpers.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const money = (cents, opts = {}) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: opts.cents ? 2 : 0 });

export function when(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

export function windowText(a, b) {
  if (a === b) return when(a);
  const hours = Math.round((new Date(b) - new Date(a)) / 36e5);
  return `${when(a)} (+${hours}h window)`;
}

export async function api(path, { method = 'GET', body, key, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  if (body !== undefined && !raw) h['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Request failed (${res.status})`);
    err.code = data?.error?.code;
    err.details = data?.error?.details;
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
export function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

/** Airport autocomplete on an input; stores the chosen code in input.dataset.code. */
export function airportPicker(input) {
  const box = document.createElement('div');
  box.className = 'ac-list';
  box.hidden = true;
  input.parentElement.classList.add('ac');
  input.parentElement.appendChild(box);
  let items = [];
  let idx = -1;
  const choose = (a) => {
    input.value = `${a.iata} · ${a.city}`;
    input.dataset.code = a.iata;
    box.hidden = true;
  };
  const render = () => {
    box.innerHTML = items.map((a, i) => `<div data-i="${i}" class="${i === idx ? 'on' : ''}"><b>${esc(a.iata)}</b>${esc(a.city)} <span class="faint">${esc(a.name)}</span></div>`).join('');
    box.hidden = items.length === 0;
  };
  input.addEventListener('input', async () => {
    input.dataset.code = '';
    const q = input.value.trim();
    if (!q) { items = []; render(); return; }
    items = await api(`/api/airports?q=${encodeURIComponent(q)}`);
    idx = items.length ? 0 : -1;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && idx >= 0) { choose(items[idx]); e.preventDefault(); }
    else if (e.key === 'Escape') box.hidden = true;
  });
  box.addEventListener('mousedown', (e) => {
    const el = e.target.closest('[data-i]');
    if (el) { choose(items[Number(el.dataset.i)]); e.preventDefault(); }
  });
  input.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 100));
  return {
    code: () => input.dataset.code || input.value.trim().split(/[\s·]/)[0].toUpperCase(),
    set: (code, label) => { input.dataset.code = code; input.value = label ?? code; },
  };
}

export const LOGO = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 14.5 22 6l-6.5 14-3-6.5L2 14.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
