import { HttpUrl, type RouteInput, type TravelMode } from "@aroundus/core";
import { coordText, placeIdOf } from "./points.ts";

const MAPS_TRAVEL_MODE: Record<TravelMode, string> = {
  WALK: "walking",
  TRANSIT: "transit",
  DRIVE: "driving",
  BICYCLE: "bicycling",
};

/** Maps URLs are limited to 2,048 characters. */
export const MAPS_URL_MAX = 2048;
/** Longer names are cut: with a place id the name is only a label. */
const LABEL_MAX = 100;

/**
 * A Google Maps directions link (Maps URLs, `api=1`), built in code so it
 * works with no key and whatever Routes does. With a place id, Maps targets
 * the exact place and the name is only a label; without one, the pin's
 * coordinates are the destination, so a vague name can't send people elsewhere.
 * The link always stays within MAPS_URL_MAX: the label goes first, then the place id.
 */
export function directionsUrl(input: Pick<RouteInput, "origin" | "destination" | "travelMode">) {
  const { origin, destination, travelMode } = input;
  const placeId = placeIdOf(destination);
  const label = [...destination.label.trim()].slice(0, LABEL_MAX).join("").trim();
  const pin = latLng(destination);

  const candidates: { destination: string; placeId?: string }[] = placeId
    ? [{ destination: label || pin, placeId }, { destination: pin, placeId }, { destination: pin }]
    : [{ destination: pin }];
  let url = "";
  for (const c of candidates) {
    const params = new URLSearchParams({ api: "1", origin: latLng(origin) });
    params.set("destination", c.destination);
    if (c.placeId) params.set("destination_place_id", c.placeId);
    params.set("travelmode", MAPS_TRAVEL_MODE[travelMode]);
    // URLSearchParams encodes spaces as "+" and apostrophes as %27, which Maps accepts.
    url = `https://www.google.com/maps/dir/?${params.toString()}`;
    if (url.length <= MAPS_URL_MAX) break;
  }
  return HttpUrl.parse(url);
}

function latLng(p: { latitude: number; longitude: number }): string {
  return `${coordText(p.latitude)},${coordText(p.longitude)}`;
}
