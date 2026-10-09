import { api, esc, money, when, toast, airportPicker, LOGO } from './common.js';

const $ = (s) => document.querySelector(s);
$('#brand').insertAdjacentHTML('afterbegin', LOGO);
const from = airportPicker($('#from'));
const to = airportPicker($('#to'));
const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
$('#date').value = tomorrow;
$('#date').min = new Date().toISOString().slice(0, 10);

let current = null; // { id, email }
let pollTimer = null;
const selected = new Set();

const DELIVERY = { Created: 'queued', Sending: 'sending', Sent: 'sent', Delivered: 'delivered', Open: 'opened', replied: 'replied', Error: 'failed', Blocked: 'failed' };

async function init() {
  const cfg = await api('/api/config');
  if (!cfg.charterQuotes) {
    $('#unavailable').hidden = false;
    return;
  }
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('id') && h.get('email')) {
    current = { id: h.get('id'), email: h.get('email') };
    showStatus();
  } else {
    $('#request').hidden = false;
  }
}

$('#request').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Searching aircraft…';
  try {
    const r = await api('/api/charter-requests', {
      method: 'POST',
      body: {
        from: from.code(), to: to.code(), date: $('#date').value, time: $('#time').value, pax: Number($('#pax').value),
        name: $('#name').value, email: $('#email').value, phone: $('#phone').value, notes: $('#notes').value,
      },
    });
    current = { id: r.id, email: r.contact.email };
    history.replaceState(null, '', `#id=${r.id}&email=${encodeURIComponent(r.contact.email)}`);
    renderOptions(r);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find aircraft';
  }
});

function renderOptions(r) {
  $('#request').hidden = true;
  $('#options').hidden = false;
  if (!r.options.length) {
    $('#opt-count').textContent = 'No suitable aircraft found nearby.';
    $('#opt-grid').innerHTML = `<div class="card empty">${esc(r.searchError ?? 'Try a nearby airport or a different date.')}</div>`;
    return;
  }
  $('#opt-count').textContent = `${r.options.length} aircraft for ${r.pax} passenger${r.pax > 1 ? 's' : ''}, ${r.from.iata || r.from.icao} → ${r.to.iata || r.to.icao}`;
  $('#opt-grid').innerHTML = r.options.map((o) => `
    <label class="card option" data-id="${o.aircraftId}">
      <input type="checkbox" value="${o.aircraftId}" aria-label="Select ${esc(o.type)}">
      ${o.images[0] ? `<img src="${esc(o.images[0])}" alt="" loading="lazy">` : '<img alt="">'}
      <div class="body">
        <strong>${esc(o.type)}</strong>
        <span class="faint">${o.seats ?? '?'} seats · ${o.year ? `built ${o.year}` : ''} · ${esc(o.tail)}</span>
        <span class="faint">${esc(o.operator.name)}</span>
        ${o.estimateCents ? `<span>Market estimate <strong class="num">${money(o.estimateCents)}</strong></span>` : '<span class="faint">Price on quote</span>'}
      </div>
    </label>`).join('');
}

$('#opt-grid').addEventListener('change', (e) => {
  const box = e.target.closest('input[type=checkbox]');
  if (!box) return;
  const id = Number(box.value);
  if (box.checked && selected.size >= 5) {
    box.checked = false;
    toast('You can choose up to 5 aircraft.');
    return;
  }
  box.checked ? selected.add(id) : selected.delete(id);
  box.closest('.option').classList.toggle('selected', box.checked);
  $('#send').disabled = selected.size === 0;
  $('#send').textContent = selected.size ? `Request quotes (${selected.size})` : 'Request quotes';
});

$('#send').addEventListener('click', async () => {
  $('#send').disabled = true;
  try {
    await api(`/api/charter-requests/${current.id}/send`, { method: 'POST', body: { email: current.email, aircraftIds: [...selected] } });
    $('#options').hidden = true;
    showStatus();
  } catch (err) {
    toast(err.message);
    $('#send').disabled = false;
  }
});

async function showStatus() {
  clearInterval(pollTimer);
  const render = async () => {
    let r;
    try {
      r = await api(`/api/charter-requests/${current.id}?email=${encodeURIComponent(current.email)}`);
    } catch (err) {
      $('#status').hidden = false;
      $('#status').innerHTML = `<div class="card empty">${esc(err.message)}</div>`;
      clearInterval(pollTimer);
      return;
    }
    if (r.status === 'options_ready' || r.status === 'no_options') {
      clearInterval(pollTimer);
      renderOptions(r);
      return;
    }
    $('#status').hidden = false;
    $('#status').innerHTML = `
      <div class="card pad stack">
        <div class="route"><span>${esc(r.from.iata || r.from.icao)}<small>${esc(r.from.city)}</small></span><span class="arrow">→</span><span>${esc(r.to.iata || r.to.icao)}<small>${esc(r.to.city)}</small></span></div>
        <div class="muted">${esc(when(r.departAt))} · ${r.pax} passenger${r.pax > 1 ? 's' : ''}</div>
        <div class="notes">${r.operators.map((o) => `<span class="tag ${o.status === 'replied' ? 'good' : ''}">${esc(o.name)}: ${esc(DELIVERY[o.status] ?? o.status)}</span>`).join('')}</div>
        <p class="faint" style="margin:0">Bookmark this page; it updates as operators reply. We also email you each offer.</p>
      </div>
      <div class="toolbar"><strong>${r.offers.filter((o) => o.state === 'offered').length} offer(s)</strong></div>
      <div class="results">${r.offers.length ? r.offers.map(offerCard).join('') : '<div class="card empty">Waiting for operators to reply…</div>'}</div>`;
  };
  await render();
  pollTimer = setInterval(render, 10_000);
}

function offerCard(o) {
  const label = { offered: '', declined: 'Not available', expired: 'Offer expired', reserved: 'Booked', unsupported: 'Cannot be booked online' }[o.state] ?? o.state;
  return `
    <article class="card leg${o.aircraft.images[0] ? ' has-photo' : ''}">
      ${o.aircraft.images[0] ? `<img class="thumb" src="${esc(o.aircraft.images[0])}" alt="">` : ''}
      <div>
        <strong>${esc(o.aircraft.type)}</strong> <span class="faint">${esc(o.aircraft.tail)}${o.aircraft.seats ? ` · ${o.aircraft.seats} seats` : ''}</span>
        <div class="facts"><span>${esc(o.operator?.name ?? '')}</span><span>received ${esc(when(o.receivedAt))}</span></div>
        ${o.comment ? `<div class="faint" style="margin-top:6px">“${esc(o.comment)}”</div>` : ''}
        ${label ? `<div class="notes"><span class="tag ${o.state === 'declined' || o.state === 'expired' ? 'bad' : 'warn'}">${esc(label)}</span></div>` : ''}
      </div>
      <div class="price">
        ${o.price ? `<div class="total num">${money(o.price.totalCents)}</div><div class="faint">all-in · whole aircraft</div>` : ''}
        ${o.bookable ? `<a class="btn" href="/#leg=${encodeURIComponent(o.legId)}&pax=${new URLSearchParams(location.hash.slice(1)).get('pax') ?? ''}" data-book="${esc(o.legId)}">Book this offer</a>` : ''}
      </div>
    </article>`;
}

document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-book]');
  if (!a) return;
  e.preventDefault();
  const r = await api(`/api/charter-requests/${current.id}?email=${encodeURIComponent(current.email)}`);
  location.href = `/#leg=${encodeURIComponent(a.dataset.book)}&pax=${r.pax}`;
});

init();
