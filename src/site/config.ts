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
  };
}
