export type Coordinates = { latitude: number; longitude: number };

const EARTH_RADIUS_METERS = 6_371_008.8;

/** Great-circle distance in meters. */
export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

const NUM = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;
const PAIR = new RegExp(String.raw`^\s*(${NUM})\s*,\s*(${NUM})\s*$`);

/**
 * Coordinates from a bare "40.8075,-73.9626" or a Google / Apple Maps link.
 * Returns null for anything else, including out-of-range values.
 */
export function parseCoordinates(text: string): Coordinates | null {
  const trimmed = text.trim();
  const bare = PAIR.exec(trimmed);
  if (bare) return checked(bare[1], bare[2]);
  if (!/^https?:\/\//i.test(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Google: /maps/place/.../@40.8,-73.9,17z and !3d40.8!4d-73.9 data segments.
  const pinned = new RegExp(String.raw`!3d(${NUM})!4d(${NUM})`).exec(url.pathname);
  if (pinned) return checked(pinned[1], pinned[2]);
  const at = new RegExp(String.raw`/@(${NUM}),(${NUM})`).exec(url.pathname);
  if (at) return checked(at[1], at[2]);
  // Google ?q= / ?query= / ?ll=, Apple ?ll= / ?q= / ?sll=.
  for (const key of ["q", "query", "ll", "sll", "daddr"]) {
    const value = url.searchParams.get(key);
    const m = value ? PAIR.exec(value) : null;
    if (m) return checked(m[1], m[2]);
  }
  return null;
}

function checked(lat: string | undefined, lng: string | undefined): Coordinates | null {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}
