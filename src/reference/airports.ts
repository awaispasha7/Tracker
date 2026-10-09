import type { Airport } from '../domain/types.ts';

// [icao, iata, name, city, country, lat, lon, feeTier]
type Row = [string, string, string, string, string, number, number, 'standard' | 'premium'];

const ROWS: Row[] = [
  ['KTEB', 'TEB', 'Teterboro', 'New York', 'US', 40.8501, -74.0608, 'premium'],
  ['KHPN', 'HPN', 'Westchester County', 'White Plains', 'US', 41.067, -73.7076, 'premium'],
  ['KJFK', 'JFK', 'John F. Kennedy Intl', 'New York', 'US', 40.6413, -73.7781, 'premium'],
  ['KBOS', 'BOS', 'Boston Logan Intl', 'Boston', 'US', 42.3656, -71.0096, 'standard'],
  ['KBED', 'BED', 'Hanscom Field', 'Bedford', 'US', 42.47, -71.289, 'standard'],
  ['KACK', 'ACK', 'Nantucket Memorial', 'Nantucket', 'US', 41.2531, -70.0602, 'premium'],
  ['KMVY', 'MVY', "Martha's Vineyard", "Martha's Vineyard", 'US', 41.3931, -70.6143, 'premium'],
  ['KIAD', 'IAD', 'Washington Dulles Intl', 'Washington', 'US', 38.9531, -77.4565, 'standard'],
  ['KPBI', 'PBI', 'Palm Beach Intl', 'West Palm Beach', 'US', 26.6832, -80.0956, 'premium'],
  ['KFLL', 'FLL', 'Fort Lauderdale-Hollywood Intl', 'Fort Lauderdale', 'US', 26.0742, -80.1506, 'standard'],
  ['KOPF', 'OPF', 'Miami-Opa Locka Executive', 'Miami', 'US', 25.907, -80.2784, 'standard'],
  ['KMIA', 'MIA', 'Miami Intl', 'Miami', 'US', 25.7959, -80.287, 'standard'],
  ['KAPF', 'APF', 'Naples Municipal', 'Naples', 'US', 26.1526, -81.7753, 'standard'],
  ['KPDK', 'PDK', 'DeKalb-Peachtree', 'Atlanta', 'US', 33.8756, -84.302, 'standard'],
  ['KBNA', 'BNA', 'Nashville Intl', 'Nashville', 'US', 36.1263, -86.6774, 'standard'],
  ['KMSY', 'MSY', 'Louis Armstrong New Orleans Intl', 'New Orleans', 'US', 29.9934, -90.258, 'standard'],
  ['KMDW', 'MDW', 'Chicago Midway', 'Chicago', 'US', 41.7868, -87.7522, 'standard'],
  ['KPWK', 'PWK', 'Chicago Executive', 'Chicago', 'US', 42.1142, -87.9015, 'standard'],
  ['KDAL', 'DAL', 'Dallas Love Field', 'Dallas', 'US', 32.8471, -96.8518, 'standard'],
  ['KHOU', 'HOU', 'William P. Hobby', 'Houston', 'US', 29.6454, -95.2789, 'standard'],
  ['KAUS', 'AUS', 'Austin-Bergstrom Intl', 'Austin', 'US', 30.1975, -97.6664, 'standard'],
  ['KAPA', 'APA', 'Centennial', 'Denver', 'US', 39.5701, -104.8493, 'standard'],
  ['KASE', 'ASE', 'Aspen/Pitkin County', 'Aspen', 'US', 39.2232, -106.8688, 'premium'],
  ['KEGE', 'EGE', 'Eagle County Regional', 'Vail', 'US', 39.6426, -106.9177, 'premium'],
  ['KSUN', 'SUN', 'Friedman Memorial', 'Sun Valley', 'US', 43.5044, -114.2962, 'premium'],
  ['KJAC', 'JAC', 'Jackson Hole', 'Jackson', 'US', 43.6073, -110.7377, 'premium'],
  ['KBZN', 'BZN', 'Bozeman Yellowstone Intl', 'Bozeman', 'US', 45.7775, -111.153, 'standard'],
  ['KSDL', 'SDL', 'Scottsdale', 'Scottsdale', 'US', 33.6229, -111.9105, 'standard'],
  ['KLAS', 'LAS', 'Harry Reid Intl', 'Las Vegas', 'US', 36.084, -115.1537, 'standard'],
  ['KVNY', 'VNY', 'Van Nuys', 'Los Angeles', 'US', 34.2098, -118.49, 'premium'],
  ['KLAX', 'LAX', 'Los Angeles Intl', 'Los Angeles', 'US', 33.9416, -118.4085, 'premium'],
  ['KBUR', 'BUR', 'Hollywood Burbank', 'Burbank', 'US', 34.2007, -118.3585, 'standard'],
  ['KSNA', 'SNA', 'John Wayne', 'Orange County', 'US', 33.6757, -117.8682, 'standard'],
  ['KCRQ', 'CRQ', 'McClellan-Palomar', 'Carlsbad', 'US', 33.1283, -117.2803, 'standard'],
  ['KPSP', 'PSP', 'Palm Springs Intl', 'Palm Springs', 'US', 33.8297, -116.507, 'standard'],
  ['KSFO', 'SFO', 'San Francisco Intl', 'San Francisco', 'US', 37.6213, -122.379, 'standard'],
  ['KOAK', 'OAK', 'Oakland Intl', 'Oakland', 'US', 37.7126, -122.2197, 'standard'],
  ['KSJC', 'SJC', 'San Jose Intl', 'San Jose', 'US', 37.3639, -121.9289, 'standard'],
  ['KTRK', 'TRK', 'Truckee-Tahoe', 'Truckee', 'US', 39.32, -120.1396, 'standard'],
  ['KBFI', 'BFI', 'Boeing Field', 'Seattle', 'US', 47.53, -122.302, 'standard'],
  ['TJSJ', 'SJU', 'Luis Munoz Marin Intl', 'San Juan', 'PR', 18.4394, -66.0018, 'standard'],
  ['TNCM', 'SXM', 'Princess Juliana Intl', 'St. Maarten', 'SX', 18.041, -63.1089, 'premium'],
  ['MYNN', 'NAS', 'Lynden Pindling Intl', 'Nassau', 'BS', 25.039, -77.4662, 'standard'],
  ['MMSD', 'SJD', 'Los Cabos Intl', 'Los Cabos', 'MX', 23.1518, -109.721, 'premium'],
  ['MMUN', 'CUN', 'Cancun Intl', 'Cancun', 'MX', 21.0365, -86.8771, 'standard'],
  ['CYYZ', 'YYZ', 'Toronto Pearson Intl', 'Toronto', 'CA', 43.6777, -79.6248, 'standard'],
  ['EGLF', 'FAB', 'Farnborough', 'London', 'GB', 51.2758, -0.7763, 'premium'],
  ['EGGW', 'LTN', 'London Luton', 'London', 'GB', 51.8747, -0.3683, 'standard'],
  ['LFPB', 'LBG', 'Paris Le Bourget', 'Paris', 'FR', 48.9694, 2.4414, 'premium'],
  ['LFMN', 'NCE', "Nice Cote d'Azur", 'Nice', 'FR', 43.6584, 7.2159, 'premium'],
  ['LFMD', 'CEQ', 'Cannes-Mandelieu', 'Cannes', 'FR', 43.542, 6.9535, 'premium'],
  ['LSGG', 'GVA', 'Geneva', 'Geneva', 'CH', 46.2381, 6.109, 'premium'],
  ['LSZH', 'ZRH', 'Zurich', 'Zurich', 'CH', 47.4582, 8.5555, 'standard'],
  ['LIML', 'LIN', 'Milan Linate', 'Milan', 'IT', 45.4451, 9.2767, 'standard'],
  ['LIRA', 'CIA', 'Rome Ciampino', 'Rome', 'IT', 41.7994, 12.5949, 'standard'],
  ['LEIB', 'IBZ', 'Ibiza', 'Ibiza', 'ES', 38.8729, 1.3731, 'premium'],
  ['LEPA', 'PMI', 'Palma de Mallorca', 'Palma', 'ES', 39.5517, 2.7388, 'standard'],
  ['LEMD', 'MAD', 'Madrid Barajas', 'Madrid', 'ES', 40.4719, -3.5626, 'standard'],
  ['EDDM', 'MUC', 'Munich', 'Munich', 'DE', 48.3538, 11.7861, 'standard'],
  ['LOWW', 'VIE', 'Vienna Intl', 'Vienna', 'AT', 48.1103, 16.5697, 'standard'],
  ['LGAV', 'ATH', 'Athens Intl', 'Athens', 'GR', 37.9364, 23.9445, 'standard'],
  ['LGMK', 'JMK', 'Mykonos', 'Mykonos', 'GR', 37.4351, 25.3481, 'premium'],
  ['OMDW', 'DWC', 'Dubai World Central', 'Dubai', 'AE', 24.896, 55.1614, 'standard'],
  // Major US private-aviation airports (launch markets, onboarding bases, SEO city pages).
  ['KMMU', 'MMU', 'Morristown Municipal', 'Morristown', 'US', 40.7994, -74.4149, 'premium'],
  ['KFRG', 'FRG', 'Republic', 'Farmingdale', 'US', 40.7288, -73.4134, 'standard'],
  ['KISP', 'ISP', 'Long Island MacArthur', 'Islip', 'US', 40.7952, -73.1002, 'standard'],
  ['KHTO', 'HTO', 'East Hampton', 'East Hampton', 'US', 40.9596, -72.2518, 'premium'],
  ['KFOK', 'FOK', 'Francis S. Gabreski', 'Westhampton Beach', 'US', 40.8437, -72.6318, 'premium'],
  ['KLGA', 'LGA', 'LaGuardia', 'New York', 'US', 40.7769, -73.874, 'premium'],
  ['KEWR', 'EWR', 'Newark Liberty Intl', 'Newark', 'US', 40.6925, -74.1687, 'standard'],
  ['KHYA', 'HYA', 'Cape Cod Gateway', 'Hyannis', 'US', 41.6693, -70.2804, 'standard'],
  ['KPVD', 'PVD', 'Rhode Island T.F. Green Intl', 'Providence', 'US', 41.724, -71.4282, 'standard'],
  ['KPHL', 'PHL', 'Philadelphia Intl', 'Philadelphia', 'US', 39.8744, -75.2424, 'standard'],
  ['KDCA', 'DCA', 'Ronald Reagan Washington National', 'Washington', 'US', 38.8512, -77.0402, 'standard'],
  ['KCHS', 'CHS', 'Charleston Intl', 'Charleston', 'US', 32.8986, -80.0405, 'standard'],
  ['KSAV', 'SAV', 'Savannah/Hilton Head Intl', 'Savannah', 'US', 32.1276, -81.2021, 'standard'],
  ['KCLT', 'CLT', 'Charlotte Douglas Intl', 'Charlotte', 'US', 35.214, -80.9431, 'standard'],
  ['KATL', 'ATL', 'Hartsfield-Jackson Atlanta Intl', 'Atlanta', 'US', 33.6407, -84.4277, 'standard'],
  ['KBCT', 'BCT', 'Boca Raton', 'Boca Raton', 'US', 26.3785, -80.1077, 'standard'],
  ['KTMB', 'TMB', 'Miami Executive', 'Miami', 'US', 25.6479, -80.4328, 'standard'],
  ['KEYW', 'EYW', 'Key West Intl', 'Key West', 'US', 24.5561, -81.7596, 'standard'],
  ['KSRQ', 'SRQ', 'Sarasota Bradenton Intl', 'Sarasota', 'US', 27.3954, -82.5544, 'standard'],
  ['KTPA', 'TPA', 'Tampa Intl', 'Tampa', 'US', 27.9755, -82.5332, 'standard'],
  ['KORL', 'ORL', 'Orlando Executive', 'Orlando', 'US', 28.5455, -81.3329, 'standard'],
  ['KMCO', 'MCO', 'Orlando Intl', 'Orlando', 'US', 28.4312, -81.3081, 'standard'],
  ['KORD', 'ORD', 'Chicago O\'Hare Intl', 'Chicago', 'US', 41.9742, -87.9073, 'standard'],
  ['KMSP', 'MSP', 'Minneapolis-St Paul Intl', 'Minneapolis', 'US', 44.8848, -93.2223, 'standard'],
  ['KDTW', 'DTW', 'Detroit Metropolitan', 'Detroit', 'US', 42.2162, -83.3554, 'standard'],
  ['KADS', 'ADS', 'Addison', 'Dallas', 'US', 32.9686, -96.8364, 'standard'],
  ['KDFW', 'DFW', 'Dallas/Fort Worth Intl', 'Dallas', 'US', 32.8998, -97.0403, 'standard'],
  ['KIAH', 'IAH', 'George Bush Intercontinental', 'Houston', 'US', 29.9902, -95.3368, 'standard'],
  ['KSAT', 'SAT', 'San Antonio Intl', 'San Antonio', 'US', 29.5337, -98.4698, 'standard'],
  ['KDEN', 'DEN', 'Denver Intl', 'Denver', 'US', 39.8561, -104.6737, 'standard'],
  ['KHDN', 'HDN', 'Yampa Valley', 'Steamboat Springs', 'US', 40.4812, -107.2177, 'standard'],
  ['KTEX', 'TEX', 'Telluride Regional', 'Telluride', 'US', 37.9538, -107.9085, 'premium'],
  ['KSLC', 'SLC', 'Salt Lake City Intl', 'Salt Lake City', 'US', 40.7899, -111.9791, 'standard'],
  ['KPHX', 'PHX', 'Phoenix Sky Harbor Intl', 'Phoenix', 'US', 33.4352, -112.0101, 'standard'],
  ['KHND', 'HND', 'Henderson Executive', 'Las Vegas', 'US', 35.9728, -115.1344, 'standard'],
  ['KSMO', 'SMO', 'Santa Monica', 'Santa Monica', 'US', 34.0158, -118.4513, 'premium'],
  ['KSBA', 'SBA', 'Santa Barbara Municipal', 'Santa Barbara', 'US', 34.4262, -119.8401, 'standard'],
  ['KSAN', 'SAN', 'San Diego Intl', 'San Diego', 'US', 32.7338, -117.1933, 'standard'],
  ['KMYF', 'MYF', 'Montgomery-Gibbs Executive', 'San Diego', 'US', 32.8157, -117.1396, 'standard'],
  ['KTRM', 'TRM', 'Jacqueline Cochran Regional', 'Thermal', 'US', 33.6267, -116.16, 'standard'],
  ['KAPC', 'APC', 'Napa County', 'Napa', 'US', 38.2132, -122.2807, 'premium'],
  ['KSTS', 'STS', 'Charles M. Schulz-Sonoma County', 'Santa Rosa', 'US', 38.509, -122.8129, 'standard'],
  ['KMRY', 'MRY', 'Monterey Regional', 'Monterey', 'US', 36.587, -121.8429, 'standard'],
  ['KRNO', 'RNO', 'Reno-Tahoe Intl', 'Reno', 'US', 39.4991, -119.7681, 'standard'],
  ['KSEA', 'SEA', 'Seattle-Tacoma Intl', 'Seattle', 'US', 47.4502, -122.3088, 'standard'],
  ['KPDX', 'PDX', 'Portland Intl', 'Portland', 'US', 45.5898, -122.5951, 'standard'],
  ['PHNL', 'HNL', 'Daniel K. Inouye Intl', 'Honolulu', 'US', 21.3187, -157.9225, 'standard'],
  ['PHOG', 'OGG', 'Kahului', 'Maui', 'US', 20.8986, -156.4305, 'standard'],
  ['PHKO', 'KOA', 'Ellison Onizuka Kona Intl', 'Kona', 'US', 19.7388, -156.0456, 'standard'],
];

export const AIRPORTS: Airport[] = ROWS.map(([icao, iata, name, city, country, lat, lon, feeTier]) => ({
  icao, iata, name, city, country, lat, lon, feeTier,
}));

const byIcao = new Map(AIRPORTS.map((a) => [a.icao, a]));
const byIata = new Map(AIRPORTS.map((a) => [a.iata, a]));

/**
 * Adds (or updates) an airport learned at runtime, e.g. from a feed. The built-in list above is
 * only a seed: real feeds reference thousands of airports. `icao` is the key; airports without an
 * ICAO code use their local identifier (FAA LID) in that slot.
 */
export function registerAirport(a: Airport): Airport {
  const key = a.icao.toUpperCase();
  const existing = byIcao.get(key);
  if (existing) {
    // Never let a feed overwrite curated data; only fill gaps.
    if (!existing.iata && a.iata) {
      existing.iata = a.iata.toUpperCase();
      byIata.set(existing.iata, existing);
    }
    return existing;
  }
  const airport: Airport = { ...a, icao: key, iata: (a.iata ?? '').toUpperCase() };
  AIRPORTS.push(airport);
  byIcao.set(key, airport);
  if (airport.iata && !byIata.has(airport.iata)) byIata.set(airport.iata, airport);
  return airport;
}

/** Resolve an ICAO, IATA or local identifier. Returns undefined for unknown codes. */
export function findAirport(code: string | null | undefined): Airport | undefined {
  if (!code) return undefined;
  const c = code.trim().toUpperCase();
  if (!c) return undefined;
  return c.length === 4 ? byIcao.get(c) ?? byIata.get(c) : byIata.get(c) ?? byIcao.get(c);
}

export function getAirport(icao: string): Airport {
  const a = byIcao.get(icao);
  if (!a) throw new Error(`Unknown airport ${icao}`);
  return a;
}

export function searchAirports(q: string, limit = 8): Airport[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const scored: Array<[number, Airport]> = [];
  for (const a of AIRPORTS) {
    let s = 0;
    if (a.iata.toLowerCase() === needle || a.icao.toLowerCase() === needle) s = 100;
    else if (a.city.toLowerCase().startsWith(needle)) s = 60;
    else if (a.name.toLowerCase().includes(needle) || a.city.toLowerCase().includes(needle)) s = 30;
    // Curated airports first among equals: they're the ones with business-aviation fee data.
    if (s > 0) scored.push([s + (a.source === 'feed' ? 0 : 1), a]);
  }
  return scored.sort((x, y) => y[0] - x[0]).slice(0, limit).map(([, a]) => a);
}
