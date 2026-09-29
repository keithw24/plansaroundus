import { describe, expect, it } from "vitest";
import { haversineMeters, parseCoordinates } from "../src/geo.ts";

describe("parseCoordinates", () => {
  it.each([
    ["40.8075,-73.9626", { latitude: 40.8075, longitude: -73.9626 }],
    [" 40.8 , -73.96 ", { latitude: 40.8, longitude: -73.96 }],
    [
      "https://www.google.com/maps/@40.8075,-73.9626,17z",
      { latitude: 40.8075, longitude: -73.9626 },
    ],
    [
      "https://www.google.com/maps/place/Jin+Ramen/@40.81,-73.95,17z/data=!3m1!4b1!4m6!3m5!8m2!3d40.8123!4d-73.9588",
      { latitude: 40.8123, longitude: -73.9588 },
    ],
    ["https://maps.google.com/?q=40.7,-73.9", { latitude: 40.7, longitude: -73.9 }],
    [
      "https://maps.apple.com/?ll=40.7128,-74.0060&q=Dropped%20Pin",
      { latitude: 40.7128, longitude: -74.006 },
    ],
  ])("%s", (text, expected) => {
    expect(parseCoordinates(text)).toEqual(expected);
  });

  it.each([
    "hi",
    "91.0,0.0",
    "40.8,-181.0",
    "12,34 please",
    "https://example.com",
    "40.8",
    "10,000",
    "3, 4",
    "40,-73",
  ])("rejects %s", (text) => {
    expect(parseCoordinates(text)).toBeNull();
  });
});

describe("haversineMeters", () => {
  it("measures Columbia to Times Square at about 6.6 km", () => {
    const d = haversineMeters(
      { latitude: 40.8075, longitude: -73.9626 },
      { latitude: 40.758, longitude: -73.9855 },
    );
    expect(d).toBeGreaterThan(5800);
    expect(d).toBeLessThan(5900);
  });
});
