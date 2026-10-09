import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, nativeLeg } from './helpers.ts';
import { loadSiteConfig } from '../src/site/config.ts';
import { hubPage, llmsTxt, marketPage, robotsTxt, sitemapXml } from '../src/site/pages.ts';
import { CITIES, ROUTES } from '../src/site/markets.ts';

const site = loadSiteConfig({ APP_ENV: 'production', SITE_URL: 'https://aurum.example/', BRAND_NAME: 'Aurum Jets', CONTACT_PHONE: '+1 212 555 0100' });

const jsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));

test('every city and route page renders with title, canonical, FAQ and breadcrumb structured data', () => {
  const { app } = testApp();
  for (const slug of [...CITIES.map((c) => c.slug), ...ROUTES.map((r) => r.slug)]) {
    const html = marketPage(app, site, slug);
    assert.ok(html, slug);
    assert.match(html!, new RegExp(`<link rel="canonical" href="https://aurum.example/empty-legs/${slug}">`));
    const ld = jsonLd(html!);
    assert.ok(ld.some((x) => x['@type'] === 'FAQPage'), `${slug} FAQ`);
    assert.ok(ld.some((x) => x['@type'] === 'BreadcrumbList'), `${slug} breadcrumbs`);
    assert.doesNotMatch(html!, /NaN|undefined/, slug);
  }
  assert.equal(marketPage(app, site, 'atlantis'), null);
});

test('route page: real distance, flight times and charter estimates; live legs listed', async () => {
  const { app } = testApp();
  await app.ingest.ingest('api:op_a', [nativeLeg()]);
  const html = marketPage(app, site, 'new-york-to-palm-beach')!;
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
  assert.equal((sm.match(/<loc>/g) ?? []).length, 4 + CITIES.length + ROUTES.length);
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
