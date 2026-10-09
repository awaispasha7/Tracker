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
// Route alerts exist only in the full marketplace; the server leaves the form out otherwise.
const aFrom = $('#a-from') ? airportPicker($('#a-from')) : null;
const aTo = $('#a-to') ? airportPicker($('#a-to')) : null;

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
    if ((await config).marketplace === 'skyaccess') return searchPartners(q, { primary: true, quiet });
    if (!quiet) searchPartners(q);
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
  const sky = e.target.closest('[data-sky]');
  if (sky) location.hash = `sky=${sky.dataset.sky}`;
});
$('#results').addEventListener('keydown', (e) => {
  const card = e.target.closest('[data-leg]');
  if (card && e.key === 'Enter') location.hash = `leg=${card.dataset.leg}`;
  const sky = e.target.closest('[data-sky]');
  if (sky && e.key === 'Enter') location.hash = `sky=${sky.dataset.sky}`;
});

// ---------- SkyAccess partner flights: shown beside ours, booked on SkyAccess ----------
const config = api('/api/config').catch(() => ({}));
const partnerFlights = new Map();
const usd = (n) => (n == null ? 'Contact for price' : money(n * 100));
const placeText = (p) => p.code || p.city || p.name || '—';

function partnerCards(flights) {
  return flights.map((f) => `
        <article class="card leg" data-sky="${esc(f.flightId)}" tabindex="0">
          <div>
            <div class="route">
              <span>${esc(placeText(f.from))}<small>${esc(f.from.city ?? f.from.name ?? '')}</small></span>
              <span class="arrow">→</span>
              <span>${esc(placeText(f.to))}<small>${esc(f.to.city ?? f.to.name ?? '')}</small></span>
            </div>
            <div class="facts">
              ${f.departAt ? `<span>${esc(when(f.departAt))}</span>` : ''}
              ${f.aircraft ? `<span>${esc(f.aircraft)}${f.seats ? ` · ${f.seats} seats` : ''}</span>` : ''}
            </div>
            <div class="notes"><span class="tag">SkyAccess partner</span></div>
          </div>
          <div class="price">
            <div class="total num">${esc(usd(f.priceUsd))}</div>
            <div class="faint">whole aircraft${f.priceUsd == null ? '' : ' · plus taxes &amp; fees'}</div>
          </div>
        </article>`).join('');
}

/** SkyAccess flights: beside ours ("More from SkyAccess"), or as the main results in SkyAccess-only mode. */
async function searchPartners(q, { primary = false, quiet = false } = {}) {
  const box = primary ? $('#results') : $('#partners');
  if (!(await config).skyaccess?.enabled) {
    if (primary) box.innerHTML = '<div class="card empty">Flight search is temporarily unavailable. Please contact our concierge.</div>';
    return;
  }
  const pq = new URLSearchParams({ from: q.get('from'), pax: q.get('pax') ?? '1', flex: q.get('flex') ?? '0' });
  if (q.get('to')) pq.set('to', q.get('to'));
  if (q.get('date')) pq.set('date', q.get('date'));
  const head = primary ? '' : '<h2>More from SkyAccess</h2>';
  box.hidden = false;
  if (!quiet) box.innerHTML = `${head}<div class="card empty">${primary ? 'Searching live empty legs…' : 'Checking SkyAccess partner flights…'}</div>`;
  try {
    const { flights } = await api(`/api/partners/skyaccess/search?${pq}`);
    if (lastQuery !== q) return;
    flights.forEach((f) => partnerFlights.set(f.flightId, f));
    if (primary) {
      $('#count').textContent = flights.length ? `${flights.length} empty leg${flights.length === 1 ? '' : 's'}` : '';
      $('#meta').textContent = '';
      box.innerHTML = flights.length
        ? `${partnerCards(flights)}<p class="faint">Listed by our partner SkyAccess. You book on SkyAccess; taxes and fees are added at their checkout.</p>`
        : '<div class="card empty">No empty legs match right now. Try other dates or a nearby city: new flights are listed every day.</div>';
      return;
    }
    if (!flights.length) { box.hidden = true; return; }
    box.innerHTML = `<h2>More from SkyAccess</h2>
      <p class="faint">Partner empty legs. Booked and paid on SkyAccess; taxes and fees are added at their checkout.</p>
      <div class="results">${partnerCards(flights)}</div>`;
  } catch (e) {
    if (lastQuery !== q) return;
    const msg = e.code === 'partner_rate_limited' ? 'Busy right now — please search again in a minute.' : primary ? 'Flight search is temporarily unavailable. Please try again shortly.' : 'SkyAccess partner flights are unavailable right now.';
    box.innerHTML = `${head}<div class="card empty">${esc(msg)}</div>`;
  }
}

// SkyAccess-only mode: hide controls SkyAccess search doesn't support.
config.then((c) => {
  if (c.marketplace !== 'skyaccess') return;
  $('#cats').hidden = true;
  $('#sort').closest('label').hidden = true;
  $('#radius').closest('label').hidden = true;
});

// ---------- concierge contact, from server config ----------
config.then(({ site }) => {
  if (!site) return;
  const tel = site.phone ? `tel:${site.phone.replace(/[^\d+]/g, '')}` : null;
  const links = [
    tel && `<a class="btn gold" href="${esc(tel)}">Call ${esc(site.phone)}</a>`,
    site.whatsapp && `<a class="btn ghost" href="https://wa.me/${esc(site.whatsapp)}" rel="noopener">WhatsApp</a>`,
    site.email && `<a class="btn ghost" href="mailto:${esc(site.email)}">Email us</a>`,
  ].filter(Boolean);
  if (links.length) {
    $('#concierge-actions').innerHTML = links.join('');
    $('#concierge').hidden = false;
  }
  const contact = [site.phone && `<a href="${esc(tel)}">${esc(site.phone)}</a>`, site.whatsapp && `<a href="https://wa.me/${esc(site.whatsapp)}" rel="noopener">WhatsApp</a>`, site.email && `<a href="mailto:${esc(site.email)}">${esc(site.email)}</a>`].filter(Boolean);
  if (contact.length) $('#footer-contact').innerHTML = `Concierge: ${contact.join(' · ')}`;
});

// Deep links from route pages: /?from=TEB&to=PBI
{
  const q = new URLSearchParams(location.search);
  if (q.get('from')) {
    from.set(q.get('from').toUpperCase());
    if (q.get('to')) to.set(q.get('to').toUpperCase());
    if (q.get('pax')) $('#pax').value = q.get('pax');
    runSearch();
  }
}

$('#partners').addEventListener('click', (e) => {
  const card = e.target.closest('[data-sky]');
  if (card) location.hash = `sky=${card.dataset.sky}`;
});
$('#partners').addEventListener('keydown', (e) => {
  const card = e.target.closest('[data-sky]');
  if (card && e.key === 'Enter') location.hash = `sky=${card.dataset.sky}`;
});

// ---------- live inventory ----------
function connectLive() {
  if (!$('#live')) return;
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
      ${d.operator?.confirmation === 'on_request' ? `<div class="notice info">We'll send your request to ${esc(d.operator.name)} the moment you book. ${(await config).payments === 'invoice' ? 'Nothing is payable until they confirm' : 'Your card is only charged once they confirm'}, usually within a few hours.</div>` : ''}
      ${leg.kind === 'charter_offer' ? '' : `<div class="notice warn">Empty legs follow the operator's primary trip. The time can shift within the window, or the flight can cancel (full refund). Keep a refundable backup.</div>`}
      <button id="get-quote">Continue to book</button>`
    : `<div class="notice bad">${d.unavailableReason === 'reserved' ? 'Someone has just requested this flight.' : 'This flight is not available to book right now.'}</div>`}
  `;
  $('#get-quote')?.addEventListener('click', () => startBooking(leg, pax));
}

async function startBooking(leg, pax) {
  const body = $('#drawer-body');
  const invoice = (await config).payments === 'invoice';
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
      ${invoice ? `<p class="faint" style="margin:0">No payment now. Once the operator confirms, we send your invoice with secure payment instructions. Your seats are secured when payment is received.</p>
        <input type="hidden" name="token" value="invoice">`
      : `<label>Card (test mode)
        <select name="token">
          <option value="tok_visa">Visa •••• 4242 — approves</option>
          <option value="tok_decline">Card that declines</option>
          <option value="tok_capture_fail">Card whose authorization expires</option>
        </select>
      </label>
      <p class="faint" style="margin:0">Your card is authorized now and charged only when the operator confirms.</p>`}
      <h3 style="margin:0">Charter agreement</h3>
      <pre class="agreement">${esc(agreement.text)}</pre>
      <label class="check"><input type="checkbox" name="accept" required> I have read and accept the charter agreement (${esc(agreement.version)}).</label>
      <label>Sign by typing your full name<input name="sig" required></label>
      <button type="submit">${invoice ? 'Request this flight' : 'Request flight'} · ${money(quote.totalCents)}</button>
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

const CARD_STATUS = {
  authorized: ['info', 'Requested — waiting for the operator to confirm. Your card is authorized, not charged.'],
  confirmed: ['good', "Confirmed. You're flying! Your card has been charged."],
};
const INVOICE_STATUS = {
  authorized: ['info', 'Requested — waiting for the operator to confirm. No payment has been taken.'],
  confirmed: ['good', 'Confirmed by the operator. Your invoice is on its way; your seats are secured once it is paid.'],
  payment_failed: ['bad', 'We could not process this request. The flight has been released.'],
};
const STATUS = {
  pending: ['info', 'Processing your request…'],
  ...CARD_STATUS,
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
    const statuses = (await config).payments === 'invoice' ? { ...STATUS, ...INVOICE_STATUS } : STATUS;
    const released = (await config).payments === 'invoice' ? 'No payment was taken.' : 'You have not been charged.';
    const [tone, raw] = statuses[b.status] ?? ['info', b.status];
    const text = raw.replace('You have not been charged.', released).replace('Any payment has been refunded in full.', (await config).payments === 'invoice' ? 'Anything you paid will be refunded in full.' : 'Any payment has been refunded in full.');
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

async function showPartnerFlight(flightId) {
  stopPoll();
  openDrawer('SkyAccess flight');
  const body = $('#drawer-body');
  body.innerHTML = '<p class="muted">Checking the flight is still available…</p>';
  let f;
  try {
    f = await api(`/api/partners/skyaccess/flights/${encodeURIComponent(flightId)}`);
  } catch (e) {
    const cached = partnerFlights.get(flightId);
    if (e.status === 404 || !cached) {
      body.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
      return;
    }
    f = cached;
  }
  const pax = Number($('#pax').value) || 1;
  const date = f.departAt ? f.departAt.slice(0, 10) : ($('#date').value || '');
  $('#drawer-title').textContent = `${placeText(f.from)} → ${placeText(f.to)}`;
  body.innerHTML = `
    <div>
      <div class="route"><span>${esc(placeText(f.from))}<small>${esc(f.from.name ?? f.from.city ?? '')}</small></span><span class="arrow">→</span><span>${esc(placeText(f.to))}<small>${esc(f.to.name ?? f.to.city ?? '')}</small></span></div>
      ${f.departAt ? `<p class="muted" style="margin:.5em 0 0">${esc(when(f.departAt))}</p>` : ''}
    </div>
    <div class="grid2">
      <div><div class="faint">Aircraft</div>${esc(f.aircraft ?? '—')}${f.seats ? `<br><span class="faint">${f.seats} seats</span>` : ''}</div>
      <div><div class="faint">Price, whole aircraft</div><strong>${esc(usd(f.priceUsd))}</strong>${f.priceUsd == null ? '' : '<br><span class="faint">taxes &amp; fees added at SkyAccess checkout</span>'}</div>
    </div>
    ${f.amenities?.length ? `<div class="notes">${f.amenities.map((a) => `<span class="tag">${esc(a)}</span>`).join('')}</div>` : ''}
    <div class="notice info">This flight is listed by our partner SkyAccess. You book and pay on their site, under their terms.</div>
    ${f.bookingUrl ? `<a class="btn" style="text-align:center;text-decoration:none" href="${esc(f.bookingUrl)}" target="_blank" rel="noopener noreferrer">Book on SkyAccess</a>` : ''}
    <form class="stack" id="sky-req">
      <h3 style="margin:0">Or ask SkyAccess to contact you</h3>
      <p class="faint" style="margin:0">A SkyAccess specialist emails you to confirm availability and price. No payment is taken and nothing is booked yet.</p>
      <div class="grid2">
        <label>Full name<input name="name" required autocomplete="name"></label>
        <label>Email<input name="email" type="email" required autocomplete="email"></label>
        <label>Phone (optional)<input name="phone" type="tel" autocomplete="tel"></label>
        <label>Passengers<input name="pax" type="number" min="1" max="50" value="${pax}" required></label>
        <label>Departure date<input name="date" type="date" value="${esc(date)}" required></label>
      </div>
      <label>Notes (optional)<textarea name="notes" rows="2" maxlength="1000"></textarea></label>
      <label class="check"><input type="checkbox" name="consent" required> Send my name, email and trip details to SkyAccess so they can contact me.</label>
      <button type="submit">Send request to SkyAccess</button>
      <div id="sky-out"></div>
    </form>`;
  $('#sky-req').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('/api/partners/skyaccess/booking-requests', {
        method: 'POST',
        body: {
          flightId: f.flightId, name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'),
          origin: f.from.code || f.from.city || f.from.name, destination: f.to.code || f.to.city || f.to.name,
          departureDate: fd.get('date'), passengers: Number(fd.get('pax')), notes: fd.get('notes'),
        },
      });
      e.target.innerHTML = `<div class="notice good">${esc(r.message)}</div><p class="faint">Reference ${esc(r.id)}</p>`;
    } catch (err) {
      btn.disabled = false;
      $('#sky-out').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    }
  });
}

function route() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('sky')) showPartnerFlight(h.get('sky'));
  else if (h.get('leg')) showLeg(h.get('leg'), Number(h.get('pax')) || undefined);
  else if (h.get('booking')) showBooking(h.get('booking'), h.get('email') ?? '');
}
window.addEventListener('hashchange', route);
route();

// ---------- alerts ----------
$('#alert-form')?.addEventListener('submit', async (e) => {
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
