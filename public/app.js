import { api, esc, money, when, windowText, toast, airportPicker, LOGO } from './common.js';

const $ = (s) => document.querySelector(s);
$('#brand').insertAdjacentHTML('afterbegin', LOGO);

const CATEGORIES = [
  ['turboprop', 'Turboprop'], ['light', 'Light jet'], ['midsize', 'Midsize'],
  ['super-midsize', 'Super-midsize'], ['heavy', 'Heavy'], ['ultra-long', 'Ultra long range'],
];
const selected = new Set();
$('#cats').innerHTML = CATEGORIES.map(([k, v]) => `<span class="chip" role="button" tabindex="0" aria-pressed="false" data-cat="${k}">${v}</span>`).join('');
$('#cats').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-cat]');
  if (!chip) return;
  const k = chip.dataset.cat;
  selected.has(k) ? selected.delete(k) : selected.add(k);
  chip.setAttribute('aria-pressed', String(selected.has(k)));
  if (lastQuery) runSearch();
});

const from = airportPicker($('#from'));
const to = airportPicker($('#to'));
const aFrom = airportPicker($('#a-from'));
const aTo = airportPicker($('#a-to'));

let lastQuery = null;

function buildQuery() {
  const q = new URLSearchParams({ from: from.code(), pax: $('#pax').value || '1', flex: $('#flex').value, sort: $('#sort').value, radius: $('#radius').value });
  if ($('#to').value.trim()) q.set('to', to.code());
  if ($('#date').value) q.set('date', $('#date').value);
  if (selected.size) q.set('category', [...selected].join(','));
  return q;
}

async function runSearch({ quiet = false } = {}) {
  if (!from.code()) return;
  const q = buildQuery();
  lastQuery = q;
  if (!quiet) $('#results').innerHTML = '<div class="card empty">Searching live inventory…</div>';
  try {
    const r = await api(`/api/search?${q}`);
    if (lastQuery !== q) return;
    renderResults(r);
  } catch (e) {
    $('#results').innerHTML = `<div class="card empty">${esc(e.message)}</div>`;
    $('#count').textContent = '';
  }
}

function renderResults({ results, meta }) {
  $('#count').textContent = results.length ? `${results.length} empty leg${results.length === 1 ? '' : 's'}` : '';
  $('#meta').textContent = `${meta.indexSize} live legs · searched in ${meta.tookMs} ms`;
  if (!results.length) {
    $('#results').innerHTML = `<div class="card empty">No empty legs match right now. Widen the airport radius or dates — or <a href="#alerts">set an alert</a> and we'll tell you when one appears.</div>`;
    return;
  }
  $('#results').innerHTML = results.map((h) => `
    <article class="card leg${h.image ? ' has-photo' : ''}" data-leg="${esc(h.legId)}" tabindex="0">
      ${h.image ? `<img class="thumb" src="${esc(h.image)}" alt="" loading="lazy">` : ''}
      <div>
        <div class="route">
          <span>${esc(h.from.iata)}<small>${esc(h.from.city)}</small></span>
          <span class="arrow">→</span>
          <span>${esc(h.to.iata)}<small>${esc(h.to.city)}</small></span>
        </div>
        <div class="facts">
          <span>${esc(windowText(h.departEarliest, h.departLatest))}</span>
          <span>${esc(h.aircraft.type)} · ${h.aircraft.seats} seats</span>
          <span>${h.blockHours}h</span>
          <span>${esc(h.operator.name)}</span>
        </div>
        <div class="notes">
          ${h.matchNotes.map((n) => `<span class="tag">${esc(n)}</span>`).join('')}
          ${h.operator.confirmation === 'on_request' ? '<span class="tag warn">Operator confirms on request</span>' : h.confidence < 0.8 ? '<span class="tag warn">Availability confirmed on request</span>' : '<span class="tag good">Direct operator</span>'}
        </div>
      </div>
      <div class="price">
        <div class="total num">${money(h.price.totalCents)}</div>
        <div class="faint">all-in · whole aircraft</div>
        <div class="was num">${money(h.price.fullCharterEstimateCents)}</div>
        <span class="tag good">${h.price.savingsPct}% below charter</span>
      </div>
    </article>`).join('');
}

$('#search').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
$('#sort').addEventListener('change', () => lastQuery && runSearch());
$('#radius').addEventListener('change', () => lastQuery && runSearch());
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-try]');
  if (!t) return;
  e.preventDefault();
  from.set(t.dataset.try);
  runSearch();
});
$('#results').addEventListener('click', (e) => {
  const card = e.target.closest('[data-leg]');
  if (card) location.hash = `leg=${card.dataset.leg}`;
});
$('#results').addEventListener('keydown', (e) => {
  const card = e.target.closest('[data-leg]');
  if (card && e.key === 'Enter') location.hash = `leg=${card.dataset.leg}`;
});

// ---------- live inventory ----------
function connectLive() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { $('#live').classList.remove('off'); $('#live').textContent = 'Live inventory'; };
  es.onerror = () => { $('#live').classList.add('off'); $('#live').textContent = 'reconnecting…'; };
  es.addEventListener('inventory', () => { if (lastQuery) runSearch({ quiet: true }); });
}
connectLive();

// ---------- drawer: leg detail → quote → book → status ----------
const drawer = $('#drawer');
const openDrawer = (title) => { $('#drawer-title').textContent = title; drawer.classList.add('open'); $('#scrim').classList.add('open'); };
const closeDrawer = () => { drawer.classList.remove('open'); $('#scrim').classList.remove('open'); history.replaceState(null, '', location.pathname); stopPoll(); };
$('#close').onclick = closeDrawer;
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => e.key === 'Escape' && drawer.classList.contains('open') && closeDrawer());

let pollTimer = null;
const stopPoll = () => { clearInterval(pollTimer); pollTimer = null; };

function breakdown(lines, total) {
  return `<table class="breakdown">${lines.map((l) => `<tr><td>${esc(l.label)}</td><td>${money(l.amountCents, { cents: true })}</td></tr>`).join('')}
    <tr class="total"><td>Total, all-in</td><td>${money(total, { cents: true })}</td></tr></table>`;
}

const AMENITY_LABELS = {
  wireless_internet: 'Wi-Fi', lavatory: 'Lavatory', cabin_crew: 'Cabin crew', hot_meal: 'Hot meals', entertainment_system: 'Entertainment',
  pets_allowed: 'Pets allowed', shower: 'Shower', satellite_phone: 'Satellite phone',
};

function gallery(images) {
  if (!images?.length) return '';
  return `<div class="gallery">${images.slice(0, 4).map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join('')}</div>`;
}

function amenities(a) {
  const on = Object.entries(a ?? {}).filter(([k, v]) => v === true && AMENITY_LABELS[k]).map(([k]) => AMENITY_LABELS[k]);
  if (a?.sleeping_places) on.push(`${a.sleeping_places} beds`);
  return on.length ? `<div class="notes">${on.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : '';
}

function flightLine(f) {
  if (!f) return '';
  const mins = f.minutes ?? Math.round((f.blockHours - 0.3) * 60);
  const hm = `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  const stops = f.fuelStops ? ` · ${f.fuelStops} fuel stop${f.fuelStops > 1 ? 's' : ''}` : ' · nonstop';
  const src = f.source === 'aviapages' ? 'airway route with typical winds' : 'estimate';
  return `<div class="faint">Flight time ${hm}${stops} · ${f.distanceNm.toLocaleString()} nm <span title="Source">(${src})</span></div>`;
}

async function showLeg(legId, paxOverride) {
  stopPoll();
  openDrawer('Flight');
  const body = $('#drawer-body');
  body.innerHTML = '<p class="muted">Loading…</p>';
  const pax = paxOverride || Number($('#pax').value) || 1;
  let d;
  try {
    d = await api(`/api/legs/${encodeURIComponent(legId)}?pax=${pax}`);
  } catch (e) {
    body.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
    return;
  }
  const { leg } = d;
  $('#drawer-title').textContent = `${leg.from.iata} → ${leg.to.iata}`;
  body.innerHTML = `
    ${gallery(d.aircraft?.images)}
    <div>
      <div class="route"><span>${esc(leg.from.iata || leg.from.icao)}<small>${esc(leg.from.name)}</small></span><span class="arrow">→</span><span>${esc(leg.to.iata || leg.to.icao)}<small>${esc(leg.to.name)}</small></span></div>
      <p class="muted" style="margin:.5em 0 0">${esc(windowText(leg.departEarliest, leg.departLatest))}</p>
      ${flightLine(d.flight)}
    </div>
    <div class="grid2">
      <div><div class="faint">Aircraft</div>${esc(leg.aircraft?.name)} (${esc(leg.tail)})<br><span class="faint">${d.aircraft?.seats} seats${d.aircraft?.year ? ` · built ${d.aircraft.year}` : ''}</span></div>
      <div><div class="faint">Operated by</div>${esc(d.operator?.name)}<br><span class="faint">${esc(d.operator?.certificate)}</span>
        ${d.operator?.responseRate ? `<br><span class="faint">Answers ${Math.round(d.operator.responseRate * 100)}% of requests</span>` : ''}</div>
    </div>
    ${amenities(d.aircraft?.amenities)}
    ${leg.note ? `<div class="notice info">Operator note: ${esc(leg.note)}</div>` : ''}
    ${d.bookable ? `
      <div>
        <h3>Price for ${pax} passenger${pax > 1 ? 's' : ''}</h3>
        ${breakdown(d.price.lines, d.price.totalCents)}
        ${leg.kind === 'charter_offer' ? '<p class="faint">Full charter offer from the operator, all-in.</p>'
          : `<p class="faint">A regular one-way charter on this aircraft is about ${money(d.price.fullCharterEstimateCents)}${d.price.fullCharterSource === 'aviapages' ? ' (market data)' : ''}. You save ${d.price.savingsPct}%.</p>`}
      </div>
      ${d.operator?.confirmation === 'on_request' ? `<div class="notice info">We'll send your request to ${esc(d.operator.name)} the moment you book. Your card is only charged once they confirm, usually within a few hours.</div>` : ''}
      ${leg.kind === 'charter_offer' ? '' : `<div class="notice warn">Empty legs follow the operator's primary trip. The time can shift within the window, or the flight can cancel (full refund). Keep a refundable backup.</div>`}
      <button id="get-quote">Continue to book</button>`
    : `<div class="notice bad">${d.unavailableReason === 'reserved' ? 'Someone has just requested this flight.' : 'This flight is not available to book right now.'}</div>`}
  `;
  $('#get-quote')?.addEventListener('click', () => startBooking(leg, pax));
}

async function startBooking(leg, pax) {
  const body = $('#drawer-body');
  let quote, agreement;
  try {
    [quote, agreement] = await Promise.all([api('/api/quotes', { method: 'POST', body: { legId: leg.id, pax } }), api('/api/agreement')]);
  } catch (e) {
    toast(e.message);
    return showLeg(leg.id, pax);
  }
  const expires = new Date(quote.expiresAt);
  body.innerHTML = `
    <div class="notice info">Price held: <strong>${money(quote.totalCents, { cents: true })}</strong> all-in, until ${expires.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</div>
    <form class="stack" id="book">
      <h3 style="margin:0">Lead passenger &amp; contact</h3>
      <div class="grid2">
        <label>Full name<input name="cname" required autocomplete="name"></label>
        <label>Email<input name="email" type="email" required autocomplete="email"></label>
      </div>
      <h3 style="margin:0">Passengers (name as on passport/ID)</h3>
      ${Array.from({ length: quote.pax }, (_, i) => `<label>Passenger ${i + 1}<input name="p${i}" required></label>`).join('')}
      <h3 style="margin:0">Payment</h3>
      <label>Card (test mode)
        <select name="token">
          <option value="tok_visa">Visa •••• 4242 — approves</option>
          <option value="tok_decline">Card that declines</option>
          <option value="tok_capture_fail">Card whose authorization expires</option>
        </select>
      </label>
      <p class="faint" style="margin:0">Your card is authorized now and charged only when the operator confirms.</p>
      <h3 style="margin:0">Charter agreement</h3>
      <pre class="agreement">${esc(agreement.text)}</pre>
      <label class="check"><input type="checkbox" name="accept" required> I have read and accept the charter agreement (${esc(agreement.version)}).</label>
      <label>Sign by typing your full name<input name="sig" required></label>
      <button type="submit">Request flight · ${money(quote.totalCents)}</button>
      <div id="book-err"></div>
    </form>`;
  const idem = crypto.randomUUID();
  $('#book').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const b = await api('/api/bookings', {
        method: 'POST',
        headers: { 'idempotency-key': idem },
        body: {
          quoteId: quote.quoteId,
          contact: { name: f.get('cname'), email: f.get('email') },
          passengers: Array.from({ length: quote.pax }, (_, i) => ({ name: f.get(`p${i}`) })),
          paymentToken: f.get('token'),
          agreement: { accepted: !!f.get('accept'), signedName: f.get('sig'), version: agreement.version },
        },
      });
      location.hash = `booking=${b.id}&email=${encodeURIComponent(b.contact.email)}`;
    } catch (err) {
      btn.disabled = false;
      $('#book-err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      if (['quote_expired', 'quote_stale', 'leg_unavailable'].includes(err.code)) {
        $('#book-err').insertAdjacentHTML('beforeend', '<button class="secondary small" id="requote" type="button" style="margin-top:8px">See current price</button>');
        $('#requote').onclick = () => showLeg(leg.id, pax);
      }
    }
  });
}

const STATUS = {
  pending: ['info', 'Processing your request…'],
  authorized: ['info', 'Requested — waiting for the operator to confirm. Your card is authorized, not charged.'],
  confirmed: ['good', "Confirmed. You're flying! Your card has been charged."],
  completed: ['good', 'Flight completed.'],
  payment_failed: ['bad', 'Payment failed. The flight has been released.'],
  declined: ['bad', "The operator couldn't confirm. You have not been charged."],
  expired: ['bad', "The operator didn't confirm in time. You have not been charged."],
  cancelled_by_customer: ['warn', 'You cancelled this request. You have not been charged.'],
  cancelled_by_operator: ['bad', 'The operator cancelled this flight. Any payment has been refunded in full.'],
};

async function showBooking(id, email) {
  openDrawer('Your booking');
  const body = $('#drawer-body');
  const render = async () => {
    let b;
    try {
      b = await api(`/api/bookings/${encodeURIComponent(id)}?email=${encodeURIComponent(email)}`);
    } catch (e) {
      body.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
      stopPoll();
      return;
    }
    const [tone, text] = STATUS[b.status] ?? ['info', b.status];
    body.innerHTML = `
      <div class="notice ${tone}">${esc(text)}</div>
      <div>
        <div class="route"><span>${esc(b.flight.from.iata)}<small>${esc(b.flight.from.city)}</small></span><span class="arrow">→</span><span>${esc(b.flight.to.iata)}<small>${esc(b.flight.to.city)}</small></span></div>
        <p class="muted" style="margin:.5em 0 0">${esc(windowText(b.flight.departEarliest, b.flight.departLatest))}<br>${esc(b.flight.aircraft)} · ${esc(b.flight.operator)}</p>
      </div>
      ${breakdown(b.lines, b.totalCents)}
      <div><h3>Passengers</h3>${b.passengers.map((p) => esc(p.name)).join('<br>')}</div>
      <div><h3>Timeline</h3><ol class="timeline">${b.history.map((h) => `<li><span><strong>${esc(h.status.replace(/_/g, ' '))}</strong> — ${esc(h.note)}<br><span class="faint">${esc(when(h.at))}</span></span></li>`).join('')}</ol></div>
      ${b.operatorUpdates?.length ? `<div><h3>Operator updates</h3><ol class="timeline">${b.operatorUpdates.map((u) => `<li><span>${esc(u.text)}<br><span class="faint">${esc(when(u.at))}</span></span></li>`).join('')}</ol></div>` : ''}
      <p class="faint">Booking ${esc(b.id)} · agreement ${esc(b.agreement.version)} signed by ${esc(b.agreement.signedName)}</p>
      ${b.status === 'authorized' ? '<button class="danger" id="cancel">Cancel request</button>' : ''}`;
    $('#cancel')?.addEventListener('click', async () => {
      try { await api(`/api/bookings/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { email } }); render(); } catch (e) { toast(e.message); }
    });
    if (!['pending', 'authorized'].includes(b.status)) stopPoll();
  };
  stopPoll();
  await render();
  pollTimer = setInterval(render, 5000);
}

function route() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('leg')) showLeg(h.get('leg'), Number(h.get('pax')) || undefined);
  else if (h.get('booking')) showBooking(h.get('booking'), h.get('email') ?? '');
}
window.addEventListener('hashchange', route);
route();

// ---------- alerts ----------
$('#alert-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/alerts', {
      method: 'POST',
      body: {
        email: $('#a-email').value, from: aFrom.code(), to: $('#a-to').value.trim() ? aTo.code() : null,
        pax: Number($('#a-pax').value) || 1, maxPrice: Number($('#a-max').value) || null,
      },
    });
    toast(r.matchedNow ? `Alert created — ${r.matchedNow} leg(s) already match; check your email.` : "Alert created — we'll email you when a leg matches.");
    e.target.reset();
  } catch (err) {
    toast(err.message);
  }
});
