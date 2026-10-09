// Aviapages API v3 payload shapes we consume, transcribed from the official OpenAPI spec
// (./openapi.json). Fields not used by this app are omitted; responses are validated against the
// full spec in tests and in the live contract check.

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
  per_page?: number;
  next_blocked_reason?: 'authentication_required' | null;
}

export interface AvpCountry { id: number; name: string; iso_alpha2?: string | null; iso_alpha3?: string | null }
export interface AvpCity { id: number; name: string; latitude?: number | null; longitude?: number | null; country?: AvpCountry }

export interface AvpAirportRef {
  id?: number | null;
  name?: string | null;
  iata?: string | null;
  icao?: string | null;
  lid?: string | null;
  slug?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  city?: AvpCity | null;
}

export interface AvpImage { position?: number; media?: { id: number; path: string | null }; url?: string | null }

export interface AvpCompanyBrief {
  id: number;
  name: string;
  phone?: string | null;
  fax?: string | null;
  website?: string | null;
  address?: string | null;
  slug: string;
  contact_email?: string | null;
}

export interface AvpAircraftExtension {
  refurbishment?: number | null;
  cabin_crew?: boolean | null;
  lavatory?: boolean | null;
  hot_meal?: boolean | null;
  wireless_internet?: boolean | null;
  entertainment_system?: boolean | null;
  smoking?: boolean | null;
  pets_allowed?: boolean | null;
  shower?: boolean | null;
  satellite_phone?: boolean | null;
  sleeping_places?: number | null;
  luggage_volume?: string | null;
  description?: string | null;
}

export interface AvpEmptyLeg {
  id: number;
  registration_number: string | null;
  aircraft_type: string | null;
  company: string | null;
  from_date_utc: string;
  to_date_utc: string;
  comment: string | null;
  price: number | null;
  currency_code: string | null;
  dep_airport: AvpAirportRef;
  arr_airport: AvpAirportRef | null;
  created_at: string;
  updated_at: string;
  aircraft: {
    id: number;
    passengers_max: number | null;
    registration_number: string | null;
    year_of_production: number | null;
    slug: string | null;
    serial_number: string | null;
    company: AvpCompanyBrief;
    aircraft_extension: AvpAircraftExtension | null;
    images: AvpImage[];
  } | null;
  aircraft_type_details: { id: number; name: string; icao: string | null; aircraft_class: { id: number; name: string }; images?: AvpImage[] } | null;
  converted_prices: { eur: number | null; usd: number | null };
}

export interface EmptyLegQuery {
  page?: number;
  updated_at_gt?: string;
  updated_at_lt?: string;
  created_at_gt?: string;
  from_date_utc?: string;
  to_date_utc?: string;
  has_arrival_airport?: boolean;
  has_price?: boolean;
  dep_airport_code_in?: string[];
  arr_airport_code_in?: string[];
  dep_airport_country_iso_alpha2_in?: string[];
  reg?: string;
  search_coords?: string;
  search_coords_radius?: number;
  ordering?: string[];
}

export type QuoteRequestState = 0 | 1 | 5 | 7 | 11;
export type QuoteMessageState =
  | 'Created' | 'Sending' | 'Sent' | 'Delivered' | 'Resending' | 'Error' | 'Partially delivered' | 'Open'
  | 'Spam' | 'Unsubscribe' | 'Test message' | 'Blocked' | 'Other';
export type Channel = 'Email' | 'Leon' | 'Fl3xx' | 'Skylegs';

export interface QuoteLeg {
  departure_airport: AvpAirportRef;
  arrival_airport: AvpAirportRef;
  pax: number;
  departure_datetime?: string | null;
  departure_datetime_local?: string | null;
}

export interface QuoteRequestCreate {
  legs: QuoteLeg[];
  quote_messages: Array<{ company: { id: number; name?: string } }>;
  aircraft: Array<{ id?: number | null; tail_number?: string | null; ac_type?: string | null; ac_class?: string | null }>;
  channels: Channel[];
  comment?: string | null;
  quote_extension?: { client_given_name?: string; client_family_name?: string; client_email?: string; client_phone?: string } | null;
  post_to_trip_board?: boolean;
  send_to_self?: boolean;
}

export interface QuoteRequest extends Omit<QuoteRequestCreate, 'quote_messages'> {
  id: number;
  created_at: string;
  state?: QuoteRequestState;
  quote_messages: Array<{
    id: number;
    state: QuoteMessageState;
    channels: Channel;
    company: { id: number | null; name: string | null; slug: string; company_extension?: { avg_response_rate?: number | null; avg_response_time?: number | null; aviapages_validation?: boolean | null } };
  }>;
}

export type OfferState = 'OK' | 'Not available' | 'Removed';
export type Reaction = 'New' | 'Seen' | 'Favorite' | 'Accept' | 'Reject' | 'Costly';

export interface QuoteReply {
  id: number;
  created_at: string;
  price: number | null;
  state: OfferState;
  comment: string | null;
  manager_name: string | null;
  reaction: Reaction;
  external_reply_id: string | null;
  quote_request_id: number;
  quote_message_id: number;
  currency_code: string | null;
  aircraft: {
    id: number;
    tail_number: string | null;
    max_passengers: number | null;
    home_base: string | null;
    images: Array<{ url: string | null; image_type: string | null }> | null;
    aircraft_type: string | null;
    aircraft_class: string | null;
    year_of_production: number | null;
    wireless_internet?: boolean | null;
    lavatory?: boolean | null;
    cabin_crew?: boolean | null;
    hot_meal?: boolean | null;
  };
  company: { id: number; name: string; slug: string; company_extension?: { avg_response_rate?: number | null; avg_response_time?: number | null; aviapages_validation?: boolean | null } };
  manager_account: { id: number; given_name?: string | null; family_name?: string | null; email?: string | null; phone?: string | null };
}

export interface FlightCalcRequest {
  departure_airport: string;
  arrival_airport: string;
  aircraft: string;
  aircraft_tail_number?: string;
  departure_datetime?: string;
  pax?: number;
  airway_time_weather_impacted?: boolean;
  great_circle_distance?: boolean;
  airway_distance?: boolean;
  airway_fuel_weather_impacted?: boolean;
  advise_techstops?: boolean;
  average_speed_time?: boolean;
  great_circle_time?: boolean;
  airway_time?: boolean;
}

export interface FlightCalcResponse {
  aircraft: string;
  airport: { departure: string; arrival: string; techstops: string[] };
  distance?: { great_circle?: number; airway?: number };
  time?: { airway?: number; airway_weather_impacted?: number; great_circle?: number; average_speed?: number };
  fuel?: { airway?: number; airway_weather_impacted?: number; great_circle?: number };
  errors?: Array<{ message: string; code: string }>;
  warnings?: Array<{ message: string; code: string }>;
}

export interface SearchLeg {
  departure_airport: AvpAirportRef;
  arrival_airport: AvpAirportRef;
  pax: number;
  departure_datetime: string;
}

export interface CharterPriceRequest {
  legs: SearchLeg[];
  aircraft: Array<{ id?: number; tail_number?: string; ac_type?: string; ac_class?: string }>;
  currency_code?: string;
  range?: boolean;
}
export interface CharterPriceResponse { price: number | null; currency_code?: string | null; price_min: number | null; price_max: number | null }

export interface CharterSearchRequest {
  legs: SearchLeg[];
  aircraft?: Array<{ id?: number; tail_number?: string; ac_type?: string; ac_class?: string }>;
  empty_legs?: boolean;
  allow_techstop?: boolean;
  year_of_production_gte?: number;
}
export interface CharterSearchAircraftResult {
  id: number;
  slug: string;
  images?: Array<{ url: string; image_type: string | null }>;
  company: { id: number; name: string; slug: string; logo_path?: string | null } | null;
  aircraft_type: string;
  passengers_max: number | null;
  year_of_production: number;
  registration_number: string;
}

export interface PriceCalcRequest {
  aircraft: string;
  currency?: string;
  flights: Array<{ departure_airport: string; arrival_airport: string; pax?: number; departure_datetime_utc?: string; is_ferry?: boolean }>;
}
export interface PriceCalcResponse { price: number; operations?: Array<{ name: string; amount: number }> }

export interface CharterCompany {
  id: number;
  name: string;
  phone?: string | null;
  website?: string | null;
  contact_email?: string | null;
  slug: string;
  is_operator: boolean;
  city: { id: number; name: string; country: { name: string; iso_alpha2?: string | null; iso_alpha3?: string | null } };
  company_extension?: { avg_response_rate?: number | null; avg_response_time?: number | null; is_pro?: boolean };
}

export interface CharterAircraft {
  id: number;
  passengers_max: number | null;
  registration_number: string | null;
  year_of_production: number | null;
  aircraft_type: { id: number; name: string; icao: string | null; aircraft_class: { id: number; name: string } };
  company: { id: number; name: string; slug: string; contact_email?: string | null; phone?: string | null; website?: string | null };
  base_airport: { id: number; icao: string | null; iata: string | null; name: string } | null;
  images: AvpImage[];
}

export interface AircraftTypeRecord {
  id: number;
  name: string;
  icao: string | null;
  class_name: string;
  manufacturer_name: string;
  range_maximum: number | null;
  pax_maximum: number | null;
  speed_typical: number | null;
}
