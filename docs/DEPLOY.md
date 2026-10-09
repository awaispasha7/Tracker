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

The site starts in **SkyAccess-only mode** (`MARKETPLACE=skyaccess`, the production default):
travelers see SkyAccess flights and book on SkyAccess; your own booking flow, operator sign-up,
route alerts and custom charter are switched off and their pages redirect home. Set
`MARKETPLACE=full` only once you have operators signed and your lawyer has reviewed the charter
agreement and DOT broker obligations.

Optional, add when ready:

| Variable | What it does |
| --- | --- |
| `SITE_URL` | Your domain, e.g. `https://aurumjets.com`. Until set, the Railway domain is used. Set it as soon as your domain works: it goes into canonical tags and the sitemap. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Real email (step 5). Without them, emails are only written to the logs. |
| `SKYACCESS_REF` | Your SkyAccess affiliate tracking, exactly as SkyAccess gives it, e.g. `ref=abc123`. Added to every SkyAccess link so your bookings are credited (see "Getting paid" below). |
| `GOVERNING_LAW` | e.g. `the State of New York`. Adds a governing-law section to the terms. Ask your lawyer. |
| `SKYACCESS_MODE` | `live` (default) shows SkyAccess flights; `off` hides them. |
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

## 6. Getting paid by SkyAccess

The public MCP server works without an account, but **it can't credit you**: its booking links
carry no partner ID. To earn on bookings:

1. Go to [skyaccess.com/partners](https://skyaccess.com/partners) and choose **Affiliate**
   (SkyAccess keeps booking, payment and liability; you earn a commission on each flight you
   send them).
2. Once approved, ask SkyAccess how referrals are tracked: a URL parameter on booking links, a
   partner ID for API/MCP calls, or both. Also ask how "Ask SkyAccess" enquiries are credited.
   Every enquiry we send already ends with "Sent via <your brand>" in its notes.
3. Put the link parameter in `SKYACCESS_REF` and redeploy. If they give you an API key or partner
   ID for the MCP or API instead, send it over and the client can be updated to pass it.

## 7. Legal pages

`/privacy` and `/terms` are drafts written to match what the site actually does: SkyAccess-only
referral, the data each form sends, and a commission disclosure. **Have a lawyer review them**
before launch, and set `CONTACT_EMAIL` so they show a real contact address.

## 8. First day

1. Open `https://<your-site>/`, search a city such as `TEB` or `VNY`, and open a flight: the
   **Book on SkyAccess** link should carry your `SKYACCESS_REF`.
2. Open `https://<your-site>/admin` with `ADMIN_KEY` to see the enquiries sent to SkyAccess
   (`/api/admin/skyaccess`).
3. Later, in `MARKETPLACE=full`: the **Operators** tab is where operator applications appear.
   Verify each certificate on the FAA's list of Part 135 holders before approving.

## 9. Get found (SEO / AEO)

1. [Google Search Console](https://search.google.com/search-console): add your domain, verify via
   DNS, then **Sitemaps → submit** `sitemap.xml`.
2. [Bing Webmaster Tools](https://www.bing.com/webmasters): import from Google Search Console.
   Bing's index also feeds several AI assistants.
3. Already done in the code: 140+ city and route pages (live SkyAccess flights on each, cached for 15
   minutes so crawlers can't use up SkyAccess's rate limit), structured data, `robots.txt` that
   welcomes AI crawlers, and `/llms.txt` describing the site for AI assistants.

## Updating

Every push to the deployed branch redeploys automatically. Data on the `/data` volume survives
redeploys. Railway keeps previous deployments, so you can roll back from the **Deployments** tab.
