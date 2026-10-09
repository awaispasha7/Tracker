import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, nativeLeg, T0 } from './helpers.ts';
import { loadSiteConfig } from '../src/site/config.ts';
import { hubPage, llmsTxt, marketPage, privacyPage, robotsTxt, sitemapXml, termsPage } from '../src/site/pages.ts';
import { SkyAccessMock } from '../src/integrations/skyaccess/mock.ts';
import { CITIES, ROUTES } from '../src/site/markets.ts';

const site = loadSiteConfig({ APP_ENV: 'production', MARKETPLACE: 'full', SITE_URL: 'https://aurum.example/', BRAND_NAME: 'Aurum Jets', CONTACT_PHONE: '+1 212 555 0100' });
const skySite = loadSiteConfig({ APP_ENV: 'production', SITE_URL: 'https://aurum.example/', BRAND_NAME: 'Aurum Jets', CONTACT_EMAIL: 'hi@aurum.example' });

const jsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));

test('every city and route page renders with title, canonical, FAQ and breadcrumb structured data', async () => {
  const { app } = testApp();
  for (const slug of [...CITIES.map((c) => c.slug), ...ROUTES.map((r) => r.slug)]) {
    const html = await marketPage(app, site, slug);
    assert.ok(html, slug);
    assert.match(html!, new RegExp(`<link rel="canonical" href="https://aurum.example/empty-legs/${slug}">`));
    const ld = jsonLd(html!);
    assert.ok(ld.some((x) => x['@type'] === 'FAQPage'), `${slug} FAQ`);
    assert.ok(ld.some((x) => x['@type'] === 'BreadcrumbList'), `${slug} breadcrumbs`);
    assert.doesNotMatch(html!, /NaN|undefined/, slug);
  }
  assert.equal(await marketPage(app, site, 'atlantis'), null);
});

test('route page: real distance, flight times and charter estimates; live legs listed', async () => {
  const { app } = testApp();
  await app.ingest.ingest('api:op_a', [nativeLeg()]);
  const html = (await marketPage(app, site, 'new-york-to-palm-beach'))!;
  assert.match(html, /<h1>Empty leg flights from New York to Palm Beach<\/h1>/);
  assert.match(html, /1,0\d\d miles/, 'TEB-PBI is about 1,040 statute miles');
  assert.match(html, /Citation XLS\+/);
  assert.match(html, /href="\/#leg=leg_/, 'the live TEB->PBI leg is linked');
  assert.match(html, /href="\/empty-legs\/palm-beach-to-new-york"/, 'reverse route linked');
  assert.match(html, /Nothing is payable until they confirm/, 'invoice wording in production');
  const faq = jsonLd(html).find((x) => x['@type'] === 'FAQPage');
  assert.match(faq.mainEntity[0].name, /How long is a private jet flight from New York to Palm Beach/);
});

test('hub, sitemap, robots and llms.txt', () => {
  const { app } = testApp();
  assert.match(hubPage(app, site), /Aurum Jets/);
  const sm = sitemapXml(site, Date.now());
  assert.equal((sm.match(/<loc>/g) ?? []).length, 6 + CITIES.length + ROUTES.length);
  assert.doesNotMatch(sitemapXml(skySite, Date.now()), /operator\/apply|\/charter/, 'SkyAccess-only sitemap has no own-marketplace pages');
  assert.match(sm, /<loc>https:\/\/aurum.example\/empty-legs\/los-angeles-to-las-vegas<\/loc>/);
  const robots = robotsTxt(site);
  assert.match(robots, /User-agent: GPTBot\nAllow: \//);
  assert.match(robots, /User-agent: ClaudeBot/);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Sitemap: https:\/\/aurum.example\/sitemap.xml/);
  const llms = llmsTxt(site);
  assert.match(llms, /^# Aurum Jets/);
  assert.match(llms, /\[New York to Palm Beach\]\(https:\/\/aurum.example\/empty-legs\/new-york-to-palm-beach\)/);
});

test('SkyAccess-only mode: route pages list SkyAccess flights with accurate wording', async () => {
  const mock = new SkyAccessMock({ now: () => T0 });
  const { app } = testApp({ skyaccess: { mode: 'mock', mock, referral: { params: 'ref=aurum42', source: 'Aurum Jets' } } });
  await app.ingest.ingest('api:op_a', [nativeLeg()]);
  const html = (await marketPage(app, skySite, 'los-angeles-to-las-vegas'))!;
  assert.doesNotMatch(html, /href="\/#leg=/, 'own inventory is not shown');
  assert.match(html, /href="\/#sky=sa_1001"/);
  assert.match(html, /book it on SkyAccess/);
  assert.match(html, /not an air carrier or charter operator, and may earn a commission/);
  assert.doesNotMatch(html, /40–70%|all-in|charter quote|route alert/);
  assert.doesNotMatch(html, /href="\/charter"|operator\/apply/);
  // Second render is served from the page cache: no extra SkyAccess call.
  const calls = mock.calls.length;
  await marketPage(app, skySite, 'los-angeles-to-las-vegas');
  assert.equal(mock.calls.length, calls);
});

test('affiliate tracking is added to SkyAccess links and enquiries say where they came from', async () => {
  const mock = new SkyAccessMock({ now: () => T0 });
  const { app } = testApp({ skyaccess: { mode: 'mock', mock, referral: { params: 'ref=aurum42', source: 'Aurum Jets' } } });
  const { flights } = await app.skyaccess!.search({ origin: 'TEB', destination: 'PBI' });
  assert.ok(flights.every((f) => f.bookingUrl?.endsWith('?ref=aurum42')));
  assert.equal(app.skyaccess!.tagUrl('https://evil.example/x'), 'https://evil.example/x', 'only skyaccess.com links are tagged');
  await app.skyaccess!.requestBooking({ name: 'Ada Lovelace', email: 'ada@example.com', origin: 'TEB', destination: 'PBI', departureDate: '2026-10-12', passengers: 2 });
  assert.match(String(mock.bookingRequests[0].arguments.notes), /Sent via Aurum Jets/);
});

test('legal pages describe the referral model in SkyAccess-only mode', () => {
  const p = privacyPage(skySite);
  assert.match(p, /skyaccess.com\/privacy/);
  assert.match(p, /hi@aurum.example/);
  assert.doesNotMatch(p, /Operator applications|charter agreement/);
  const t = termsPage(skySite);
  assert.match(t, /not an air carrier, charter operator or seller of air transportation/);
  assert.match(t, /commission from SkyAccess/);
  assert.match(termsPage(site), /charter agreement you sign/);
});
