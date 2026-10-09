// Launch markets: the US cities and city pairs with the most private-jet traffic. Each city gets
// a landing page (/empty-legs/new-york) and each pair gets a route page in both directions
// (/empty-legs/new-york-to-palm-beach). This is what people (and AI assistants) search for.

import { findAirport } from '../reference/airports.ts';
import type { Airport } from '../domain/types.ts';

export interface City {
  slug: string;
  name: string;
  /** "NY", "FL"… or a country for the few international favourites. */
  region: string;
  /** First airport is the search anchor; the rest are covered by the search radius or listed for context. */
  airports: string[];
  /** One sentence, specific to private aviation in this market. */
  blurb: string;
  /** What to send SkyAccess as origin/destination when the display name isn't a city it knows. */
  query?: string;
}

export const CITIES: City[] = [
  { slug: 'new-york', name: 'New York', region: 'NY', airports: ['TEB', 'HPN', 'MMU', 'FRG', 'LGA', 'JFK', 'EWR'], blurb: 'Teterboro, 12 miles from Midtown, is the busiest private-jet airport in the country; Westchester (HPN), Morristown (MMU) and Republic (FRG) cover the suburbs.' },
  { slug: 'los-angeles', name: 'Los Angeles', region: 'CA', airports: ['VNY', 'SMO', 'BUR', 'LAX'], blurb: 'Van Nuys is one of the busiest general-aviation airports in the world and the main private-jet base for LA, with Burbank and Santa Monica close by.' },
  { slug: 'san-francisco', name: 'San Francisco', region: 'CA', airports: ['SFO', 'OAK', 'SJC'], blurb: 'Private flights use the business-aviation terminals at SFO, Oakland and San José; Napa and Sonoma are a short hop north.' },
  { slug: 'miami', name: 'Miami', region: 'FL', airports: ['OPF', 'TMB', 'MIA', 'FLL'], blurb: 'Opa-locka Executive and Miami Executive are the private-jet airports for Miami, with Fort Lauderdale a few minutes north.' },
  { slug: 'palm-beach', name: 'Palm Beach', region: 'FL', airports: ['PBI', 'BCT'], blurb: 'Palm Beach International is one of the busiest winter private-jet destinations in the US, with Boca Raton nearby.' },
  { slug: 'las-vegas', name: 'Las Vegas', region: 'NV', airports: ['LAS', 'HND'], blurb: 'Private jets use the FBOs at Harry Reid International and Henderson Executive, a few minutes from the Strip.' },
  { slug: 'aspen', name: 'Aspen', region: 'CO', airports: ['ASE'], blurb: 'Aspen/Pitkin County sits at 7,800 ft between mountains; aircraft and crews need mountain experience, and winter weekends book out early.' },
  { slug: 'the-hamptons', query: 'HTO', name: 'The Hamptons', region: 'NY', airports: ['HTO', 'FOK'], blurb: 'East Hampton and Gabreski (Westhampton Beach) turn a three-hour summer drive from Manhattan into a 35-minute flight.' },
  { slug: 'boston', name: 'Boston', region: 'MA', airports: ['BED', 'BOS'], blurb: 'Hanscom Field in Bedford is Boston’s main private-jet airport, with Logan for larger aircraft.' },
  { slug: 'washington-dc', query: 'Washington', name: 'Washington, D.C.', region: 'DC', airports: ['IAD', 'DCA'], blurb: 'Dulles handles most private traffic for the capital; Reagan National allows private flights under extra security rules.' },
  { slug: 'chicago', name: 'Chicago', region: 'IL', airports: ['PWK', 'MDW', 'ORD'], blurb: 'Chicago Executive and Midway are the private-jet airports closest to downtown and the North Shore.' },
  { slug: 'dallas', name: 'Dallas', region: 'TX', airports: ['DAL', 'ADS', 'DFW'], blurb: 'Dallas Love Field and Addison are minutes from Uptown and Preston Hollow, with DFW for larger aircraft.' },
  { slug: 'houston', name: 'Houston', region: 'TX', airports: ['HOU', 'IAH'], blurb: 'Hobby is the closest private-jet airport to downtown Houston and the Galleria; Bush Intercontinental serves the north.' },
  { slug: 'austin', name: 'Austin', region: 'TX', airports: ['AUS'], blurb: 'Austin-Bergstrom has busy private terminals, especially around festivals and race weekends.' },
  { slug: 'atlanta', name: 'Atlanta', region: 'GA', airports: ['PDK', 'ATL'], blurb: 'DeKalb-Peachtree (PDK) is Atlanta’s main business-aviation airport, close to Buckhead.' },
  { slug: 'nashville', name: 'Nashville', region: 'TN', airports: ['BNA'], blurb: 'Nashville International’s private terminals are 15 minutes from downtown.' },
  { slug: 'denver', name: 'Denver', region: 'CO', airports: ['APA', 'DEN'], blurb: 'Centennial (APA) is Denver’s private-jet hub and a gateway to the Colorado ski resorts.' },
  { slug: 'scottsdale', name: 'Scottsdale', region: 'AZ', airports: ['SDL', 'PHX'], blurb: 'Scottsdale Airport is one of the busiest private-jet airports in the Southwest, busiest in winter and spring.' },
  { slug: 'seattle', name: 'Seattle', region: 'WA', airports: ['BFI', 'SEA'], blurb: 'Boeing Field (BFI) is the private-jet airport closest to downtown Seattle.' },
  { slug: 'san-diego', name: 'San Diego', region: 'CA', airports: ['SAN', 'MYF', 'CRQ'], blurb: 'Private flights use San Diego International, Montgomery-Gibbs and McClellan-Palomar in Carlsbad.' },
  { slug: 'orlando', name: 'Orlando', region: 'FL', airports: ['ORL', 'MCO'], blurb: 'Orlando Executive is the closest private-jet airport to downtown; Orlando International serves the theme-park corridor.' },
  { slug: 'naples', name: 'Naples', region: 'FL', airports: ['APF'], blurb: 'Naples Municipal is a busy winter private-jet destination on Florida’s Gulf Coast.' },
  { slug: 'nantucket', name: 'Nantucket', region: 'MA', airports: ['ACK'], blurb: 'Nantucket Memorial is one of the busiest summer private-jet airports in New England.' },
  { slug: 'marthas-vineyard', query: 'MVY', name: 'Martha’s Vineyard', region: 'MA', airports: ['MVY'], blurb: 'Martha’s Vineyard sees heavy private traffic from New York and Washington all summer.' },
  { slug: 'vail', name: 'Vail', region: 'CO', airports: ['EGE'], blurb: 'Eagle County Regional is 30 minutes from Vail and Beaver Creek.' },
  { slug: 'jackson-hole', name: 'Jackson Hole', region: 'WY', airports: ['JAC'], blurb: 'Jackson Hole Airport, inside Grand Teton National Park, serves the ski resort and summer ranches.' },
  { slug: 'napa-valley', query: 'APC', name: 'Napa Valley', region: 'CA', airports: ['APC', 'STS'], blurb: 'Napa County and Sonoma County airports put wine country minutes from landing.' },
  { slug: 'lake-tahoe', query: 'TRK', name: 'Lake Tahoe', region: 'CA', airports: ['TRK', 'RNO'], blurb: 'Truckee-Tahoe is the private-jet airport for North Lake Tahoe; Reno-Tahoe takes larger aircraft.' },
  { slug: 'palm-springs', name: 'Palm Springs', region: 'CA', airports: ['PSP', 'TRM'], blurb: 'Palm Springs International and Thermal (TRM) serve the Coachella Valley, busiest around festival season.' },
  { slug: 'los-cabos', name: 'Los Cabos', region: 'Mexico', airports: ['SJD'], blurb: 'Los Cabos is the most popular international private-jet destination from the West Coast.' },
  { slug: 'nassau', name: 'Nassau', region: 'Bahamas', airports: ['NAS'], blurb: 'Nassau is under an hour from South Florida by private jet.' },
];

/** Popular city pairs; each gets a page in both directions. */
const PAIRS: Array<[string, string]> = [
  ['new-york', 'palm-beach'], ['new-york', 'miami'], ['new-york', 'los-angeles'], ['new-york', 'the-hamptons'], ['new-york', 'aspen'],
  ['new-york', 'boston'], ['new-york', 'nantucket'], ['new-york', 'marthas-vineyard'], ['new-york', 'chicago'], ['new-york', 'washington-dc'],
  ['new-york', 'atlanta'], ['new-york', 'nassau'], ['new-york', 'naples'], ['new-york', 'las-vegas'], ['new-york', 'san-francisco'],
  ['new-york', 'dallas'], ['new-york', 'nashville'],
  ['los-angeles', 'las-vegas'], ['los-angeles', 'san-francisco'], ['los-angeles', 'los-cabos'], ['los-angeles', 'aspen'], ['los-angeles', 'scottsdale'],
  ['los-angeles', 'palm-springs'], ['los-angeles', 'seattle'], ['los-angeles', 'napa-valley'], ['los-angeles', 'jackson-hole'], ['los-angeles', 'miami'],
  ['los-angeles', 'dallas'], ['los-angeles', 'lake-tahoe'], ['los-angeles', 'vail'],
  ['san-francisco', 'las-vegas'], ['san-francisco', 'lake-tahoe'], ['san-francisco', 'los-cabos'], ['san-francisco', 'seattle'], ['san-francisco', 'aspen'],
  ['san-francisco', 'scottsdale'], ['san-francisco', 'san-diego'],
  ['miami', 'nassau'], ['miami', 'atlanta'], ['miami', 'chicago'], ['palm-beach', 'nassau'], ['palm-beach', 'boston'], ['palm-beach', 'chicago'],
  ['dallas', 'aspen'], ['dallas', 'las-vegas'], ['dallas', 'los-cabos'], ['dallas', 'vail'], ['houston', 'aspen'], ['houston', 'dallas'], ['austin', 'los-angeles'],
  ['chicago', 'aspen'], ['chicago', 'naples'], ['denver', 'aspen'], ['boston', 'nantucket'], ['atlanta', 'palm-beach'], ['scottsdale', 'las-vegas'],
];

const bySlug = new Map(CITIES.map((c) => [c.slug, c]));

export function city(slug: string): City | undefined {
  return bySlug.get(slug);
}

export function cityAirports(c: City): Airport[] {
  return c.airports.map((a) => findAirport(a)).filter((a): a is Airport => !!a);
}

export interface Route {
  from: City;
  to: City;
  slug: string;
}

export const ROUTES: Route[] = PAIRS.flatMap(([a, b]) => [[a, b], [b, a]]).map(([a, b]) => ({
  from: bySlug.get(a)!, to: bySlug.get(b)!, slug: `${a}-to-${b}`,
}));

const routeBySlug = new Map(ROUTES.map((r) => [r.slug, r]));

export function route(slug: string): Route | undefined {
  return routeBySlug.get(slug);
}

export function routesFrom(c: City): Route[] {
  return ROUTES.filter((r) => r.from.slug === c.slug);
}

export function routesTo(c: City): Route[] {
  return ROUTES.filter((r) => r.to.slug === c.slug);
}
