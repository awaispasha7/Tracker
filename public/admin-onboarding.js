// Ops console: signing operators (Prospects from the FAA Part 135 list and applications),
// onboarding them (Operators), and the market inputs pricing depends on (Market).
import { api, esc, when, toast } from './common.js';

const $ = (s) => document.querySelector(s);
const CATEGORIES = ['turboprop', 'light', 'midsize', 'super-midsize', 'heavy', 'ultra-long'];
const STATUSES = ['new', 'contacted', 'interested', 'applied', 'onboarding', 'signed', 'declined'];
const statusTone = { signed: 'good', interested: 'good', applied: 'warn', onboarding: 'warn', contacted: '', declined: 'bad', active: 'good', suspended: 'bad' };
const tag = (s) => `<span class="tag ${statusTone[s] ?? ''}">${esc(s)}</span>`;
const cats = (c) => (c ? Object.entries(c).map(([k, n]) => `${n} ${esc(k)}`).join(', ') : '');

export const state = {
  operatorId: null, // operator open in the detail panel
  keys: null, // keys just issued (shown once)
  prefill: null, // operator form values carried over from a prospect
  prospectId: null,
  prospectFilter: { q: '', status: '', category: '', minJets: '1' },
  aircraftPrefill: null,
};

let types = null;
async function aircraftTypes(key) {
  types ??= await api('/api/admin/aircraft-types', { key });
  return types;
}

// ---------- Operators ----------

export async function operators(key) {
  const [rows, detail] = await Promise.all([
    api('/api/admin/operators', { key }),
    state.operatorId ? api(`/api/admin/operators/${state.operatorId}`, { key }).catch(() => null) : null,
  ]);
  const p = state.prefill ?? {};
  return `
    ${state.keys ? keysBox(state.keys) : ''}
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="card pad stack" style="order:${p.prospectId ? 0 : 1};max-width:720px">
        <h3 style="margin:0">${p.prospectId ? `Onboard ${esc(p.name)}` : 'Add an operator'}</h3>
        <p class="faint" style="margin:0">Creates their portal login and feed key. Use the FAA certificate designator (e.g. <code>XYZA123B</code>) so their aircraft can be checked against the Part 135 list.</p>
        <form class="stack" id="op-create">
          <label>Company name<input name="name" required value="${esc(p.name ?? '')}"></label>
          <div class="grid2">
            <label>FAA certificate designator<input name="certificateNumber" value="${esc(p.certificateNumber ?? '')}" placeholder="optional for non-US"></label>
            <label>Contact name<input name="contactName" value="${esc(p.contactName ?? '')}"></label>
          </div>
          <div class="grid2">
            <label>Email<input name="email" type="email" required value="${esc(p.email ?? '')}"></label>
            <label>Phone<input name="phone" value="${esc(p.phone ?? '')}"></label>
          </div>
          <label>Website<input name="website" value="${esc(p.website ?? '')}"></label>
          <div style="display:flex;gap:8px"><button>Create operator</button>${p.prospectId ? '<button type="button" class="secondary" data-ob="clear-prefill">Cancel</button>' : ''}</div>
        </form>
      </div>
      <div class="card pad stack" style="order:${p.prospectId ? 1 : 0}">
        <h3 style="margin:0">Signed operators</h3>
        ${rows.length ? `<div class="scroll-x"><table class="data"><thead><tr><th>Operator</th><th>Fleet</th><th>Live legs</th><th>Bookings</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map((o) => `<tr><td><strong>${esc(o.name)}</strong><div class="faint">${[o.contact?.certificateNumber ?? o.certificate, o.contact?.email].filter(Boolean).map(esc).join(' · ')}</div></td>
            <td class="num">${o.fleetSize}</td><td class="num">${o.liveLegs}</td><td class="num">${o.confirmedBookings}</td><td>${tag(o.status)}</td>
            <td><button class="small secondary" data-ob="open-op" data-id="${esc(o.id)}">Manage</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="faint">No operators yet. Start from Prospects, or add one here.</div>'}
      </div>
    </div>
    ${detail ? await operatorPanel(detail, key) : ''}`;
}

function keysBox(k) {
  return `<div class="card pad stack notice good" style="margin-bottom:12px" id="keys-box">
    <strong>Keys for ${esc(k.operatorName)}: copy them now, they are not shown again.</strong>
    ${k.portalKey ? `<div>Portal login (operator signs in at <code>/operator</code>): <code class="copy">${esc(k.portalKey)}</code></div>` : ''}
    ${k.feedKey ? `<div>Feed key for their systems: <code class="copy">${esc(k.feedKey)}</code> → <code>POST /api/feeds/${esc(k.feedSourceId)}</code> (JSON or CSV)</div>` : ''}
    <div><button class="small secondary" data-ob="dismiss-keys">Done, I've saved them</button></div>
  </div>`;
}

async function operatorPanel(o, key) {
  const t = await aircraftTypes(key);
  const a = state.aircraftPrefill ?? {};
  const c = o.contact ?? {};
  const faa = o.faa;
  const missing = faa?.aircraft?.filter((x) => !x.onOurPlatform) ?? [];
  return `<div class="card pad stack" style="margin-top:12px" id="op-detail">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <h2 style="margin:0">${esc(o.name)}</h2>${tag(o.status)}
      <span class="faint">${esc(o.id)}</span>
      <span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">
        <button class="small secondary" data-ob="rotate" data-which="portal">New portal key</button>
        <button class="small secondary" data-ob="rotate" data-which="feed">New feed key</button>
        <button class="small ${o.status === 'active' ? 'danger' : ''}" data-ob="toggle-status">${o.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
        <button class="small secondary" data-ob="close-op">Close</button>
      </span>
    </div>
    ${faa ? (faa.found ? `<div class="notice info">FAA Part 135 certificate <strong>${esc(faa.designator)}</strong>: ${faa.tailsOnCertificate} aircraft on the certificate.</div>`
      : `<div class="notice bad">Certificate ${esc(faa.designator)} is not in the imported FAA list.</div>`) : ''}
    <form class="stack" id="op-edit">
      <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        <label>Company name<input name="name" value="${esc(o.name)}"></label>
        <label>FAA certificate designator<input name="certificateNumber" value="${esc(c.certificateNumber ?? '')}"></label>
        <label>Contact name<input name="contactName" value="${esc(c.contactName ?? '')}"></label>
        <label>Email<input name="email" type="email" value="${esc(c.email ?? '')}"></label>
        <label>Phone<input name="phone" value="${esc(c.phone ?? '')}"></label>
        <label>Website<input name="website" value="${esc(c.website ?? '')}"></label>
      </div>
      <div><button class="small">Save details</button></div>
    </form>
    <h3 style="margin:8px 0 0">Fleet</h3>
    <p class="faint" style="margin:0">Only aircraft listed here can be sold: legs on any other tail are quarantined.</p>
    ${o.fleet.length ? `<div class="scroll-x"><table class="data"><thead><tr><th>Tail</th><th>Type</th><th>Seats</th><th>Base</th><th>Year</th><th>FAA</th><th></th></tr></thead><tbody>
      ${o.fleet.map((x) => `<tr><td><strong>${esc(x.tail)}</strong></td><td>${esc(x.typeName)}</td><td class="num">${x.seats}</td><td>${esc(x.homeBase)}</td><td>${x.year || '—'}</td>
        <td>${x.onCertificate == null ? '<span class="faint">—</span>' : x.onCertificate ? '<span class="tag good">on certificate</span>' : '<span class="tag bad">not on certificate</span>'}</td>
        <td><button class="small danger" data-ob="remove-ac" data-tail="${esc(x.tail)}">Remove</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="faint">No aircraft yet.</div>'}
    ${missing.length ? `<details ${o.fleet.length ? '' : 'open'}><summary>${missing.length} aircraft on their FAA certificate not added yet</summary>
      <div class="scroll-x"><table class="data"><thead><tr><th>Tail</th><th>FAA model</th><th>Category</th><th></th></tr></thead><tbody>
      ${missing.map((x) => `<tr><td>${esc(x.tail)}</td><td>${esc(x.model)}</td><td>${esc(x.category ?? '—')}</td>
        <td><button class="small secondary" data-ob="prefill-ac" data-tail="${esc(x.tail)}" data-type="${esc(x.suggested_type ?? '')}" data-cat="${esc(x.category ?? '')}" data-model="${esc(x.model)}">Use</button></td></tr>`).join('')}
      </tbody></table></div></details>` : ''}
    <form class="stack" id="ac-add">
      <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        <label>Registration<input name="tail" required value="${esc(a.tail ?? '')}" placeholder="N123AB"></label>
        <label>Type<select name="typeCode">
          <option value="">Choose…</option>
          ${t.map((x) => `<option value="${esc(x.code)}" data-seats="${x.seats}" ${a.typeCode === x.code ? 'selected' : ''}>${esc(x.name)} (${esc(x.category)})</option>`).join('')}
          <option value="__new" ${a.newType ? 'selected' : ''}>Other type…</option>
        </select></label>
        <label>Seats<input name="seats" type="number" min="1" max="30" required value="${esc(a.seats ?? '')}"></label>
        <label>Home base<input name="homeBase" required placeholder="TEB or KTEB" value="${esc(a.homeBase ?? '')}"></label>
        <label>Year<input name="year" type="number" min="1960" max="2035" value="${esc(a.year ?? '')}"></label>
      </div>
      <div class="grid2" id="new-type" ${a.newType ? '' : 'hidden'}>
        <label>Type name<input name="newTypeName" value="${esc(a.newType?.name ?? '')}" placeholder="e.g. Citation Latitude"></label>
        <label>Category<select name="newTypeCategory">${CATEGORIES.map((x) => `<option ${a.newType?.category === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      </div>
      ${a.warning ? `<div class="notice warn" id="ac-warning">${esc(a.warning)}</div>` : ''}
      <label class="check"><input type="checkbox" name="override"> Add even if it isn't on their FAA certificate (I've verified it)</label>
      <div><button class="small">Add aircraft</button></div>
    </form>
  </div>`;
}

// ---------- Prospects ----------

export async function prospects(key) {
  const f = state.prospectFilter;
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ''));
  const [stats, rows, detail] = await Promise.all([
    api('/api/admin/faa/stats', { key }),
    api(`/api/admin/prospects?${qs}`, { key }),
    state.prospectId ? api(`/api/admin/prospects/${encodeURIComponent(state.prospectId)}`, { key }).catch(() => null) : null,
  ]);
  return `
    <div class="card pad stack">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <h3 style="margin:0">FAA Part 135 operators</h3>
        <span class="faint">${stats.loaded ? `${stats.operators.toLocaleString()} certificate holders, ${stats.aircraft.toLocaleString()} aircraft loaded` : 'Not loaded yet'}</span>
        <label class="secondary" style="margin-left:auto;display:inline-flex;align-items:center;gap:8px">
          <span class="faint">${stats.loaded ? 'Re-import' : 'Import'} (.xlsx or .csv)</span><input type="file" id="faa-file" accept=".xlsx,.csv">
        </label>
      </div>
      ${stats.loaded ? '' : `<div class="notice info">Download the free "Part 135 Certificate Holders" list (with aircraft) from the FAA (faa.gov → Air Operator / Part 135 resources) and import it here. Every certificate holder becomes a prospect you can filter by fleet, and aircraft added later are checked against it.</div>`}
    </div>
    <form class="card pad" id="pf" style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:end">
      <label style="flex:2 1 200px">Search<input name="q" value="${esc(f.q)}" placeholder="name, designator, FSDO"></label>
      <label style="flex:1 1 130px">Status<select name="status"><option value="">Any</option>${STATUSES.map((s) => `<option ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label style="flex:1 1 130px">Has category<select name="category"><option value="">Any</option>${CATEGORIES.map((s) => `<option ${f.category === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label style="flex:1 1 110px">Min. jets<input name="minJets" type="number" min="0" value="${esc(f.minJets)}"></label>
      <button>Filter</button>
    </form>
    ${detail ? prospectPanel(detail) : ''}
    <div class="card scroll-x" style="margin-top:12px"><table class="data"><thead><tr><th>Company</th><th>Certificate</th><th>Fleet</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map((r) => `<tr>
        <td><strong>${esc(r.company)}</strong>${r.source === 'application' ? ' <span class="tag warn">applied</span>' : ''}<div class="faint">${esc(r.districtOffice ?? '')}</div></td>
        <td>${esc(r.designator ?? '—')}</td>
        <td>${r.aircraftCount != null ? `${r.jetCount} jets / ${r.aircraftCount}<div class="faint">${cats(r.categories)}</div>` : '<span class="faint">not in FAA list</span>'}</td>
        <td>${tag(r.status)}${r.operatorId ? ` <span class="faint">${esc(r.operatorId)}</span>` : ''}</td>
        <td class="faint">${r.updatedAt ? esc(when(r.updatedAt)) : '—'}</td>
        <td><button class="small secondary" data-ob="open-prospect" data-id="${esc(r.id)}">Open</button></td></tr>`).join('')
        : `<tr><td colspan="6" class="faint">${stats.loaded ? 'No prospects match.' : 'Import the FAA list, or wait for operator applications.'}</td></tr>`}
    </tbody></table></div>`;
}

function prospectPanel(p) {
  const app = p.application;
  return `<div class="card pad stack" style="margin-top:12px" id="prospect">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <h2 style="margin:0">${esc(p.company)}</h2>${tag(p.status)}<span class="faint">${esc(p.designator ?? '')} ${esc(p.districtOffice ?? '')}</span>
      <span style="margin-left:auto;display:flex;gap:6px">
        ${p.operatorId ? `<button class="small secondary" data-ob="open-op" data-id="${esc(p.operatorId)}">Open operator</button>` : '<button class="small" data-ob="onboard">Onboard as operator</button>'}
        <button class="small secondary" data-ob="close-prospect">Close</button>
      </span>
    </div>
    ${app ? `<div class="notice ${p.faaVerified ? 'good' : 'warn'}"><strong>Application ${esc(when(app.submittedAt))}</strong>${p.faaVerified ? ' · certificate matches the FAA list' : app.certificateNumber ? ' · certificate not found in the FAA list (or the list isn\'t imported yet)' : ''}<br>
      ${esc(app.name)} · ${esc(app.email)} ${esc(app.phone ?? '')} ${app.website ? `· ${esc(app.website)}` : ''}<br>Fleet: ${esc(app.fleet ?? '—')}${app.message ? `<br>${esc(app.message)}` : ''}</div>` : ''}
    <form class="stack" id="prospect-form">
      <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
        <label>Status<select name="status">${STATUSES.map((s) => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label>Contact name<input name="contactName" value="${esc(p.contact.name ?? '')}"></label>
        <label>Email<input name="contactEmail" type="email" value="${esc(p.contact.email ?? '')}"></label>
        <label>Phone<input name="contactPhone" value="${esc(p.contact.phone ?? '')}"></label>
      </div>
      <label>Notes<textarea name="notes" rows="3" placeholder="Who you spoke to, where they publish empty legs today, follow-up date…">${esc(p.notes ?? '')}</textarea></label>
      <div><button class="small">Save</button></div>
    </form>
    ${p.aircraft.length ? `<details><summary>${p.aircraft.length} aircraft on certificate</summary><div class="scroll-x"><table class="data"><thead><tr><th>Tail</th><th>Model</th><th>Category</th><th>Serial</th></tr></thead><tbody>
      ${p.aircraft.map((a) => `<tr><td>${esc(a.tail)}</td><td>${esc(a.model)}</td><td>${esc(a.category ?? '—')}</td><td>${esc(a.serial ?? '')}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
  </div>`;
}

// ---------- Market ----------

export async function market(key) {
  const m = await api('/api/admin/market', { key });
  const ageDays = m.fuelAsOf ? (Date.now() - new Date(m.fuelAsOf)) / 86_400_000 : null;
  return `<div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));align-items:start">
    <div class="card pad stack">
      <h3 style="margin:0">Jet fuel index</h3>
      <p class="faint" style="margin:0">Only affects legs priced from the rate model (no operator ask). Valid for ${m.fuelValidDays} days; after that those legs stop selling until it's updated.</p>
      <div>${m.fuelCentsPerGal != null ? `<strong class="num">$${(m.fuelCentsPerGal / 100).toFixed(2)}</strong>/gal · set ${esc(when(m.fuelAsOf))}` : 'Not set'}
        ${ageDays != null && ageDays > m.fuelValidDays - 5 ? ` <span class="tag ${ageDays > m.fuelValidDays ? 'bad' : 'warn'}">${ageDays > m.fuelValidDays ? 'expired' : 'expires soon'}</span>` : ''}</div>
      <form id="fuel-form" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap"><label>Jet-A $/gal<input name="fuel" type="number" step="0.01" min="1" max="20" required value="${m.fuelCentsPerGal ? (m.fuelCentsPerGal / 100).toFixed(2) : ''}"></label><button class="small">Update</button></form>
    </div>
    <div class="card pad stack">
      <div style="display:flex;align-items:center;gap:8px"><h3 style="margin:0">Exchange rates</h3><button class="small secondary" data-ob="refresh-fx" style="margin-left:auto">Refresh from ECB</button></div>
      <p class="faint" style="margin:0">European Central Bank daily reference rates, refreshed automatically every 6 hours. Operator prices in a currency older than ${m.fxValidHours} h are held back.</p>
      <table class="data"><thead><tr><th>Currency</th><th>USD per unit</th><th>As of</th></tr></thead><tbody>
        ${Object.entries(m.fx).map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num">${v ? v.usdPer.toFixed(4) : '—'}</td><td class="faint">${v ? esc(when(v.asOf)) : 'never'}</td></tr>`).join('')}
      </tbody></table>
    </div>
  </div>`;
}

// ---------- events ----------

const formData = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

/** Returns true when the click was ours (the caller re-renders). */
export async function onClick(btn, key) {
  const act = btn.dataset.ob;
  if (!act) return false;
  if (act === 'open-op') { state.operatorId = btn.dataset.id; state.aircraftPrefill = null; return 'operators'; }
  if (act === 'close-op') { state.operatorId = null; return true; }
  if (act === 'dismiss-keys') { state.keys = null; return true; }
  if (act === 'clear-prefill') { state.prefill = null; return true; }
  if (act === 'open-prospect') { state.prospectId = btn.dataset.id; return true; }
  if (act === 'close-prospect') { state.prospectId = null; return true; }
  if (act === 'onboard') {
    const p = await api(`/api/admin/prospects/${encodeURIComponent(state.prospectId)}`, { key });
    state.prefill = { prospectId: p.id, name: p.company, certificateNumber: p.designator ?? '', contactName: p.contact.name ?? '', email: p.contact.email ?? '', phone: p.contact.phone ?? '', website: p.application?.website ?? '' };
    return 'operators';
  }
  if (act === 'rotate') {
    const which = btn.dataset.which;
    if (!confirm(`Issue a new ${which} key? The old one stops working immediately.`)) return false;
    const r = await api(`/api/admin/operators/${state.operatorId}/keys`, { method: 'POST', key, body: { which } });
    const op = await api(`/api/admin/operators/${state.operatorId}`, { key });
    state.keys = { operatorName: op.name, feedSourceId: `api:${op.id}`, [which === 'portal' ? 'portalKey' : 'feedKey']: r.key };
    return true;
  }
  if (act === 'toggle-status') {
    const op = await api(`/api/admin/operators/${state.operatorId}`, { key });
    const status = op.status === 'active' ? 'suspended' : 'active';
    if (status === 'suspended' && !confirm(`Suspend ${op.name}? Their legs leave search and their portal login stops working.`)) return false;
    await api(`/api/admin/operators/${state.operatorId}`, { method: 'PATCH', key, body: { status } });
    toast(status === 'active' ? 'Reactivated.' : 'Suspended.');
    return true;
  }
  if (act === 'remove-ac') {
    if (!confirm(`Remove ${btn.dataset.tail} from this fleet?`)) return false;
    await api(`/api/admin/operators/${state.operatorId}/aircraft/${encodeURIComponent(btn.dataset.tail)}`, { method: 'DELETE', key });
    return true;
  }
  if (act === 'prefill-ac') {
    const t = (types ?? []).find((x) => x.code === btn.dataset.type);
    state.aircraftPrefill = t ? { tail: btn.dataset.tail, typeCode: t.code, seats: t.seats }
      : { tail: btn.dataset.tail, newType: { name: btn.dataset.model, category: btn.dataset.cat || 'light' } };
    return true;
  }
  if (act === 'refresh-fx') {
    const r = await api('/api/admin/market/refresh-fx', { method: 'POST', key });
    toast(r.ok ? `Rates updated: ${r.updated.join(', ')}` : `ECB refresh failed: ${r.error}`);
    return true;
  }
  return false;
}

export async function onSubmit(form, key) {
  const d = formData(form);
  switch (form.id) {
    case 'op-create': {
      const r = await api('/api/admin/operators', { method: 'POST', key, body: { ...d, prospectId: state.prefill?.prospectId } });
      state.keys = { operatorName: r.operator.name, ...r.keys };
      state.operatorId = r.operator.id;
      state.prefill = null;
      types = null;
      return true;
    }
    case 'op-edit':
      await api(`/api/admin/operators/${state.operatorId}`, { method: 'PATCH', key, body: d });
      toast('Saved.');
      return true;
    case 'ac-add': {
      const body = { tail: d.tail, seats: Number(d.seats), homeBase: d.homeBase, year: d.year ? Number(d.year) : undefined, override: !!d.override };
      if (d.typeCode === '__new') body.newType = { name: d.newTypeName, category: d.newTypeCategory };
      else body.typeCode = d.typeCode;
      const r = await api(`/api/admin/operators/${state.operatorId}/aircraft`, { method: 'POST', key, body });
      if (!r.added) {
        state.aircraftPrefill = { ...body, newType: body.newType, warning: `Not added: ${r.warnings.join('; ')}. Only aircraft on the operator's certificate may fly charter. Tick the box below if you've verified it.` };
        return true;
      }
      toast(r.warnings.length ? `Added with warning: ${r.warnings.join('; ')}` : `${d.tail.toUpperCase()} added.`);
      state.aircraftPrefill = null;
      if (body.newType) types = null;
      return true;
    }
    case 'prospect-form':
      await api(`/api/admin/prospects/${encodeURIComponent(state.prospectId)}`, { method: 'PATCH', key, body: d });
      toast('Saved.');
      return true;
    case 'pf':
      state.prospectFilter = { q: d.q ?? '', status: d.status ?? '', category: d.category ?? '', minJets: d.minJets ?? '' };
      return true;
    case 'fuel-form':
      await api('/api/admin/market', { method: 'POST', key, body: { fuelCentsPerGal: Math.round(Number(d.fuel) * 100) } });
      toast('Fuel index updated.');
      return true;
    default:
      return false;
  }
}

export async function onChange(el, key) {
  if (el.id === 'faa-file' && el.files?.[0]) {
    const f = el.files[0];
    toast(`Importing ${f.name}…`);
    const r = await api(`/api/admin/faa/import?filename=${encodeURIComponent(f.name)}`, { method: 'POST', key, raw: true, body: f, headers: { 'content-type': 'application/octet-stream' } });
    toast(`Imported ${r.operators.toLocaleString()} operators (${r.jetOperators.toLocaleString()} with jets), ${r.aircraft.toLocaleString()} aircraft`);
    return true;
  }
  if (el.name === 'typeCode' && el.form?.id === 'ac-add') {
    $('#new-type').hidden = el.value !== '__new';
    const seats = el.selectedOptions[0]?.dataset.seats;
    if (seats && !el.form.seats.value) el.form.seats.value = seats;
  }
  return false;
}
