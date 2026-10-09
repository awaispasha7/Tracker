// Brand and contact details, from the environment so the same code runs any brand/domain.

export interface SiteConfig {
  production: boolean;
  brand: string;
  /** Canonical origin without trailing slash, e.g. https://aurumjets.com */
  url: string;
  tagline: string;
  phone: string | null;
  /** Digits only with country code, e.g. 12125550100, for wa.me links. */
  whatsapp: string | null;
  email: string | null;
  /** 'card' (test cards in dev) or 'invoice' (request to book, pay by invoice). */
  payments: 'card' | 'invoice';
  /**
   * 'skyaccess': referral site. Travelers see SkyAccess flights and book on SkyAccess; our own
   * booking flow, operator sign-up, alerts and custom charter are off. 'full': everything.
   */
  marketplace: 'skyaccess' | 'full';
  /** Affiliate tracking from SkyAccess, appended to every SkyAccess link, e.g. "ref=abc123". */
  skyaccessRef: string | null;
}

export function loadSiteConfig(env: NodeJS.ProcessEnv = process.env): SiteConfig {
  const production = env.APP_ENV === 'production' || env.NODE_ENV === 'production';
  const port = env.PORT ?? '3000';
  const railway = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null;
  return {
    production,
    brand: env.BRAND_NAME?.trim() || 'Empty Leg Tracker',
    url: (env.SITE_URL?.trim() || railway || `http://localhost:${port}`).replace(/\/+$/, ''),
    tagline: env.BRAND_TAGLINE?.trim() || 'Private jets flying empty, at a fraction of charter.',
    phone: env.CONTACT_PHONE?.trim() || null,
    whatsapp: env.CONTACT_WHATSAPP?.replace(/\D/g, '') || null,
    email: env.CONTACT_EMAIL?.trim() || null,
    payments: (env.PAYMENTS as SiteConfig['payments']) ?? (production ? 'invoice' : 'card'),
    marketplace: (env.MARKETPLACE as SiteConfig['marketplace']) ?? (production ? 'skyaccess' : 'full'),
    skyaccessRef: env.SKYACCESS_REF?.trim().replace(/^[?&]/, '') || null,
  };
}
