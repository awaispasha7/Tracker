# Going live on Railway

About 15 minutes, no command line needed. Cost: Railway's Hobby plan (about $5/month, which
includes usage credit; check current pricing on railway.com) plus a domain (about $10/year).

## 1. Create the service

1. Sign in at [railway.com](https://railway.com) with GitHub.
2. **New Project → Deploy from GitHub repo →** `awaispasha7/Tracker`.
3. Open the service → **Settings → Source → Branch**: choose the branch to deploy (`main` once this
   work is merged, or `claude/sweet-planck-s7myox` to try it now).

Railway finds `railway.json` and builds the `Dockerfile` automatically. The first deploy **will
crash** until you add `ADMIN_KEY` in step 3. That is deliberate: production never starts with a
guessable admin key.

## 2. Add a volume (your database lives here)

Service → **Settings → Volumes → Add volume**, mount path **`/data`**.

Without a volume, every deploy would wipe your operators, legs and bookings. Keep the service at
**one replica**: the database is a single SQLite file on that volume.

## 3. Set variables

Service → **Variables → Raw editor**, paste and fill in:

```
ADMIN_KEY=<long random secret: run `openssl rand -hex 24`, or use a password manager>
BRAND_NAME=Aurum Jets
BRAND_TAGLINE=Private jets flying empty, at a fraction of charter.
CONTACT_PHONE=+1 212 555 0100
CONTACT_WHATSAPP=12125550100
CONTACT_EMAIL=concierge@yourdomain.com
OPS_EMAIL=you@yourdomain.com
```

Optional, add when ready:

| Variable | What it does |
| --- | --- |
| `SITE_URL` | Your domain, e.g. `https://aurumjets.com`. Until set, the Railway domain is used. Set it as soon as your domain works: it goes into canonical tags and the sitemap. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Real email (step 5). Without them, emails are only written to the logs. |
| `SKYACCESS_MODE` | `live` (default) shows SkyAccess partner flights; `off` hides them. |
| `AVIAPAGES_API_KEY` | Live Aviapages inventory, if you subscribe. |
| `PAYMENTS` | `invoice` (default in production): request to book, pay by invoice. |

`APP_ENV=production` and `DB_PATH=/data/emptylegs.db` are already set by the Dockerfile.

## 4. Get a web address

Service → **Settings → Networking → Generate Domain**. You get a free
`something.up.railway.app` address straight away. The site works there, and you can share it.

### Your own domain

There's no reliable free `.com`. Free-domain services either disappeared (Freenom) or are meant
for hobby projects. For a luxury brand, a real `.com` is worth about $10 a year:

1. Buy it at **Cloudflare Registrar** or **Porkbun** (no markup at renewal).
2. Railway → **Networking → Custom Domain** → enter `yourdomain.com` (and `www.yourdomain.com`).
3. Railway shows a DNS record (CNAME). Add it at your registrar. HTTPS is issued automatically,
   usually within minutes.
4. Set `SITE_URL=https://yourdomain.com` in Variables.

## 5. Email (Resend, free tier)

1. Sign up at [resend.com](https://resend.com) → **Domains → Add** your domain → add the DNS
   records it shows at your registrar.
2. **API Keys → Create** → set `RESEND_API_KEY=re_…` and
   `EMAIL_FROM=Aurum Jets <bookings@yourdomain.com>` in Railway.

Travelers then get booking emails, operators get requests (with a copy to `OPS_EMAIL`), and new
operator applications reach you.

## 6. First day

1. Open `https://<your-site>/admin`, sign in with `ADMIN_KEY`. The **Operators** tab is your
   home: applications appear there.
2. Send operators to `https://<your-site>/operator/apply`. Verify each certificate on the FAA's
   list of Part 135 certificate holders, then **Approve**. They get their portal key by email and
   can post legs straight away.
3. Bookings arrive as requests. When an operator confirms, send the traveler your invoice or
   payment link (the confirmation email tells them one is coming).

## 7. Get found (SEO / AEO)

1. [Google Search Console](https://search.google.com/search-console): add your domain, verify via
   DNS, then **Sitemaps → submit** `sitemap.xml`.
2. [Bing Webmaster Tools](https://www.bing.com/webmasters): import from Google Search Console.
   Bing's index also feeds several AI assistants.
3. Already done in the code: 140+ city and route pages, structured data, `robots.txt` that
   welcomes AI crawlers, and `/llms.txt` describing the site for AI assistants.

## Updating

Every push to the deployed branch redeploys automatically. Data on the `/data` volume survives
redeploys. Railway keeps previous deployments, so you can roll back from the **Deployments** tab.
