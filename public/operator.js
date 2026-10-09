import { api, esc, money, when, toast, LOGO } from './common.js';

const $ = (s) => document.querySelector(s);
$('#brand').insertAdjacentHTML('afterbegin', LOGO);
let key = sessionStorage.getItem('opKey') || '';

async function signIn(k) {
  const me = await api('/api/operator/me', { key: k });
  key = k;
  sessionStorage.setItem('opKey', k);
  $('#login').hidden = true;
  $('#portal').hidden = false;
  $('#logout').hidden = false;
  $('#op-name').textContent = me.operator.name;
  $('#op-meta').textContent = `${me.operator.certificate} · ${me.fleet.length} aircraft`;
  $('#p-tail').innerHTML = me.fleet.map((a) => `<option value="${esc(a.tail)}">${esc(a.tail)} — ${esc(a.typeName)}</option>`).join('');
  $('[data-panel="fleet"]').innerHTML = `<div class="card scroll-x"><table class="data"><thead><tr><th>Tail</th><th>Type</th><th>Seats</th><th>Base</th><th>Year</th></tr></thead><tbody>
    ${me.fleet.map((a) => `<tr><td>${esc(a.tail)}</td><td>${esc(a.typeName)}</td><td>${a.seats}</td><td>${esc(a.homeBase)}</td><td>${a.year}</td></tr>`).join('')}</tbody></table></div>
    <p class="faint">Fleet records are verified at onboarding and are authoritative: feeds that report a different type or operator for these tails are flagged, not believed.</p>`;
  loadBookings();
  loadLegs();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await signIn($('#key').value.trim()); } catch (err) { toast(err.message); }
});
api('/api/config').then((c) => { $('#demo-keys').hidden = !c.demo; }).catch(() => {});
$('#apply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, String(v).trim()]));
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const r = await api('/api/operator-applications', { method: 'POST', body });
    e.target.hidden = true;
    $('#apply-done').hidden = false;
    $('#apply-done').textContent = `Thanks, ${body.name}. We'll email ${body.email} within one business day to set up your account${r.faaVerified ? ' (your Part 135 certificate checks out)' : ''}.`;
  } catch (err) { toast(err.message); btn.disabled = false; }
});
$('#logout').addEventListener('click', (e) => { e.preventDefault(); sessionStorage.removeItem('opKey'); location.reload(); });

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === b)));
  document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
  if (b.dataset.tab === 'legs') loadLegs();
  if (b.dataset.tab === 'messages') loadThreads();
  if (b.dataset.tab === 'bookings') loadBookings();
});

async function loadBookings() {
  const list = await api('/api/operator/bookings', { key });
  const panel = $('[data-panel="bookings"]');
  if (!list.length) { panel.innerHTML = '<div class="card empty">No booking requests yet.</div>'; return; }
  panel.innerHTML = `<div class="results">${list.map((b) => `
    <div class="card pad">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <strong>${esc(b.flight.from.iata)} → ${esc(b.flight.to.iata)}</strong> · ${esc(b.flight.tail)} · ${esc(when(b.flight.departEarliest))}
          <div class="faint">${b.pax} pax · ${esc(b.contact.name)} · requested ${esc(when(b.createdAt))}</div>
        </div>
        <div style="text-align:right"><div class="num"><strong>${money(b.operatorPayoutCents)}</strong> payout</div><span class="tag ${b.status === 'confirmed' ? 'good' : b.status === 'authorized' ? 'warn' : ''}">${esc(b.status.replace(/_/g, ' '))}</span></div>
      </div>
      ${b.status === 'authorized' ? `
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
          <button class="small" data-confirm="${esc(b.id)}">Confirm &amp; charge</button>
          <button class="small danger" data-decline="${esc(b.id)}">Decline</button>
          <span class="faint">Respond by ${esc(when(b.holdExpiresAt))} or the hold lapses.</span>
        </div>` : ''}
    </div>`).join('')}</div>`;
}

$('[data-panel="bookings"]').addEventListener('click', async (e) => {
  const c = e.target.closest('[data-confirm]');
  const d = e.target.closest('[data-decline]');
  try {
    if (c) { await api(`/api/operator/bookings/${c.dataset.confirm}/confirm`, { method: 'POST', key }); toast('Confirmed — traveler charged.'); }
    if (d) {
      const reason = prompt('Reason for declining (shared internally):') ?? '';
      await api(`/api/operator/bookings/${d.dataset.decline}/decline`, { method: 'POST', key, body: { reason } });
      toast('Declined — authorization released.');
    }
  } catch (err) { toast(err.message); }
  if (c || d) { loadBookings(); loadLegs(); }
});

async function loadLegs() {
  const legs = await api('/api/operator/legs', { key });
  const panel = $('[data-panel="legs"]');
  if (!legs.length) { panel.innerHTML = '<div class="card empty">No upcoming legs. Post one, or connect your scheduling system to the feed API.</div>'; return; }
  const live = legs.filter((l) => l.supplyStatus === 'available');
  const oldest = live.length ? Math.min(...live.map((l) => new Date(l.lastSeenAt).getTime())) : null;
  panel.innerHTML = `${live.length ? `<div class="card pad" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <span>Listings stay on sale for 7 days after you last confirm them${oldest ? ` (oldest confirmed ${esc(when(new Date(oldest).toISOString()))})` : ''}.</span>
      <button class="small" id="reconfirm" style="margin-left:auto">All still available</button></div>` : ''}
    <div class="card scroll-x"><table class="data"><thead><tr><th>Route</th><th>Departure</th><th>Aircraft</th><th>Your ask</th><th>Traveler price</th><th>Status</th><th>Issues</th><th></th></tr></thead><tbody>
    ${legs.map((l) => `<tr>
      <td><strong>${esc(l.from.iata)} → ${esc(l.to.iata)}</strong></td>
      <td>${esc(when(l.departEarliest))}</td>
      <td>${esc(l.tail)}<div class="faint">${esc(l.aircraft?.name)}</div></td>
      <td class="num">${l.askCents === null ? '<span class="faint">priced by us</span>' : `${(l.askCents / 100).toLocaleString()} ${esc(l.currency)}`}</td>
      <td class="num">${l.travelerPriceCents ? money(l.travelerPriceCents) : '—'}</td>
      <td>${l.commerceStatus !== 'open' ? `<span class="tag warn">${esc(l.commerceStatus)}</span>` : l.listed ? '<span class="tag good">listed</span>' : `<span class="tag bad">${esc(l.supplyStatus === 'available' ? 'not listed' : l.supplyStatus)}</span>`}</td>
      <td>${l.issues.map((i) => `<div class="${i.blocking ? '' : 'faint'}" title="${esc(i.detail)}">${i.blocking ? '⚠ ' : ''}${esc(i.detail)}</div>`).join('')}</td>
      <td>${l.supplyStatus === 'available' ? `<button class="small secondary" data-withdraw="${esc(l.id)}">Withdraw</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

$('[data-panel="legs"]').addEventListener('click', async (e) => {
  if (e.target.id === 'reconfirm') {
    try { const r = await api('/api/operator/legs/reconfirm', { method: 'POST', key }); toast(`${r.reconfirmed} leg${r.reconfirmed === 1 ? '' : 's'} confirmed for another 7 days.`); loadLegs(); } catch (err) { toast(err.message); }
    return;
  }
  const w = e.target.closest('[data-withdraw]');
  if (!w || !confirm('Withdraw this leg? Any traveler holding it will be notified and refunded.')) return;
  try { await api(`/api/operator/legs/${w.dataset.withdraw}/withdraw`, { method: 'POST', key }); toast('Leg withdrawn.'); loadLegs(); loadBookings(); } catch (err) { toast(err.message); }
});

function showReport(r) {
  $('#post-result').innerHTML = `<div class="notice ${r.rejected ? 'warn' : 'good'}">Accepted ${r.accepted}, rejected ${r.rejected}. ${r.legsCreated} new, ${r.legsUpdated} updated.
    ${r.issues.map((i) => `<div>• ${esc(i.externalId ?? 'record')}: ${esc(i.message)}</div>`).join('')}</div>`;
  loadLegs();
}

$('#post-one').addEventListener('submit', async (e) => {
  e.preventDefault();
  const early = new Date($('#p-early').value);
  const late = $('#p-late').value ? new Date($('#p-late').value) : early;
  const price = Number($('#p-price').value);
  try {
    showReport(await api('/api/operator/legs', {
      method: 'POST', key,
      body: [{
        externalId: `portal-${crypto.randomUUID()}`, tailNumber: $('#p-tail').value, from: $('#p-from').value, to: $('#p-to').value,
        departureEarliest: early.toISOString(), departureLatest: late.toISOString(),
        price: price > 0 ? { amount: Math.round(price * 100), currency: $('#p-ccy').value } : null, status: 'available',
      }],
    }));
  } catch (err) { toast(err.message); }
});

$('#post-csv').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { showReport(await api('/api/operator/legs', { method: 'POST', key, raw: true, body: $('#csv').value, headers: { 'content-type': 'text/csv' } })); } catch (err) { toast(err.message); }
});

// ---------- messages ----------
let openThread = null;
async function loadThreads() {
  const list = await api('/api/operator/threads', { key });
  $('#threads').innerHTML = list.length ? list.map((t) => `
    <div class="card thread-item ${t.id === openThread ? 'active' : ''}" data-thread="${esc(t.id)}">
      <strong>${esc(t.subject)}</strong>
      <span class="faint">${esc(t.lastMessage ?? '').slice(0, 90)}</span>
      <span class="faint">${esc(when(t.updatedAt))}</span>
    </div>`).join('') : '<div class="card empty">No conversations yet.</div>';
}

async function showThread(id) {
  openThread = id;
  const t = await api(`/api/operator/threads/${id}`, { key });
  $('#thread').innerHTML = `
    <h3>${esc(t.subject)}</h3>
    <div class="msgs">${t.messages.map((m) => `<div class="msg ${m.direction === 'in' ? 'out' : 'in'}"><div class="faint">${esc(m.direction === 'in' ? 'You' : 'Empty Leg Tracker')} · ${esc(when(m.at))}</div>${esc(m.body)}</div>`).join('')}</div>
    <form class="stack" id="reply"><textarea rows="3" placeholder="Write a reply…" required></textarea><button>Send</button></form>`;
  $('#reply').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/operator/threads/${id}/reply`, { method: 'POST', key, body: { body: e.target.querySelector('textarea').value } });
      showThread(id);
      loadThreads();
    } catch (err) { toast(err.message); }
  });
  loadThreads();
}

$('#threads').addEventListener('click', (e) => {
  const t = e.target.closest('[data-thread]');
  if (t) showThread(t.dataset.thread);
});

if (key) signIn(key).catch(() => sessionStorage.removeItem('opKey'));
