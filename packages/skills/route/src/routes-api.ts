import type { RouteInput, TravelMode } from "@aroundus/core";
import { z } from "zod";
import { placeIdOf, roundCoord } from "./points.ts";

// Google Routes API, computeRoutes (v2). Request and response shapes follow
// https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes

export const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

const BASE_FIELDS = ["routes.duration", "routes.distanceMeters"];
// Only what the transit summary reads: each step's mode, line, vehicle and where you get off.
const TRANSIT_FIELDS = [
  "routes.legs.steps.travelMode",
  "routes.legs.steps.transitDetails.transitLine.nameShort",
  "routes.legs.steps.transitDetails.transitLine.name",
  "routes.legs.steps.transitDetails.transitLine.vehicle.type",
  "routes.legs.steps.transitDetails.stopDetails.arrivalStop.name",
];

export function fieldMask(mode: TravelMode): string {
  return (mode === "TRANSIT" ? [...BASE_FIELDS, ...TRANSIT_FIELDS] : BASE_FIELDS).join(",");
}

type Waypoint =
  | { placeId: string }
  | { location: { latLng: { latitude: number; longitude: number } } };

function waypoint(p: {
  latitude: number;
  longitude: number;
  placeId?: string | undefined;
}): Waypoint {
  const placeId = placeIdOf(p);
  if (placeId) return { placeId };
  return {
    location: { latLng: { latitude: roundCoord(p.latitude), longitude: roundCoord(p.longitude) } },
  };
}

/** Routes accepts past transit departures up to 7 days back. */
export const TRANSIT_PAST_LIMIT_MS = 7 * 24 * 60 * 60_000;

/**
 * The request body, and whether the departure had to be moved to now. Mode rules:
 * - TRANSIT sends the requested departure time, past or future; one more
 *   than 7 days back (which Routes rejects) becomes now, flagged.
 * - DRIVE is traffic-aware; a departure time is sent only when it's in the
 *   future, because Routes rejects past times for driving.
 * - WALK and BICYCLE take neither a routing preference nor a time.
 */
export function routesRequest(
  input: RouteInput,
  now: Date,
): { body: Record<string, unknown>; departureMovedToNow: boolean } {
  const body: Record<string, unknown> = {
    origin: waypoint(input.origin),
    destination: waypoint(input.destination),
    travelMode: input.travelMode,
    computeAlternativeRoutes: false,
    languageCode: "en-US",
    units: "METRIC",
  };
  let departureMovedToNow = false;
  const departure = new Date(input.departureTime);
  if (input.travelMode === "TRANSIT") {
    // A minute of slack so "now" from a slightly earlier clock is never rejected.
    const tooOld = departure.getTime() < now.getTime() - TRANSIT_PAST_LIMIT_MS + 60_000;
    departureMovedToNow = tooOld;
    body.departureTime = (tooOld ? now : departure).toISOString();
  } else if (input.travelMode === "DRIVE") {
    body.routingPreference = "TRAFFIC_AWARE";
    // A small margin so a "now" departure doesn't arrive at Google already in the past.
    if (departure.getTime() > now.getTime() + 60_000) body.departureTime = departure.toISOString();
  }
  return { body, departureMovedToNow };
}

/** Proto3 JSON drops zero and empty values, so nearly everything is optional. */
const Step = z.object({
  travelMode: z.string().optional(),
  transitDetails: z
    .object({
      transitLine: z
        .object({
          name: z.string().optional(),
          nameShort: z.string().optional(),
          vehicle: z.object({ type: z.string().optional() }).optional(),
        })
        .optional(),
      stopDetails: z
        .object({ arrivalStop: z.object({ name: z.string().optional() }).optional() })
        .optional(),
    })
    .optional(),
});

export const RoutesResponse = z.object({
  routes: z
    .array(
      z.object({
        /** A protobuf Duration, e.g. "1234s" or "1234.5s". */
        duration: z
          .string()
          .regex(/^\d+(\.\d+)?s$/)
          .optional(),
        distanceMeters: z.number().int().nonnegative().optional(),
        // Checked separately by transitSummary, so an odd step only drops the summary.
        legs: z.unknown().optional(),
      }),
    )
    .optional(),
});
const Legs = z.array(z.object({ steps: z.array(Step).optional() }));
export type RoutesResponse = z.infer<typeof RoutesResponse>;
export type RoutesRoute = NonNullable<RoutesResponse["routes"]>[number];

/** "754s" → 13. Anything under a minute but above zero is 1, so a walk is never "0 min". */
export function durationMinutes(duration: string): number {
  const seconds = Number.parseFloat(duration);
  if (seconds <= 0) return 0;
  return Math.max(1, Math.round(seconds / 60));
}

const VEHICLE_NOUN: Record<string, string> = {
  SUBWAY: "train",
  METRO_RAIL: "train",
  HEAVY_RAIL: "train",
  RAIL: "train",
  COMMUTER_TRAIN: "train",
  HIGH_SPEED_TRAIN: "train",
  LONG_DISTANCE_TRAIN: "train",
  MONORAIL: "train",
  BUS: "bus",
  INTERCITY_BUS: "bus",
  TROLLEYBUS: "bus",
  TRAM: "tram",
  FERRY: "ferry",
  CABLE_CAR: "cable car",
  GONDOLA_LIFT: "gondola",
  FUNICULAR: "funicular",
  SHARE_TAXI: "shared taxi",
};

const MAX_RIDES_SHOWN = 3;

/**
 * A short transit summary from the route's own steps, e.g. "1 train to 116 St"
 * or "A train → 2 train to 96 St". Undefined when there are no transit steps
 * (an all-walking "transit" route), so nothing is made up.
 */
export function transitSummary(route: RoutesRoute): string | undefined {
  // Any malformed step drops the whole summary: a partial one could name the wrong line.
  const legs = Legs.safeParse(route.legs ?? []);
  if (!legs.success) return undefined;
  const rides = legs.data
    .flatMap((leg) => leg.steps ?? [])
    .filter((s) => s.travelMode === "TRANSIT" && s.transitDetails)
    .map((s) => {
      const line = s.transitDetails?.transitLine;
      const type = line?.vehicle?.type;
      const noun = type ? VEHICLE_NOUN[type] : undefined;
      const name = clean(line?.nameShort) ?? clean(line?.name);
      return {
        label: [name, noun].filter(Boolean).join(" ") || "transit",
        stop: clean(s.transitDetails?.stopDetails?.arrivalStop?.name),
      };
    });
  const last = rides.at(-1);
  if (!last) return undefined;

  let labels = rides.map((r) => r.label);
  if (labels.length > MAX_RIDES_SHOWN) {
    labels = [labels[0] ?? "", `${labels.length - 2} more`, labels.at(-1) ?? ""];
  }
  const path = labels.join(" → ");
  return last.stop ? `${path} to ${last.stop}` : path;
}

function clean(s: string | undefined): string | undefined {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? t : undefined;
}
