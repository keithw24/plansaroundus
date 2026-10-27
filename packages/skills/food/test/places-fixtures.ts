import { createHash } from "node:crypto";
import type { Location } from "@aroundus/core";

// Places Text Search (New) responses built by hand from the documented shape:
// https://developers.google.com/maps/documentation/places/web-service/text-search
// No Maps key was available, so none of these are recorded from the live API.
// The places are invented; only the shape is Google's.

export const COLUMBIA: Location = { label: "Columbia", latitude: 40.8075, longitude: -73.9626 };

export type RawPlace = Record<string, unknown>;

export function place(n: number, overrides: RawPlace = {}): RawPlace {
  const { name, ...rest } = overrides;
  return {
    id: `ChIJfake${n}`,
    displayName: {
      text: typeof name === "string" ? name : `Test Kitchen ${n}`,
      languageCode: "en",
    },
    // ~100 m apart heading south from Columbia.
    location: { latitude: Number((40.8075 - n * 0.0009).toFixed(6)), longitude: -73.9626 },
    priceLevel: "PRICE_LEVEL_MODERATE",
    rating: 4.2,
    currentOpeningHours: { openNow: true },
    googleMapsUri: `https://maps.google.com/?cid=${1000 + n}`,
    types: ["restaurant", "food", "point_of_interest", "establishment"],
    formattedAddress: `${3000 - n * 10} Broadway, New York, NY 10027, USA`,
    ...rest,
  };
}

/** A realistic mixed set near Columbia, used by the re-rank tests and the recorder. */
export const NEIGHBORHOOD: RawPlace[] = [
  place(1, {
    name: "Morningside Ramen House",
    types: ["ramen_restaurant", "japanese_restaurant", "restaurant", "food"],
    priceLevel: "PRICE_LEVEL_INEXPENSIVE",
    rating: 4.4,
  }),
  place(2, {
    name: "Broadway Steak Room",
    types: ["steak_house", "restaurant", "food"],
    priceLevel: "PRICE_LEVEL_VERY_EXPENSIVE",
    rating: 4.6,
  }),
  place(3, {
    name: "Green Bowl Vegan Cafe",
    types: ["vegan_restaurant", "vegetarian_restaurant", "cafe", "restaurant"],
    priceLevel: "PRICE_LEVEL_INEXPENSIVE",
    rating: 4.5,
  }),
  place(4, {
    name: "Amsterdam Ave Pizza",
    types: ["pizza_restaurant", "restaurant", "food"],
    priceLevel: "PRICE_LEVEL_INEXPENSIVE",
    rating: 4.1,
  }),
  place(5, {
    name: "Candlelight Trattoria",
    types: ["italian_restaurant", "wine_bar", "restaurant"],
    priceLevel: "PRICE_LEVEL_EXPENSIVE",
    rating: 4.7,
  }),
  place(6, {
    name: "Harlem Soul Kitchen",
    types: ["american_restaurant", "restaurant", "food"],
    priceLevel: "PRICE_LEVEL_MODERATE",
    rating: 4.3,
  }),
  place(7, {
    name: "Night Owl Diner",
    types: ["diner", "breakfast_restaurant", "restaurant"],
    rating: 3.9,
    currentOpeningHours: { openNow: true },
    priceLevel: "PRICE_LEVEL_UNSPECIFIED",
  }),
  // No opening hours and no rating, as Places returns for some small places.
  place(8, {
    name: "Corner Dumpling Stand",
    types: ["chinese_restaurant", "restaurant", "food"],
    priceLevel: "PRICE_LEVEL_MODERATE",
    currentOpeningHours: undefined,
    rating: undefined,
  }),
];

export type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A fake fetch that answers every call with `respond()` and records what was sent. */
export function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), init: init ?? {}, body });
    init?.signal?.throwIfAborted();
    return respond();
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** Places omits `places` entirely when nothing matches; otherwise it may add a nextPageToken. */
export const placesResponse = (places: unknown[] | undefined): Response =>
  new Response(
    JSON.stringify(places === undefined ? {} : { places, nextPageToken: "AeJbb3fake" }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );

export const googleError = (code: number, status: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message, status } }), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });

/** Recorded Gemini replies are keyed by everything sent, as in the router's fixtures. */
export function fixtureKey(req: { system: string; prompt: string; jsonSchema: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([req.system, req.prompt, req.jsonSchema]))
    .digest("hex")
    .slice(0, 16);
}

export type RerankFixture = {
  model: string;
  recordedAt: string;
  replies: Record<string, { case: string; reply: string }>;
};

/** Real Places responses, written by scripts/record-places.ts once a Maps key exists. */
export type PlacesLiveFixture = {
  recordedAt: string;
  cases: {
    name: string;
    input: { cuisine: string[]; openNow: boolean; budget?: "free" | "low" | "medium" | "high" };
    status: number;
    response: string;
  }[];
};

/** The re-rank cases recorded against Gemini (scripts/record-rerank.ts). */
export const RERANK_CASES: {
  name: string;
  request: string;
  cuisine: string[];
  budget?: "free" | "low" | "medium" | "high";
}[] = [
  {
    name: "cheap ramen",
    request: "cheap ramen near columbia?",
    cuisine: ["ramen"],
    budget: "low",
  },
  {
    name: "date night",
    request: "somewhere nice for a date night",
    cuisine: [],
    budget: "high",
  },
  { name: "vegan", request: "anything vegan around here", cuisine: ["vegan"] },
];
