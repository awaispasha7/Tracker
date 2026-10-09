import { api, esc, money, when, toast, LOGO } from './common.js';

const $ = (s) => document.querySelector(s);
$('#brand').insertAdjacentHTML('afterbegin', LOGO);
let key = sessionStorage.getItem('adminKey') || '';
let tab = 'operators';
let issuedKeys = null;
let openThread = null;

const dur = (ms) => (ms == null ? '—' : ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);
const ago = (iso) => (iso ? when(iso) : 'never');
const statusTag = (s) => {
  const tone = { confirmed: 'good', completed: 'good', authorized: 'warn', awaiting_reply: 'warn', needs_decision: 'bad', offer_received: 'good', declined: 'bad', expired: 'bad', payment_failed: 'bad', cancelled_by_operator: 'bad' }[s] ?? '';
  return `<span class="tag ${tone}">${esc(String(s).replace(/_/g, ' '))}</span>`;
};

const views = {
  async operators() {
    const [apps, ops] = await Promise.all([api('/api/admin/operator-applications', { key }), api('/api/admin/operators', { key })]);
    const pending = apps.filter((a) => a.status === 'pending');
    const decided = apps.filter((a) => a.status !== 'pending').slice(0, 20);
    const keys = issuedKeys;
    issuedKeys = null;
    return `
      ${keys ? `<div class="notice good stack"><strong>${esc(keys.company)} approved.</strong> These keys are shown once and were emailed to the operator.
        <div>Portal key: <code>${esc(keys.portalKey)}</code></div><div>Feed key: <code>${esc(keys.feedKey)}</code> for <code>POST /api/feeds/api:${esc(keys.operatorId)}</code></div></div>` : ''}
      <div class="card pad stack">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><h2 style="margin:0">Operator applications</h2>
          <a href="/operator/apply" target="_blank" class="faint">Public application form ↗</a></div>
        <p class="faint" style="margin:0">Before approving, verify the certificate. US operators: look up the company and certificate number on the FAA's list of Part 135 certificate holders. Check that each tail number is on that certificate.</p>
      </div>
      ${pending.length ? pending.map((a) => `
        <div class="card pad stack" style="margin-top:12px">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><h3 style="margin:0">${esc(a.company)}</h3>${statusTag(a.status)}<span class="faint">applied ${esc(when(a.createdAt))}</span></div>
          <div class="grid2">
            <div><div class="faint">Certificate</div>${esc(a.certificate)} · <strong>${esc(a.certificateNumber)}</strong></div>
            <div><div class="faint">Contact</div>${esc(a.contactName)} · <a href="mailto:${esc(a.email)}">${esc(a.email)}</a> · ${esc(a.phone)}${a.website ? ` · <a href="${esc(a.website)}" target="_blank" rel="noopener">${esc(a.website)}</a>` : ''}</div>
          </div>
          <div class="scroll-x"><table class="data"><thead><tr><th>Tail</th><th>Aircraft</th><th>Category</th><th>Seats</th><th>Base</th><th>Year</th><th></th></tr></thead><tbody>
            ${a.fleet.map((f) => `<tr><td>${esc(f.tail)}</td><td>${esc(f.typeName ?? f.model)}</td><td>${esc(f.category ?? '?')}</td><td>${f.seats}</td><td>${esc(f.homeBase)}</td><td>${f.year}</td>
              <td class="faint">${esc(f.problems.map((p) => p.replace(/^note: /, '')).join('; '))}</td></tr>`).join('')}</tbody></table></div>
          ${a.notes ? `<div class="faint">Notes: ${esc(a.notes)}</div>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button data-app-approve="${esc(a.id)}" data-company="${esc(a.company)}">Approve</button><button class="danger" data-app-reject="${esc(a.id)}">Reject</button></div>
        </div>`).join('') : '<div class="card empty" style="margin-top:12px">No applications waiting.</div>'}
      <h2 style="margin:24px 0 8px">Operators</h2>
      ${ops.length ? `<div class="card scroll-x"><table class="data"><thead><tr><th>Name</th><th>Certificate</th><th>Contact</th><th>Status</th><th></th></tr></thead><tbody>
        ${ops.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.certificate)}</td><td>${esc(o.contact?.email ?? '')} ${esc(o.contact?.phone ?? '')}</td><td>${statusTag(o.status)}</td>
          <td>${o.source === 'aviapages' ? '<span class="faint">network</span>' : `<button class="secondary small" data-op-status="${esc(o.id)}" data-to="${o.status === 'active' ? 'suspended' : 'active'}">${o.status === 'active' ? 'Suspend' : 'Reactivate'}</button>`}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="card empty">No operators yet. Share the application form with operators you sign.</div>'}
      ${decided.length ? `<h3 style="margin:24px 0 8px">Recent decisions</h3><div class="card scroll-x"><table class="data"><tbody>
        ${decided.map((a) => `<tr><td>${esc(a.company)}</td><td>${statusTag(a.status)}</td><td class="faint">${esc(a.decisionNote ?? '')}</td><td class="faint">${esc(a.decidedAt ? when(a.decidedAt) : '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  },

  async integrations() {
    const { aviapages: a } = await api('/api/admin/integrations', { key });
    if (!a.enabled) return '<div class="card empty">Aviapages integration is off. Set <code>AVIAPAGES_API_KEY</code> (live) or <code>AVIAPAGES_MODE=mock</code> and restart.</div>';
    const s = a.sync;
    const check = a.lastCheck;
    return `
      <div class="card pad stack">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <h2 style="margin:0">Aviapages</h2>
          <span class="tag ${a.mode === 'live' ? 'good' : 'warn'}">${a.mode === 'live' ? 'LIVE' : 'MOCK DATA'}</span>
          <span class="faint">${esc(a.baseUrl)}</span>
        </div>
        ${a.mode === 'mock' ? '<div class="notice warn">Running against the built-in mock. Start the server with <code>AVIAPAGES_API_KEY=…</code> to use your real account.</div>' : ''}
        ${s.freshnessAtRisk ? `<div class="notice bad">Budget can't sustain full syncs inside the listing freshness window (needs one every ${dur(12 * 3_600_000)}, budget allows every ${dur(s.fullIntervalMs)}). Listings will drop out between syncs: raise the empty_legs budget or <code>AVIAPAGES_LISTING_MAX_AGE_MINUTES</code>.</div>` : ''}
      </div>
      <div class="kpis" style="margin-top:12px">
        ${[['Operators learned', a.learned.operators], ['Aircraft learned', a.learned.aircraft], ['Airports learned', a.learned.airports], ['Aircraft types learned', a.learned.aircraftTypes],
          ['Flight times cached', a.learned.flightTimes], ['Market prices cached', a.learned.marketPrices], ['Responses archived', a.learned.archivedResponses]]
          .map(([k, v]) => `<div class="card kpi"><div class="faint">${k}</div><div class="v num">${Number(v).toLocaleString()}</div></div>`).join('')}
      </div>
      <div class="grid2" style="margin-top:12px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));align-items:start">
        <div class="card pad stack">
          <h3 style="margin:0">Empty-leg sync</h3>
          <div class="faint">Last full: ${esc(ago(s.lastFullAt ? new Date(s.lastFullAt).toISOString() : null))} · next: ${esc(s.nextFullAt ? when(s.nextFullAt) : 'on next tick')}</div>
          <div class="faint">Full-sync interval (paced to budget): ${dur(s.fullIntervalMs)} · pages per full sync: ${s.pagesPerFull ?? '—'}</div>
          <div class="faint">empty_legs calls left this month: ${s.remainingCalls.toLocaleString()} / ${s.budget.toLocaleString()}</div>
          ${s.lastReport ? `<div class="faint">Last run (${esc(s.lastReport.kind)}): ${s.lastReport.received} received, ${s.lastReport.ingested} ingested, ${s.lastReport.removed} removed${Object.keys(s.lastReport.skipped).length ? `, skipped ${esc(JSON.stringify(s.lastReport.skipped))}` : ''}${s.lastReport.error ? ` — <span style="color:var(--bad)">${esc(s.lastReport.error)}</span>` : ''}</div>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="small" data-act="sync-full">Run full sync</button><button class="small secondary" data-act="sync-incremental">Run incremental</button></div>
        </div>
        <div class="card pad stack">
          <h3 style="margin:0">Operator RFQs</h3>
          <div class="faint">Open RFQs: ${a.openRfqs ? 'yes — polling for replies' : 'none (no polling, no cost)'}</div>
          <div class="faint">Last poll: ${esc(ago(a.comms.lastPollAt ? new Date(a.comms.lastPollAt).toISOString() : null))} ${a.comms.lastResult ? esc(JSON.stringify(a.comms.lastResult)) : ''}</div>
          <div><button class="small secondary" data-act="poll">Poll replies now</button></div>
        </div>
      </div>
      <div class="card pad stack" style="margin-top:12px">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><h3 style="margin:0">Live contract check</h3>
          <label class="check" style="margin-left:auto"><input type="checkbox" id="writes"> include RFQ create (sent to yourself, then archived)</label>
          <button class="small" data-act="check">Run check</button></div>
        <p class="faint" style="margin:0">Calls every endpoint the site depends on once and validates each response against Aviapages' published OpenAPI spec.</p>
        ${check ? `<div class="faint">Last run ${esc(when(check.at))} (${esc(check.mode)}): <strong>${check.summary.passed} passed</strong>, ${check.summary.failed} failed, ${check.summary.skipped} skipped</div>
          <div class="scroll-x"><table class="data"><thead><tr><th>Check</th><th>Feature</th><th>HTTP</th><th>ms</th><th>Result</th></tr></thead><tbody>
          ${check.results.map((r) => `<tr><td>${esc(r.name)}<div class="faint">${esc(r.method)} ${esc(r.path)}</div></td><td>${esc(r.feature)}</td><td>${r.status ?? '—'}</td><td class="num">${r.ms}</td>
            <td>${r.ok ? '<span class="tag good">pass</span>' : r.note.startsWith('skipped') ? '<span class="tag">skipped</span>' : '<span class="tag bad">fail</span>'} <span class="faint">${esc(r.note)}</span>${r.schemaErrors.length ? `<div class="faint">${r.schemaErrors.slice(0, 3).map(esc).join('<br>')}</div>` : ''}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="faint">Not run yet.</div>'}
      </div>
      <div class="card pad" style="margin-top:12px">
        <h3>API usage this month</h3>
        ${a.usage.length ? `<div class="scroll-x"><table class="data"><thead><tr><th>Endpoint</th><th>Calls / budget</th><th></th><th>Errors</th><th>Last</th></tr></thead><tbody>
          ${a.usage.map((u) => { const pct = Math.min(100, Math.round((u.calls / u.budget) * 100)); return `<tr><td>${esc(u.endpoint)}</td><td class="num">${u.calls.toLocaleString()} / ${u.budget.toLocaleString()}</td>
            <td style="min-width:120px"><div class="bar ${pct > 80 ? 'hot' : ''}"><span style="width:${pct}%"></span></div></td><td class="num">${u.errors}</td><td>${u.lastStatus ?? '—'} <span class="faint">${esc(ago(u.lastAt))}</span></td></tr>`; }).join('')}
        </tbody></table></div>` : '<div class="faint">No calls yet.</div>'}
      </div>
      ${s.history?.length ? `<div class="card pad" style="margin-top:12px"><h3>Sync history</h3><div class="scroll-x"><table class="data"><thead><tr><th>When</th><th>Kind</th><th>Pages</th><th>Received</th><th>Ingested</th><th>Removed</th><th>Result</th></tr></thead><tbody>
        ${s.history.map((h) => `<tr><td>${esc(when(h.startedAt))}</td><td>${esc(h.kind)}</td><td>${h.pages}</td><td>${h.received}</td><td>${h.ingested}</td><td>${h.removed}</td><td>${h.error ? `<span class="tag bad">${esc(h.error)}</span>` : h.complete ? '<span class="tag good">complete</span>' : '<span class="tag warn">partial</span>'}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
  },

  async inbox() {
    const threads = await api('/api/admin/threads', { key });
    return `<div class="split">
      <div class="thread-list" id="threads">${threads.length ? threads.map((t) => `
        <div class="card thread-item ${t.id === openThread ? 'active' : ''}" data-thread="${esc(t.id)}">
          <div style="display:flex;gap:6px;align-items:center;justify-content:space-between"><strong>${esc(t.operator?.name ?? 'Unassigned')}</strong>${t.needsAttention ? '<span class="tag bad">needs you</span>' : ''}</div>
          <span>${esc(t.subject)}</span>
          <span class="faint">${statusTag(t.status)} ${esc((t.lastMessage ?? '').slice(0, 70))}</span>
          <span class="faint">${esc(when(t.updatedAt))}</span>
        </div>`).join('') : '<div class="card empty">No conversations yet. Booking a network operator\'s leg or sending a charter request starts one.</div>'}</div>
      <div class="card pad" id="thread"><p class="faint">Select a conversation.</p></div>
    </div>`;
  },

  async bookings() {
    const rows = await api('/api/admin/bookings', { key });
    if (!rows.length) return '<div class="card empty">No bookings yet.</div>';
    return `<div class="card scroll-x"><table class="data"><thead><tr><th>Booking</th><th>Flight</th><th>Operator</th><th>Traveler</th><th>Total / payout</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((b) => `<tr>
        <td>${esc(b.id)}<div class="faint">${esc(when(b.createdAt))}</div></td>
        <td><strong>${esc(b.flight?.from?.iata || b.flight?.from?.icao)} → ${esc(b.flight?.to?.iata || b.flight?.to?.icao)}</strong><div class="faint">${esc(b.flight?.aircraft ?? '')} ${esc(b.flight?.tail ?? '')} · ${esc(when(b.flight?.departEarliest))}</div></td>
        <td>${esc(b.operator?.name ?? '')}<div class="faint">${b.operator?.source === 'aviapages' ? 'Aviapages network' : 'direct'}</div></td>
        <td>${esc(b.contact.name)}<div class="faint">${esc(b.contact.email)} · ${b.pax} pax</div></td>
        <td class="num">${money(b.totalCents)}<div class="faint">${money(b.operatorPayoutCents)}</div></td>
        <td>${statusTag(b.status)}${b.threadStatus ? `<div class="faint">operator: ${esc(b.threadStatus.replace(/_/g, ' '))}</div>` : ''}</td>
        <td>${b.status === 'authorized' ? `<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="small" data-confirm="${esc(b.id)}">Confirm</button><button class="small danger" data-decline="${esc(b.id)}">Decline</button></div>` : ''}
          ${b.threadId ? `<a href="#" data-goto-thread="${esc(b.threadId)}">conversation</a>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>
      <p class="faint">Confirm on behalf of network operators once they've committed (by RFQ reply, email or phone). Confirming captures the card.</p>`;
  },

  async charters() {
    const rows = await api('/api/admin/charter-requests', { key });
    if (!rows.length) return '<div class="card empty">No custom charter requests yet.</div>';
    return `<div class="card scroll-x"><table class="data"><thead><tr><th>Request</th><th>Route</th><th>Traveler</th><th>Status</th><th>Offers</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.from)} → ${esc(r.to)}<div class="faint">${esc(when(r.departAt))} · ${r.pax} pax</div></td>
        <td>${esc(r.contact.name)}<div class="faint">${esc(r.contact.email)}</div></td><td>${statusTag(r.status)}</td><td class="num">${r.offers}</td></tr>`).join('')}
    </tbody></table></div>`;
  },

  async review() {
    const rows = await api('/api/admin/review', { key });
    return `<p class="muted">Legs held back from travelers (or listed with advisories). Conflicts come from feed reconciliation; price failures from pricing guardrails.</p>
    <div class="card scroll-x"><table class="data"><thead><tr><th>Leg</th><th>Operator</th><th>Listed</th><th>Why</th><th>Price</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td><strong>${esc(r.leg.from.iata || r.leg.from.icao)} → ${esc(r.leg.to.iata || r.leg.to.icao)}</strong> ${esc(r.leg.tail)}<div class="faint">${esc(when(r.leg.departEarliest))} · conf ${r.leg.confidence}</div></td>
      <td>${esc(r.operator ?? '—')}</td>
      <td>${r.listed ? '<span class="tag good">yes</span>' : '<span class="tag bad">no</span>'}</td>
      <td>${r.conflicts.map((c) => `<div class="${c.blocking ? '' : 'faint'}"><code>${esc(c.code)}</code> ${esc(c.detail)}${c.values ? `<div class="faint">${c.values.map((v) => `${esc(v.sourceId)}: ${esc(v.value)}`).join(' · ')}</div>` : ''}</div>`).join('')}
          ${r.priceFailures.map((f) => `<div><code>${esc(f.code)}</code> ${esc(f.message)}</div>`).join('')}</td>
      <td class="num">${r.candidatePriceCents ? money(r.candidatePriceCents) : '—'}${r.lastPublishedPriceCents ? `<div class="faint">was ${money(r.lastPublishedPriceCents)}</div>` : ''}</td>
      <td>${r.priceFailures.some((f) => f.code === 'PRICE_JUMP') ? `<button class="small" data-approve="${esc(r.leg.id)}">Approve price</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
  },

  async errors() {
    const rows = await api('/api/admin/ingest-errors', { key });
    if (!rows.length) return '<div class="card empty">No rejected feed records.</div>';
    return `<div class="card scroll-x"><table class="data"><thead><tr><th>When</th><th>Source</th><th>Record</th><th>Problem</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(when(new Date(r.received_at).toISOString()))}</td><td>${esc(r.source_id)}</td><td>${esc(r.external_id ?? '—')}</td><td><code>${esc(r.code)}</code> ${esc(r.message)}</td></tr>`).join('')}</tbody></table></div>`;
  },

  async outbox() {
    const rows = await api('/api/admin/notifications', { key });
    if (!rows.length) return '<div class="card empty">No notifications yet. Create a route alert or a booking.</div>';
    return `<div class="card scroll-x"><table class="data"><thead><tr><th>To</th><th>Subject</th><th>Body</th><th>Sent</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.recipient)}</td><td>${esc(r.subject)}</td><td class="faint">${esc(r.body)}</td><td>${r.sent_at ? '✓' : 'queued'}</td></tr>`).join('')}</tbody></table></div>`;
  },

  async ledger() {
    const rows = await api('/api/admin/ledger', { key });
    if (!rows.length) return '<div class="card empty">No captured payments yet.</div>';
    return `<p class="muted">Balances across all bookings. Postings are balanced: they always sum to zero.</p><div class="card scroll-x"><table class="data"><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.account)}</td><td class="num">${money(r.balance_cents, { cents: true })}</td></tr>`).join('')}</tbody></table></div>`;
  },
};

async function render() {
  try {
    $('#panel').innerHTML = await views[tab]();
    if (tab === 'inbox' && openThread) showThread(openThread);
  } catch (e) { toast(e.message); }
  refreshAttention();
}

async function refreshAttention() {
  try {
    const n = (await api('/api/admin/threads?attention=1', { key })).length;
    $('#attn').hidden = n === 0;
    $('#attn').textContent = String(n);
    const p = (await api('/api/admin/operator-applications?status=pending', { key })).length;
    $('#apps').hidden = p === 0;
    $('#apps').textContent = String(p);
  } catch { /* ignore */ }
}

async function showThread(id) {
  openThread = id;
  document.querySelectorAll('[data-thread]').forEach((el) => el.classList.toggle('active', el.dataset.thread === id));
  const t = await api(`/api/admin/threads/${id}`, { key });
  const el = $('#thread');
  if (!el) return;
  el.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><h3 style="margin:0">${esc(t.subject)}</h3>${statusTag(t.status)}</div>
    <div class="faint">${t.operator ? `${esc(t.operator.name)} · ${t.operator.source === 'aviapages' ? 'Aviapages network' : 'direct'} · ${esc(t.operator.email ?? 'no email')} · ${esc(t.operator.phone ?? '')}` : 'Unassigned sender'}
      ${t.bookingId ? ` · booking ${esc(t.bookingId)}` : ''}${t.externalRef ? ` · ${esc(t.externalRef)}` : ''}</div>
    <div class="msgs">${t.messages.map((m) => `<div class="msg ${m.direction}">
      <div class="faint">${esc(m.author)} · ${esc(m.channel)}${m.deliveryStatus ? ` · ${esc(m.deliveryStatus)}` : ''} · ${esc(when(m.at))}</div>
      ${esc(m.body)}${m.priceCents != null ? `<div><strong class="num">${(m.priceCents / 100).toLocaleString()} ${esc(m.currency ?? '')}</strong></div>` : ''}</div>`).join('')}</div>
    ${t.operator ? `<form class="stack" id="compose"><textarea rows="3" placeholder="Write to ${esc(t.operator.name)} (sent by email${t.operator.source === 'direct' ? ' and shown in their portal' : ''})" required></textarea>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button>Send</button>
      ${t.kind === 'booking' && t.status !== 'closed' ? '<button type="button" class="secondary" data-act="retry">Re-send request</button>' : ''}
      <button type="button" class="secondary" data-act="resolve">Mark resolved</button></div></form>` : '<button class="secondary" data-act="resolve">Mark resolved</button>'}`;
  $('#compose')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/admin/threads/${id}/messages`, { method: 'POST', key, body: { body: e.target.querySelector('textarea').value } });
      toast('Sent.');
      render();
    } catch (err) { toast(err.message); }
  });
}

async function signIn(k) {
  await api('/api/admin/sources', { key: k });
  key = k;
  sessionStorage.setItem('adminKey', k);
  $('#login').hidden = true;
  $('#ops').hidden = false;
  render();
}

$('#login-form').addEventListener('submit', (e) => { e.preventDefault(); signIn($('#key').value.trim()).catch((err) => toast(err.message)); });
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === b)));
  render();
});

$('#panel').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-thread]');
  if (t) return showThread(t.dataset.thread);
  const g = e.target.closest('[data-goto-thread]');
  if (g) {
    e.preventDefault();
    openThread = g.dataset.gotoThread;
    tab = 'inbox';
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === 'inbox')));
    return render();
  }
  const btn = e.target.closest('button');
  if (!btn) return;
  const act = btn.dataset.act;
  try {
    if (act === 'sync-full' || act === 'sync-incremental') {
      btn.disabled = true;
      const r = await api('/api/admin/integrations/aviapages/sync', { method: 'POST', key, body: { kind: act === 'sync-full' ? 'full' : 'incremental' } });
      toast(r.error ? `Sync error: ${r.error}` : `${r.kind} sync: ${r.received} received, ${r.ingested} ingested, ${r.removed} removed`);
    } else if (act === 'poll') {
      const r = await api('/api/admin/integrations/aviapages/poll', { method: 'POST', key });
      toast(r.error ? `Poll error: ${r.error}` : `${r.newReplies} new operator replies`);
    } else if (act === 'check') {
      btn.disabled = true;
      btn.textContent = 'Checking…';
      const r = await api('/api/admin/integrations/aviapages/check', { method: 'POST', key, body: { includeWrites: $('#writes')?.checked } });
      toast(`${r.summary.passed} passed, ${r.summary.failed} failed`);
    } else if (act === 'retry') {
      await api(`/api/admin/threads/${openThread}/retry`, { method: 'POST', key });
      toast('Request re-sent.');
    } else if (act === 'resolve') {
      await api(`/api/admin/threads/${openThread}/resolve`, { method: 'POST', key });
    } else if (btn.dataset.confirm) {
      await api(`/api/admin/bookings/${btn.dataset.confirm}/confirm`, { method: 'POST', key });
      toast('Confirmed — traveler and operator notified.');
    } else if (btn.dataset.decline) {
      const reason = prompt('Reason (shared with the operator thread):') ?? '';
      await api(`/api/admin/bookings/${btn.dataset.decline}/decline`, { method: 'POST', key, body: { reason } });
      toast('Declined — authorization released.');
    } else if (btn.dataset.appApprove) {
      if (!confirm(`Approve ${btn.dataset.company}? Their aircraft become verified and they can publish legs immediately.`)) return;
      const r = await api(`/api/admin/operator-applications/${btn.dataset.appApprove}/approve`, { method: 'POST', key });
      issuedKeys = { ...r, company: btn.dataset.company };
    } else if (btn.dataset.appReject) {
      const reason = prompt('Reason (emailed to the applicant):');
      if (reason === null) return;
      await api(`/api/admin/operator-applications/${btn.dataset.appReject}/reject`, { method: 'POST', key, body: { reason } });
      toast('Rejected; applicant emailed.');
    } else if (btn.dataset.opStatus) {
      await api(`/api/admin/operators/${btn.dataset.opStatus}/status`, { method: 'POST', key, body: { status: btn.dataset.to } });
      toast(btn.dataset.to === 'suspended' ? 'Suspended; their legs are hidden.' : 'Reactivated.');
    } else if (btn.dataset.approve) {
      const r = await api(`/api/admin/legs/${btn.dataset.approve}/approve-price`, { method: 'POST', key });
      toast(`Approved at ${money(r.approvedPriceCents)}`);
    } else return;
  } catch (err) {
    toast(err.message);
  }
  render();
});

if (key) signIn(key).catch(() => sessionStorage.removeItem('adminKey'));
setInterval(() => { if (!$('#ops').hidden && (tab === 'integrations' || tab === 'inbox')) refreshAttention(); }, 20_000);
