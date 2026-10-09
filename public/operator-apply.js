import { api, esc, LOGO } from './common.js';

const $ = (s) => document.querySelector(s);
$('#brand').insertAdjacentHTML('afterbegin', LOGO);
api('/api/config').then((c) => { if (c.site?.brand) $('#brand').lastChild.textContent = c.site.brand; }).catch(() => {});

const CATEGORIES = [['', 'Auto (from model)'], ['turboprop', 'Turboprop'], ['light', 'Light jet'], ['midsize', 'Midsize'], ['super-midsize', 'Super-midsize'], ['heavy', 'Heavy'], ['ultra-long', 'Ultra long range']];
api('/api/aircraft-types').then((types) => {
  $('#types').innerHTML = types.map((t) => `<option value="${esc(t.name)}">`).join('');
}).catch(() => {});

let n = 0;
function addAircraft() {
  const i = n++;
  $('#fleet').insertAdjacentHTML('beforeend', `
    <fieldset class="card pad aircraft" data-i="${i}" style="margin:0">
      <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
        <label>Tail number<input name="tail" required placeholder="N123AB"></label>
        <label>Model<input name="model" required list="types" placeholder="Citation XLS+"></label>
        <label>Category<select name="category">${CATEGORIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label>Seats<input name="seats" type="number" min="1" max="30" required></label>
        <label>Home base<input name="homeBase" required placeholder="TEB"></label>
        <label>Year built<input name="year" type="number" min="1960" max="2030" required></label>
      </div>
      ${i > 0 ? '<button type="button" class="secondary small" data-remove style="margin-top:8px">Remove</button>' : ''}
    </fieldset>`);
}
addAircraft();
$('#add-aircraft').addEventListener('click', addAircraft);
$('#fleet').addEventListener('click', (e) => {
  if (e.target.closest('[data-remove]')) e.target.closest('.aircraft').remove();
});

$('#apply').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (!$('#attest').checked) {
    $('#out').innerHTML = '<div class="notice bad">Please confirm the certificate statement.</div>';
    return;
  }
  const fleet = [...document.querySelectorAll('.aircraft')].map((el) => {
    const v = (k) => el.querySelector(`[name=${k}]`).value.trim();
    return { tail: v('tail'), model: v('model'), category: v('category') || undefined, seats: Number(v('seats')), homeBase: v('homeBase'), year: Number(v('year')) };
  });
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('/api/operator-applications', {
      method: 'POST',
      body: {
        company: f.get('company'), website: f.get('website'), certificate: f.get('certificate'), certificateNumber: f.get('certificateNumber'),
        contactName: f.get('contactName'), email: f.get('email'), phone: f.get('phone'), notes: f.get('notes'), company_url: f.get('company_url'), fleet,
      },
    });
    e.target.innerHTML = `<h2 style="margin:0">Application received</h2>
      <p class="muted">Thank you. We'll verify your certificate and email <strong>${esc(f.get('email'))}</strong>, usually within one business day. Once approved, you'll get your portal access and can start posting legs.</p>`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    btn.disabled = false;
    const list = err.details?.problems;
    $('#out').innerHTML = `<div class="notice bad">${list ? `Please fix:<ul>${list.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : esc(err.message)}</div>`;
  }
});
