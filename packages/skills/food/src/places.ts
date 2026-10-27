import {
  type Budget,
  type Coordinates,
  type FoodRecommendation,
  HttpUrl,
  haversineMeters,
  type Location,
} from "@aroundus/core";
import { z } from "zod";

// Step 1 of the food skill: Places Text Search (New).
// https://developers.google.com/maps/documentation/places/web-service/text-search

export const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

/** Only the fields we use: Places bills by the fields requested. */
export const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.priceLevel",
  "places.rating",
  "places.currentOpeningHours.openNow",
  "places.googleMapsUri",
  "places.types",
  "places.formattedAddress",
].join(",");

export const PAGE_SIZE = 10;
/** The bias circle. Places may still return farther matches; MAX_DISTANCE_METERS drops those. */
export const BIAS_RADIUS_METERS = 1500;
/** Nobody wants dinner recommendations in another borough. */
export const MAX_DISTANCE_METERS = 5000;
export const PLACES_TIMEOUT_MS = 4000;

export const PLACES_SOURCE = { name: "Google Places" } as const;

/** Places price levels → our Budget. UNSPECIFIED and unknown values → no price. */
const PRICE_LEVELS: Record<string, Budget> = {
  PRICE_LEVEL_FREE: "free",
  PRICE_LEVEL_INEXPENSIVE: "low",
  PRICE_LEVEL_MODERATE: "medium",
  PRICE_LEVEL_EXPENSIVE: "high",
  PRICE_LEVEL_VERY_EXPENSIVE: "high",
};

export function budgetFromPriceLevel(level: string | undefined): Budget | undefined {
  return level === undefined ? undefined : PRICE_LEVELS[level];
}

const BUDGET_RANK: Record<Budget, number> = { free: 0, low: 1, medium: 2, high: 3 };

/**
 * How a place fits a requested budget, used as a ceiling:
 * "fits" (at or under it), "unknown" (no price from Places) or "over".
 * A "free" ask is treated like "low", since almost no restaurant is free.
 */
export function budgetFit(
  price: Budget | undefined,
  budget: Budget | undefined,
): "fits" | "unknown" | "over" {
  if (budget === undefined) return "fits";
  if (price === undefined) return "unknown";
  const ceiling = Math.max(BUDGET_RANK[budget], BUDGET_RANK.low);
  return BUDGET_RANK[price] <= ceiling ? "fits" : "over";
}

/** "{cuisine} restaurant", from cleaned cuisine words. */
export function textQuery(cuisine: readonly string[]): string {
  const words = cuisine
    .map((c) =>
      c
        .replace(/[^\p{L}\p{N}\s'&-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40),
    )
    .filter((c) => c.length > 0)
    .filter((c, i, all) => all.findIndex((o) => o.toLowerCase() === c.toLowerCase()) === i)
    .slice(0, 3);
  return words.length === 0 ? "restaurant" : `${words.join(" or ")} restaurant`;
}

export function searchBody(opts: {
  origin: Coordinates;
  cuisine: readonly string[];
  openNow: boolean;
}) {
  return {
    textQuery: textQuery(opts.cuisine),
    pageSize: PAGE_SIZE,
    languageCode: "en",
    regionCode: "US",
    locationBias: {
      circle: {
        center: { latitude: opts.origin.latitude, longitude: opts.origin.longitude },
        radius: BIAS_RADIUS_METERS,
      },
    },
    ...(opts.openNow ? { openNow: true } : {}),
  };
}

// The response is checked in two layers: the envelope must be right (else the
// whole call failed), but each place is checked on its own so one malformed
// candidate is dropped rather than failing the search. Optional fields that
// are malformed are dropped (`.catch`) rather than losing a good place.
const PlacesEnvelope = z.object({ places: z.array(z.unknown()).optional() });

const optional = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const PlaceCandidate = z.object({
  id: z.string().trim().min(1),
  displayName: z.object({ text: z.string().trim().min(1) }),
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  priceLevel: optional(z.string()),
  rating: optional(z.number().min(0).max(5)),
  currentOpeningHours: optional(z.object({ openNow: optional(z.boolean()) })),
  googleMapsUri: optional(HttpUrl),
  types: optional(z.array(z.string())),
  formattedAddress: optional(z.string()),
});
type PlaceCandidate = z.infer<typeof PlaceCandidate>;

/** Place types that say nothing about the food. */
const GENERIC_TYPES = new Set(["food", "point_of_interest", "establishment", "store"]);

export class PlacesError extends Error {
  readonly httpStatus: number | undefined;
  constructor(message: string, opts: { httpStatus?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "PlacesError";
    this.httpStatus = opts.httpStatus;
  }
}

export type SearchResult = {
  candidates: FoodRecommendation[];
  /** Candidates dropped as malformed. Logged, never shown. */
  malformed: number;
  /** Candidates dropped for distance, budget or being closed. */
  filtered: number;
  /** Extra facts per id for the re-rank prompt; not part of the recommendation. */
  addresses: Map<string, string>;
};

/**
 * Runs one Text Search and returns valid candidates in Places' relevance
 * order, with a requested budget applied: known over-budget places are
 * dropped, and places with no price go after the ones that fit.
 */
export async function searchPlaces(opts: {
  mapsKey: string;
  fetch: typeof fetch;
  origin: Location;
  cuisine: readonly string[];
  budget: Budget | undefined;
  openNow: boolean;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<SearchResult> {
  const timeoutMs = opts.timeoutMs ?? PLACES_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await opts.fetch(PLACES_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": opts.mapsKey,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify(searchBody(opts)),
      signal: AbortSignal.any([opts.signal, timeout]),
    });
  } catch (err) {
    if (opts.signal.aborted) throw err;
    if (timeout.aborted) {
      throw new PlacesError(`Places searchText timed out after ${timeoutMs} ms`, { cause: err });
    }
    throw new PlacesError(`Places searchText request failed: ${errorMessage(err)}`, {
      cause: err,
    });
  }

  const text = await res.text();
  if (!res.ok) {
    throw new PlacesError(`Places searchText failed: HTTP ${res.status}${errorDetail(text)}`, {
      httpStatus: res.status,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new PlacesError("Places searchText returned invalid JSON", { cause: err });
  }
  const envelope = PlacesEnvelope.safeParse(json);
  if (!envelope.success) {
    throw new PlacesError("Places searchText returned an unexpected shape", {
      cause: envelope.error,
    });
  }

  let malformed = 0;
  let filtered = 0;
  const fits: FoodRecommendation[] = [];
  const unknownPrice: FoodRecommendation[] = [];
  const addresses = new Map<string, string>();
  const seen = new Set<string>();
  for (const raw of envelope.data.places ?? []) {
    const parsed = PlaceCandidate.safeParse(raw);
    if (!parsed.success) {
      malformed++;
      continue;
    }
    const rec = toRecommendation(parsed.data, opts.origin);
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    const fit = budgetFit(rec.priceLevel, opts.budget);
    if (
      rec.distanceMeters > MAX_DISTANCE_METERS ||
      fit === "over" ||
      (opts.openNow && rec.openNow === false)
    ) {
      filtered++;
      continue;
    }
    if (parsed.data.formattedAddress) addresses.set(rec.id, parsed.data.formattedAddress);
    (fit === "unknown" ? unknownPrice : fits).push(rec);
  }
  return { candidates: [...fits, ...unknownPrice], malformed, filtered, addresses };
}

function toRecommendation(place: PlaceCandidate, origin: Coordinates): FoodRecommendation {
  const name = place.displayName.text;
  const location = { label: name, ...place.location };
  const priceLevel = budgetFromPriceLevel(place.priceLevel);
  const openNow = place.currentOpeningHours?.openNow;
  const url = place.googleMapsUri;
  return {
    kind: "food",
    id: `places:${place.id}`,
    placeId: place.id,
    name,
    location,
    distanceMeters: Math.round(haversineMeters(origin, place.location)),
    categories: (place.types ?? []).filter((t) => !GENERIC_TYPES.has(t)),
    source: url ? { ...PLACES_SOURCE, url } : { ...PLACES_SOURCE },
    ...(priceLevel === undefined ? {} : { priceLevel }),
    ...(openNow === undefined ? {} : { openNow }),
    ...(place.rating === undefined ? {} : { rating: place.rating }),
    ...(url === undefined ? {} : { url }),
  };
}

// Google's error body: { error: { code, message, status } }. Status and a
// short message only, so logs stay readable.
function errorDetail(body: string): string {
  try {
    const err = (JSON.parse(body) as { error?: { status?: unknown; message?: unknown } }).error;
    const status = typeof err?.status === "string" ? ` ${err.status}` : "";
    const message = typeof err?.message === "string" ? `: ${err.message.slice(0, 200)}` : "";
    return `${status}${message}`;
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
