// Server-rendered marketing pages for search engines and AI assistants (SEO / AEO).
//
// Every page answers a real query ("empty leg flights New York to Palm Beach", "how much is a
// private jet from LA to Vegas") with numbers computed from our own model and live inventory,
// plus FAQ and breadcrumb structured data. Pages link to the live app for booking.

import type { App } from '../app.ts';
import type { AircraftType, Airport } from '../domain/types.ts';
import { estimateFlight, distanceNm } from '../domain/geo.ts';
import { getAircraftType } from '../reference/aircraft-types.ts';
import type { SiteConfig } from './config.ts';
import type { PartnerFlight } from '../integrations/skyaccess/service.ts';
import { CITIES, ROUTES, city as findCity, cityAirports, route as findRoute, routesFrom, routesTo, type City, type Route } from './markets.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const usd = (dollars: number) => `$${Math.round(dollars).toLocaleString('en-US')}`;
const round500 = (d: number) => Math.max(500, Math.round(d / 500) * 500);
const hm = (hours: number) => {
  const m = Math.round(hours * 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
const miles = (nm: number) => Math.round(nm * 1.15078);

/** Example aircraft per cabin class for flight-time and price estimates. */
const CLASSES: Array<{ label: string; code: string }> = [
  { label: 'Light jet', code: 'E55P' },
  { label: 'Midsize jet', code: 'C56X' },
  { label: 'Super-midsize jet', code: 'CL35' },
  { label: 'Large-cabin jet', code: 'GLF4' },
];

interface Estimate { label: string; type: AircraftType; blockHours: number; fuelStops: number; charterUsd: number }

function estimates(from: Airport, to: Airport): Estimate[] {
  return CLASSES.map(({ label, code }) => {
    const type = getAircraftType(code);
    const f = estimateFlight(from, to, type);
    return { label, type, blockHours: f.blockHours, fuelStops: f.fuelStops, charterUsd: round500((type.hourlyRateCents / 100) * Math.max(1, f.blockHours)) };
  });
}

// ---------- layout ----------

interface PageOpts {
  title: string;
  description: string;
  path: string;
  body: string;
  jsonLd?: unknown[];
}

export function layout(site: SiteConfig, o: PageOpts): string {
  const canonical = `${site.url}${o.path}`;
  const contact = [
    site.phone ? `<a href="tel:${esc(site.phone.replace(/[^\d+]/g, ''))}">${esc(site.phone)}</a>` : '',
    site.whatsapp ? `<a href="https://wa.me/${esc(site.whatsapp)}" rel="noopener">WhatsApp</a>` : '',
    site.email ? `<a href="mailto:${esc(site.email)}">${esc(site.email)}</a>` : '',
  ].filter(Boolean).join(' · ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.brand)}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
${(o.jsonLd ?? []).map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n')}
</head>
<body class="lux">
<header class="top"><div class="wrap">
  <a class="brand" href="/">${esc(site.brand)}</a>
  <nav class="links"><a class="keep" href="/empty-legs">Empty legs</a>${site.marketplace === 'full' ? '<a href="/charter">Charter</a><a href="/operator/apply">Operators</a>' : ''}${site.phone ? `<a class="call keep" href="tel:${esc(site.phone.replace(/[^\d+]/g, ''))}">${esc(site.phone)}</a>` : ''}</nav>
</div></header>
<main class="wrap seo">
${o.body}
</main>
<footer class="wrap site-footer">
  <div><strong>${esc(site.brand)}</strong> · ${esc(site.tagline)}</div>
  ${contact ? `<div>Concierge: ${contact}</div>` : ''}
  <div class="faint">${esc(disclaimer(site))}</div>
  <nav class="faint"><a href="/empty-legs">All empty-leg routes</a>${site.marketplace === 'full' ? ' · <a href="/operator/apply">List your empty legs</a>' : ''} · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/llms.txt">llms.txt</a></nav>
</footer>
</body>
</html>`;
}

const crumbs = (site: SiteConfig, items: Array<[string, string]>) => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${site.url}${path}` })),
});

const faqLd = (faq: Array<[string, string]>) => ({
  '@context': 'https://schema.org', '@type': 'FAQPage',
  mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
});

const faqHtml = (faq: Array<[string, string]>) => `<section class="faq"><h2>Questions</h2>${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</section>`;

export function organizationLd(site: SiteConfig) {
  return {
    '@context': 'https://schema.org', '@type': 'TravelAgency', name: site.brand, url: site.url, description: site.tagline,
    ...(site.phone ? { telephone: site.phone } : {}), ...(site.email ? { email: site.email } : {}), areaServed: 'United States',
  };
}

// ---------- live inventory ----------

type OwnHit = ReturnType<App['search']['search']>['results'][number];
type Live = { kind: 'own'; legs: OwnHit[] } | { kind: 'partner'; flights: PartnerFlight[] };

const partnerCache = new Map<string, { at: number; flights: PartnerFlight[] }>();
const PARTNER_PAGE_TTL_MS = 15 * 60_000;

/** Live flights for a page: our inventory, or SkyAccess's in referral mode (cached so crawlers can't exhaust its rate limit). */
async function live(app: App, site: SiteConfig, from: City, to: City | null, limit = 6): Promise<Live> {
  if (site.marketplace === 'full') {
    return { kind: 'own', legs: app.search.search({ from: from.airports[0], to: to ? to.airports[0] : null, radiusNm: 40, sort: 'departure', limit }, app.clock.now()).results };
  }
  if (!app.skyaccess) return { kind: 'partner', flights: [] };
  const key = `${from.slug}>${to?.slug ?? ''}`;
  const hit = partnerCache.get(key);
  if (hit && app.clock.now() - hit.at < PARTNER_PAGE_TTL_MS) return { kind: 'partner', flights: hit.flights };
  try {
    const r = await Promise.race([
      app.skyaccess.search({ origin: from.query ?? from.name, destination: to ? to.query ?? to.name : undefined }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000).unref()),
    ]);
    const flights = r.flights.slice(0, limit);
    partnerCache.set(key, { at: app.clock.now(), flights });
    return { kind: 'partner', flights };
  } catch {
    return { kind: 'partner', flights: hit?.flights ?? [] };
  }
}

function liveHtml(l: Live, empty: string): string {
  if (l.kind === 'own' ? !l.legs.length : !l.flights.length) return `<div class="card empty">${empty}</div>`;
  if (l.kind === 'partner') {
    return `<div class="results">${l.flights.map((f) => `
    <a class="card leg" href="/#sky=${esc(encodeURIComponent(f.flightId))}">
      <div>
        <div class="route"><span>${esc(f.from.code ?? f.from.city ?? '')}<small>${esc(f.from.city ?? f.from.name ?? '')}</small></span><span class="arrow">→</span><span>${esc(f.to.code ?? f.to.city ?? '')}<small>${esc(f.to.city ?? f.to.name ?? '')}</small></span></div>
        <div class="facts">${f.departAt ? `<span>${esc(new Date(f.departAt).toUTCString().slice(0, 22))} UTC</span>` : ''}${f.aircraft ? `<span>${esc(f.aircraft)}${f.seats ? ` · ${f.seats} seats` : ''}</span>` : ''}</div>
      </div>
      <div class="price"><div class="total num">${f.priceUsd == null ? 'On request' : usd(f.priceUsd)}</div><div class="faint">whole aircraft${f.priceUsd == null ? '' : ' · plus taxes &amp; fees'}</div></div>
    </a>`).join('')}</div><p class="faint">Listed by our partner SkyAccess.</p>`;
  }
  return `<div class="results">${l.legs.map((h) => `
    <a class="card leg" href="/#leg=${esc(h.legId)}">
      <div>
        <div class="route"><span>${esc(h.from.iata)}<small>${esc(h.from.city)}</small></span><span class="arrow">→</span><span>${esc(h.to.iata)}<small>${esc(h.to.city)}</small></span></div>
        <div class="facts"><span>${esc(new Date(h.departEarliest).toUTCString().slice(0, 22))} UTC</span><span>${esc(h.aircraft.type)} · ${h.aircraft.seats} seats</span><span>${esc(h.operator.name)}</span></div>
      </div>
      <div class="price"><div class="total num">${usd(h.price.totalCents / 100)}</div><div class="faint">all-in · whole aircraft</div>${h.price.savingsPct ? `<span class="tag good">${h.price.savingsPct}% below charter</span>` : ''}</div>
    </a>`).join('')}</div>`;
}

/** What to offer when nothing is listed: alerts and charter quotes exist only in the full marketplace. */
function emptyCta(site: SiteConfig, what: string): string {
  const concierge = site.phone ? ` or call our concierge on <a href="tel:${esc(site.phone.replace(/[^\d+]/g, ''))}">${esc(site.phone)}</a>` : site.email ? ` or <a href="mailto:${esc(site.email)}">email our concierge</a>` : '';
  return site.marketplace === 'full'
    ? `${what} They appear and sell within hours: <a href="/#alerts">set a route alert</a> or <a href="/charter">request a charter quote</a>${concierge}.`
    : `${what} New empty legs are listed every day, so check back soon${concierge}.`;
}

function bookingAnswer(site: SiteConfig): string {
  if (site.marketplace === 'skyaccess') {
    return `Choose a flight to see its details, then book it on SkyAccess, our partner marketplace, which handles booking, payment and confirmation with the operator. Prefer to talk first? Ask a SkyAccess specialist to contact you from the flight page; no payment is taken and nothing is booked until you decide.`;
  }
  return site.payments === 'invoice'
    ? 'Choose a flight and request it. The certificated operator confirms availability, usually within a few hours. Nothing is payable until they confirm; you then receive an invoice, and your seats are secured once it is paid.'
    : 'Choose a flight and request it. Your card is authorized but not charged; the certificated operator confirms availability, usually within a few hours, and you are charged only once they confirm.';
}

/** Who sells and operates the flights, in plain words, per marketplace mode. */
export function disclaimer(site: SiteConfig): string {
  return site.marketplace === 'skyaccess'
    ? `${site.brand} shows empty-leg flights listed by our partner SkyAccess. Flights are booked and paid for with SkyAccess under its terms, and operated by certificated air carriers that hold operational control. ${site.brand} is not an air carrier or charter operator, and may earn a commission when you book.`
    : `Flights are operated by FAA Part 135 (or equivalent) certificated carriers, which hold operational control. ${site.brand} arranges charter on your behalf as an agent.`;
}

const savings = (site: SiteConfig) => (site.marketplace === 'skyaccess'
  ? 'often far below a comparable one-way charter'
  : 'often 40–70% below a one-way charter');

const EMPTY_LEG_ANSWER = 'An empty leg is a repositioning flight: a private jet flying without passengers to pick up its next charter or return to base. Because the flight operates anyway, the whole aircraft is sold at a steep discount. The trade-off is flexibility: the time can shift and the flight can be cancelled if the operator\u2019s main trip changes, in which case you are refunded in full.';

// ---------- pages ----------

export function hubPage(app: App, site: SiteConfig): string {
  const body = `
  <section class="hero"><p class="eyebrow">Empty-leg flights</p>
    <h1>Private jets flying empty, across the US.</h1>
    <p class="lead">Fly the whole aircraft on a repositioning flight, typically far below a regular one-way charter. Choose your departure city or a popular route.</p></section>
  <section><h2>Departure cities</h2><div class="chipgrid">${CITIES.map((c) => `<a class="chip-link" href="/empty-legs/${c.slug}">${esc(c.name)}</a>`).join('')}</div></section>
  <section><h2>Popular routes</h2><div class="routegrid">${ROUTES.map((r) => `<a href="/empty-legs/${r.slug}">${esc(r.from.name)} → ${esc(r.to.name)}</a>`).join('')}</div></section>
  <section class="card pad"><h2>What is an empty leg?</h2><p>${esc(EMPTY_LEG_ANSWER)}</p></section>`;
  return layout(site, {
    title: `Empty Leg Flights in the US: Routes & Live Deals | ${site.brand}`,
    description: `Live empty-leg private jet flights from ${CITIES.slice(0, 6).map((c) => c.name).join(', ')} and more. Fly the whole aircraft, ${savings(site)}.`,
    path: '/empty-legs', body,
    jsonLd: [organizationLd(site), crumbs(site, [['Home', '/'], ['Empty legs', '/empty-legs']])],
  });
}

export async function cityPage(app: App, site: SiteConfig, c: City): Promise<string> {
  const airports = cityAirports(c);
  const legs = await live(app, site, c, null);
  const out = routesFrom(c);
  const inbound = routesTo(c);
  const faq: Array<[string, string]> = [
    [`Which airports do private jets use in ${c.name}?`, `${airports.map((a) => `${a.name} (${a.iata})`).join(', ')}. ${c.blurb}`],
    [`Where can I fly on an empty leg from ${c.name}?`, out.length ? `Popular empty-leg routes from ${c.name} include ${out.slice(0, 6).map((r) => r.to.name).join(', ')}. Availability changes daily, so check the live flights often.` : `Empty legs from ${c.name} go wherever aircraft need to reposition; check the live list often.`],
    ['What is an empty leg?', EMPTY_LEG_ANSWER],
    ['How do I book?', bookingAnswer(site)],
  ];
  const body = `
  <nav class="crumbs faint"><a href="/">Home</a> › <a href="/empty-legs">Empty legs</a> › ${esc(c.name)}</nav>
  <section class="hero"><p class="eyebrow">Empty legs from ${esc(c.name)}</p>
    <h1>Empty leg flights from ${esc(c.name)}</h1>
    <p class="lead">${esc(c.blurb)}</p>
    <p><a class="btn" href="/?from=${esc(c.airports[0])}">Search all flights from ${esc(c.name)}</a></p></section>
  <section><h2>Departing soon</h2>${liveHtml(legs, emptyCta(site, `No empty legs from ${esc(c.name)} are listed right now.`))}</section>
  ${out.length ? `<section><h2>Popular routes from ${esc(c.name)}</h2><div class="routegrid">${out.map((r) => `<a href="/empty-legs/${r.slug}">${esc(c.name)} → ${esc(r.to.name)}</a>`).join('')}</div></section>` : ''}
  ${inbound.length ? `<section><h2>Popular routes to ${esc(c.name)}</h2><div class="routegrid">${inbound.map((r) => `<a href="/empty-legs/${r.slug}">${esc(r.from.name)} → ${esc(c.name)}</a>`).join('')}</div></section>` : ''}
  <section><h2>Private-jet airports in ${esc(c.name)}</h2><ul class="plain">${airports.map((a) => `<li><strong>${esc(a.iata)}</strong> · ${esc(a.name)}, ${esc(a.city)}</li>`).join('')}</ul></section>
  ${faqHtml(faq)}`;
  return layout(site, {
    title: `Empty Leg Flights from ${c.name} | Private Jet Deals | ${site.brand}`,
    description: `Live empty-leg private jet flights from ${c.name} (${c.airports.slice(0, 3).join(', ')}). Fly the whole aircraft, ${savings(site)}.`,
    path: `/empty-legs/${c.slug}`, body,
    jsonLd: [crumbs(site, [['Home', '/'], ['Empty legs', '/empty-legs'], [c.name, `/empty-legs/${c.slug}`]]), faqLd(faq)],
  });
}

export async function routePage(app: App, site: SiteConfig, r: Route): Promise<string> {
  const [from] = cityAirports(r.from);
  const [to] = cityAirports(r.to);
  const nm = Math.round(distanceNm(from, to));
  const est = estimates(from, to);
  const mid = est[1];
  const legs = await live(app, site, r.from, r.to);
  const reverse = findRoute(`${r.to.slug}-to-${r.from.slug}`);
  const nearby = routesFrom(r.from).filter((x) => x.slug !== r.slug).slice(0, 8);
  const faq: Array<[string, string]> = [
    [`How long is a private jet flight from ${r.from.name} to ${r.to.name}?`,
      `About ${hm(mid.blockHours)} in a midsize jet such as the ${mid.type.name}, for roughly ${miles(nm).toLocaleString()} miles (${nm.toLocaleString()} nautical miles)${mid.fuelStops ? `, including ${mid.fuelStops} fuel stop${mid.fuelStops > 1 ? 's' : ''}` : ''}. A light jet takes about ${hm(est[0].blockHours)}${est[0].fuelStops ? ` with ${est[0].fuelStops} fuel stop${est[0].fuelStops > 1 ? 's' : ''}` : ''}; a large-cabin jet about ${hm(est[3].blockHours)}.`],
    [`How much does a private jet from ${r.from.name} to ${r.to.name} cost?`,
      `A regular one-way charter is roughly ${usd(est[0].charterUsd)} in a light jet to ${usd(est[3].charterUsd)} in a large-cabin jet, before taxes and fees (estimates from typical hourly rates; actual quotes vary with season and aircraft). Empty legs on this route are ${site.marketplace === 'skyaccess' ? 'often far less' : 'often 40–70% less'}, because the aircraft is flying it anyway.`],
    [`Which airports are used between ${r.from.name} and ${r.to.name}?`,
      `In ${r.from.name}: ${cityAirports(r.from).map((a) => `${a.name} (${a.iata})`).join(', ')}. In ${r.to.name}: ${cityAirports(r.to).map((a) => `${a.name} (${a.iata})`).join(', ')}.`],
    ['What is an empty leg?', EMPTY_LEG_ANSWER],
    ['How do I book?', bookingAnswer(site)],
  ];
  const body = `
  <nav class="crumbs faint"><a href="/">Home</a> › <a href="/empty-legs">Empty legs</a> › <a href="/empty-legs/${r.from.slug}">${esc(r.from.name)}</a> › ${esc(r.to.name)}</nav>
  <section class="hero"><p class="eyebrow">${esc(r.from.name)} → ${esc(r.to.name)}</p>
    <h1>Empty leg flights from ${esc(r.from.name)} to ${esc(r.to.name)}</h1>
    <p class="lead">${miles(nm).toLocaleString()} miles · about ${hm(mid.blockHours)} in a midsize jet. Fly the whole aircraft on a repositioning flight, ${savings(site)}.</p>
    <p><a class="btn" href="/?from=${esc(r.from.airports[0])}&to=${esc(r.to.airports[0])}">See live flights</a> ${reverse ? `<a class="btn ghost" href="/empty-legs/${reverse.slug}">${esc(r.to.name)} → ${esc(r.from.name)}</a>` : ''}</p></section>
  <section><h2>Live empty legs on this route</h2>${liveHtml(legs, emptyCta(site, 'No empty legs on this route right now.'))}</section>
  <section><h2>Flight time and charter price by aircraft</h2>
    <div class="card scroll-x"><table class="data"><thead><tr><th>Class</th><th>Example aircraft</th><th>Seats</th><th>Flight time</th><th>One-way charter (est.)</th></tr></thead><tbody>
    ${est.map((e) => `<tr><td>${esc(e.label)}</td><td>${esc(e.type.name)}</td><td>up to ${e.type.seats}</td><td>${hm(e.blockHours)}${e.fuelStops ? ` · ${e.fuelStops} stop${e.fuelStops > 1 ? 's' : ''}` : ''}</td><td class="num">${usd(e.charterUsd)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="faint">Charter estimates are aircraft-only, before US federal excise tax and fees, from typical hourly rates. ${site.marketplace === 'skyaccess' ? 'SkyAccess empty-leg prices are for the whole aircraft; taxes and fees are shown at their checkout.' : `Empty-leg prices on ${esc(site.brand)} are shown all-in.`}</p></section>
  ${nearby.length ? `<section><h2>More routes from ${esc(r.from.name)}</h2><div class="routegrid">${nearby.map((x) => `<a href="/empty-legs/${x.slug}">${esc(r.from.name)} → ${esc(x.to.name)}</a>`).join('')}</div></section>` : ''}
  ${faqHtml(faq)}`;
  return layout(site, {
    title: `${r.from.name} to ${r.to.name} Empty Leg Flights | Private Jet Deals | ${site.brand}`,
    description: `Private jet empty legs from ${r.from.name} to ${r.to.name}: about ${hm(mid.blockHours)} flight, ${miles(nm).toLocaleString()} miles. See live flights, typical charter prices and how to book the whole aircraft.`,
    path: `/empty-legs/${r.slug}`, body,
    jsonLd: [crumbs(site, [['Home', '/'], ['Empty legs', '/empty-legs'], [r.from.name, `/empty-legs/${r.from.slug}`], [`${r.from.name} to ${r.to.name}`, `/empty-legs/${r.slug}`]]), faqLd(faq)],
  });
}

/** Resolves /empty-legs/<slug> to a city or route page; null if unknown. */
export async function marketPage(app: App, site: SiteConfig, slug: string): Promise<string | null> {
  const c = findCity(slug);
  if (c) return cityPage(app, site, c);
  const r = findRoute(slug);
  return r ? routePage(app, site, r) : null;
}

// ---------- legal ----------
// Drafts written to match what the site actually does. Have a lawyer review them before relying on them.

const LEGAL_UPDATED = 'October 9, 2026';

function legalContact(site: SiteConfig): string {
  return site.email ? `<a href="mailto:${esc(site.email)}">${esc(site.email)}</a>` : 'the contact details on our home page';
}

export function privacyPage(site: SiteConfig): string {
  const sky = site.marketplace === 'skyaccess';
  const forms = [
    '<li><strong>“Ask SkyAccess to contact you” requests:</strong> your name, email, phone (optional), number of passengers, travel date, route and any notes you add.</li>',
    ...(sky ? [] : [
      '<li><strong>Flight requests and bookings:</strong> your name, email, passenger names as on travel documents, and your signature on the charter agreement, with the time and IP address it was signed from.</li>',
      '<li><strong>Route alerts and charter quotes:</strong> your email, the route, dates and passenger count you ask about.</li>',
      '<li><strong>Operator applications:</strong> company, certificate, contact and fleet details.</li>',
    ]),
  ];
  const body = `
  <section class="hero"><p class="eyebrow">Legal</p><h1>Privacy policy</h1><p class="faint">Last updated ${LEGAL_UPDATED}</p></section>
  <section class="legal">
    <p>This policy explains what ${esc(site.brand)} (“we”) collects through this website, why, and who we share it with.</p>
    <h2>What we collect</h2>
    <p>Only what you choose to send us through the forms on this site:</p>
    <ul>${forms.join('')}</ul>
    <p>Like most websites, our servers also record technical information with each request, such as your IP address, browser type and the pages requested, which we use to keep the site secure and working. We do not use advertising or analytics cookies, and we don't build profiles about you.</p>
    <h2>How we use it</h2>
    <ul>
      <li>To pass your request to the company that will act on it${sky ? ' (SkyAccess, see below)' : ' (the operator of your flight, or our partner SkyAccess)'}, and to reply to you.</li>
      <li>To keep a record of what was sent on your behalf and when.</li>
      <li>To protect the site against fraud and abuse.</li>
    </ul>
    <h2>Who we share it with</h2>
    <ul>
      <li><strong>SkyAccess</strong>, when you ask SkyAccess to contact you. SkyAccess handles your details under its own privacy policy: <a href="https://skyaccess.com/privacy" rel="noopener">skyaccess.com/privacy</a>.${sky ? '' : ' <strong>Charter operators</strong> receive the details needed to confirm and operate a flight you request.'}</li>
      <li><strong>Service providers</strong> that run the site for us: website hosting, and email delivery for messages we send you. They may only use your information to provide that service.</li>
      <li><strong>Google Fonts</strong>, which serves the fonts on this site; your browser connects to Google to load them.</li>
      <li>Authorities, where the law requires it.</li>
    </ul>
    <p>We do not sell your personal information, and we do not share it for targeted advertising.</p>
    <h2>How long we keep it</h2>
    <p>We keep requests and the record of what was sent for as long as needed to handle them and meet legal and accounting obligations, then delete them. You can ask us to delete your information sooner.</p>
    <h2>Your choices and rights</h2>
    <p>You can ask us what information we hold about you, to correct it, or to delete it, by writing to ${legalContact(site)}. Depending on where you live (for example California, under the CCPA), you may have further rights; we will not treat you differently for using them. Information you sent to SkyAccess must also be requested from SkyAccess.</p>
    <h2>Security</h2>
    <p>The site is served over encrypted connections (HTTPS), and access to stored information is restricted to people who need it. No system is perfectly secure, so please don't send us payment card numbers or passport scans through the site.</p>
    <h2>Children</h2>
    <p>This site is for adults booking travel. We don't knowingly collect information from children under 13.</p>
    <h2>Changes and contact</h2>
    <p>We will update this page if our practices change, and change the date above. Questions: ${legalContact(site)}.</p>
  </section>`;
  return layout(site, { title: `Privacy policy | ${site.brand}`, description: `How ${site.brand} collects, uses and shares information.`, path: '/privacy', body });
}

export function termsPage(site: SiteConfig): string {
  const sky = site.marketplace === 'skyaccess';
  const law = process.env.GOVERNING_LAW?.trim();
  const body = `
  <section class="hero"><p class="eyebrow">Legal</p><h1>Terms of use</h1><p class="faint">Last updated ${LEGAL_UPDATED}</p></section>
  <section class="legal">
    <p>By using this website you agree to these terms. If you don't agree, please don't use the site.</p>
    <h2>What we do</h2>
    ${sky
      ? `<p>${esc(site.brand)} helps you find empty-leg private jet flights. The flights shown are listed by our partner <strong>SkyAccess</strong>. When you choose to book, you book and pay on SkyAccess, under <a href="https://skyaccess.com/terms" rel="noopener">SkyAccess's terms</a>, and your contract for the flight is with SkyAccess and the operator, not with us. ${esc(site.brand)} is not an air carrier, charter operator or seller of air transportation.</p>
         <p>When you ask SkyAccess to contact you, we pass your request to SkyAccess. That creates no booking and no obligation to pay.</p>`
      : `<p>${esc(site.brand)} arranges charter flights on your behalf as an agent. Each booking is governed by the charter agreement you sign when you request it. Flights are operated by the certificated operator shown, which holds operational control. Some flights are listed by our partner SkyAccess and are booked with SkyAccess under its terms.</p>`}
    <h2>How we are paid</h2>
    <p>${sky ? 'We may receive a commission from SkyAccess when you book a flight after visiting our site. This does not change the price you pay.' : 'Our service fee is included in the all-in price shown before you request a flight. We may also receive a commission from SkyAccess for flights booked through our links.'}</p>
    <h2>Information on this site</h2>
    <p>Flight details, prices and availability come from operators and partners and can change or be withdrawn at any time; a flight is only secured once it is confirmed and paid for. Flight times and charter price estimates on our route pages are indicative, based on typical aircraft performance and hourly rates, and are not quotes.</p>
    <h2>About empty legs</h2>
    <p>An empty leg exists because the aircraft must reposition for another trip. Its time can change, and it can be cancelled if that trip changes. Please keep a refundable backup plan for important travel.</p>
    <h2>Using the site</h2>
    <p>Don't misuse the site: no automated scraping that degrades it, no false requests, and no attempts to access areas not meant for you. Content and design on this site belong to ${esc(site.brand)} or its partners.</p>
    <h2>Liability</h2>
    <p>The site is provided “as is”. To the extent the law allows, we are not liable for flights, services or content provided by SkyAccess, operators or other third parties, or for indirect or consequential losses. Nothing in these terms limits rights you have under consumer law that cannot be limited.</p>
    ${law ? `<h2>Governing law</h2><p>These terms are governed by the laws of ${esc(law)}.</p>` : ''}
    <h2>Changes and contact</h2>
    <p>We may update these terms and will change the date above when we do. Questions: ${legalContact(site)}.</p>
  </section>`;
  return layout(site, { title: `Terms of use | ${site.brand}`, description: `The terms for using ${site.brand}.`, path: '/terms', body });
}

// ---------- crawler files ----------

export function sitemapXml(site: SiteConfig, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  const urls = ['/', '/empty-legs', ...(site.marketplace === 'full' ? ['/charter', '/operator/apply'] : []), '/privacy', '/terms', ...CITIES.map((c) => `/empty-legs/${c.slug}`), ...ROUTES.map((r) => `/empty-legs/${r.slug}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(site.url + u)}</loc><lastmod>${day}</lastmod><changefreq>${u.startsWith('/empty-legs') || u === '/' ? 'daily' : 'monthly'}</changefreq></url>`).join('\n')}
</urlset>
`;
}

export function robotsTxt(site: SiteConfig): string {
  const ai = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'Bingbot'];
  const rules = 'Allow: /\nDisallow: /admin\nDisallow: /operator\nAllow: /operator/apply\nDisallow: /api/\n';
  return `# AI assistants and search engines are welcome on public pages.
${ai.map((b) => `User-agent: ${b}\n${rules}`).join('\n')}
User-agent: *
${rules}
Sitemap: ${site.url}/sitemap.xml
`;
}

export function llmsTxt(site: SiteConfig): string {
  return `# ${site.brand}

> ${site.tagline} ${site.marketplace === 'skyaccess'
    ? `${site.brand} helps travelers find empty-leg (repositioning) private jet flights across the US, listed by its partner SkyAccess. Travelers book the whole aircraft on SkyAccess, typically far below a regular one-way charter.`
    : `${site.brand} lists empty-leg (repositioning) private jet flights from FAA Part 135 certificated operators across the US. Travelers book the whole aircraft at one all-in price, typically far below a regular one-way charter.`}

## How it works
- ${EMPTY_LEG_ANSWER}
- ${bookingAnswer(site)}
${site.marketplace === 'full' ? '- No matching flight? Travelers can set a route alert (emailed when a match is listed) or request quotes for a custom charter.\n' : ''}${site.phone || site.email ? `- Concierge: ${[site.phone, site.email].filter(Boolean).join(', ')}` : ''}

## Search
- Live search: ${site.url}/?from=TEB&to=PBI (airport codes; destination optional)
- JSON API: ${site.marketplace === 'skyaccess' ? `${site.url}/api/partners/skyaccess/search?from=TEB&to=PBI&pax=4&date=YYYY-MM-DD&flex=2` : `${site.url}/api/search?from=TEB&to=PBI&pax=4&date=YYYY-MM-DD&flex=2`}

## Departure cities
${CITIES.map((c) => `- [${c.name}](${site.url}/empty-legs/${c.slug}): ${c.airports.join(', ')}`).join('\n')}

## Popular routes
${ROUTES.map((r) => `- [${r.from.name} to ${r.to.name}](${site.url}/empty-legs/${r.slug})`).join('\n')}

${site.marketplace === 'full' ? `## For operators\n- Certificated operators can list empty legs free: ${site.url}/operator/apply\n` : ''}`;
}
