import { HttpUrl, type RouteInput, type TravelMode } from "@aroundus/core";

const MAPS_TRAVEL_MODE: Record<TravelMode, string> = {
  WALK: "walking",
  TRANSIT: "transit",
  DRIVE: "driving",
  BICYCLE: "bicycling",
};

/**
 * A Google Maps directions link (Maps URLs, `api=1`), built in code so it
 * works with no key and whatever Routes does. With a place id, Maps targets
 * the exact place and the name is only a label; without one, the pin's
 * coordinates are the destination, so a vague name can't send people elsewhere.
 */
export function directionsUrl(input: Pick<RouteInput, "origin" | "destination" | "travelMode">) {
  const { origin, destination, travelMode } = input;
  const params = new URLSearchParams({ api: "1", origin: latLng(origin) });
  if (destination.placeId) {
    params.set("destination", destination.label);
    params.set("destination_place_id", destination.placeId);
  } else {
    params.set("destination", latLng(destination));
  }
  params.set("travelmode", MAPS_TRAVEL_MODE[travelMode]);
  // URLSearchParams encodes spaces as "+" and apostrophes as %27, which Maps accepts.
  return HttpUrl.parse(`https://www.google.com/maps/dir/?${params.toString()}`);
}

function latLng(p: { latitude: number; longitude: number }): string {
  return `${p.latitude},${p.longitude}`;
}
